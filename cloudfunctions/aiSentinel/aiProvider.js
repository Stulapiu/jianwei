/**
 * ============================================================
 * 统一 AI 适配层（aiProvider）
 * ------------------------------------------------------------
 * 设计原则：
 *   1. 业务代码永远只调 chat() / chatJSON()，不认识任何具体厂商；
 *   2. 换模型 = 改下面的 PROVIDERS 配置，业务代码零改动；
 *   3. 没有配 Key 时自动降级为 mock，保证演示不依赖网络和额度；
 *   4. 只用 Node 原生 https，不引入 axios，部署包里没有多余依赖。
 *
 * 通义千问 / 智谱 / DeepSeek 三家都兼容 OpenAI 的
 * /chat/completions 协议，所以这里可以用同一段请求逻辑。
 * ============================================================
 */

const https = require('https');
const { URL } = require('url');

/** 各厂商接入参数。keyEnv 指向云函数「环境变量」里的名字，不要硬编码密钥。 */
const PROVIDERS = {
  dashscope: {
    name: '通义千问',
    url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    keyEnv: 'DASHSCOPE_API_KEY',
    textModel: 'qwen-plus',
    visionModel: 'qwen-vl-max'
  },
  zhipu: {
    name: '智谱 GLM',
    url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    keyEnv: 'ZHIPU_API_KEY',
    textModel: 'glm-4-flash',
    visionModel: 'glm-4v-flash'
  },
  deepseek: {
    name: 'DeepSeek',
    url: 'https://api.deepseek.com/chat/completions',
    keyEnv: 'DEEPSEEK_API_KEY',
    textModel: 'deepseek-chat',
    visionModel: null // DeepSeek 暂不提供视觉，视觉自动回落到 dashscope
  }
};

/** 当前启用哪家：优先读环境变量 AI_PROVIDER，默认通义。 */
function activeProvider() {
  const key = process.env.AI_PROVIDER || 'dashscope';
  return PROVIDERS[key] ? key : 'dashscope';
}

/** 没有 Key 就进入 mock 模式——这是让「没申请到额度」的同学也能跑通全流程的兜底。 */
function isMock() {
  const p = PROVIDERS[activeProvider()];
  return !process.env[p.keyEnv];
}

/**
 * 底层 HTTP 请求，返回已解析的 JSON。
 * 云函数运行在 Node，用原生 https 可以避免任何第三方依赖安装失败的问题。
 */
function postJSON(urlStr, headers, body, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const payload = Buffer.from(JSON.stringify(body), 'utf8');

    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
          ...headers
        },
        timeout
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`AI 接口 ${res.statusCode}: ${text.slice(0, 300)}`));
          }
          try {
            resolve(JSON.parse(text));
          } catch (e) {
            reject(new Error('AI 返回的不是合法 JSON: ' + text.slice(0, 200)));
          }
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error('AI 接口超时'));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * 统一对话入口。
 * @param {Object} opts
 * @param {string} opts.system      系统提示词
 * @param {string} opts.user        用户内容
 * @param {string[]} [opts.images]  图片公网 URL 数组（走视觉模型）
 * @param {boolean} [opts.json]     是否要求返回 JSON
 * @param {number} [opts.temperature]
 * @returns {Promise<string>} 模型输出的纯文本
 */
async function chat(opts) {
  const { system, user, images = [], json = false, temperature = 0.3 } = opts;
  const providerKey = activeProvider();
  const p = PROVIDERS[providerKey];

  // ---------- 无 Key：走本地规则引擎，保证演示可跑 ----------
  if (isMock()) {
    return mockAnswer(opts);
  }

  const needVision = images.length > 0;
  // 如果当前厂商没有视觉能力，视觉请求自动改道到通义
  const target = needVision && !p.visionModel ? PROVIDERS.dashscope : p;
  const apiKey = process.env[target.keyEnv];

  // 组装 OpenAI 兼容的多模态 messages
  const content = needVision
    ? [
        ...images.slice(0, 4).map((url) => ({ type: 'image_url', image_url: { url } })),
        { type: 'text', text: user }
      ]
    : user;

  const body = {
    model: needVision ? target.visionModel : target.textModel,
    temperature,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content }
    ]
  };
  if (json) body.response_format = { type: 'json_object' };

  const res = await postJSON(target.url, { Authorization: `Bearer ${apiKey}` }, body);
  const text = res?.choices?.[0]?.message?.content;
  if (!text) throw new Error('AI 未返回内容：' + JSON.stringify(res).slice(0, 200));
  return text;
}

/**
 * 要求返回 JSON 的对话。模型偶尔会裹 markdown 代码块，这里统一清洗。
 * 解析失败时抛错，由调用方决定是否降级——不要静默返回脏数据。
 */
async function chatJSON(opts) {
  const raw = await chat({ ...opts, json: true });
  const cleaned = String(raw)
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // 兜底：抓第一个 { 到最后一个 } 之间的内容
    const s = cleaned.indexOf('{');
    const t = cleaned.lastIndexOf('}');
    if (s >= 0 && t > s) return JSON.parse(cleaned.slice(s, t + 1));
    throw new Error('AI 输出的 JSON 无法解析: ' + cleaned.slice(0, 200));
  }
}

/* ============================================================
 * Mock 引擎：没有 API Key 时的确定性规则
 * ------------------------------------------------------------
 * 刻意做成「可控」而不是「随机」：演示时用特定描述就能稳定
 * 触发拦截，方便讲清楚产品逻辑，不会现场翻车。
 *   描述含「模糊 / 看不清」  → 拦模糊
 *   描述含「自拍 / 截图 / 网上」→ 拦非设施
 *   类型与描述冲突           → 拦语义不一致
 *   其他                     → 通过
 * ============================================================ */
function mockAnswer(opts) {
  const user = String(opts.user || '');
  const isVision = (opts.images || []).length > 0;

  if (isVision) {
    if (/模糊|看不清|blur/i.test(user)) {
      return JSON.stringify({
        clear: false,
        score: 0.28,
        facility: ['垃圾桶'],
        scene: '画面整体失焦，无法辨认设施细节',
        reason: 'blur',
        message: '这张照片有点模糊，换个角度或者靠近一点再拍一张？'
      });
    }
    if (/自拍|截图|网上|表情包/i.test(user)) {
      return JSON.stringify({
        clear: true,
        score: 0.9,
        facility: [],
        scene: '人像照片，未检测到公共设施',
        reason: 'not_facility',
        message: '这张图里好像没有看到公共设施，是我们看漏了吗？'
      });
    }
    return JSON.stringify({
      clear: true,
      score: 0.88,
      facility: ['路灯'],
      scene: '夜间拍摄的照明设施，存在明显异常',
      reason: null,
      message: ''
    });
  }

  // 文本判定
  if (/模糊|看不清/.test(user)) {
    return JSON.stringify({ consistent: true, reason: null, severity: 3, summary: '设施存在异常，需要现场核查' });
  }
  if (/水利|水管|漏水/.test(user) && /照明|灯/.test(user)) {
    return JSON.stringify({
      consistent: false,
      reason: 'type_mismatch',
      severity: 2,
      summary: '描述内容与所选类型不一致'
    });
  }
  return JSON.stringify({
    consistent: true,
    reason: null,
    severity: 3,
    summary: '公共设施出现损坏，影响正常使用',
    advice: '建议 48 小时内派单核查，优先确认是否存在安全隐患。'
  });
}

module.exports = {
  chat,
  chatJSON,
  isMock,
  activeProvider,
  PROVIDERS
};
