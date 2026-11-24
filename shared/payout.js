/* ==========================================================================
 * 见微 · 积分结算
 * --------------------------------------------------------------------------
 * 一条规则贯穿全系统：**积分不是 AI 发的，是后勤发的。**
 *
 * 为什么要把这两件事拆开：
 *
 *   AI 判"有效"只是把工单放进派单池，它证明的是"这张照片像那么回事"，
 *   不证明"这里真的有一盏坏灯"。如果 AI 一放行就到账，那这套积分
 *   奖励的其实是"会拍照的人"，而不是"帮上忙的人"——刷单也就有了动机：
 *   找一面脏墙、换个角度拍十次，照样拿分。
 *
 *   所以钱要压在最后一环：后勤到场、核实、处理完，才结算。
 *   到这一步，乱报的人拿不到任何东西，因为他报的地方根本没东西可修；
 *   真发现问题的人，拿到的分也才对得起他跑的那一趟。
 *
 * 分档也很重要。「垃圾桶满了」和「井盖没了」不该同一个价。
 * 分由三样东西乘出来：
 *
 *   紧急度  1–5 星  →  20 / 30 / 45 / 65 / 90   基础分，越急越贵
 *   问题类型        →  安全 ×1.2，路面 ×1.1，积水 ×1.05，其余 ×1
 *   上报方式        →  独立发现 ×1，帮别人确认 ×0.6，同一处重复 ×0.4
 *
 * 结果取整到 5 的倍数——界面上写「预计 +65」比「预计 +63.7」可信得多。
 *
 * 这个文件同时被用户端和管理后台引用。后台没有引 auth.js（那一套带着
 * 登录闸门，后台用不上），所以这里只按约定的键名直接读写 localStorage，
 * 不依赖任何上游模块。
 * ========================================================================== */

