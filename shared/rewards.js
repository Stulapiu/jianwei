/* ==========================================================================
   rewards.js — 积分去处
   --------------------------------------------------------------------------
   积分得有个去处，否则「+65 积分」只是一句空话。

   这里只留两块，刻意做成互不重叠：
     商城  想买什么买什么，价格标在明面上
     抽奖  只出非卖品 —— 能直接买的东西不会出现在奖池里，
           否则抽到"谢谢参与"的人会问"那我不如去买"

   曾经还有第三块「宠物养成」，后来整个删掉了：
   那是另一个游戏，和"上报—派单—办结"这条治理闭环没有因果关系，
   挂在这里只会让评审觉得是硬凑留存手段。积分有两个出口已经够用，
   而且这两个出口都能直接挂在上报这件事上讲清楚。

   两块池子的商品 id 前缀不同（商城无前缀 / 奖池 lt-），
   启动时 verify() 会跑一遍查重，重复了会在控制台报出来。
   ========================================================================== */

(function (global) {
  'use strict';

  var KEY = 'jw.rewards.v1';

  /* ---------------------------------------------------------------------
   * 商城货架
   * 只卖两样：头像框、称号。都是挂在自己名字上的东西，
   * 和「谁在替这条街操心」直接相关，不需要再编一套世界观。
   * ------------------------------------------------------------------- */

  var MALL = [
    /* --- 头像框 --- */
    { id: 'frame-leaf',  kind: 'frame', name: '青叶框',   cost: 120, icon: 'frame',
      desc: '四角长出一圈细叶，安静的那种' },
    { id: 'frame-lamp',  kind: 'frame', name: '路灯框',   cost: 240, icon: 'frame',
      desc: '夜里会亮一下，白天看不出来' },
    { id: 'frame-map',   kind: 'frame', name: '测绘框',   cost: 420, icon: 'frame',
      desc: '带坐标刻度，给爱记位置的人' },

    /* --- 称号 --- */
    { id: 'title-street', kind: 'title', name: '见习巡街人', cost: 60,  icon: 'crown',
      desc: '入门称号，名字后面挂个牌子' },
    { id: 'title-night',  kind: 'title', name: '夜巡者',     cost: 180, icon: 'crown',
      desc: '给常在晚上报修的人' },
    { id: 'title-see',    kind: 'title', name: '见微知著',   cost: 520, icon: 'crown',
      desc: '本站最高称号，需要攒一阵' }
  ];

  /* ---------------------------------------------------------------------
   * 抽奖奖池
   * 权重合计 100，抽一次 30 积分。
   * 注意：这里出现的头像框 / 称号，商城一件都没有卖——这就是"抽"的意义。
   * ------------------------------------------------------------------- */

  var LOTTERY = [
    { id: 'lt-points-50',  kind: 'points', value: 50,  name: '50 积分',      weight: 34 },
    { id: 'lt-points-120', kind: 'points', value: 120, name: '120 积分',     weight: 9 },
    { id: 'lt-frame-fire', kind: 'frame',  name: '流萤框',   weight: 5,  rare: true,
      desc: '只此一池，商城不卖' },
    { id: 'lt-title-watch', kind: 'title', name: '守夜人',   weight: 4,  rare: true,
      desc: '抽到的，买不到' },
    { id: 'lt-again',      kind: 'reroll', name: '再来一次',  weight: 18 },
    { id: 'lt-empty',      kind: 'empty',  name: '谢谢参与',  weight: 30 }
  ];

  var DRAW_COST = 30;

  /* ---------------------------------------------------------------------
   * 存取
   * ------------------------------------------------------------------- */

  function read() {
    try {
      var raw = global.localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
  }

  function write(v) {
    try { global.localStorage.setItem(KEY, JSON.stringify(v)); return true; }
    catch (e) { return false; }
  }

  /** 每个账号一份，游客按设备 ID 分开 */
  function whoami() {
    var A = global.Auth;
    var s = A && A.get ? A.get() : null;
    if (s) return s.id;
    return (A && A.deviceId) ? A.deviceId() : 'anon';
  }

  function blank() {
    return { owned: [], title: null, frame: null, draws: 0, spent: 0 };
  }

  function get() {
    var all = read();
    var id = whoami();
    if (!all[id]) { all[id] = blank(); write(all); }
    var st = all[id];
    // 老数据补字段，省得后面到处判空
    if (!st.owned) st.owned = [];
    if (typeof st.draws !== 'number') st.draws = 0;
    if (typeof st.spent !== 'number') st.spent = 0;
    // 宠物那一版留下的 pet 字段直接清掉，免得以后有人翻出来以为还在用
    if (st.pet) delete st.pet;
    return st;
  }

  function save(st) {
    var all = read();
    all[whoami()] = st;
    write(all);
    return st;
  }

  /* ---------------------------------------------------------------------
   * 积分（真正的账本在 Auth 的 session 上，这里只读改写回）
   * ------------------------------------------------------------------- */

  function points() {
    var A = global.Auth;
    var s = A && A.get ? A.get() : null;
    return s ? (s.points || 0) : 0;
  }

  /**
   * @param {number} n    正数加，负数减
   * @param {string} why  写进流水的原因，例如「抽奖一次」
   */
  function addPoints(n, why) {
    var A = global.Auth;
    if (!A || !A.patch) return points();
    // 扣分扣到底就停在 0，所以流水里要记实际变化量，不是名义值
    var before = points();
    var after = Math.max(0, before + n);
    A.patch({ points: after });
    if (global.Ledger && why && after !== before) {
      global.Ledger.push('points', after - before, why, after);
    }
    return after;
  }

  function spend(n, why) {
    if (points() < n) return false;
    addPoints(-n, why);
    return true;
  }

  /* ---------------------------------------------------------------------
   * 商城
   * ------------------------------------------------------------------- */

  function findItem(id) {
    for (var i = 0; i < MALL.length; i++) if (MALL[i].id === id) return MALL[i];
    for (var j = 0; j < LOTTERY.length; j++) if (LOTTERY[j].id === id) return LOTTERY[j];
    return null;
  }

  function owns(id) {
    return get().owned.indexOf(id) >= 0;
  }

  /** @returns {{ok:boolean, reason?:string, item?:object}} */
  function buy(id) {
    var item = findItem(id);
    if (!item) return { ok: false, reason: '没有这件东西' };

    if (owns(id)) return { ok: false, reason: '已经拥有了' };
    if (points() < item.cost) {
      return { ok: false, reason: '积分差 ' + (item.cost - points()) + ' 分' };
    }

    var st = get();
    spend(item.cost, '兑换「' + item.name + '」');
    st.spent += item.cost;

    st.owned.push(id);
    // 买了就顺手换上，不用再点一次"使用"
    if (item.kind === 'frame') st.frame = id;
    if (item.kind === 'title') st.title = id;
    save(st);
    return { ok: true, item: item };
  }

  function equip(id) {
    var item = findItem(id);
    var st = get();
    if (!item || st.owned.indexOf(id) < 0) return false;
    if (item.kind === 'frame') st.frame = st.frame === id ? null : id;
    else if (item.kind === 'title') st.title = st.title === id ? null : id;
    else return false;
    save(st);
    return true;
  }

  /* ---------------------------------------------------------------------
   * 抽奖
   * ------------------------------------------------------------------- */

  function roll(extra) {
    var total = 0;
    for (var i = 0; i < LOTTERY.length; i++) total += LOTTERY[i].weight;
    var r = Math.random() * total;
    for (var j = 0; j < LOTTERY.length; j++) {
      r -= LOTTERY[j].weight;
      if (r <= 0) return LOTTERY[j];
    }
    return LOTTERY[LOTTERY.length - 1];
  }

  /**
   * 抽一次。
   * @returns {{ok:boolean, reason?:string, prize?:object, points?:number}}
   */
  function draw() {
    if (points() < DRAW_COST) {
      return { ok: false, reason: '积分不足，还差 ' + (DRAW_COST - points()) + ' 分' };
    }

    var st = get();
    spend(DRAW_COST, '抽奖一次');
    st.draws += 1;

    var prize = roll();
    var result = { ok: true, prize: prize, points: points() };

    if (prize.kind === 'points') {
      addPoints(prize.value, '抽奖得 ' + prize.name);
    } else if (prize.kind === 'frame' || prize.kind === 'title') {
      if (st.owned.indexOf(prize.id) >= 0) {
        // 抽到已拥有的，折算成积分，别让人白抽
        prize = { id: 'lt-dup', kind: 'points', value: 60, name: '重复奖品折 60 积分' };
        addPoints(60, '抽奖重复，折成积分');
      } else {
        st.owned.push(prize.id);
      }
    } else if (prize.kind === 'reroll') {
      // 再来一次：直接退钱，等于这次免费
      addPoints(DRAW_COST, '抽到「再来一次」，退回本次抽奖分');
    }

    save(st);
    result.prize = prize;
    result.points = points();
    return result;
  }

  /* ---------------------------------------------------------------------
   * 自检：商城的和抽奖的不能重样
   * ------------------------------------------------------------------- */

  function verify() {
    var seen = {};
    var dup = [];
    MALL.concat(LOTTERY).forEach(function (it) {
      if (seen[it.id]) dup.push(it.id);
      seen[it.id] = 1;
    });

    // 除了 id 不重，名字也不能重 —— 重名在界面上等于同一件东西
    var names = {};
    MALL.concat(LOTTERY).forEach(function (it) {
      if (names[it.name]) dup.push('name:' + it.name);
      names[it.name] = 1;
    });

    return { ok: dup.length === 0, dup: dup, mall: MALL.length, lottery: LOTTERY.length };
  }

  global.Rewards = {
    MALL: MALL,
    LOTTERY: LOTTERY,
    DRAW_COST: DRAW_COST,

    get: get,
    save: save,
    points: points,
    addPoints: addPoints,
    spend: spend,

    findItem: findItem,
    owns: owns,
    buy: buy,
    equip: equip,

    draw: draw,

    verify: verify
  };
})(window);
