/**
 * 云函数：api —— 三端共用数据接口（读写查询统一入口）
 * ------------------------------------------------------------
 * 为什么合并成一个云函数？
 *   原型期部署单元越少越好。20 个细碎云函数会让「改一处、三端同步」
 *   变成噩梦。这里用 action 路由，内部再拆 handler，逻辑依然是分开的。
 *
 * action 一览：
 *   mapPoints      用户端地图点位（脱敏）
 *   myProfile      个人中心
 *   myReports      我的上报列表
 *   markInvalid    记录一次无效提交（AI 拦截后调用）
 *   dashboard      管理端看板
 *   orderList      工单列表（筛选/分页）
 *   orderDetail    工单详情（含原始图片）
 *   orderUpdate    标记处理中 / 已完成 / 驳回，并回写上报状态
 * ============================================================
 */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

/* ------------------------------------------------------------------
 * 工具
 * ------------------------------------------------------------------ */

/**
 * 分页拉全量。云函数单次 get 上限 100 条，超过要自己翻页。
 * max 是保护阈值，防止误查把云函数内存打爆。
 */
async function fetchAll(query, max = 800) {
  const pageSize = 100;
  let all = [];
  let skip = 0;
  while (all.length < max) {
    const res = await query.skip(skip).limit(pageSize).get();
    all = all.concat(res.data);
    if (res.data.length < pageSize) break;
    skip += pageSize;
  }
  return all;
}

const DAY = 86400000;

/** 昵称脱敏：李小明 → 李同学；空值 → 热心居民 */
function maskName(name) {
  if (!name) return '热心居民';
  return String(name).slice(0, 1) + '同学';
}

function dayKey(d) {
  const t = new Date(d);
  return `${t.getMonth() + 1}/${t.getDate()}`;
}

/**
 * 管理员校验。
 * 优先读环境变量 ADMIN_OPENIDS（逗号分隔）；没配置时放行并打警告，
 * 让同学在本地/演示环境不用先配一堆东西就能跑起来。
 * 生产环境务必配置，否则任何人都能调管理端接口。
 */
function assertAdmin(openid) {
  const list = (process.env.ADMIN_OPENIDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length) {
    console.warn('[api] 未配置 ADMIN_OPENIDS，当前为演示模式，管理接口不鉴权');
    return true;
  }
  if (!list.includes(openid)) {
    const err = new Error('无管理权限');
    err.code = 'FORBIDDEN';
    throw err;
  }
  return true;
}

/* ------------------------------------------------------------------
 * 各 action 实现
 * ------------------------------------------------------------------ */

