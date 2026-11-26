/* ==========================================================================
 * 见微 · 身份与激励
 * --------------------------------------------------------------------------
 * 为什么需要这一层：
 *
 * 众包报修最怕两件事——「不知道是谁报的」（责任无从追溯）和「报假了没代价」
 * （刷单、报复性乱报）。这个模块用三层数字把它们分开：
 *
 *   信用分 credit  0–100   资格。低于 60 的提交一律进人工复核。
 *   积分   points  只增     收益。**不在这里发**——后勤到场核实并处理完，
 *                           由 payout.js 按问题程度结算（20–90 分）；乱报 −20。
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

  /**
   * 从存储里重读当前档案。
   *
   * 后台办结工单时会直接往 profiles 里加积分（见 payout.js），
   * 但用户端内存里那份 session 还是旧的。切到「我的」或「积分乐园」
   * 时调一次，积分当场就涨了 —— 不用让人按刷新。
   */
  function refresh() {
    if (!session) return null;
    const store = read(KEY + '.profiles', {}) || {};
    const fresh = store[profileKey(session.kind, session.id)];
    if (fresh) {
      session = fresh;
      write(KEY, session);
      emit();
    }
    return session;
  }

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
   * 一次有效上报的结算 —— 只结信用与权重，**不发积分**。
   *
   * 积分为什么要留到后面：AI 说"通过"只代表这张照片像回事，不代表现场
   * 真的有东西可修。当场发钱等于奖励"会拍照"，也给刷单留了口子。
   * 真正结算在后勤办结那一步（见 payout.js），这里只把预估分
   * 算出来带回去，让用户当场知道"这单值多少、什么时候到"。
   *
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

    // 积分：这次一个子儿都不发，只把预估额带出去
    const estPoints = o.estPoints != null ? o.estPoints : 0;

    // 权重缓慢回血，但不会因为一次有效上报就洗白
    session.weight = Math.min(1.5, (session.weight || 1) + 0.02);

    persist();
    if (window.Ledger) {
      Ledger.push('credit', creditGain,
        o.merged ? '有效上报（与别人合并同一处）' : '有效上报通过', session.credit);
    }
    return { creditGain: creditGain, pointGain: 0, estPoints: estPoints, deferred: true };
  }

  /**
   * 问题被确认解决后的追加结算。
   * 保留它是为了兼容早期的调用方；新的结算一律走 Payout.settle，
   * 那边会按问题程度算分、写回工单时间线，也保证不会重复发。
   */
  function rewardResolved(points) {
    if (!session) return;
    const pts = typeof points === 'number' ? points : 30;
    session.resolvedCnt = (session.resolvedCnt || 0) + 1;
    session.points = (session.points || 0) + pts;
    session.credit = Math.min(100, session.credit + 3);
    persist();
    if (window.Ledger) {
      Ledger.push('points', pts, '问题已解决', session.points);
      Ledger.push('credit', 3, '问题已解决', session.credit);
    }
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
    if (window.Ledger) {
      var why = '被判定为无效上报' + (reason ? '：' + reason : '');
      Ledger.push('credit', -5, why, session.credit);
      Ledger.push('points', -20, why, session.points);
    }
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
   * 工单进度节点。
   * 一开始只写了一句"已提交"，用户点开只看到一行字，等于没进度。
   * 现在每个节点都带：谁做的（by）、什么角色、做了什么（label）、
   * 为什么/细节（note）、这一步之后的状态（state）。
   * 前台按时间轴渲染，后台在同一份数据上追加。
   */
  function buildInitTimeline(t) {
    var at = Date.now();
    var a = t.analysis || null;
    var st = t.status || 'pending';
    var list = [{
      at: at,
      label: '上报已提交',
      note: t.desc ? '描述：' + t.desc : '只传了照片，没有填写文字描述',
      by: '上报人',
      role: 'user',
      state: st,
      tone: 'ok'
    }];

    if (!a) {
      list.push({
        at: at + 1,
        label: '已转入人工复核池',
        note: '这条没有经过自动判定，等管理员人工确认',
        by: '系统',
        role: 'system',
        state: 'review',
        tone: 'warn'
      });
      return list;
    }

    var pass = a.pass !== false;
    var srcLabel = a.source === 'deepseek'
      ? (a.sawImage ? 'DeepSeek 看图判定' : 'DeepSeek 文本判定')
      : '本地规则引擎';
    var noteParts = [];
    if (a.seen) noteParts.push('画面：' + a.seen);
    if (a.detail) noteParts.push(a.detail);
    if (a.soft && a.qualityHint && a.qualityHint.message) {
      noteParts.push('画质存疑：' + a.qualityHint.message);
    }
    // 图文矛盾是用户自己点过头的，写进进度里，事后能对上账
    if (a.conflict) {
      noteParts.push(a.conflictAction === 'applied'
        ? '已按你确认的版本调整类型与描述'
        : '你选择保留原描述，已转人工重点核对');
    }
    if (a.noPhoto) noteParts.push('未附照片（这一类允许）');

    list.push({
      at: at + 1,
      label: pass ? 'AI 判定通过' : 'AI 判定未通过',
      note: noteParts.join('；') || (pass ? '照片与所选类型一致' : '未给出具体原因'),
      by: '哨兵智能体 · ' + srcLabel,
      role: 'ai',
      state: pass ? st : 'review',
      tone: pass ? '' : 'warn'
    });

    if (!pass || st === 'review') {
      list.push({
        at: at + 2,
        label: '已转入人工复核池',
        note: '等管理员看过现场照片再做决定',
        by: '系统',
        role: 'system',
        state: 'review',
        tone: 'warn'
      });
    } else {
      list.push({
        at: at + 2,
        label: '已按类型自动派单',
        note: (t.dept || '相关班组') + ' · 等待接单',
        by: '系统',
        role: 'system',
        state: st
      });
    }
    return list;
  }

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
      status: t.status || 'pending',   // pending | processing | resolved | review
      severity: t.severity,
      merged: !!t.merged,
      reporters: t.reporters || 1,
      // 奖励方式与预估积分：提交那一刻就定死，办结时按这个数发，
      // 不能等办结再算——规则改过了、或者后台改过紧急度，都会让
      // 用户看到的「预计 +65」和实际到账对不上。
      kind: t.kind || (t.merged ? 'crowd' : 'solo'),
      estPoints: typeof t.estPoints === 'number' ? t.estPoints : 0,
      ownerId: t.ownerId,
      ownerKind: t.ownerKind,
      // 下面三项是给后台"现场模式"看的：现场长什么样、说了什么、AI 怎么判的
      photo: t.photo || null,
      desc: t.desc || '',
      analysis: t.analysis || null,
      at: Date.now(),
      timeline: buildInitTimeline(t)
    };
    // 登记时就已经是 review 的（画质存疑 / 强制转人工），状态和最后一个节点要对上
    rec.status = rec.timeline[rec.timeline.length - 1].state || rec.status;
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

  /**
   * 全部工单，不分谁报的。
   * 后台"现场模式"靠它把现场真报上来的单子接进看板 ——
   * 三个端同源（同一个 github.io 域名），localStorage 是通的，
   * 所以手机上报一条，投屏上的后台几秒后就能看见。
   */
  function allTickets() {
    const codes = loadCodes();
    return Object.keys(codes)
      .map(function (k) { return codes[k]; })
      .sort(function (a, b) { return b.at - a.at; });
  }

  function advanceTicket(code, status, label, extra) {
    const codes = loadCodes();
    const c = normalizeCode(code);
    if (!codes[c]) return null;
    const e = extra || {};
    codes[c].status = status;
    codes[c].timeline = codes[c].timeline || [];
    codes[c].timeline.push({
      at: Date.now(),
      label: label,
      note: e.note || '',
      by: e.by || '后勤班组',
      role: e.role || 'crew',
      state: status,
      tone: status === 'resolved' ? 'ok' : (e.tone || '')
    });
    write(CODE_KEY, codes);
    return codes[c];
  }

  /**
   * 往一张工单上追加一条进度。
   * 后台抽屉里"记一条进展"走这个口子，前端只负责传文字。
   */
  function addTimeline(code, entry) {
    const codes = loadCodes();
    const c = normalizeCode(code);
    if (!codes[c]) return null;
    const e = entry || {};
    codes[c].timeline = codes[c].timeline || [];
    codes[c].timeline.push({
      at: e.at || Date.now(),
      label: e.label || '处理进展',
      note: e.note || '',
      by: e.by || '后勤班组',
      role: e.role || 'crew',
      state: e.state || codes[c].status,
      tone: e.tone || ''
    });
    if (e.status) codes[c].status = e.status;
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
      kind: 'crowd',
      estPoints: 25,                   // 3 星 45 分 × 并单 0.6 ≈ 25，还没办结
      at: Date.now() - 26 * 3600 * 1000,
      demo: true,
      timeline: [
        { at: Date.now() - 26 * 3600 * 1000, label: '上报已提交',
          note: '描述：连廊第二盏灯不亮，晚上看不清台阶',
          by: '上报人', role: 'user', state: 'pending', tone: 'ok' },
        { at: Date.now() - 26 * 3600 * 1000 + 4000, label: 'AI 判定通过',
          note: '画面：夜间连廊，第二盏灯不亮，其余灯正常；与所选「照明路灯」一致',
          by: '哨兵智能体 · DeepSeek 看图判定', role: 'ai', state: 'pending' },
        { at: Date.now() - 24 * 3600 * 1000, label: '又有 1 位同学上报同一处',
          note: '紧急度 2 星 → 3 星，已合并为一张工单，反馈人数 4 人',
          by: '系统', role: 'system', state: 'pending' },
        { at: Date.now() - 20 * 3600 * 1000, label: '已分派给 后勤保障部 · 水电班组',
          note: '李师傅接单，承诺 8 小时内到场',
          by: '调度台', role: 'admin', state: 'processing' },
        { at: Date.now() - 5 * 3600 * 1000, label: '维修师傅已到现场',
          note: '检查确认镇流器烧损，需回库领件，次日上午更换',
          by: '水电班组 · 李师傅', role: 'crew', state: 'processing' }
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
      kind: 'solo',
      estPoints: 70,
      reward: { points: 70, paid: true, kind: 'solo', kindText: '独立发现', at: Date.now() - 2 * 24 * 3600 * 1000 },
      at: Date.now() - 3 * 24 * 3600 * 1000,
      demo: true,
      timeline: [
        { at: Date.now() - 3 * 24 * 3600 * 1000, label: '上报已提交',
          note: '描述：12 号楼东侧路面一直有水，怀疑下水堵了',
          by: '上报人', role: 'user', state: 'pending', tone: 'ok' },
        { at: Date.now() - 3 * 24 * 3600 * 1000 + 3000, label: 'AI 判定通过',
          note: '画面：路面大片积水，反光，旁边是排水口；与所选「给排水」一致',
          by: '哨兵智能体 · DeepSeek 看图判定', role: 'ai', state: 'pending' },
        { at: Date.now() - 3 * 24 * 3600 * 1000 + 3600 * 1000, label: '已分派给 后勤保障部 · 水电班组',
          note: 'P1 工单，要求 8 小时内到场',
          by: '调度台', role: 'admin', state: 'processing' },
        { at: Date.now() - 2 * 24 * 3600 * 1000 - 3 * 3600 * 1000, label: '已到场排查',
          note: '确认下水口被落叶与泥沙堵死，管道本身无破损',
          by: '水电班组 · 何师傅', role: 'crew', state: 'processing' },
        { at: Date.now() - 2 * 24 * 3600 * 1000, label: '已疏通排水口并回填塌陷',
          note: '清出两桶淤积物，重新找坡，冲水试验排水正常',
          by: '水电班组 · 何师傅', role: 'crew', state: 'processing' },
        { at: Date.now() - 2 * 24 * 3600 * 1000 + 1800 * 1000, label: '处理完成，工单办结',
          note: '现场复核通过，70 积分已发放给上报人',
          by: '后勤保障部 · 值班主管', role: 'admin', state: 'resolved', tone: 'ok' }
      ]
    }
  };

  /* ---------------- 对外 ---------------- */

  return {
    get: get,
    refresh: refresh,
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
    allTickets: allTickets,
    advanceTicket: advanceTicket,
    addTimeline: addTimeline,
    normalizeCode: normalizeCode
  };
})();
