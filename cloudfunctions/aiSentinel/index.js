/**
 * 云函数：aiSentinel —— AI 哨兵（图像 + 文本双闸门）
 * ------------------------------------------------------------
 * 职责：只做「判定」，不写业务数据（除了 AI 调用日志）。
 *   1. 视觉闸门：清晰度 / 是否包含公共设施 / 与所选类型是否一致
 *   2. 语义闸门：描述是否与类型一致，顺带产出严重度与摘要
 *   3. 通过后生成一句处置建议
 *
 * 为什么不在这里做「重复坐标去重」？
 * 去重需要查数据库历史记录，属于业务写操作，放在 submitReport 里更合理，
 * 也让这个云函数保持无状态、可独立压测和替换。
 * ============================================================
 */

const cloud = require('wx-server-sdk');
const ai = require('./aiProvider');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

/** 问题类型字典：中文名 + 判断线索，提示词里会用到 */
const TYPE_DICT = {
  lighting: { label: '照明', hints: '路灯、庭院灯、楼道灯、应急指示灯' },
  sanitation: { label: '卫生', hints: '垃圾桶满溢、垃圾堆放、污水、异味' },
  facility: { label: '设施损坏', hints: '座椅、护栏、井盖、健身器材、宣传栏、水篦子' },
  safety: { label: '安全隐患', hints: '电线裸露、井盖缺失、墙体开裂、护栏断裂' },
  other: { label: '其他', hints: '不属于以上类别的公共设施问题' }
};

/* ------------------------------------------------------------------
 * 提示词集中管理：调优时只改这里，不用翻业务逻辑
 * ------------------------------------------------------------------ */

const VISION_SYSTEM = `你是校园与乡村的公共设施巡查助手，任务是判断一张照片能否作为有效的报修凭证。

必须从三个维度判断：
1. 清晰度 clear：画面是否足以辨认设施状态。严重失焦、过暗、过曝、大面积遮挡，都算不清晰。
2. 主体性 facility：画面主体是否为公共设施（路灯、垃圾桶、井盖、护栏、座椅、健身器材、水篦子、宣传栏等）。
   自拍、人像、纯风景、手机截图、表情包、文档照片、宠物照，都不算。
3. 类型一致性：如果用户选了某种类型，画面主体应当与该类型相关。

语气要求：message 是给普通居民/学生看的，必须温和、不指责、给出可操作的下一步，
例如「这张照片有点模糊，换个角度试试？」而不是「照片不合格」。

只输出 JSON，不要任何解释文字：
{"clear":true,"score":0.0,"facility":["识别到的设施"],"scene":"一句话客观描述画面","reason":null,"message":""}
reason 只能是 null / "blur" / "not_facility" / "type_mismatch" 之一。通过时 reason 为 null 且 message 为空字符串。`;

const TEXT_SYSTEM = `你是公共设施报修工单的文本理解助手。用户已选择问题类型并填写了描述（描述可能为空）。

你要做三件事：
1. 判断描述与所选类型是否一致。例如选了「照明」却描述「水管漏水」，属于不一致。
   描述为空、或只是「坏了」「有问题」这类极简描述，视为「无法判断但不算冲突」，consistent 为 true。
2. 给出严重程度 severity（1-5 的整数）：
   5 = 有即时人身危险（井盖缺失、电线裸露、护栏断裂）
   4 = 影响安全或大面积使用（路灯整段不亮、垃圾堵塞通道）
   3 = 影响正常使用（单个路灯不亮、垃圾桶满溢）
   2 = 影响体验但不紧急（座椅松动、标识模糊）
   1 = 建议性改进（希望增设设施）
3. 用一句不超过 24 字的话概括问题摘要 summary。

只输出 JSON：
{"consistent":true,"reason":null,"severity":3,"summary":"","advice":""}
reason 只能是 null 或 "type_mismatch"。`;

/**
 * 把云存储 fileID 换成模型可访问的临时 https 链接。
 * 视觉模型只能读公网 URL，不能读 wxfile:// 或 cloud:// 协议。
 */
