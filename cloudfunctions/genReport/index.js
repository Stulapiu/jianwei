/**
 * 云函数：genReport —— 大模型生成类能力（周报 / 巡逻建议 / 合并建议）
 * ------------------------------------------------------------
 * 单独成一个云函数的原因：这类调用耗时长（3–15 秒），
 * 和 submitReport 这种「用户点一下就要返回」的链路分开，
 * 可以把超时各自配置（这里设 20–60 秒也不影响上报）。
 *
 * 三个 action：
 *   weekly  一键生成管理层周报（约 200 字，可直接发微信群）
 *   patrol  AI 哨兵巡逻：基于高频故障点生成下周巡查路线建议
 *   merge   同类工单合并建议：识别同区域同类型的多条工单
 *
 * 全部支持无 Key 降级：用模板拼装，保证演示时永远有东西可看。
 * ============================================================
 */

const cloud = require('wx-server-sdk');
const ai = require('./aiProvider');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const DAY = 86400000;

const TYPE_LABEL = {
  lighting: '照明',
  sanitation: '卫生',
  facility: '设施损坏',
  safety: '安全隐患',
  other: '其他'
};

async function fetchAll(query, max = 800) {
  let all = [];
  let skip = 0;
  while (all.length < max) {
    const res = await query.skip(skip).limit(100).get();
    all = all.concat(res.data);
    if (res.data.length < 100) break;
    skip += 100;
  }
  return all;
}

/** 汇总本周数据，三个 action 共用 */
async function collectWeekData() {
  const since = new Date(Date.now() - 7 * DAY);
  const [orders, logs] = await Promise.all([
    fetchAll(db.collection('orders').where({ createdAt: _.gt(since) }).orderBy('createdAt', 'desc')),
    fetchAll(db.collection('ai_logs').where({ createdAt: _.gt(since) }).orderBy('createdAt', 'desc'))
  ]);

  const blocked = logs.filter((l) => l.pass === false);
  const resolved = orders.filter((o) => o.status === 'resolved');

  const areaMap = {};
  orders.forEach((o) => {
    const k = o.address || '未标注';
    areaMap[k] = (areaMap[k] || 0) + 1;
  });
  const topAreas = Object.entries(areaMap)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const typeMap = {};
  orders.forEach((o) => {
    typeMap[o.type] = (typeMap[o.type] || 0) + 1;
  });

  return { orders, logs, blocked, resolved, topAreas, typeMap, since };
}

/** 把数据压成一段紧凑文本喂给模型，比塞 JSON 更省 token 也更好读 */
function digest(d) {
  const types = Object.entries(d.typeMap)
    .map(([k, v]) => `${TYPE_LABEL[k] || k} ${v} 条`)
    .join('、');
  const areas = d.topAreas.map((a, i) => `${i + 1}. ${a.name}（${a.count} 条）`).join('；');
  return [
    `本周上报总数：${d.orders.length} 条`,
    `AI 拦截无效信息：${d.blocked.length} 条，占比 ${d.orders.length + d.blocked.length ? Math.round((d.blocked.length / (d.orders.length + d.blocked.length)) * 100) : 0}%`,
    `已解决：${d.resolved.length} 条，待处理：${d.orders.filter((o) => o.status === 'pending').length} 条`,
    `问题类型分布：${types || '暂无'}`,
    `高频区域：${areas || '暂无'}`
  ].join('\n');
}

