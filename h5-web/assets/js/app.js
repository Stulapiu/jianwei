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
    reports: JSON.parse(JSON.stringify(D.MY_REPORTS)),
    user: JSON.parse(JSON.stringify(D.USER))
  };

  /** 这三屏是二级页，进入后收起底部导航 */
  const HIDE_TAB = ['report', 'result', 'badges'];

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
    if (credit >= 90) return '金牌哨兵';
    if (credit >= 75) return '守信哨兵';
    if (credit >= 60) return '见习哨兵';
    return '待提升';
  }

  /* ============================================================
     2. 路由
     ============================================================ */

  function go(name, opts) {
    opts = opts || {};
    const to = screenEl(name);
    if (!to) return;

    // 数据屏每次进入都重新渲染，保证提交后的列表、徽章、信用分是新的
    if (name === 'reports') { renderReportTabs(); renderReportList(); }
    if (name === 'profile') renderProfile();
    if (name === 'badges') renderBadges();

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

  function renderPhotos() {
    const grid = $('#photoGrid');
    let html = state.photos.map(function (ph, i) {
      return '<div class="photo-cell photo-pop">' +
               D.photoSVG(ph.kind) +
               '<button class="photo-del" data-del="' + i + '" aria-label="删除">' +
                 UI.icon('close', 11) + '</button>' +
             '</div>';
    }).join('');

    if (state.photos.length < 3) {
      html += '<div class="photo-cell">' +
                '<button class="photo-add" id="btnAddPhoto">' +
                  '<span class="plus">' + UI.icon('plus', 15) + '</span>' +
                  '<span>拍照 / 相册</span>' +
                '</button>' +
              '</div>';
    }

    grid.innerHTML = html;

    $$('[data-del]', grid).forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        state.photos.splice(+b.dataset.del, 1);
        renderPhotos();
        refreshSubmit();
      });
    });

    const add = $('#btnAddPhoto');
    if (add) add.addEventListener('click', openPhotoPicker);
  }

  /** 选图面板：不是真调摄像头，而是给几张可控的样例照片 */
  function openPhotoPicker() {
    const options = [
      { kind: 'trash',   label: '垃圾桶满溢',  note: '清晰 · 含设施' },
      { kind: 'lamp',    label: '路灯不亮',    note: '夜间 · 主体偏暗' },
      { kind: 'pothole', label: '井盖缺失',    note: '路面 · 有隐患' },
      { kind: 'scenery', label: '校园风景',    note: '没有设施' },
      { kind: 'blur',    label: '手抖拍糊',    note: '画面模糊' }
    ];

    const body =
      '<div class="picker">' +
        options.map(function (o) {
          return '<button class="pick" data-pick="' + o.kind + '">' +
                   '<span class="pick-img">' + D.photoSVG(o.kind) + '</span>' +
                   '<span class="pick-t">' + o.label + '</span>' +
                   '<span class="pick-n">' + o.note + '</span>' +
                 '</button>';
        }).join('') +
      '</div>' +
      '<div class="hint" style="margin-top:12px;text-align:center;line-height:1.6">' +
        '演示环境不调摄像头，用样例照片代替。<br>' +
        '后两张会被 AI 拦下，正好可以看拦截文案。' +
      '</div>';

    UI.sheet({
      title: '选择现场照片',
      sub: '演示环境 · 5 张样例',
      body: body,
      onMount: function (api) {
        $$('[data-pick]', api.el).forEach(function (b) {
          b.addEventListener('click', function () {
            state.photos.push({ kind: b.dataset.pick });
            api.close();
            renderPhotos();
            refreshSubmit();
          });
        });
      }
    });
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
        refreshSubmit();
      });
    });
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
    $('#locState').textContent = source === 'gps' ? '已定位' : '已定位 · 默认位置';

    const meta = $('#coordMeta');
    if (meta && meta.lastElementChild) {
      // 展示时只到 5 位小数（约 1 米），并说明还会再模糊
      meta.lastElementChild.textContent =
        lat.toFixed(5) + ', ' + lng.toFixed(5) + ' · 展示时模糊到约 100 米';
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
      if (reason) UI.toast(reason + '，先用校区中心，可手动修正', 'warn');
    }, 260);
  }

  function canSubmit() {
    return state.photos.length > 0 && !!state.type && state.located;
  }

  function refreshSubmit() {
    const btn = $('#btnSubmit');
    const ok = canSubmit();
    btn.setAttribute('aria-disabled', ok ? 'false' : 'true');
  }

  function resetForm(keepAddr) {
    state.photos = [];
    state.type = '';
    state.desc = '';
    if (!keepAddr) state.addr = '';
    $('#descInput').value = '';
    $('#descCount').textContent = '0';
    $('#addrInput').value = state.addr;
    renderPhotos();
    renderTypes();
    refreshSubmit();
  }

  function bindReport() {
    $('#descInput').addEventListener('input', function (e) {
      state.desc = e.target.value.slice(0, 100);
      $('#descCount').textContent = state.desc.length;
    });

    $('#addrInput').addEventListener('input', function (e) {
      state.addr = e.target.value;
    });

    $('#btnFixLoc').addEventListener('click', function () {
      // 真实版本是打开地图点选。这里给校区里的主要地标，
      // 每个都带真实坐标，选完之后定位信息也会跟着更新
      const body = '<div class="picker picker--list">' +
        D.LANDMARKS.map(function (m) {
          return '<button class="pick-row" data-spot="' + m.id + '">' +
                   UI.icon('pin', 15) +
                   '<span style="flex:1;text-align:left">' + UI.escapeHtml(m.name) + '</span>' +
                   '<span class="hint num">' + m.lng.toFixed(4) + ', ' + m.lat.toFixed(4) + '</span>' +
                 '</button>';
        }).join('') + '</div>';

      UI.sheet({
        title: '修正位置',
        sub: '校内主要地点 · 选完自动对齐坐标',
        body: body,
        onMount: function (api) {
          $$('[data-spot]', api.el).forEach(function (b) {
            b.addEventListener('click', function () {
              const m = D.LANDMARKS.filter(function (x) { return x.id === b.dataset.spot; })[0];
              if (!m) return;
              state.addr = m.name;
              state.lng = m.lng;
              state.lat = m.lat;
              state.located = true;
              $('#addrInput').value = m.name;
              const meta = $('#coordMeta');
              if (meta && meta.lastElementChild) {
                meta.lastElementChild.textContent =
                  m.lat.toFixed(5) + ', ' + m.lng.toFixed(5) + ' · 展示时模糊到约 100 米';
              }
              api.close();
              refreshSubmit();
              UI.toast('位置已更新 · ' + m.name, 'ok');
            });
          });
        }
      });
    });

    $('#btnSubmit').addEventListener('click', submit);
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

  function getAgent() {
    if (!agent) {
      agent = SentinelAgent.create({ mode: 'auto' });
      // 探测本地代理。探不到就走规则引擎，不影响使用。
      agent.probe().then(function (st) {
        const badge = $('#aiModeBadge');
        if (badge) {
          badge.textContent = st.mode === 'deepseek'
            ? 'DeepSeek · ' + (st.model || 'deepseek-chat')
            : '本地规则引擎';
          badge.dataset.mode = st.mode;
        }
      });
    }
    return agent;
  }

  async function submit() {
    if (!canSubmit()) {
      if (!state.photos.length) UI.toast('先拍一张现场照片吧');
      else if (!state.type) UI.toast('选一下问题类型');
      else UI.toast('还没有获取到位置');
      return;
    }

    const ag = getAgent();
    const st = ag.status();
    const t0 = Date.now();

    openAiMask();

    const v = await ag.judge({
      image: D.photoDataURI(state.photos[0].kind),
      type: state.type,
      desc: state.desc,
      address: state.addr,
      lng: state.lng,
      lat: state.lat
    });

    // 真实模型通常 1–3 秒，本地规则只要几十毫秒。
    // 太快反而显得"根本没在看"，兜一个下限，也让讲解有个节拍。
    const minWait = st.mode === 'deepseek' ? 700 : 1150;
    const rest = minWait - (Date.now() - t0);
    if (rest > 0) await sleep(rest);

    closeAiMask();
    await sleep(140);

    if (!v.pass) {
      state.invalidStreak++;
      showReject(v);
      return;
    }

    const merge = checkMerge();
    state.invalidStreak = 0;

    const rec = {
      id: 'q' + Date.now(),
      type: state.type,
      status: 'pending',
      addr: state.addr || '已记录坐标',
      ago: 0,
      merged: merge.merged ? Math.max(1, merge.reporters - 1) : 0,
      photo: state.photos[0].kind,
      lng: state.lng,
      lat: state.lat
    };
    state.reports.unshift(rec);

    state.user.validCnt++;
    state.user.credit = Math.min(100, state.user.credit + 2);
    const newBadges = grantBadges(v, merge.merged, true);

    showPass(v, merge, newBadges);
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

    if (earned.length) state.user.badges = owned.concat(earned);
    return earned.map(function (code) {
      return D.BADGES.filter(function (b) { return b.code === code; })[0];
    }).filter(Boolean);
  }

  function starsHTML(n) {
    let s = '';
    for (let i = 1; i <= 5; i++) s += '<i class="' + (i <= n ? 'on' : '') + '"></i>';
    return '<span class="stars">' + s + '<span class="n num">' + n + ' / 5</span></span>';
  }

  function showPass(v, merge, newBadges) {
    const typeLabel = D.TYPE_LABEL[state.type];
    const dept = Domain.deptFor(state.type);
    // 合并会抬升紧急度，界面上要显示抬升后的值，
    // 否则会出现「紧急度 2 星」和「从 2 星抬到 3 星」并排打架
    const finalSeverity = (merge && merge.merged && merge.severityAfter > v.severity)
      ? merge.severityAfter
      : v.severity;
    const pri = Domain.priorityOf(finalSeverity);

    const html =
      '<div class="result-wrap">' +
        '<div class="tick">' +
          '<div class="tick-fill">' +
            '<svg viewBox="0 0 32 32"><path d="M8 16.6l5.4 5.4L24 11.2"/></svg>' +
          '</div>' +
        '</div>' +
        '<div class="result-title">已经收到</div>' +
        '<div class="result-sub">谢谢你替这条街多看一眼</div>' +

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
            '<span class="tag tag--ai">' + UI.icon('spark', 11) + 'AI 建议 · 仅供参考</span>' +
            '<div class="txt">' + UI.escapeHtml(v.summary) + '</div>' +
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
      '</div>' +

      '<div class="result-actions">' +
        '<button class="btn btn--primary btn--block" data-go="reports">看看我的上报</button>' +
        '<button class="btn btn--text btn--block" data-go="map">回到地图</button>' +
      '</div>';

    renderResult(html);
  }

  function showReject(v) {
    const typeLabel = D.TYPE_LABEL[state.type];
    const reasonText = {
      blur: '画面不够清晰',
      dark: '照片太暗',
      overexposed: '照片过曝',
      flat: '疑似截图或纯色图',
      'non-facility': '没识别到公共设施',
      mismatch: '描述与所选类型不一致'
    }[v.reason] || '照片信息不足';

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
            '<div class="hint" style="line-height:1.7">' +
              '这次不算你的错，只是 AI 想让工单更准确一点。' +
              '重新拍一张通常就能过；如果你确信信息没问题，也可以直接转人工复核。' +
            '</div>' +
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
        '<button class="btn btn--text btn--block" id="btnForce">仍然提交，转人工复核</button>' +
        '<div class="dock-hint">AI 建议 · 仅供参考，人工复核全程保留</div>' +
      '</div>';

    renderResult(html);
  }

  function renderResult(html) {
    const body = $('#resultBody');
    body.innerHTML = html;
    go('result');

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
      force.addEventListener('click', function () {
        force.disabled = true;
        force.textContent = '已提交，等待复核';

        state.reports.unshift({
          id: 'q' + Date.now(),
          type: state.type,
          status: 'review',
          addr: state.addr || '已记录坐标',
          ago: 0,
          merged: 0,
          photo: state.photos[0] ? state.photos[0].kind : 'scenery'
        });

        setTimeout(function () {
          UI.toast('已转人工复核，结果会通知你', 'ok');
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
    box.innerHTML = TAB_DEFS.map(function (t) {
      const n = t.key === 'all'
        ? state.reports.length
        : state.reports.filter(function (r) { return r.status === t.key; }).length;
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

  function renderReportList() {
    const list = state.reports.filter(function (r) {
      return state.reportTab === 'all' || r.status === state.reportTab;
    });

    $('#reportsSub').textContent = '共 ' + state.reports.length + ' 条记录';
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

      return '<div class="report-item reveal" style="--d:' + (i + 1) + '">' +
               '<div class="report-thumb">' + D.photoSVG(r.photo) + '</div>' +
               '<div class="report-main">' +
                 '<div class="report-top">' +
                   '<span class="report-type">' + D.TYPE_LABEL[r.type] + '</span>' +
                   '<span class="report-status" style="color:' + st.color + '">' + st.label + '</span>' +
                 '</div>' +
                 '<div class="report-addr">' + UI.escapeHtml(r.addr) + '</div>' +
                 '<div class="report-meta">' +
                   '<span>' + when + '</span>' +
                   (r.merged ? '<span>· 已与 ' + r.merged + ' 人合并</span>' : '') +
                 '</div>' +
               '</div>' +
             '</div>';
    }).join('');
  }

  function renderProfile() {
    const u = state.user;
    $('#pAvatar').textContent = u.initial;
    $('#pName').textContent = u.name;
    $('#pStreak').textContent = u.streak > 0 ? '连续 ' + u.streak + ' 天上报' : '今天还没上报';
    $('#pCredit').innerHTML = u.credit + '<small>/ 100</small>';
    $('#pTier').textContent = tierOf(u.credit);
    $('#creditBar').style.width = u.credit + '%';
    $('#pValid').textContent = u.validCnt;
    $('#pResolved').textContent = u.resolvedCnt;
    $('#pInvalid').textContent = u.invalidCnt;

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
    go('report');
    resetForm(true);

    // 预置材料
    state.photos = [{ kind: s.photo }];
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

  function boot() {
    // 状态栏图标
    $('#sbIcons').innerHTML = UI.icon('signal', 15) + UI.icon('wifi', 15) + UI.icon('battery', 22);

    renderTabbar();
    renderMapStats();
    renderMarkers();
    bindMap();

    renderPhotos();
    renderTypes();
    bindReport();
    realLocate();

    renderReportTabs();
    renderReportList();
    renderProfile();
    renderBadges();
    renderScenes();

    // 全局点击路由
    document.addEventListener('click', function (e) {
      const t = e.target.closest('[data-go]');
      if (t) go(t.dataset.go);
    });

    $('#btnReset').addEventListener('click', resetDemo);

    $('#btnExchange').addEventListener('click', function () {
      UI.toast('积分商城正在筹备，先攒着');
    });

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
