/* ==========================================================================
 * 见微 · 哨兵智能体（Sentinel Agent）
 * --------------------------------------------------------------------------
 * 职责：在一条上报进入数据库之前，判断它值不值得占用管理端的处理资源。
 *
 * 拆成两道闸门，而不是「一个模型全包」：
 *   闸门一 · 视觉质量   —— 用真实图像算法算，不调模型
 *   闸门二 · 语义一致性 —— 交给 DeepSeek
 *
 * 为什么视觉不交给 DeepSeek：DeepSeek 的对话模型不接受图片输入。
 * 硬要接就得换 GLM-4V / 通义千问 VL，那是另一个供应商的 key。
 * 而「这张图糊没糊」本来就该用确定性算法判断 —— 拉普拉斯方差是
 * 摄影行业的标准做法，比模型更准，还零成本、零延迟。
 *
 * 于是视觉闸门输出一组客观指标（清晰度、亮度、饱和度、平坦区占比），
 * 这组指标连同样本描述一起喂给 DeepSeek，让它去判断「这像不像一张
 * 拍设施的现场照片」。模型不需要看见像素，也能从统计特征上分辨
 * 「风景照」「截图」「自拍」和「坏掉的路灯」。
 * ========================================================================== */

(function (global) {
  'use strict';

  /* ======================================================================
   * 一、图像客观指标
   * ==================================================================== */

  /**
   * 算一张图的清晰度/亮度/饱和度等信息。
   * @param {HTMLImageElement|HTMLCanvasElement|string} source
   * @returns {Promise<Object>} 指标
   */
  function analyzeImage(source) {
    return new Promise(function (resolve) {
      var img = source;
      var isCanvas = source && source.getContext;
      var isString = typeof source === 'string';

      function go() {
        try {
          resolve(measure(img));
        } catch (e) {
          resolve(fallbackMetrics());
        }
      }

      if (isCanvas) return go();
      if (isString) {
        img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = go;
        img.onerror = function () { resolve(fallbackMetrics()); };
        img.src = source;
        return;
      }
      if (img && img.complete) return go();
      if (img && img.addEventListener) {
        img.addEventListener('load', go, { once: true });
        img.addEventListener('error', function () { resolve(fallbackMetrics()); }, { once: true });
        return;
      }
      resolve(fallbackMetrics());
    });
  }

  function fallbackMetrics() {
    return {
      ok: false, sharpness: 0, sharpScore: 0, brightness: 0,
      saturation: 0, flatRatio: 1, edgeDensity: 0, dominant: 'unknown'
    };
  }

  /** 把任意图源缩到 240px 宽再算，省时间也统一尺度 */
  function measure(img) {
    var W = 240;
    var ratio = (img.height || img.naturalHeight || 180) / (img.width || img.naturalWidth || 320);
    var H = Math.max(2, Math.round(W * ratio));
    var cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    var cx = cv.getContext('2d', { willReadFrequently: true });
    cx.drawImage(img, 0, 0, W, H);
    var data = cx.getImageData(0, 0, W, H).data;

    // ---- 灰度 + 色彩统计 ----
    var gray = new Float32Array(W * H);
    var sumBright = 0, sumSat = 0;
    var greenish = 0, blueish = 0, whitish = 0;
    for (var i = 0, p = 0; i < data.length; i += 4, p++) {
      var r = data[i], g = data[i + 1], b = data[i + 2];
      var lum = 0.299 * r + 0.587 * g + 0.114 * b;
      gray[p] = lum;
      sumBright += lum;

      var mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      var sat = mx === 0 ? 0 : (mx - mn) / mx;
      sumSat += sat;

      if (g > r + 18 && g > b + 18) greenish++;
      if (b > r + 22 && b > g + 8) blueish++;
      if (mn > 200 && sat < 0.12) whitish++;
    }
    var n = W * H;
    var brightness = sumBright / n / 255;
    var saturation = sumSat / n;
    var greenRatio = greenish / n;
    var blueRatio = blueish / n;
    var whiteRatio = whitish / n;

    // ---- 清晰度：分块算拉普拉斯方差，取最清晰的那一批 ----
    //
    // 为什么不用"全图方差"：一张对焦完美的照片，如果画面大部分是天空或者
    // 白墙，全图方差一样很低，会被误判成糊。而人要判断"糊没糊"，其实看的是
    // 画面里最锐利的那部分 —— 只要有一块边缘是清楚的，就说明对上了焦。
    // 所以按 16px 切块，每块单独算，最后取前 30% 的均值。
    var BW = 16;
    var blockVars = [];
    var edges = 0;
    for (var by0 = 1; by0 + BW < H - 1; by0 += BW) {
      for (var bx0 = 1; bx0 + BW < W - 1; bx0 += BW) {
        var bs = 0, bs2 = 0, bc = 0;
        for (var yy0 = by0; yy0 < by0 + BW; yy0++) {
          for (var xx0 = bx0; xx0 < bx0 + BW; xx0++) {
            var ii = yy0 * W + xx0;
            var lv = -4 * gray[ii] + gray[ii - 1] + gray[ii + 1] + gray[ii - W] + gray[ii + W];
            bs += lv; bs2 += lv * lv; bc++;
            // 顺带统计边缘
            if (Math.abs(lv) > 26) edges++;
          }
        }
        if (bc > 8) blockVars.push(Math.max(0, bs2 / bc - (bs / bc) * (bs / bc)));
      }
    }

    blockVars.sort(function (a, b) { return b - a; });
    var topN = Math.max(1, Math.round(blockVars.length * 0.3));
    var topMean = 0;
    for (var bi = 0; bi < topN; bi++) topMean += blockVars[bi];
    topMean = topN ? topMean / topN : 0;

    var edgeDensity = edges / n;

    // ---- 平坦区占比：截图和纯色背景的典型特征 ----
    // 按 12px 网格分块，块内方差极小的算「平坦」
    var BLK = 12, flatBlocks = 0, totalBlocks = 0;
    for (var by = 0; by + BLK <= H; by += BLK) {
      for (var bx = 0; bx + BLK <= W; bx += BLK) {
        var s = 0, s2 = 0, c = 0;
        for (var yy = by; yy < by + BLK; yy++) {
          for (var xx = bx; xx < bx + BLK; xx++) {
            var gv = gray[yy * W + xx];
            s += gv; s2 += gv * gv; c++;
          }
        }
        var m = s / c;
        var va = s2 / c - m * m;
        if (va < 34) flatBlocks++;
        totalBlocks++;
      }
    }
    var flatRatio = totalBlocks ? flatBlocks / totalBlocks : 1;

    // 归一化到 0~100。开方是为了压缩动态范围：
    // 清晰照片的 topMean 能到几百，糊图只有个位数，线性映射会挤成一团。
    var sharpScore = Math.max(0, Math.min(100, Math.round(Math.sqrt(topMean) * 3)));

    var dominant = 'mixed';
    if (greenRatio > 0.28) dominant = 'outdoor-green';
    else if (blueRatio > 0.3) dominant = 'sky-water';
    else if (whiteRatio > 0.4) dominant = 'document-screen';
    else if (flatRatio > 0.55) dominant = 'flat-graphic';

    return {
      ok: true,
      width: img.width || img.naturalWidth,
      height: img.height || img.naturalHeight,
      sharpness: Math.round(topMean),
      sharpScore: sharpScore,
      brightness: +brightness.toFixed(3),
      saturation: +saturation.toFixed(3),
      flatRatio: +flatRatio.toFixed(3),
      edgeDensity: +edgeDensity.toFixed(3),
      greenRatio: +greenRatio.toFixed(3),
      blueRatio: +blueRatio.toFixed(3),
      dominant: dominant
    };
  }

  /* ======================================================================
   * 二、判定阈值
   * ==================================================================== */

  /*
   * 阈值不是拍脑袋定的，是用 tools/probe-photo.html 跑六张样例图量出来的：
   *   清晰的设施照   64 / 60 / 40 分
   *   糊掉的夜景      8 分
   * 取 25 分作分界线，两边都有余量。
   *
   * dark 定得比常规低（0.10 而不是 0.14）：报路灯坏了本来就是晚上拍的，
   * 用白天的亮度标准会把最该被受理的那类问题挡在门外。
   */
  var THRESH = {
    blur: 25,          // sharpScore 低于此值判为模糊
    dark: 0.10,        // 亮度低于此值判为过暗
    overexposed: 0.94, // 高于此值判为过曝
    flat: 0.88,        // 平坦区超过此值才怀疑是截图
    flatEdge: 0.012    // 且边缘密度也极低，两个条件同时满足
  };

  /* ======================================================================
   * 三、闸门一：视觉质量（纯算法）
   * ==================================================================== */

  function gateVision(m) {
    var issues = [];
    var reason = null;
    var message = '';

    if (!m.ok) {
      return { id: 'vision', pass: true, degraded: true, reason: null, message: '图片未能解析，已放行待人工复核' };
    }

    if (m.sharpScore < THRESH.blur) {
      reason = 'blur';
      message = '这张照片有点糊，手抖了一下吧？';
      issues.push('清晰度 ' + m.sharpScore + '/100，低于阈值 ' + THRESH.blur);
    } else if (m.brightness < THRESH.dark) {
      reason = 'dark';
      message = '照片太暗了，看不太清设施本身';
      issues.push('平均亮度 ' + (m.brightness * 100).toFixed(0) + '%，低于 ' + (THRESH.dark * 100) + '%');
    } else if (m.brightness > THRESH.overexposed) {
      reason = 'overexposed';
      message = '照片曝得太亮了，细节都没了';
      issues.push('平均亮度 ' + (m.brightness * 100).toFixed(0) + '%，接近纯白');
    } else if (m.flatRatio > THRESH.flat && m.edgeDensity < THRESH.flatEdge) {
      reason = 'flat';
      message = '这张不太像现场拍的，像是截图或者纯色图';
      issues.push('平坦区占比 ' + (m.flatRatio * 100).toFixed(0) + '%，边缘密度 ' + (m.edgeDensity * 100).toFixed(1) + '%');
    }

    return {
      id: 'vision',
      pass: !reason,
      reason: reason,
      message: message,
      metrics: m,
      issues: issues
    };
  }

  /* ======================================================================
   * 四、闸门二：语义一致性（本地规则版，离线兜底）
   * ==================================================================== */

  /**
   * 关键词 → 它究竟属于哪一类。用户选错了，就在这里现形。
   *
   * also 是「同样说得通」的类型。一个东西往往跨两类：井盖缺失既是设施损坏，
   * 更是安全隐患；护栏松动既算设施也算安全。只写单一归属会导致大量误拦 ——
   * 用户选的完全合理，系统却说他选错了，这比不拦更伤信任。
   */
  var SEMANTIC_RULES = [
    { words: ['路灯', '灯不亮', '照明', '灯管', '灯泡', '灯罩', '频闪', '闪烁'],
      belongs: 'lighting', also: [] },
    { words: ['垃圾', '满溢', '垃圾桶', '异味', '臭味', '发臭', '污渍', '小广告', '脏乱'],
      belongs: 'sanitation', also: [] },
    { words: ['漏水', '积水', '水管', '下水', '返味', '直饮水', '喷水', '渗水', '排水'],
      belongs: 'water', also: ['facility'] },
    { words: ['护栏', '扶手', '座椅', '台阶', '门禁', '玻璃', '断裂', '松动', '损坏', '变形'],
      belongs: 'facility', also: ['safety'] },
    { words: ['漏电', '电线', '外露', '倒塌', '坍塌', '围墙', '裂缝', '塌陷', '下沉', '井盖', '危险'],
      belongs: 'safety', also: ['facility', 'road'] },
    { words: ['坑洼', '地砖', '路面', '柏油', '减速带', '马路牙', '塌方'],
      belongs: 'road', also: ['safety'] },
    { words: ['树枝', '树倒', '倒伏', '草坪', '绿化', '花坛', '落叶'],
      belongs: 'green', also: [] },
    { words: ['停车', '乱停', '闸机', '占道', '单车', '电动车', '违停'],
      belongs: 'traffic', also: [] },
    { words: ['网络', '断网', '信号', '广播', '监控', '摄像头', '弱电', '网线'],
      belongs: 'network', also: [] }
  ];

  var NON_FACILITY_WORDS = ['自拍', '风景', '随手拍', '截图', '网图', '表情包', '打卡', '天空', '夕阳', '好看'];

  function gateSemanticRules(ctx) {
    var desc = (ctx.desc || '').trim();
    var picked = ctx.type;
    var metrics = ctx.metrics || {};

    // 1) 描述里明确写了「这不是设施」
    for (var i = 0; i < NON_FACILITY_WORDS.length; i++) {
      if (desc.indexOf(NON_FACILITY_WORDS[i]) >= 0) {
        return {
          id: 'semantic', pass: false, reason: 'non-facility',
          message: '这张更像' + NON_FACILITY_WORDS[i] + '，没找到要报的设施',
          detail: '描述里提到了「' + NON_FACILITY_WORDS[i] + '」'
        };
      }
    }

    // 2) 「是不是设施」不再靠色彩分布自动判定。
    //    试过用蓝绿占比识别风景照，但夜里路灯的主导色同样是蓝的，
    //    误伤比命中多。这类判断交给描述文本，以及 DeepSeek 综合指标去判断。

    // 3) 描述与所选类型冲突
    if (desc) {
      for (var j = 0; j < SEMANTIC_RULES.length; j++) {
        var rule = SEMANTIC_RULES[j];
        var hit = null;
        for (var k = 0; k < rule.words.length; k++) {
          if (desc.indexOf(rule.words[k]) >= 0) { hit = rule.words[k]; break; }
        }
        var acceptable = rule.belongs === picked ||
          (rule.also && rule.also.indexOf(picked) >= 0);
        if (hit && !acceptable) {
          // 「其他」不参与冲突判定，用户本来就没选具体类
          if (picked === 'other') break;
          return {
            id: 'semantic', pass: false, reason: 'mismatch',
            message: '你写的内容更像「' + (global.Domain ? Domain.type(rule.belongs).label : rule.belongs) + '」类问题',
            detail: '描述里出现了「' + hit + '」，与所选的「' +
              (global.Domain ? Domain.type(picked).label : picked) + '」不一致',
            suggestType: rule.belongs
          };
        }
      }
    }

    // 4) 没描述也没问题 —— 通过
    return {
      id: 'semantic', pass: true, reason: null,
      message: desc ? '描述和所选类型一致' : '没有描述，按图片判断',
      detail: ''
    };
  }

  /* ======================================================================
   * 五、闸门二：语义一致性（DeepSeek 版）
   * ==================================================================== */

  var SYSTEM_PROMPT = [
    '你是「见微」系统的上报质检员。你的唯一任务：判断一条来自校园/乡村居民的公共设施问题上报，是否值得进入工单池。',
    '',
    '你会随消息收到上报人拍的原图（若消息里没有图，说明这次只有统计指标，按指标推断）。',
    '有图时以画面为准：先看图，再看文字。文字描述只作参考——很多人写不全，但照片不会撒谎。',
    '同时会给出一组程序测量指标（同一张图算出来的），用来印证你的观察，不是让你复述数字：',
    '  sharpScore  0-100，清晰度（拉普拉斯方差归一化）。低于 30 基本是糊的。',
    '  brightness  0-1，平均亮度。低于 0.14 是黑图或夜间无光，高于 0.93 是过曝。',
    '  saturation  0-1，平均饱和度。',
    '  flatRatio   0-1，平坦区块占比。截图、纯色图、表格页通常 > 0.6。',
    '  edgeDensity 0-1，边缘像素占比。真实场景照片通常 0.06-0.25。',
    '  dominant    主导色彩类型，取值 outdoor-green / sky-water / document-screen / flat-graphic / mixed。',
    '',
    '判定三条标准，任一不满足即判为不通过：',
    '  1. 图像可用：能看清现场。糊到认不出、全黑、过曝、纯色图、屏幕截图、聊天记录，判不通过。',
    '  2. 内容对题：画面里确实是一处公共设施或公共空间的问题（路面裂缝、井盖缺失、路灯不亮、水管漏水、垃圾堆积、护栏损坏、线缆外露、绿化缺损……）。',
    '     若拍的是风景、人像、宠物、美食、室内私物，判不通过，reason 用 non-facility。',
    '     不允许"猜"：画面里找不出问题时，宁可判不通过，也不要替用户编一个出来。',
    '  3. 类型一致：画面中的问题，与用户选的类型必须是同一类。选「照明路灯」却拍的是水管漏水，判不通过，reason 用 mismatch。',
    '     若两种解释都说得通（例如积水既可算给排水、也涉路面），按用户所选类型通过，并在 detail 里注明。',
    '',
    '同时给出：',
    '  seen      40 字以内，只写画面上实际看到的东西和位置关系（例如「夜间路面正中一处积水，反光，旁边是路缘石」）。',
    '            这一项用于核对是否真的看了图：不要写推断，不要写"可能""似乎"，不要复述用户描述。',
    '  severity  1-5 的紧急度整数。判断依据是「对人身安全的威胁程度」和「影响范围」，不是用户有多着急。',
    '            5 = 可能直接伤人的（井盖缺失、电线外露、护栏脱落）；',
    '            4 = 有安全隐患但不立即伤人；3 = 影响正常使用；2 = 影响体验；1 = 观感问题。',
    '  summary   20 字以内的问题摘要，动词开头，例如「路灯灯罩破损，夜间无照明」。',
    '  advice    30 字以内给管理端的处置建议，要具体到动作，例如「建议夜间带电检修，重点查线路接头」。',
    '',
    '几条边界，别踩：',
    '  - 画质以本地指标为准。只有你自己也看不清现场时才判 blur/overexposed；',
    '    夜里路灯不亮、雨天积水这类本来就暗，别因为画面暗就驳回——那是它该有的样子。',
    '  - 不认识的设施不要硬编，用「疑似」表述。',
    '  - 严格按用户选的那一类判"像不像"，不要因为你觉得该归别的部门就驳回。',
    '',
    '语气要求：拒绝时不要像机器在驳回。用「建议换一张」而不是「不符合要求」。',
    '',
    '严格只输出 JSON，不要 markdown 代码块，不要任何解释文字。字段：',
    '{',
    '  "seen": "40 字内，画面上实际看到的东西",',
    '  "pass": true|false,',
    '  "reason": "blur"|"dark"|"overexposed"|"flat"|"non-facility"|"mismatch"|null,',
    '  "message": "给用户看的一句话，20 字内，温和",',
    '  "detail": "给管理员看的判定依据，40 字内",',
    '  "severity": 1-5,',
    '  "summary": "20 字内摘要",',
    '  "advice": "30 字内处置建议"',
    '}'
  ].join('\n');

  /**
   * 这张图能不能直接喂给模型。
   * 只认位图：演示用的样例图是 SVG 插画，模型会正确判定"这不是照片"，
   * 反而把演示流程卡死；所以样例图一律走指标 + 本地规则。
   */
  function isRasterImage(src) {
    if (!src || typeof src !== 'string') return false;
    if (/^data:image\/(jpeg|jpg|png|webp|gif);base64,/i.test(src)) {
      // 48 MiB 是上游上限，本地代理也有闸，8 MiB 以上直接不传图，免得整条请求失败
      return src.length <= 8 * 1024 * 1024;
    }
    return /^https?:\/\/\S+\.(jpe?g|png|webp|gif)(\?\S*)?$/i.test(src);
  }

  function buildUserPrompt(ctx, opts) {
    var o = opts || {};
    var m = ctx.metrics || {};
    var typeLabel = global.Domain ? Domain.type(ctx.type).label : ctx.type;
    var lines = [
      o.hasImage
        ? '【图片】消息里附了原图一张，请直接看画面。'
        : '【图片】本条没有原图，只能依据下面的指标推断，请保守判断。',
      '',
      '【上报内容】',
      '问题类型：' + typeLabel,
      '用户描述：' + (ctx.desc ? '「' + ctx.desc + '」' : '（未填写）'),
      '上报地点：' + (ctx.address || '未知'),
      '',
      '【图像指标（同一张图的程序测量，可交叉印证）】',
      '清晰度 sharpScore：' + (m.sharpScore != null ? m.sharpScore : '未知'),
      '亮度 brightness：' + (m.brightness != null ? m.brightness : '未知'),
      '饱和度 saturation：' + (m.saturation != null ? m.saturation : '未知'),
      '平坦区占比 flatRatio：' + (m.flatRatio != null ? m.flatRatio : '未知'),
      '边缘密度 edgeDensity：' + (m.edgeDensity != null ? m.edgeDensity : '未知'),
      '主导色彩 dominant：' + (m.dominant || '未知')
    ];

    if (ctx.history && ctx.history.length) {
      lines.push('');
      lines.push('【该地点附近 24 小时内的历史上报】');
      ctx.history.slice(0, 4).forEach(function (h) {
        lines.push('- ' + h.typeLabel + '，' + h.ago + '，' + (h.summary || '无摘要'));
      });
    }
    return lines.join('\n');
  }

  function judgeByDeepSeek(ctx, cfg) {
    var hasImage = isRasterImage(ctx.image);
    var prompt = buildUserPrompt(ctx, { hasImage: hasImage });

    var body = {
      model: cfg.model || 'deepseek-flash',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: hasImage
            ? [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: ctx.image, detail: 'high' } }
              ]
            : prompt
        }
      ],
      temperature: 0.2,
      max_tokens: 600,
      response_format: { type: 'json_object' },
      // 判定是短任务：开思维链只会把等待从 2 秒拉到 10 秒、还多花钱。
      // 约束力交给 prompt 里的字段定义。
      thinking: { type: 'disabled' }
    };

    var url = (cfg.endpoint || '').replace(/\/+$/, '') + '/chat/completions';
    var headers = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) headers['Authorization'] = 'Bearer ' + cfg.apiKey;

    var t0 = Date.now();
    return fetch(url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body)
    })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (j) {
        var raw = j.choices && j.choices[0] && j.choices[0].message
          ? j.choices[0].message.content : '';
        var parsed = safeParseJSON(raw);
        if (!parsed) throw new Error('模型返回的不是合法 JSON');
        return {
          id: 'semantic',
          pass: parsed.pass !== false,
          reason: parsed.reason || null,
          message: parsed.message || '',
          detail: parsed.detail || '',
          severity: clampSeverity(parsed.severity),
          summary: parsed.summary || '',
          advice: parsed.advice || '',
          // 模型自述"看到了什么"，用来核对它是否真把图看进去了
          seen: parsed.seen || '',
          vision: hasImage,
          source: 'deepseek',
          latency: Date.now() - t0,
          raw: raw
        };
      });
  }

  /** 模型偶尔会包一层 ```json，三级清洗 */
  function safeParseJSON(text) {
    if (!text) return null;
    var s = String(text).trim();
    // 1) 直接解析
    try { return JSON.parse(s); } catch (e) { /* 继续 */ }
    // 2) 抠出第一个 { ... }
    var i = s.indexOf('{');
    var j = s.lastIndexOf('}');
    if (i >= 0 && j > i) {
      try { return JSON.parse(s.slice(i, j + 1)); } catch (e2) { /* 继续 */ }
    }
    // 3) 去掉 markdown 围栏再试
    s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    try { return JSON.parse(s); } catch (e3) { return null; }
  }

  function clampSeverity(v) {
    var n = Math.round(Number(v));
    if (!isFinite(n)) return 2;
    return Math.max(1, Math.min(5, n));
  }

  /* ======================================================================
   * 六、智能体主体
   * ==================================================================== */

  /**
   * @param {Object} opts
   *   mode      'auto' | 'rules' | 'deepseek'
   *   endpoint  DeepSeek 兼容端点，默认走本地代理 http://localhost:8787/v1
   *   apiKey    直连时才需要；走代理时密钥留在服务端，前端不碰
   *   model     默认 deepseek-chat
   *   timeout   毫秒，默认 12000
   */
  function createAgent(opts) {
    opts = opts || {};
    var cfg = {
      mode: opts.mode || 'auto',
      endpoint: opts.endpoint || 'http://localhost:8787/v1',
      apiKey: opts.apiKey || '',
      model: opts.model || 'deepseek-chat',
      timeout: opts.timeout || 12000
    };

    var status = { mode: 'rules', online: false, vision: false, lastError: '', checkedAt: 0 };

    /** 探测代理是否活着。活着就用真模型，否则回落到本地规则。 */
    function probe() {
      if (cfg.mode === 'rules') {
        status.mode = 'rules';
        status.online = false;
        return Promise.resolve(status);
      }
      var base = cfg.endpoint.replace(/\/v1\/?$/, '');
      var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var timer = ctl ? setTimeout(function () { ctl.abort(); }, 1500) : null;

      return fetch(base + '/health', { signal: ctl ? ctl.signal : undefined })
        .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('bad')); })
        .then(function (j) {
          if (timer) clearTimeout(timer);
          status.online = !!(j && j.ok);
          status.mode = status.online ? 'deepseek' : 'rules';
          status.model = (j && j.model) || cfg.model;
          status.hasKey = !!(j && j.hasKey);
          status.vision = !!(j && j.vision);
          status.lastError = '';
          status.checkedAt = Date.now();
          return status;
        })
        .catch(function (e) {
          if (timer) clearTimeout(timer);
          status.online = false;
          status.mode = 'rules';
          status.lastError = e && e.name === 'AbortError' ? '代理无响应' : '未检测到本地代理';
          status.checkedAt = Date.now();
          return status;
        });
    }

    /**
     * 主入口：跑完整的两道闸门
     * @param {Object} ctx { image, type, desc, address, lng, lat, history }
     * @returns {Promise<Object>} verdict
     */
    function judge(ctx) {
      var t0 = Date.now();
      return analyzeImage(ctx.image).then(function (metrics) {
        var vision = gateVision(metrics);
        var local = { metrics: metrics, desc: ctx.desc, type: ctx.type };

        // 视觉闸门已经拦下，没必要再花钱调模型
        if (!vision.pass) {
          return finish({
            pass: false,
            gates: [vision],
            reason: vision.reason,
            message: vision.message,
            severity: 0,
            source: 'rules',
            seen: '',
            sawImage: false,
            metrics: metrics,
            latency: Date.now() - t0
          });
        }

        var semanticPromise;
        if (status.mode === 'deepseek') {
          var enriched = Object.assign({ metrics: metrics }, ctx);
          semanticPromise = judgeByDeepSeek(enriched, cfg).catch(function (e) {
            status.lastError = String(e && e.message || e);
            // 模型挂了也要给用户一个出口 —— 降级放行，标人工复核
            var fb = gateSemanticRules(local);
            fb.degraded = true;
            fb.detail = (fb.detail || '') + '（模型不可用，已降级为本地规则）';
            return fb;
          });
        } else {
          semanticPromise = Promise.resolve(gateSemanticRules(local));
        }

        return semanticPromise.then(function (sem) {
          var gates = [vision, sem];
          var severity = sem.severity || estimateSeverity(ctx, metrics);

          /* 否决权怎么分，取决于模型到底看到了什么。
             —— 有图（vision=true）：模型手里是原始画面，是这道闸门里最有资格说话的一方，
                它的判断直接采纳。否则就等于"让它看，又不信它"。
             —— 没图（样例插画、或者关闭了视觉）：它只是拿几个统计数字在猜。
                拿数字猜"这图太平淡"，会把夜里的路灯实拍全部毙掉，
                而路灯问题恰好都发生在夜里。这种情况一律降级成建议。 */
          var VISUAL_REASONS = { blur: 1, dark: 1, overexposed: 1, flat: 1, 'non-facility': 1 };
          var soft = false;
          if (sem.pass === false && VISUAL_REASONS[sem.reason] && vision.pass) {
            soft = !sem.vision;
          }

          /* 类型错配在有图时同理。没图时还要本地规则背书：
             domain.js 里的 also 兼容表是人工校过的领域知识，
             同一段"路面积水"，模型可能算给排水，也可能算道路破损。 */
          if (!soft && sem.pass === false && sem.reason === 'mismatch'
              && sem.source === 'deepseek' && !sem.vision) {
            var localSem = gateSemanticRules(local);
            if (localSem.pass) soft = true;
          }

          return finish({
            pass: soft ? true : sem.pass,
            gates: gates,
            reason: soft ? null : sem.reason,
            message: sem.message,
            detail: soft
              ? '模型没拿到原图，只凭统计量认为画质偏弱；本地指标判定通过，已按通过处理'
              : sem.detail,
            softHint: soft ? sem.message : null,
            suggestType: sem.suggestType,
            summary: sem.summary || autoSummary(ctx),
            advice: sem.advice || autoAdvice(ctx),
            severity: severity,
            source: sem.source || 'rules',
            // 模型自述的"看到了什么" —— 后台抽屉里展示，证明这次是真看了图
            seen: sem.seen || '',
            sawImage: !!sem.vision,
            metrics: metrics,
            degraded: !!sem.degraded,
            latency: Date.now() - t0
          });
        });
      });
    }

    function finish(v) {
      v.at = Date.now();
      // 强制兜底：任何情况下 pass 必须是布尔值
      v.pass = v.pass !== false;
      return v;
    }

    /** 模型没给 severity 时，用类型基准 + 指标微调 */
    function estimateSeverity(ctx, m) {
      var base = global.Domain ? Domain.type(ctx.type).base : 2;
      if (ctx.type === 'safety') base = 4;
      if (m && m.edgeDensity > 0.18) base = Math.min(5, base + 1);
      return base;
    }

    function autoSummary(ctx) {
      var label = global.Domain ? Domain.type(ctx.type).label : '设施';
      var d = (ctx.desc || '').trim();
      if (!d) return label + '问题待核查';
      return d.length > 20 ? d.slice(0, 20) + '…' : d;
    }

    function autoAdvice(ctx) {
      var deptName = global.Domain ? Domain.deptFor(ctx.type).short : '相关班组';
      return '建议派' + deptName + '现场核实后处置';
    }

    return {
      judge: judge,
      probe: probe,
      status: function () { return Object.assign({}, status); },
      configure: function (patch) {
        Object.assign(cfg, patch || {});
        return probe();
      },
      config: function () { return Object.assign({}, cfg); },
      SYSTEM_PROMPT: SYSTEM_PROMPT
    };
  }

  /* ======================================================================
   * 七、导出
   * ==================================================================== */

  var SentinelAgent = {
    create: createAgent,
    analyzeImage: analyzeImage,
    THRESH: THRESH,
    SYSTEM_PROMPT: SYSTEM_PROMPT,
    /** 暴露给测试用 */
    _gateSemanticRules: gateSemanticRules,
    _safeParseJSON: safeParseJSON
  };

  if (typeof module === 'object' && module.exports) module.exports = SentinelAgent;
  global.SentinelAgent = SentinelAgent;

})(typeof window !== 'undefined' ? window : this);
