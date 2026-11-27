/* ============================================================
   见微 · 用户端交互
   ------------------------------------------------------------
   一个文件管六屏。结构：
     1. 工具与状态
     2. 路由与底部导航
     3. 地图屏
     4. 上报屏（选图 / 类型 / 定位 / 提交）
     5. AI 分析遮罩
     6. 结果屏（通过 / 拦截两态）
     7. 我的上报 / 个人中心 / 徽章墙
     8. 演示场景
   ============================================================ */
(function () {
  'use strict';

  const D = window.DATA;
  const UI = window.UI;
  const A = window.Auth;
  const $  = function (s, r) { return (r || document).querySelector(s); };
  const $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  /* ---------------- 状态 ---------------- */
  const state = {
    screen: 'map',
    layer: 'pending',
    reportTab: 'all',
    photos: [],           // [{ kind }]
    type: '',
    desc: '',
    addr: '',
    lng: null,            // 上报点经度（WGS-84）
    lat: null,            // 上报点纬度
    located: false,
    invalidStreak: 0,     // 连续被拦次数，满 3 转人工
    preview: null,        // 图片即时预判结果（AI 认出来的类型 + 一句话描述）
    photoGate: null,      // 本地准入结果：糊了/太暗/像截图，选图后立刻提示
    previewing: false,    // 预判请求在飞
    session: null,        // 当前身份（学号 / 手机号 / 游客）
    reports: JSON.parse(JSON.stringify(D.MY_REPORTS)),
    user: JSON.parse(JSON.stringify(D.USER))
  };

  /** 这三屏是二级页，进入后收起底部导航 */
  const HIDE_TAB = ['report', 'result', 'badges', 'query', 'rewards'];

  const TABS = [
    { key: 'map',     label: '地图',     icon: 'map' },
    { key: 'reports', label: '我的上报', icon: 'list' },
    { key: 'profile', label: '我的',     icon: 'user' }
  ];

  /* ============================================================
     1. 工具
     ============================================================ */

  /** 把 <span data-icon="x"> 填充成 SVG，写结构时不用手抄路径 */
  function hydrate(root) {
    $$('[data-icon]', root || document).forEach(function (el) {
      if (el.dataset.done) return;
      el.innerHTML = UI.icon(el.dataset.icon, +el.dataset.size || 18);
      el.dataset.done = '1';
    });
  }

  function screenEl(name) { return $('.screen[data-screen="' + name + '"]'); }

  /** 把「天」单位的浮点数转成人话：0.2 → 5 小时前，2.6 → 3 天前 */
  function agoText(ago) {
    if (ago <= 0.02) return '刚刚';
    if (ago < 1) return Math.max(1, Math.round(ago * 24)) + ' 小时前';
    return Math.round(ago) + ' 天前';
  }

  function tierOf(credit) {
    // 分档规则收在 Auth 里，用户端和后台读的是同一份
    return A ? A.tierOf(credit).name : '见习哨兵';
  }

  /* ============================================================
     2. 路由
     ============================================================ */

  function go(name, opts) {
    opts = opts || {};
    const to = screenEl(name);
    if (!to) return;

    // 数据屏每次进入都重新渲染，保证提交后的列表、徽章、信用分是新的。
    // 进这几个屏之前先跟存储对一次账：后台可能刚把某张单子办结并发了积分，
    // 内存里那份还是旧的，不重读就会显示成"没到账"。
    if (name === 'reports' || name === 'profile' || name === 'badges' || name === 'rewards') {
      if (A && A.refresh) A.refresh();
      applySession();
    }

    if (name === 'reports') { renderReportTabs(); renderReportList(); }
    if (name === 'profile') renderProfile();
    if (name === 'badges') renderBadges();
    if (name === 'rewards') renderRewards();

    /* 上报页不要留上一次的东西。
       交完一条再点「上报」，还挂着上一条的照片和描述，最轻的后果是重复提交，
       最重的后果是把另一件事写成同一条。地址和定位留着 —— 人通常还在原地。 */
    if (name === 'report' && state.formStale) {
      state.formStale = false;
      resetForm(true);
    }

    if (state.screen === name) return;

    const from = screenEl(state.screen);
    from && from.classList.remove('is-active');
    to.classList.add('is-active');
    // 重新触发入场动画
    to.style.animation = 'none';
    void to.offsetWidth;
    to.style.animation = '';

    state.screen = name;

    if (opts.top !== false) to.scrollTop = 0;

    // 底部导航
    const tabbar = $('#tabbar');
    if (HIDE_TAB.indexOf(name) >= 0) {
      tabbar.classList.add('is-hidden');
    } else {
      tabbar.classList.remove('is-hidden');
      $$('.tab-btn', tabbar).forEach(function (b) {
        b.classList.toggle('on', b.dataset.go === name);
      });
    }

    hydrate(to);
  }

  function renderTabbar() {
    const bar = $('#tabbar');
    bar.innerHTML = TABS.map(function (t) {
      return '<button class="tab-btn' + (state.screen === t.key ? ' on' : '') + '" data-go="' + t.key + '">' +
               UI.icon(t.icon, 21) + '<span>' + t.label + '</span>' +
             '</button>';
    }).join('');
  }

  /* ============================================================
     3. 地图屏
     ============================================================ */

  let map = null;            // 瓦片地图实例，懒创建
  let mapBooted = false;

  function renderMapStats() {
    const pending = D.POINTS.filter(function (p) { return p.status === 'pending'; }).length;
    const resolved = D.POINTS.filter(function (p) { return p.status === 'resolved'; }).length;
    $('#cntPending').textContent = pending;
    $('#cntResolved').textContent = resolved;
    $('#cPending').textContent = pending;
    $('#cResolved').textContent = resolved;
  }

  /**
   * 建地图。只建一次，之后复用 —— 重建会重新拉瓦片，闪白一下很难看。
   * 中心点用郑州大学主校区，zoom 15 大约覆盖 1.7 公里，正好看全校区。
   */
  function initMap() {
    const holder = $('#mapHolder');
    if (!holder || map) return;

    map = TileMap.create(holder, {
      center: [TileMap.CAMPUS.lng, TileMap.CAMPUS.lat],
      zoom: 15,
      source: 'gaode',
      minZoom: 13,
      maxZoom: 19
    });

    // 缩放控件
    const ctrl = document.createElement('div');
    ctrl.className = 'tm-ctrl';
    ctrl.innerHTML = '<button type="button" data-z="in" aria-label="放大">+</button>' +
                     '<button type="button" data-z="out" aria-label="缩小">−</button>';
    ctrl.addEventListener('click', function (e) {
      const b = e.target.closest('[data-z]');
      if (!b) return;
      if (b.dataset.z === 'in') map.zoomIn();
      else map.zoomOut();
    });
    $('#mapCard').appendChild(ctrl);

    // 版权标注。高德的瓦片服务要求保留来源，删掉不合规。
    const attrib = document.createElement('div');
    attrib.className = 'tm-attrib';
    attrib.textContent = '© 高德地图';
    $('#mapCard').appendChild(attrib);
  }

  /**
   * 经纬度 → 相对校中心的屏幕像素。
   * 只用来判断「两个点是不是挤在一起」，不需要考虑地图拖到哪了。
   */
  function screenXY(lng, lat, zoom) {
    const c = TileMap.project(TileMap.CAMPUS.lng, TileMap.CAMPUS.lat, zoom);
    const p = TileMap.project(lng, lat, zoom);
    return { x: p.x - c.x, y: p.y - c.y };
  }

  /**
   * 像素级聚合。
   * 校区只有 1.3 公里宽，16 个问题点在 zoom 15 下平均间距不到 60 像素，
   * 直接铺开会糊成一坨红点。按 30 像素聚类，挤在一起的就变成一个带数字的圈，
   * 点开再展开 —— 这是地图产品的标准做法，也让「哪一片问题最密」一眼看出来。
   */
  function clusterPoints(list, zoom, threshold) {
    const groups = [];
    list.forEach(function (p) {
      const xy = screenXY(p.lng, p.lat, zoom);
      let hit = null;
      for (let i = 0; i < groups.length; i++) {
        const g = groups[i];
        if (Math.hypot(g.x - xy.x, g.y - xy.y) < threshold) { hit = g; break; }
      }
      if (hit) hit.items.push(p);
      else groups.push({ x: xy.x, y: xy.y, items: [p] });
    });
    return groups;
  }

  /** 把点位画到地图上。用户端做坐标脱敏：偏移 ±15 米再显示 */
  function renderMarkers() {
    if (!map) initMap();
    if (!map) return;

    const raw = D.POINTS.filter(function (p) { return p.status === state.layer; });

    // 先脱敏
    const list = raw.map(function (p, i) {
      const f = D.fuzz(p.lng, p.lat, i * 13 + 7);
      return Object.assign({}, p, { _lng: f[0], _lat: f[1], _idx: i });
    });

    const groups = clusterPoints(list, map.getZoom(), 30);
    const marks = [];

    groups.forEach(function (g) {
      if (g.items.length === 1) {
        const p = g.items[0];
        const t = Domain.type(p.type);
        const color = p.status === 'resolved' ? '#3E8A5F' : t.color;
        marks.push({
          id: p.id,
          lng: p._lng,
          lat: p._lat,
          className: 'pin' + (p.merged ? ' is-merged' : ''),
          style: { background: color, color: color },
          title: p.addr,
          onClick: function () { showPoint(p); }
        });
        return;
      }

      // 聚合点：用这一簇里最严重的类型颜色
      const worst = g.items.slice().sort(function (a, b) {
        return Domain.type(b.type).base - Domain.type(a.type).base;
      })[0];
      const t = Domain.type(worst.type);
      const color = state.layer === 'resolved' ? '#3E8A5F' : t.color;
      const lng = g.items.reduce(function (a, p) { return a + p._lng; }, 0) / g.items.length;
      const lat = g.items.reduce(function (a, p) { return a + p._lat; }, 0) / g.items.length;

      marks.push({
        id: 'c' + g.x + '_' + g.y,
        lng: lng,
        lat: lat,
        className: 'pin-cluster',
        style: { borderColor: color, color: color },
        html: '<span>' + g.items.length + '</span>',
        title: g.items.length + ' 个问题',
        onClick: function () { showCluster(g.items); }
      });
    });

    // 我的位置
    if (state.lng && state.layer === 'pending') {
      marks.push({
        id: 'me',
        lng: state.lng,
        lat: state.lat,
        className: 'pin-me',
        title: '我的位置',
        onClick: function () { UI.toast('这是你最近一次定位的位置'); }
      });
    }

    map.setMarkers(marks);
  }

  /** 聚合点展开：列出这一簇里的每一个问题 */
  function showCluster(items) {
    const body = '<div class="picker picker--list">' +
      items.map(function (p) {
        const t = Domain.type(p.type);
        return '<button class="pick-row" data-cl="' + p.id + '" style="gap:10px">' +
                 '<span style="flex:none;width:8px;height:8px;border-radius:50%;background:' +
                   (p.status === 'resolved' ? '#3E8A5F' : t.color) + '"></span>' +
                 '<span style="flex:1;text-align:left">' +
                   UI.escapeHtml(p.addr) +
                   '<br><span class="hint" style="font-size:10.5px">' +
                     t.label + ' · ' + agoText(p.ago) + '</span>' +
                 '</span>' +
                 (p.merged ? '<span class="hint" style="font-size:10.5px">+' + p.merged + ' 人</span>' : '') +
               '</button>';
      }).join('') + '</div>';

    UI.sheet({
      title: '这一片有 ' + items.length + ' 个问题',
      sub: '点开看具体是哪一个',
      body: body,
      onMount: function (api) {
        $$('[data-cl]', api.el).forEach(function (b) {
          b.addEventListener('click', function () {
            const p = items.filter(function (x) { return x.id === b.dataset.cl; })[0];
            api.close();
            setTimeout(function () { if (p) showPoint(p); }, 220);
          });
        });
      }
    });
  }

  function showPoint(p) {
    const typeLabel = D.TYPE_LABEL[p.type];
    const typeMeta = Domain.type(p.type);
    const dept = Domain.deptFor(p.type);
    let body = '';

    if (p.status === 'resolved') {
      body =
        '<div class="sheet-lead">' +
          '<div class="sheet-ico" style="background:var(--ok-bg);color:var(--ok)">' +
            UI.icon('check', 20) + '</div>' +
          '<div style="flex:1">' +
            '<div class="h3">' + UI.escapeHtml(p.addr) + '</div>' +
            '<div class="muted" style="margin-top:3px">' +
              '这个问题 ' + agoText(p.ago) + '被' + p.by + '同学上报，已经处理好了' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="info-card" style="margin-top:0">' +
          '<div class="info-row"><span class="k">问题类型</span><span class="v">' + typeLabel + '</span></div>' +
          '<div class="info-row"><span class="k">负责部门</span><span class="v">' + dept.name + '</span></div>' +
          '<div class="info-row"><span class="k">处理用时</span><span class="v num">' +
            Math.max(0.3, p.ago * 0.55).toFixed(1) + ' 天</span></div>' +
        '</div>';
    } else {
      const people = 1 + (p.merged || 0);
      const pri = Domain.priorityOf(Domain.mergedSeverity(typeMeta.base, people));
      body =
        '<div class="sheet-lead">' +
          '<div class="sheet-ico" style="background:' + typeMeta.soft + ';color:' + typeMeta.color + '">' +
            UI.icon(typeMeta.icon, 20) + '</div>' +
          '<div style="flex:1">' +
            '<div class="h3">' + UI.escapeHtml(p.addr) + '</div>' +
            '<div class="muted" style="margin-top:3px">' +
              agoText(p.ago) + '上报，还没人处理' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="info-card" style="margin-top:0">' +
          '<div class="info-row"><span class="k">问题类型</span><span class="v">' + typeLabel + '</span></div>' +
          '<div class="info-row"><span class="k">负责部门</span><span class="v">' + dept.name + '</span></div>' +
          '<div class="info-row"><span class="k">参与反馈</span><span class="v num">' + people + ' 人</span></div>' +
          '<div class="info-row"><span class="k">当前优先级</span><span class="v">' +
            '<span class="tag" style="background:' + pri.color + '18;color:' + pri.color + '">' +
              pri.id + ' · ' + pri.label + '</span></span></div>' +
          (p.merged ? '<div class="info-row"><span class="k">合并情况</span>' +
            '<span class="v"><span class="tag tag--warn">多人反馈 · 优先级已提升</span></span></div>' : '') +
        '</div>' +
        '<div class="hint" style="margin-top:12px;text-align:center">' +
          '坐标已模糊处理，仅展示大致位置' +
        '</div>';
    }

    UI.sheet({
      title: p.status === 'resolved' ? '这里后来好了' : '这处还没人管',
      body: body + '<div style="height:12px"></div>',
      onMount: function (api) {
        var btn = document.createElement('button');
        btn.className = 'btn btn--ghost btn--block';
        btn.textContent = '知道了';
        btn.addEventListener('click', api.close);
        $('.sheet-bd', api.el).appendChild(btn);
      }
    });
  }

  function bindMap() {
    initMap();
    renderMarkers();

    $$('.layer-row .chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        state.layer = chip.dataset.layer;
        $$('.layer-row .chip').forEach(function (c) { c.classList.toggle('on', c === chip); });
        renderMarkers();
      });
    });

    // 图层切换后地图可能还没尺寸（如果之前是隐藏的），补一次测量
    setTimeout(function () { if (map) map.resize(); }, 60);

    $('#btnRecenter').addEventListener('click', function () {
      if (!map) return;
      if (state.lng) map.flyTo(state.lng, state.lat, 16);
      else map.flyTo(TileMap.CAMPUS.lng, TileMap.CAMPUS.lat, 15);
      UI.toast('已回到我的位置 · 坐标已脱敏');
    });

    const ml = $('#btnMapLocate');
    if (ml) {
      ml.addEventListener('click', function () {
        if (state.lng) {
          map.flyTo(state.lng, state.lat, 17);
          UI.toast('这是你最近一次定位的位置');
        } else {
          realLocate(true);
        }
      });
    }
  }

  /* ============================================================
     4. 上报屏
     ============================================================ */

  /** 一张照片可能来自样例（SVG）也可能来真相机（dataURL），统一在这里出图 */
  function photoOf(ph) {
    if (!ph) return '';
    if (ph.src) return '<img src="' + ph.src + '" alt="现场照片">';
    return D.photoSVG(ph.kind);
  }

  function renderPhotos() {
    const grid = $('#photoGrid');
    let html = state.photos.map(function (ph, i) {
      return '<div class="photo-cell photo-pop">' +
               photoOf(ph) +
               (ph.real ? '<span class="photo-real">' + (ph.demo ? '演示图' : '实拍') + '</span>' : '') +
               '<button class="photo-del" data-del="' + i + '" aria-label="删除">' +
                 UI.icon('close', 11) + '</button>' +
             '</div>';
    }).join('');

    if (state.photos.length < 3) {
      const addLabel = photoRequired() ? '拍照 / 相册' : '添加图片 · 选填';
      html += '<div class="photo-cell">' +
                '<button class="photo-add" id="btnAddPhoto">' +
                  '<span class="plus">' + UI.icon('plus', 15) + '</span>' +
                  '<span>' + addLabel + '</span>' +
                '</button>' +
              '</div>';
    }

    grid.innerHTML = html;

    $$('[data-del]', grid).forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        state.photos.splice(+b.dataset.del, 1);
        if (!state.photos.length) state.preview = null;
        renderPhotos();
        renderSuggest();
        refreshSubmit();
      });
    });

    const add = $('#btnAddPhoto');
    if (add) add.addEventListener('click', openPhotoPicker);
  }

  /**
   * 选图面板。
   * 三条路：真拍照（手机直接起相机）、相册、以及演示用的样例图。
   * 拍照走 <input capture>，在手机上会唤起系统相机；桌面浏览器没有摄像头时
   * 退化成文件选择，照样能传一张本地的图。
   */
  function openPhotoPicker() {
    const samples = [
      { kind: 'trash',   label: '垃圾桶满溢',  note: '清晰 · 含设施' },
      { kind: 'lamp',    label: '路灯不亮',    note: '夜间 · 主体偏暗' },
      { kind: 'pothole', label: '井盖缺失',    note: '路面 · 有隐患' },
      { kind: 'scenery', label: '校园风景',    note: '没有设施' },
      { kind: 'blur',    label: '手抖拍糊',    note: '画面模糊' }
    ];

    const body =
      '<div class="shot-ways">' +
        '<button class="sw-btn is-main" data-way="camera">' +
          '<span class="sw-ic">' + UI.icon('camera', 20) + '</span>' +
          '<span class="sw-t">拍照<small>直接调起摄像头</small></span>' +
        '</button>' +
        '<button class="sw-btn" data-way="album">' +
          '<span class="sw-ic">' + UI.icon('image', 20) + '</span>' +
          '<span class="sw-t">从相册选<small>本地已有照片</small></span>' +
        '</button>' +
      '</div>' +
      '<div class="sw-split"><span>或者用样例图试一遍</span></div>' +
      '<div class="picker">' +
        samples.map(function (o) {
          return '<button class="pick" data-pick="' + o.kind + '">' +
                   '<span class="pick-img">' + D.photoSVG(o.kind) + '</span>' +
                   '<span class="pick-t">' + o.label + '</span>' +
                   '<span class="pick-n">' + o.note + '</span>' +
                 '</button>';
        }).join('') +
      '</div>' +
      '<div class="hint" style="margin-top:12px;text-align:center;line-height:1.6">' +
        '实拍图会在浏览器里先算一遍清晰度、亮度、色彩，再交给 AI 判断内容。<br>' +
        '照片只留在本机，不上传服务器。' +
      '</div>';

    UI.sheet({
      title: '现场照片',
      sub: '拍照 · 相册 · 样例',
      body: body,
      onMount: function (api) {
        $$('[data-pick]', api.el).forEach(function (b) {
          b.addEventListener('click', function () {
            state.photos.push({ kind: b.dataset.pick });
            state.preview = null;
            api.close();
            renderPhotos();
            renderSuggest();
            refreshSubmit();
          });
        });

        $$('[data-way]', api.el).forEach(function (b) {
          b.addEventListener('click', function () {
            const way = b.dataset.way;
            api.close();
            pickFile(way === 'camera');
          });
        });
      }
    });
  }

  /** 起一个隐藏的 file input。capture 只有手机认得，桌面会忽略。 */
  function pickFile(camera) {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    if (camera) inp.setAttribute('capture', 'environment');
    inp.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.appendChild(inp);

    inp.addEventListener('change', function () {
      const file = inp.files && inp.files[0];
      document.body.removeChild(inp);
      if (!file) return;
      if (!/^image\//.test(file.type)) { UI.toast('这个文件不是图片', 'warn'); return; }

      UI.toast('正在读取照片…');
      shrinkImage(file, 1100, 0.82).then(function (dataUrl) {
        state.photos.push({ kind: 'real', src: dataUrl, real: true });
        renderPhotos();
        refreshSubmit();
        UI.toast('照片已添加', 'ok');
        // 图一进来就送去认一遍：顶出候选类型、给一句现成描述
        runPreview();
      }).catch(function () {
        UI.toast('这张图读不出来，换一张试试', 'warn');
      });
    });

    inp.click();
  }

  /**
   * 大图直接塞进内存会卡，先缩到长边 max 再转 JPEG。
   * 1100px 足够 AI 判断，也让 localStorage 装得下。
   */
  function shrinkImage(file, max, quality) {
    return new Promise(function (resolve, reject) {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = function () {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        const ctx = cv.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve(cv.toDataURL('image/jpeg', quality));
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('decode')); };
      img.src = url;
    });
  }

  /**
   * 演示场景的 SVG → 位图。
   *
   * 演示图是 240×180 的矢量插画。以前这类图故意不送模型（模型会说"这不是照片"），
   * 结果演示时只有文字参与判断、看不到画面。现在把插画栅格化成 PNG 一起送，
   * prompt 里也说明了"示意图按画面内容判断"，演示走的就是真的视觉链路。
   */
  function svgToPng(svg, width) {
    return new Promise(function (resolve) {
      const img = new Image();
      img.onload = function () {
        try {
          const W = width || 720;
          const H = Math.max(2, Math.round(W * (img.height || 180) / (img.width || 240)));
          const cv = document.createElement('canvas');
          cv.width = W; cv.height = H;
          const cx = cv.getContext('2d');
          cx.fillStyle = '#fff';
          cx.fillRect(0, 0, W, H);
          cx.drawImage(img, 0, 0, W, H);
          resolve(cv.toDataURL('image/jpeg', 0.88));
        } catch (e) {
          resolve(null);
        }
      };
      img.onerror = function () { resolve(null); };
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    });
  }

  /**
   * 图片即时预判。
   *
   * 用户按下快门之后、还在想怎么描述的那几秒里，把两件事做完：
   *   1. 认出来这是哪一类问题，把候选类型顶在类型区下面，点一下就能换；
   *   2. 写一句现成的描述（"某处井盖缺失，边缘外露"），点一下就填进输入框。
   *
   * 拿不到结果就什么都不显示 —— 这里不猜、不兜底文案。
   * 猜错类型比不猜更糟：用户会以为系统认定了，反而不敢改。
   */
  function runPreview() {
    const ph = state.photos[0];
    if (!ph || !ph.real) { renderSuggest(); return; }

    const seq = ++previewSeq;
    state.previewing = true;
    state.preview = null;
    state.photoGate = null;
    renderSuggest({ loading: true });

    const ag = getAgent();

    /* 先本地过一遍，过了才花一次模型调用。
       糊到看不清的图当场让人重拍 —— 不把一张注定要退的图送去模型，
       也不让用户填完整个表单、点了提交才被拦。 */
    ag.check(ph.src).then(function (qc) {
      if (seq !== previewSeq) return null;
      if (!qc.ok) {
        state.previewing = false;
        state.photoGate = qc;
        renderSuggest({ quality: qc });
        return null;
      }
      return ag.probe().then(function (st) {
        if (seq !== previewSeq) return null;
        if (st.mode !== 'deepseek') {
          state.previewing = false;
          renderSuggest({ offline: true });
          return null;
        }
        return ag.preview({
          image: ph.src,
          type: state.type,
          desc: state.desc,
          address: state.addr
        });
      });
    }).then(function (res) {
      if (seq !== previewSeq || !res) return;
      state.previewing = false;
      if (!res.ok) {
        renderSuggest({ offline: true });
        return;
      }
      state.preview = res;
      renderSuggest();
    }).catch(function () {
      if (seq !== previewSeq) return;
      state.previewing = false;
      renderSuggest();
    });
  }

  let previewSeq = 0;

  /** 把预判结果画出来（类型候选 + 描述建议） */
  function renderSuggest(opt) {
    opt = opt || {};
    const boxT = $('#typeSuggest');
    const boxD = $('#descSuggest');
    if (!boxT || !boxD) return;

    if (opt.loading) {
      boxT.hidden = false;
      boxT.innerHTML =
        '<div class="ts-head"><span class="ts-ic">' + UI.icon('spark', 13) + '</span>正在认这张图…</div>' +
        '<div class="ts-note">认出来会把类型顶上来，描述也能一键填入</div>';
      boxD.hidden = true;
      return;
    }

    if (opt.quality) {
      boxT.hidden = false;
      boxT.innerHTML =
        '<div class="ts-head" style="color:var(--warn)">' +
          '<span class="ts-ic">' + UI.icon('alert', 13) + '</span>' +
          UI.escapeHtml(opt.quality.message || '这张照片本地检查没过') +
        '</div>' +
        '<div class="ts-note">本地只看清晰度和亮度。这张没过，AI 也看不清，先重拍一张更清楚的再提交。</div>';
      boxD.hidden = true;
      return;
    }

    if (opt.offline) {
      boxT.hidden = false;
      boxT.innerHTML =
        '<div class="ts-head"><span class="ts-ic">' + UI.icon('spark', 13) + '</span>AI 没连上</div>' +
        '<div class="ts-note">图片还没送去识别。提交前需要连上 AI，否则这条不会被分析 —— 稍后再试或检查本地代理。</div>';
      boxD.hidden = true;
      return;
    }

    const p = state.preview;
    if (!p) {
      boxT.hidden = true;
      boxT.innerHTML = '';
      boxD.hidden = true;
      boxD.innerHTML = '';
      return;
    }

    if (p.isFacility === false) {
      boxT.hidden = false;
      boxT.innerHTML =
        '<div class="ts-head"><span class="ts-ic">' + UI.icon('alert', 13) + '</span>这张里没看出设施问题</div>' +
        '<div class="ts-note">如果确实要报，建议把镜头对准设施本身再拍一张</div>';
      boxD.hidden = true;
      return;
    }

    const t = D.TYPES.filter(function (x) { return x.key === p.type; })[0];
    const label = t ? t.label : p.type;
    const on = state.type === p.type;

    boxT.hidden = false;
    boxT.innerHTML =
      '<div class="ts-head"><span class="ts-ic">' + UI.icon('spark', 13) + '</span>' +
        'AI 看这张图，像是这一类' +
      '</div>' +
      '<div class="ts-chips">' +
        '<button class="ts-chip" data-sug-type="' + p.type + '"' + (on ? ' style="border-color:var(--brand);background:var(--brand-light)"' : '') + '>' +
          '<b>' + label + '</b>' + (on ? ' · 已选中' : '') +
        '</button>' +
      '</div>' +
      '<div class="ts-note">认错了直接改上面的类型就行，不用管它</div>';

    const btn = boxT.querySelector('[data-sug-type]');
    if (btn) {
      btn.addEventListener('click', function () {
        state.type = btn.dataset.sugType;
        renderTypes();
        renderPtLadder();
        refreshSubmit();
        renderSuggest();
        UI.toast('已换成「' + label + '」', 'ok');
      });
    }

    if (p.desc) {
      boxD.hidden = false;
      boxD.innerHTML =
        '<span class="ds-ic">' + UI.icon('spark', 14) + '</span>' +
        '<div class="ds-main">' +
          '<div class="ds-k">你可能想上报</div>' +
          '<div class="ds-t">' + UI.escapeHtml(p.desc) + '</div>' +
        '</div>' +
        '<span class="ds-use">填入</span>';
      boxD.onclick = function () {
        applySuggestedDesc(p.desc);
      };
    } else {
      boxD.hidden = true;
    }
  }

  /** 点建议 → 填进描述框。已经写过内容的，用分号接上，不覆盖人家的话 */
  function applySuggestedDesc(text) {
    const cur = (state.desc || '').trim();
    const next = cur
      ? (cur.indexOf(text) >= 0 ? cur : cur + '；' + text)
      : text;
    state.desc = next.slice(0, 100);
    $('#descInput').value = state.desc;
    $('#descCount').textContent = state.desc.length;
    refreshSubmit();
    UI.toast('已填入描述，可以再改', 'ok');
  }

  function renderTypes() {
    const row = $('#typeRow');
    row.innerHTML = D.TYPES.map(function (t) {
      return '<button class="chip' + (state.type === t.key ? ' on' : '') + '" data-type="' + t.key + '">' +
               UI.icon(t.icon, 14) + t.label +
             '</button>';
    }).join('');

    $$('[data-type]', row).forEach(function (b) {
      b.addEventListener('click', function () {
        state.type = b.dataset.type;
        renderTypes();
        renderPtLadder();
        refreshSubmit();
      });
    });
  }

  /**
   * 表单里的积分档位条。
   *
   * 提交之前就把「这单大概值多少」摆出来，是为了避免结果页那种落差：
   * 报的时候以为能拿 90，办结发现只给了 25。这里把五个星级和类型系数
   * 一起摊开，用户选完类型就能看到自己这一类的价格区间。
   *
   * 数字全部来自 Payout，界面不自己算——否则改价之后两边对不上。
   */
  function renderPtLadder() {
    const box = $('#ptLadder');
    if (!box || !window.Payout) return;

    const typeName = state.type ? (D.TYPE_LABEL[state.type] || '') : '';
    const rows = Payout.ladder();
    const pts = rows.map(function (r) {
      return Payout.estimate({ severity: r.severity, type: state.type || 'other' });
    });

    box.innerHTML =
      '<div class="pt-steps">' +
        rows.map(function (r, i) {
          return '<span class="pt-step' + (r.severity >= 4 ? ' is-hot' : '') + '">' +
                   '<b>' + pts[i] + '</b><i>' + r.severity + ' 星</i>' +
                 '</span>';
        }).join('') +
      '</div>' +
      '<div class="pt-scale">' +
        (typeName
          ? '按「' + typeName + '」算 · 独立发现满额，帮别人确认 ×0.6'
          : '选好类型后，这里会换成这类问题的价格') +
      '</div>';
  }

  /** 模拟定位：真实小程序走 wx.getLocation，这里给个固定的校园坐标 */
  /* ---------------- 定位 ---------------- */

  /** 把坐标翻译成人话：找最近的地标 */
  function nearestLandmark(lng, lat) {
    let best = null;
    let bestD = Infinity;
    D.LANDMARKS.forEach(function (m) {
      const d = TileMap.distance(lng, lat, m.lng, m.lat);
      if (d < bestD) { bestD = d; best = m; }
    });
    return { landmark: best, distance: bestD };
  }

  /**
   * 写入定位结果。
   * force=false 时，如果已经有坐标了就不覆盖 —— 否则会出现这种情况：
   * 演示场景预置了精确坐标，2 秒后定位超时的兜底回调把坐标改回校区中心，
   * 于是「合并判定」找不到附近点位，整个演示链路断掉。
   */
  function applyLocation(lng, lat, source, force) {
    if (!force && state.located) return;

    const near = nearestLandmark(lng, lat);
    state.lng = lng;
    state.lat = lat;
    state.located = true;

    if (!state.addr) {
      if (near.distance <= 400) {
        state.addr = near.landmark.name + '附近';
      } else if (near.distance <= 1500) {
        state.addr = near.landmark.name + '以东约 ' + Math.round(near.distance) + ' 米';
      } else {
        state.addr = '校区内 · 已获取坐标';
      }
    }

    $('#addrInput').value = state.addr;
    $('#locState').textContent = source === 'gps' ? '已定位'
      : source === 'manual' ? '已手动选点' : '已定位 · 默认位置';

    // 手动选点或真定位成功后，把"定位失败"提示收起来
    if (source === 'gps' || source === 'manual') {
      const alertEl = $('#locAlert');
      if (alertEl) alertEl.hidden = true;
    }

    const meta = $('#coordMeta');
    if (meta && meta.lastElementChild) {
      // 展示时只到 5 位小数（约 1 米），并说明还会再模糊
      meta.lastElementChild.textContent =
        lat.toFixed(5) + ', ' + lng.toFixed(5) + ' · 展示时模糊到约 100 米';
    }

    // 地图上标出"我在这里"。
    // 兜底位置（校区中心）不是真的我，用大光圈表示"只知道在这一带"。
    if (map) {
      map.setMe(lng, lat, { spread: source === 'fallback' });
      // 定位成功时把地图移到我这儿，别让人自己找
      if (source === 'gps' || source === 'manual') {
        map.flyTo(lng, lat, Math.max(map.getZoom(), 16));
        renderMarkers();
      }
    }

    refreshSubmit();
  }

  /**
   * 调浏览器的定位。
   * 注意：file:// 协议下浏览器会直接拒绝定位权限，必须用 server/proxy.mjs
   * 起的 http://localhost 打开，定位才可用。拿不到就老实降级到校区中心，
   * 并明确告诉用户「这是默认位置」。
   */
  function realLocate(force) {
    const label = $('#locState');
    if (label) label.textContent = '定位中…';

    if (!navigator.geolocation) {
      fallbackLocate('这个浏览器不支持定位', force);
      return;
    }

    let settled = false;
    const timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      fallbackLocate('定位超时', force);
    }, 9000);

    navigator.geolocation.getCurrentPosition(
      function (pos) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);

        const lng = pos.coords.longitude;
        const lat = pos.coords.latitude;
        const away = TileMap.distance(lng, lat, TileMap.CAMPUS.lng, TileMap.CAMPUS.lat);

        // 人在校外还要报校内的问题，这是正常场景（比如回宿舍路上想起昨天路过的地方）
        // 所以不拦，只是提示一下，并把视图拉回校区
        applyLocation(lng, lat, 'gps', force);
        const acc = pos.coords.accuracy ? Math.round(pos.coords.accuracy) : 0;
        UI.toast('定位成功' + (acc ? ' · 精度约 ' + acc + ' 米' : ''), 'ok');

        if (away > 5000) {
          UI.toast('你不在校区附近，可以手动改成具体位置');
        }
      },
      function (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fallbackLocate(geoErrText(err), force);
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
    );
  }

  function geoErrText(err) {
    switch (err && err.code) {
      case 1: return '定位权限被拒绝了';
      case 2: return '暂时收不到位置信号';
      case 3: return '定位超时';
      default: return '定位不可用';
    }
  }

  /** 拿不到定位时的兜底：落在校区中心，并说清楚这是默认值 */
  function fallbackLocate(reason, force) {
    setTimeout(function () {
      applyLocation(TileMap.CAMPUS.lng, TileMap.CAMPUS.lat, 'fallback', force);

      // 桌面浏览器没有 GPS 模块，定位大概率走不通。
      // 与其只弹个 toast（两秒就没了），不如把两条明路摆在表单里。
      const alertEl = $('#locAlert');
      if (alertEl) {
        alertEl.hidden = false;
        $('#locAlertText').textContent = (reason || '获取不到定位') +
          ' · 当前用的是校区中心';
      }

      if (reason) {
        const detail = location.protocol === 'file:'
          ? '本地文件方式打开时浏览器会禁用定位，用 http://localhost:8787 打开即可'
          : '可以先在图上选点，不影响提交';
        UI.toast(reason + ' · ' + detail, 'warn');
      }
    }, 260);
  }

  /* ---------------- 可提交判断 ---------------- */

  /**
   * 这一类要不要照片。
   * 规则收在 domain.js：路面、井盖、垃圾这些没有图就没法派人，
   * 断网、校园网卡这些拍不出所以然，改成选填。
   */
  function photoRequired() {
    return window.Domain && Domain.photoRequired ? Domain.photoRequired(state.type) : true;
  }

  function descTooShort() {
    return (state.desc || '').trim().length < 4;
  }

  function canSubmit() {
    if (!state.type || !state.located) return false;
    if (photoRequired() && !state.photos.length) return false;
    // 不拍照可以，但得说清楚是什么事 —— 否则后台只收到一句"网卡了"
    if (!state.photos.length && descTooShort()) return false;
    return true;
  }

  function refreshSubmit() {
    const btn = $('#btnSubmit');
    if (!btn) return;
    const ok = canSubmit();
    btn.setAttribute('aria-disabled', ok ? 'false' : 'true');

    // 照片区的说明跟着类型变：必传的讲怎么拍，选填的讲为什么要传
    const req = $('#photoReq');
    const hint = $('#photoHint');
    if (req) {
      req.textContent = photoRequired() ? '最多 3 张 · 这一类需要照片' : '最多 3 张 · 选填';
    }
    if (hint) {
      hint.textContent = photoRequired()
        ? '拍清楚设施本身，AI 更容易判断'
        : '这一类不拍也能报。有图的话，后勤不用先跑一趟确认位置';
    }

    const tip = $('#submitTip');
    if (!tip) return;
    let msg = '';
    if (!state.type) msg = '还差一步：选一个问题类型';
    else if (!state.located) msg = '还在定位，也可以手动填个位置';
    else if (photoRequired() && !state.photos.length) msg = '这一类需要一张现场照片，方便后勤直接派对应班组';
    else if (!state.photos.length && descTooShort()) msg = '不拍照的话，写一句是什么问题（至少 4 个字）';

    if (msg) {
      tip.hidden = false;
      tip.textContent = msg;
      tip.classList.toggle('is-block', photoRequired() && !state.photos.length);
    } else {
      const g = window.Guard ? Guard.remain() : null;
      if (g && g.coolLeft > 0) {
        tip.hidden = false;
        tip.textContent = '连续几次没识别通过，先歇 ' + Math.ceil(g.coolLeft / 60) + ' 分钟再报';
        tip.classList.add('is-block');
      } else {
        tip.hidden = true;
        tip.textContent = '';
        tip.classList.remove('is-block');
      }
    }
  }

  function resetForm(keepAddr) {
    state.photos = [];
    state.type = '';
    state.desc = '';
    state.preview = null;
    state.photoGate = null;
    if (!keepAddr) state.addr = '';
    $('#descInput').value = '';
    $('#descCount').textContent = '0';
    $('#addrInput').value = state.addr;
    renderPhotos();
    renderTypes();
    renderPtLadder();
    renderSuggest();
    refreshSubmit();
  }

  function bindReport() {
    $('#descInput').addEventListener('input', function (e) {
      state.desc = e.target.value.slice(0, 100);
      $('#descCount').textContent = state.desc.length;
      // 不拍照的类型靠描述判断能不能提交，所以每次输入都要重算
      refreshSubmit();
    });

    $('#addrInput').addEventListener('input', function (e) {
      state.addr = e.target.value;
    });

    $('#btnFixLoc').addEventListener('click', openPickSheet);

    // 定位失败提示里的两个出口
    const btnRelocate = $('#btnRelocate');
    if (btnRelocate) {
      btnRelocate.addEventListener('click', function () {
        const alertEl = $('#locAlert');
        if (alertEl) alertEl.hidden = true;
        realLocate(true);
      });
    }
    const btnPickOnMap = $('#btnPickOnMap');
    if (btnPickOnMap) btnPickOnMap.addEventListener('click', openPickSheet);

    $('#btnSubmit').addEventListener('click', submit);
  }

  /** 手动选点后的统一收尾：地址、坐标、状态、按钮一起更新 */
  function applyManual(lng, lat, name) {
    state.lng = lng;
    state.lat = lat;
    state.located = true;

    if (name) {
      state.addr = name;
    } else {
      const near = nearestLandmark(lng, lat);
      state.addr = near.distance <= 400
        ? near.landmark.name + '附近'
        : near.distance <= 1500
          ? near.landmark.name + '以东约 ' + Math.round(near.distance) + ' 米'
          : '校区内 · 已手动选点';
    }

    $('#addrInput').value = state.addr;
    $('#locState').textContent = '已手动选点';

    const meta = $('#coordMeta');
    if (meta && meta.lastElementChild) {
      meta.lastElementChild.textContent =
        lat.toFixed(5) + ', ' + lng.toFixed(5) + ' · 展示时模糊到约 100 米';
    }

    const alertEl = $('#locAlert');
    if (alertEl) alertEl.hidden = true;

    // 主地图上的蓝点跟着手选的位置走
    if (map) map.setMe(lng, lat);

    refreshSubmit();
  }

  /**
   * 选位置：上面一张小地图点选，下面一列地标。
   * 两条路都留着——赶时间点地标，要精确就在图上点。
   */
  function openPickSheet() {
    const spots = D.LANDMARKS.map(function (m) {
      return '<button class="pick-row" data-spot="' + m.id + '">' +
               UI.icon('pin', 15) +
               '<span style="flex:1;text-align:left">' + UI.escapeHtml(m.name) + '</span>' +
               '<span class="hint num">' + m.lng.toFixed(4) + ', ' + m.lat.toFixed(4) + '</span>' +
             '</button>';
    }).join('');

    const body =
      '<div class="pick-map" id="pickMap"></div>' +
      '<div class="pick-note" id="pickNote">在图上点一下就能选点</div>' +
      '<div class="picker picker--list" style="margin-top:10px">' + spots + '</div>' +
      '<button class="btn btn--primary btn--block" id="pickOk" style="margin-top:10px">用这个位置</button>';

    let chosen = null;

    UI.sheet({
      title: '选择位置',
      sub: '点哪里就是哪里 · 坐标自动对齐',
      body: body,
      onMount: function (api) {
        const mapEl = $('#pickMap', api.el);
        const noteEl = $('#pickNote', api.el);

        const m = TileMap.create(mapEl, {
          center: [state.lng || TileMap.CAMPUS.lng, state.lat || TileMap.CAMPUS.lat],
          zoom: 16,
          source: 'gaode',
          onClick: function (lng, lat) { choose(lng, lat); }
        });
        // 弹层刚展开时容器尺寸还没稳定，等一帧再量
        setTimeout(function () { m.resize(); }, 80);

        function choose(lng, lat) {
          chosen = { lng: lng, lat: lat };
          m.setMarkers([{
            id: 'pick', lng: lng, lat: lat,
            className: 'is-pick',
            html: '<span class="pick-dot"><i></i></span>'
          }]);
          noteEl.textContent = '已选中 · ' + lat.toFixed(5) + ', ' + lng.toFixed(5);
        }

        if (state.lng) choose(state.lng, state.lat);

        $$('[data-spot]', api.el).forEach(function (b) {
          b.addEventListener('click', function () {
            const spot = D.LANDMARKS.filter(function (x) { return x.id === b.dataset.spot; })[0];
            if (!spot) return;
            chosen = { lng: spot.lng, lat: spot.lat, name: spot.name };
            m.flyTo(spot.lng, spot.lat, 17);
            m.setMarkers([{
              id: 'pick', lng: spot.lng, lat: spot.lat,
              className: 'is-pick',
              html: '<span class="pick-dot"><i></i></span>'
            }]);
            noteEl.textContent = '已选中 · ' + spot.name;
          });
        });

        $('#pickOk', api.el).addEventListener('click', function () {
          if (!chosen) {
            UI.toast('先在图上点一下，或者挑一个地标');
            return;
          }
          applyManual(chosen.lng, chosen.lat, chosen.name);
          api.close();
          UI.toast('位置已更新', 'ok');
        });
      }
    });
  }

  /* ============================================================
     5. AI 分析遮罩
     ============================================================ */

  const STEPS = [
    '正在检查照片清晰度',
    '正在确认设施类型',
    '正在匹配语义描述',
    '正在生成处置建议'
  ];

  let maskEl = null;
  let maskTimer = null;

  function openAiMask() {
    closeAiMask(true);
    const host = $('#screens');
    maskEl = document.createElement('div');
    maskEl.className = 'ai-mask';
    maskEl.innerHTML =
      '<div class="ai-box">' +
        '<div class="ai-orb">' +
          '<span class="ring"></span><span class="ring"></span><span class="ring"></span>' +
          '<span class="core">' + UI.icon('spark', 20) + '</span>' +
        '</div>' +
        '<div class="ai-title">AI 哨兵正在看</div>' +
        '<div class="ai-step" id="aiStep">' + STEPS[0] + '</div>' +
        '<div class="ai-bar"><i></i></div>' +
      '</div>';
    host.appendChild(maskEl);

    let i = 0;
    maskTimer = setInterval(function () {
      i = (i + 1) % STEPS.length;
      const el = $('#aiStep');
      if (!el) return;
      el.style.opacity = '0';
      setTimeout(function () { el.textContent = STEPS[i]; el.style.opacity = '1'; }, 130);
    }, 720);
  }

  function closeAiMask(immediate) {
    if (maskTimer) { clearInterval(maskTimer); maskTimer = null; }
    if (!maskEl) return;
    const el = maskEl;
    maskEl = null;
    if (immediate) { el.remove(); return; }
    el.style.transition = 'opacity .22s';
    el.style.opacity = '0';
    setTimeout(function () { el.remove(); }, 240);
  }

  /* ============================================================
     6. 提交与结果
     ============================================================ */

  /* ---------------- 智能体单例 ---------------- */

  let agent = null;

  /** 个人中心那一行「AI 连接状态」，探活结果直接画出来 */
  function paintAiBadge(st) {
    const badge = $('#aiModeBadge');
    if (!badge) return;
    badge.textContent = st.mode === 'deepseek'
      ? (st.vision ? 'DeepSeek 看图 · ' + (st.model || 'deepseek-flash')
                   : 'DeepSeek 文本 · ' + (st.model || 'deepseek-flash'))
      : 'AI 未连接 · 点此重试';
    badge.dataset.mode = st.mode;
  }

  function getAgent() {
    if (!agent) {
      agent = SentinelAgent.create({ mode: 'auto' });
      // 探测本地代理。探不到就照实显示"AI 未连接"—— 不假装还有规则兜底。
      agent.probe().then(paintAiBadge);
    }
    return agent;
  }

  /**
   * 图文矛盾的二次确认。
   *
   * 只在一种情况下弹：照片和描述说的是两件事（描述"灯不亮"，照片是井盖缺失）。
   * 类型点错不弹 —— 那种事 AI 自己改完就行，用户没必要参与。
   *
   * 弹出的内容必须是"改好之后的成品"，不是让用户自己重写：
   * 类型、描述、以及为什么这么改，都给全，用户只需要点一下。
   *
   * @returns {Promise<'apply'|'keep'|'cancel'>}
   */
  function askConflict(v, origType) {
    return new Promise(function (resolve) {
      let settled = false;
      function done(act) {
        if (settled) return;
        settled = true;
        resolve(act);
      }

      const fromType = D.TYPE_LABEL[origType || state.type] || '未选择';
      const toType = D.TYPE_LABEL[v.type] || fromType;
      const origDesc = (state.desc || '').trim();

      const body =
        '<div class="cf-lead">照片和你写的内容对不上，以照片为准整理了一版，确认一下再提交。</div>' +

        '<div class="cf-compare">' +
          '<div class="cf-col">' +
            '<div class="cf-k">你填的</div>' +
            '<div class="cf-type">' + UI.escapeHtml(fromType) + '</div>' +
            '<div class="cf-desc">' + UI.escapeHtml(origDesc || '（没有描述）') + '</div>' +
          '</div>' +
          '<div class="cf-col is-ai">' +
            '<div class="cf-k">照片里是</div>' +
            '<div class="cf-type">' + UI.escapeHtml(toType) + '</div>' +
            '<div class="cf-desc">' + UI.escapeHtml(v.suggestDesc || '') + '</div>' +
          '</div>' +
        '</div>' +

        (v.conflictNote
          ? '<div class="cf-why">' + UI.icon('spark', 12) + '<span>' + UI.escapeHtml(v.conflictNote) + '</span></div>'
          : '') +

        '<button class="btn btn--primary btn--block" id="cfApply" style="margin-top:14px">按这版提交</button>' +
        '<button class="btn btn--ghost btn--block" id="cfKeep" style="margin-top:8px">保留我写的</button>' +
        '<button class="btn btn--text btn--block" id="cfCancel" style="margin-top:4px">先不报，我改一下</button>';

      UI.sheet({
        title: '核对一下再提交',
        sub: '照片和描述不一致，以照片为准',
        body: body,
        onClose: function () { done('cancel'); },
        onMount: function (api) {
          $('#cfApply', api.el).addEventListener('click', function () {
            done('apply');
            api.close();
          });
          $('#cfKeep', api.el).addEventListener('click', function () {
            done('keep');
            api.close();
          });
          $('#cfCancel', api.el).addEventListener('click', function () {
            done('cancel');
            api.close();
          });
        }
      });
    });
  }

  async function submit() {
    if (!canSubmit()) {
      if (!state.type) UI.toast('选一下问题类型');
      else if (!state.located) UI.toast('还没有获取到位置');
      else if (photoRequired() && !state.photos.length) UI.toast('这一类需要一张现场照片');
      else UI.toast('写一句是什么问题（至少 4 个字）');
      return;
    }

    /* 照片指纹：判"同一张图反复用"。
       只给真拍/真传的图算指纹 —— 示意图是所有人共用的素材，算出来必然一样，
       拿它去拦人等于把演示路径堵死。算不出指纹（画布被污染、图太大）就跳过，
       宁可少拦一次，也不能让人因为技术原因报不上。 */
    let photoHash = null;
    if (window.Guard && Guard.hashImage) {
      const p0 = state.photos[0];
      // 演示图是内置素材，每次运行都是同一张，不能拿它去触发「同图」拦截
      if (p0 && p0.real && p0.src && !p0.demo) photoHash = await Guard.hashImage(p0.src);
    }

    /* 防刷：间隔、同图、重复、配额、冷静期，都在 Guard 里。
       这里不是防坏人 —— 改代码的人拦不住；是拦"手滑连点"和"情绪化刷屏"。 */
    if (window.Guard) {
      const g = Guard.check({
        type: state.type, lng: state.lng, lat: state.lat, photoHash: photoHash
      });
      if (!g.ok) {
        UI.toast(g.message, 'warn');
        refreshSubmit();
        return;
      }
    }

    const ag = getAgent();
    const st = ag.status();
    const t0 = Date.now();

    openAiMask();

    const v = await ag.judge({
      image: state.photos.length
        ? (state.photos[0].src || D.photoDataURI(state.photos[0].kind))
        : '',
      // 演示图要在 prompt 里说明"这是示意图"，模型才不会因为不是实拍而驳回
      demo: !!(state.photos[0] && state.photos[0].demo),
      type: state.type,
      desc: state.desc,
      address: state.addr,
      lng: state.lng,
      lat: state.lat
    });

    // 这里曾经有一段「实拍图画质一律放行」的逻辑，理由是阈值是拿示意图
    // 标定的，怕误杀夜景。方向对，做法错：它把 blank（镜头被挡、拍到桌面、
    // 一片纯色）也一起放了，闸门一等于不存在。
    // 现在由 agent.js 分流：没拍到东西是硬拦（重拍），拍到了但没拍好是
    // 软提示（放行 + 进人工复核）。前端不再二次覆盖模型的结论。

    // 真实模型通常 1–3 秒。太快反而显得"根本没在看"，兜一个下限；
    // 离线时不用等 —— 尽快把"没连上"告诉用户。
    const minWait = st.mode === 'deepseek' ? 700 : 0;
    const rest = minWait - (Date.now() - t0);
    if (rest > 0) await sleep(rest);

    closeAiMask();
    await sleep(140);

    /* AI 没连上 / 调用失败：这条不落库，表单原样留着。
       没有降级、没有模板摘要 —— 演示时宁可当场看见"没分析"，
       也不要出现一段和照片对不上的分析。 */
    if (v.stage === 'ai') {
      showAiDown(v);
      return;
    }

    /* 本地画质没过：直接让用户重拍，不送去 AI，也不算一次 AI 驳回
       （否则手机镜头脏的人会被连续 3 次的冷静期锁住）。 */
    if (v.stage === 'local') {
      showReject(v);
      return;
    }

    if (!v.pass) {
      if (window.Guard) Guard.noteReject();
      state.invalidStreak++;
      showReject(v);
      return;
    }
    if (window.Guard) Guard.notePass();

    /* 类型点错：直接换成 AI 认出来的那一类，不打断、不提示。
       用户点错按钮是常事，为此驳回一次等于让人重填一遍全表 ——
       该改的是分类，不是人的态度。 */
    let typeFrom = null;
    if (v.type && v.type !== state.type) {
      typeFrom = state.type;
      state.type = v.type;
      renderTypes();
      renderPtLadder();
    }

    /* 描述与画面矛盾：这才是真需要用户点头的情况。
       以图片为准给出改好的版本，让用户确认一次再提交。 */
    let conflictAction = '';
    if (v.conflict) {
      const act = await askConflict(v, typeFrom || state.type);
      if (act === 'cancel') {
        refreshSubmit();
        return;
      }
      if (act === 'apply') {
        state.type = v.type || state.type;
        state.desc = (v.suggestDesc || '').slice(0, 100);
        $('#descInput').value = state.desc;
        $('#descCount').textContent = state.desc.length;
        renderTypes();
        renderPtLadder();
        conflictAction = 'applied';
      } else {
        conflictAction = 'kept';
      }
      refreshSubmit();
    }

    const merge = checkMerge();
    state.invalidStreak = 0;

    // 合并之后真实生效的紧急度：报告页和工单里必须是同一个数
    const finalSeverity = (merge.merged && merge.severityAfter > v.severity)
      ? merge.severityAfter
      : v.severity;

    const s = A.get();
    const photo0 = state.photos[0];

    // 提交前就把这一单值多少分算清楚，并且存进工单。
    // 存下来而不是等办结再算，是为了让「预计 +65」和最终到账的数字一定一致：
    // 这套规则以后要调价，调价不该回头改已经报上去的单子。
    const rewardKind = merge.merged
      ? (merge.kind === 'crowd' ? 'crowd' : 'self')
      : 'solo';
    const estPoints = window.Payout
      ? Payout.estimate({ severity: finalSeverity, type: state.type, kind: rewardKind })
      : 0;

    const ticket = A.registerTicket({
      type: state.type,
      addr: state.addr || '已记录坐标',
      lng: state.lng,
      lat: state.lat,
      dept: Domain.deptFor(state.type).name,
      severity: finalSeverity,
      /* 状态必须在这里定下来。
         以前漏了这一个字段，落盘的单子全是 pending —— 界面上写着"人工复核"，
         后台的复核队列里却一条都没有，等于这条单没人管。 */
      status: (A.needsHumanReview() || v.review) ? 'review' : 'pending',
      merged: !!merge.merged,
      reporters: merge.reporters || 1,
      kind: rewardKind,
      estPoints: estPoints,
      ownerId: s ? s.id : A.deviceId(),
      ownerKind: s ? s.kind : 'guest',
      // 实拍图带一张缩略图过去，后台现场模式能直接看到现场长什么样
      photo: photo0 ? (photo0.src || null) : null,
      desc: state.desc || '',
      // 判定过程也一起存下来：后台要看的是"AI 为什么放行"，不是只看到一个绿点
      analysis: {
        pass: !!v.pass,
        stage: v.stage || 'ai',
        source: v.source || 'deepseek',
        reason: v.reason || null,
        summary: v.summary || '',
        advice: v.advice || '',
        // soft = 画质存疑但放行了；这类单子后台要标出来，别当成干净单
        soft: !!v.qualityHint,
        qualityHint: v.qualityHint || null,
        review: !!v.review,
        // 为什么要人工复核：no-vision = 有图但没跑模型，等于没人看过这张图
        reviewWhy: v.reviewWhy || '',
        // 模型自述"看到了什么" —— 后台要能核对它是不是真看了图
        seen: v.seen || '',
        sawImage: !!v.sawImage,
        metrics: v.metrics || null,
        severity: finalSeverity,
        latency: v.latency || 0,
        // 类型被改过：后台能看到"用户点的"和"AI 判的"分别是哪个
        typeAdjusted: !!(v.typeAdjusted || typeFrom),
        typeFrom: typeFrom || v.typeFrom || null,
        typeTo: state.type,
        // 图文矛盾：applied = 用户采纳了 AI 的版本，kept = 用户坚持自己的
        conflict: !!v.conflict,
        conflictAction: conflictAction || (v.conflict ? 'kept' : ''),
        conflictNote: v.conflictNote || '',
        // 这张单没有照片（网络类问题允许不拍）
        noPhoto: !state.photos.length
      }
    });

    const rec = {
      id: 'q' + Date.now(),
      code: ticket.code,
      type: state.type,
      status: (A.needsHumanReview() || v.review) ? 'review' : 'pending',
      addr: state.addr || '已记录坐标',
      ago: 0,
      merged: merge.merged ? Math.max(1, merge.reporters - 1) : 0,
      estPoints: estPoints,
      photo: state.photos.length ? state.photos[0].kind : 'none',
      lng: state.lng,
      lat: state.lat
    };
    state.reports.unshift(rec);

    // 记一笔：下一次提交要过间隔/同图/配额/重复几道检查
    if (window.Guard) {
      Guard.record({
        type: state.type, lng: state.lng, lat: state.lat,
        code: ticket.code, photoHash: photoHash
      });
    }

    // 结算走 Auth：这一步只动学分与权重。
    // 积分一个子儿都不发 —— 等后勤到场核实、真处理完了才结算，
    // 这里只把预估额带回结果页，让人知道这单值多少、什么时候到。
    const reward = A.rewardValid({
      merged: !!merge.merged,
      crowd: merge.kind === 'crowd',
      estPoints: estPoints
    });
    applySession();
    const newBadges = grantBadges(v, merge.merged, true);

    showPass(v, merge, newBadges, ticket.code, reward, estPoints);

    // 这一条已经交出去了：下次进上报页先把表单清干净，
    // 但不要现在就清 —— 结果页上的类型、位置还得靠它显示
    state.formStale = true;
  }

  /**
   * 合并判定。用真实球面距离，不是"地址字符串相等"——
   * 同一个地方不同人会有不同叫法，「图书馆南广场」和「图书馆前广场」
   * 字面不同但其实是同一根灯杆。
   *
   * 两种合并语义不一样：
   *   同一人重复报   → 并进原工单，但不动优先级（否则能靠刷单抬优先级）
   *   不同人报同一处 → 并进原工单，且每多一人紧急度 +1
   */
  function checkMerge() {
    if (!state.lng || !state.type) return { merged: false, reporters: 1, kind: null };

    const near = D.findNearby(state.lng, state.lat, state.type, D.POINTS);
    if (!near.length) return { merged: false, reporters: 1, kind: null };

    // 取最近的那一条作为合并目标
    let target = near[0];
    let best = Infinity;
    near.forEach(function (p) {
      const d = TileMap.distance(state.lng, state.lat, p.lng, p.lat);
      if (d < best) { best = d; target = p; }
    });

    const selfDup = target.by === state.user.initial;
    const prevPeople = Math.max(1, target.reporters || (1 + (target.merged || 0)));
    const people = prevPeople + 1;

    const meta = Domain.type(state.type);
    const before = Domain.mergedSeverity(meta.base, prevPeople);
    const after = selfDup ? before : Domain.mergedSeverity(meta.base, people);

    // 回写到点位，让下一次续报还能继续累加
    target.merged = (target.merged || 0) + 1;
    target.reporters = people;

    return {
      merged: true,
      kind: selfDup ? 'self' : 'crowd',
      target: target,
      distance: Math.max(1, Math.round(best)),
      reporters: people,
      severityBefore: before,
      severityAfter: after
    };
  }

  function grantBadges(v, merged, isDaytime) {
    const owned = state.user.badges;
    const earned = [];

    function add(code) {
      if (owned.indexOf(code) < 0 && earned.indexOf(code) < 0) earned.push(code);
    }

    if (state.user.validCnt >= 1) add('first_report');
    if (state.type === 'safety' && v.severity >= 4) add('eagle_eye');
    if (merged) add('crowd');
    const h = new Date().getHours();
    if (h >= 22 || h < 6) add('night_watch');
    const cnt = state.reports.filter(function (r) {
      return r.type === 'sanitation' && r.status !== 'rejected';
    }).length;
    if (cnt >= 10) add('clean_hand');
    if (state.user.streak >= 7) add('gold_sentinel');

    if (earned.length) {
      state.user.badges = owned.concat(earned);
      A.patch({ badges: state.user.badges });
    }
    return earned.map(function (code) {
      return D.BADGES.filter(function (b) { return b.code === code; })[0];
    }).filter(Boolean);
  }

  function starsHTML(n) {
    let s = '';
    for (let i = 1; i <= 5; i++) s += '<i class="' + (i <= n ? 'on' : '') + '"></i>';
    return '<span class="stars">' + s + '<span class="n num">' + n + ' / 5</span></span>';
  }

  function showPass(v, merge, newBadges, code, reward, estPoints) {
    const typeLabel = D.TYPE_LABEL[state.type];
    const dept = Domain.deptFor(state.type);
    const isGuest = !state.session || state.session.kind === 'guest';
    // 合并会抬升紧急度，界面上要显示抬升后的值，
    // 否则会出现「紧急度 2 星」和「从 2 星抬到 3 星」并排打架
    const finalSeverity = (merge && merge.merged && merge.severityAfter > v.severity)
      ? merge.severityAfter
      : v.severity;
    const pri = Domain.priorityOf(finalSeverity);

    // 说清楚这 65 分是怎么来的：星级、类型、独立发现与否
    const bd = window.Payout
      ? Payout.breakdown({
          severity: finalSeverity,
          type: state.type,
          kind: merge.merged ? (merge.kind === 'crowd' ? 'crowd' : 'self') : 'solo'
        })
      : null;
    const pts = typeof estPoints === 'number' ? estPoints : (bd ? bd.points : 0);
    const bdText = bd
      ? bd.severity + ' 星 ' + bd.base + ' 分' +
        (bd.typeW !== 1 ? ' · ' + typeLabel + ' ×' + bd.typeW : '') +
        (bd.kindW !== 1 ? ' · ' + bd.kindText + ' ×' + bd.kindW : '')
      : '';

    const html =
      '<div class="result-wrap">' +
        '<div class="tick">' +
          '<div class="tick-fill">' +
            '<svg viewBox="0 0 32 32"><path d="M8 16.6l5.4 5.4L24 11.2"/></svg>' +
          '</div>' +
        '</div>' +
        '<div class="result-title">已经收到</div>' +
        '<div class="result-sub">谢谢你替这条街多看一眼</div>' +

        // 转复核这件事必须说清楚，否则用户看到"待发放"一直不到，会以为被吞了。
        // 三种原因分开讲：没跑视觉模型 / 画质存疑 / 模型调用失败。
        (v.review
          ? '<div class="merge-note" style="background:var(--review-bg);border-color:rgba(107,124,138,.2);margin-bottom:14px">' +
              '<div style="flex:1"><div style="font-size:12.5px;font-weight:600">' +
                (v.reviewWhy === 'no-vision'
                  ? '这张照片没有被 AI 识别内容，会先过一次人工复核'
                  : '这张单会先过一遍人工复核') + '</div>' +
              '<div class="hint" style="margin-top:2px">' +
                (v.reviewWhy === 'no-vision'
                  ? '这张图的尺寸或格式没能送进视觉模型，画面内容没有被识别。' +
                    '工单照常提交，管理员看一眼就能确认，不扣信用分。'
                  : '管理员确认现场后照常派单，不扣信用分，处理完积分照发。') +
              '</div></div>' +
            '</div>'
          : '') +

        '<div class="code-card">' +
          '<div class="cc-k">' + UI.icon('ticket', 12) + '查询编码</div>' +
          '<div class="cc-row">' +
            '<span class="cc-code">' + UI.escapeHtml(code) + '</span>' +
            '<button class="cc-copy" data-copy="' + UI.escapeHtml(code) + '">复制</button>' +
          '</div>' +
          '<div class="cc-note">' +
            (isGuest
              ? '游客也能凭这串编码查进度，建议截图或记下来——清掉浏览器记录就找不回来了'
              : '凭这串编码随时查进度，登录状态下也能在「我的上报」里直接看到') +
          '</div>' +
        '</div>' +

        '<div class="info-card">' +
          '<div class="info-row"><span class="k">问题类型</span><span class="v">' + typeLabel + '</span></div>' +
          '<div class="info-row"><span class="k">位置</span>' +
            '<span class="v ellipsis" style="max-width:190px">' + UI.escapeHtml(state.addr || '已记录坐标') + '</span></div>' +
          '<div class="info-row"><span class="k">负责部门</span><span class="v">' + dept.name + '</span></div>' +
          '<div class="info-row"><span class="k">紧急度</span><span class="v">' + starsHTML(finalSeverity) + '</span></div>' +
          '<div class="info-row"><span class="k">优先级</span><span class="v">' +
            '<span class="tag" style="background:' + pri.color + '18;color:' + pri.color + '">' +
              pri.id + ' · ' + pri.label + '</span></span></div>' +
          '<div class="ai-block">' +
            '<span class="tag tag--ai">' + UI.icon('spark', 11) +
              (v.summary || v.advice ? 'AI 建议 · 仅供参考' : 'AI 已看过 · 未给摘要') + '</span>' +
            '<div class="txt">' + UI.escapeHtml(v.summary ||
              (state.photos.length
                ? '模型看过这张图了，但没有写摘要。下面这些字段仍是按画面判的。'
                : '这条没有照片，模型只读了文字，没有写摘要。')) + '</div>' +
            (v.advice ? '<div class="advice">处置建议：' + UI.escapeHtml(v.advice) + '</div>' : '') +
          '</div>' +
        '</div>' +

        (merge && merge.merged ?
          '<div class="merge-note">' +
            '<div class="badge-num">' + (merge.kind === 'crowd' ? '+' + (merge.reporters - 1) : '1') + '</div>' +
            '<div style="flex:1">' +
              '<div style="font-size:13px;font-weight:600">' +
                (merge.kind === 'crowd' ? '顺手帮到了别人' : '并进了原来那张工单') + '</div>' +
              '<div class="hint" style="margin-top:2px">' +
                (merge.kind === 'crowd'
                  ? (merge.distance <= 5
                      ? '这个位置已经有人报过，你的记录并入了同一张工单'
                      : '这里 ' + merge.distance + ' 米内已有人报过同一处，你的记录并入了同一张工单') +
                    (merge.severityAfter > merge.severityBefore
                      ? '，紧急度从 ' + merge.severityBefore + ' 星抬到了 ' + merge.severityAfter + ' 星'
                      : '，紧急度已经在最高档')
                  : '同一个位置你之前报过，这次合并进去，不重复开单，也不影响紧急度') +
              '</div>' +
            '</div>' +
          '</div>' : '') +

        (newBadges.length ?
          '<div class="new-badge">' +
            '<div class="bi">' + UI.icon(newBadges[0].icon, 21) + '</div>' +
            '<div style="flex:1">' +
              '<div style="font-size:12.5px;font-weight:600">获得新徽章 · ' + newBadges[0].name + '</div>' +
              '<div class="hint" style="margin-top:2px">' + newBadges[0].desc + '</div>' +
            '</div>' +
          '</div>' : '') +

        /* 结算反馈：学分当场结算，积分挂着等办结 —— 这个区别要写在脸上 */
        (reward ?
          '<div class="reward-note">' +
            '<div class="rn-top">' +
              '<span class="rw-chip is-pt is-pending">待发放 +' + pts + ' 积分</span>' +
              '<span class="rw-chip">信用 +' + reward.creditGain + '</span>' +
              '<span class="rw-hint">当前 ' + state.user.credit + ' 分 · ' + state.user.points + ' 积分</span>' +
            '</div>' +
            '<div class="rn-sub">' +
              '积分要等<b>后勤到场核实并处理完成</b>之后才自动到账，不是 AI 认了就算。' +
              (bdText ? '<br>本单：' + bdText + '，合计 <b>' + pts + '</b> 分。' : '') +
            '</div>' +
          '</div>' : '') +
      '</div>' +

      '<div class="result-actions">' +
        '<button class="btn btn--primary btn--block" data-go="reports">看看我的上报</button>' +
        '<button class="btn btn--ghost btn--block" id="btnViewCode" data-code="' + UI.escapeHtml(code) + '">查看这张工单的进度</button>' +
        '<button class="btn btn--text btn--block" data-go="map">回到地图</button>' +
      '</div>';

    renderResult(html);
  }

  /**
   * AI 没连上 / 调用失败。
   *
   * 这里刻意不提供"仍然提交"：这张单从来没有被分析过，放进去只会在后台
   * 变成一条没有诊断、还占着队列的记录。让用户重试，或者先不报。
   */
  function showAiDown(v) {
    const html =
      '<div class="result-wrap">' +
        '<div class="blur-dots"><i></i><i></i><i></i></div>' +
        '<div class="result-title">AI 没连上，这条还没有提交</div>' +
        '<div class="result-sub">不是你的问题，网络或本地 AI 服务断了</div>' +
        '<div class="info-card">' +
          '<div class="info-row"><span class="k">当前状态</span>' +
            '<span class="v"><span class="tag tag--warn">未分析 · 未提交</span></span></div>' +
          '<div style="padding:12px 0 14px">' +
            '<div class="hint" style="line-height:1.7">' +
              '这张照片还在，描述也没丢。连上 AI 之后点重试就行。' +
              '系统不会用模板编一段分析糊弄你 —— 没看过图，就说没看过。' +
            '</div>' +
            (v.detail ? '<div class="hint" style="margin-top:8px;opacity:.7">' +
              UI.escapeHtml(v.detail) + '</div>' : '') +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="result-actions">' +
        '<button class="btn btn--primary btn--block" id="btnAiRetry">重试</button>' +
        '<button class="btn btn--ghost btn--block" data-go="report">回去改一下</button>' +
      '</div>';

    renderResult(html);

    const retry = $('#btnAiRetry');
    if (retry) {
      retry.addEventListener('click', function () {
        retry.disabled = true;
        retry.textContent = '正在重试…';
        go('report');
        submit();
      });
    }
  }

  function showReject(v) {
    // renderResult 是独立函数，拿不到这里的 v；转人工时要读紧急度，
    // 先存一份，避免点"仍然提交"时报 undefined。
    state.lastReject = v;
    const typeLabel = D.TYPE_LABEL[state.type];
    const reasonText = {
      blank: '画面里没有可辨识的内容',
      blackout: '照片几乎全黑',
      blur: '画面不够清晰',
      dark: '照片太暗',
      overexposed: '照片过曝',
      flat: '疑似截图或纯色图',
      unreadable: '图片读不出来',
      'non-facility': '没识别到公共设施',
      'no-info': '没有照片，描述也太短',
      mismatch: '描述与类型不一致'
    }[v.reason] || '信息不足';

    // 空白图是"没拍到"，和被挡下来的糊图不是一回事，提示得说人话
    const hintText = v.reason === 'blank' || v.reason === 'blackout'
      ? '这张照片里看不出任何东西，通常是手指挡住了镜头、对着桌面或墙面拍的。' +
        '把镜头对准要报的设施再拍一张就行。'
      : v.reason === 'no-info'
        ? '这一类可以不拍照，但至少写一句是什么问题，比如「3 号楼 502 校园网一直断」。'
        : v.stage === 'local'
          ? '本地画质检查没过，这张没有送去 AI。重拍一张更清楚的就行 —— ' +
            '不用改描述，也不用重新定位。'
          : '这次不算你的错，只是 AI 想让工单更准确一点。' +
            '重新拍一张通常就能过；如果你确信信息没问题，也可以直接转人工复核。';

    const html =
      '<div class="result-wrap">' +
        '<div class="blur-dots"><i></i><i></i><i></i></div>' +
        '<div class="result-title">' + UI.escapeHtml(v.message) + '</div>' +
        '<div class="result-sub">' + UI.escapeHtml(v.detail || '') + '</div>' +

        '<div class="info-card">' +
          '<div class="info-row"><span class="k">判定原因</span>' +
            '<span class="v"><span class="tag tag--warn">' + reasonText + '</span></span></div>' +
          '<div class="info-row"><span class="k">已选类型</span><span class="v">' + typeLabel + '</span></div>' +
          '<div style="padding:12px 0 14px">' +
            '<div class="hint" style="line-height:1.7">' + hintText + '</div>' +
          '</div>' +
        '</div>' +

        (state.invalidStreak >= 3 ?
          '<div class="merge-note" style="background:var(--review-bg);border-color:rgba(107,124,138,.18)">' +
            '<div style="flex:1"><div style="font-size:12.5px;font-weight:600">已连续 3 次未通过</div>' +
            '<div class="hint" style="margin-top:2px">系统已自动把你的提交转入人工复核池，会有管理员来看</div></div>' +
          '</div>' : '') +
      '</div>' +

      '<div class="result-actions">' +
        '<button class="btn btn--primary btn--block" id="btnRetry">重新拍一张</button>' +
        (v.stage === 'local'
          ? '<button class="btn btn--text btn--block" data-go="report">回去改一下描述</button>' +
            '<div class="dock-hint">本地检查只管清晰度和亮度，没过就不送 AI —— 免得它在一张糊图里猜</div>'
          : '<button class="btn btn--text btn--block" id="btnForce">仍然提交，转人工复核</button>' +
            '<div class="dock-hint">AI 建议 · 仅供参考，人工复核全程保留</div>') +
      '</div>';

    renderResult(html);
  }

  function renderResult(html) {
    const body = $('#resultBody');
    body.innerHTML = html;
    go('result');

    // 复制编码：手机上 clipboard 可能被拦，拦了就退化成选中文本
    const copyBtn = $('[data-copy]');
    if (copyBtn) {
      copyBtn.addEventListener('click', function () {
        const text = copyBtn.dataset.copy;
        const done = function () {
          copyBtn.textContent = '已复制';
          setTimeout(function () { copyBtn.textContent = '复制'; }, 1600);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done, function () { UI.toast('复制失败，长按编码手动复制'); });
        } else {
          UI.toast('编码：' + text + '（长按可复制）', 'ok');
        }
      });
    }

    const viewCode = $('#btnViewCode');
    if (viewCode) {
      viewCode.addEventListener('click', function () {
        const input = $('#queryInput');
        if (input) input.value = viewCode.dataset.code;
        renderQuery(viewCode.dataset.code);
        go('query');
      });
    }

    const retry = $('#btnRetry');
    if (retry) {
      retry.addEventListener('click', function () {
        state.photos = [];
        resetForm(true);
        go('report');
      });
    }

    const force = $('#btnForce');
    if (force) {
      force.addEventListener('click', async function () {
        force.disabled = true;
        force.textContent = '已提交，等待复核';

        // 转人工也要给编码——否则游客这条就彻底查不到了
        const rv = state.lastReject || {};
        const ss = A.get();
        const sev = rv.severity || 2;
        const estPts = window.Payout
          ? Payout.estimate({ severity: sev, type: state.type, kind: 'review' })
          : 0;
        const ph0 = state.photos[0];
        const tk = A.registerTicket({
          type: state.type,
          addr: state.addr || '已记录坐标',
          lng: state.lng, lat: state.lat,
          dept: Domain.deptFor(state.type).name,
          severity: sev,
          merged: false, reporters: 1,
          kind: 'review',
          estPoints: estPts,
          ownerId: ss ? ss.id : A.deviceId(),
          ownerKind: ss ? ss.kind : 'guest',
          // 复核的人要看到原图和用户写的原话，否则点了"转人工"也等于没给人看
          photo: ph0 ? (ph0.src || null) : null,
          desc: state.desc || '',
          analysis: {
            pass: false,
            source: rv.source || 'rules',
            reason: rv.reason || null,
            message: rv.message || '',
            detail: rv.detail || '',
            seen: rv.seen || '',
            sawImage: !!rv.sawImage,
            metrics: rv.metrics || null,
            review: true,
            manual: true,
            noPhoto: !state.photos.length
          }
        });
        A.advanceTicket(tk.code, 'review', 'AI 未通过，用户选择转人工复核');

        if (window.Guard) {
          // 转人工也要落指纹，否则"AI 拦下 → 转人工"就成了绕开同图判重的口子
          let fh = null;
          if (Guard.hashImage && ph0 && ph0.real && ph0.src) fh = await Guard.hashImage(ph0.src);
          Guard.record({
            type: state.type, lng: state.lng, lat: state.lat,
            code: tk.code, photoHash: fh
          });
        }

        state.reports.unshift({
          id: 'q' + Date.now(),
          code: tk.code,
          type: state.type,
          status: 'review',
          addr: state.addr || '已记录坐标',
          ago: 0,
          merged: 0,
          estPoints: estPts,
          photo: state.photos[0] ? state.photos[0].kind : 'scenery'
        });

        setTimeout(function () {
          UI.toast('已转人工复核 · 编码 ' + tk.code, 'ok');
          state.formStale = true;
          go('reports');
        }, 500);
      });
    }
  }

  /* ============================================================
     7. 我的上报 / 个人中心 / 徽章墙
     ============================================================ */

  const TAB_DEFS = [
    { key: 'all',        label: '全部' },
    { key: 'pending',    label: '待处理' },
    { key: 'processing', label: '处理中' },
    { key: 'resolved',   label: '已解决' },
    { key: 'rejected',   label: '被驳回' }
  ];

  function renderReportTabs() {
    const box = $('#reportTabs');
    const mine = allMyReports();
    box.innerHTML = TAB_DEFS.map(function (t) {
      const n = t.key === 'all'
        ? mine.length
        : mine.filter(function (r) { return r.status === t.key; }).length;
      return '<button class="tab' + (state.reportTab === t.key ? ' on' : '') + '" data-tab="' + t.key + '">' +
               t.label + '<span class="c">' + n + '</span>' +
             '</button>';
    }).join('');

    $$('[data-tab]', box).forEach(function (b) {
      b.addEventListener('click', function () {
        state.reportTab = b.dataset.tab;
        renderReportTabs();
        renderReportList();
      });
    });
  }

  /**
   * 「我的上报」由两部分拼起来：
   *   state.reports   这一次会话里刚报的（在内存里，刷新就没）
   *   Auth.myTickets  真落盘的工单（刷新、关页面、换天回来都还在）
   *
   * 只读前者会有个很难看的现象：报完刷新一下列表就空了，
   * 更看不到「积分已到账」——而那恰恰是最想让人看见的一屏。
   * 两边按编码去重，内存里那份优先（它带着图片样子和合并信息）。
   */
  function allMyReports() {
    const rows = state.reports.slice();
    const seen = {};
    rows.forEach(function (r) { if (r.code) seen[r.code] = 1; });

    (A.myTickets ? A.myTickets() : []).forEach(function (t) {
      if (!t || seen[t.code]) return;
      rows.push({
        id: 'tk-' + t.code,
        code: t.code,
        type: t.type,
        status: t.status || 'pending',
        addr: t.addr,
        ago: Math.max(0, (Date.now() - t.at) / 3600000),
        merged: Math.max(0, (t.reporters || 1) - 1),
        estPoints: t.estPoints,
        photo: 'scenery',
        photoSrc: t.photo && t.photo.indexOf('data:') === 0 ? t.photo : null
      });
    });

    // 新的在前
    return rows.sort(function (a, b) { return (a.ago || 0) - (b.ago || 0); });
  }

  function renderReportList() {
    const mine = allMyReports();
    const list = mine.filter(function (r) {
      return state.reportTab === 'all' || r.status === state.reportTab;
    });

    $('#reportsSub').textContent = '共 ' + mine.length + ' 条记录';
    const box = $('#reportList');

    if (!list.length) {
      box.innerHTML =
        '<div class="empty">' +
          '<div class="ico">' + UI.icon('inbox', 26) + '</div>' +
          '<div class="t">' + (state.reportTab === 'all' ? '还没有上报记录' : '这个分类下还没有记录') + '</div>' +
          '<button class="btn btn--ghost" data-go="report">去上报一个</button>' +
        '</div>';
      return;
    }

    box.innerHTML = list.map(function (r, i) {
      const st = D.STATUS[r.status] || D.STATUS.pending;
      const when = agoText(r.ago);

      // 积分状态以工单里的实际结算记录为准，而不是本地记的那个预估值：
      // 后台办结后会在工单上写 reward，这里照它显示「已到账」。
      const tk = r.code ? A.findTicket(r.code) : null;
      const paid = !!(tk && tk.reward && tk.reward.paid);
      const pts = paid ? tk.reward.points : (r.estPoints || (tk && tk.estPoints) || 0);
      const payChip = pts
        ? '<span class="pay-chip' + (paid ? ' is-paid' : '') + '">' +
            (paid ? '积分 +' + pts + ' 已到账' : '待发放 +' + pts) +
          '</span>'
        : '';

      return '<div class="report-item reveal" style="--d:' + (i + 1) + '"' +
               (r.code ? ' data-code="' + UI.escapeHtml(r.code) + '"' : '') + '>' +
               '<div class="report-thumb">' +
                 (r.photoSrc
                   ? '<img src="' + r.photoSrc + '" alt="现场照片">'
                   : D.photoSVG(r.photo)) +
               '</div>' +
               '<div class="report-main">' +
                 '<div class="report-top">' +
                   '<span class="report-type">' + D.TYPE_LABEL[r.type] + '</span>' +
                   '<span class="report-status" style="color:' + st.color + '">' + st.label + '</span>' +
                 '</div>' +
                 '<div class="report-addr">' + UI.escapeHtml(r.addr) + '</div>' +
                 '<div class="report-meta">' +
                   payChip +
                   '<span>' + when + '</span>' +
                   (r.code ? '<span>· <b class="mono">' + UI.escapeHtml(r.code) + '</b></span>' : '') +
                   (r.merged ? '<span>· 已与 ' + r.merged + ' 人合并</span>' : '') +
                 '</div>' +
               '</div>' +
             '</div>';
    }).join('');
  }

  /* ============================================================
     上报详情：点一条，看全过程
     ------------------------------------------------------------
     列表只回答"报了没、解决没"，回答不了"卡在哪一步、谁在办"。
     用户第二次点进来，想知道的就是后者。
     ============================================================ */

  function openReportDetail(code) {
    if (!code) return;
    const tk = A.findTicket(code) || null;
    const local = allMyReports().filter(function (r) { return r.code === code; })[0] || {};
    const t = tk || {};

    const stKey = t.status || local.status || 'pending';
    const st = D.STATUS[stKey] || D.STATUS.pending;
    // 状态色只有前景色，浅底在这里补一份，不然行内只有一行裸字
    const stBg = { pending: 'var(--danger-bg)', processing: 'var(--warn-bg)',
                   review: 'var(--review-bg)', resolved: 'var(--ok-bg)',
                   rejected: 'var(--line-2)' }[stKey] || 'var(--line-2)';
    const typeKey = t.type || local.type;
    const typeLabel = D.TYPE_LABEL[typeKey] || '—';
    const dept = t.dept || (window.Domain && Domain.deptFor(typeKey).name) || '待分派';
    const sev = t.severity || local.severity || 1;
    const paid = !!(t.reward && t.reward.paid);
    const pts = paid ? t.reward.points : (t.estPoints || local.estPoints || 0);

    // 实拍图存的是 dataURL；老数据只有 kind，回落到示意图
    const photo = (t.photo && /^data:image\//.test(t.photo))
      ? '<img src="' + t.photo + '" alt="现场照片">'
      : (local.photoSrc ? '<img src="' + local.photoSrc + '" alt="现场照片">' : D.photoSVG(local.photo || 'scenery'));

    // 进度按时间正序读：提交 → 派单 → 到场 → 处置 → 办结。
    // 每个节点带角色徽章、操作方和备注，用户能看清"卡在谁手上"。
    const timeline = (t.timeline || []).slice().sort(function (a, b) { return a.at - b.at; });
    const ROLE_LABEL = { user: '上报人', ai: 'AI 判定', crew: '处置班组', admin: '管理端', system: '系统' };

    function gapText(ms) {
      const m = Math.round(ms / 60000);
      if (m < 1) return '不到 1 分钟';
      if (m < 60) return m + ' 分钟';
      const h = Math.floor(m / 60);
      if (h < 24) return h + ' 小时' + (m % 60 ? ' ' + (m % 60) + ' 分钟' : '');
      return Math.floor(h / 24) + ' 天' + (h % 24 ? ' ' + (h % 24) + ' 小时' : '');
    }

    const tlHTML = timeline.length
      ? '<div class="tl">' + timeline.map(function (e, i) {
          const prev = i > 0 ? timeline[i - 1].at : null;
          const gap = prev ? (e.at - prev) : 0;
          const role = e.role || (i === 0 ? 'user' : 'crew');
          const last = i === timeline.length - 1;
          return '<div class="tl-row' + (i === 0 ? ' is-first' : '') + (last ? ' is-now' : '') +
                   (e.tone === 'ok' ? ' is-ok' : '') + '">' +
                   '<div class="tl-head">' +
                     '<span class="tl-t">' + UI.escapeHtml(e.label) + '</span>' +
                     '<span class="tl-role" data-role="' + role + '">' +
                       (ROLE_LABEL[role] || '处理') + '</span>' +
                   '</div>' +
                   (e.by ? '<div class="tl-by">' + UI.escapeHtml(e.by) + '</div>' : '') +
                   (e.note ? '<div class="tl-note">' + UI.escapeHtml(e.note) + '</div>' : '') +
                   '<div class="tl-time">' + fmtTime(e.at) +
                     (gap > 60000 ? '　距上一步 ' + gapText(gap) : '') + '</div>' +
                 '</div>';
        }).join('') + '</div>'
      : '<div class="dsl-empty">还没有流转记录</div>';

    const aiLine = (t.analysis && (t.analysis.seen || t.analysis.summary))
      ? '<div class="dsl-note">' +
          (t.analysis.seen ? '<b>AI 看到的：</b>' + UI.escapeHtml(t.analysis.seen) : '') +
          (t.analysis.advice ? '<br><b>处置建议：</b>' + UI.escapeHtml(t.analysis.advice) : '') +
        '</div>'
      : '';

    UI.sheet({
      title: '上报详情',
      sub: typeLabel + ' · ' + (t.addr || local.addr || '已记录坐标'),
      body:
        '<div class="dr-shot-mini">' + photo + '</div>' +
        '<div class="dsl-status" style="color:' + st.color + ';background:' + stBg + '">' +
          st.label +
          (pts ? '<span class="dsl-pt">' + (paid ? '积分 +' + pts + ' 已到账' : '待发放 +' + pts) + '</span>' : '') +
        '</div>' +
        '<dl class="qr-meta">' +
          '<dt>编码</dt><dd><b class="mono">' + UI.escapeHtml(code) + '</b></dd>' +
          '<dt>位置</dt><dd>' + UI.escapeHtml(t.addr || local.addr || '已记录坐标') + '</dd>' +
          '<dt>负责部门</dt><dd>' + UI.escapeHtml(dept) + '</dd>' +
          '<dt>紧急度</dt><dd>' + starsHTML(sev) + '</dd>' +
          '<dt>反馈人数</dt><dd>' + (t.reporters || 1) + ' 人' + (t.merged ? ' · 已合并' : '') + '</dd>' +
          '<dt>提交时间</dt><dd>' + fmtTime(t.at || local.at) + '</dd>' +
        '</dl>' +
        aiLine +
        '<div class="dsl-h">解决流程<span class="dsl-h-sub">' +
          (paid ? '已办结' : '已用时 ' + gapText(Date.now() - (t.at || local.at || Date.now()))) +
        '</span></div>' +
        tlHTML +
        (paid ? '' : '<div class="dsl-note">积分要等后勤到场核实并处理完才发放，' +
                     '进度有变化会在这里更新。</div>'),
      onMount: function (api) {
        // 注意：api.el 是遮罩层，本身是 flex 行布局。
        // 按钮要挂进 .sheet-bd，挂到遮罩上会把弹层挤窄。
        var btn = document.createElement('button');
        btn.className = 'btn btn--ghost btn--block';
        btn.style.marginTop = '12px';
        btn.textContent = '关闭';
        btn.addEventListener('click', function () { api.close(); });
        (api.el.querySelector('.sheet-bd') || api.el).appendChild(btn);

        // 缩略图点开看全图：竖拍的照片在详情页里只能显示一段，
        // 想确认"到底拍到什么"就得能放大
        var mini = api.el.querySelector('.dr-shot-mini');
        if (mini) {
          mini.addEventListener('click', function () {
            var im = mini.querySelector('img');
            if (im && im.src) UI.imageView(im.src, '现场照片');
          });
        }
      }
    });
  }

  /* ============================================================
     积分 / 信用分流水
     ------------------------------------------------------------
     余额是个结论，流水才是证据。用户质疑"怎么少了 20 分"时，
     能直接指给他看是哪一条。
     ============================================================ */

  function openLedger(kind) {
    const L = window.Ledger;
    if (!L) { UI.toast('流水模块没加载', 'warn'); return; }

    const isPt = kind === 'points';
    const items = L.list(kind);
    const bal = isPt ? (A.get() && A.get().points || 0) : (A.get() && A.get().credit || 0);

    const rows = items.length
      ? items.map(function (e) {
          const up = e.d > 0;
          return '<div class="lg-row">' +
                   '<div class="lg-main">' +
                     '<div class="lg-why">' + UI.escapeHtml(e.why || (isPt ? '积分变动' : '信用分变动')) + '</div>' +
                     '<div class="lg-time">' + fmtTime(e.at) + '</div>' +
                   '</div>' +
                   '<div class="lg-d ' + (up ? 'is-up' : 'is-down') + '">' +
                     (up ? '+' : '') + e.d +
                     '<small>' + (e.after != null ? '余 ' + e.after : '') + '</small>' +
                   '</div>' +
                 '</div>';
        }).join('')
      : '<div class="dsl-empty">还没有记录</div>';

    UI.sheet({
      title: isPt ? '积分流水' : '信用分流水',
      sub: (isPt ? '只记已到账的' : '定期复盘用') + ' · 当前 ' + bal + (isPt ? ' 分' : ' / 100'),
      body: '<div class="lg-list">' + rows + '</div>',
      onMount: function (api) {
        // 注意：api.el 是遮罩层，本身是 flex 行布局。
        // 按钮要挂进 .sheet-bd，挂到遮罩上会把弹层挤窄。
        var btn = document.createElement('button');
        btn.className = 'btn btn--ghost btn--block';
        btn.style.marginTop = '12px';
        btn.textContent = '关闭';
        btn.addEventListener('click', function () { api.close(); });
        (api.el.querySelector('.sheet-bd') || api.el).appendChild(btn);
      }
    });
  }

  function renderProfile() {
    const u = state.user;
    const s = state.session || A.get();
    const guest = !s || s.kind === 'guest';

    $('#pAvatar').textContent = u.initial;
    $('#pName').textContent = u.name;
    $('#pStreak').textContent = u.streak > 0 ? '连续 ' + u.streak + ' 天上报' : '今天还没上报';
    $('#pCredit').innerHTML = u.credit + '<small>/ 100</small>';
    $('#pTier').textContent = tierOf(u.credit);
    $('#creditBar').style.width = u.credit + '%';
    $('#pValid').textContent = u.validCnt;
    $('#pResolved').textContent = u.resolvedCnt;
    $('#pInvalid').textContent = u.invalidCnt;

    /* 身份标签 */
    const chip = $('#pIdChip');
    const idText = $('#pIdText');
    if (guest) {
      idText.textContent = '游客模式 · 点这里登录';
      chip.classList.add('is-guest');
    } else if (s.kind === 'school') {
      idText.textContent = '学号 ' + s.id;
      chip.classList.remove('is-guest');
    } else {
      idText.textContent = A.maskPhone(s.id);
      chip.classList.remove('is-guest');
    }

    /* 积分与权重 */
    $('#pPoints').textContent = u.points || 0;
    // 菜单里那个"积分乐园"后面的余额也一起刷新，否则办结到账后
    // 上面写着 640、菜单还挂着 0，一看就是没接上
    const mp = $('#menuPoints');
    if (mp) mp.textContent = (u.points || 0) + ' 分';
    const w = u.weight || 1;
    $('#pWeight').textContent = w.toFixed(2);
    $('#pWeightHint').textContent = A.weightLabel(w) +
      (w < 0.6 ? ' · 不计入合并人数' : ' · 合并时计入人数');

    $('#pCreditNote').textContent = (guest
      ? '游客的信用分只存在这台设备上，登录后才会长期累积'
      : '有效上报 +2 · 被复核判定无效 −5 · 低于 60 分进人工复核') + ' · 点开看流水';

    $('#logoutLabel').textContent = guest ? '登录 / 切换账号' : '切换账号 / 退出登录';

    /* 分析过程入口的小标签：直接告诉人现在有没有接上模型，
       免得每次都点进去才发现是本地规则 */
    const dbgTag = $('#aiDebugTag');
    if (dbgTag) {
      const st = getAgent().status();
      dbgTag.textContent = st.mode === 'deepseek' ? 'DeepSeek' : 'AI 离线';
      dbgTag.className = 'tag' + (st.mode === 'deepseek' ? ' tag--ok' : ' tag--warn');
    }

    const owned = D.BADGES.filter(function (b) { return u.badges.indexOf(b.code) >= 0; });
    $('#profileBadges').innerHTML = owned.length
      ? owned.map(function (b) {
          return '<div class="badge-cell">' +
                   '<div class="ic">' + UI.icon(b.icon, 21) + '</div>' +
                   '<div class="bn">' + b.name + '</div>' +
                 '</div>';
        }).join('')
      : '<div class="hint" style="padding:8px 0">还没有徽章。第一次有效上报就能拿到「初次出勤」。</div>';
  }

  function renderBadges() {
    const u = state.user;
    $('#badgeGot').innerHTML = u.badges.length + '<sub> / ' + D.BADGES.length + '</sub>';

    $('#badgeGrid').innerHTML = D.BADGES.map(function (b, i) {
      const owned = u.badges.indexOf(b.code) >= 0;
      return '<div class="badge-tile reveal' + (owned ? '' : ' locked') + '" style="--d:' + (i + 1) + '">' +
               '<div class="ic">' + UI.icon(b.icon, 22) + '</div>' +
               '<div class="bn">' + b.name + '</div>' +
               '<div class="bd">' + b.desc + '</div>' +
               '<div class="bt">' + (owned ? '已获得' : b.tip) + '</div>' +
             '</div>';
    }).join('');
  }

  /* ============================================================
     8. 演示场景
     ============================================================ */

  function renderScenes() {
    $('#sceneList').innerHTML = D.SCENES.map(function (s) {
      return '<button class="scene ' + s.tone + '" data-scene="' + s.key + '">' +
               '<span class="k">' + s.n + '</span>' +
               '<span class="t">' + s.label + '<small>' + s.sub + '</small></span>' +
             '</button>';
    }).join('');

    $$('[data-scene]').forEach(function (b) {
      b.addEventListener('click', function () {
        const s = D.SCENES.filter(function (x) { return x.key === b.dataset.scene; })[0];
        if (s) runScene(s);
      });
    });
  }

  async function runScene(s) {
    // 演示面板在设备外面，点它就当"我要看流程"，顺手以游客身份过闸
    if (!A.get()) { A.loginGuest(); applySession(); }
    hideGate();
    go('report');
    resetForm(true);

    // 预置材料。演示图也栅格化成 PNG 一起送模型 ——
    // 现场演示走的就是"本地准入 → 视觉模型"这条路，不是预置文案。
    const demoPng = await svgToPng(D.photoSVG(s.photo), 720);
    state.photos = [{
      kind: s.photo,
      src: demoPng || D.photoDataURI(s.photo),
      real: !!demoPng,
      demo: true
    }];
    state.type = s.type;
    state.desc = s.desc;
    state.addr = s.addr;
    state.lng = s.lng;
    state.lat = s.lat;
    state.located = true;

    $('#descInput').value = s.desc;
    $('#descCount').textContent = s.desc.length;
    $('#addrInput').value = s.addr;
    $('#locState').textContent = '已定位';

    renderPhotos();
    renderTypes();
    refreshSubmit();

    UI.toast('材料已就位，正在提交…');
    await sleep(900);
    if (state.screen === 'report') submit();
  }

  function resetDemo() {
    state.reports = JSON.parse(JSON.stringify(D.MY_REPORTS));
    state.user = JSON.parse(JSON.stringify(D.USER));
    state.invalidStreak = 0;
    state.photos = [];
    state.type = '';
    state.desc = '';
    state.lng = null;
    state.lat = null;
    state.located = false;
    state.reportTab = 'all';

    renderReportTabs();
    renderReportList();
    renderProfile();
    renderBadges();
    resetForm(false);
    go('map');

    UI.toast('演示数据已重置，回到初始状态', 'ok');
  }

  /* ============================================================
     启动
     ============================================================ */

  /* ============================================================
     9. 身份 / 积分 / 编码查询
     ============================================================ */

  /** 工单状态在查询页的展示口径 */
  const TICKET_STATUS = {
    pending:    { label: '待派单', color: '#C97E15', bg: 'var(--warn-bg)' },
    processing: { label: '处理中', color: '#2B7A78', bg: 'var(--brand-light)' },
    resolved:   { label: '已解决', color: '#3E8A5F', bg: 'var(--ok-bg)' },
    review:     { label: '人工复核', color: '#6B7C8A', bg: 'var(--review-bg)' }
  };

  function fmtTime(at) {
    const d = new Date(at);
    const p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /**
   * 把当前身份同步到界面状态。
   * 登录账号带演示底数（86 分、12 条历史），游客从零开始——
   * 这个差异本身就是讲解点：不登录也能用，但没有信用积累。
   */
  function applySession() {
    const s = A.get();
    state.session = s;

    if (!s) return;

    if (s.kind === 'guest') {
      state.user = {
        name: '游客', initial: '游',
        credit: s.credit, points: s.points || 0, weight: s.weight || 1,
        validCnt: s.validCnt || 0,
        resolvedCnt: s.resolvedCnt || 0,
        invalidCnt: s.invalidCnt || 0,
        streak: 0,
        badges: s.badges || []
      };
      return;
    }

    state.user = {
      name: s.name,
      initial: (s.name || '同').slice(0, 1),
      credit: s.credit,
      points: s.points || 0,
      weight: s.weight || 1,
      validCnt: s.validCnt || 0,
      resolvedCnt: s.resolvedCnt || 0,
      invalidCnt: s.invalidCnt || 0,
      streak: s.streak || 0,
      badges: s.badges || []
    };
  }

  /** 新账号第一次登录时灌一份演示底数，免得个人中心是空的 */
  function seedIfNew(s) {
    if (!s || s.seeded || s.kind === 'guest') return;
    A.patch({
      seeded: true,
      credit: 86,
      points: 260,
      weight: 1,
      validCnt: D.USER.validCnt,
      resolvedCnt: D.USER.resolvedCnt,
      invalidCnt: D.USER.invalidCnt,
      streak: D.USER.streak || 3,
      badges: (D.USER.badges || []).slice()
    });
  }

  function showGate(canClose) {
    const g = $('#authGate');
    if (!g) return;
    g.hidden = false;
    $('#btnAuthClose').hidden = !canClose;
    g.style.animation = 'none';
    void g.offsetWidth;
    g.style.animation = '';
  }

  function hideGate() {
    const g = $('#authGate');
    if (g) g.hidden = true;
  }

  function bindAuth() {
    // 两个 Tab 之间切换
    $$('[data-auth-tab]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const key = btn.dataset.authTab;
        $$('[data-auth-tab]').forEach(function (b) { b.classList.toggle('on', b === btn); });
        $$('[data-auth-pane]').forEach(function (p) {
          p.classList.toggle('is-on', p.dataset.authPane === key);
        });
      });
    });

    /* ---- 学号一键登录 ---- */
    const schoolInput = $('#authSchoolId');
    const schoolHint = $('#authSchoolHint');

    schoolInput.addEventListener('input', function () {
      const v = schoolInput.value.replace(/\D/g, '');
      schoolInput.value = v;
      if (!v) { schoolHint.textContent = '校内统一身份 · 无需密码'; schoolHint.className = 'auth-hint'; return; }
      const c = A.checkSchoolId(v);
      if (c.ok) {
        schoolHint.textContent = '已识别：' + v.slice(0, 4) + ' 级 · ' + v.slice(-4) + ' 号';
        schoolHint.className = 'auth-hint is-ok';
      } else {
        schoolHint.textContent = '还需要 ' + Math.max(0, 8 - v.length) + ' 位数字';
        schoolHint.className = 'auth-hint';
      }
    });

    schoolInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') $('#btnSchoolLogin').click();
    });

    $('#btnSchoolLogin').addEventListener('click', function () {
      const btn = this;
      const r = A.login({ kind: 'school', id: schoolInput.value });
      if (!r.ok) {
        schoolHint.textContent = r.msg;
        schoolHint.className = 'auth-hint is-warn';
        schoolInput.focus();
        return;
      }
      btn.textContent = '正在进入…';
      btn.setAttribute('aria-disabled', 'true');
      seedIfNew(r.user);
      setTimeout(function () {
        enterAfterLogin(r.user, '学号 ' + r.user.id.slice(-4) + ' 号');
        btn.textContent = '一键登录';
        btn.removeAttribute('aria-disabled');
      }, 520);
    });

    /* ---- 手机号 + 验证码 ---- */
    const phoneInput = $('#authPhone');
    const codeInput = $('#authCode');
    const phoneHint = $('#authPhoneHint');
    const sendBtn = $('#btnSendCode');
    let sentCode = '';
    let cooldown = 0;
    let cooldownTimer = null;

    phoneInput.addEventListener('input', function () {
      phoneInput.value = phoneInput.value.replace(/\D/g, '');
    });

    sendBtn.addEventListener('click', function () {
      if (cooldown > 0) return;
      const c = A.checkPhone(phoneInput.value);
      if (!c.ok) {
        phoneHint.textContent = c.msg;
        phoneHint.className = 'auth-hint is-warn';
        phoneInput.focus();
        return;
      }
      // 演示环境不真发短信，直接把验证码摆在提示里
      sentCode = String(Math.floor(100000 + Math.random() * 900000));
      phoneHint.innerHTML = '验证码已发送到 ' + A.maskPhone(c.id) + '，演示码：<b>' + sentCode + '</b>';
      phoneHint.className = 'auth-hint is-ok';
      codeInput.value = '';
      codeInput.focus();

      cooldown = 60;
      sendBtn.disabled = true;
      sendBtn.textContent = cooldown + 's';
      cooldownTimer = setInterval(function () {
        cooldown--;
        if (cooldown <= 0) {
          clearInterval(cooldownTimer);
          sendBtn.disabled = false;
          sendBtn.textContent = '重新获取';
        } else {
          sendBtn.textContent = cooldown + 's';
        }
      }, 1000);
    });

    codeInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') $('#btnPhoneLogin').click();
    });

    $('#btnPhoneLogin').addEventListener('click', function () {
      const btn = this;
      if (!sentCode) {
        phoneHint.textContent = '先点「获取验证码」';
        phoneHint.className = 'auth-hint is-warn';
        return;
      }
      if (codeInput.value !== sentCode) {
        phoneHint.textContent = '验证码不对，再看一眼提示里那 6 位';
        phoneHint.className = 'auth-hint is-warn';
        return;
      }
      const r = A.login({ kind: 'phone', id: phoneInput.value, code: codeInput.value });
      if (!r.ok) {
        phoneHint.textContent = r.msg;
        phoneHint.className = 'auth-hint is-warn';
        return;
      }
      btn.textContent = '正在进入…';
      seedIfNew(r.user);
      setTimeout(function () {
        enterAfterLogin(r.user, A.maskPhone(r.user.id));
        btn.textContent = '登录';
      }, 480);
    });

    /* ---- 游客 ---- */
    $('#btnGuest').addEventListener('click', function () {
      const r = A.loginGuest();
      if (!r.ok) return;
      enterAfterLogin(r.user, '游客模式');
      UI.toast('已进入游客模式 · 提交后会给查询编码', 'ok');
    });

    $('#btnAuthClose').addEventListener('click', hideGate);

    /* ---- 个人中心里的身份标签 / 退出 ---- */
    $('#pIdChip').addEventListener('click', function () {
      const s = A.get();
      if (!s || s.kind === 'guest') showGate(!!s);
      else UI.toast('当前身份：' + (s.kind === 'school' ? '学号 ' + s.id : A.maskPhone(s.id)), 'ok');
    });

    $('#btnLogout').addEventListener('click', function () {
      const s = A.get();
      A.logout();
      applySession();
      renderProfile();
      go('map');
      showGate(false);
      UI.toast(s && s.kind !== 'guest' ? '已退出登录' : '登录后可以累积信用分', 'ok');
    });

    const aiDbg = $('#btnAiDebug');
    if (aiDbg) aiDbg.addEventListener('click', openAiDebug);
  }

  /* ============================================================
     设置 · AI 分析过程
     ------------------------------------------------------------
     这个面板只回答一个问题："这张图，到底有没有被 AI 看过？"
     看过的，把模型说了什么、本地指标是多少摆出来；
     没看过的，明说没看过 —— 而不是在结果页给一个看起来正常的绿勾。

     数据来自 agent.debug()：最近一次判定 + 最近一次预判 + 最近 6 条历史。
     ============================================================ */
  function openAiDebug() {
    const ag = getAgent();
    const dbg = ag.debug ? ag.debug() : { last: null, preview: null, history: [] };
    const last = dbg.last;
    const pv = dbg.preview;

    if (!last && !pv) {
      UI.sheet({
        title: 'AI 分析过程',
        sub: '还没有可看的记录',
        body: '<div class="dbg-empty">这里会显示最近一次判定的完整过程。' +
          '先报一条，或者随便选一张图（预判不需要提交）。</div>' +
          '<div class="dbg-sec"><div class="dbg-t">当前模式</div>' +
          '<div class="dbg-line">' + modeLine(ag.status()) + '</div></div>'
      });
      return;
    }

    const METRIC_ROWS = [
      ['清晰度', 'sharpScore', '> ' + SentinelAgent.THRESH.blur, '越高越清楚'],
      ['平均亮度', 'brightness', '< ' + SentinelAgent.THRESH.dark + ' 算暗', '0–1'],
      ['平坦区', 'flatRatio', '> ' + SentinelAgent.THRESH.flat + ' 且无边缘 = 疑似截图', '0–1'],
      ['边缘密度', 'edgeDensity', '< ' + SentinelAgent.THRESH.noEdge + ' 视为没结构', '0–1']
    ];

    function metricTable(m) {
      if (!m) return '<div class="dbg-line muted">没有跑到画质分析（没图，或者图读不出来）</div>';
      return '<table class="dbg-tb">' + METRIC_ROWS.map(function (r) {
        const v = m[r[1]];
        const shown = typeof v === 'number'
          ? (r[1] === 'sharpScore' ? Math.round(v) : v.toFixed(3))
          : '—';
        return '<tr><td class="k">' + r[0] + '</td><td class="v num">' + shown + '</td>' +
          '<td class="t">' + r[2] + '</td></tr>';
      }).join('') + '</table>';
    }

    function verdictChip(v) {
      const cls = v.pass ? 'is-pass' : 'is-fail';
      const text = v.pass ? (v.review ? '放行 · 转人工复核' : '放行') : '拦下';
      return '<span class="dbg-chip ' + cls + '">' + text + '</span>';
    }

    const v = last ? last.verdict : null;
    const gates = last ? (last.gates || []) : [];
    const gVision = gates.filter(function (g) { return g.id === 'vision'; })[0];
    const gSem = gates.filter(function (g) { return g.id === 'semantic'; })[0];

    const html =
      (last
        ? '<div class="dbg-hero">' +
            verdictChip(v) +
            '<span class="dbg-mode">' + (last.mode === 'deepseek' ? 'DeepSeek 视觉' : 'AI 未连接') + '</span>' +
            '<span class="dbg-lat">' + (last.verdict.latency || 0) + ' ms</span>' +
          '</div>' +

          '<div class="dbg-sec">' +
            '<div class="dbg-t">① 图片有没有进模型</div>' +
            '<div class="dbg-line">' +
              (last.hasPhoto
                ? (last.raster
                    ? (last.demo
                        ? '是演示示意图，已栅格化成位图（' + Math.round(last.imageLen / 1024) + ' KB）'
                        : '是一张真实照片（' + Math.round(last.imageLen / 1024) + ' KB）')
                    : '是演示示意图（SVG），浏览器没能栅格化，只能按文字判断')
                : '这条没有照片') +
            '</div>' +
            '<div class="dbg-line ' + (last.verdict.sawImage ? 'is-ok' : 'is-warn') + '">' +
              (last.verdict.sawImage
                ? '✓ 已送进视觉模型，它看过了'
                : (last.verdict.stage === 'local'
                    ? '✗ 本地画质没过，这张没有送去模型'
                    : '✗ 没有送进模型 —— AI 未连接，所以这次没有分析')) +
            '</div>' +
            (last.verdict.seen
              ? '<div class="dbg-quote">模型说：' + UI.escapeHtml(last.verdict.seen) + '</div>'
              : '') +
          '</div>' +

          '<div class="dbg-sec">' +
            '<div class="dbg-t">② 第一关 · 本地准入（纯算法，不花钱）</div>' +
            metricTable(last.metrics) +
            (gVision
              ? '<div class="dbg-line">结论：' + (gVision.pass ? '通过' : '不合格 · ' + (gVision.reason || '')) +
                (gVision.message ? ' · ' + UI.escapeHtml(gVision.message) : '') + '</div>'
              : '') +
          '</div>' +

          '<div class="dbg-sec">' +
            '<div class="dbg-t">③ 第二关 · 模型判定（必经）</div>' +
            '<div class="dbg-line">判定来源：' +
              (last.verdict.source === 'deepseek'
                ? 'DeepSeek 视觉'
                : (last.verdict.stage === 'local' ? '没有进入这一关（本地已经拦下）' : '没有判定（AI 未连接）')) + '</div>' +
            '<div class="dbg-line">用户选的类型：' + typeName(last.typeIn) +
              (last.verdict.typeAdjusted
                ? '　→　改成：' + typeName(last.verdict.type) + '（点错不驳回，直接改）'
                : '　　类型没动') + '</div>' +
            (gSem && gSem.reason
              ? '<div class="dbg-line is-warn">拦截原因：' + UI.escapeHtml(gSem.reason) + ' · ' +
                UI.escapeHtml(gSem.message || '') + '</div>'
              : '') +
            (v.reviewWhy
              ? '<div class="dbg-line is-warn">为什么转复核：' +
                ({ 'no-vision': '有照片但没有跑视觉模型，等于没人看过这张图',
                   quality: '画质存疑（拍糊/偏暗），先让人看一眼',
                   degraded: '模型调用失败，降级成规则判定' }[v.reviewWhy] || v.reviewWhy) + '</div>'
              : '') +
            '<div class="dbg-line">严重度：' + v.severity + ' 星' +
              (v.detail ? '　·　' + UI.escapeHtml(v.detail) : '') + '</div>' +
          '</div>' +

          '<div class="dbg-sec">' +
            '<div class="dbg-t">④ 原始返回（看清楚它是不是真说了话）</div>' +
            '<pre class="dbg-raw">' + UI.escapeHtml(last.raw || '（没有调用模型，所以没有原始返回）') + '</pre>' +
          '</div>'
        : '<div class="dbg-empty">还没有提交过判定，只有预判记录。</div>') +

      (pv
        ? '<div class="dbg-sec">' +
            '<div class="dbg-t">⑤ 图片一进来时的即时预判</div>' +
            (pv.ok
              ? '<div class="dbg-line">认出来的类型：' + typeName(pv.type) +
                '　置信度 ' + Math.round((pv.confidence || 0) * 100) + '%</div>' +
                '<div class="dbg-line">给用户的描述建议：' + UI.escapeHtml(pv.desc || '（没给）') + '</div>' +
                (pv.raw ? '<pre class="dbg-raw">' + UI.escapeHtml(pv.raw) + '</pre>' : '')
              : '<div class="dbg-line is-warn">没有结果：' +
                ({ sample: '演示示意图不送模型',
                   offline: '本地代理没启动',
                   NOT_RASTER: '不是位图' }[pv.reason] || UI.escapeHtml(pv.reason)) + '</div>') +
          '</div>'
        : '') +

      '<div class="dbg-sec">' +
        '<div class="dbg-t">最近记录</div>' +
        ((dbg.history || []).length
          ? '<div class="dbg-list">' + dbg.history.slice(0, 6).map(function (h) {
              const vv = h.verdict || {};
              return '<div class="dbg-item">' +
                '<span class="dbg-when">' + fmtTime(h.at) + '</span>' +
                '<span class="dbg-what">' +
                  (vv.pass ? (vv.review ? '放行·复核' : '放行')
                           : (vv.stage === 'local' ? '本地拦下' : '未判定')) +
                  ' · ' + (h.mode === 'deepseek' ? 'DeepSeek' : 'AI 离线') +
                  (h.hasPhoto ? (h.raster ? ' · 真图' : ' · 示意图') : ' · 无图') +
                '</span>' +
              '</div>';
            }).join('') + '</div>'
          : '<div class="dbg-line muted">还没有记录</div>') +
      '</div>' +

      '<div class="dbg-foot">这些是判定用的原样数据，不参与业务逻辑。' +
        '本地只做准入（清晰度、亮度、平坦区），过了才会送模型；模型没连上就没有分析，' +
        '系统也不会用模板补一段。</div>';

    UI.sheet({ title: 'AI 分析过程', sub: '看清楚这张图有没有被模型看过', body: html });
  }

  function modeLine(st) {
    if (!st) return '未知';
    if (st.mode === 'deepseek') return 'DeepSeek 视觉 · ' + (st.model || '') + (st.vision ? ' · 支持图片' : ' · 不带视觉');
    return 'AI 未连接（' + (st.lastError || '代理未启动') + '）· 这次不会产生分析';
  }

  function typeName(k) {
    return (D.TYPE_LABEL && D.TYPE_LABEL[k]) || k || '—';
  }

  function enterAfterLogin(user, who) {
    applySession();
    hideGate();
    renderProfile();
    renderBadges();
    go('map');
    UI.toast('欢迎，' + who, 'ok');
  }

  /* ---------------- 编码查询 ---------------- */

  function renderQuery(raw) {
    const box = $('#queryResult');
    const code = String(raw || '').trim();
    if (!code) {
      box.innerHTML = '<div class="qr-empty">输入提交时拿到的编码，就能看到这张工单走到哪一步了</div>';
      return;
    }

    const t = A.findTicket(code);
    if (!t) {
      box.innerHTML =
        '<div class="qr-empty">' +
          '没找到 <b>' + UI.escapeHtml(code.toUpperCase()) + '</b> 这张工单<br>' +
          '编码形如 JW-8F3K2M，注意别把 O 和 0 弄混' +
        '</div>';
      return;
    }

    const st = TICKET_STATUS[t.status] || TICKET_STATUS.pending;
    const typeLabel = (window.DATA.TYPE_LABEL && D.TYPE_LABEL[t.type]) || t.type || '—';

    // 积分状态：到账了就说 +70 已到账，没到就说明卡在哪一步
    const paid = !!(t.reward && t.reward.paid);
    const estPts = paid ? t.reward.points
      : (typeof t.estPoints === 'number' ? t.estPoints
        : (window.Payout ? Payout.estimate(t) : 0));
    const payHTML = estPts
      ? (paid
          ? '<b style="color:var(--ok)">+' + estPts + ' 已到账</b>'
          : '<b style="color:var(--warn)">待发放 +' + estPts + '</b>' +
            '<span style="color:var(--text-3)"> · 后勤到场核实并处理完成后到账</span>')
      : '—';

    box.innerHTML =
      '<div class="qr-card">' +
        '<div class="qr-hd">' +
          '<div>' +
            '<div class="qr-code">' + UI.escapeHtml(t.code) + '</div>' +
            '<div class="qr-type">' + UI.escapeHtml(typeLabel) + ' · ' + fmtTime(t.at) + '</div>' +
          '</div>' +
          '<span class="qr-status" style="color:' + st.color + ';background:' + st.bg + '">' +
            st.label + '</span>' +
        '</div>' +
        '<dl class="qr-meta">' +
          '<dt>位置</dt><dd>' + UI.escapeHtml(t.addr || '已记录坐标') + '</dd>' +
          '<dt>负责部门</dt><dd>' + UI.escapeHtml(t.dept || '待分派') + '</dd>' +
          '<dt>紧急度</dt><dd>' + starsHTML(t.severity || 1) + '</dd>' +
          '<dt>反馈人数</dt><dd>' + (t.reporters || 1) + ' 人' + (t.merged ? ' · 已合并' : '') + '</dd>' +
          '<dt>积分</dt><dd>' + payHTML + '</dd>' +
        '</dl>' +
        '<div class="tl">' +
          (t.timeline || []).map(function (e, i) {
            return '<div class="tl-row' + (i === 0 ? ' is-first' : '') + (e.tone === 'ok' ? ' is-ok' : '') + '">' +
                     '<div class="tl-t">' + UI.escapeHtml(e.label) + '</div>' +
                     '<div class="tl-time">' + fmtTime(e.at) + '</div>' +
                   '</div>';
          }).join('') +
        '</div>' +
      '</div>';
  }

  function bindQuery() {
    const input = $('#queryInput');
    $('#btnQuery').addEventListener('click', function () { renderQuery(input.value); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); renderQuery(input.value); }
    });
    $$('[data-fill]').forEach(function (b) {
      b.addEventListener('click', function () {
        input.value = b.dataset.fill;
        renderQuery(b.dataset.fill);
      });
    });
  }

  /* ============================================================
     积分乐园：抽奖 / 商城
     ------------------------------------------------------------
     两块共用一份积分，但玩法互不相干：
     抽的是非卖品，买的是明码标价。

     原来还有第三块「宠物养成」，后来整个删掉了 —— 那是另一个游戏，
     跟"上报—派单—办结"这条链没有因果关系，放在这里只会分散注意力。
     积分有两个出口已经够用，而且这两个都能直接挂在上报这件事上讲。
     ============================================================ */

  let rwTab = 'lottery';
  let rwDrawing = false;
  let rwLastPrize = null;

  const RW_KIND = {
    frame: { label: '头像框', hint: '换掉名字旁边那一圈' },
    title: { label: '称号',  hint: '挂在昵称后面' }
  };

  function renderRewards() {
    const R = window.Rewards;
    if (!R) return;

    const pts = R.points();
    $('#rwPoints').textContent = pts;
    const mp = $('#menuPoints');
    if (mp) mp.textContent = pts + ' 分';

    $$('#rwTabs .rw-seg-btn').forEach(function (b) {
      b.classList.toggle('is-on', b.dataset.rw === rwTab);
    });

    const body = $('#rwBody');
    if (rwTab === 'mall') body.innerHTML = mallHTML();
    else body.innerHTML = lotteryHTML();

    bindRewards();
  }

  /* ---------------- 抽奖 ---------------- */

  function lotteryHTML() {
    const R = window.Rewards;
    const pts = R.points();
    const st = R.get();
    const pool = R.LOTTERY.slice().sort(function (a, b) { return a.weight - b.weight; });

    const result = rwLastPrize
      ? '<div class="rw-drop">' +
          '<div class="rd-k">上次抽到</div>' +
          '<div class="rd-v">' + UI.escapeHtml(rwLastPrize.name) + '</div>' +
          (rwLastPrize.desc ? '<div class="rd-d">' + UI.escapeHtml(rwLastPrize.desc) + '</div>' : '') +
        '</div>'
      : '';

    return '<div class="rw-hero reveal">' +
             '<div class="rh-dice">' + UI.icon('dice', 34) + '</div>' +
             '<div class="rh-t">抽一次</div>' +
             '<div class="rh-s">奖池里全是商城不卖的东西，抽到重复的自动折 60 分</div>' +
             '<button class="btn btn--primary btn--block" id="btnDraw" ' +
               (pts < R.DRAW_COST ? 'aria-disabled="true"' : '') + '>' +
               '花 ' + R.DRAW_COST + ' 分抽一次' +
             '</button>' +
             '<div class="rh-h">已抽 ' + st.draws + ' 次 · 当前 ' + pts + ' 分</div>' +
             result +
           '</div>' +

           '<div class="rw-sec-h">奖池</div>' +
           '<div class="pool-list">' +
             pool.map(function (p) {
               return '<div class="pool-row' + (p.rare ? ' is-rare' : '') + '">' +
                        '<span class="pr-dot"></span>' +
                        '<span class="pr-n">' + UI.escapeHtml(p.name) + '</span>' +
                        (p.rare ? '<span class="pr-tag">限定</span>' : '') +
                        '<span class="pr-w num">' + p.weight + '%</span>' +
                      '</div>';
             }).join('') +
           '</div>' +
           '<div class="rw-note">概率按权重折算，「再来一次」等于这次免费，' +
             '「谢谢参与」只扣积分不给东西——抽之前先看一眼这张表。</div>';
  }

  /* ---------------- 商城 ---------------- */

  function mallHTML() {
    const R = window.Rewards;
    const st = R.get();
    const groups = { frame: [], title: [] };
    R.MALL.forEach(function (it) { (groups[it.kind] || (groups[it.kind] = [])).push(it); });

    return Object.keys(groups).map(function (kind) {
      const items = groups[kind];
      if (!items.length) return '';
      const meta = RW_KIND[kind] || { label: kind, hint: '' };

      return '<div class="rw-sec">' +
               '<div class="rw-sec-h">' + meta.label +
                 '<span class="rw-sec-n">' + meta.hint + '</span>' +
               '</div>' +
               '<div class="mall-grid">' +
                 items.map(function (it) {
                   const owned = st.owned.indexOf(it.id) >= 0;
                   const on = st.frame === it.id || st.title === it.id;
                   const can = R.points() >= it.cost;

                   return '<button class="mall-card' + (owned ? ' is-owned' : '') + (on ? ' is-on' : '') + '" ' +
                            'data-buy="' + it.id + '"' + (can || owned ? '' : ' aria-disabled="true"') + '>' +
                            '<span class="mc-ic">' + UI.icon(it.icon, 19) + '</span>' +
                            '<span class="mc-t">' + UI.escapeHtml(it.name) + '</span>' +
                            '<span class="mc-d">' + UI.escapeHtml(it.desc || '') + '</span>' +
                            '<span class="mc-c">' +
                              (owned
                                ? (on ? '使用中' : '点一下换上')
                                : '<b class="num">' + it.cost + '</b> 分') +
                            '</span>' +
                          '</button>';
                 }).join('') +
               '</div>' +
             '</div>';
    }).join('') +
    '<div class="rw-note">买了立刻换上；再点一次可以摘下来。积分不够的卡片是灰的，不会误点。</div>';
  }

  /* ---------------- 绑定 ---------------- */

  function bindRewards() {
    const R = window.Rewards;

    const drawBtn = $('#btnDraw');
    if (drawBtn) {
      drawBtn.addEventListener('click', function () {
        if (rwDrawing) return;
        const r = R.draw();
        if (!r.ok) { UI.toast(r.reason, 'warn'); return; }

        rwDrawing = true;
        drawBtn.setAttribute('aria-disabled', 'true');
        drawBtn.textContent = '抽取中…';

        const names = R.LOTTERY.map(function (x) { return x.name; });
        let i = 0;
        const spin = setInterval(function () {
          drawBtn.textContent = names[i++ % names.length];
        }, 70);

        setTimeout(function () {
          clearInterval(spin);
          rwDrawing = false;
          rwLastPrize = r.prize;
          renderRewards();
          UI.toast('抽到「' + r.prize.name + '」', r.prize.kind === 'empty' ? 'warn' : 'ok');
        }, 900);
      });
    }

    $$('[data-buy]').forEach(function (b) {
      b.addEventListener('click', function () {
        const id = b.dataset.buy;
        const item = R.findItem(id);
        if (!item) return;

        if (R.owns(id)) {
          if (R.equip(id)) {
            renderRewards();
            UI.toast('已换上「' + item.name + '」', 'ok');
          }
          return;
        }

        const res = R.buy(id);
        if (!res.ok) { UI.toast(res.reason, 'warn'); return; }
        renderRewards();
        applySession();
        UI.toast('已入手「' + item.name + '」', 'ok');
      });
    });
  }

  function boot() {
    // 状态栏图标
    $('#sbIcons').innerHTML = UI.icon('signal', 15) + UI.icon('wifi', 15) + UI.icon('battery', 22);

    /* 身份：有会话直接进；没有就挡一层闸门。
       但 #demo-* / #point / #query 这些演示入口不该被拦住，
       自动以游客身份进入，投屏时少点两下。 */
    const hash0 = decodeURIComponent(location.hash.replace(/^#/, ''));
    if (!A.get()) {
      const isDemoEntry = hash0.indexOf('demo-') === 0 || hash0 === 'point' ||
                          hash0 === 'point-done' || hash0 === 'query';
      if (isDemoEntry) A.loginGuest();
    }
    applySession();

    renderTabbar();
    renderMapStats();
    renderMarkers();
    bindMap();

    renderPhotos();
    renderTypes();
    renderPtLadder();
    renderSuggest();
    refreshSubmit();
    bindReport();

    // 「AI 未连接」那行可以点，点一次重新探活 —— 演示前不用刷新整页
    const aiBadge = $('#aiModeBadge');
    if (aiBadge) {
      aiBadge.addEventListener('click', function () {
        aiBadge.textContent = '检测中…';
        getAgent().probe().then(function (st) {
          paintAiBadge(st);
          UI.toast(st.mode === 'deepseek' ? 'AI 已连上' : (st.lastError || 'AI 还是没连上'),
                   st.mode === 'deepseek' ? 'ok' : 'warn');
        });
      });
    }

    bindAuth();
    bindQuery();
    renderQuery('');
    realLocate();

    renderReportTabs();
    renderReportList();
    renderProfile();
    renderBadges();
    renderScenes();

    /* 点开看细节：列表项 → 上报详情；两处分值 → 流水账。
       都用事件委托，列表重渲染之后不用重新绑。 */
    const rl = $('#reportList');
    if (rl) {
      rl.addEventListener('click', function (e) {
        const item = e.target.closest('[data-code]');
        if (item) openReportDetail(item.dataset.code);
      });
    }
    const creditCard = document.querySelector('.credit-card');
    if (creditCard) {
      creditCard.style.cursor = 'pointer';
      creditCard.addEventListener('click', function () { openLedger('credit'); });
    }
    const ptCell = document.querySelector('.score-pair .score-cell');
    if (ptCell) {
      ptCell.style.cursor = 'pointer';
      ptCell.addEventListener('click', function () { openLedger('points'); });
    }

    if (!A.get()) showGate(false);

    // 积分乐园的三个页签只绑一次（内容区每次重渲染，页签本身不动）
    $$('#rwTabs .rw-seg-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        if (rwTab === b.dataset.rw) return;
        rwTab = b.dataset.rw;
        renderRewards();
      });
    });

    // 全局点击路由
    document.addEventListener('click', function (e) {
      const t = e.target.closest('[data-go]');
      if (t) go(t.dataset.go);
    });

    $('#btnReset').addEventListener('click', resetDemo);

    hydrate();

    /* 直达入口：index.html#profile / #badges / #reports
       也可以 #demo-normal 直接把某个演示场景跑完停在结果页，
       方便投屏时跳过点击，或者截某个状态。 */
    handleHash();
    window.addEventListener('hashchange', handleHash);
  }

  function handleHash() {
    const h = decodeURIComponent(location.hash.replace(/^#/, ''));
    if (!h) return;

    if (h.indexOf('demo-') === 0) {
      const key = h.slice(5);
      const s = D.SCENES.filter(function (x) { return x.key === key; })[0];
      if (s) setTimeout(function () { runScene(s); }, 260);
      return;
    }
    // #point / #point-done：直接弹出一个点位的详情，方便单独讲这一屏
    if (h === 'point' || h === 'point-done') {
      const pt = D.POINTS.filter(function (p) {
        return p.status === (h === 'point' ? 'pending' : 'resolved');
      })[0];
      if (pt) setTimeout(function () { showPoint(pt); }, 320);
      return;
    }
    if (screenEl(h)) go(h);
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
