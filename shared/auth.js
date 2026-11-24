/* ==========================================================================
 * 见微 · 身份与激励
 * --------------------------------------------------------------------------
 * 为什么需要这一层：
 *
 * 众包报修最怕两件事——「不知道是谁报的」（责任无从追溯）和「报假了没代价」
 * （刷单、报复性乱报）。这个模块用三层数字把它们分开：
 *
 *   信用分 credit  0–100   资格。低于 60 的提交一律进人工复核。
 *   积分   points  只增     收益。有效上报 +10，问题被解决 +30，乱报 −20。
 *   权重   weight  0.3–1.5  投票权。乱报会衰减；权重低的账号不给别人的工单"抬票"。
 *
 * 三者互不替代：信用分低但积分高的人可以继续报（只是要人看一眼），
 * 权重低的人报同一处问题不会把优先级刷上去——这就是防刷的核心。
 *
 * 身份有三种：
 *   school  学号一键登录（演示环境不校验密码，真实环境接教务 CAS）
 *   phone   手机号 + 短信验证码
 *   guest   不登录。本机生成设备 ID，提交后拿到查询编码，凭编码查进度。
 *
 * 所有数据存 localStorage，换浏览器就没了——这是演示版，不是真实账号系统。
 * ========================================================================== */

window.Auth = (function () {
  'use strict';

  const KEY = 'jw.auth.v2';
  const CODE_KEY = 'jw.codes.v2';

  /* ---------------- 存储 ---------------- */

  function read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }

  function write(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); return true; }
    catch (e) { return false; }
  }

  /* ---------------- 设备指纹（游客身份） ---------------- */

  function deviceId() {
    let id = read('jw.dev', null);
    if (id) return id;
    const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
    id = 'DEV-' + rand;
    write('jw.dev', id);
    return id;
  }

  /* ---------------- 初始档案 ---------------- */

  function blank(kind, id, name) {
    return {
      kind: kind,                 // school | phone | guest
      id: id,
      name: name,
      credit: 70,                 // 信用分：新人从 70 起，及格线 60
      points: 0,                  // 积分：只增不减（乱报会扣，但不会到负数）
      weight: 1,                  // 账号权重：影响合并时是否计入人数
      validCnt: 0,
      resolvedCnt: 0,
      invalidCnt: 0,
      at: Date.now()
    };
  }

  let session = read(KEY, null);

  const listeners = [];
  function emit() {
    listeners.forEach(function (fn) { try { fn(session); } catch (e) {} });
  }

  /* ---------------- 登录 ---------------- */

  /** 学号校验：郑大学号 10 位数字；演示环境接受 8–12 位 */
  function checkSchoolId(v) {
    const s = String(v || '').trim();
    if (!/^\d{8,12}$/.test(s)) return { ok: false, msg: '学号应该是 8–12 位数字' };
    return { ok: true, id: s };
  }

  /** 手机号校验：11 位，1 开头，第二位 3–9 */
  function checkPhone(v) {
    const s = String(v || '').replace(/\s|-/g, '');
    if (!/^1[3-9]\d{9}$/.test(s)) return { ok: false, msg: '手机号格式不对，应该是 11 位' };
    return { ok: true, id: s };
  }

  /** 从手机号里取一个可展示的别名，避免在界面上暴露完整号码 */
  function maskPhone(p) { return p.slice(0, 3) + '****' + p.slice(-4); }

  /** 演示用：同一学号第二次登录要能拿回原来的记录，所以按 id 存档案 */
  function profileKey(kind, id) { return kind + ':' + id; }

  function login(opts) {
    const kind = opts.kind;
    const store = read(KEY + '.profiles', {}) || {};
    let prof;

    if (kind === 'school') {
      const c = checkSchoolId(opts.id);
      if (!c.ok) return { ok: false, msg: c.msg };
      prof = store[profileKey('school', c.id)] || blank('school', c.id, opts.name || ('学号 ' + c.id.slice(-4) + ' 同学'));
      prof.kind = 'school';
      prof.id = c.id;
    } else if (kind === 'phone') {
      const c = checkPhone(opts.id);
      if (!c.ok) return { ok: false, msg: c.msg };
      if (!opts.code) return { ok: false, needCode: true, msg: '请输入验证码' };
      if (String(opts.code).length !== 6) return { ok: false, msg: '验证码是 6 位' };
      prof = store[profileKey('phone', c.id)] || blank('phone', c.id, maskPhone(c.id));
      prof.kind = 'phone';
      prof.id = c.id;
      prof.name = maskPhone(c.id);
    } else {
      const id = deviceId();
      prof = store[profileKey('guest', id)] || blank('guest', id, '游客');
      prof.kind = 'guest';
      prof.id = id;
      prof.name = '游客';
      prof.guest = true;
    }

    store[profileKey(prof.kind, prof.id)] = prof;
    write(KEY + '.profiles', store);

    session = prof;
    write(KEY, session);
    emit();
    return { ok: true, user: session };
  }

  function loginGuest() { return login({ kind: 'guest' }); }

  function logout() {
    session = null;
    write(KEY, null);
    emit();
  }

  /** 页面刷新后恢复；没有会话返回 null */
  function get() { return session; }

  function isGuest() { return !session || session.kind === 'guest'; }

  function relabel(name) {
    if (!session) return;
    session.name = name;
    persist();
  }

  /** 批量写入档案字段（徽章、连续天数这类只属于展示层的状态） */
  function patch(obj) {
    if (!session) return null;
    Object.keys(obj || {}).forEach(function (k) { session[k] = obj[k]; });
    persist();
    return session;
  }

  function persist() {
    if (!session) return;
    const store = read(KEY + '.profiles', {}) || {};
    store[profileKey(session.kind, session.id)] = session;
    write(KEY + '.profiles', store);
    write(KEY, session);
    emit();
  }

  /* ---------------- 积分 / 信用 / 权重 ---------------- */

  const TIERS = [
    { min: 90, name: '金牌哨兵', color: '#B4832A' },
    { min: 75, name: '守信哨兵', color: '#2B7A78' },
    { min: 60, name: '见习哨兵', color: '#6B7C7A' },
    { min: 0,  name: '待提升',   color: '#C9553D' }
  ];

  function tierOf(credit) {
    for (let i = 0; i < TIERS.length; i++) if (credit >= TIERS[i].min) return TIERS[i];
    return TIERS[TIERS.length - 1];
  }

  /**
   * 一次有效上报的结算。
   * @param {boolean} merged    是否并入了已有工单
   * @param {boolean} crowd     是否属于"多人报同一处"
   */
  function rewardValid(opts) {
    if (!session) return null;
    const o = opts || {};
    session.validCnt = (session.validCnt || 0) + 1;

    // 学分：有效 +2，封顶 100
    const creditGain = o.merged ? 1 : 2;
    session.credit = Math.min(100, session.credit + creditGain);

    // 积分：独立分 +10；顺手帮别人合并算半份，避免刷单
    const pointGain = o.merged ? 5 : 10;
    session.points = (session.points || 0) + pointGain;

    // 权重缓慢回血，但不会因为一次有效上报就洗白
    session.weight = Math.min(1.5, (session.weight || 1) + 0.02);

    persist();
    return { creditGain: creditGain, pointGain: pointGain };
  }

  /** 问题被确认解决后的追加结算 */
  function rewardResolved() {
    if (!session) return;
    session.resolvedCnt = (session.resolvedCnt || 0) + 1;
    session.points = (session.points || 0) + 30;
    session.credit = Math.min(100, session.credit + 3);
    persist();
  }

  /**
   * 被判定为无效 / 恶意上报。
   * 注意：AI 拦下来不算惩罚——AI 是建议，误判成本不该让用户承担。
   * 只有人工复核确认「乱报」才走这里。
   */
  function penalize(reason) {
    if (!session) return null;
    session.invalidCnt = (session.invalidCnt || 0) + 1;
    session.credit = Math.max(0, session.credit - 5);
    session.points = Math.max(0, (session.points || 0) - 20);
    session.weight = Math.max(0.3, +((session.weight || 1) * 0.82).toFixed(3));
    persist();
    return { credit: -5, points: -20, weight: session.weight, reason: reason || '' };
  }

  /** 权重是否够格给别人的工单"抬票" */
  function countsAsVoter() {
    return !!session && (session.weight || 1) >= 0.6;
  }

  /** 是否需要强制人工复核 */
  function needsHumanReview() {
    return !session || session.credit < 60 || (session.weight || 1) < 0.6;
  }

  function weightLabel(w) {
    if (w >= 1.2) return '高';
    if (w >= 0.9) return '正常';
    if (w >= 0.6) return '偏低';
    return '受限';
  }

  /* ---------------- 查询编码 ---------------- */

  // 去掉容易混淆的 0/O、1/I，用户口头念、手抄都不容易错
  const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

  function newCode() {
    let s = '';
    for (let i = 0; i < 6; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    return 'JW-' + s;
  }

  function loadCodes() { return read(CODE_KEY, {}) || {}; }

  /**
   * 提交成功时登记一条编码。
   * 一条编码对应一张工单，里面记了上报人（游客也能追溯到自己这台设备）。
   */
  function registerTicket(t) {
    const codes = loadCodes();
    let code = t.code || newCode();
    while (codes[code]) code = newCode();          // 撞号就重生成
    const rec = {
      code: code,
      type: t.type,
      addr: t.addr,
      lng: t.lng, lat: t.lat,
      dept: t.dept,
      status: 'pending',              // pending | processing | resolved | review
      severity: t.severity,
      merged: !!t.merged,
      reporters: t.reporters || 1,
      ownerId: t.ownerId,
      ownerKind: t.ownerKind,
      at: Date.now(),
      timeline: [{ at: Date.now(), label: '已提交，进入待派单池', tone: 'ok' }]
    };
    codes[code] = rec;
    write(CODE_KEY, codes);
    return rec;
  }

  function normalizeCode(v) {
    return String(v || '').trim().toUpperCase().replace(/\s/g, '').replace(/^([A-Z0-9]{6})$/, 'JW-$1');
  }

  function findTicket(code) {
    const c = normalizeCode(code);
    const codes = loadCodes();
    if (codes[c]) return codes[c];
    // 演示兜底：几个写死的编码，方便在别人电脑上演示查询效果
    return DEMO_TICKETS[c] || null;
  }

  function myTickets() {
    const codes = loadCodes();
    const id = session ? session.id : deviceId();
    return Object.keys(codes)
      .map(function (k) { return codes[k]; })
      .filter(function (t) { return t.ownerId === id; })
      .sort(function (a, b) { return b.at - a.at; });
  }

  function advanceTicket(code, status, label) {
    const codes = loadCodes();
    const c = normalizeCode(code);
    if (!codes[c]) return null;
    codes[c].status = status;
    codes[c].timeline.push({ at: Date.now(), label: label, tone: status === 'resolved' ? 'ok' : '' });
    write(CODE_KEY, codes);
    return codes[c];
  }

  /* 演示用固定编码：换台电脑也能查到进度 */
  const DEMO_TICKETS = {
    'JW-8F3K2M': {
      code: 'JW-8F3K2M',
      type: 'lighting',
      addr: '图书馆南广场 · 东侧路灯',
      dept: '后勤保障部 · 水电班组',
      status: 'processing',
      severity: 3,
      merged: true,
      reporters: 4,
      at: Date.now() - 26 * 3600 * 1000,
      demo: true,
      timeline: [
        { at: Date.now() - 26 * 3600 * 1000, label: '已提交，进入待派单池', tone: 'ok' },
        { at: Date.now() - 24 * 3600 * 1000, label: '又有 1 位同学上报同一处，紧急度升到 3 星' },
        { at: Date.now() - 20 * 3600 * 1000, label: '已分派给 后勤保障部 · 水电班组' },
        { at: Date.now() - 5 * 3600 * 1000, label: '维修师傅已到现场，等待更换灯管' }
      ]
    },
    'JW-Q7M4TP': {
      code: 'JW-Q7M4TP',
      type: 'water',
      addr: '柳园宿舍区 · 12 号楼东侧',
      dept: '后勤保障部 · 水电班组',
      status: 'resolved',
      severity: 4,
      merged: false,
      reporters: 1,
      at: Date.now() - 3 * 24 * 3600 * 1000,
      demo: true,
      timeline: [
        { at: Date.now() - 3 * 24 * 3600 * 1000, label: '已提交，进入待派单池', tone: 'ok' },
        { at: Date.now() - 3 * 24 * 3600 * 1000 + 3600 * 1000, label: '已分派给 后勤保障部 · 水电班组' },
        { at: Date.now() - 2 * 24 * 3600 * 1000, label: '已疏通排水口，回填塌陷' },
        { at: Date.now() - 2 * 24 * 3600 * 1000 + 1800 * 1000, label: '处理完成，感谢你的上报', tone: 'ok' }
      ]
    }
  };

  /* ---------------- 对外 ---------------- */

  return {
    get: get,
    login: login,
    loginGuest: loginGuest,
    logout: logout,
    relabel: relabel,
    patch: patch,
    isGuest: isGuest,
    deviceId: deviceId,
    onChange: function (fn) { listeners.push(fn); },

    checkSchoolId: checkSchoolId,
    checkPhone: checkPhone,
    maskPhone: maskPhone,

    rewardValid: rewardValid,
    rewardResolved: rewardResolved,
    penalize: penalize,
    countsAsVoter: countsAsVoter,
    needsHumanReview: needsHumanReview,
    weightLabel: weightLabel,
    tierOf: tierOf,
    TIERS: TIERS,

    newCode: newCode,
    registerTicket: registerTicket,
    findTicket: findTicket,
    myTickets: myTickets,
    advanceTicket: advanceTicket,
    normalizeCode: normalizeCode
  };
})();
