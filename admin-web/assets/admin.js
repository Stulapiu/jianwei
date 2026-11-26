/* ==========================================================================
 * 见微 · 管理后台
 * --------------------------------------------------------------------------
 * 零外部依赖：地图、折线、环形、热力全部自己画。
 * 之前用 ECharts CDN，断网就白屏，单文件离线演示也带不走，索性全换掉。
 *
 * 模块顺序：
 *   1. 数据（含合并规则）
 *   2. 工具
 *   3. 侧边栏与路由
 *   4. 总览：指标 / 热力图 / 排行 / 趋势 / 环形
 *   5. 工单表：筛选 / 排序 / 合并展开 / 状态流转
 *   6. 部门派单
 *   7. AI 决策
 *   8. 导出
 * ========================================================================== */

(function () {
  'use strict';

  var D = window.Domain;
  var TM = window.TileMap;

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  /* ======================================================================
   * 1. 数据
   * ==================================================================== */

  var CAMPUS = TM.CAMPUS;
  var HOUR = 3600000;
  var NOW = Date.now();

  /**
   * 工单种子。
   * 第 5 个字段是「原始上报人」，同一工单多人会有多条记录。
   * 合并规则见 Domain.shouldMerge —— 同人重复不提优先级，多人报同一处每多一人 +1。
   */
  var SEED = [
    // 类型, 位置, 基准紧急度, 摘要, 处置建议, 坐标, 上报人[], 状态, 几小时前
    ['lighting', '图书馆南广场路灯', 3, '路灯连续三晚不亮，晚自习后通行不便',
      '近两周同一路段报修 3 次，建议排查线路老化而非只换灯泡',
      [113.5314, 34.8175], ['李', '王', '张', '陈'], 'pending', 1.2],

    ['safety', '教学区主路井盖缺失', 4, '井盖缺失，只用木板临时遮挡，夜间有跌落风险',
      '存在即时人身风险，建议 2 小时内设置围挡并更换',
      [113.5336, 34.8152], ['王', '刘'], 'pending', 0.8],

    ['sanitation', '菊园食堂东南角', 2, '餐厨垃圾桶满溢，垃圾堆放到人行道',
      '清运频次与人流不匹配，建议调整为每日两次',
      [113.5316, 34.8136], ['刘', '赵', '孙'], 'pending', 2.4],

    ['sanitation', '图书馆南广场', 2, '广场垃圾桶满溢，纸杯散落一地',
      '广场人流量大，建议增设一组分类桶',
      [113.5316, 34.8176], ['李', '王'], 'pending', 3.1],

    ['facility', '图书馆南广场无障碍坡道', 2, '坡道扶手缺失，轮椅通行困难',
      '建议补装扶手并按无障碍标准验收',
      [113.5312, 34.8178], ['赵'], 'pending', 3.6],

    ['lighting', '柳园至食堂小路', 3, '小路三盏路灯不亮，树荫下几乎没有光',
      '同线路多点故障，建议整段排查而非单点更换',
      [113.5290, 34.8155], ['张', '周'], 'pending', 4.8],

    ['road', '教学区主路路面', 3, '路面坑洼积水，雨天溅水严重',
      '建议铣刨重铺该段 20 米，并检查排水坡度',
      [113.5334, 34.8150], ['周'], 'pending', 6.1],

    ['traffic', '教学区主路非机动车占道', 2, '电动车占用盲道停放，行人绕行机动车道',
      '建议增设非机动车停放区并划线管理',
      [113.5338, 34.8156], ['吴'], 'pending', 7.3],

    ['green', '荷园 3 号楼前树枝断裂', 1, '风后树枝断裂悬挂，有掉落风险',
      '建议当日修剪，检查同排树木健康状况',
      [113.5288, 34.8198], ['郑'], 'pending', 8.9],

    ['network', '教学区 B 座弱电箱', 2, '弱电箱门敞开，线路裸露',
      '建议上锁并整理走线',
      [113.5356, 34.8172], ['钱'], 'pending', 10.2],

    ['water', '菊园食堂东侧路面', 3, '路面长期积水，疑似下水堵塞',
      '建议疏通并 CCTV 检测管道，排除结构性破损',
      [113.5317, 34.8135], ['何'], 'pending', 11.5],

    // ---- 处理中 ----
    ['lighting', '图书馆东侧连廊', 3, '连廊第二盏灯不亮',
      '已派电工现场检查，发现镇流器损坏',
      [113.5322, 34.8168], ['吴', '李'], 'processing', 14],

    ['sanitation', '柳园 4 号楼下', 2, '垃圾桶周边地面油污',
      '环卫已完成初步冲洗，需复检',
      [113.5283, 34.8140], ['李'], 'processing', 18],

    ['facility', '人工湖西岸护栏', 3, '护栏一处焊点开裂',
      '维修班组已焊接，待 24 小时后验收',
      [113.5346, 34.8196], ['郑', '冯'], 'processing', 22],

    ['safety', '西门内坡道', 4, '坡道防滑条翘起，雨天易滑倒',
      '已贴临时警示，等待材料到场',
      [113.5266, 34.8168], ['冯'], 'processing', 26],

    ['road', '工科园东侧路', 2, '地砖松动，踩上去有异响',
      '已列入本周道路维护计划',
      [113.5340, 34.8192], ['孙'], 'processing', 30],

    // ---- 已完成 ----
    ['sanitation', '菊园南侧垃圾房', 2, '垃圾房外溢，异味明显',
      '已加密清运并增设除臭装置',
      [113.5321, 34.8122], ['何'], 'resolved', 40],

    ['lighting', '北门内侧主路', 3, '主路北段照明整体偏暗',
      '已加装 4 盏补光灯，照度复测达标',
      [113.5321, 34.8215], ['陈'], 'resolved', 52],

    ['facility', '商学院一层门禁', 2, '门禁读卡器失灵',
      '已更换读卡模块',
      [113.5345, 34.8160], ['张'], 'resolved', 64],

    ['safety', '化学系楼北侧围墙', 4, '围墙裂缝加宽，有倒塌风险',
      '已拆除重建 6 米墙段',
      [113.5375, 34.8192], ['孙'], 'resolved', 76],

    ['water', '教学区 A 座直饮水', 2, '直饮水机出水异常',
      '已更换滤芯并检测水质',
      [113.5350, 34.8168], ['钱'], 'resolved', 88],

    ['traffic', '南门闸机', 2, '闸机识别失败率高',
      '已升级识别算法',
      [113.5311, 34.8102], ['周'], 'resolved', 96],

    ['green', '体育场西侧草坪', 1, '草坪被踩出多条土路',
      '已补种草籽并设置引导围栏',
      [113.5338, 34.8123], ['吴'], 'resolved', 108],

    ['network', '图书馆五层自习区', 2, '无线信号弱，视频课卡顿',
      '已增设 2 个 AP',
      [113.5318, 34.8183], ['李'], 'resolved', 120],

    ['road', '北门停车场出入口', 3, '路面破损形成坑洞',
      '已完成沥青修补',
      [113.5320, 34.8222], ['陈'], 'resolved', 132]
  ];

  var CREDIT = { '李': 92, '王': 88, '张': 96, '陈': 100, '刘': 85, '赵': 90, '孙': 94, '周': 87, '吴': 99, '郑': 91, '冯': 86, '钱': 93, '何': 89 };

  function buildOrders() {
    return SEED.map(function (row, i) {
      var type = row[0];
      var meta = D.type(type);
      var people = row[6];
      var base = row[2];

      // 按合并规则算最终紧急度：首报 base，之后每多一个不同的人 +1
      var severity = D.mergedSeverity(base, people.length);
      var at = NOW - row[8] * HOUR;

      var o = {
        id: 'o' + i,
        orderNo: 'WO26' + String(1101 + i),
        type: type,
        address: row[1],
        baseSeverity: base,
        severity: severity,
        summary: row[3],
        advice: row[4],
        lng: row[5][0],
        lat: row[5][1],
        dept: D.deptFor(type),
        status: row[7],
        createdAt: at,
        reports: people.map(function (name, k) {
          return {
            by: name,
            credit: CREDIT[name] || 90,
            // 同一工单里，第一条是首报，后面的人陆续跟上
            at: at + k * 0.12 * HOUR,
            selfDup: false
          };
        })
      };

      o.timeline = seedTimeline(o);
      return o;
    });
  }

  /**
   * 给演示工单造一条像样的进度。
   *
   * 以前抽屉里只有「优先级 / 状态 / 坐标」这几行，点开等于什么都没看到。
   * 处理进度是这套系统里最该被看见的东西：谁接的、几点到的、卡在哪一环。
   * 所以每条演示工单都按它当前的状态倒推出一串节点。
   */
  function seedTimeline(o) {
    var meta = D.type(o.type);
    var t0 = o.createdAt;
    var span = Math.max(NOW - t0, 60 * 1000);
    var crew = o.dept.short + ' · ' +
      ['李', '王', '张', '赵', '陈'][o.type.length % 5] + '师傅';

    var list = [{
      at: t0,
      label: '上报已提交',
      note: '描述：' + o.summary,
      by: (o.reports[0] && o.reports[0].by ? o.reports[0].by + '同学' : '上报人'),
      role: 'user',
      state: 'pending',
      tone: 'ok'
    }, {
      at: t0 + 2000,
      label: 'AI 判定通过',
      note: '画面：' + o.summary + '；与所选「' + meta.label + '」一致',
      by: '哨兵智能体 · DeepSeek 看图判定',
      role: 'ai',
      state: 'pending'
    }];

    var uniqNames = [];
    o.reports.forEach(function (r) { if (uniqNames.indexOf(r.by) < 0) uniqNames.push(r.by); });
    if (uniqNames.length > 1) {
      list.push({
        at: t0 + 0.12 * HOUR * (uniqNames.length - 1),
        label: '又有 ' + (uniqNames.length - 1) + ' 位同学上报同一处',
        note: '紧急度 ' + o.baseSeverity + ' 星 → ' + o.severity + ' 星，已合并为一张工单',
        by: '系统',
        role: 'system',
        state: 'pending'
      });
    }

    list.push({
      at: t0 + 0.2 * HOUR,
      label: '已按类型自动派单',
      note: o.dept.name + ' · 等待接单',
      by: '系统',
      role: 'system',
      state: 'pending'
    });

    if (o.status === 'processing' || o.status === 'resolved') {
      list.push({
        at: t0 + span * 0.12,
        label: '班组已接单',
        note: '按 ' + D.priorityOf(o.severity).id + ' 时限要求响应',
        by: '调度台',
        role: 'admin',
        state: 'processing'
      });
      list.push({
        at: t0 + span * 0.25,
        label: '已到场核实',
        note: '确认问题属实，无需转派',
        by: crew,
        role: 'crew',
        state: 'processing'
      });
      list.push({
        at: t0 + span * 0.55,
        label: '处置进行中',
        note: o.advice,
        by: crew,
        role: 'crew',
        state: 'processing'
      });
    }

    if (o.status === 'resolved') {
      list.push({
        at: t0 + span * 0.96,
        label: '处理完成，工单办结',
        note: '现场复核通过，处置结果已归档',
        by: '后勤保障部 · 值班主管',
        role: 'admin',
        state: 'resolved',
        tone: 'ok'
      });
    }

    list.forEach(function (e) { if (e.at > NOW) e.at = NOW; });
    return list;
  }

  var ORDERS = buildOrders();

  // 追加一条「同一人重复报」的记录到第 0 号工单，用来演示 self 合并
  ORDERS[0].reports.push({
    by: '李', credit: 92, at: ORDERS[0].createdAt + 0.55 * HOUR, selfDup: true
  });

  /* ---------------- AI 拦截记录（用于算拦截率） ---------------- */

  var BLOCK_LOG = [
    { reason: 'blur', at: 0.4 }, { reason: 'non-facility', at: 0.9 },
    { reason: 'mismatch', at: 1.3 }, { reason: 'blur', at: 2.1 },
    { reason: 'non-facility', at: 2.6 }, { reason: 'flat', at: 3.2 },
    { reason: 'blur', at: 3.8 }, { reason: 'mismatch', at: 4.5 },
    { reason: 'blur', at: 5.1 }, { reason: 'dark', at: 5.6 },
    { reason: 'non-facility', at: 6.2 }, { reason: 'blur', at: 6.9 }
  ].map(function (b) {
    return { reason: b.reason, at: NOW - b.at * 24 * HOUR };
  });

  /* ======================================================================
   * 2. 状态与工具
   * ==================================================================== */

  var state = {
    view: 'dashboard',
    statusFilter: 'all',
    typeFilter: 'all',
    deptFilter: 'all',
    sortBy: 'priority',
    heatFilter: 'all',
    keyword: '',
    expanded: {},       // 展开合并明细的工单 id
    collapsed: false
  };

  /**
   * 从详细地址里抽出「片区」。
   * 排行的意义是看「哪一片问题最多」，而不是「哪个具体点位最多」——
   * 「图书馆南广场路灯」和「图书馆南广场坡道」在管理视角上是同一片地方，
   * 只是分属不同班组，按完整地址聚合会把它们拆成两个"1 条"。
   */
  var AREA_KEYS = [
    '图书馆', '教学区', '菊园食堂', '柳园', '荷园', '体育场',
    '南门', '北门', '西门', '人工湖', '工科园', '化学系',
    '商学院', '实验楼', '医学院'
  ];

  function areaOf(addr) {
    for (var i = 0; i < AREA_KEYS.length; i++) {
      if (addr.indexOf(AREA_KEYS[i]) >= 0) return AREA_KEYS[i] + '片区';
    }
    return addr;
  }

  function fmtAgo(ts) {
    var h = (NOW - ts) / HOUR;
    if (h < 1) return Math.max(1, Math.round(h * 60)) + ' 分钟前';
    if (h < 24) return Math.round(h) + ' 小时前';
    return Math.round(h / 24) + ' 天前';
  }

  function fmtDate(ts) {
    var d = new Date(ts);
    var pad = function (n) { return n < 10 ? '0' + n : n; };
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function toast(msg, tone) {
    var el = $('#toast');
    el.textContent = msg;
    el.className = 'toast on' + (tone ? ' ' + tone : '');
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.className = 'toast'; }, 2400);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function starsHTML(n, color) {
    var s = '';
    for (var i = 1; i <= 5; i++) {
      s += '<i class="' + (i <= n ? 'on' : '') + '"></i>';
    }
    return '<span class="pri-stars" style="--pri-color:' + color + '">' + s + '</span>';
  }

  /* ======================================================================
   * 3. 侧边栏与路由
   * ==================================================================== */

  var VIEW_META = {
    dashboard: { title: '总览看板', sub: '郑州大学主校区 · 最近 7 天' },
    orders: { title: '工单管理', sub: '默认按紧急度排序' },
    dispatch: { title: '部门派单', sub: '按负责班组聚合，看谁手上积压最多' },
    insight: { title: 'AI 决策', sub: '周报、巡逻路线、合并建议' }
  };

  function bindSidebar() {
    $('#btnCollapse').addEventListener('click', function () {
      state.collapsed = !state.collapsed;
      $('#app').classList.toggle('is-collapsed', state.collapsed);
      // 侧栏变窄后地图容器尺寸也变了，得重新量一次，否则瓦片会留白
      setTimeout(function () { if (heatMap) heatMap.resize(); }, 380);
    });

    $$('#nav .nav-item').forEach(function (btn) {
      btn.addEventListener('click', function () { go(btn.dataset.view); });
    });
  }

  function go(view) {
    if (!VIEW_META[view]) return;
    state.view = view;

    $$('#nav .nav-item').forEach(function (b) {
      b.classList.toggle('active', b.dataset.view === view);
    });
    $$('.view').forEach(function (v) {
      v.classList.toggle('active', v.dataset.view === view);
    });

    $('#viewTitle').textContent = VIEW_META[view].title;
    $('#viewSub').textContent = VIEW_META[view].sub;

    if (view === 'dashboard') { renderMetrics(); renderHeat(); renderRank(); renderDonut(); }
    if (view === 'orders') renderOrders();
    if (view === 'dispatch') renderDispatch();
    if (view === 'insight') { renderMergeAdvice(); }

    // 切换后几何尺寸可能变了
    setTimeout(function () { if (heatMap && view === 'dashboard') heatMap.resize(); }, 60);
  }

  /* ======================================================================
   * 4. 总览
   * ==================================================================== */

  function pendingList() {
    return ORDERS.filter(function (o) { return o.status === 'pending'; });
  }

  function renderMetrics() {
    var pending = pendingList();
    var p0 = pending.filter(function (o) { return o.severity >= 5; }).length;

    var total = ORDERS.length;
    var done = ORDERS.filter(function (o) { return o.status === 'resolved'; }).length;
    var rate = total ? Math.round(done / total * 100) : 0;

    var validTotal = total + BLOCK_LOG.length;
    var blockRate = validTotal ? Math.round(BLOCK_LOG.length / validTotal * 100) : 0;

    // 平均响应：pending 工单从上报到现在的中位时长
    var ages = pending.map(function (o) { return (NOW - o.createdAt) / HOUR; }).sort(function (a, b) { return a - b; });
    var med = ages.length ? ages[Math.floor(ages.length / 2)] : 0;

    $('#mPending').textContent = pending.length;
    $('#mUrgent').textContent = p0;
    $('#mRate').textContent = rate + '%';
    $('#mRateSub').textContent = '已完成 ' + done + ' / 共 ' + total;
    $('#mBlock').textContent = blockRate + '%';
    $('#mBlockSub').textContent = '本周拦截 ' + BLOCK_LOG.length + ' 条无效信息';
    $('#mSla').innerHTML = Math.round(med) + '<small>h</small>';
    $('#mSlaSub').textContent = '中位待处理时长';

    $('#navBadgeOrders').textContent = pending.length;

    var mergedGroups = ORDERS.filter(function (o) {
      var uniq = {};
      o.reports.forEach(function (r) { uniq[r.by] = 1; });
      return Object.keys(uniq).length > 1;
    }).length;
    $('#sbPending').textContent = pending.length;
    $('#sbP0').textContent = p0;
    $('#sbMerged').textContent = mergedGroups + ' 组';
  }

  /* ---------------- 热力图 ---------------- */

  var heatMap = null;

  function initHeatMap() {
    var el = $('#heatMap');
    if (!el || heatMap) return;

    heatMap = TM.create(el, {
      center: [CAMPUS.lng, CAMPUS.lat],
      zoom: 15,
      source: 'plain',      // 无注记底图，热力压上去才不会糊成一片
      minZoom: 13,
      maxZoom: 19
    });
  }

  function renderHeat() {
    initHeatMap();
    if (!heatMap) return;

    var list = state.heatFilter === 'all'
      ? ORDERS
      : ORDERS.filter(function (o) { return o.type === state.heatFilter; });

    // 热力值用「紧急度累加」而不是单纯计数：
    // 一个 P0 井盖缺失，比三个「草坪被踩秃」更该被看见
    var buckets = {};
    list.forEach(function (o) {
      // 网格吸附到 30 米，避免同一栋楼的点各自独立成小热点
      var key = Math.round(o.lng * 20000) + '_' + Math.round(o.lat * 20000);
      if (!buckets[key]) buckets[key] = { lng: o.lng, lat: o.lat, v: 0, n: 0 };
      buckets[key].v += o.severity;
      buckets[key].n++;
    });

    var pts = Object.keys(buckets).map(function (k) {
      return buckets[k];
    });

    var maxV = pts.reduce(function (m, p) { return Math.max(m, p.v); }, 1);

    heatMap.setHeat(pts.map(function (p) {
      return { lng: p.lng, lat: p.lat, value: p.v };
    }), { radius: 52, max: maxV });

    // 点位小标记，方便点击看详情
    heatMap.setMarkers(list.map(function (o) {
      var t = D.type(o.type);
      return {
        id: o.id,
        lng: o.lng,
        lat: o.lat,
        className: 'hm-pin',
        style: { background: t.color },
        title: o.address + ' · ' + t.label,
        onClick: function () { openDrawer(o); }
      };
    }));

    // 左上角统计
    $('#hsTotal').textContent = list.length;

    var byArea = {};
    list.forEach(function (o) {
      var area = areaOf(o.address);
      byArea[area] = (byArea[area] || 0) + 1;
    });
    var top = Object.keys(byArea).sort(function (a, b) { return byArea[b] - byArea[a]; })[0];
    $('#hsTop').textContent = top || '—';

    setTimeout(function () { heatMap.resize(); }, 40);
  }

  /* ---------------- 高频区域排行 ---------------- */

  function renderRank() {
    var pending = pendingList();
    var map = {};
    pending.forEach(function (o) {
      var area = areaOf(o.address);
      if (!map[area]) map[area] = { name: area, n: 0, p: 0 };
      map[area].n++;
      map[area].p = Math.max(map[area].p, o.severity);
    });

    var rows = Object.keys(map).map(function (k) { return map[k]; })
      .sort(function (a, b) { return b.n - a.n || b.p - a.p; })
      .slice(0, 5);

    var max = rows.length ? rows[0].n : 1;

    $('#rankList').innerHTML = rows.map(function (r, i) {
      return '<div class="rank-row">' +
        '<div class="rank-top">' +
          '<span class="rank-idx">' + (i + 1) + '</span>' +
          '<span class="rank-name">' + escapeHtml(r.name) +
            (r.p >= 5 ? '<span class="tag-p0">P0</span>' : '') + '</span>' +
          '<span class="rank-count num">' + r.n + ' 条</span>' +
        '</div>' +
        '<div class="rank-bar"><i class="rank-fill" style="width:' +
          Math.max(8, Math.round(r.n / max * 100)) + '%"></i></div>' +
      '</div>';
    }).join('') || '<div class="empty-state">暂无待处理工单</div>';
  }

  /* ---------------- 趋势（SVG 手绘） ---------------- */

  function renderTrend() {
    var days = 7;
    var valid = [];
    var blocked = [];

    for (var d = days - 1; d >= 0; d--) {
      var dayStart = new Date(NOW - d * 24 * HOUR);
      dayStart.setHours(0, 0, 0, 0);
      var t0 = dayStart.getTime();
      var t1 = t0 + 24 * HOUR;

      var v = ORDERS.filter(function (o) { return o.createdAt >= t0 && o.createdAt < t1; }).length;
      var b = BLOCK_LOG.filter(function (x) { return x.at >= t0 && x.at < t1; }).length;
      valid.push(v);
      blocked.push(b);
    }

    // 补一点起伏，避免演示数据太整齐看起来像假的
    valid = valid.map(function (v, i) { return v + [2, 1, 3, 0, 2, 1, 0][i % 7]; });

    var W = 560, H = 200, PL = 34, PR = 10, PT = 14, PB = 26;
    var maxV = Math.max.apply(null, valid.concat(blocked).concat([4])) * 1.15;
    var stepX = (W - PL - PR) / (days - 1);

    function px(i) { return PL + i * stepX; }
    function py(v) { return PT + (H - PT - PB) * (1 - v / maxV); }
    function smooth(vals) {
      var d = 'M' + px(0).toFixed(1) + ',' + py(vals[0]).toFixed(1);
      for (var i = 0; i < vals.length - 1; i++) {
        var x0 = px(i), x1 = px(i + 1);
        var mx = (x0 + x1) / 2;
        d += ' C' + mx.toFixed(1) + ',' + py(vals[i]).toFixed(1) +
             ' ' + mx.toFixed(1) + ',' + py(vals[i + 1]).toFixed(1) +
             ' ' + x1.toFixed(1) + ',' + py(vals[i + 1]).toFixed(1);
      }
      return d;
    }

    var pathValid = smooth(valid);
    var pathBlocked = smooth(blocked);

    var labels = [];
    for (var i = 0; i < days; i++) {
      var dt = new Date(NOW - (days - 1 - i) * 24 * HOUR);
      labels.push((dt.getMonth() + 1) + '/' + dt.getDate());
    }

    // Y 轴刻度
    var ticks = [0, 0.5, 1].map(function (r) {
      var v = Math.round(maxV * r);
      return '<line x1="' + PL + '" y1="' + py(v) + '" x2="' + (W - PR) + '" y2="' + py(v) +
        '" stroke="rgba(22,41,43,.07)" stroke-dasharray="3 4"/>' +
        '<text x="' + (PL - 8) + '" y="' + (py(v) + 3.5) + '" text-anchor="end" ' +
        'font-size="10" fill="rgba(22,41,43,.35)">' + v + '</text>';
    }).join('');

    var svg =
      '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="近七天上报趋势">' +
        '<defs>' +
          '<linearGradient id="gv" x1="0" y1="0" x2="0" y2="1">' +
            '<stop offset="0" stop-color="#2B7A78" stop-opacity=".26"/>' +
            '<stop offset="1" stop-color="#2B7A78" stop-opacity="0"/>' +
          '</linearGradient>' +
        '</defs>' +
        ticks +
        '<path d="' + pathValid + ' L' + px(days - 1) + ',' + (H - PB) + ' L' + px(0) + ',' + (H - PB) + ' Z" fill="url(#gv)"/>' +
        '<path d="' + pathBlocked + '" fill="none" stroke="#C9D3D1" stroke-width="1.8" ' +
          'stroke-dasharray="4 4" stroke-linecap="round"/>' +
        '<path d="' + pathValid + '" fill="none" stroke="#2B7A78" stroke-width="2.2" ' +
          'stroke-linecap="round" stroke-linejoin="round"/>' +
        valid.map(function (v, i) {
          return '<circle cx="' + px(i) + '" cy="' + py(v) + '" r="3.2" fill="#fff" ' +
            'stroke="#2B7A78" stroke-width="2"/>';
        }).join('') +
        labels.map(function (l, i) {
          return '<text x="' + px(i) + '" y="' + (H - 8) + '" text-anchor="middle" ' +
            'font-size="10" fill="rgba(22,41,43,.4)">' + l + '</text>';
        }).join('') +
        // 透明热区，hover 出提示
        valid.map(function (v, i) {
          return '<rect class="trend-hit" data-i="' + i + '" x="' + (px(i) - stepX / 2) +
            '" y="0" width="' + stepX + '" height="' + H + '" fill="transparent"/>';
        }).join('') +
      '</svg>' +
      '<div class="trend-tip" id="trendTip"></div>';

    var box = $('#trendChart');
    box.innerHTML = svg;

    // hover 提示
    var tip = $('#trendTip', box);
    $$('.trend-hit', box).forEach(function (r) {
      r.addEventListener('mousemove', function (e) {
        var i = +r.dataset.i;
        var rect = box.getBoundingClientRect();
        tip.innerHTML = labels[i] + ' · 有效 <b>' + valid[i] + '</b> 条 / 拦截 <b>' + blocked[i] + '</b> 条';
        tip.style.left = (e.clientX - rect.left) + 'px';
        tip.style.top = (e.clientY - rect.top - 10) + 'px';
        tip.classList.add('on');
      });
      r.addEventListener('mouseleave', function () { tip.classList.remove('on'); });
    });
  }

  /* ---------------- 环形（SVG） ---------------- */

  function renderDonut() {
    var pending = pendingList();
    var map = {};
    pending.forEach(function (o) {
      map[o.type] = (map[o.type] || 0) + 1;
    });

    var rows = Object.keys(map).map(function (k) {
      return { type: k, n: map[k], meta: D.type(k) };
    }).sort(function (a, b) { return b.n - a.n; });

    var total = pending.length || 1;
    var R = 46;
    var C = 2 * Math.PI * R;
    var offset = 0;

    var svg = '<circle cx="60" cy="60" r="' + R + '" fill="none" stroke="rgba(22,41,43,.05)" stroke-width="13"/>';

    rows.forEach(function (r) {
      var frac = r.n / total;
      var len = frac * C;
      svg += '<circle cx="60" cy="60" r="' + R + '" fill="none" ' +
        'stroke="' + r.meta.color + '" stroke-width="13" ' +
        'stroke-dasharray="' + (len - 2.5) + ' ' + (C - len + 2.5) + '" ' +
        'stroke-dashoffset="' + (-offset) + '" stroke-linecap="round">' +
        '<title>' + r.meta.label + ' ' + r.n + ' 条</title></circle>';
      offset += len;
    });

    $('#donut').innerHTML = svg;
    $('#donutTotal').textContent = pending.length;

    $('#donutLegend').innerHTML = rows.slice(0, 5).map(function (r) {
      return '<div class="dl-row">' +
        '<span class="dl-dot" style="background:' + r.meta.color + '"></span>' +
        '<span class="dl-name">' + r.meta.label + '</span>' +
        '<span class="dl-val num">' + r.n + '</span>' +
      '</div>';
    }).join('') || '<div class="dl-row" style="color:var(--text-3)">暂无数据</div>';
  }

  /* ======================================================================
   * 5. 工单表
   * ==================================================================== */

  function filteredOrders() {
    var list = ORDERS.slice();

    if (state.statusFilter !== 'all') {
      list = list.filter(function (o) { return o.status === state.statusFilter; });
    }
    if (state.typeFilter !== 'all') {
      list = list.filter(function (o) { return o.type === state.typeFilter; });
    }
    if (state.deptFilter !== 'all') {
      list = list.filter(function (o) { return o.dept.id === state.deptFilter; });
    }
    if (state.keyword) {
      var kw = state.keyword.toLowerCase();
      list = list.filter(function (o) {
        return (o.orderNo + o.address + o.summary + o.type).toLowerCase().indexOf(kw) >= 0;
      });
    }

    switch (state.sortBy) {
      case 'priority':
        list.sort(function (a, b) {
          // 已完成的沉到底部：管理端最关心的是「还没处理的里哪个最急」，
          // 把昨天的 P0 已完成工单钉在最上面只会碍事
          var da = a.status === 'resolved' ? 1 : 0;
          var db = b.status === 'resolved' ? 1 : 0;
          return da - db ||
                 b.severity - a.severity ||
                 a.createdAt - b.createdAt;      // 同优先级时先报的先处理
        });
        break;
      case 'people':
        list.sort(function (a, b) {
          return b.reports.length - a.reports.length || b.severity - a.severity;
        });
        break;
      case 'newest':
        list.sort(function (a, b) { return b.createdAt - a.createdAt; });
        break;
      case 'oldest':
        list.sort(function (a, b) { return a.createdAt - b.createdAt; });
        break;
      case 'dept':
        list.sort(function (a, b) {
          return a.dept.name.localeCompare(b.dept.name, 'zh') || b.severity - a.severity;
        });
        break;
    }
    return list;
  }

  function renderOrders() {
    var list = filteredOrders();

    var mergedGroups = list.filter(function (o) {
      var uniq = {};
      o.reports.forEach(function (r) { uniq[r.by] = 1; });
      return Object.keys(uniq).length > 1;
    }).length;

    $('#ordersCount').textContent = list.length + ' 条工单';
    $('#mergeCount').textContent = mergedGroups + ' 组已合并';

    var body = $('#orderBody');
    if (!list.length) {
      body.innerHTML = '<tr><td colspan="8"><div class="empty-state">没有符合条件的工单，换个筛选试试</div></td></tr>';
      return;
    }

    body.innerHTML = list.map(function (o) {
      var t = D.type(o.type);
      var pri = D.priorityOf(o.severity);

      // 上报人：去重后的真实人数 + 总条数
      var uniqNames = [];
      o.reports.forEach(function (r) { if (uniqNames.indexOf(r.by) < 0) uniqNames.push(r.by); });
      var totalReports = o.reports.length;
      var isMerged = totalReports > 1;
      var expanded = !!state.expanded[o.id];

      var reporter = uniqNames[0] + '同学';
      if (isMerged) {
        reporter = uniqNames.length + ' 人';
      }

      var statusCls = 'status-' + o.status;
      var statusLabel = {
        pending: '待处理', processing: '处理中',
        resolved: '已完成', review: '待复核'
      }[o.status] || '待处理';

      return '<tr data-id="' + o.id + '">' +
        '<td>' +
          '<div class="thumb" style="background:linear-gradient(150deg,' + t.soft.replace('0.12', '0.5') + ',' + t.soft + ')">' +
            '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="' + t.color + '" ' +
              'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' + iconPath(t.icon) + '</svg>' +
          '</div>' +
        '</td>' +
        '<td>' +
          '<div class="cell-main">' + escapeHtml(o.address) + '</div>' +
          '<div class="cell-sub"><span class="mono">' + o.orderNo + '</span> · ' + fmtAgo(o.createdAt) + '</div>' +
          (function () {
            var s2 = slaOf(o);
            return '<div class="cell-sla ' + s2.tone + '">' + s2.text + '</div>';
          })() +
        '</td>' +
        '<td>' +
          '<span class="chip" style="background:' + t.soft + ';color:' + t.color + '">' +
            '<i style="background:' + t.color + '"></i><span>' + t.label + '</span>' +
          '</span>' +
        '</td>' +
        '<td>' +
          '<span class="dept-chip" title="' + escapeHtml(o.dept.name) + '">' +
            '<i style="width:6px;height:6px;border-radius:2px;background:' + o.dept.color + '"></i>' +
            '<span>' + escapeHtml(o.dept.short) + '</span>' +
          '</span>' +
        '</td>' +
        '<td>' +
          '<span class="pri">' +
            '<span class="pri-badge" style="background:' + pri.color + '">' + pri.id + '</span>' +
            starsHTML(o.severity, pri.color) +
          '</span>' +
        '</td>' +
        '<td>' +
          '<div class="reporter">' +
            '<span class="reporter-name">' + escapeHtml(reporter) + '</span>' +
            (isMerged
              ? '<span class="merge-badge" data-expand="' + o.id + '" title="点击展开上报明细">+' + (totalReports - 1) + '</span>'
              : '') +
          '</div>' +
          (expanded ? '<div class="cell-sub" style="white-space:normal;line-height:1.7;margin-top:4px">' +
            o.reports.map(function (r) {
              return escapeHtml(r.by) + '同学' +
                (r.selfDup ? '<span style="color:var(--text-3)">（重复，已合并）</span>' : '') +
                ' · ' + fmtAgo(r.at);
            }).join('<br>') + '</div>' : '') +
        '</td>' +
        '<td><span class="status ' + statusCls + '"><i></i>' + statusLabel + '</span></td>' +
        '<td>' +
          '<div class="ops">' +
            (o.status === 'pending' || o.status === 'review'
              ? '<button class="op op-primary" data-act="start" data-id="' + o.id + '">受理</button>'
              : '') +
            (o.status !== 'resolved'
              ? '<button class="op op-done" data-act="done" data-id="' + o.id + '" ' +
                  'title="办结并向上报人发放积分">办结</button>'
              : '') +
            '<button class="op" data-act="detail" data-id="' + o.id + '">详情</button>' +
          '</div>' +
        '</td>' +
      '</tr>';
    }).join('');

    bindOrderActions();
  }

  function iconPath(name) {
    var P = {
      alert: '<path d="M12 8v5M12 16.5v.4"/><path d="M12 3.5l9 16H3z"/>',
      bulb: '<path d="M9.5 18h5M10 21h4"/><path d="M12 3a6 6 0 00-3.5 10.9V16h7v-2.1A6 6 0 0012 3Z"/>',
      road: '<path d="M6 21l3-18M18 21l-3-18M12 6v3M12 13v3M12 20v1"/>',
      drop: '<path d="M12 3.5s5.5 6 5.5 9.6A5.5 5.5 0 016.5 13c0-3.6 5.5-9.5 5.5-9.5Z"/>',
      wrench: '<path d="M15.5 4.5a4.5 4.5 0 00-6 6L4 16l4 4 5.5-5.5a4.5 4.5 0 006-6l-3 3-3-3 3-3Z"/>',
      trash: '<path d="M5 7h14M9 7V5h6v2M7 7l1 13h8l1-13"/><path d="M11 11v5M13 11v5"/>',
      leaf: '<path d="M20 4c0 9-6.5 14-13 14"/><path d="M4 20c0-6 4-10 9-11"/>',
      car: '<path d="M5 16V11l2-4h10l2 4v5"/><rect x="3" y="15" width="18" height="4" rx="2"/><circle cx="7.5" cy="19.5" r="1.4"/><circle cx="16.5" cy="19.5" r="1.4"/>',
      wifi: '<path d="M4 9a13 13 0 0116 0M7 12.5a8.5 8.5 0 0110 0M10 16a4 4 0 014 0"/><circle cx="12" cy="19" r="1"/>',
      dots: '<circle cx="6" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="18" cy="12" r="1.5"/>'
    };
    return P[name] || P.dots;
  }

  function bindOrderActions() {
    $$('#orderBody [data-expand]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        var id = b.dataset.expand;
        state.expanded[id] = !state.expanded[id];
        renderOrders();
      });
    });

    $$('#orderBody [data-act]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        var id = b.dataset.id;
        var act = b.dataset.act;

        if (act === 'detail') {
          var o = ORDERS.filter(function (x) { return x.id === id; })[0];
          if (o) openDrawer(o);
          return;
        }

        var target = ORDERS.filter(function (x) { return x.id === id; })[0];
        if (!target) return;

        if (act === 'start') {
          target.status = 'processing';
          appendProgress(target, '班组已受理', '已通知 ' + target.dept.name + ' 安排到场',
            { by: '调度台', role: 'admin', state: 'processing' });
          renderOrders();
          renderMetrics();
          toast('已受理，已通知负责班组', 'ok');
          return;
        }

        // ---- 办结 = 发积分的唯一入口 ----
        // 积分不是 AI 放行时发的，是这里发的。后台点这一下，等于确认
        // 「人到过现场、问题真解决了」，钱才该出去。
        target.status = 'resolved';

        var pay = null;
        if (window.Payout && (target.live || target.code)) {
          // 现场模式进来的单子带的是真实编码，能落到具体某个上报人头上
          pay = Payout.settle(target.orderNo, { note: '后勤已到场核实并处理完成 · 积分到账' });
          if (pay && pay.ok) target.reward = { points: pay.points, paid: true };
        }

        if (pay && pay.ok) {
          // 结算已经往编码表里写过带积分说明的节点，这里只补内存那份
          appendProgress(target, '处理完成，工单办结',
            '现场复核通过，' + pay.points + ' 积分已发放给上报人',
            { state: 'resolved', tone: 'ok', skipStore: true });
        } else if (!pay || !pay.already) {
          appendProgress(target, '处理完成，工单办结',
            '现场复核通过，处置结果已归档',
            { state: 'resolved', tone: 'ok' });
        }

        renderOrders();
        renderMetrics();

        if (pay && pay.ok) {
          toast('已办结 · ' + pay.points + ' 积分已发放给上报人', 'ok');
        } else if (pay && pay.already) {
          toast('已办结 · 这张单的积分之前就发过了，不重复发', 'ok');
        } else if (pay && pay.msg) {
          toast('已办结 · ' + pay.msg, 'warn');
        } else {
          toast('已办结（演示工单没有真实上报人，不涉及积分发放）', 'ok');
        }
      });
    });

    $$('#orderBody tr').forEach(function (tr) {
      tr.addEventListener('click', function () {
        var o = ORDERS.filter(function (x) { return x.id === tr.dataset.id; })[0];
        if (o) openDrawer(o);
      });
    });
  }

  function bindOrdersToolbar() {
    $$('#statusFilter .filter').forEach(function (b) {
      b.addEventListener('click', function () {
        state.statusFilter = b.dataset.status;
        $$('#statusFilter .filter').forEach(function (x) { x.classList.toggle('on', x === b); });
        renderOrders();
      });
    });

    // 类型下拉
    $('#typeFilter').innerHTML = '<option value="all">全部类型</option>' +
      D.TYPES.map(function (t) {
        var n = ORDERS.filter(function (o) { return o.type === t.id; }).length;
        return '<option value="' + t.id + '">' + t.label + '（' + n + '）</option>';
      }).join('');

    $('#typeFilter').addEventListener('change', function (e) {
      state.typeFilter = e.target.value;
      renderOrders();
    });

    // 部门下拉
    $('#deptFilter').innerHTML = '<option value="all">全部部门</option>' +
      D.DEPTS.map(function (d) {
        var n = ORDERS.filter(function (o) { return o.dept.id === d.id; }).length;
        if (!n) return '';
        return '<option value="' + d.id + '">' + d.name + '（' + n + '）</option>';
      }).join('');

    $('#deptFilter').addEventListener('change', function (e) {
      state.deptFilter = e.target.value;
      renderOrders();
    });

    $('#sortBy').addEventListener('change', function (e) {
      state.sortBy = e.target.value;
      renderOrders();
    });

    $('#search').addEventListener('input', function (e) {
      state.keyword = e.target.value.trim();
      if (state.view === 'orders') renderOrders();
      if (state.view === 'dispatch') renderDispatch();
    });
  }

  /* ======================================================================
   * 6. 部门派单
   * ==================================================================== */

  function renderDispatch() {
    var groups = {};

    ORDERS.forEach(function (o) {
      if (o.status === 'resolved') return;
      if (!groups[o.dept.id]) groups[o.dept.id] = { dept: o.dept, orders: [] };
      groups[o.dept.id].orders.push(o);
    });

    var rows = Object.keys(groups).map(function (k) { return groups[k]; })
      .sort(function (a, b) { return b.orders.length - a.orders.length; });

    if (!rows.length) {
      $('#deptGrid').innerHTML = '<div class="empty-state">所有工单都已处理完毕</div>';
      return;
    }

    $('#deptGrid').innerHTML = rows.map(function (g) {
      var p0 = g.orders.filter(function (o) { return o.severity >= 5; }).length;

      // 这个部门最该先动哪一条
      var urgent = g.orders.slice().sort(function (a, b) {
        return b.severity - a.severity || a.createdAt - b.createdAt;
      })[0];
      var oldestH = Math.round((NOW - g.orders.reduce(function (m, o) {
        return Math.min(m, o.createdAt);
      }, NOW)) / HOUR);

      // 按类型看这个部门手上都是些什么活
      var byType = {};
      g.orders.forEach(function (o) {
        byType[o.type] = (byType[o.type] || 0) + 1;
      });
      var typeRows = Object.keys(byType).sort(function (a, b) {
        return byType[b] - byType[a];
      }).slice(0, 4);

      return '<div class="dept-card glass">' +
        '<div class="dept-head">' +
          '<div class="dept-mark" style="background:' + g.dept.color + '">' +
            escapeHtml(g.dept.short.slice(0, 2)) + '</div>' +
          '<div class="dept-info">' +
            '<div class="dept-name">' + escapeHtml(g.dept.name) + '</div>' +
            '<div class="dept-meta">' +
              (p0 ? '<span class="dept-p0">P0 ' + p0 + '</span> 最早 ' + oldestH + ' 小时前' :
                    '最早 ' + oldestH + ' 小时前') +
            '</div>' +
          '</div>' +
          '<div class="dept-count num">' + g.orders.length + '<small>条</small></div>' +
        '</div>' +
        '<div class="dept-load">' +
          typeRows.map(function (t) {
            var m = D.type(t);
            return '<div class="dept-load-row">' +
              '<span class="dl-dot" style="width:7px;height:7px;border-radius:50%;background:' + m.color + '"></span>' +
              '<span class="n">' + m.label + '</span>' +
              '<span class="c">' + byType[t] + '</span>' +
            '</div>';
          }).join('') +
        '</div>' +
        (urgent
          ? '<div class="dept-urgent">' +
              '<span class="tag-p0" style="flex:none">' + D.priorityOf(urgent.severity).id + '</span>' +
              '<span class="dept-urgent-text">' + escapeHtml(urgent.address) + '</span>' +
            '</div>'
          : '') +
      '</div>';
    }).join('');
  }

  /* ======================================================================
   * 7. AI 决策
   * ==================================================================== */

  function typewriter(el, text, done) {
    el.classList.remove('empty');
    el.textContent = '';
    var i = 0;
    el._tw && clearInterval(el._tw);
    el._tw = setInterval(function () {
      i += 2;
      el.textContent = text.slice(0, i);
      if (i >= text.length) {
        clearInterval(el._tw);
        el.textContent = text;
        done && done();
      }
    }, 16);
  }

  function bindInsight() {
    $('#btnWeekly').addEventListener('click', function () {
      var pending = pendingList();
      var done = ORDERS.filter(function (o) { return o.status === 'resolved'; }).length;
      var total = ORDERS.length;
      var rate = Math.round(done / total * 100);
      var validTotal = total + BLOCK_LOG.length;
      var blockRate = Math.round(BLOCK_LOG.length / validTotal * 100);
      var p0 = pending.filter(function (o) { return o.severity >= 5; }).length;

      var byArea = {};
      pending.forEach(function (o) {
        var area = areaOf(o.address);
        byArea[area] = (byArea[area] || 0) + 1;
      });
      var top = Object.keys(byArea).sort(function (a, b) { return byArea[b] - byArea[a]; })[0] || '图书馆片区';

      var text =
        '本周（11 月 18 日 — 11 月 24 日）郑州大学主校区共接收设施问题上报 ' + validTotal + ' 条，' +
        'AI 前置拦截无效信息 ' + BLOCK_LOG.length + ' 条（' + blockRate + '%），' +
        '主要原因是照片模糊与非设施内容，拦截质量稳定，未见明显误拦投诉。\n\n' +
        '有效工单 ' + total + ' 条，已完成 ' + done + ' 条，处理率 ' + rate + '%。' +
        '当前待处理 ' + pending.length + ' 条，其中紧急（P0）' + p0 + ' 条，已全部通知负责班组。' +
        '高频区域集中在' + top + '，建议下周把该片区纳入日常巡查路线。\n\n' +
        '提示：照明类问题连续三周位居前二，且多集中在老旧线路区段，' +
        '建议由后勤保障部水电班组牵头做一次线路专项排查，比逐点换灯更省事。';

      typewriter($('#outWeekly'), text);
      toast('周报已生成，可直接复制', 'ok');
    });

    $('#btnCopy').addEventListener('click', function () {
      var t = $('#outWeekly').textContent;
      if (!t || $('#outWeekly').classList.contains('empty')) {
        toast('先生成周报');
        return;
      }
      navigator.clipboard && navigator.clipboard.writeText(t)
        .then(function () { toast('已复制到剪贴板', 'ok'); })
        .catch(function () { toast('复制失败，请手动选中'); });
    });

    $('#btnPatrol').addEventListener('click', function () {
      var pending = pendingList();

      // 按「紧急度累加」排，不是按条数 —— 一个 P0 比三个 P3 更该先去
      var byArea = {};
      pending.forEach(function (o) {
        var area = areaOf(o.address);
        if (!byArea[area]) byArea[area] = { n: 0, score: 0, types: [], lng: o.lng, lat: o.lat };
        byArea[area].n++;
        byArea[area].score += o.severity;
        byArea[area].types.push(D.type(o.type).label);
      });

      var stops = Object.keys(byArea).map(function (k) {
        return { name: k, n: byArea[k].n, score: byArea[k].score, types: byArea[k].types };
      }).sort(function (a, b) { return b.score - a.score; }).slice(0, 5);

      var text = '本周建议重点巡查 ' + stops.length + ' 个点位。' +
        '顺序按「紧急度累加」排，而不是按上报条数——' +
        '一个井盖缺失比三处草坪问题更该先到。' +
        '建议两人一组，从' + (stops[0] ? stops[0].name : '图书馆周边') + '出发，沿主干道向南推进，预计 90 分钟完成。';

      typewriter($('#outPatrol'), text);

      $('#routeBox').innerHTML = stops.map(function (s, i) {
        var uniq = s.types.filter(function (t, k) { return s.types.indexOf(t) === k; });
        return '<div class="route-stop">' +
          '<span class="route-num">' + (i + 1) + '</span>' +
          '<div class="route-main">' +
            '<div class="route-name">' + escapeHtml(s.name) + '</div>' +
            '<div class="route-why">' + uniq.slice(0, 3).join(' · ') + ' · 累计紧急度 ' + s.score + '</div>' +
          '</div>' +
          '<span class="route-gap">' + s.n + ' 条</span>' +
        '</div>';
      }).join('');

      toast('巡逻路线已生成', 'ok');
    });

    $('#btnMergeAi').addEventListener('click', function () { renderMergeAdvice(true); });
  }

  function renderMergeAdvice(animate) {
    // 找「同一位置 + 同类型」但被拆成多条工单的情况
    var buckets = {};
    pendingList().forEach(function (o) {
      var key = o.type + '|' + Math.round(o.lng * 20000) + '|' + Math.round(o.lat * 20000);
      if (!buckets[key]) buckets[key] = [];
      buckets[key].push(o);
    });

    var sug = Object.keys(buckets).filter(function (k) {
      return buckets[k].length > 1;
    }).map(function (k) {
      var arr = buckets[k];
      var count = arr.reduce(function (n, o) { return n + o.reports.length; }, 0);
      return { area: arr[0].address, type: arr[0].type, n: arr.length, reports: count, orders: arr };
    });

    // 「同片区、不同类型」：一次出勤能顺手处理掉几条，这才是最省事的合并
    var areaBuckets = {};
    pendingList().forEach(function (o) {
      var area = areaOf(o.address);
      if (!areaBuckets[area]) areaBuckets[area] = [];
      areaBuckets[area].push(o);
    });

    Object.keys(areaBuckets).forEach(function (area) {
      var arr = areaBuckets[area];
      var types = {};
      arr.forEach(function (o) { types[o.type] = 1; });
      // 已经同类型合并过的就不重复建议了
      var already = sug.some(function (s) {
        return !s.deptWide && areaOf(s.area) === area;
      });
      if (arr.length >= 2 && Object.keys(types).length >= 2 && !already && sug.length < 3) {
        sug.push({
          area: area,
          type: null,
          crossType: true,
          n: arr.length,
          reports: arr.reduce(function (n, o) { return n + o.reports.length; }, 0),
          orders: arr
        });
      }
    });

    // 再加一条「同部门同片区」的建议，展示跨类型聚合
    var deptBuckets = {};
    pendingList().forEach(function (o) {
      if (!deptBuckets[o.dept.id]) deptBuckets[o.dept.id] = [];
      deptBuckets[o.dept.id].push(o);
    });
    Object.keys(deptBuckets).forEach(function (id) {
      var arr = deptBuckets[id];
      if (arr.length >= 3) {
        var alone = arr.filter(function (o) { return o.dept.id === id; });
        if (alone.length >= 3 && sug.length < 4) {
          sug.push({
            area: '整个' + D.dept(id).short + '辖区',
            type: null,
            n: alone.length,
            reports: alone.reduce(function (n, o) { return n + o.reports.length; }, 0),
            deptWide: true,
            orders: alone
          });
        }
      }
    });

    var box = $('#mergeBox');
    if (!sug.length) {
      box.innerHTML = '<div class="ai-output empty">当前没有发现需要合并的工单，现有归并逻辑已经把同一处的问题合到一起了。</div>';
      return;
    }

    box.innerHTML = sug.slice(0, 4).map(function (s) {
      var t = s.type ? D.type(s.type) : null;
      var title, desc;
      if (s.deptWide) {
        title = '检测到' + s.area + '有 ' + s.n + ' 条待办，建议安排一次集中出勤';
        desc = '涉及 ' + s.reports + ' 次上报，类型分散。同一位师傅跑一趟能处理完，比分三次出勤省 2 小时车程。';
      } else if (s.crossType) {
        var tset = s.orders.map(function (o) { return D.type(o.type).label; })
          .filter(function (v, i, a) { return a.indexOf(v) === i; });
        title = s.area + '有 ' + s.n + ' 处不同类型的问题，建议一次出勤顺路处理';
        desc = '涉及' + tset.slice(0, 3).join('、') + '。虽然分属不同班组，但物理距离在 200 米内，可以协调同日上门。';
      } else {
        title = '检测到' + s.area + '有 ' + s.n + ' 条' + t.label + '工单，建议合并为一次集中检修';
        desc = '共 ' + s.reports + ' 次上报，' + (s.orders[0].severity >= 4
          ? '其中包含高优先级工单，建议优先安排。'
          : '紧急度中等，可与其他任务合并出行。');
      }

      return '<div class="merge-sug">' +
        '<div class="merge-sug-ico">' +
          '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M5 8h6M5 16h6M13 8h6M13 16h6"/><path d="M11 8l2 8M13 8l-2 8"/>' +
          '</svg>' +
        '</div>' +
        '<div class="merge-sug-main">' +
          '<div class="merge-sug-title">' + escapeHtml(title) + '</div>' +
          '<div class="merge-sug-desc">' + escapeHtml(desc) + '</div>' +
        '</div>' +
        '<button class="op" data-merge-do="' + encodeURIComponent(s.orders.map(function (o) { return o.id; }).join(',')) + '">执行合并</button>' +
      '</div>';
    }).join('');

    $$('[data-merge-do]').forEach(function (b) {
      b.addEventListener('click', function () {
        var ids = decodeURIComponent(b.dataset.mergeDo).split(',');
        var first = ids[0];
        var others = ids.slice(1);

        // 合并：除了保留的那条，其余标记为已合并并从待处理里移除
        others.forEach(function (id) {
          var o = ORDERS.filter(function (x) { return x.id === id; })[0];
          var main = ORDERS.filter(function (x) { return x.id === first; })[0];
          if (!o || !main) return;
          main.reports = main.reports.concat(o.reports);
          main.severity = Math.max(main.severity, o.severity);
          o.mergedInto = first;
          o.status = 'resolved';
        });

        renderOrders();
        renderMetrics();
        renderDispatch();
        renderMergeAdvice();
        toast('已合并 ' + others.length + ' 条工单，上报记录已归并', 'ok');
      });
    });

    if (animate) toast('已重新分析合并建议');
  }

  /* ======================================================================
   * 8. 详情抽屉
   * ==================================================================== */

  /* ======================================================================
   * 时效与同处历史
   * ----------------------------------------------------------------------
   * 后勤最关心的其实不是"有多少单"，而是"哪几单快到点了"。
   * 所以每条工单都算一个剩余小时数：P0 4 小时、P1 8 小时、P2 24 小时，
   * 超了标红，剩不到 2 小时标黄。
   *
   * 另一件事是"这条街这个月第几次了"。同一位置反复报同类问题，
   * 说明上次只是补了一下，没有根治——这比单条工单更值得往上报。
   * ==================================================================== */

  var SLA_HOURS = { P0: 4, P1: 8, P2: 24, P3: 48, P4: 72 };
  var HOUR_MS = 3600 * 1000;

  function slaOf(o) {
    var pri = D.priorityOf(o.severity).id;
    var limitH = SLA_HOURS[pri] || 24;
    if (o.status === 'resolved') {
      return { text: '已办结', tone: 'is-ok', limitH: limitH };
    }
    var left = o.createdAt + limitH * HOUR_MS - Date.now();
    var h = Math.max(1, Math.round(Math.abs(left) / HOUR_MS));
    if (left < 0) return { text: '已超时 ' + h + ' 小时', tone: 'is-late', limitH: limitH };
    if (left < 2 * HOUR_MS) return { text: '剩 ' + h + ' 小时到期', tone: 'is-soon', limitH: limitH };
    return { text: '剩 ' + h + ' 小时', tone: '', limitH: limitH };
  }

  /** 近 30 天、同一类型、300 米内的其它工单数 */
  function repeatOf(o) {
    if (!o || typeof o.lat !== 'number') return 0;
    var n = 0;
    ORDERS.forEach(function (x) {
      if (!x || x.id === o.id || x.type !== o.type) return;
      if (Date.now() - x.createdAt > 30 * 24 * HOUR_MS) return;
      var dLat = Math.abs(x.lat - o.lat) * 111000;
      var dLng = Math.abs(x.lng - o.lng) * 91000;   // 郑州纬度下经度 1° ≈ 91km
      if (Math.sqrt(dLat * dLat + dLng * dLng) < 300) n++;
    });
    return n;
  }

  function openDrawer(o) {
    var t = D.type(o.type);
    var pri = D.priorityOf(o.severity);
    var sla = slaOf(o);
    var rep = repeatOf(o);

    $('#drawerTitle').textContent = o.orderNo;
    $('#drawerSub').textContent = o.address + ' · ' + fmtAgo(o.createdAt) + '上报';

    var uniq = [];
    o.reports.forEach(function (r) { if (uniq.indexOf(r.by) < 0) uniq.push(r.by); });

    $('#drawerBody').innerHTML =
      '<div class="dr-row"><span class="dr-k">问题类型</span>' +
        '<span class="dr-v"><span class="chip" style="background:' + t.soft + ';color:' + t.color + '">' +
          '<i style="background:' + t.color + '"></i><span>' + t.label + '</span></span></span></div>' +
      '<div class="dr-row"><span class="dr-k">负责部门</span><span class="dr-v">' + escapeHtml(o.dept.name) + '</span></div>' +
      '<div class="dr-row"><span class="dr-k">优先级</span>' +
        '<span class="dr-v"><span class="pri-badge" style="background:' + pri.color + ';display:inline-grid;vertical-align:1px">' +
          pri.id + '</span> ' + pri.label + ' · ' + o.severity + ' 星</span></div>' +
      '<div class="dr-row"><span class="dr-k">上报时间</span><span class="dr-v">' + fmtDate(o.createdAt) + '</span></div>' +
      '<div class="dr-row"><span class="dr-k">坐标</span><span class="dr-v mono" style="font-size:11px">' +
        o.lat.toFixed(5) + ', ' + o.lng.toFixed(5) + '</span></div>' +
      '<div class="dr-row"><span class="dr-k">状态</span><span class="dr-v">' +
        ({ pending: '待处理', processing: '处理中', resolved: '已完成', review: '待复核' })[o.status] +
        '</span></div>' +
      '<div class="dr-row"><span class="dr-k">时效</span><span class="dr-v">' +
        '<span class="sla-chip ' + sla.tone + '">' + sla.text + '</span>' +
        '<span class="dr-dim">　' + pri.id + ' 要求 ' + sla.limitH + ' 小时内响应</span></span></div>' +
      (rep
        ? '<div class="dr-row"><span class="dr-k">同处历史</span><span class="dr-v">' +
          '近 30 天同一位置已有 <b>' + rep + '</b> 条同类工单' +
          (rep >= 2 ? '，建议这次一并根治' : '') + '</span></div>'
        : '') +

      '<div class="dr-section">' +
        '<div class="dr-section-title">AI 诊断 · 仅供参考</div>' +
        '<div class="dr-note">' + escapeHtml(o.summary) + '<br><br>' +
          '<b style="font-weight:600">处置建议：</b>' + escapeHtml(o.advice) + '</div>' +
      '</div>' +

      (o.live ? liveSection(o) : '') +

      paySection(o) +

      progressSection(o) +

      '<div class="dr-section">' +
        '<div class="dr-section-title">上报记录 · ' + o.reports.length + ' 条 / ' + uniq.length + ' 人</div>' +
        o.reports.map(function (r) {
          return '<div class="dr-reporter">' +
            '<span class="dr-avatar">' + escapeHtml(r.by) + '</span>' +
            '<div class="dr-reporter-main">' +
              '<div class="dr-reporter-name">' + escapeHtml(r.by) + '同学' +
                (r.selfDup ? ' <span style="font-size:10px;color:var(--text-3)">重复上报</span>' : '') + '</div>' +
              '<div class="dr-reporter-meta">' + fmtDate(r.at) + '</div>' +
            '</div>' +
            '<span class="dr-credit">信用分 ' + r.credit + '</span>' +
          '</div>';
        }).join('') +
        (uniq.length > 1
          ? '<div class="dr-note" style="margin-top:8px;background:rgba(201,123,32,.06);border-color:rgba(201,123,32,.18)">' +
            '本工单由 ' + uniq.length + ' 位用户反馈同一处问题，紧急度已按人数从 ' +
            o.baseSeverity + ' 星抬升至 ' + o.severity + ' 星。</div>'
          : '') +
      '</div>';

    $('#drawer').classList.add('on');
    $('#drawerMask').classList.add('on');

    // 抽屉里也能直接办结发分：看完现场照片、确认没问题，就地处理，
    // 不用退回去到列表里再找一遍这一行。
    var payBtn = $('#drawerBody [data-pay]');
    if (payBtn) {
      payBtn.addEventListener('click', function () {
        var code = payBtn.dataset.pay;
        var pay = window.Payout ? Payout.settle(code) : null;

        if (!pay || !pay.ok) {
          toast((pay && pay.msg) || '结算失败', 'warn');
          return;
        }

        ORDERS.forEach(function (x) {
          if (x.orderNo !== code) return;
          x.status = 'resolved';
          x.reward = { points: pay.points, paid: true };
        });

        renderOrders();
        renderMetrics();

        var fresh = ORDERS.filter(function (x) { return x.orderNo === code; })[0];
        if (fresh) openDrawer(fresh);
        toast('已办结 · ' + pay.points + ' 积分已发放给上报人', 'ok');
      });
    }

    bindProgress(o);
  }

  function closeDrawer() {
    $('#drawer').classList.remove('on');
    $('#drawerMask').classList.remove('on');
  }

  /* ======================================================================
   * 9. 导出
   * ==================================================================== */

  function exportExcel() {
    var list = state.view === 'orders' ? filteredOrders() : ORDERS;

    var head = ['工单号', '问题类型', '位置', '负责部门', '优先级', '紧急度',
                '反馈人数', '上报条数', '状态', '首报时间', 'AI 摘要', '处置建议', '纬度', '经度'];

    var statusLabel = { pending: '待处理', processing: '处理中', resolved: '已完成', review: '待复核' };

    var rows = list.map(function (o) {
      var uniq = [];
      o.reports.forEach(function (r) { if (uniq.indexOf(r.by) < 0) uniq.push(r.by); });
      return [
        o.orderNo,
        D.type(o.type).label,
        o.address,
        o.dept.name,
        D.priorityOf(o.severity).id,
        o.severity,
        uniq.length,
        o.reports.length,
        statusLabel[o.status],
        fmtDate(o.createdAt),
        o.summary,
        o.advice,
        o.lat.toFixed(6),
        o.lng.toFixed(6)
      ];
    });

    // CSV + BOM：Excel 双击直接打开，中文不乱码。
    // 用 xls 的 HTML 伪装虽然能带样式，但 Excel 会弹「格式与扩展名不符」的警告，
    // 每次打开都吓人一跳，不如老老实实用 CSV。
    var esc = function (v) {
      var s = String(v == null ? '' : v);
      if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
      return s;
    };

    var csv = '\ufeff' + [head].concat(rows)
      .map(function (r) { return r.map(esc).join(','); })
      .join('\r\n');

    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);

    var d = new Date();
    var pad = function (n) { return n < 10 ? '0' + n : n; };
    var name = '见微-工单-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
               '-' + pad(d.getHours()) + pad(d.getMinutes()) + '.csv';

    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);

    toast('已导出 ' + rows.length + ' 条工单到 ' + name, 'ok');
  }

  /* ======================================================================
   * 现场模式
   * ----------------------------------------------------------------------
   * 演示时最尴尬的一幕：你在台上说"刚收到一条上报"，屏幕上却躺着一堆
   * 早就准备好的假数据。开这个模式，演示数据立刻清空，看板只接现场真报
   * 上来的工单 —— 手机报一条，这边两秒后长出来一条。
   *
   * 三端同源（都在同一个域名下），localStorage 是通的，
   * 所以不需要后端也能做到这件事。
   * ==================================================================== */

  var LIVE = {
    on: false,
    seen: {},
    timer: null,
    // 「清空」不是真删：先把当前列表整份拷进 trash，撤销时原样放回。
    // 演示时最常出的事故就是讲完一页手一抖清了库，所以这个必须能反悔。
    trash: null,
    // 被清掉的编码要拦一下，否则 syncLive 两秒后从编码表把它们又捞回来，
    // 用户会以为"清空没生效"
    muted: {}
  };
  var BLOCK_LOG_SEED = BLOCK_LOG.slice();

  function ticketToOrder(t) {
    var meta = D.type(t.type);
    var a = t.analysis || null;
    return {
      id: 'live-' + t.code,
      orderNo: t.code,
      type: t.type,
      address: t.addr,
      baseSeverity: t.severity,
      severity: t.severity,
      summary: t.desc || (meta.label + ' · 现场上报'),
      advice: (a && a.advice) || 'AI 已放行，按类型自动派单',
      lng: t.lng,
      lat: t.lat,
      dept: D.deptFor(t.type),
      status: ({ resolved: 'resolved', processing: 'processing', review: 'review' })[t.status] || 'pending',
      createdAt: t.at,
      reports: [{ by: '现场', credit: 80, at: t.at, selfDup: false }],
      live: true,
      code: t.code,
      // 积分：提交时算好的预估额、上报方式、以及到底发没发
      estPoints: t.estPoints,
      kind: t.kind,
      reward: t.reward || null,
      photo: t.photo || null,
      analysis: a,
      // 进度是这张单最有信息量的部分，漏了它抽屉里就只剩几行元数据
      timeline: t.timeline || [],
      desc: t.desc || ''
    };
  }

  /**
   * 直接从 localStorage 里读编码表。
   * 后台没有引 Auth 模块（它带着账号、闸门那一套，后台用不上），
   * 这里只要一张编码表就够了。键名和 auth.js 里的 CODE_KEY 是同一个。
   */
  function liveOrders() {
    var raw;
    try { raw = localStorage.getItem('jw.codes.v2'); } catch (e) { return []; }
    if (!raw) return [];
    var codes;
    try { codes = JSON.parse(raw); } catch (e) { return []; }

    return Object.keys(codes)
      .map(function (k) { return codes[k]; })
      .filter(function (t) { return t && t.lng && t.lat && t.type; })
      .sort(function (a, b) { return b.at - a.at; })
      .map(ticketToOrder);
  }

  function syncLive(quiet) {
    if (!LIVE.on) return;

    var fresh = liveOrders();
    var added = 0;

    fresh.forEach(function (o) {
      // 刚被「清空」掉的单子，编码表里还在，这里要挡一下
      if (o.code && LIVE.muted[o.code]) return;
      if (LIVE.seen[o.id]) return;
      LIVE.seen[o.id] = 1;
      // 已经在列表里的不重复加（合并上报会更新同一条编码）
      var exist = ORDERS.filter(function (x) { return x.id === o.id; })[0];
      if (exist) {
        exist.severity = o.severity;
        exist.status = o.status;
        exist.reports = o.reports;
        exist.estPoints = o.estPoints;
        exist.reward = o.reward;
        exist.timeline = o.timeline;
      } else {
        ORDERS.unshift(o);
        added++;
      }
    });

    // 状态可能被后台改过，同步回来（后台操作会写回编码表）
    ORDERS.forEach(function (o) {
      if (!o.live) return;
      var t = fresh.filter(function (x) { return x.id === o.id; })[0];
      if (t) { o.status = t.status; o.reward = t.reward; o.timeline = t.timeline; }
    });

    var n = ORDERS.length;
    var el = $('#liveCount');
    if (el) el.textContent = n + ' 条';

    if (added) {
      renderAll();
      if (!quiet) toast('收到 ' + added + ' 条现场上报', 'ok');
    }
  }

  function renderAll() {
    renderMetrics();
    renderTrend();
    renderDonut();
    renderRank();
    renderHeat();
    renderOrders();
    renderMergeAdvice();
  }

  /** 工单里全是纯数据，JSON 走一圈就是深拷贝 */
  function cloneOrders(list) {
    return JSON.parse(JSON.stringify(list));
  }

  /**
   * 演示模式下清空当前所有工单。
   * 只清屏幕，不动 localStorage —— 用户报的单子是真数据，
   * 演示完可能还要按编码查进度，删了就找不回来了。
   * 所以这里做的是"从看板上摘下来"，并且随时能原样挂回去。
   */
  function clearOrders() {
    if (!LIVE.on) { toast('先打开现场模式'); return; }

    var n = ORDERS.length;
    if (!n) { toast('现在本来就没有工单'); return; }

    LIVE.trash = cloneOrders(ORDERS);
    LIVE.muted = {};
    ORDERS.forEach(function (o) { if (o.code) LIVE.muted[o.code] = 1; });

    ORDERS.length = 0;
    LIVE.seen = {};
    state.expanded = {};
    closeDrawer();

    $('#btnLiveClear').hidden = true;
    $('#btnLiveUndo').hidden = false;
    $('#liveCount').textContent = '0 条';
    renderAll();

    toast('已清空 ' + n + ' 条工单，可随时撤销', 'ok');
  }

  function undoClear() {
    if (!LIVE.trash) { toast('没有可以撤销的清空'); return; }

    var restored = LIVE.trash;
    var fresh = ORDERS.slice();     // 清空之后又现场报上来的，撤销不能把它们冲掉
    LIVE.trash = null;
    LIVE.muted = {};

    ORDERS.length = 0;
    restored.forEach(function (o) { ORDERS.push(o); });
    fresh.forEach(function (o) {
      var dup = ORDERS.filter(function (x) { return x.id === o.id; })[0];
      if (!dup) ORDERS.unshift(o);
    });
    ORDERS.forEach(function (o) { LIVE.seen[o.id] = 1; });

    $('#btnLiveClear').hidden = false;
    $('#btnLiveUndo').hidden = true;
    $('#liveCount').textContent = ORDERS.length + ' 条';
    renderAll();

    toast('已恢复 ' + restored.length + ' 条工单' +
      (fresh.length ? '（清空后新增的 ' + fresh.length + ' 条也保留）' : ''), 'ok');
  }

  function setLive(on) {
    LIVE.on = on;

    $('#btnLive').classList.toggle('is-on', on);
    $('#btnLiveText').textContent = on ? '现场模式 · 开' : '现场模式';
    $('#liveBar').hidden = !on;

    if (on) {
      // 先清空：演示数据、拦截记录、以及所有缓存的分组
      ORDERS.length = 0;
      BLOCK_LOG.length = 0;
      LIVE.seen = {};
      LIVE.trash = null;
      LIVE.muted = {};
      state.expanded = {};
      if ($('#btnLiveUndo')) $('#btnLiveUndo').hidden = true;
      if ($('#btnLiveClear')) $('#btnLiveClear').hidden = false;

      ORDERS.unshift.apply(ORDERS, liveOrders());
      ORDERS.forEach(function (o) { LIVE.seen[o.id] = 1; });

      $('#liveCount').textContent = ORDERS.length + ' 条';
      renderAll();

      // 每 2 秒看一次编码表，现场报的会自己冒出来
      clearInterval(LIVE.timer);
      LIVE.timer = setInterval(function () { syncLive(false); }, 2000);

      toast('演示数据已清空，等待现场上报', 'ok');
    } else {
      clearInterval(LIVE.timer);
      LIVE.timer = null;
      LIVE.trash = null;
      LIVE.muted = {};
      if ($('#btnLiveUndo')) $('#btnLiveUndo').hidden = true;
      if ($('#btnLiveClear')) $('#btnLiveClear').hidden = false;

      ORDERS.length = 0;
      ORDERS.unshift.apply(ORDERS, buildOrders());
      // buildOrders 之后补上那条「同一人重复报」的记录
      if (ORDERS[0]) {
        ORDERS[0].reports.push({
          by: '李', credit: 92, at: ORDERS[0].createdAt + 0.55 * HOUR, selfDup: true
        });
      }

      BLOCK_LOG.length = 0;
      BLOCK_LOG.push.apply(BLOCK_LOG, BLOCK_LOG_SEED);

      renderAll();
      toast('已恢复演示数据');
    }

    if (heatMap) setTimeout(function () { heatMap.resize(); }, 60);
  }

  /**
   * 抽屉里的「处理进度」。
   *
   * 这一块是给现场处理的人用的，也是给上报人看的同一份数据：
   * 谁接的单、几点到场、卡在材料还是卡在施工窗口。以前只有一句
   * 「处理中」，等于让上报人干等。
   */
  var PROGRESS_CHIPS = [
    { label: '已到场核实', note: '已到现场，确认问题属实，无需转派' },
    { label: '材料未到', note: '所需材料短缺，已报采购，暂不能施工' },
    { label: '处置中', note: '正在施工/维修，预计当天完成' },
    { label: '已修复', note: '处置完成，等待复核验收' },
    { label: '需延期', note: '受天气或施工窗口影响，申请延期处理' },
    { label: '已转派', note: '超出本班组职责范围，已转派相关部门' }
  ];
  var drChip = null;

  function fmtDur(ms) {
    var m = Math.round(ms / 60000);
    if (m < 60) return m + ' 分钟';
    var h = Math.floor(m / 60);
    if (h < 24) return h + ' 小时' + (m % 60 ? ' ' + (m % 60) + ' 分' : '');
    return Math.floor(h / 24) + ' 天' + (h % 24 ? ' ' + (h % 24) + ' 小时' : '');
  }

  function progressSection(o) {
    var list = (o.timeline || []).slice().sort(function (a, b) { return a.at - b.at; });
    var ROLE = { user: '上报人', ai: 'AI', crew: '班组', admin: '管理端', system: '系统' };

    var rows = list.length ? list.map(function (e, i) {
      var gap = i > 0 ? e.at - list[i - 1].at : 0;
      var last = i === list.length - 1;
      return '<div class="dr-tl-row' + (last ? ' is-now' : '') +
               (e.tone === 'ok' ? ' is-ok' : '') + '">' +
        '<div class="dr-tl-head">' +
          '<span class="dr-tl-t">' + escapeHtml(e.label) + '</span>' +
          '<span class="dr-tl-role" data-role="' + (e.role || 'crew') + '">' +
            (ROLE[e.role] || '处理') + '</span>' +
        '</div>' +
        (e.by ? '<div class="dr-tl-by">' + escapeHtml(e.by) + '</div>' : '') +
        (e.note ? '<div class="dr-tl-note">' + escapeHtml(e.note) + '</div>' : '') +
        '<div class="dr-tl-time">' + fmtDate(e.at) +
          (gap > 60000 ? '　距上一步 ' + fmtDur(gap) : '') + '</div>' +
      '</div>';
    }).join('') : '<div class="dr-note">还没有进度记录</div>';

    return '<div class="dr-section">' +
      '<div class="dr-section-title">处理进度 · ' + list.length + ' 个节点' +
        (o.status === 'resolved'
          ? '<span class="dr-tl-elapse">已办结 · 历时 ' + fmtDur(NOW - o.createdAt) + '</span>'
          : '<span class="dr-tl-elapse">已用时 ' + fmtDur(Date.now() - o.createdAt) + '</span>') +
      '</div>' +
      '<div class="dr-tl">' + rows + '</div>' +
      '<div class="dr-progress">' +
        '<div class="dr-chips">' + PROGRESS_CHIPS.map(function (c, i) {
          return '<button class="dr-chip" data-chip="' + i + '">' + c.label + '</button>';
        }).join('') + '</div>' +
        '<textarea class="dr-note-input" id="drNote" rows="2" ' +
          'placeholder="补一句现场情况。写在这里的话，上报人在手机上也能看到"></textarea>' +
        '<button class="dr-add-btn" id="drAddNote">记一条进展</button>' +
      '</div>' +
    '</div>';
  }

  function bindProgress(o) {
    drChip = null;

    $$('#drawerBody .dr-chip').forEach(function (b) {
      b.addEventListener('click', function () {
        drChip = PROGRESS_CHIPS[+b.dataset.chip] || null;
        $$('#drawerBody .dr-chip').forEach(function (x) {
          x.classList.toggle('on', x === b);
        });
        var ta = $('#drNote');
        if (ta && !ta.value.trim()) ta.placeholder = '默认记录：' + drChip.note;
      });
    });

    var btn = $('#drAddNote');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var ta = $('#drNote');
      var note = ta ? ta.value.trim() : '';
      if (!drChip && !note) { toast('先选一个动作，或者写一句进展'); return; }
      writeProgress(o, drChip ? drChip.label : '处理进展',
        note || (drChip ? drChip.note : ''));
    });
  }

  /**
   * 往工单上追加一个进度节点。
   * 列表上的「受理」「办结」和抽屉里的「记一条进展」都走这里，
   * 保证内存里的工单和 localStorage 里的编码表写的是同一份东西。
   */
  function appendProgress(o, label, note, opts) {
    var x = opts || {};
    var entry = {
      at: x.at || Date.now(),
      label: label,
      note: note || '',
      by: x.by || '后勤保障部 · 值班主管',
      role: x.role || 'admin',
      state: x.state || o.status,
      tone: x.tone || ''
    };

    o.timeline = o.timeline || [];
    o.timeline.push(entry);

    // 现场单要写回编码表，否则手机端查进度看不到这一条。
    // 演示单没有编码，留在内存里就够，刷新后跟着演示数据一起重建。
    // skipStore：结算已经往编码表里写过一条（带积分说明），不要写重。
    if (o.code && !x.skipStore) {
      try {
        var raw = localStorage.getItem('jw.codes.v2');
        var codes = raw ? JSON.parse(raw) : {};
        if (codes[o.code]) {
          codes[o.code].timeline = codes[o.code].timeline || [];
          codes[o.code].timeline.push(entry);
          localStorage.setItem('jw.codes.v2', JSON.stringify(codes));
        }
      } catch (e) { /* 存不进去也不影响演示 */ }
    }
    return entry;
  }

  function writeProgress(o, label, note) {
    // 记进展本身就意味着"有人接管了"，把待处理/待复核推到处理中
    if (o.status === 'pending' || o.status === 'review') {
      o.status = 'processing';
      if (o.code) {
        try {
          var raw = localStorage.getItem('jw.codes.v2');
          var codes = raw ? JSON.parse(raw) : {};
          if (codes[o.code]) {
            codes[o.code].status = 'processing';
            localStorage.setItem('jw.codes.v2', JSON.stringify(codes));
          }
        } catch (e) { /* 忽略 */ }
      }
    }

    appendProgress(o, label, note);
    openDrawer(o);
    renderOrders();
    renderMetrics();
    toast('已记录：' + label, 'ok');
  }

  /**
   * 抽屉里的「积分结算」。
   *
   * 这一块存在的意义是让处理的人看见：自己点的这一下会往外发多少钱。
   * 以前「完成」只是个状态变更，现在它同时是一次付款动作，
   * 那就必须在点之前把金额、依据、发没发都摊开。
   */
  function paySection(o) {
    var canPay = !!(window.Payout && (o.live || o.code));
    var paid = !!(o.reward && o.reward.paid);

    if (!canPay) {
      return '<div class="dr-section">' +
        '<div class="dr-section-title">积分结算</div>' +
        '<div class="dr-note">这条是演示数据，没有真实上报人，办结时不产生积分。' +
          '开「现场模式」用手机真报一条，就能看到从上报到到账的完整链路。</div>' +
      '</div>';
    }

    var bd = window.Payout
      ? Payout.breakdown({ severity: o.severity, type: o.type, kind: (o.reward && o.reward.kind) || o.kind })
      : null;

    var pts = paid ? o.reward.points
      : (typeof o.estPoints === 'number' && o.estPoints ? o.estPoints : (bd ? bd.points : 0));

    var t = D.type(o.type);

    var how = bd
      ? '<div>' + bd.severity + ' 星 · 基础 ' + bd.base + ' 分' + '</div>' +
        '<div>' + escapeHtml(t.label) +
          (bd.typeW !== 1 ? ' ×' + bd.typeW : '') +
          ' · ' + escapeHtml(bd.kindText || '独立发现') +
          (bd.kindW !== 1 ? ' ×' + bd.kindW : '') + '</div>'
      : '';

    return '<div class="dr-section">' +
      '<div class="dr-section-title">积分结算</div>' +
      '<div class="dr-pay">' +
        '<div class="dr-pay-num"><b>' + pts + '</b><span>分</span></div>' +
        '<div class="dr-pay-info">' + how + '</div>' +
        '<span class="dr-pay-state' + (paid ? ' is-paid' : '') + '">' +
          (paid ? '已到账' : '待发放') + '</span>' +
      '</div>' +
      '<div class="dr-note" style="margin-top:9px">' +
        (paid
          ? '积分已随办结转给上报人，工单时间线上有记录。'
          : '点「办结并发分」才发。AI 放行只说明这张单能开，不代表现场真有东西可修——' +
            '钱压在最后这一步，乱报的人在这里拿不到任何东西。') +
      '</div>' +
      (paid || o.status === 'resolved' ? '' :
        '<button class="dr-pay-btn" data-pay="' + escapeHtml(o.orderNo) + '">' +
          '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" ' +
            'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ' +
            'style="vertical-align:-2px;margin-right:5px"><path d="M20 7L9.5 17.5 4 12"/></svg>' +
          '办结并发分</button>') +
    '</div>';
  }

  /** 抽屉里的「现场这一条」：照片 + 判定过程 */
  function liveSection(o) {
    var a = o.analysis || {};
    var m = a.metrics || {};
    var src = a.source === 'deepseek'
      ? (a.sawImage ? 'DeepSeek 看图判定' : 'DeepSeek 文本判定')
      : '本地规则引擎';

    var hin = a.qualityHint || null;
    var reviewTag = (a.review || a.soft)
      ? '<div class="dr-note" style="margin-top:8px;background:rgba(240,180,60,.12);' +
        'border:1px solid rgba(240,180,60,.28);color:#8a5a00">' +
        '<b>画质存疑 · 已放行待人工复核</b>' +
        (hin ? '<br>' + escapeHtml(hin.message || '') +
          (hin.issues && hin.issues.length ? '（' + escapeHtml(hin.issues[0]) + '）' : '') : '') +
        '<br>到场先确认现场是否真有这一处，对不上就直接驳回，不要让这张单进工单池。' +
        '</div>'
      : '';

    var LABEL = {
      sharpness: '清晰度',
      brightness: '亮度',
      saturation: '饱和度',
      flatRatio: '平坦区',
      edgeDensity: '边缘密度'
    };

    var rows = Object.keys(LABEL).filter(function (k) {
      return m[k] != null;
    }).map(function (k) {
      var v = m[k];
      var show = typeof v === 'number' ? (v < 10 ? v.toFixed(3) : Math.round(v)) : v;
      return '<div class="dr-metric"><span>' + LABEL[k] + '</span><b>' + show + '</b></div>';
    }).join('');

    return '<div class="dr-section">' +
      '<div class="dr-section-title">现场原始记录</div>' +
      (o.photo ? '<div class="dr-shot"><img src="' + o.photo + '" alt="现场照片"></div>' : '') +
      (o.summary ? '<div class="dr-note" style="margin-top:10px">“' + escapeHtml(o.summary) + '”</div>' : '') +
      '<div class="dr-row" style="margin-top:10px"><span class="dr-k">判定来源</span>' +
        '<span class="dr-v">' + src + '</span></div>' +
      reviewTag +
      (a.seen
        ? '<div class="dr-seen"><span class="dr-seen-k">模型看到的</span>' +
          escapeHtml(a.seen) + '</div>'
        : '') +
      (rows ? '<div class="dr-metrics">' + rows + '</div>' : '') +
      '<div class="dr-note" style="margin-top:8px">' +
        (a.pass
          ? 'AI 已放行，这张单按类型自动派给了班组；现场照片和判定依据都留在这里，' +
            '核实完点「办结并发分」。'
          : '上报人选择的是「转人工」，所以这张单子没经过自动派单，' +
            '等人工确认后再分给班组。') +
      '</div>' +
    '</div>';
  }

  /* ======================================================================
   * 启动
   * ==================================================================== */

  function boot() {
    bindSidebar();
    bindOrdersToolbar();
    bindInsight();

    $('#drawerClose').addEventListener('click', closeDrawer);
    $('#drawerMask').addEventListener('click', closeDrawer);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeDrawer();
    });

    $('#btnExport').addEventListener('click', exportExcel);

    $('#btnLive').addEventListener('click', function () { setLive(!LIVE.on); });
    $('#btnLiveExit').addEventListener('click', function () { setLive(false); });
    $('#btnLiveClear').addEventListener('click', clearOrders);
    $('#btnLiveUndo').addEventListener('click', undoClear);

    // 热力图筛选
    $$('#heatFilter .seg-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        state.heatFilter = b.dataset.heat;
        $$('#heatFilter .seg-btn').forEach(function (x) { x.classList.toggle('on', x === b); });
        renderHeat();
      });
    });

    renderMetrics();
    renderTrend();
    renderDonut();
    renderRank();
    initHeatMap();
    renderHeat();
    renderOrders();
    renderMergeAdvice();

    // 支持 #orders / #dispatch / #insight 直达
    var h = decodeURIComponent(location.hash.replace(/^#/, ''));

    // #drawer-o3：直接打开某条工单的详情，跳过点击
    if (h.indexOf('drawer-') === 0) {
      var id = h.slice(7);
      var target = ORDERS.filter(function (o) { return o.id === id; })[0];
      if (target) {
        go('orders');
        setTimeout(function () { openDrawer(target); }, 260);
      }
      return;
    }
    if (h === 'weekly') {
      go('insight');
      setTimeout(function () { $('#btnWeekly').click(); }, 300);
      return;
    }
    if (h === 'patrol') {
      go('insight');
      setTimeout(function () { $('#btnPatrol').click(); }, 300);
      return;
    }
    if (VIEW_META[h]) go(h);
  }

  /* ======================================================================
   * 自测：?selftest=1 时跑一遍关键交互，把结果写进 body[data-selftest]
   * 这样用无头浏览器也能验证「点了有没有反应」，不用靠肉眼看截图。
   * ==================================================================== */

  function selftest() {
    var log = [];
    var ok = function (name, pass, extra) {
      log.push((pass ? 'PASS ' : 'FAIL ') + name + (extra ? ' :: ' + extra : ''));
    };

    // 1. 侧栏收起
    var app = $('#app');
    $('#btnCollapse').click();
    ok('侧栏收起', app.classList.contains('is-collapsed'));
    $('#btnCollapse').click();
    ok('侧栏展开', !app.classList.contains('is-collapsed'));

    // 2. 排序：切到「反馈人数优先」，检查是否真的重排
    var sel = $('#sortBy');
    sel.value = 'people';
    sel.dispatchEvent(new Event('change'));
    var firstRows = $$('#orderBody tr').slice(0, 3).map(function (tr) {
      return tr.querySelector('.reporter-name').textContent;
    });
    ok('按反馈人数排序', firstRows.length > 0, firstRows.join(' / '));

    // 3. 受理：点第一条待处理的「受理」，状态应变成处理中
    sel.value = 'priority';
    sel.dispatchEvent(new Event('change'));
    var btn = $('#orderBody [data-act="start"]');
    var beforeId = btn ? btn.dataset.id : null;
    if (btn) {
      btn.click();
      var after = ORDERS.filter(function (o) { return o.id === beforeId; })[0];
      ok('受理工单', after && after.status === 'processing', beforeId + ' -> ' + (after && after.status));
    } else {
      ok('受理工单', false, '没找到受理按钮');
    }

    // 4. 导出：拦下 a.click，检查生成的 CSV 有没有内容
    var captured = null;
    var origCreate = document.createElement.bind(document);
    var origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { captured = this.download; };
    try { exportExcel(); } catch (e) { captured = 'ERROR: ' + e.message; }
    HTMLAnchorElement.prototype.click = origClick;
    ok('导出 Excel', !!captured && captured.indexOf('.csv') > 0, String(captured));

    // 5. 热力图是否建起来
    var tiles = $$('#heatMap .tm-tile').length;
    var marks = $$('#heatMap .tm-mark').length;
    ok('热力图瓦片', tiles > 0, tiles + ' 张瓦片');
    ok('热力图标记', marks > 0, marks + ' 个点位');

    // 6. 合并建议
    var sug = $$('#mergeBox .merge-sug').length;
    ok('合并建议', sug > 0, sug + ' 条建议');

    document.body.setAttribute('data-selftest', log.join(' | '));
  }

  document.addEventListener('DOMContentLoaded', function () {
    boot();
    // ?collapsed=1：侧栏直接以收起状态打开，投屏演示时省得现场点
    if (/[?&]collapsed=1/.test(location.search)) {
      state.collapsed = true;
      $('#app').classList.add('is-collapsed');
    }
    if (/[?&]selftest=1/.test(location.search)) {
      setTimeout(selftest, 900);
    }
  });

})();
