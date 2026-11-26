/* ==========================================================================
 * ledger.js — 信用分 / 积分的流水账
 * --------------------------------------------------------------------------
 * 为什么单独记一本账：
 *
 * 「积分 640」这个数字本身没有说服力。用户真正会问的是三句话——
 * 「这 80 分是哪来的」「上次那 20 分为啥扣了」「怎么比昨天还少了」。
 * 只存余额答不了这些，所以每动一次，就留一条：什么时候、因为什么、±多少、之后剩多少。
 *
 * 两条原则：
 *   1. 只记已经发生的，不记"预计"。预估 80 分写在工单上，不入账；
 *      办结到账那一刻才进流水。否则用户会以为已经拿到了。
 *   2. 余额一起存。只存增量的话，一旦有别的路径改过余额（比如后台补发），
 *      流水和现实就对不上，解释起来反而更费劲。
 *
 * 存在 localStorage，按用户 id（学号 / 手机号 / 设备号）分桶，最多留 120 条。
 * ========================================================================== */

window.Ledger = (function (global) {
  'use strict';

  var KEY = 'jw.ledger.v1';
  var MAX = 120;

  function read() {
    try {
      var raw = localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
  }

  function write(v) {
    try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) { /* 满了就算了 */ }
  }

  /** 同一个人在不同端（游客设备号 / 登录账号）是两个桶，这里取当前身份 */
  function who() {
    var A = global.Auth;
    var s = A && A.get ? A.get() : null;
    if (s && s.id) return s.id;
    return A && A.deviceId ? A.deviceId() : 'anon';
  }

  /**
   * @param {'credit'|'points'} kind
   * @param {number} delta   正负都行
   * @param {string} why     给人看的原因，别写英文键名
   * @param {number} after   变动后的余额
   */
  function push(kind, delta, why, after) {
    var d = Math.round(Number(delta) || 0);
    if (!d) return;
    var all = read();
    var id = who();
    var arr = all[id] || (all[id] = []);
    arr.unshift({
      at: Date.now(),
      k: kind,
      d: d,
      why: why || '',
      after: after != null ? Math.round(Number(after)) : null
    });
    if (arr.length > MAX) arr.length = MAX;
    all[id] = arr;
    write(all);
  }

  function list(kind) {
    var arr = read()[who()] || [];
    if (!kind) return arr;
    return arr.filter(function (e) { return e.k === kind; });
  }

  function sum(kind) {
    return list(kind).reduce(function (n, e) { return n + e.d; }, 0);
  }

  function clear() {
    var all = read();
    delete all[who()];
    write(all);
  }

  return { push: push, list: list, sum: sum, clear: clear, who: who, KEY: KEY };
})(window);