const handlers = {
  /** 地图点位：用户端看红点（待处理）与绿点（已解决） */
  async mapPoints({ layer = 'pending' }, { openid }) {
    const status = layer === 'resolved' ? ['resolved'] : ['pending', 'processing', 'review'];
    const orders = await fetchAll(
      db.collection('orders').where({ status: _.in(status) }).orderBy('createdAt', 'desc'),
      300
    );

    // 脱敏：直接返回入库时算好的 locFuzzy，不暴露精确坐标
    return {
      points: orders.map((o) => ({
        id: o._id,
        lat: o.locFuzzy?.lat ?? o.lat,
        lng: o.locFuzzy?.lng ?? o.lng,
        type: o.type,
        severity: o.severity || 3,
        status: o.status,
        multi: !!o.multiFeedback,
        reporter: o.reporterMask || '一位同学',
        // 已解决的点要讲一个完整的小故事，才有参与感
        days: o.status === 'resolved' && o.resolvedAt
          ? Math.max(1, Math.round((Date.now() - new Date(o.resolvedAt).getTime()) / DAY))
          : null
      }))
    };
  },

  /** 个人中心：信用分、计数、徽章 */
  async myProfile(_, { openid }) {
    const res = await db.collection('users').where({ _openid: openid }).limit(1).get();
    const u = res.data[0];
    if (!u) {
      return { credit: 100, validCnt: 0, invalidCnt: 0, badgeList: [], nickName: '热心居民' };
    }
    const resolved = await db
      .collection('reports')
      .where({ _openid: openid, status: 'resolved' })
      .count();
    return {
      nickName: u.nickName,
      avatar: u.avatar,
      credit: u.credit ?? 100,
      validCnt: u.validCnt || 0,
      invalidCnt: u.invalidCnt || 0,
      resolvedCnt: resolved.total,
      streak: u.streak?.days || 0,
      badgeList: u.badgeList || []
    };
  },

  /** 我的上报列表 */
  async myReports({ status = 'all', page = 0, size = 20 }, { openid }) {
    const where = { _openid: openid };
    if (status !== 'all') where.status = status;

    const q = db.collection('reports').where(where).orderBy('createdAt', 'desc');
    const res = await q.skip(page * size).limit(size).get();
    const total = await db.collection('reports').where(where).count();

    return {
      total: total.total,
      list: res.data.map((r) => ({
        id: r._id,
        files: r.files,
        type: r.type,
        address: r.address,
        desc: r.desc,
        status: r.status,
        severity: r.aiVerdict?.severity,
        summary: r.aiVerdict?.summary,
        merged: !!r.merged,
        createdAt: r.createdAt
      }))
    };
  },

  /** AI 拦截后记一次无效提交：不扣太多分，但要留下行为痕迹 */
  async markInvalid(_, { openid }) {
    const res = await db.collection('users').where({ _openid: openid }).limit(1).get();
    const u = res.data[0];
    if (!u) return { invalidCnt: 1, toReview: false };

    const invalidCnt = (u.invalidCnt || 0) + 1;
    await db.collection('users').doc(u._id).update({
      data: {
        invalidCnt,
        // 扣 1 分，下限 60，避免用户一次性被扣到负分而离开
        credit: Math.max(60, (u.credit || 100) - 1),
        updatedAt: new Date()
      }
    });

    // 超过 3 次进入人工复核池：给一个人工出口，而不是直接封禁
    return { invalidCnt, toReview: invalidCnt > 3 };
  },

  /** 管理端看板 */
  async dashboard(_, { openid }) {
    assertAdmin(openid);

    const since7 = new Date(Date.now() - 7 * DAY);
    const [orders, logs] = await Promise.all([
      fetchAll(db.collection('orders').orderBy('createdAt', 'desc'), 800),
      fetchAll(db.collection('ai_logs').where({ scene: 'report_verdict' }).orderBy('createdAt', 'desc'), 800)
    ]);

    const weekOrders = orders.filter((o) => new Date(o.createdAt) >= since7);
    const weekLogs = logs.filter((l) => new Date(l.createdAt) >= since7);
    const blocked = weekLogs.filter((l) => l.pass === false);

    // 高频区域 Top5
    const areaMap = {};
    weekOrders.forEach((o) => {
      const k = o.address || '未标注';
      areaMap[k] = (areaMap[k] || 0) + 1;
    });
    const topAreas = Object.entries(areaMap)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
    const maxArea = topAreas[0]?.count || 1;

    // 近 7 天趋势（按天）
    const trend = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * DAY);
      const key = dayKey(d);
      const sameDay = (arr) =>
        arr.filter((x) => dayKey(x.createdAt) === key).length;
      trend.push({ day: key, reports: sameDay(weekOrders), aiPass: sameDay(weekLogs.filter((l) => l.pass)) });
    }

    // 48 小时处理率
    const resolved = orders.filter((o) => o.status === 'resolved' && o.resolvedAt);
    const within48 = resolved.filter(
      (o) => new Date(o.resolvedAt) - new Date(o.createdAt) <= 2 * DAY
    ).length;
    const resolveRate = resolved.length ? Math.round((within48 / resolved.length) * 100) : 0;

    return {
      metrics: {
        weekReports: weekOrders.length,
        blocked: blocked.length,
        blockRate: weekOrders.length + blocked.length
          ? Math.round((blocked.length / (weekOrders.length + blocked.length)) * 100)
          : 0,
        pending: orders.filter((o) => o.status === 'pending').length,
        processing: orders.filter((o) => o.status === 'processing').length,
        resolveRate
      },
      topAreas: topAreas.map((a) => ({ ...a, pct: Math.round((a.count / maxArea) * 100) })),
      trend,
      // 热力图原始数据：前端用 ECharts heatmap / 地图插件渲染
      heat: weekOrders.map((o) => ({
        lat: o.lat,
        lng: o.lng,
        type: o.type,
        weight: o.severity || 3
      }))
    };
  },

  /** 工单列表 */
  async orderList({ status = 'all', type = 'all', page = 0, size = 20 }, { openid }) {
    assertAdmin(openid);

    const where = {};
    if (status !== 'all') where.status = status;
    if (type !== 'all') where.type = type;

    const q = db.collection('orders').where(where).orderBy('createdAt', 'desc');
    const [res, total] = await Promise.all([
      q.skip(page * size).limit(size).get(),
      db.collection('orders').where(where).count()
    ]);

    // 批量取上报人，避免 N+1 查询
    const reportIds = res.data.flatMap((o) => o.reportIds || []).slice(0, 200);
    const reports = reportIds.length
      ? await db.collection('reports').where({ _id: _.in(reportIds) }).get()
      : { data: [] };
    const reportMap = {};
    reports.data.forEach((r) => (reportMap[r._id] = r));

    const openids = [...new Set(reports.data.map((r) => r._openid))];
    const users = openids.length
      ? await db.collection('users').where({ _openid: _.in(openids) }).get()
      : { data: [] };
    const userMap = {};
    users.data.forEach((u) => (userMap[u._openid] = u));

    return {
      total: total.total,
      list: res.data.map((o) => {
        const first = reportMap[(o.reportIds || [])[0]] || {};
        const reporter = userMap[first._openid] || {};
        return {
          id: o._id,
          orderNo: o.orderNo,
          type: o.type,
          address: o.address,
          lat: o.lat,
          lng: o.lng,
          status: o.status,
          severity: o.severity,
          mergeCnt: o.mergeCnt || 1,
          multiFeedback: !!o.multiFeedback,
          summary: o.summary,
          aiAdvice: o.aiAdvice,
          cover: (first.files || [])[0] || '',
          reporter: maskName(reporter.nickName),
          credit: reporter.credit ?? 100,
          createdAt: o.createdAt
        };
      })
    };
  },

  /** 工单详情 */
  async orderDetail({ id }, { openid }) {
    assertAdmin(openid);
    const o = (await db.collection('orders').doc(id).get()).data;
    const reports = o.reportIds?.length
      ? await db.collection('reports').where({ _id: _.in(o.reportIds) }).get()
      : { data: [] };
    return { order: o, reports: reports.data };
  },

  /** 工单状态流转：处理中 / 已完成 / 驳回 */
  async orderUpdate({ id, status, note = '' }, { openid }) {
    assertAdmin(openid);
    if (!['pending', 'processing', 'resolved', 'review', 'rejected'].includes(status)) {
      throw new Error('非法状态');
    }

    const now = new Date();
    const patch = { status, note, updatedAt: now };
    if (status === 'resolved') patch.resolvedAt = now;

    await db.collection('orders').doc(id).update({ data: patch });

    // 同步所有关联上报，用户端「我的上报」才能跟着变
    const o = (await db.collection('orders').doc(id).get()).data;
    if (o.reportIds?.length) {
      await db
        .collection('reports')
        .where({ _id: _.in(o.reportIds) })
        .update({ data: { status: status === 'rejected' ? 'rejected' : status } });
    }
    return { ok: true };
  }
};

/* ------------------------------------------------------------------
 * 路由
 * ------------------------------------------------------------------ */
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { action, ...payload } = event || {};
  const handler = handlers[action];

  if (!handler) {
    return { ok: false, error: `未知 action: ${action}` };
  }

  try {
    const data = await handler(payload, { openid: OPENID });
    return { ok: true, data };
  } catch (err) {
    console.error(`[api/${action}]`, err);
    return { ok: false, error: err.message, code: err.code || 'ERROR' };
  }
};
