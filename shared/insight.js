/* ==========================================================================
 * 见微 · 管理端洞察（Insight）
 * --------------------------------------------------------------------------
 * 周报、巡逻路线、合并建议这三块，原来是把统计数字套进几段写死的句子里。
 * 演示时看着像 AI 写的，实际上换一批数据它也是那几句话 —— 数字变了，
 * 判断没变，这就不叫分析。
 *
 * 现在改成：先把数据算好（这部分仍然是确定性的，不交给模型），
 * 再把数据交给 DeepSeek 写判断。模型只负责"怎么看这件事"，
 * 不负责算数 —— 数字错一个，整段结论就废了。
 *
 * 没有代理时**不生成假文本**。返回一个明确的错误，界面照实说"AI 没连上"，
 * 顶多把原始统计摆出来让人自己看。宁可少一段话，不要一段编的话。
 * ========================================================================== */

(function (global) {
  'use strict';

  var ENDPOINT = 'http://localhost:8787/v1';

  function base() {
    return ENDPOINT.replace(/\/v1\/?$/, '');
  }

  function health() {
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, 1500) : null;
    return fetch(base() + '/health', { signal: ctl ? ctl.signal : undefined })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
      .then(function (j) {
        if (timer) clearTimeout(timer);
        return { ok: !!(j && j.ok), hasKey: !!(j && j.hasKey), model: (j && j.model) || '' };
      })
      .catch(function (e) {
        if (timer) clearTimeout(timer);
        return { ok: false, error: String(e && e.message || e) };
      });
  }

  function chat(system, user, opt) {
    var o = opt || {};
    var body = {
      model: o.model || 'deepseek-flash',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      temperature: o.temperature != null ? o.temperature : 0.4,
      max_tokens: o.maxTokens || 700,
      thinking: { type: 'disabled' }
    };
    if (o.json) body.response_format = { type: 'json_object' };

    var t0 = Date.now();
    return fetch(ENDPOINT.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (j) {
        var txt = j.choices && j.choices[0] && j.choices[0].message
          ? j.choices[0].message.content : '';
        if (!txt) throw new Error('模型没有返回内容');
        return { text: String(txt).trim(), latency: Date.now() - t0 };
      });
  }

  function parseJSON(text) {
    if (!text) return null;
    try { return JSON.parse(text); } catch (e) { /* 继续 */ }
    var i = text.indexOf('{');
    var j = text.lastIndexOf('}');
    if (i >= 0 && j > i) {
      try { return JSON.parse(text.slice(i, j + 1)); } catch (e2) { /* 继续 */ }
    }
    return null;
  }

  function statsLine(d) {
    var lines = [];
    lines.push('本周接收上报 ' + d.total + ' 条（含 AI 拦截 ' + d.blocked + ' 条，拦截率 ' + d.blockRate + '%）。');
    lines.push('有效工单 ' + d.valid + ' 条，已办结 ' + d.done + ' 条，处理率 ' + d.rate + '%。');
    lines.push('当前待处理 ' + d.pending + ' 条，其中 P0 ' + d.p0 + ' 条。');
    if (d.areas && d.areas.length) {
      lines.push('待处理最集中的片区：' + d.areas.map(function (a) {
        return a.name + '（' + a.n + ' 条，累计紧急度 ' + a.score + '）';
      }).join('、') + '。');
    }
    if (d.types && d.types.length) {
      lines.push('类型构成：' + d.types.map(function (t) {
        return t.label + ' ' + t.n + ' 条';
      }).join('、') + '。');
    }
    if (d.repeats && d.repeats.length) {
      lines.push('反复报修的点位：' + d.repeats.map(function (r) {
        return r.address + '（近 30 天 ' + r.n + ' 次）';
      }).join('、') + '。');
    }
    if (d.rejected) lines.push('人工复核驳回 ' + d.rejected + ' 条。');
    return lines.join('\n');
  }

  /**
   * 周报。要求模型给"判断"而不是复述数字：
   * 哪一类在变多、哪一片反复出问题、下周该先做什么。
   */
  function weekly(d) {
    var system = [
      '你是高校后勤管理中心的运营分析员，要给中心主任写一段可以直接发到工作群的周报。',
      '',
      '硬性要求：',
      '  1. 220-300 字，分 3 段，不要小标题，不要 markdown。',
      '  2. 数字只在第一段出现，后面写判断和动作。不要逐个复述所有数字。',
      '  3. 必须给出"下周先做什么"的具体建议，最多两条，要能执行（谁、去哪、做什么）。',
      '  4. 不要写"综上所述""总体来看"这类空话，不要编造数据里没有的东西。',
      '  5. 如果某类问题在重复发生，要指出这可能是上次没根治，而不是新问题。',
      '  6. 语气克制，像同事在交接工作，不像宣传稿。'
    ].join('\n');

    var user = [
      '本周数据（统计口径已核准，直接引用，不要重算）：',
      statsLine(d),
      '',
      '请据此写周报。'
    ].join('\n');

    return chat(system, user, { temperature: 0.45, maxTokens: 700 })
      .then(function (r) { return { ok: true, text: r.text, latency: r.latency }; });
  }

  /**
   * 巡逻路线。数据侧已经把点位和紧急度算好了，
   * 模型负责解释"为什么这么排、到了看什么"。
   */
  function patrol(d) {
    var system = [
      '你是高校后勤的巡检调度员。给你一份待处理工单聚合出来的点位表，',
      '请写一段巡查建议，并给每个点位一句"到了看什么"。',
      '',
      '判断原则：',
      '  - 顺序按紧急度累加排，不是按条数。一个井盖缺失比三处草坪问题更该先去。',
      '  - 同一片区的不同类型问题，能顺路看的就放在一起，别让人来回跑。',
      '  - 到了现场看什么，要具体（例如"看井盖是否缺失、周边是否已围挡"），不要写"检查设施"。',
      '',
      '严格只输出 JSON：',
      '{',
      '  "intro": "80 字以内的路线说明，说清为什么这么排、预计多久",',
      '  "stops": [{ "i": 0, "why": "20 字以内，到这个点重点看什么" }],',
      '  "tip": "30 字以内的一条提醒，例如带什么工具、几点去合适"',
      '}'
    ].join('\n');

    var user = [
      '待处理点位（按紧急度累加排序，i 是从 0 开始的序号）：',
      d.stops.map(function (s, i) {
        return (i + 1) + '. ' + s.name + ' · ' + s.n + ' 条 · 累计紧急度 ' + s.score +
          ' · 类型：' + s.types.join('、');
      }).join('\n'),
      '',
      '共 ' + d.stops.length + ' 个点位。请给巡查建议。'
    ].join('\n');

    return chat(system, user, { json: true, temperature: 0.35, maxTokens: 600 })
      .then(function (r) {
        var p = parseJSON(r.text);
        if (!p) throw new Error('模型返回的不是 JSON');
        return { ok: true, intro: p.intro || '', stops: p.stops || [], tip: p.tip || '', latency: r.latency };
      });
  }

  /** 合并建议：给每一组写一句"为什么值得合并" */
  function merge(groups) {
    var system = [
      '你是后勤调度员。下面几组工单在物理位置上很接近，可能可以合并成一次出勤。',
      '给每一组写一句判断：值不值得合并、合并之后怎么安排。',
      '',
      '要求：',
      '  - 每组一句标题（24 字内）+ 一句说明（40 字内）。',
      '  - 说明要提到"省什么"（车程、来回次数、重复上门），不要空泛。',
      '  - 如果某组其实不该合并（例如分属两个必须分开处理的班组），直说。',
      '',
      '严格只输出 JSON：{ "items": [{ "i": 0, "title": "", "desc": "" }] }'
    ].join('\n');

    var user = groups.map(function (g, i) {
      return (i + 1) + '. ' + g.area + ' · ' + g.n + ' 条 · ' + g.reports + ' 次上报 · ' +
        (g.types.length ? '类型：' + g.types.join('、') : '类型分散') +
        (g.deptWide ? ' · 同一个班组辖区' : '');
    }).join('\n');

    return chat(system, user, { json: true, temperature: 0.4, maxTokens: 600 })
      .then(function (r) {
        var p = parseJSON(r.text);
        if (!p || !Array.isArray(p.items)) throw new Error('模型返回的不是 JSON');
        return { ok: true, items: p.items, latency: r.latency };
      });
  }

  var Insight = {
    ENDPOINT: ENDPOINT,
    health: health,
    weekly: weekly,
    patrol: patrol,
    merge: merge,
    _statsLine: statsLine
  };

  if (typeof module === 'object' && module.exports) module.exports = Insight;
  global.Insight = Insight;

})(typeof window !== 'undefined' ? window : this);
