/* ==========================================================================
 * 见微 · 领域词汇表
 * --------------------------------------------------------------------------
 * 三端共用同一份定义。以前类型和部门散落在各处，改一个地方就会对不上，
 * 所以这里集中：问题类型 → 默认负责部门 → 默认基准紧急度。
 * ========================================================================== */

(function (global) {
  'use strict';

  /* ----------------------------------------------------------------------
   * 一、负责部门
   * -------------------------------------------------------------------- */

  var DEPTS = [
    { id: 'logistics-power',   name: '后勤保障部 · 水电班组', short: '水电班组', color: '#2E6FB7' },
    { id: 'logistics-clean',   name: '后勤保障部 · 环卫班组', short: '环卫班组', color: '#3E9B6B' },
    { id: 'logistics-repair',  name: '后勤保障部 · 维修班组', short: '维修班组', color: '#7A6BC4' },
    { id: 'logistics-green',   name: '后勤保障部 · 绿化班组', short: '绿化班组', color: '#4E9A3E' },
    { id: 'security-patrol',   name: '保卫处 · 安全巡查队',   short: '安全巡查队', color: '#C9553D' },
    { id: 'security-traffic',  name: '保卫处 · 交通管理',     short: '交通管理', color: '#C97B20' },
    { id: 'infra-road',        name: '基建处 · 道路维护',     short: '道路维护', color: '#8A7350' },
    { id: 'it-network',        name: '信息化办公室 · 网络运维', short: '网络运维', color: '#2B7A78' },
    { id: 'coordination',      name: '综合协调办 · 待分派',   short: '待分派', color: '#6B7C7A' }
  ];

  var DEPT_MAP = {};
  DEPTS.forEach(function (d) { DEPT_MAP[d.id] = d; });

  /* ----------------------------------------------------------------------
   * 二、问题类型
   * -------------------------------------------------------------------- */

  /**
   * base: 该类型的基准紧急度（1~5 星）。合并与多人反馈会在这个基础上加。
   *       「安全隐患」基准就是 4，因为它天然比「卫生」更该先处理。
   */
  var TYPES = [
    {
      id: 'safety', label: '安全隐患', icon: 'alert',
      color: '#C9553D', soft: 'rgba(201,85,61,.12)',
      dept: 'security-patrol', base: 4,
      hint: '井盖缺失、护栏松动、电线外露、墙体开裂',
      sla: 4
    },
    {
      id: 'lighting', label: '照明路灯', icon: 'bulb',
      color: '#C97B20', soft: 'rgba(201,123,32,.12)',
      dept: 'logistics-power', base: 3,
      hint: '路灯不亮、灯罩破损、路灯闪烁',
      sla: 24
    },
    {
      id: 'road', label: '道路破损', icon: 'road',
      color: '#8A7350', soft: 'rgba(138,115,80,.12)',
      dept: 'infra-road', base: 3,
      hint: '路面坑洼、地砖松动、台阶破损、路面积水',
      sla: 48
    },
    {
      id: 'water', label: '给排水', icon: 'drop',
      color: '#2E6FB7', soft: 'rgba(46,111,183,.12)',
      dept: 'logistics-power', base: 3,
      hint: '水管漏水、下水返味、直饮水故障、积水',
      sla: 24
    },
    {
      id: 'facility', label: '设施损坏', icon: 'wrench',
      color: '#7A6BC4', soft: 'rgba(122,107,196,.12)',
      dept: 'logistics-repair', base: 2,
      hint: '座椅断裂、垃圾桶破损、门禁失灵、无障碍设施缺失',
      sla: 72
    },
    {
      id: 'sanitation', label: '环境卫生', icon: 'trash',
      color: '#3E9B6B', soft: 'rgba(62,155,107,.12)',
      dept: 'logistics-clean', base: 2,
      hint: '垃圾满溢、异味、地面污渍、小广告',
      sla: 12
    },
    {
      id: 'green', label: '绿化养护', icon: 'leaf',
      color: '#4E9A3E', soft: 'rgba(78,154,62,.12)',
      dept: 'logistics-green', base: 1,
      hint: '树木倒伏、枝干断裂、草坪损毁',
      sla: 72
    },
    {
      id: 'traffic', label: '交通秩序', icon: 'car',
      color: '#C97B20', soft: 'rgba(201,123,32,.12)',
      dept: 'security-traffic', base: 2,
      hint: '机动车乱停、闸机故障、减速带缺失、非机动车占道',
      sla: 24
    },
    {
      id: 'network', label: '网络通信', icon: 'wifi',
      color: '#2B7A78', soft: 'rgba(43,122,120,.12)',
      dept: 'it-network', base: 2,
      hint: '校园网中断、弱电箱破损、广播无声、监控黑屏',
      sla: 24
    },
    {
      id: 'other', label: '其他问题', icon: 'dots',
      color: '#6B7C7A', soft: 'rgba(107,124,122,.12)',
      dept: 'coordination', base: 1,
      hint: '不属于以上分类的公共设施问题',
      sla: 72
    }
  ];

  var TYPE_MAP = {};
  TYPES.forEach(function (t) { TYPE_MAP[t.id] = t; });

  /* ----------------------------------------------------------------------
   * 二·补、哪些类型可以不拍照
   * -------------------------------------------------------------------- */

  /**
   * 照片要求的判断标准只有一个：这张图能不能证明问题存在。
   *
   *   能证明 —— 井盖缺失、路灯不亮、垃圾满溢、护栏断裂、路面坑洼。
   *             一张图能让后勤少跑一趟空路，所以必传。
   *   证明不了 —— 校园网卡、断网、信号差、系统故障。
   *             拍路由器指示灯是正常的，拍手机屏幕又不是"现场"，
   *             逼着必传只会让人随便拍一张交差，反而污染工单。
   *
   * 所以这里不做"全都要"也不做"全不要"，按类型分开：
   * 这两类改成选填，并在界面上写清楚"有图会更快解决"。
   */
  var PHOTO_OPTIONAL = { network: 1, other: 1 };

  function photoRequired(typeId) {
    return !PHOTO_OPTIONAL[typeId];
  }

  /* ----------------------------------------------------------------------
   * 三、优先级
   * -------------------------------------------------------------------- */

  /**
   * 由紧急度（1~5）推出优先级。管理端列表默认按优先级排。
   * 之所以不让用户直接选优先级：用户只会全选「非常紧急」，
   * 这个字段必须由系统算，才可信。
   */
  function priorityOf(severity) {
    var s = Math.round(severity || 1);
    if (s >= 5) return { id: 'P0', label: '紧急', color: '#C0392B', weight: 5 };
    if (s === 4) return { id: 'P1', label: '高',   color: '#C9553D', weight: 4 };
    if (s === 3) return { id: 'P2', label: '中',   color: '#C97B20', weight: 3 };
    if (s === 2) return { id: 'P3', label: '较低', color: '#3E9B6B', weight: 2 };
    return { id: 'P4', label: '低', color: '#6B7C7A', weight: 1 };
  }

  /* ----------------------------------------------------------------------
   * 四、合并规则
   * -------------------------------------------------------------------- */

  var MERGE = {
    radius: 15,            // 米：同一处判定半径
    windowHours: 24,       // 小时：合并时间窗
    maxSeverity: 5,
    /** 每多一名不同用户反馈，紧急度 +1，上限 5 */
    crowdBoost: 1
  };

  /**
   * 判定两条上报是否应合并。
   * @param {Object} a 已存在的上报 { type, lng, lat, openid, ts }
   * @param {Object} b 新上报
   * @param {Function} dist 距离函数（米），由 TileMap.distance 提供
   */
  function shouldMerge(a, b, dist) {
    if (a.type !== b.type) return { merge: false };
    var d = dist(a.lng, a.lat, b.lng, b.lat);
    if (d > MERGE.radius) return { merge: false, distance: d };

    var hours = Math.abs(b.ts - a.ts) / 3600000;
    if (hours > MERGE.windowHours) return { merge: false, distance: d };

    // 同一人重复报同一处：合并，但不提优先级（防止刷分刷优先级）
    if (a.openid && b.openid && a.openid === b.openid) {
      return { merge: true, kind: 'self', distance: d, reason: '同一用户重复上报' };
    }
    // 不同人报同一处：合并，并且随人数抬升优先级
    return { merge: true, kind: 'crowd', distance: d, reason: '多人反馈同一问题' };
  }

  /** 合并后重算紧急度 */
  function mergedSeverity(baseSeverity, reporterCount) {
    var s = (baseSeverity || 1) + Math.max(0, (reporterCount || 1) - 1) * MERGE.crowdBoost;
    return Math.min(MERGE.maxSeverity, s);
  }

  /* ----------------------------------------------------------------------
   * 五、对外
   * -------------------------------------------------------------------- */

  var D = {
    DEPTS: DEPTS,
    TYPES: TYPES,
    TYPE_MAP: TYPE_MAP,
    DEPT_MAP: DEPT_MAP,
    MERGE: MERGE,
    dept: function (id) { return DEPT_MAP[id] || DEPT_MAP.coordination; },
    type: function (id) { return TYPE_MAP[id] || TYPE_MAP.other; },
    /** 某类型默认派给谁 */
    deptFor: function (typeId) {
      var t = TYPE_MAP[typeId] || TYPE_MAP.other;
      return DEPT_MAP[t.dept] || DEPT_MAP.coordination;
    },
    priorityOf: priorityOf,
    shouldMerge: shouldMerge,
    mergedSeverity: mergedSeverity,
    photoRequired: photoRequired,
    PHOTO_OPTIONAL: PHOTO_OPTIONAL
  };

  if (typeof module === 'object' && module.exports) module.exports = D;
  global.Domain = D;

})(typeof window !== 'undefined' ? window : this);
