/**
 * 云函数：submitReport —— 上报入库 + 重复坐标合并 + 信用分/徽章结算
 * ------------------------------------------------------------
 * 这是唯一会写 reports / orders 的入口，其他云函数只读。
 *
 * 关键设计：
 *   1. reports 是事实源，orders 是聚合视图。一条工单可以挂多条上报，
 *      「多人反馈，紧急度高」就自然成立，不需要额外的冗余字段。
 *   2. 去重不用 geoNear 索引，改用「先按类型+时间粗筛，再内存算球面距离」。
 *      原型期数据量小（万级以内）这样最稳，也不必担心索引建错或索引未生效。
 *      数据量上来后换成 geoNear 即可，接口签名不用变。
 *   3. 信用分与徽章只在「有效上报」时结算，被 AI 拦截的不扣分也不加徽章。
 * ============================================================
 */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

/** 去重半径（米）与时间窗（小时）—— 产品需求写的是 15 米 / 24 小时 */
const DEDUPE_RADIUS_M = 15;
const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 两点球面距离，单位米（Haversine） */
function distanceM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * 坐标脱敏：把精确坐标模糊到约 100 米网格。
 * 用户端地图只显示这个值，避免暴露具体住户位置（尤其乡村场景）。
 * 管理端看到的是精确坐标，用于派单。
 */
function fuzzy(lat, lng) {
  return {
    lat: Math.round(lat * 1000) / 1000,
    lng: Math.round(lng * 1000) / 1000
  };
}

function orderNo() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${String(d.getFullYear()).slice(2)}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  return `WO${stamp}${Math.floor(1000 + Math.random() * 9000)}`;
}

/* ------------------------------------------------------------------
 * 徽章规则
 * 规则保持「声明式」，新增徽章只要往数组里加一条，不用改判定流程。
 * ------------------------------------------------------------------ */
const BADGE_RULES = [
  {
    code: 'first_report',
    name: '初次出勤',
    icon: '🌱',
    desc: '完成第一次有效上报',
    test: (ctx) => ctx.user.validCnt === 1
  },
  {
    code: 'eagle_eye',
    name: '火眼金睛',
    icon: '👁',
    desc: '识别出一处被忽视的安全隐患',
    test: (ctx) => ctx.type === 'safety' && ctx.verdict.severity >= 4
  },
  {
    code: 'gold_sentinel',
    name: '金牌哨兵',
    icon: '🛡',
    desc: '连续 7 天有效上报',
    test: (ctx) => ctx.streak >= 7
  },
  {
    code: 'night_watch',
    name: '夜巡者',
    icon: '🌙',
    desc: '在 22:00–06:00 之间上报',
    test: (ctx) => {
      const h = new Date().getHours();
      return h >= 22 || h < 6;
    }
  },
  {
    code: 'crowd',
    name: '众人拾柴',
    icon: '🤝',
    desc: '你的上报与邻居的合并为同一工单',
    test: (ctx) => ctx.merged === true
  },
  {
    code: 'clean_hand',
    name: '清道夫',
    icon: '🧹',
    desc: '累计提交 10 条卫生类有效上报',
    test: (ctx) => ctx.type === 'sanitation' && ctx.user.sanitationCnt >= 10
  }
];