window.Payout = (function () {
  'use strict';

  var AUTH_KEY = 'jw.auth.v2';
  var PROF_KEY = 'jw.auth.v2.profiles';
  var CODE_KEY = 'jw.codes.v2';

  /* ---------------- 分档表 ---------------- */

  var BASE = { 1: 20, 2: 30, 3: 45, 4: 65, 5: 90 };

  var TYPE_W = {
    safety: 1.2,      // 安全隐患：可能伤到人，最贵
    road: 1.1,        // 路面破损：影响通行，次之
    water: 1.05,      // 积水漏水：会扩散，越早越省事
    facility: 1.05,   // 设施损坏：个人修不了，等专业班组
    network: 1.05,    // 网络通信：影响面大，一坏一片
    lighting: 1,
    sanitation: 1,
    traffic: 1,
    green: 0.95,      // 绿化：好看但不挡路，分最低
    other: 1
  };

  var KIND_W = {
    solo: 1,          // 独立发现
    crowd: 0.6,       // 帮别人确认了同一处：少跑一趟，但确实有人证
    self: 0.4,        // 同一处重复报：不鼓励，但也不至于白报
    review: 0.75      // AI 没过、自己转人工，最后核实为真
  };

  var KIND_TEXT = {
    solo: '独立发现',
    crowd: '帮别人确认了同一处',
    self: '同一处重复上报',
    review: '转人工复核后核实为真'
  };

  /* ---------------- 存储 ---------------- */

  function read(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }

  function write(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); return true; }
    catch (e) { return false; }
  }

  /* ---------------- 算分 ---------------- */

  function clampSev(n) {
    var s = Math.round(Number(n) || 1);
    return Math.max(1, Math.min(5, s));
  }

  /** 上报方式：没显式传就按「有没有并单」推断 */
  function kindOf(o) {
    if (o.kind && KIND_W[o.kind] != null) return o.kind;
    if (o.status === 'review') return 'review';
    return o.merged ? 'crowd' : 'solo';
  }

  /**
   * 算一条上报值多少分。
   * @param {object} o  { severity, type, kind, merged, status }
   * @return {number}   5 的倍数
   */
  function estimate(o) {
    o = o || {};
    var sev = clampSev(o.severity);
    var tw = TYPE_W[o.type] != null ? TYPE_W[o.type] : 1;
    var kw = KIND_W[kindOf(o)] != null ? KIND_W[kindOf(o)] : 1;
    var pts = Math.round(BASE[sev] * tw * kw / 5) * 5;
    return Math.max(5, pts);
  }

  /** 给界面拆着讲：为什么是这么多分 */
  function breakdown(o) {
    o = o || {};
    var sev = clampSev(o.severity);
    var k = kindOf(o);
    return {
      severity: sev,
      base: BASE[sev],
      type: o.type || 'other',
      typeW: TYPE_W[o.type] != null ? TYPE_W[o.type] : 1,
      kind: k,
      kindText: KIND_TEXT[k] || '',
      kindW: KIND_W[k] != null ? KIND_W[k] : 1,
      points: estimate(o)
    };
  }

  /** 档位表，用户端说明页直接照着渲染 */
  function ladder() {
    return [1, 2, 3, 4, 5].map(function (s) {
      return { severity: s, points: BASE[s] };
    });
  }

  function kindText(k) { return KIND_TEXT[k] || ''; }

  /* ---------------- 结算 ---------------- */

  function profileKey(kind, id) { return kind + ':' + id; }

  /**
   * 后勤办结后调用：给上报人加分，并把工单标成 resolved。
   *
   * 幂等——同一张工单点两次「完成」不会发两次钱，
   * 这点在演示时特别重要：台下有人会让你多点两下。
   *
   * @param {string} code  查询编码
   * @param {object} opts  { at: 时间戳, note: 覆盖时间线文案 }
   * @return {object} { ok, points, already, code, msg }
   */
  function settle(code, opts) {
    opts = opts || {};

    var codes = read(CODE_KEY, {}) || {};
    var key = String(code || '').trim().toUpperCase();
    var t = codes[key];

    if (!t) return { ok: false, code: key, msg: '没有这张工单' };

    if (t.reward && t.reward.paid) {
      return { ok: false, already: true, code: key, points: t.reward.points, msg: '这张工单的积分已经发过了' };
    }

    var now = opts.at || Date.now();
    var kind = kindOf(t);
    // 提交时算过的那个数就是承诺给用户的数，办结时必须发同样的数。
    // 只有老数据（没有 estPoints）才现算，避免规则改过之后前后不一致。
    var pts = typeof t.estPoints === 'number'
      ? t.estPoints
      : estimate({ severity: t.severity, type: t.type, kind: kind, merged: t.merged, status: t.status });

    // ---- 加分给上报人 ----
    var profs = read(PROF_KEY, {}) || {};
    var pk = profileKey(t.ownerKind || 'guest', t.ownerId || '');
    var prof = profs[pk];

    if (prof) {
      prof.points = (prof.points || 0) + pts;
      prof.resolvedCnt = (prof.resolvedCnt || 0) + 1;
      prof.at = now;
      profs[pk] = prof;
      write(PROF_KEY, profs);
    }

    // 当前这台设备正好是本人时，顺手把会话里那份也改了，
    // 否则用户得刷新一次才看见积分涨了——演示时这一步很掉分。
    var sess = read(AUTH_KEY, null);
    if (sess && sess.id === t.ownerId && sess.kind === (t.ownerKind || 'guest')) {
      sess.points = (sess.points || 0) + pts;
      sess.resolvedCnt = (sess.resolvedCnt || 0) + 1;
      write(AUTH_KEY, sess);
    }

    // ---- 工单本身 ----
    t.status = 'resolved';
    t.reward = {
      points: pts,
      at: now,
      paid: true,
      kind: kind,
      kindText: KIND_TEXT[kind]
    };
    t.timeline = t.timeline || [];
    t.timeline.push({
      at: now,
      label: opts.note || ('后勤已到场核实并处理完成 · ' + pts + ' 积分已到账'),
      tone: 'ok'
    });

    codes[key] = t;
    write(CODE_KEY, codes);

    return { ok: true, code: key, points: pts, kind: kind, answered: !!prof };
  }

  /**
   * 批量结算一组工单，返回总发放额。
   * 后台「合并工单」那种一次动几条的场景用它。
   */
  function settleMany(list, opts) {
    var total = 0, n = 0;
    (list || []).forEach(function (c) {
      var r = settle(c, opts);
      if (r.ok) { total += r.points; n++; }
    });
    return { count: n, points: total };
  }

  /** 只读查询：这张单子的积分发没发 */
  function statusOf(code) {
    var codes = read(CODE_KEY, {}) || {};
    var t = codes[String(code || '').trim().toUpperCase()];
    if (!t) return null;
    return {
      reward: t.reward || null,
      pending: t.reward ? 0 : (typeof t.estPoints === 'number' ? t.estPoints : estimate(t)),
      status: t.status
    };
  }

  return {
    BASE: BASE,
    estimate: estimate,
    breakdown: breakdown,
    ladder: ladder,
    kindText: kindText,
    settle: settle,
    settleMany: settleMany,
    statusOf: statusOf
  };
})();