async function toTempUrls(fileIDs) {
  const ids = (fileIDs || []).filter(Boolean).slice(0, 3);
  if (!ids.length) return [];
  const res = await cloud.getTempFileURL({ fileList: ids });
  return (res.fileList || [])
    .filter((f) => f.status === 0 && f.tempFileURL)
    .map((f) => f.tempFileURL);
}

/** 视觉闸门 */
async function visionGate(images, type, desc) {
  const t = TYPE_DICT[type] || TYPE_DICT.other;
  const user = `用户选择的问题类型：${t.label}（典型对象：${t.hints}）
用户的文字描述：${desc || '（未填写）'}

请判断这组照片是否可以受理。`;

  const r = await ai.chatJSON({
    system: VISION_SYSTEM,
    user,
    images,
    temperature: 0.1
  });

  const pass = r.clear !== false && r.reason == null;
  return {
    pass,
    stage: 'vision',
    reason: r.reason || null,
    message: r.message || '',
    score: Number(r.score) || 0,
    scene: r.scene || '',
    facility: r.facility || []
  };
}

/** 语义闸门 */
async function textGate(type, desc) {
  const t = TYPE_DICT[type] || TYPE_DICT.other;
  const user = `所选类型：${t.label}（${t.hints}）
用户描述：${desc || '（未填写）'}`;

  const r = await ai.chatJSON({
    system: TEXT_SYSTEM,
    user,
    temperature: 0.2
  });

  const pass = r.consistent !== false && r.reason !== 'type_mismatch';
  return {
    pass,
    stage: 'text',
    reason: r.reason || null,
    message: pass ? '' : '你选的是「' + t.label + '」，但描述说的好像是另一类问题，确认一下类型？',
    severity: Math.min(5, Math.max(1, parseInt(r.severity, 10) || 3)),
    summary: r.summary || '',
    advice: r.advice || ''
  };
}

/** 主入口 */
exports.main = async (event) => {
  const started = Date.now();
  const { fileIDs = [], type = 'other', desc = '' } = event;

  // 参数兜底：没有图片直接判无效，避免浪费一次模型调用
  if (!fileIDs.length) {
    return {
      pass: false,
      stage: 'vision',
      reason: 'no_image',
      message: '还没有选择照片，拍一张现场图再提交吧。',
      provider: ai.activeProvider()
    };
  }

  let verdict;
  try {
    const images = await toTempUrls(fileIDs);

    // 两道闸门并行跑，总耗时取较慢的那个，而不是相加
    const [v, t] = await Promise.all([visionGate(images, type, desc), textGate(type, desc)]);

    // 视觉优先：图不对，后面再怎么描述都没意义
    if (!v.pass) {
      verdict = { ...v, severity: 0, summary: '', advice: '' };
    } else if (!t.pass) {
      verdict = { ...t, score: v.score, scene: v.scene, facility: v.facility };
    } else {
      verdict = {
        pass: true,
        stage: null,
        reason: null,
        message: '',
        severity: t.severity,
        summary: t.summary,
        advice: t.advice,
        score: v.score,
        scene: v.scene,
        facility: v.facility
      };
    }
  } catch (err) {
    // 关键决策：AI 挂了不能让用户提交不了。
    // 失败时「放行 + 标记待人工复核」，把降级权交给人，而不是粗暴拒绝用户。
    console.error('[aiSentinel] 判定失败，降级放行:', err.message);
    verdict = {
      pass: true,
      degraded: true,
      stage: null,
      reason: null,
      message: '',
      severity: 3,
      summary: '',
      advice: '',
      score: 0
    };
  }

  const latency = Date.now() - started;

  // 审计日志：用于后台算「AI 降噪拦截率」，也方便排查误判
  try {
    await db.collection('ai_logs').add({
      data: {
        scene: 'report_verdict',
        provider: ai.activeProvider(),
        mock: ai.isMock(),
        type,
        desc: String(desc).slice(0, 200),
        pass: verdict.pass,
        reason: verdict.reason || null,
        degraded: !!verdict.degraded,
        latency,
        createdAt: db.serverDate()
      }
    });
  } catch (e) {
    console.warn('[aiSentinel] 日志写入失败（不影响主流程）:', e.message);
  }

  return { ...verdict, latency, provider: ai.activeProvider(), mock: ai.isMock() };
};