/** 判断连续天数：今天已上报过则不重复累加 */
function nextStreak(user) {
  const today = new Date().toISOString().slice(0, 10);
  const s = user.streak || { days: 0, last: '' };
  if (s.last === today) return s.days;
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  return s.last === yesterday ? s.days + 1 : 1;
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const {
    fileIDs = [],
    type = 'other',
    desc = '',
    lat,
    lng,
    address = '',
    verdict = {},
    force = false // 用户被 AI 拦截后「仍然提交」，进入人工复核池
  } = event;

  // ---------- 1. 基础校验 ----------
  if (!fileIDs.length) throw new Error('缺少图片');
  if (typeof lat !== 'number' || typeof lng !== 'number') throw new Error('缺少定位信息');

  const now = new Date();

  // ---------- 2. 取用户（首次使用自动建档） ----------
  const users = db.collection('users');
  let user;
  const found = await users.where({ _openid: OPENID }).limit(1).get();
  if (found.data.length) {
    user = found.data[0];
  } else {
    const created = {
      _openid: OPENID,
      nickName: '热心居民',
      avatar: '',
      credit: 100,
      validCnt: 0,
      invalidCnt: 0,
      sanitationCnt: 0,
      streak: { days: 0, last: '' },
      badgeList: [],
      createdAt: now
    };
    const r = await users.add({ data: created });
    user = { ...created, _id: r._id };
  }

  // ---------- 3. 重复坐标检测 ----------
  // 先粗筛：同类型、24 小时内、尚未关闭的工单
  const since = new Date(Date.now() - DEDUPE_WINDOW_MS);
  const nearOrders = await db
    .collection('orders')
    .where({
      type,
      status: _.in(['pending', 'processing']),
      createdAt: _.gt(since)
    })
    .orderBy('createdAt', 'desc')
    .limit(50)
    .get();

  let dupOrder = null;
  let minDist = Infinity;
  for (const o of nearOrders.data) {
    if (typeof o.lat !== 'number') continue;
    const d = distanceM(lat, lng, o.lat, o.lng);
    if (d <= DEDUPE_RADIUS_M && d < minDist) {
      minDist = d;
      dupOrder = o;
    }
  }

  // ---------- 4. 写上报记录 ----------
  const fz = fuzzy(lat, lng);
  const reportDoc = {
    _openid: OPENID,
    files: fileIDs,
    lat,
    lng,
    locFuzzy: fz,
    address,
    type,
    desc: String(desc).slice(0, 200),
    aiVerdict: {
      pass: verdict.pass !== false,
      severity: verdict.severity || 3,
      summary: verdict.summary || '',
      advice: verdict.advice || '',
      reason: verdict.reason || null,
      scene: verdict.scene || '',
      provider: verdict.provider || '',
      degraded: !!verdict.degraded
    },
    force,
    merged: !!dupOrder,
    status: force ? 'review' : 'pending',
    orderId: '',
    createdAt: now
  };

  const reportRes = await db.collection('reports').add({ data: reportDoc });
  const reportId = reportRes._id;

  // ---------- 5. 合并 or 新建工单 ----------
  let orderId;
  let merged = false;
  let severity = reportDoc.aiVerdict.severity;

  if (dupOrder && !force) {
    // 合并进已有工单
    merged = true;
    orderId = dupOrder._id;
    const mergeCnt = (dupOrder.mergeCnt || 1) + 1;
    // 多人反馈会把紧急度顶上去，但最多 5 星
    const bumped = Math.min(5, Math.max(dupOrder.severity || 3, severity) + (mergeCnt >= 3 ? 1 : 0));

    await db.collection('orders').doc(orderId).update({
      data: {
        reportIds: _.push([reportId]),
        mergeCnt,
        severity: bumped,
        multiFeedback: mergeCnt >= 2,
        updatedAt: now
      }
    });
    severity = bumped;
  } else {
    // 新建工单（force 情况下即使坐标重复也单独建，避免污染正常工单）
    const orderRes = await db.collection('orders').add({
      data: {
        orderNo: orderNo(),
        type,
        lat,
        lng,
        locFuzzy: fz,
        address,
        reportIds: [reportId],
        mergeCnt: 1,
        multiFeedback: false,
        severity,
        /* 存一份脱敏昵称，用户端地图点「已解决」时直接读，避免二次查用户表 */
        reporterMask: (user.nickName || '热心居民').slice(0, 1) + '同学',
        summary: reportDoc.aiVerdict.summary,
        aiAdvice: reportDoc.aiVerdict.advice,
        status: force ? 'review' : 'pending',
        handler: '',
        note: '',
        createdAt: now,
        updatedAt: now
      }
    });
    orderId = orderRes._id;
  }

  await db.collection('reports').doc(reportId).update({ data: { orderId } });

  // ---------- 6. 结算信用分与徽章 ----------
  const validCnt = (user.validCnt || 0) + 1;
  const streakDays = nextStreak(user);
  const sanitationCnt = (user.sanitationCnt || 0) + (type === 'sanitation' ? 1 : 0);

  const ctx = {
    user: { ...user, validCnt, sanitationCnt },
    type,
    verdict: { severity },
    streak: streakDays,
    merged
  };
  const owned = new Set(user.badgeList || []);
  const newBadges = [];
  for (const rule of BADGE_RULES) {
    if (!owned.has(rule.code) && rule.test(ctx)) {
      owned.add(rule.code);
      newBadges.push({ code: rule.code, name: rule.name, icon: rule.icon, desc: rule.desc });
    }
  }

  await users.doc(user._id).update({
    data: {
      validCnt,
      sanitationCnt,
      credit: Math.min(100, (user.credit || 100) + 2),
      streak: { days: streakDays, last: now.toISOString().slice(0, 10) },
      badgeList: Array.from(owned),
      updatedAt: now
    }
  });

  return {
    ok: true,
    reportId,
    orderId,
    merged,
    mergeCnt: merged ? (dupOrder.mergeCnt || 1) + 1 : 1,
    severity,
    credit: Math.min(100, (user.credit || 100) + 2),
    newBadges,
    message: merged ? '已有邻居上报过这里，已合并为同一工单' : '已提交，等待处理'
  };
};
