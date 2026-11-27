/* ==========================================================================
 * 见微 · 网页版交互
 * --------------------------------------------------------------------------
 * 和手机端共享 shared/ 下的四个模块：
 *   tilemap.js  地图     domain.js  领域词汇     auth.js  身份与积分
 *   agent.js    智能体   data.js     演示数据
 *
 * 这个文件只做三件事：
 *   1. 三栏布局的视图切换与渲染
 *   2. 上报流程（照片 → 类型 → 位置 → AI 判定 → 结果）
 *   3. 把选中对象的详情喂给右侧上下文面板
 * ========================================================================== */
(function () {
  'use strict';

  const D = window.DATA;
  const UI = window.UI;
  const A = window.Auth;
  const Domain = window.Domain;
  const SentinelAgent = window.SentinelAgent;

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ============================================================
     状态
     ============================================================ */

  const state = {
    view: 'map',
    layer: 'pending',
    base: 'gaode',
    heat: false,
    photo: null,          // 当前选中的照片 kind 或 dataURL
    type: '',
    desc: '',
    addr: '',
    lng: null,
    lat: null,
    located: false,
    preview: null,        // 图片即时预判结果
    photoGate: null,      // 本地准入结果（糊了/太暗/像截图）
    previewing: false,
    lastReject: null,
    tstatus: 'all',
    rwTab: 'lottery',     // 积分乐园：lottery | mall
    lgKind: 'points',     // 流水：points | credit
    tickets: [],          // 本会话提交的工单
    picked: null          // 地图上选中的点位
  };

  const VIEW_META = {
    map:     { t: '地图',     s: '郑州大学主校区 · 实时点位' },
    report:  { t: '上报问题', s: '拍照 → 选类型 → 定位 → AI 判定' },
    tickets: { t: '我的工单', s: '凭编码随时查进度' },
    query:   { t: '查进度',   s: '不登录也能凭编码查询' },
    rewards: { t: '积分乐园', s: '抽奖 · 商城 · 积分去处' },
    me:      { t: '我的',     s: '信用分 · 积分 · 账号权重' }
  };

  /* 演示照片的 kind 必须和 data.js 里 photoSVG 的分支对齐：
     trash / lamp / pothole / puddle / scenery / blur。
     写成别的名字会画出一张空白图，然后被 AI 判成"没有实体"——
     这个坑踩过一次，注释留在这里。 */
  const PHOTOS = [
    { kind: 'trash',   cap: '垃圾桶满溢' },
    { kind: 'lamp',    cap: '路灯不亮' },
    { kind: 'pothole', cap: '路面坑洼' },
    { kind: 'puddle',  cap: '路面积水' },
    { kind: 'blur',    cap: '拍糊了' },
    { kind: 'scenery', cap: '风景照' }
  ];

  const STATUS_UI = {
    pending:    { label: '待派单', color: '#C97E15', bg: 'var(--warn-bg)' },
    processing: { label: '处理中', color: '#2B7A78', bg: 'var(--brand-light)' },
    resolved:   { label: '已解决', color: '#3E8A5F', bg: 'var(--ok-bg)' },
    review:     { label: '人工复核', color: '#6B7C8A', bg: 'var(--review-bg)' }
  };

  /* 类型 → 演示照片，纯为让详情面板有图可看 */
  const PHOTO_BY_TYPE = {
    sanitation: 'trash', lighting: 'lamp', road: 'pothole', water: 'puddle',
    safety: 'pothole', facility: 'pothole', green: 'scenery',
    traffic: 'pothole', network: 'trash', other: 'scenery'
  };

  const TYPE_COLOR = {};
  D.TYPES.forEach(function (t) { TYPE_COLOR[t.key] = t.color || '#2B7A78'; });

  let map = null;
  let agent = null;

  /* ============================================================
     工具
     ============================================================ */

  function hydrate(root) {
    $$('[data-icon]', root || document).forEach(function (el) {
      if (el.dataset.done) return;
      el.innerHTML = UI.icon(el.dataset.icon, +el.dataset.size || 16);
      el.dataset.done = '1';
    });
  }

  function toast(msg, type) {
    const host = $('#toastHost');
    const el = document.createElement('div');
    el.className = 'toast' + (type ? ' is-' + type : '');
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(function () {
      el.style.transition = 'opacity .3s, transform .3s';
      el.style.opacity = '0';
      el.style.transform = 'translateY(8px)';
      setTimeout(function () { el.remove(); }, 320);
    }, 2200);
  }

  function stars(n) {
    let s = '';
    for (let i = 1; i <= 5; i++) s += '<i class="' + (i <= n ? 'on' : '') + '"></i>';
    return '<span class="stars">' + s + '<span class="n">' + n + '/5</span></span>';
  }

  function fmtTime(at) {
    const d = new Date(at);
    const p = (n) => (n < 10 ? '0' + n : '' + n);
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /** 两个节点之间隔了多久 —— 只写绝对时间看不出一单卡了几天 */
  function fmtSpan(ms) {
    const m = Math.round(ms / 60000);
    if (m < 1) return '不到 1 分钟';
    if (m < 60) return m + ' 分钟';
    const h = Math.floor(m / 60);
    if (h < 24) return h + ' 小时' + (m % 60 ? ' ' + (m % 60) + ' 分' : '');
    return Math.floor(h / 24) + ' 天' + (h % 24 ? ' ' + (h % 24) + ' 小时' : '');
  }

  function distanceText(lng, lat) {
    const near = D.LANDMARKS.reduce(function (best, m) {
      const d = window.TileMap.distance(lng, lat, m.lng, m.lat);
      return d < best.d ? { m: m, d: d } : best;
    }, { m: null, d: Infinity });
    return near.m ? near.m.name : '校区内';
  }

  /* ============================================================
     视图切换
     ============================================================ */

  function go(name) {
    if (!VIEW_META[name]) return;
    state.view = name;

    $$('.view').forEach(function (v) {
      v.classList.toggle('is-on', v.dataset.view === name);
    });
    $$('.rail-btn').forEach(function (b) {
      b.classList.toggle('is-on', b.dataset.view === name);
    });

    $('#viewTitle').textContent = VIEW_META[name].t;
    $('#viewSub').textContent = VIEW_META[name].s;

    // 上报页自带 AI 侧栏，把上下文中转栏收掉，主区更宽
    $('#app').classList.toggle('is-report', name === 'report');

    if (name === 'map') {
      // 地图容器在切回来之前宽度是 0，必须重新量一次
      setTimeout(function () { if (map) map.resize(); }, 60);
    }
    if (name === 'tickets') renderTickets();
    if (name === 'me') renderMe();
    if (name === 'rewards') renderRewards();
    if (name === 'report') {
      /* 和手机端一致：交完一条再回上报页，不要挂着上一条的照片和描述。
         桌面端更容易踩这个坑 —— 左边填着，右边已经显示结果了。 */
      if (state.formStale) {
        state.formStale = false;
        resetReport();
      }
      renderReportState();
    }
    if (name === 'query') renderQuery($('#queryInput').value);
  }

  /** 清空上报表单，但保留位置（人通常还在原地） */
  function resetReport() {
    state.photos = [];
    state.photo = null;
    state.desc = '';
    state.type = '';
    state.preview = null;
    state.photoGate = null;
    var d = $('#descInput');
    if (d) { d.value = ''; }
    var c = $('#descCount');
    if (c) c.textContent = '0';
    renderShots();
    renderTypes();
  }

  /* ============================================================
     地图
     ============================================================ */

  function initMap() {
    map = window.TileMap.create($('#mapHolder'), {
      center: [window.TileMap.CAMPUS.lng, window.TileMap.CAMPUS.lat],
      zoom: 16,
      source: 'gaode',
      // 点击地图时抛个自定义事件出去。「选点模式」在监听着，
      // 平时没人听，就等于普通点击，不会互相干扰。
      onClick: function (lng, lat) {
        $('#mapHolder').dispatchEvent(new CustomEvent('picked', { detail: { lng: lng, lat: lat } }));
      }
    });
    renderMarkers();
    renderMapStats();

    // 拖拽过程中提示会挡视线，动手就淡出
    const tip = $('#mapTip');
    $('#mapHolder').addEventListener('mousedown', function () { tip.style.opacity = '0'; });
    $('#mapHolder').addEventListener('mouseleave', function () { tip.style.opacity = '1'; });
  }

  function visiblePoints() {
    return D.POINTS.filter(function (p) {
      return state.layer === 'all' || p.status === state.layer;
    });
  }

  function renderMarkers() {
    const list = visiblePoints().map(function (p) {
      const color = TYPE_COLOR[p.type] || '#2B7A78';
      const done = p.status === 'resolved';
      return {
        id: p.id,
        lng: p.lng,
        lat: p.lat,
        className: 'wm',
        title: D.TYPE_LABEL[p.type] + ' · ' + p.addr,
        html: '<span class="wm-dot' + (done ? ' is-done' : '') + '" style="--c:' + color + '">' +
                '<i></i>' +
              '</span>',
        onClick: function () { showPoint(p); }
      };
    });
    map.setMarkers(list);
    if (state.heat) {
      map.setHeat(visiblePoints().map(function (p) {
        return { lng: p.lng, lat: p.lat, weight: (p.merged || 0) + 1 };
      }));
    } else {
      map.setHeat(null);
    }
  }

  function renderMapStats() {
    const pending = D.POINTS.filter((p) => p.status === 'pending').length;
    const done = D.POINTS.filter((p) => p.status === 'resolved').length;
    const merged = D.POINTS.filter((p) => p.merged > 0).length;
    $('#msPending').textContent = pending;
    $('#msResolved').textContent = done;
    $('#msMerged').textContent = merged;
  }

  function showPoint(p) {
    state.picked = p;
    const st = D.STATUS[p.status] || D.STATUS.pending;
    const dept = Domain.deptFor(p.type);
    // 点位数据里没存严重度，用类型的基准值 + 合并抬升推出来，
    // 与用户端看到的数字保持一致
    const sev = Math.min(5, (Domain.type(p.type).base || 2) + (p.merged || 0));
    const pri = Domain.priorityOf(sev);
    const photo = p.photo || PHOTO_BY_TYPE[p.type] || 'trash';

    $('#ctxCard').innerHTML =
      '<div class="ctx-hd">' +
        '<div style="flex:1">' +
          '<div class="ctx-title">' + UI.escapeHtml(D.TYPE_LABEL[p.type]) + '</div>' +
          '<div class="ctx-sub">' + UI.escapeHtml(p.addr) + '</div>' +
        '</div>' +
        '<span class="tag" style="color:' + st.color + ';background:' + st.color + '14">' + st.label + '</span>' +
      '</div>' +
      '<div class="ctx-pic">' + photoHTML(photo) + '</div>' +
      '<dl class="kv">' +
        '<dt>负责部门</dt><dd>' + UI.escapeHtml(dept.name) + '</dd>' +
        '<dt>紧急度</dt><dd>' + stars(sev) + '</dd>' +
        '<dt>优先级</dt><dd><span class="tag" style="color:' + pri.color + ';background:' + pri.color + '14">' +
          pri.id + ' · ' + pri.label + '</span></dd>' +
        '<dt>反馈人数</dt><dd>' + (p.merged ? (p.merged + 1) + ' 人 · 已合并' : '1 人') + '</dd>' +
        '<dt>上报时间</dt><dd>' + (p.ago < 1 ? Math.max(1, Math.round(p.ago * 24)) + ' 小时前' : Math.round(p.ago) + ' 天前') + '</dd>' +
      '</dl>' +
      (p.merged ?
        '<div class="ctx-note">这处问题有 <b>' + (p.merged + 1) + ' 个人</b>报过，已合并为一张工单，' +
        '紧急度比单人上报提升了 <b>' + p.merged + ' 星</b>。</div>' : '') +
      '<div class="ctx-actions">' +
        '<button class="btn btn--ghost" id="ctxGoReport">我也要上报</button>' +
      '</div>';

    $('#ctxGoReport').addEventListener('click', function () {
      go('report');
      pickLocation(p.lng, p.lat, p.addr);
    });
  }

  /* ============================================================
     上报
     ============================================================ */

  /** 照片渲染：内置示意图走 SVG，本地拖进来的走 img */
  function photoHTML(src) {
    if (!src) return '';
    if (src.indexOf('data:') === 0) return '<img src="' + src + '" alt="">';
    return D.photoSVG(src);
  }

  /**
   * 样例图是 SVG，模型只认位图。演示时把它栅格化成 PNG 一起送，
   * 这样"看图判断"是真的在看图，不是拿文字猜。
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
        } catch (e) { resolve(null); }
      };
      img.onerror = function () { resolve(null); };
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    });
  }

  function renderShots() {
    const local = state.photo && state.photo.indexOf('data:') === 0;
    const localShot = local
      ? '<button class="shot is-on" data-photo="__local">' +
          '<img src="' + state.photo + '" alt="">' +
          '<span class="cap">本地图片</span>' +
        '</button>'
      : '';

    $('#shotList').innerHTML = localShot + PHOTOS.map(function (ph) {
      return '<button class="shot' + (state.photo === ph.kind ? ' is-on' : '') + '" data-photo="' + ph.kind + '">' +
               D.photoSVG(ph.kind) +
               '<span class="cap">' + ph.cap + '</span>' +
             '</button>';
    }).join('');

    $$('[data-photo]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (b.dataset.photo === '__local') return;
        state.photo = b.dataset.photo;
        state.preview = null;
        renderShots();
        renderSuggest();
        renderReportState();
      });
    });
  }

  function renderTypes() {
    $('#typeList').innerHTML = D.TYPES.map(function (t) {
      return '<button class="type' + (state.type === t.key ? ' is-on' : '') + '" data-type="' + t.key + '">' +
               '<span class="ti" data-icon="' + (t.icon || 'wrench') + '"></span>' +
               '<span>' + t.label + '</span>' +
             '</button>';
    }).join('');
    hydrate($('#typeList'));

    $$('[data-type]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.type = b.dataset.type;
        renderTypes();
        renderReportState();
      });
    });
  }

  /* ============================================================
   * 即时识别（桌面版）
   * ------------------------------------------------------------
   * 和手机端同一套逻辑：本地图片一载入就送去认，认出来把候选类型
   * 顶在类型区、把描述建议放在输入框下面。样例插画不送 —— 那是 SVG，
   * 模型会正确地说"这不是照片"，反而添乱。
   * ============================================================ */

  let previewSeq = 0;

  function runPreview() {
    const src = state.photo;
    if (!src || src.indexOf('data:') !== 0) { state.preview = null; renderSuggest(); return; }

    const seq = ++previewSeq;
    state.previewing = true;
    state.preview = null;
    state.photoGate = null;
    renderSuggest({ loading: true });

    const ag = getAgent();

    /* 和手机端同一条路：先本地准入，过了才调模型。
       本地拦下就当场提示换图，不把一张注定要退的图送去模型。 */
    ag.check(src).then(function (qc) {
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
        return ag.preview({ image: src, type: state.type, desc: state.desc, address: state.addr });
      });
    }).then(function (res) {
      if (seq !== previewSeq || !res) return;
      state.previewing = false;
      if (!res.ok) { renderSuggest({ offline: true }); return; }
      state.preview = res;
      renderSuggest();
    }).catch(function () {
      if (seq !== previewSeq) return;
      state.previewing = false;
      renderSuggest();
    });
  }

  function renderSuggest(opt) {
    opt = opt || {};
    const boxT = $('#typeSuggest');
    const boxD = $('#descSuggest');
    if (!boxT || !boxD) return;

    if (opt.loading) {
      boxT.hidden = false;
      boxT.innerHTML = '<div class="ts-head">' + UI.icon('spark', 13) + ' 正在认这张图…</div>' +
        '<div class="ts-note">认出来会把类型顶上来，描述也能一键填入</div>';
      boxD.hidden = true;
      return;
    }
    if (opt.quality) {
      boxT.hidden = false;
      boxT.innerHTML =
        '<div class="ts-head" style="color:var(--warn)">' + UI.icon('alert', 13) + ' ' +
          UI.escapeHtml(opt.quality.message || '这张照片本地检查没过') + '</div>' +
        '<div class="ts-note">本地只看清晰度和亮度。这张没过，AI 也看不清，换一张更清楚的再提交。</div>';
      boxD.hidden = true;
      return;
    }

    if (opt.offline) {
      boxT.hidden = false;
      boxT.innerHTML = '<div class="ts-head">' + UI.icon('spark', 13) + ' AI 没连上</div>' +
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
      boxT.innerHTML = '<div class="ts-head">' + UI.icon('alert', 13) + ' 这张里没看出设施问题</div>' +
        '<div class="ts-note">如果确实要报，建议把镜头对准设施本身再拍一张</div>';
      boxD.hidden = true;
      return;
    }

    const label = D.TYPE_LABEL[p.type] || p.type;
    const on = state.type === p.type;
    boxT.hidden = false;
    boxT.innerHTML =
      '<div class="ts-head">' + UI.icon('spark', 13) + ' AI 看这张图，像是这一类</div>' +
      '<div class="ts-chips"><button class="ts-chip" data-sug-type="' + p.type + '">' +
        '<b>' + label + '</b>' + (on ? ' · 已选中' : '') +
      '</button></div>' +
      '<div class="ts-note">认错了直接改上面的类型就行，不用管它</div>';

    const btn = boxT.querySelector('[data-sug-type]');
    if (btn) {
      btn.addEventListener('click', function () {
        state.type = btn.dataset.sugType;
        renderTypes();
        renderReportState();
        renderSuggest();
        toast('已换成「' + label + '」', 'ok');
      });
    }

    if (p.desc) {
      boxD.hidden = false;
      boxD.innerHTML =
        '<span class="ds-ic">' + UI.icon('spark', 14) + '</span>' +
        '<div class="ds-main"><div class="ds-k">你可能想上报</div>' +
        '<div class="ds-t">' + UI.escapeHtml(p.desc) + '</div></div>' +
        '<span class="ds-use">填入</span>';
      boxD.onclick = function () { applySuggestedDesc(p.desc); };
    } else {
      boxD.hidden = true;
    }
  }

  function applySuggestedDesc(text) {
    const cur = (state.desc || '').trim();
    state.desc = (cur ? (cur.indexOf(text) >= 0 ? cur : cur + '；' + text) : text).slice(0, 100);
    $('#descInput').value = state.desc;
    $('#descCount').textContent = state.desc.length;
    renderReportState();
    toast('已填入描述，可以再改', 'ok');
  }

  function photoRequired() {
    return window.Domain && Domain.photoRequired ? Domain.photoRequired(state.type) : true;
  }

  function descTooShort() {
    return (state.desc || '').trim().length < 4;
  }

  function canSubmit() {
    if (!state.type || !state.located) return false;
    if (photoRequired() && !state.photo) return false;
    if (!state.photo && descTooShort()) return false;
    return true;
  }

  function renderReportState() {
    $('#photoState').textContent = state.photo
      ? (PHOTOS.filter((x) => x.kind === state.photo)[0] || { cap: '本地图片' }).cap
      : (photoRequired() ? '未选择' : '可不上传');
    $('#photoState').className = 'tag ' + (state.photo ? 'tag--ok' : 'tag--soft');

    const photoSub = $('#photoSub');
    if (photoSub) {
      photoSub.textContent = photoRequired()
        ? '这一类需要一张现场照片，后勤才能直接派人'
        : '这一类可以不传照片；有图会更快解决，也能少一次电话确认';
    }
    const photoTip = $('#photoTip');
    if (photoTip) {
      photoTip.textContent = state.photo
        ? ''
        : (photoRequired()
            ? '没有图，工单只能按文字派单，班组往往要先跑一趟确认位置'
            : '上传图片能够更快解决问题：后勤看到现场，就不用先打电话问你在哪');
    }

    const deptTag = $('#deptTag');
    if (state.type) {
      const dept = Domain.deptFor(state.type);
      deptTag.hidden = false;
      deptTag.textContent = dept.short;
    } else {
      deptTag.hidden = true;
    }

    $('#locState').textContent = state.located ? '已定位' : '未定位';
    $('#locState').className = 'tag ' + (state.located ? 'tag--ok' : 'tag--soft');
    if (state.lng) {
      $('#coordLine').textContent = state.lat.toFixed(5) + ', ' + state.lng.toFixed(5) +
        ' · 展示时模糊到约 100 米';
    }

    const miss = [];
    if (!state.type) miss.push('类型');
    if (!state.located) miss.push('位置');
    if (photoRequired() && !state.photo) miss.push('照片');
    if (!state.photo && descTooShort()) miss.push('一句描述');

    const g = window.Guard ? Guard.remain() : null;
    let hint;
    if (g && g.coolLeft > 0) {
      hint = '连续几次没识别通过，先歇 ' + Math.ceil(g.coolLeft / 60) + ' 分钟再报';
    } else if (miss.length) {
      hint = '还需要：' + miss.join('、');
    } else {
      hint = '齐了，可以提交';
    }
    $('#submitHint').textContent = hint;
    $('#btnSubmit').setAttribute('aria-disabled', canSubmit() ? 'false' : 'true');

    renderPtPreview();
  }

  /**
   * 右栏的积分预估。
   * 手机端是一条横向档位条，桌面这栏窄，改成三行文字更省地方：
   * 这一单大概多少、按什么算、什么时候到账。
   */
  function renderPtPreview() {
    const box = $('#ptPreview');
    if (!box) return;
    if (!window.Payout || !state.type) {
      box.innerHTML = '选好类型后，这里会算出这一单值多少积分';
      return;
    }
    const pts = Payout.estimate({ severity: 3, type: state.type, kind: 'solo' });
    const hot = Payout.estimate({ severity: 5, type: state.type, kind: 'solo' });
    box.innerHTML =
      '这一单约 <b>' + pts + '</b> 积分（3 星基准），最急的情况 <b>' + hot + '</b> 分。' +
      '<br>AI 认了不算，后勤到场核实并办结后才到账。';
  }

  function pickLocation(lng, lat, name) {
    state.lng = lng;
    state.lat = lat;
    state.located = true;
    state.addr = name || distanceText(lng, lat) + '附近';
    $('#addrInput').value = state.addr;
    renderReportState();
  }

  /** 在地图上选点：临时把主地图切到选点模式，选完自动恢复 */
  function enterPickMode() {
    go('map');
    toast('在地图上点一下，就是上报位置');
    $('#mapTip').textContent = '选点模式 · 点一下确认位置，Esc 取消';

    const holder = $('#mapHolder');
    holder.classList.add('is-picking');

    function done(lng, lat) {
      holder.classList.remove('is-picking');
      holder.removeEventListener('picked', onPicked);
      document.removeEventListener('keydown', onEsc);
      $('#mapTip').textContent = '点任意标记看详情 · 拖拽平移 · 滚轮缩放';
      pickLocation(lng, lat);
      go('report');
      toast('位置已更新', 'ok');
    }
    function onPicked(e) { done(e.detail.lng, e.detail.lat); }
    function onEsc(e) {
      if (e.key !== 'Escape') return;
      holder.classList.remove('is-picking');
      holder.removeEventListener('picked', onPicked);
      document.removeEventListener('keydown', onEsc);
      $('#mapTip').textContent = '点任意标记看详情 · 拖拽平移 · 滚轮缩放';
      go('report');
    }
    holder.addEventListener('picked', onPicked);
    document.addEventListener('keydown', onEsc);
  }

  function getAgent() {
    if (!agent) {
      agent = SentinelAgent.create({ mode: 'auto' });
      agent.probe().then(function (st) {
        const badge = $('#aiMode');
        if (badge) {
          badge.textContent = st.mode === 'deepseek' ? 'DeepSeek' : 'AI 未连接';
          badge.dataset.mode = st.mode;
        }
      });
    }
    return agent;
  }

  function setSteps(steps) {
    $('#aiSteps').innerHTML = steps.map(function (s) {
      return '<div class="ai-step' + (s.cls ? ' is-' + s.cls : '') + '">' +
               '<span class="bullet"></span><span>' + s.text + '</span></div>';
    }).join('');
  }

  async function submit() {
    if (!canSubmit()) {
      const miss = [];
      if (!state.type) miss.push('类型');
      if (!state.located) miss.push('位置');
      if (photoRequired() && !state.photo) miss.push('照片');
      if (!state.photo && descTooShort()) miss.push('一句描述');
      toast('还差：' + miss.join('、'));
      return;
    }

    /* 照片指纹：判"同一张图反复用"。
       只给真传的图算 —— 示意图是所有人共用的素材，算出来必然一样，
       拿它去拦人等于把演示路径堵死。算不出就跳过，不因为技术原因挡人。 */
    let photoHash = null;
    if (window.Guard && Guard.hashImage && state.photo
        && state.photo.indexOf('data:') === 0) {
      photoHash = await Guard.hashImage(state.photo);
    }

    /* 防刷：和手机端共用 Guard，同一台设备两边一起算额度 */
    if (window.Guard) {
      const g = Guard.check({
        type: state.type, lng: state.lng, lat: state.lat, photoHash: photoHash
      });
      if (!g.ok) { toast(g.message, 'warn'); renderReportState(); return; }
    }

    const btn = $('#btnSubmit');
    btn.setAttribute('aria-disabled', 'true');

    const ag = getAgent();
    const st = ag.status();
    const t0 = Date.now();

    // 样例图先栅格化，模型才看得到画面；本地图片本来就是位图
    let agentImage = '';
    let isDemoPhoto = false;
    if (state.photo) {
      if (state.photo.indexOf('data:') === 0) {
        agentImage = state.photo;
      } else {
        agentImage = (await svgToPng(D.photoSVG(state.photo), 720)) || D.photoDataURI(state.photo);
        isDemoPhoto = true;
      }
    }

    const steps = [
      { text: '检查照片清晰度与曝光', cls: 'run' },
      { text: '看图确认问题类型与描述', cls: '' },
      { text: '生成严重度与处置建议' },
      { text: '匹配责任部门与合并判断' }
    ];
    setSteps(steps);

    const timer = setInterval(function () {
      const run = steps.findIndex((s) => s.cls === 'run');
      if (run < 0) return;
      steps[run].cls = 'done';
      if (steps[run + 1]) steps[run + 1].cls = 'run';
      setSteps(steps);
    }, st.mode === 'deepseek' ? 520 : 300);

    const v = await ag.judge({
      image: agentImage,
      demo: isDemoPhoto,
      type: state.type,
      desc: state.desc,
      address: state.addr,
      lng: state.lng,
      lat: state.lat
    });

    const minWait = st.mode === 'deepseek' ? 900 : 0;
    const rest = minWait - (Date.now() - t0);
    if (rest > 0) await sleep(rest);
    clearInterval(timer);
    steps.forEach(function (s) { s.cls = 'done'; });
    setSteps(steps);

    /* AI 没连上：这条不落库，表单留着。没有降级、没有模板摘要。 */
    if (v.stage === 'ai') {
      btn.setAttribute('aria-disabled', 'false');
      showAiDown(v);
      return;
    }

    /* 本地画质没过：重拍，不算一次 AI 驳回。 */
    if (v.stage === 'local') {
      btn.setAttribute('aria-disabled', 'false');
      showReject(v);
      return;
    }

    if (!v.pass) {
      if (window.Guard) Guard.noteReject();
      btn.setAttribute('aria-disabled', 'false');
      showReject(v);
      return;
    }
    if (window.Guard) Guard.notePass();

    /* 类型点错：静默改成 AI 认出来的那一类。
       用户点错按钮很常见，为此驳回一次等于让他重填整表。 */
    let typeFrom = null;
    if (v.type && v.type !== state.type) {
      typeFrom = state.type;
      state.type = v.type;
      renderTypes();
      renderReportState();
    }

    /* 图文矛盾：这才是需要用户点头的情况，按图片整理一版让他确认 */
    let conflictAction = '';
    if (v.conflict) {
      const act = await askConflict(v, typeFrom || state.type);
      if (act === 'cancel') { btn.setAttribute('aria-disabled', 'false'); return; }
      if (act === 'apply') {
        state.type = v.type || state.type;
        state.desc = (v.suggestDesc || '').slice(0, 100);
        $('#descInput').value = state.desc;
        $('#descCount').textContent = state.desc.length;
        renderTypes();
        renderReportState();
        conflictAction = 'applied';
      } else {
        conflictAction = 'kept';
      }
    }

    const merge = checkMerge();
    const severity = (merge.merged && merge.severityAfter > v.severity) ? merge.severityAfter : v.severity;
    const dept = Domain.deptFor(state.type);
    const s = A.get();

    // 积分：提交时就把这一单值多少算好存进工单，办结时按这个数发。
    // 不等办结再算——规则调价不该回头改已经报上去的单子，
    // 否则用户看到的「预计 +65」和到账数字会对不上。
    const kind = merge.merged ? (merge.kind === 'crowd' ? 'crowd' : 'self') : 'solo';
    const estPoints = window.Payout
      ? Payout.estimate({ severity: severity, type: state.type, kind: kind })
      : 0;

    const ticket = A.registerTicket({
      type: state.type,
      addr: state.addr,
      lng: state.lng,
      lat: state.lat,
      dept: dept.name,
      severity: severity,
      // 和手机端同一个坑：不在这里写状态，落盘就是 pending，复核队列里查不到
      status: v.review ? 'review' : 'pending',
      merged: !!merge.merged,
      reporters: merge.reporters || 1,
      kind: kind,
      estPoints: estPoints,
      ownerId: s ? s.id : A.deviceId(),
      ownerKind: s ? s.kind : 'guest',
      // 这三项以前网页版根本没存，后台现场模式看到的就是一张没图的空单
      photo: (state.photo && state.photo.indexOf('data:') === 0) ? state.photo : null,
      desc: state.desc || '',
      analysis: {
        pass: true,
        stage: v.stage || 'ai',
        source: v.source || 'deepseek',
        reason: null,
        summary: v.summary || '',
        advice: v.advice || '',
        soft: !!v.qualityHint,
        qualityHint: v.qualityHint || null,
        review: !!v.review,
        reviewWhy: v.reviewWhy || '',
        seen: v.seen || '',
        sawImage: !!v.sawImage,
        metrics: v.metrics || null,
        severity: severity,
        latency: v.latency || 0,
        typeAdjusted: !!(v.typeAdjusted || typeFrom),
        typeFrom: typeFrom || v.typeFrom || null,
        typeTo: state.type,
        conflict: !!v.conflict,
        conflictAction: conflictAction || '',
        conflictNote: v.conflictNote || '',
        noPhoto: !state.photo
      }
    });

    // 这一步只结信用与权重，积分要等后勤办结（见 payout.js）
    const reward = A.rewardValid({
      merged: !!merge.merged,
      crowd: merge.kind === 'crowd',
      estPoints: estPoints
    });
    state.tickets.unshift({
      code: ticket.code,
      type: state.type,
      addr: state.addr,
      status: (v.review ? 'review' : 'pending'),
      at: Date.now(),
      photo: state.photo,
      severity: severity,
      estPoints: estPoints,
      dept: dept.name
    });

    if (window.Guard) {
      Guard.record({
        type: state.type, lng: state.lng, lat: state.lat,
        code: ticket.code, photoHash: photoHash
      });
    }

    showPass(v, merge, ticket, reward, severity);
    // 下次回到上报页再清，结果页还要用这份数据
    state.formStale = true;
    renderMe();
    renderReportState();
    btn.setAttribute('aria-disabled', 'false');
  }

  /**
   * 图文矛盾确认（桌面弹窗）。
   * 只在一个时候弹：描述和照片说的是两件事。类型点错不弹，AI 自己改完就行。
   */
  function askConflict(v, origType) {
    return new Promise(function (resolve) {
      const host = $('#cfm');
      const body = $('#cfmBody');
      const fromType = D.TYPE_LABEL[origType || state.type] || '未选择';
      const toType = D.TYPE_LABEL[v.type] || fromType;

      body.innerHTML =
        '<div class="cfm-lead">照片和你写的内容对不上，以照片为准整理了一版，确认一下再提交。</div>' +
        '<div class="cfm-cols">' +
          '<div class="cfm-col"><div class="cfm-k">你填的</div>' +
            '<div class="cfm-type">' + UI.escapeHtml(fromType) + '</div>' +
            '<div class="cfm-desc">' + UI.escapeHtml((state.desc || '').trim() || '（没有描述）') + '</div></div>' +
          '<div class="cfm-col is-ai"><div class="cfm-k">照片里是</div>' +
            '<div class="cfm-type">' + UI.escapeHtml(toType) + '</div>' +
            '<div class="cfm-desc">' + UI.escapeHtml(v.suggestDesc || '') + '</div></div>' +
        '</div>' +
        (v.conflictNote ? '<div class="cfm-why">' + UI.escapeHtml(v.conflictNote) + '</div>' : '') +
        '<div class="cfm-acts">' +
          '<button class="btn btn--ghost" data-cfm="keep">保留我写的</button>' +
          '<button class="btn btn--primary" data-cfm="apply">按这版提交</button>' +
        '</div>' +
        '<button class="cfm-cancel" data-cfm="cancel">先不报，我改一下</button>';

      host.hidden = false;

      function done(act) {
        host.hidden = true;
        host.removeEventListener('click', onClick);
        document.removeEventListener('keydown', onKey);
        resolve(act);
      }
      function onClick(e) {
        const b = e.target.closest('[data-cfm]');
        if (b) { done(b.dataset.cfm); return; }
        if (e.target === host) done('cancel');
      }
      function onKey(e) { if (e.key === 'Escape') done('cancel'); }

      host.addEventListener('click', onClick);
      document.addEventListener('keydown', onKey);
    });
  }

  function checkMerge() {
    if (!state.lng || !state.type) return { merged: false, reporters: 1, kind: null };
    const near = D.findNearby(state.lng, state.lat, state.type, D.POINTS);
    if (!near.length) return { merged: false, reporters: 1, kind: null };

    const best = near[0];
    const dist = window.TileMap.distance(state.lng, state.lat, best.lng, best.lat);
    const reporters = (best.merged || 0) + 1;
    const before = best.severity || Domain.type(state.type).base || 2;
    // 同一台设备/同一账号重复报，不给抬票
    const self = state.votedIds && state.votedIds.indexOf(best.id) >= 0;
    state.votedIds = state.votedIds || [];
    state.votedIds.push(best.id);
    const after = self ? before : Math.min(5, before + Math.min(2, reporters - 1));

    return {
      merged: true,
      kind: self ? 'self' : 'crowd',
      distance: Math.max(1, Math.round(dist)),
      reporters: reporters,
      severityBefore: before,
      severityAfter: after
    };
  }

  function showResult(html) {
    const host = $('#resultHost');
    host.hidden = false;
    host.innerHTML = html;
    $('#reportGrid').hidden = true;
    host.scrollTop = 0;
  }

  function hideResult() {
    const host = $('#resultHost');
    host.hidden = true;
    host.innerHTML = '';
    $('#reportGrid').hidden = false;
  }

  function showPass(v, merge, ticket, reward, severity) {
    const dept = Domain.deptFor(state.type);
    const pri = Domain.priorityOf(severity);

    // 把「为什么是这么多分」拆开讲，别只甩一个数字
    const kind = merge.merged ? (merge.kind === 'crowd' ? 'crowd' : 'self') : 'solo';
    const bd = window.Payout
      ? Payout.breakdown({ severity: severity, type: state.type, kind: kind })
      : null;
    const pts = reward && reward.estPoints ? reward.estPoints : (bd ? bd.points : 0);

    showResult(
      '<div class="result-hero">' +
        '<div class="tick"><svg viewBox="0 0 32 32"><path d="M8 16.6l5.4 5.4L24 11.2"/></svg></div>' +
        '<div>' +
          '<div class="rh-t">已经收到</div>' +
          '<div class="rh-s">' + UI.escapeHtml(v.summary || '谢谢你替这条街多看一眼') + '</div>' +
        '</div>' +
      '</div>' +

      '<div class="code-big">' +
        '<div>' +
          '<div class="cb-k">查询编码</div>' +
          '<div class="cb-v">' + ticket.code + '</div>' +
          '<div class="cb-n">凭这串编码在任何设备上都能查进度，不需要登录</div>' +
        '</div>' +
        '<button class="cb-copy" data-copy="' + ticket.code + '">复制编码</button>' +
      '</div>' +

      '<div class="result-body">' +
        '<div class="card">' +
          '<div class="card-t">工单信息</div>' +
          '<dl class="kv" style="margin-top:10px">' +
            '<dt>类型</dt><dd>' + D.TYPE_LABEL[state.type] + '</dd>' +
            '<dt>位置</dt><dd>' + UI.escapeHtml(state.addr) + '</dd>' +
            '<dt>责任部门</dt><dd>' + UI.escapeHtml(dept.name) + '</dd>' +
            '<dt>紧急度</dt><dd>' + stars(severity) + '</dd>' +
            '<dt>优先级</dt><dd><span class="tag" style="color:' + pri.color + ';background:' + pri.color + '14">' +
              pri.id + ' · ' + pri.label + '</span></dd>' +
          '</dl>' +
        '</div>' +
        '<div class="card">' +
          '<div class="card-t">这次结算</div>' +
          '<div class="chips">' +
            '<span class="chip-ok">信用 +' + reward.creditGain + '</span>' +
            '<span class="chip-pt">待发放 +' + pts + ' 积分</span>' +
          '</div>' +
          '<div class="ctx-note">' +
            '<b>积分不在这里发。</b>要等后勤到场核实、并且真的处理完成之后才到账 —— ' +
            'AI 认了只代表这张单可以开，不代表现场真有东西可修。' +
            (bd ? '<br>本单：' + bd.severity + ' 星 ' + bd.base + ' 分' +
              (bd.typeW !== 1 ? ' × ' + bd.typeW : '') +
              (bd.kindW !== 1 ? ' × ' + bd.kindW + '（' + bd.kindText + '）' : '') +
              '，合计 <b>' + bd.points + '</b> 分。' : '') +
          '</div>' +
          '<div class="ctx-note">' +
            (v.review
              ? (v.reviewWhy === 'no-vision'
                  ? '<b>这张照片没有被 AI 识别内容。</b>图片尺寸或格式没能送进视觉模型，' +
                    '画面内容没有被识别，所以这条会先进人工复核。<br>'
                  : '<b>这张单会先过人工复核。</b>管理员确认现场后照常派单，' +
                    '不扣信用分，处理完积分照发。<br>')
              : '') +
            (merge.merged
              ? (merge.kind === 'crowd'
                  ? '这个位置 ' + merge.distance + ' 米内已有 <b>' + (merge.reporters - 1) + ' 人</b>报过，' +
                    '已并入同一张工单' +
                    (merge.severityAfter > merge.severityBefore
                      ? '，紧急度从 <b>' + merge.severityBefore + ' 星</b>抬到 <b>' + merge.severityAfter + ' 星</b>'
                      : '，紧急度已在最高档')
                  : '你之前报过这处，这次并入原工单，不重复开单，也不影响紧急度')
              : (v.advice
                  ? 'AI 建议：' + UI.escapeHtml(v.advice)
                  : '已进入待派单池，按类型自动分派（模型没有给出处置建议）')) +
          '</div>' +
        '</div>' +
      '</div>' +

      '<div class="result-acts">' +
        '<button class="btn btn--ghost" id="resNew">再报一个</button>' +
        '<button class="btn btn--primary" id="resQuery">查看这张工单的进度</button>' +
      '</div>'
    );

    bindCopy($('[data-copy]'));
    $('#resNew').addEventListener('click', resetForm);
    $('#resQuery').addEventListener('click', function () {
      $('#queryInput').value = ticket.code;
      go('query');
    });
    toast('已提交 · 编码 ' + ticket.code, 'ok');
  }

  /**
   * AI 没连上 / 调用失败：不落库、不降级、不编摘要。
   * 表单原样保留，连上之后点重试即可。
   */
  function showAiDown(v) {
    showResult(
      '<div class="result-hero is-warn">' +
        '<div class="tick">' +
          '<svg viewBox="0 0 32 32"><path d="M16 9v9"/><path d="M16 23.2v.2"/></svg>' +
        '</div>' +
        '<div>' +
          '<div class="rh-t">AI 没连上，这条还没有提交</div>' +
          '<div class="rh-s">不是你的问题，网络或本地 AI 服务断了</div>' +
        '</div>' +
      '</div>' +

      '<div class="result-body">' +
        '<div class="card">' +
          '<div class="card-t">当前状态</div>' +
          '<div class="chips"><span class="chip-pt">未分析 · 未提交</span></div>' +
          '<div class="ctx-note">照片和描述都还在。连上 AI 之后点重试就行。' +
            '系统不会用模板编一段分析糊弄你 —— 没看过图，就说没看过。' +
            (v.detail ? '<br><span style="opacity:.7">' + UI.escapeHtml(v.detail) + '</span>' : '') +
          '</div>' +
        '</div>' +
      '</div>' +

      '<div class="result-acts">' +
        '<button class="btn btn--ghost" id="resBack">回去改一下</button>' +
        '<button class="btn btn--primary" id="resAiRetry">重试</button>' +
      '</div>'
    );

    $('#resBack').addEventListener('click', function () { hideResult(); });
    $('#resAiRetry').addEventListener('click', function () {
      $('#resAiRetry').disabled = true;
      $('#resAiRetry').textContent = '正在重试…';
      hideResult();
      submit();
    });
  }

  function showReject(v) {
    state.lastReject = v;
    const reason = {
      blank: '画面里没有可辨识的内容',
      blackout: '照片几乎全黑',
      blur: '画面不够清晰',
      dark: '照片太暗',
      overexposed: '照片过曝',
      flat: '疑似截图或纯色图',
      unreadable: '图片读不出来',
      'non-facility': '没识别到公共设施',
      'no-info': '没有照片，描述也太短'
    }[v.reason] || '信息不足';

    showResult(
      '<div class="result-hero is-warn">' +
        '<div class="tick">' +
          '<svg viewBox="0 0 32 32"><path d="M16 9v9"/><path d="M16 23.2v.2"/></svg>' +
        '</div>' +
        '<div>' +
          '<div class="rh-t">' + UI.escapeHtml(v.message || '这张照片先等等') + '</div>' +
          '<div class="rh-s">' + UI.escapeHtml(v.detail || '') + '</div>' +
        '</div>' +
      '</div>' +

      '<div class="result-body">' +
        '<div class="card">' +
          '<div class="card-pic" style="border-radius:12px;overflow:hidden;background:#EDF4F3">' +
            photoHTML(state.photo) +
          '</div>' +
        '</div>' +
        '<div class="card">' +
          '<div class="card-t">为什么没过</div>' +
          '<div class="chips"><span class="chip-pt">' + reason + '</span></div>' +
          '<div class="ctx-note">' +
            (v.stage === 'local'
              ? '本地画质检查没过，这张没有送去 AI。换一张更清楚的就行 —— 不用改描述，也不用重新定位。'
              : '这次不算你的错，AI 只是想让工单更准。换一张通常就能过；' +
                '如果你确信信息没问题，也可以直接转人工复核。') +
          '</div>' +
        '</div>' +
      '</div>' +

      '<div class="result-acts">' +
        '<button class="btn btn--ghost" id="resRetry">换一张照片</button>' +
        (v.stage === 'local'
          ? '<button class="btn btn--primary" id="resBack">回去改描述</button>'
          : '<button class="btn btn--primary" id="resForce">仍然提交，转人工复核</button>') +
      '</div>'
    );

    $('#resRetry').addEventListener('click', function () {
      state.photo = null;
      renderShots();
      renderReportState();
      hideResult();
    });

    const back = $('#resBack');
    if (back) back.addEventListener('click', function () { hideResult(); });

    const force = $('#resForce');
    if (force) force.addEventListener('click', async function () {
      const s = A.get();
      const dept = Domain.deptFor(state.type);
      const sev = v.severity || 2;
      const estPts = window.Payout
        ? Payout.estimate({ severity: sev, type: state.type, kind: 'review' })
        : 0;
      const tk = A.registerTicket({
        type: state.type, addr: state.addr, lng: state.lng, lat: state.lat,
        dept: dept.name, severity: sev, merged: false, reporters: 1,
        kind: 'review', estPoints: estPts,
        ownerId: s ? s.id : A.deviceId(), ownerKind: s ? s.kind : 'guest',
        // 复核要看原图和原话，否则"转人工"等于把单子丢进黑箱
        photo: (state.photo && state.photo.indexOf('data:') === 0) ? state.photo : null,
        desc: state.desc || '',
        analysis: {
          pass: false,
          source: v.source || 'rules',
          reason: v.reason || null,
          message: v.message || '',
          detail: v.detail || '',
          seen: v.seen || '',
          sawImage: !!v.sawImage,
          metrics: v.metrics || null,
          review: true,
          manual: true,
          noPhoto: !state.photo
        }
      });
      A.advanceTicket(tk.code, 'review', 'AI 未通过，用户选择转人工复核');

      if (window.Guard) {
        // 转人工也要落指纹，否则"AI 拦下 → 转人工"就成了绕开同图判重的口子
        let fh = null;
        if (Guard.hashImage && state.photo && state.photo.indexOf('data:') === 0) {
          fh = await Guard.hashImage(state.photo);
        }
        Guard.record({
          type: state.type, lng: state.lng, lat: state.lat,
          code: tk.code, photoHash: fh
        });
      }

      state.tickets.unshift({
        code: tk.code, type: state.type, addr: state.addr, status: 'review',
        at: Date.now(), photo: state.photo, severity: sev, estPoints: estPts, dept: dept.name
      });
      toast('已转人工复核 · ' + tk.code, 'ok');
      state.formStale = true;
      go('tickets');
    });
  }

  function bindCopy(btn) {
    if (!btn) return;
    btn.addEventListener('click', function () {
      const text = btn.dataset.copy;
      const done = function () {
        btn.textContent = '已复制';
        setTimeout(function () { btn.textContent = '复制编码'; }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { toast('复制失败，手动选中复制'); });
      } else {
        toast('编码：' + text);
      }
    });
  }

  function resetForm() {
    state.photo = null;
    state.type = '';
    state.desc = '';
    state.preview = null;
    state.photoGate = null;
    $('#descInput').value = '';
    $('#descCount').textContent = '0';
    hideResult();
    renderShots();
    renderTypes();
    renderSuggest();
    renderReportState();
    setSteps([
      { text: '检查照片清晰度与曝光' },
      { text: '看图确认问题类型与描述' },
      { text: '生成严重度与处置建议' },
      { text: '匹配责任部门与合并判断' }
    ]);
    go('report');
  }

  /* ============================================================
     工单列表
     ============================================================ */

  function allTickets() {
    const fromAuth = A.myTickets().map(function (t) {
      return {
        code: t.code, type: t.type, addr: t.addr, status: t.status,
        at: t.at, severity: t.severity, dept: t.dept,
        photo: t.photo || PHOTO_BY_TYPE[t.type] || 'trash'
      };
    });
    const seen = {};
    return state.tickets.concat(fromAuth).filter(function (t) {
      if (seen[t.code]) return false;
      seen[t.code] = 1;
      return true;
    }).sort(function (a, b) { return b.at - a.at; });
  }

  /* ============================================================
     积分乐园（桌面版）
     ------------------------------------------------------------
     和手机端共用 shared/rewards.js，奖池和货架只有一份定义。
     桌面屏宽，列表横过来排：一行一件，价格和状态一眼能扫。
     ============================================================ */

  function renderRewards() {
    const R = window.Rewards;
    if (!R) { $('#rwBody').innerHTML = '<div class="empty">积分模块没加载</div>'; return; }

    const pts = R.points();
    $('#rwSub').textContent = '当前 ' + pts + ' 分 · 抽一次 ' + R.DRAW_COST + ' 分';
    $$('#rwSeg .seg-btn').forEach(function (b) {
      b.classList.toggle('is-on', b.dataset.rw === state.rwTab);
    });

    if (state.rwTab === 'lottery') {
      const total = R.LOTTERY.reduce(function (n, x) { return n + x.weight; }, 0);
      const rows = R.LOTTERY.map(function (it) {
        const pct = Math.round(it.weight / total * 100);
        return '<div class="rw-row">' +
                 '<div class="rw-name">' + UI.escapeHtml(it.name) +
                   (it.rare ? '<span class="rw-tag">限定</span>' : '') + '</div>' +
                 '<div class="rw-desc">' + UI.escapeHtml(it.desc || (it.kind === 'points' ? '直接进积分' : '—')) + '</div>' +
                 '<div class="rw-pct">' + pct + '%</div>' +
               '</div>';
      }).join('');

      $('#rwBody').innerHTML =
        '<div class="rw-hero">' +
          '<div>' +
            '<div class="rw-hero-t">花 ' + R.DRAW_COST + ' 分抽一次</div>' +
            '<div class="rw-hero-s">奖池里没有商城在卖的东西——抽到的都是买不着的</div>' +
          '</div>' +
          '<button class="btn btn--primary" id="btnDraw"' + (pts < R.DRAW_COST ? ' disabled' : '') + '>' +
            '抽一次</button>' +
        '</div>' +
        '<div class="rw-rows">' + rows + '</div>' +
        '<div class="rw-last" id="rwLast"></div>';

      const btn = $('#btnDraw');
      if (btn) btn.addEventListener('click', function () {
        const r = R.draw();
        if (!r.ok) { toast(r.reason, 'warn'); return; }
        renderRewards();
        renderMe();
        const last = $('#rwLast');
        if (last) last.innerHTML = '抽到：<b>' + UI.escapeHtml(r.prize.name) + '</b>　当前 ' + r.points + ' 分';
        toast('抽到「' + r.prize.name + '」', 'ok');
      });
      return;
    }

    const st = R.get();
    const kindLabel = { frame: '头像框', title: '称号' };
    const groups = {};
    R.MALL.forEach(function (it) { (groups[it.kind] || (groups[it.kind] = [])).push(it); });

    $('#rwBody').innerHTML = Object.keys(groups).map(function (kind) {
      return '<div class="rw-group">' +
               '<div class="rw-group-h">' + (kindLabel[kind] || kind) + '</div>' +
               groups[kind].map(function (it) {
                 const owned = st.owned.indexOf(it.id) >= 0;
                 const on = st.frame === it.id || st.title === it.id;
                 const can = pts >= it.cost;
                 return '<div class="rw-row">' +
                          '<div class="rw-name">' + UI.escapeHtml(it.name) + '</div>' +
                          '<div class="rw-desc">' + UI.escapeHtml(it.desc || '') + '</div>' +
                          '<div class="rw-cost">' + it.cost + ' 分</div>' +
                          '<button class="btn btn--sm' + (owned ? ' btn--ghost' : can ? ' btn--primary' : '') + '"' +
                            ' data-buy="' + it.id + '"' + (!owned && !can ? ' disabled' : '') + '>' +
                            (owned ? (on ? '已佩戴' : '佩戴') : '兑换') + '</button>' +
                        '</div>';
               }).join('') +
             '</div>';
    }).join('');

    $$('[data-buy]').forEach(function (b) {
      b.addEventListener('click', function () {
        const id = b.dataset.buy;
        const item = R.findItem(id);
        if (!item) return;
        if (R.owns(id)) {
          if (R.equip(id)) { renderRewards(); toast('已换上「' + item.name + '」', 'ok'); }
          return;
        }
        const res = R.buy(id);
        if (!res.ok) { toast(res.reason, 'warn'); return; }
        renderRewards();
        renderMe();
        toast('已入手「' + item.name + '」', 'ok');
      });
    });
  }

  /* ---------------- 变动记录 ---------------- */

  function renderLedger() {
    const L = window.Ledger;
    const box = $('#meLedger');
    if (!box) return;
    if (!L) { box.innerHTML = '<div class="card-s">流水模块没加载</div>'; return; }

    const kind = state.lgKind || 'points';
    const items = L.list(kind).slice(0, 12);
    box.innerHTML = items.length
      ? items.map(function (e) {
          const up = e.d > 0;
          return '<div class="lg-row">' +
                   '<div class="lg-main">' +
                     '<div class="lg-why">' + UI.escapeHtml(e.why || '变动') + '</div>' +
                     '<div class="lg-time">' + fmtTime(e.at) +
                       (e.after != null ? ' · 余 ' + e.after : '') + '</div>' +
                   '</div>' +
                   '<div class="lg-d ' + (up ? 'is-up' : 'is-down') + '">' +
                     (up ? '+' : '') + e.d + '</div>' +
                 '</div>';
        }).join('')
      : '<div class="card-s">还没有记录。有效上报会加信用分，后勤办结才加积分。</div>';
  }

  function renderTickets() {
    const list = allTickets().filter(function (t) {
      return state.tstatus === 'all' || t.status === state.tstatus;
    });

    $('#ticketsSub').textContent = '共 ' + allTickets().length + ' 条' +
      (list.length !== allTickets().length ? ' · 当前筛选 ' + list.length + ' 条' : '');

    if (!list.length) {
      $('#ticketList').innerHTML =
        '<div class="empty">还没有工单。<br>去「上报」拍一张，或者用别人给你的编码去「查进度」。</div>';
      return;
    }

    $('#ticketList').innerHTML = list.map(function (t) {
      const st = STATUS_UI[t.status] || STATUS_UI.pending;
      return '<div class="trow" data-code="' + t.code + '">' +
               '<div class="thumb">' + photoHTML(t.photo || 'trash') + '</div>' +
               '<div class="tmain">' +
                 '<div class="t1">' +
                   '<span class="ttype">' + (D.TYPE_LABEL[t.type] || t.type) + '</span>' +
                   '<span class="tstatus" style="color:' + st.color + '">' + st.label + '</span>' +
                 '</div>' +
                 '<div class="t2">' + UI.escapeHtml(t.addr) + ' · ' + fmtTime(t.at) + '</div>' +
               '</div>' +
               '<span class="tcode">' + t.code + '</span>' +
             '</div>';
    }).join('');

    $$('.trow').forEach(function (row) {
      row.addEventListener('click', function () {
        $('#queryInput').value = row.dataset.code;
        go('query');
      });
    });
  }

  /* ============================================================
     查进度
     ============================================================ */

  function renderQuery(raw) {
    const box = $('#queryResult');
    const code = String(raw || '').trim();
    if (!code) {
      box.innerHTML = '<div class="card"><div class="empty">输入编码就能看到这张工单走到哪一步</div></div>';
      return;
    }

    const t = A.findTicket(code);
    if (!t) {
      box.innerHTML = '<div class="card"><div class="empty">没找到 <b>' +
        UI.escapeHtml(code.toUpperCase()) + '</b><br>编码形如 JW-8F3K2M，注意别把 O 和 0 弄混</div></div>';
      return;
    }

    const st = STATUS_UI[t.status] || STATUS_UI.pending;

    // 积分状态：到账了说已到账，没到就说清楚卡在"等后勤到场"这一步
    const paid = !!(t.reward && t.reward.paid);
    const estPts = paid ? t.reward.points
      : (typeof t.estPoints === 'number' ? t.estPoints
        : (window.Payout ? Payout.estimate(t) : 0));
    const payLine = estPts
      ? (paid
          ? '<b style="color:var(--ok)">+' + estPts + ' 已到账</b>'
          : '<b style="color:var(--warn)">待发放 +' + estPts + '</b>' +
            '<span style="color:var(--text-3)"> · 后勤到场核实并处理完成后到账</span>')
      : '—';

    box.innerHTML =
      '<div class="card qr">' +
        '<div class="qr-hd">' +
          '<div style="flex:1">' +
            '<div class="qr-code">' + t.code + '</div>' +
            '<div class="qr-type">' + (D.TYPE_LABEL[t.type] || t.type) + ' · ' + fmtTime(t.at) + '</div>' +
          '</div>' +
          '<span class="tag" style="color:' + st.color + ';background:' + st.bg + '">' + st.label + '</span>' +
        '</div>' +
        '<dl class="qr-meta">' +
          '<dt>位置</dt><dd>' + UI.escapeHtml(t.addr) + '</dd>' +
          '<dt>负责部门</dt><dd>' + UI.escapeHtml(t.dept || '待分派') + '</dd>' +
          '<dt>紧急度</dt><dd>' + stars(t.severity || 1) + '</dd>' +
          '<dt>反馈人数</dt><dd>' + (t.reporters || 1) + ' 人' + (t.merged ? ' · 已合并' : '') + '</dd>' +
          '<dt>积分</dt><dd>' + payLine + '</dd>' +
        '</dl>' +
        '<div class="tl">' +
          (function () {
            const list = (t.timeline || []).slice().sort(function (a, b) { return a.at - b.at; });
            const ROLE = { user: '上报人', ai: 'AI', crew: '班组', admin: '管理端', system: '系统' };
            if (!list.length) return '<div class="empty" style="padding:14px 0">还没有流转记录</div>';
            return list.map(function (e, i) {
              const gap = i > 0 ? e.at - list[i - 1].at : 0;
              const last = i === list.length - 1;
              return '<div class="tl-row' + (last ? ' is-now' : '') +
                       (e.tone === 'ok' ? ' is-ok' : '') + '">' +
                '<div class="tl-head">' +
                  '<span class="tl-t">' + UI.escapeHtml(e.label) + '</span>' +
                  '<span class="tl-role" data-role="' + (e.role || 'crew') + '">' +
                    (ROLE[e.role] || '处理') + '</span>' +
                '</div>' +
                (e.by ? '<div class="tl-by">' + UI.escapeHtml(e.by) + '</div>' : '') +
                (e.note ? '<div class="tl-note">' + UI.escapeHtml(e.note) + '</div>' : '') +
                '<div class="tl-time">' + fmtTime(e.at) +
                  (gap > 60000 ? '　距上一步 ' + fmtSpan(gap) : '') + '</div>' +
              '</div>';
            }).join('');
          })() +
        '</div>' +
      '</div>';
  }

  /* ============================================================
     我的
     ============================================================ */

  function renderMe() {
    const s = A.get();
    const guest = !s || s.kind === 'guest';

    $('#meAvatar').textContent = guest ? '游' : (s.name || '同').slice(0, 1);
    $('#meName').textContent = guest ? '游客' : s.name;
    $('#meKind').textContent = guest
      ? '未登录 · 数据只存在这台设备'
      : (s.kind === 'school' ? '学号 ' + s.id : A.maskPhone(s.id)) + ' · 已登录';

    const credit = s ? s.credit : 70;
    $('#meCredit').textContent = credit;
    $('#meCreditBar').style.width = credit + '%';
    $('#meTier').textContent = A.tierOf(credit).name;
    $('#mePoints').textContent = s ? (s.points || 0) : 0;
    $('#meWeight').textContent = (s ? (s.weight || 1) : 1).toFixed(2);
    $('#meWeightNote').textContent = A.weightLabel(s ? s.weight : 1) +
      ((s ? s.weight : 1) < 0.6 ? ' · 不计入合并人数' : ' · 合并时计入人数');

    $('#meValid').textContent = s ? (s.validCnt || 0) : 0;
    $('#meResolved').textContent = s ? (s.resolvedCnt || 0) : 0;
    $('#meInvalid').textContent = s ? (s.invalidCnt || 0) : 0;

    const owned = (s && s.badges) || [];
    $('#meBadges').innerHTML = owned.length
      ? D.BADGES.filter((b) => owned.indexOf(b.code) >= 0).map(function (b) {
          return '<div class="badge-cell"><div class="bic" data-icon="' + b.icon + '"></div>' +
                 '<div class="bn">' + b.name + '</div></div>';
        }).join('')
      : '<div class="card-s">还没有徽章，第一次有效上报就能拿到「初次出勤」</div>';
    hydrate($('#meBadges'));
    renderLedger();

    $('#btnIdentity').textContent = guest ? '登录 / 切换账号' : '退出登录';

    // 顶部身份条与左下角头像
    $('#idPillText').textContent = guest ? '游客模式' : (s.kind === 'school' ? '学号 ' + s.id : A.maskPhone(s.id));
    $('#idPill').classList.toggle('is-in', !guest);
    $('#railAvatar').textContent = guest ? '游' : (s.name || '同').slice(0, 1);
  }

  /* ============================================================
     身份闸门
     ============================================================ */

  let sentCode = '';

  function openGate(canClose) {
    $('#gate').hidden = false;
    $('#gClose').hidden = !canClose;
  }
  function closeGate() { $('#gate').hidden = true; }

  function bindGate() {
    $$('[data-gtab]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        $$('[data-gtab]').forEach((b) => b.classList.toggle('is-on', b === btn));
        $$('[data-gpane]').forEach(function (p) {
          p.classList.toggle('is-on', p.dataset.gpane === btn.dataset.gtab);
        });
      });
    });

    const schoolInput = $('#gSchoolId');
    schoolInput.addEventListener('input', function () {
      schoolInput.value = schoolInput.value.replace(/\D/g, '');
      const c = A.checkSchoolId(schoolInput.value);
      $('#gSchoolHint').textContent = c.ok
        ? '已识别：' + schoolInput.value.slice(0, 4) + ' 级 · ' + schoolInput.value.slice(-4) + ' 号'
        : '校内统一身份 · 无需密码（演示环境 8–12 位数字即可）';
      $('#gSchoolHint').className = 'gate-hint' + (c.ok ? ' is-ok' : '');
    });

    $('#gSchoolBtn').addEventListener('click', function () {
      const r = A.login({ kind: 'school', id: schoolInput.value });
      if (!r.ok) {
        $('#gSchoolHint').textContent = r.msg;
        $('#gSchoolHint').className = 'gate-hint is-warn';
        return;
      }
      seedIfNew(r.user);
      enter(r.user, '学号 ' + r.user.id.slice(-4) + ' 号');
    });

    $('#gSend').addEventListener('click', function () {
      const c = A.checkPhone($('#gPhone').value);
      if (!c.ok) {
        $('#gPhoneHint').textContent = c.msg;
        $('#gPhoneHint').className = 'gate-hint is-warn';
        return;
      }
      sentCode = String(Math.floor(100000 + Math.random() * 900000));
      $('#gPhoneHint').innerHTML = '验证码已发送，演示码：<b>' + sentCode + '</b>';
      $('#gPhoneHint').className = 'gate-hint is-ok';
      $('#gCode').focus();
    });

    $('#gPhoneBtn').addEventListener('click', function () {
      if (!sentCode) {
        $('#gPhoneHint').textContent = '先点「获取验证码」';
        $('#gPhoneHint').className = 'gate-hint is-warn';
        return;
      }
      if ($('#gCode').value !== sentCode) {
        $('#gPhoneHint').textContent = '验证码不对';
        $('#gPhoneHint').className = 'gate-hint is-warn';
        return;
      }
      const r = A.login({ kind: 'phone', id: $('#gPhone').value, code: $('#gCode').value });
      if (!r.ok) {
        $('#gPhoneHint').textContent = r.msg;
        $('#gPhoneHint').className = 'gate-hint is-warn';
        return;
      }
      seedIfNew(r.user);
      enter(r.user, A.maskPhone(r.user.id));
    });

    $('#gGuestBtn').addEventListener('click', function () {
      A.loginGuest();
      closeGate();
      renderMe();
      renderTickets();
      toast('已进入游客模式 · 提交后会给查询编码');
    });

    $('#gClose').addEventListener('click', closeGate);

    $('#btnIdentity').addEventListener('click', function () {
      if (A.get() && A.get().kind !== 'guest') {
        A.logout();
        renderMe();
        renderTickets();
        toast('已退出登录');
      } else {
        openGate(!!A.get());
      }
    });

    $('#railAvatar').addEventListener('click', function () {
      if (!A.get() || A.get().kind === 'guest') openGate(!!A.get());
      else go('me');
    });
  }

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
      streak: 3,
      badges: (D.USER.badges || []).slice()
    });
  }

  function enter(user, who) {
    closeGate();
    renderMe();
    renderTickets();
    toast('欢迎，' + who, 'ok');
  }

  /* ============================================================
     事件绑定
     ============================================================ */

  function bind() {
    // 积分乐园页签 / 流水页签：只绑一次，内容区每次重渲染
    $$('#rwSeg .seg-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        state.rwTab = b.dataset.rw;
        renderRewards();
      });
    });
    $$('#lgSeg .seg-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        state.lgKind = b.dataset.lg;
        $$('#lgSeg .seg-btn').forEach(function (x) { x.classList.toggle('is-on', x === b); });
        renderLedger();
      });
    });

    $$('.rail-btn').forEach(function (b) {
      b.addEventListener('click', function () { go(b.dataset.view); });
    });

    // 地图图层 / 底图 / 热力 / 定位
    $('#layerSeg').addEventListener('click', function (e) {
      const b = e.target.closest('[data-layer]');
      if (!b) return;
      state.layer = b.dataset.layer;
      $$('[data-layer]').forEach((x) => x.classList.toggle('is-on', x === b));
      renderMarkers();
    });

    $$('[data-base]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.base = b.dataset.base;
        $$('[data-base]').forEach((x) => x.classList.toggle('is-on', x === b));
        if (map) map.setSource(state.base);
      });
    });

    $('#btnHeat').addEventListener('click', function () {
      state.heat = !state.heat;
      $('#btnHeat').classList.toggle('is-on', state.heat);
      renderMarkers();
    });

    $('#btnLocate').addEventListener('click', locate);

    // 上报
    $('#btnPickMap').addEventListener('click', enterPickMode);
    $('#btnSubmit').addEventListener('click', submit);

    $('#addrInput').addEventListener('input', function (e) {
      state.addr = e.target.value;
    });

    $('#descInput').addEventListener('input', function (e) {
      state.desc = e.target.value.slice(0, 100);
      $('#descCount').textContent = state.desc.length;
      // 不传图时靠描述判断能不能提交
      renderReportState();
    });

    // 拖拽照片
    const dz = $('#dropZone');
    const fi = $('#fileInput');
    dz.addEventListener('click', function () { fi.click(); });
    ['dragenter', 'dragover'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('is-over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('is-over'); });
    });
    dz.addEventListener('drop', function (e) {
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) loadFile(f);
    });
    fi.addEventListener('change', function () {
      if (fi.files[0]) loadFile(fi.files[0]);
    });

    function loadFile(file) {
      if (!/^image\//.test(file.type)) { toast('只支持图片文件'); return; }
      const fr = new FileReader();
      fr.onload = function () {
        state.photo = fr.result;
        state.photoLocal = true;
        renderShots();
        renderReportState();
        toast('已载入本地图片 · 只在浏览器里分析');
        runPreview();
      };
      fr.readAsDataURL(file);
    }

    // 工单筛选
    $('#ticketSeg').addEventListener('click', function (e) {
      const b = e.target.closest('[data-tstatus]');
      if (!b) return;
      state.tstatus = b.dataset.tstatus;
      $$('[data-tstatus]').forEach((x) => x.classList.toggle('is-on', x === b));
      renderTickets();
    });

    // 查询
    $('#btnQuery').addEventListener('click', function () {
      renderQuery($('#queryInput').value);
    });
    $('#queryInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') renderQuery($('#queryInput').value);
    });
    $$('[data-fill]').forEach(function (b) {
      b.addEventListener('click', function () {
        $('#queryInput').value = b.dataset.fill;
        renderQuery(b.dataset.fill);
      });
    });

    bindGate();
  }

  /* 定位：桌面浏览器经常拿不到 GPS，失败就引导手选 */
  function locate() {
    const btn = $('#btnLocate');
    if (!navigator.geolocation) {
      toast('这个浏览器不支持定位，用「在图上报点」吧', 'warn');
      return;
    }
    btn.classList.add('is-on');
    toast('正在定位…');

    const done = function (lng, lat) {
      btn.classList.remove('is-on');
      pickLocation(lng, lat);
      if (map) map.flyTo(lng, lat, 17);
      toast('定位成功', 'ok');
    };
    const fail = function (msg) {
      btn.classList.remove('is-on');
      toast(msg + ' · 用「在图上选点」也一样', 'warn');
    };

    const timer = setTimeout(function () { fail('定位超时'); }, 9000);
    navigator.geolocation.getCurrentPosition(
      function (pos) {
        clearTimeout(timer);
        done(pos.coords.longitude, pos.coords.latitude);
      },
      function (err) {
        clearTimeout(timer);
        fail({
          1: '定位权限被拒绝',
          2: '拿不到位置信号',
          3: '定位超时'
        }[err.code] || '定位不可用');
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
    );
  }

  /* ============================================================
     启动
     ============================================================ */

  function boot() {
    hydrate();
    initMap();
    renderShots();
    renderTypes();
    renderSuggest();
    renderReportState();
    renderQuery('');
    renderMe();
    renderTickets();
    bind();

    // 首屏没有身份就挡一层；带 #view=xxx 的直达链接默认以游客进入
    const hash = decodeURIComponent(location.hash.replace(/^#/, ''));
    const m = /view=([a-z]+)/.exec(hash);
    if (!A.get() && !m) openGate(false);
    if (m) {
      if (!A.get()) A.loginGuest();
      go(m[1]);
      if (m[1] === 'map') { /* 地图需要一帧再量 */ }
    }

    // 点空白处清掉选中的点位，回到概览
    $('#ctx').addEventListener('click', function (e) {
      if (e.target === $('#ctx')) renderOverview();
    });
    renderOverview();

    window.addEventListener('resize', function () {
      if (map) map.resize();
    });
  }

  function renderOverview() {
    $('#ctxCard').innerHTML =
      '<div class="ctx-hd">' +
        '<div style="flex:1">' +
          '<div class="ctx-title">今天在校区里</div>' +
          '<div class="ctx-sub">' + D.POINTS.length + ' 个点位 · ' +
            D.POINTS.filter((p) => p.status === 'pending').length + ' 处还没处理</div>' +
        '</div>' +
      '</div>' +
      '<div class="ctx-note" style="margin-top:0">' +
        '点地图上的任意标记，这里会显示这一处的现场照片、责任部门和合并情况。' +
      '</div>' +
      '<dl class="kv" style="margin-top:14px">' +
        '<dt>接入底图</dt><dd>高德瓦片 · WGS-84 已纠偏</dd>' +
        '<dt>智能体</dt><dd id="aiMode">探测中…</dd>' +
        '<dt>合并规则</dt><dd>15 米 / 24 小时 / 同类型</dd>' +
      '</dl>' +
      '<div class="ctx-note">' +
        '<b>不登录也能用</b><br>提交后会生成查询编码，凭编码在任何设备上都能查进度。' +
      '</div>';
    getAgent();
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
