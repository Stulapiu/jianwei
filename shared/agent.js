/* ==========================================================================
 * 见微 · 哨兵智能体（Sentinel Agent）
 * --------------------------------------------------------------------------
 * 职责：在一条上报进入数据库之前，判断它值不值得占用管理端的处理资源。
 *
 * 流程是「先本地、后模型」，不是二选一：
 *   第一关 · 本地准入 —— 用真实图像算法算清晰度/亮度/结构，不调模型
 *   第二关 · 内容判定 —— 必须交给 DeepSeek（看图 + 文字）
 *
 * 为什么本地放前面：
 *   糊到看不清、全黑、纯色截图这类图，模型也救不回来，送去只会白花钱、
 *   还多等好几秒。本地几十毫秒就能判，判不过直接让用户重拍，不占用模型。
 *
 * 为什么模型是必经路径：
 *   本地指标只回答「清不清晰」，回答不了「画面里是不是一处设施」。一张写满
 *   字的作业本，在这四项指标上全部健康 —— 这就是之前放行它的原因。
 *   所以只要本地过了，就必须让模型真看图；模型没连上就明说没连上，
 *   绝不拿规则模板冒充 AI，也不生成一段和照片对不上的「分析」。
 *
 * 模型这一关做的是「整理」而不是「质检」：
 *   类型点错由模型自己改；只有画面和描述真的对不上时，才把改好的版本
 *   带回去让用户确认一次。
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
    blackout: 0.035,   // 低于此值不是"暗"，是镜头被挡/没开灯
    overexposed: 0.94, // 高于此值判为过曝
    flat: 0.88,        // 平坦区超过此值才怀疑是截图
    flatEdge: 0.012,   // 且边缘密度也极低，两个条件同时满足
    noEdge: 0.004,     // 边缘密度低于此值……
    noInfoSharp: 12    // ……且清晰度也极低 = 画面里没有任何结构
  };

  /* ======================================================================
   * 三、闸门一：视觉质量（纯算法）
   * ==================================================================== */

  /**
   * 本地准入是「过 / 不过」的开关，不再分软硬两档。
   *
   * 以前分 soft / hard：糊图、暗图只提示，照样送去模型。结果是同一张糊到
   * 看不清的图，模型在模糊的画面里猜一个答案，用户还以为系统看清楚了。
   * 现在统一成：本地过不了就重拍，不往下走 —— 不猜、不硬着头皮分析。
   *
   * 唯一放宽的是 dark 的阈值（0.10，而不是白天的 0.14）：夜里路灯坏了
   * 本来就该是暗的，这条线只拦「真的什么都看不见」，不拦夜景。
   */
  function gateVision(m) {
    var issues = [];
    var reason = null;
    var message = '';

    if (!m || !m.ok) {
      return {
        id: 'vision', pass: false, hard: true, reason: 'unreadable',
        message: '这张图没读出来，换一张试试',
        issues: ['图片解码失败'], metrics: m || null
      };
    }

    // 整张图几乎没有超过阈值的梯度，清晰度也贴着地板 —— 这不是"糊"，
    // 这是没拍到任何有结构的物体。实测中挡住镜头、拍桌面、拍纯色墙
    // 都会落在这个区间（edgeDensity 0.000、sharpScore 个位数）。
    // 注意第三个条件：整张图几乎全平（>= 0.95）才算"没拍到东西"。
    // 一张糊掉的街景 flatRatio 只有 0.88，它其实是"拍糊了"，不是"对着白墙"，
    // 该给的提示是"重拍"，不是"你挡住镜头了"。
    var noContent = (m.edgeDensity < THRESH.noEdge && m.sharpScore < THRESH.noInfoSharp && m.flatRatio >= 0.95)
      || (m.flatRatio >= 0.97 && m.edgeDensity < 0.008);

    if (noContent) {
      reason = 'blank';
      message = '这张照片里看不出任何东西，是不是挡住镜头了？';
      issues.push('边缘密度 ' + (m.edgeDensity * 100).toFixed(1) + '%，清晰度 ' + m.sharpScore +
        '/100，画面没有可辨识的结构');
    } else if (m.brightness < THRESH.blackout) {
      reason = 'blackout';
      message = '照片基本是黑的，什么也看不见';
      issues.push('平均亮度 ' + (m.brightness * 100).toFixed(0) + '%，低于 ' + (THRESH.blackout * 100) + '%');
    } else if (m.brightness > THRESH.overexposed) {
      reason = 'overexposed';
      message = '照片曝得太亮了，细节都没了';
      issues.push('平均亮度 ' + (m.brightness * 100).toFixed(0) + '%，接近纯白');
    } else if (m.flatRatio > THRESH.flat && m.edgeDensity < THRESH.flatEdge) {
      reason = 'flat';
      message = '这张不太像现场拍的，像是截图或者纯色图';
      issues.push('平坦区占比 ' + (m.flatRatio * 100).toFixed(0) + '%，边缘密度 ' + (m.edgeDensity * 100).toFixed(1) + '%');
    } else if (m.sharpScore < THRESH.blur) {
      reason = 'blur';
      message = '这张照片太糊了，手别抖，对焦到设施上再拍一张';
      issues.push('清晰度 ' + m.sharpScore + '/100，低于阈值 ' + THRESH.blur);
    } else if (m.brightness < THRESH.dark) {
      reason = 'dark';
      message = '太暗了，开个灯或者打开闪光灯再拍一张';
      issues.push('平均亮度 ' + (m.brightness * 100).toFixed(0) + '%，低于 ' + (THRESH.dark * 100) + '%');
    }

    return {
      id: 'vision',
      pass: !reason,
      reason: reason,
      hard: !!reason,
      message: message,
      metrics: m,
      issues: issues
    };
  }

  /* ======================================================================
   * 四、第二关：内容判定（DeepSeek）
   * --------------------------------------------------------------------
   * 这里没有「关键词猜类型」的本地版了。
   * 原因很简单：词表能猜中「井盖」，猜不中「一个黑洞洞的方坑」；
   * 能认出「路灯」两个字，认不出照片里那根杆子就是路灯。
   * 拿它兜底只会让系统在没有看图的情况下也显得"分析过了"。
   * ==================================================================== */

  var SYSTEM_PROMPT = [
    '你是「见微」系统的上报分析员。你的任务不是驳回，而是把一条粗糙的上报整理成一张准确的工单。',
    '',
    '你会随消息收到上报人拍的原图（若消息里没有图，说明这次只有文字，按文字判断）。',
    '有图时以画面为准：先看图，再看文字。文字只是参考——很多人写不全，但照片不会撒谎。',
    '如果附图画的是示意图/插画而不是实拍，不要因为"这不是照片"就驳回，按画面里表现的内容判断。',
    '同时会给出一组程序测量指标（同一张图算出来的），用来印证你的观察，不是让你复述数字：',
    '  sharpScore  0-100，清晰度（拉普拉斯方差归一化）。低于 30 基本是糊的。',
    '  brightness  0-1，平均亮度。低于 0.14 是黑图或夜间无光，高于 0.93 是过曝。',
    '  saturation  0-1，平均饱和度。',
    '  flatRatio   0-1，平坦区块占比。截图、纯色图、表格页通常 > 0.6。',
    '  edgeDensity 0-1，边缘像素占比。真实场景照片通常 0.06-0.25。',
    '  dominant    主导色彩类型，取值 outdoor-green / sky-water / document-screen / flat-graphic / mixed。',
    '',
    '只有一种情况判不通过（pass=false）：画面里根本没有可以处置的公共设施问题。',
    '  - 糊到认不出、全黑、过曝、纯色图、屏幕截图、聊天记录 → reason 用 blank / blackout / blur / overexposed。',
    '  - 拍的是风景、人像、宠物、美食、室内私物 → reason 用 non-facility。',
    '  - 找不出问题时宁可判不通过，也不要替用户编一个出来。',
    '',
    '类型选错不是驳回理由，是你的工作。用户点错分类很常见，你要自己改成对的那个：',
    '  safety 安全隐患 / lighting 照明路灯 / road 道路破损 / water 给排水 /',
    '  facility 设施损坏 / sanitation 环境卫生 / green 绿化养护 / traffic 交通秩序 /',
    '  network 网络通信 / other 其他问题',
    '  拿不准时按"哪个部门来修"归类，跨两类的选更紧急的那类。',
    '',
    '还要判断一件事：描述和画面是否矛盾。',
    '  - 类型点错但描述和画面一致 → conflict=false，只改 type。',
    '  - 描述说的是 A、画面里是 B（例如描述"灯不亮"，照片却是井盖破损）→ conflict=true，',
    '    并在 desc 里按画面重写一句话描述，type 也改成画面对应的类型。',
    '  - 用户没写描述 → conflict=false，在 desc 里补一句画面描述。',
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
    '  - 不要因为"该归别的部门"就驳回，改 type 就行。',
    '',
    '语气要求：拒绝时不要像机器在驳回。用「建议换一张」而不是「不符合要求」。',
    '',
    '严格只输出 JSON，不要 markdown 代码块，不要任何解释文字。字段：',
    '{',
    '  "pass": true|false,',
    '  "reason": null|"blank"|"blackout"|"blur"|"overexposed"|"non-facility",',
    '  "seen": "40 字内，画面上实际看到的东西",',
    '  "type": "safety|lighting|road|water|facility|sanitation|green|traffic|network|other",',
    '  "desc": "40 字内的一句话描述，按画面写；用户写得对就沿用他的原话",',
    '  "conflict": true|false,',
    '  "conflictNote": "20 字内，说清楚哪里对不上；没有矛盾就留空",',
    '  "message": "给用户看的一句话，20 字内，温和",',
    '  "detail": "给管理员看的判定依据，40 字内",',
    '  "severity": 1-5,',
    '  "summary": "20 字内摘要",',
    '  "advice": "30 字内处置建议"',
    '}'
  ].join('\n');

  /* ----------------------------------------------------------------------
   * 即时预判：图片一传上来就问一次，不等提交
   * --------------------------------------------------------------------
   * 用处有两个，都在"提交前"：
   *   1. 把最可能的类型顶到前面，用户点错分类的概率直接降一半；
   *   2. 在描述框下面给一句"你可能想上报：某处井盖破损"，点一下就能填。
   *
   * 这个请求要比判定轻 —— 它跑在用户还在打字的间隙里，
   * 慢一点用户就自己写完点了提交，白花一次钱。所以 max_tokens 压到 200。
   * -------------------------------------------------------------------- */

  var PREVIEW_PROMPT = [
    '你是上报页的识别助手。看这张照片，用一句话告诉用户"你可能想报什么"。',
    '',
    '只判断两件事：',
    '  1. 画面里有没有需要维修的公共设施问题（有 / 没有）。',
    '  2. 属于哪一类：safety 安全隐患 / lighting 照明路灯 / road 道路破损 / water 给排水 /',
    '     facility 设施损坏 / sanitation 环境卫生 / green 绿化养护 / traffic 交通秩序 /',
    '     network 网络通信 / other 其他问题。',
    '',
    '描述要求：12-24 个字，说清"什么东西、什么状态、在哪里"，不要加主观评价，不要用"可能"。',
    '例如：「图书馆南侧路面井盖缺失，边缘外露」「3 号楼西侧路灯灯罩破损」。',
    '画面里没有设施问题时 isFacility=false，desc 说明拍到了什么。',
    '',
    '严格只输出 JSON：',
    '{',
    '  "isFacility": true|false,',
    '  "type": "上面的英文 id",',
    '  "desc": "12-24 字的描述",',
    '  "confidence": 0.0-1.0',
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
        ? (ctx.demo
            ? '【图片】消息里附了一张演示用的示意图，请按画面表现的内容判断，不要因为不是实拍就驳回。'
            : '【图片】消息里附了原图一张，请直接看画面。')
        : '【图片】本条没有原图（这类问题常常拍不了照），只能依据文字判断，不要因为没图就驳回。',
      '',
      '【上报内容】',
      '问题类型（用户点的，仅供参考，点错了你直接改）：' + typeLabel,
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

  /** 模型偶尔会返回中文标签、大小写混写，统一压成类型 id */
  var TYPE_HINT = {
    '安全': 'safety', '隐患': 'safety', '井盖': 'safety', '护栏': 'safety', '电线': 'safety',
    '路灯': 'lighting', '照明': 'lighting', '灯': 'lighting',
    '道路': 'road', '路面': 'road', '坑洼': 'road', '地砖': 'road',
    '给排水': 'water', '积水': 'water', '漏水': 'water', '下水': 'water',
    '设施': 'facility', '座椅': 'facility', '门禁': 'facility',
    '卫生': 'sanitation', '垃圾': 'sanitation', '清洁': 'sanitation',
    '绿化': 'green', '树': 'green', '草坪': 'green',
    '交通': 'traffic', '停车': 'traffic', '占道': 'traffic',
    '网络': 'network', '通信': 'network', '信号': 'network',
    '其他': 'other', '其它': 'other'
  };

  var TYPE_IDS = {
    safety: 1, lighting: 1, road: 1, water: 1, facility: 1,
    sanitation: 1, green: 1, traffic: 1, network: 1, other: 1
  };

  function normalizeType(v) {
    if (!v) return null;
    var s = String(v).trim();
    var low = s.toLowerCase();
    if (TYPE_IDS[low]) return low;
    if (TYPE_HINT[s]) return TYPE_HINT[s];
    // 「安全隐患」这种带后缀的写法
    var keys = Object.keys(TYPE_HINT).sort(function (a, b) { return b.length - a.length; });
    for (var i = 0; i < keys.length; i++) {
      if (s.indexOf(keys[i]) >= 0) return TYPE_HINT[keys[i]];
    }
    return null;
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
          // 它认为该归哪一类 —— 类型点错时直接采信，不驳回
          type: normalizeType(parsed.type),
          // 按画面重写的一句话描述（用户没写或写岔了才会用上）
          desc: (parsed.desc || '').trim(),
          conflict: !!parsed.conflict,
          conflictNote: parsed.conflictNote || '',
          vision: hasImage,
          source: 'deepseek',
          latency: Date.now() - t0,
          raw: raw
        };
      });
  }

  /* ----------------------------------------------------------------------
   * 即时预判请求
   * -------------------------------------------------------------------- */
  function previewByDeepSeek(ctx, cfg) {
    var hasImage = isRasterImage(ctx.image);
    if (!hasImage) return Promise.reject(new Error('NOT_RASTER'));

    var body = {
      model: cfg.model || 'deepseek-flash',
      messages: [
        { role: 'system', content: PREVIEW_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: '地点：' + (ctx.address || '校园内') + '。这张照片像什么问题？' },
            { type: 'image_url', image_url: { url: ctx.image, detail: 'high' } }
          ]
        }
      ],
      temperature: 0.1,
      max_tokens: 220,
      response_format: { type: 'json_object' },
      thinking: { type: 'disabled' }
    };

    var url = (cfg.endpoint || '').replace(/\/+$/, '') + '/chat/completions';
    var headers = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) headers['Authorization'] = 'Bearer ' + cfg.apiKey;

    var t0 = Date.now();
    return fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(body) })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (j) {
        var raw = j.choices && j.choices[0] && j.choices[0].message
          ? j.choices[0].message.content : '';
        var p = safeParseJSON(raw);
        if (!p) throw new Error('BAD_JSON');
        var t = normalizeType(p.type);
        if (!t) t = 'other';
        return {
          ok: true,
          isFacility: p.isFacility !== false,
          type: t,
          typeLabel: global.Domain ? Domain.type(t).label : t,
          desc: (p.desc || '').trim().slice(0, 40),
          confidence: typeof p.confidence === 'number' ? p.confidence : 0.6,
          raw: raw,
          latency: Date.now() - t0
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

    var status = { mode: 'offline', online: false, vision: false, lastError: '', checkedAt: 0 };

    /* ----------------------------------------------------------------
     * 判定过程留档
     * ----------------------------------------------------------------
     * 用户问过一句很实在的话："图片真的通过 AI 识别了吗？"
     * 这句话不该由界面上的一个绿点来回答。这里把每一次判定的原料、
     * 指标、两道闸门的结论、模型的原始输出都留一份，设置页里可以原样翻出来看。
     *
     * 只留最近几条，存在内存 + localStorage（刷新后还能看上一次）。
     * 不留原图 —— 只留图片长度和指标，够复盘，也不占空间。
     * ---------------------------------------------------------------- */
    var DEBUG_KEY = 'jw.ailog.v2';
    var LAST = { judge: null, preview: null };

    function note(kind, rec) {
      rec.at = Date.now();
      LAST[kind] = rec;
      try {
        var all = JSON.parse(localStorage.getItem(DEBUG_KEY) || '[]');
        if (!Array.isArray(all)) all = [];
        all.unshift(Object.assign({ kind: kind }, rec));
        localStorage.setItem(DEBUG_KEY, JSON.stringify(all.slice(0, 6)));
      } catch (e) { /* 存不进去不影响判定 */ }
      return rec;
    }

    /** 读历史：设置页用 */
    function history() {
      try {
        var all = JSON.parse(localStorage.getItem(DEBUG_KEY) || '[]');
        return Array.isArray(all) ? all : [];
      } catch (e) { return []; }
    }

    /** 探测代理是否活着。探不到就如实标记离线 —— 没有"回落到规则"这一步。 */
    function probe() {
      if (cfg.mode === 'rules') {
        status.mode = 'offline';
        status.online = false;
        status.lastError = '已关闭模型调用（mode: rules）';
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
          status.mode = status.online ? 'deepseek' : 'offline';
          status.model = (j && j.model) || cfg.model;
          status.hasKey = !!(j && j.hasKey);
          status.vision = !!(j && j.vision);
          status.lastError = status.online
            ? ''
            : (j && j.hasKey === false
                ? '本地代理已启动，但没有配置 DEEPSEEK_API_KEY'
                : '本地 AI 服务未就绪');
          status.checkedAt = Date.now();
          return status;
        })
        .catch(function (e) {
          if (timer) clearTimeout(timer);
          status.online = false;
          status.mode = 'offline';
          status.lastError = e && e.name === 'AbortError' ? '本地代理无响应' : '未检测到本地 AI 服务';
          status.checkedAt = Date.now();
          return status;
        });
    }

    /**
     * 主入口：先本地准入，过了再交给模型。
     * 外面裹一层留档 —— 无论从哪个分支返回，判定过程都能在设置页翻出来。
     */
    function judge(ctx) {
      var t0 = Date.now();
      // 提交前确认一次 AI 还在线。探不到就明说探不到，不退回规则。
      // 30 秒内刚确认过在线就不再探，省一次 /health 往返。
      var fresh = status.online && (Date.now() - (status.checkedAt || 0) < 30000);
      var ready = (cfg.mode === 'rules' || fresh) ? Promise.resolve(status) : probe();
      return ready.then(function () {
        return judgeInner(ctx, t0);
      }).then(function (v) {
        note('judge', {
          mode: status.mode,
          online: status.online,
          hasPhoto: !!(ctx.image && String(ctx.image).length > 8),
          raster: isRasterImage(ctx.image),
          demo: !!ctx.demo,
          imageLen: ctx.image ? String(ctx.image).length : 0,
          typeIn: ctx.type,
          desc: ctx.desc || '',
          address: ctx.address || '',
          metrics: v.metrics || null,
          raw: v.raw || '',
          preview: LAST.preview,
          gates: (v.gates || []).map(function (g) {
            return {
              id: g.id, pass: g.pass, reason: g.reason || null,
              message: g.message || '', detail: (g.detail || '').slice(0, 240)
            };
          }),
          verdict: {
            pass: v.pass, stage: v.stage || '',
            reason: v.reason || null, message: v.message || '',
            detail: (v.detail || '').slice(0, 240),
            type: v.type, typeAdjusted: !!v.typeAdjusted,
            review: !!v.review, reviewWhy: v.reviewWhy || '',
            source: v.source, sawImage: !!v.sawImage, seen: v.seen || '',
            severity: v.severity, latency: v.latency || 0
          }
        });
        return v;
      });
    }

    /**
     * @param {Object} ctx { image, type, desc, address, lng, lat, history }
     * @returns {Promise<Object>} verdict
     */
    function judgeInner(ctx, t0) {
      var hasPhoto = !!(ctx.image && String(ctx.image).length > 8);

      /* 没照片的单子（校园网卡、系统故障这类本来就没法拍）：
         跳过本地画质关，但仍然交给模型 —— 只是这次它读的是文字。 */
      if (!hasPhoto) {
        var shortDesc = (ctx.desc || '').trim().length < 4;
        if (shortDesc) {
          return Promise.resolve(finish({
            pass: false,
            stage: 'local',
            gates: [],
            reason: 'no-info',
            message: '这一类不用拍照，但得写一句是什么问题',
            detail: '没有照片，描述又不足 4 个字，无法判断',
            severity: 0,
            source: 'local',
            seen: '',
            sawImage: false,
            metrics: null,
            noPhoto: true,
            latency: Date.now() - t0
          }));
        }
        return judgeByAi(ctx, t0, {
          metrics: null,
          vision: { pass: true, noPhoto: true }
        });
      }

      return analyzeImage(ctx.image).then(function (metrics) {
        var vision = gateVision(metrics);

        /* 本地没过 —— 到此为止。
           不送到模型那里"碰碰运气"，也不替用户猜一个结论。
           前端拿到 stage:'local' 就知道该让人重拍，而不是转人工。 */
        if (!vision.pass) {
          return finish({
            pass: false,
            stage: 'local',
            gates: [vision],
            reason: vision.reason,
            message: vision.message,
            detail: '本地画质检查没过，这张没有送去 AI 分析',
            severity: 0,
            source: 'local',
            seen: '',
            sawImage: false,
            metrics: metrics,
            latency: Date.now() - t0
          });
        }

        // 本地过了，就必须让模型真看图。这里没有再往下分叉的路。
        return judgeByAi(Object.assign({ metrics: metrics }, ctx), t0, {
          metrics: metrics,
          vision: vision
        });
      });
    }

    /**
     * 第二关：模型判定。唯一的分支是「AI 在不在线」，而不是「要不要用规则」。
     * 不在线就返回失败让前端提示重试 —— 没有降级、没有模板摘要。
     */
    function judgeByAi(ctx, t0, env) {
      if (status.mode !== 'deepseek') {
        return Promise.resolve(finish({
          pass: false,
          stage: 'ai',
          aiUnavailable: true,
          gates: env.vision && !env.vision.noPhoto ? [env.vision] : [],
          reason: 'ai-offline',
          message: 'AI 没连上，这条还没有分析',
          detail: status.lastError || '本地 AI 服务未连接，启动代理后再试',
          severity: 0,
          source: 'none',
          seen: '',
          sawImage: false,
          metrics: env.metrics || null,
          latency: Date.now() - t0
        }));
      }

      return judgeByDeepSeek(ctx, cfg).then(function (sem) {
        // 纯文字的判定，模型看不到画面，它说的"看不清"一律不算数
        if (!ctx.image && sem.pass === false &&
            /blur|dark|exposed|blank|blackout|flat/.test(sem.reason || '')) {
          sem.pass = true;
          sem.reason = null;
          sem.message = '';
          sem.detail = '没有照片，画质类判断不适用';
        }
        return finish(compose(ctx, sem, {
          metrics: env.metrics || null,
          vision: env.vision || { pass: true, noPhoto: true },
          t0: t0
        }));
      }).catch(function (e) {
        status.lastError = String(e && e.message || e);
        // 这一次失败了，下一次提交要重新探活，别拿旧的"在线"状态继续用
        status.online = false;
        status.mode = 'offline';
        return finish({
          pass: false,
          stage: 'ai',
          aiFailed: true,
          reason: 'ai-failed',
          message: 'AI 调用失败，这条还没有分析',
          detail: status.lastError,
          severity: 0,
          source: 'none',
          seen: '',
          sawImage: false,
          metrics: env.metrics || null,
          latency: Date.now() - t0
        });
      });
    }

    /**
     * 把模型的结论和上下文合成最终裁定。
     * 这里做三件事：
     *   1. 类型自动纠正 —— 点错分类不再是驳回理由；
     *   2. 矛盾检测 —— 描述和画面对不上时，把 AI 改好的版本带回去让用户确认；
     *   3. 把 review 这些标记一次算清，前端不用再猜。
     */
    function compose(ctx, sem, env) {
      var vision = env.vision || {};
      var metrics = env.metrics || null;

      // 旧版本会返回 mismatch，现在一律当"类型点错"处理，不驳回
      if (sem.reason === 'mismatch') {
        sem.pass = true;
        sem.detail = sem.detail || '类型与内容不符，已按内容自动归类';
        sem.reason = null;
      }

      // 模型没看到图时，画质类结论降级成提示（拿统计量猜"这图太平"会误杀夜景）
      var VISUAL_REASONS = { blur: 1, dark: 1, overexposed: 1, flat: 1, blank: 1, blackout: 1, 'non-facility': 1 };
      var soft = false;
      if (sem.pass === false && VISUAL_REASONS[sem.reason] && !sem.vision) {
        soft = true;
      }

      var passed = soft ? true : sem.pass;

      // ---- 类型自动纠正 ----
      // 只认模型给的 type —— 点错分类不是用户的错，更不该成为驳回理由。
      var finalType = ctx.type;
      var typeAdjusted = false;
      var candType = sem.type;
      if (candType && (!global.Domain || Domain.TYPE_MAP[candType])) {
        if (candType !== ctx.type) {
          finalType = candType;
          typeAdjusted = true;
        }
      }

      // ---- 描述矛盾 ----
      // 只在"真有图、模型真看了、它说对不上"时才要求用户二次确认。
      // 类型点错不算矛盾 —— 那种情况用户根本不需要知道。
      var conflict = !!(passed && sem.vision && sem.conflict && sem.desc);

      var severity = sem.severity || estimateSeverity({ type: finalType }, metrics);
      var review = false;

      /* 有照片、却没跑上视觉模型 —— 这张单等于没被"看过"。
         本地指标只回答"清不清晰、亮不亮、平不平"，它回答不了"画面里是不是一处设施"。
         一张打印纸、一张电脑屏幕、一张人脸，在它眼里都是"清晰、亮度正常、有边缘"。
         所以这种单不能当干净单混进池子，必须转人工看一眼，并且在结果页说清楚。 */
      var offlinePhoto = !!metrics && isRasterImage(ctx.image) && !sem.vision;
      if (offlinePhoto) review = true;

      return {
        pass: passed,
        gates: [vision, sem],
        reason: soft ? null : sem.reason,
        message: sem.message,
        detail: soft
          ? '模型没拿到原图，只凭统计量认为画质偏弱；本地指标判定通过，已按通过处理'
          : sem.detail,
        softHint: soft ? sem.message : null,

        // 类型：可能被模型改过
        type: finalType,
        typeAdjusted: typeAdjusted,
        typeFrom: typeAdjusted ? ctx.type : null,

        // 矛盾确认：前端拿这三个字段弹二次确认
        conflict: conflict,
        conflictNote: sem.conflictNote || '',
        suggestDesc: conflict ? sem.desc : '',

        // 摘要与建议只认模型给的原文。
        // 以前这里会按类型套一句「某类问题待核查」—— 那是模板，不是判断，
        // 摆出来只会让人以为 AI 已经看过了。模型没给就留空，宁可不写。
        summary: sem.summary || '',
        advice: sem.advice || '',
        severity: severity,
        source: sem.source || 'deepseek',
        // 模型自述的"看到了什么" —— 后台抽屉里展示，证明这次是真看了图
        seen: sem.seen || '',
        sawImage: !!sem.vision,
        metrics: metrics,
        degraded: false,
        qualityHint: null,
        review: passed && review,
        // 转复核要有个理由，界面才能说人话
        reviewWhy: !passed ? '' : offlinePhoto ? 'no-vision' : '',
        // 模型的原始输出，只在"分析过程"里给人看，不参与业务判断
        raw: sem.raw || '',
        noPhoto: !metrics,
        latency: Date.now() - (env.t0 || Date.now())
      };
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

    /**
     * 只跑本地准入，不调模型。
     * 选完图立刻给一次反馈：糊了、太暗、像截图，当场提示重拍，
     * 不用等用户填完一整张表单、点了提交才被拦。
     */
    function check(image) {
      return analyzeImage(image).then(function (metrics) {
        var vision = gateVision(metrics);
        return {
          ok: vision.pass,
          metrics: metrics,
          vision: vision,
          reason: vision.reason,
          message: vision.message
        };
      });
    }

    /**
     * 即时预判。图片一选中就调，用来顶候选类型和描述建议。
     * 不阻塞提交：拿不到结果就当没有，界面不显示建议即可。
     * 注意这里**不做**任何本地"猜类型"的兜底 —— 猜错了比不猜更糟。
     */
    function preview(ctx) {
      var base = {
        at: Date.now(),
        mode: status.mode,
        raster: isRasterImage(ctx.image),
        imageLen: ctx.image ? String(ctx.image).length : 0,
        address: ctx.address || ''
      };
      function done(r) {
        LAST.preview = Object.assign({}, base, {
          ok: !!r.ok,
          reason: r.reason || (r.ok ? '' : 'unknown'),
          type: r.type || '', desc: r.desc || '',
          confidence: r.confidence,
          isFacility: r.isFacility,
          raw: (r.raw || '').slice(0, 400)
        });
        return r;
      }
      if (!isRasterImage(ctx.image)) {
        return Promise.resolve(done({ ok: false, reason: 'sample' }));
      }
      if (status.mode !== 'deepseek') {
        return Promise.resolve(done({ ok: false, reason: 'offline', lastError: status.lastError }));
      }
      return previewByDeepSeek(ctx, cfg).then(done).catch(function (e) {
        return done({ ok: false, reason: String(e && e.message || e) });
      });
    }

    return {
      judge: judge,
      check: check,
      preview: preview,
      probe: probe,
      status: function () { return Object.assign({}, status); },
      /** 「AI 分析过程」用：最近一次判定 + 最近一次预判 + 历史记录 */
      debug: function () {
        return { last: LAST.judge, preview: LAST.preview, history: history() };
      },
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
    _gateVision: gateVision,
    _safeParseJSON: safeParseJSON,
    _normalizeType: normalizeType
  };

  if (typeof module === 'object' && module.exports) module.exports = SentinelAgent;
  global.SentinelAgent = SentinelAgent;

})(typeof window !== 'undefined' ? window : this);