const handlers = {
  /** 一键周报：200 字左右，像人写的，不像公文 */
  async weekly() {
    const d = await collectWeekData();

    if (ai.isMock()) {
      const pct = d.orders.length + d.blocked.length
        ? Math.round((d.blocked.length / (d.orders.length + d.blocked.length)) * 100)
        : 0;
      const top = d.topAreas[0]?.name || '暂无集中区域';
      return {
        text:
          `本周共收到上报 ${d.orders.length} 条，AI 自动拦下 ${d.blocked.length} 条无效信息（占比 ${pct}%），` +
          `实际进入工单 ${d.orders.length} 条，已解决 ${d.resolved.length} 条。` +
          `问题集中在${top}一带，以${TYPE_LABEL[Object.keys(d.typeMap).sort((a, b) => d.typeMap[b] - d.typeMap[a])[0]] || '设施'}类为主。` +
          `建议下周优先安排一次该区域的集中巡检，同时把高频点位加入日常巡查路线。`,
        degraded: true
      };
    }

    const text = await ai.chat({
      system: `你是校园与乡村公共治理的运营分析助手。请把本周数据写成一段管理层简报。

硬性要求：
- 篇幅 180–220 字，一段话，不分点
- 至少包含 3 个具体数字
- 语气平实、口语化，像同事在群里汇报，不要「尊敬的领导」「特此报告」这类公文腔
- 结尾给 1 条具体、可执行的建议
- 直接输出正文，不要标题，不要 markdown`,
      user: digest(d),
      temperature: 0.6
    });

    // 落库，方便回溯历史周报
    await db.collection('ai_logs').add({
      data: { scene: 'weekly_report', provider: ai.activeProvider(), content: text, createdAt: db.serverDate() }
    });

    return { text: text.trim(), degraded: false };
  },

  /** AI 哨兵巡逻：把「被动响应」讲成「主动预警」 */
  async patrol() {
    const d = await collectWeekData();
    const spots = d.topAreas.slice(0, 4);

    if (!spots.length) {
      return { text: '本周数据还不多，暂不生成巡查路线。等上报累积到 5 条以上再来看看。', spots: [], degraded: true };
    }

    if (ai.isMock()) {
      const route = spots.map((s, i) => `${i + 1}. ${s.name}（近 7 天 ${s.count} 条）`).join('　');
      return {
        text:
          `本周建议按「${spots.map((s) => s.name).join(' → ')}」的顺序走一遍，全程约 25 分钟。` +
          `${spots[0].name}是本周最集中的点位，建议傍晚 18:30 前后顺路核查照明与垃圾清运情况；` +
          `其余点位可在同一趟巡线中带过。这条路线是从历史工单里倒推出来的，比等报修再跑一趟更省事。`,
        route: spots.map((s) => s.name),
        spots,
        degraded: true
      };
    }

    const text = await ai.chat({
      system: `你是城市/校园巡查调度助手。根据高频故障点，给出一条下周重点巡查路线建议。

要求：
- 150 字以内，一段话
- 按空间顺序把点位串成一条可执行的路线，而不是罗列
- 点出最需要关注的那个点位和原因，给出建议时段
- 语气像老同事给的建议，具体、不空泛
- 直接输出正文，不要标题和 markdown`,
      user: `高频点位（近 7 天）：\n${spots.map((s, i) => `${i + 1}. ${s.name}：${s.count} 条`).join('\n')}\n类型分布：${Object.entries(d.typeMap).map(([k, v]) => `${TYPE_LABEL[k] || k} ${v}`).join('、')}`,
      temperature: 0.7
    });

    await db.collection('patrol_plans').add({
      data: {
        week: new Date().toISOString().slice(0, 10),
        content: text.trim(),
        spots,
        createdAt: db.serverDate()
      }
    });

    return { text: text.trim(), route: spots.map((s) => s.name), spots, degraded: false };
  },

  /** 同类工单合并建议：先用规则分组，再让模型写人话 */
  async merge() {
    const since = new Date(Date.now() - 7 * DAY);
    const orders = await fetchAll(
      db.collection('orders')
        .where({ status: _.in(['pending', 'processing']), createdAt: _.gt(since) })
        .orderBy('createdAt', 'desc')
    );

    // 规则分组：地址 + 类型相同即视为同组，2 条以上才值得建议合并
    const groups = {};
    orders.forEach((o) => {
      const key = `${o.address || '未标注'}|${o.type}`;
      (groups[key] = groups[key] || []).push(o);
    });

    const candidates = Object.entries(groups)
      .filter(([, list]) => list.length >= 2)
      .map(([key, list]) => {
        const [address, type] = key.split('|');
        return {
          key,
          address,
          type,
          typeLabel: TYPE_LABEL[type] || type,
          count: list.length,
          orderIds: list.map((o) => o._id),
          orderNos: list.map((o) => o.orderNo)
        };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    if (!candidates.length) {
      return { suggestions: [], message: '近期没有发现需要合并的同类工单' };
    }

    // 让模型为每组写一句「为什么要合并、合并后怎么处理」
    let tips = [];
    if (!ai.isMock()) {
      try {
        const r = await ai.chatJSON({
          system: `你是工单调度助手。下面有几组同区域同类型的工单，请为每组写一句合并建议。
要求：每条 30 字以内，说明合并理由和处置方式，例如「A 区 3 条路灯损坏，建议合并为一次集中检修，排查线路老化」。
只输出 JSON：{"tips":[{"key":"分组key","text":"建议"}]}`,
          user: JSON.stringify(candidates.map((c) => ({ key: c.key, address: c.address, type: c.typeLabel, count: c.count }))),
          temperature: 0.5
        });
        tips = r.tips || [];
      } catch (e) {
        console.warn('[genReport/merge] 模型生成失败，使用规则文案:', e.message);
      }
    }

    const suggestions = candidates.map((c) => {
      const ai1 = tips.find((t) => t.key === c.key);
      return {
        ...c,
        text: ai1?.text || `${c.address}有 ${c.count} 条${c.typeLabel}工单，建议合并为一次集中检修。`
      };
    });

    return { suggestions };
  }
};

exports.main = async (event) => {
  const { action } = event || {};
  const h = handlers[action];
  if (!h) return { ok: false, error: `未知 action: ${action}` };

  try {
    const data = await h();
    return { ok: true, data };
  } catch (err) {
    console.error(`[genReport/${action}]`, err);
    return { ok: false, error: err.message };
  }
};
