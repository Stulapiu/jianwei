/* ==========================================================================
 * 见微 · 提交闸门（Guard）
 * --------------------------------------------------------------------------
 * 解决的问题：一个人在十分钟里连报二十条，不管是手滑、赌气还是刷积分，
 * 都会把真正需要处理的单子挤下去。而后端不存在（纯前端 + localStorage），
 * 拦不住改代码的人 —— 所以这里的目标不是"防黑客"，是拦住正常用户的
 * 重复提交和情绪化刷屏，同时把异常行为记下来给管理端看。
 *
 * 四道规则，从轻到重：
 *   1. 间隔    两次提交至少隔 25 秒。手滑连点、网络卡了重复点，都在这一层挡掉。
 *   2. 重复    同一类型、80 米内、10 分钟内已经报过 —— 直接告诉用户"这一处你刚报过"，
 *              而不是默默合并。合并会让人以为没提交成功，于是再报一次。
 *   3. 配额    10 分钟 4 条、1 小时 12 条。正常巡查一圈也报不了这么多。
 *   4. 同图    同一张照片 24 小时内只能用在一条上报上。限流拦得住"报得快"，
 *              拦不住"拿同一张图报十次"——那才是刷积分最省事的路子。
 *   5. 冷静期  连续 3 次被 AI 拦下，强制停 5 分钟。这比继续让他试更省事，
 *              也避免有人拿系统当"试探 AI 底线"的玩具。
 *
 * 只记时间戳、类型、坐标和照片指纹，不留照片和描述 —— 这不是用户档案，是限流窗口。
 * ========================================================================== */

(function (global) {
  'use strict';

  var KEY = 'jw.guard.v1';

  var RULES = {
    gapSec: 25,
    dupMs: 10 * 60 * 1000,
    dupMeters: 80,
    samePhotoMs: 24 * 60 * 60 * 1000,
    // 64 位里允许 8 位不同。同一个人把同一张照片重新压缩一次再传，
    // 指纹会有几个 bit 漂移；两万张不同的照片撞在 8 位以内的概率可以忽略。
    samePhotoBits: 8,
    win10: { ms: 10 * 60 * 1000, max: 4 },
    win60: { ms: 60 * 60 * 1000, max: 12 },
    coolAfterReject: 3,
    coolSec: 5 * 60
  };

  /**
   * 给照片算一个平均哈希（8×8 灰度，跟均值比大小）。
   *
   * 为什么需要：限流只能拦住"报得快"，拦不住"拿同一张图报十次"。
   * 同一张照片重复使用，是刷积分最省事的路子 —— 不用出门，改个地址就行。
   * 这里不存原图，只存 16 位十六进制指纹，够比对、也不构成隐私负担。
   *
   * @returns {Promise<string|null>} 失败返回 null，不阻断提交
   */
  function hashImage(dataUrl) {
    return new Promise(function (resolve) {
      if (!dataUrl || typeof dataUrl !== 'string' || dataUrl.indexOf('data:image') !== 0) {
        resolve(null);
        return;
      }
      var img = new Image();
      img.onload = function () {
        try {
          var N = 8;
          var cv = document.createElement('canvas');
          cv.width = N; cv.height = N;
          var cx = cv.getContext('2d');
          cx.drawImage(img, 0, 0, N, N);
          var d = cx.getImageData(0, 0, N, N).data;
          var gray = [], sum = 0;
          for (var i = 0; i < d.length; i += 4) {
            var g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
            gray.push(g); sum += g;
          }
          var mean = sum / gray.length;
          var bits = '';
          for (var k = 0; k < gray.length; k++) bits += gray[k] > mean ? '1' : '0';
          // 64 位 → 16 位十六进制
          var hex = '';
          for (var b = 0; b < 64; b += 4) {
            hex += parseInt(bits.slice(b, b + 4), 2).toString(16);
          }
          resolve(hex);
        } catch (e) {
          resolve(null);   // 画布被污染（跨域图）也不该挡人
        }
      };
      img.onerror = function () { resolve(null); };
      img.src = dataUrl;
    });
  }

  /**
   * 两个指纹像不像。
   *
   * 不用"完全相等"：同一张照片过一遍微信再存下来，或者手机端缩到 1100px、
   * 网页版原样读取，算出来的指纹会差几个 bit。要求相等等于规则形同虚设。
   * 用汉明距离 —— 64 位里差 8 位以内算同一张。
   */
  function similar(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    if (a === b) return true;
    var diff = 0;
    for (var i = 0; i < a.length; i++) {
      var x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
      if (isNaN(x)) return false;
      while (x) { diff += x & 1; x >>= 1; }
      if (diff > RULES.samePhotoBits) return false;
    }
    return diff <= RULES.samePhotoBits;
  }

  function read() {
    try {
      var raw = localStorage.getItem(KEY);
      var o = raw ? JSON.parse(raw) : null;
      if (!o || typeof o !== 'object') throw new Error('empty');
      o.hits = Array.isArray(o.hits) ? o.hits : [];
      o.rejectStreak = o.rejectStreak || 0;
      o.coolUntil = o.coolUntil || 0;
      return o;
    } catch (e) {
      return { hits: [], rejectStreak: 0, coolUntil: 0 };
    }
  }

  function write(o) {
    try {
      // 只留 25 小时内的记录：照片指纹要能回溯一天，限流窗口只要一小时
      var cut = Date.now() - Math.max(RULES.win60.ms, RULES.samePhotoMs) - 60 * 1000;
      o.hits = o.hits.filter(function (h) { return h && h.at > cut; });
      localStorage.setItem(KEY, JSON.stringify(o));
    } catch (e) { /* 存不进去也不该挡住提交 */ }
  }

  function dist(a, b) {
    if (global.TileMap && TileMap.distance) return TileMap.distance(a.lng, a.lat, b.lng, b.lat);
    var R = 6371000;
    var dLat = (b.lat - a.lat) * Math.PI / 180;
    var dLng = (b.lng - a.lng) * Math.PI / 180;
    var la1 = a.lat * Math.PI / 180, la2 = b.lat * Math.PI / 180;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function fmtWait(sec) {
    if (sec >= 60) {
      var m = Math.ceil(sec / 60);
      return m + ' 分钟';
    }
    return Math.max(1, Math.ceil(sec)) + ' 秒';
  }

  /**
   * 提交前问一次。
   * @param {Object} ctx { type, lng, lat }
   * @returns {{ok:boolean, reason?:string, waitSec?:number, message?:string, left?:Object}}
   */
  function check(ctx) {
    var o = read();
    var now = Date.now();
    ctx = ctx || {};

    if (o.coolUntil > now) {
      var wait = Math.ceil((o.coolUntil - now) / 1000);
      return {
        ok: false, reason: 'cool', waitSec: wait,
        message: '连续几次没被识别通过，先歇 ' + fmtWait(wait) + '。' +
          '换个角度重拍一张，或者直接走人工复核入口。'
      };
    }

    var last = o.hits[o.hits.length - 1];
    if (last) {
      var gap = (now - last.at) / 1000;
      if (gap < RULES.gapSec) {
        return {
          ok: false, reason: 'gap', waitSec: RULES.gapSec - gap,
          message: '刚提交过一条，' + fmtWait(RULES.gapSec - gap) + '后再报下一条。' +
            '同一处问题不用重复提交，已经有人在处理了。'
        };
      }
    }

    // 同一张照片 —— 换地址、换类型都躲不掉。
    // 放在"同一处"前面，因为它的证据更硬：位置可以乱改，照片指纹改不了。
    if (ctx.photoHash) {
      for (var p = o.hits.length - 1; p >= 0; p--) {
        var hp = o.hits[p];
        if (now - hp.at > RULES.samePhotoMs) continue;
        if (!hp.photoHash || !similar(hp.photoHash, ctx.photoHash)) continue;
        return {
          ok: false, reason: 'same-photo',
          waitSec: Math.ceil((RULES.samePhotoMs - (now - hp.at)) / 1000),
          code: hp.code || '',
          message: '这张照片和之前报过的一条是同一张' + (hp.code ? '（' + hp.code + '）' : '') +
            '。是同一个问题就在「我的上报」里跟进，不用再报一次；' +
            '如果是新问题，麻烦重新拍一张现场图 —— 审核的人要靠照片判断现场。'
        };
      }
    }

    // 同一处、同一类、10 分钟内 —— 这是最常见的"以为没提交成功"
    if (ctx.type && typeof ctx.lng === 'number') {
      for (var i = o.hits.length - 1; i >= 0; i--) {
        var h = o.hits[i];
        if (now - h.at > RULES.dupMs) continue;
        if (h.type !== ctx.type) continue;
        if (typeof h.lng !== 'number') continue;
        if (dist(ctx, h) <= RULES.dupMeters) {
          return {
            ok: false, reason: 'dup', waitSec: Math.ceil((RULES.dupMs - (now - h.at)) / 1000),
            code: h.code || '',
            message: '这一处你刚刚报过' + (h.code ? '（' + h.code + '）' : '') +
              '，已经在派单了。不用重复提交，处理进度可以在「我的上报」里看。'
          };
        }
      }
    }

    var c10 = o.hits.filter(function (h) { return now - h.at < RULES.win10.ms; }).length;
    if (c10 >= RULES.win10.max) {
      return {
        ok: false, reason: 'quota', waitSec: Math.ceil((o.hits[o.hits.length - RULES.win10.max].at + RULES.win10.ms - now) / 1000),
        message: '10 分钟内已经报了 ' + c10 + ' 条，先停一下。' +
          '一次性报太多反而会让后勤分不清哪条最急，把最要紧的几条说清楚就够了。'
      };
    }

    var c60 = o.hits.filter(function (h) { return now - h.at < RULES.win60.ms; }).length;
    if (c60 >= RULES.win60.max) {
      return {
        ok: false, reason: 'quota', waitSec: Math.ceil((o.hits[0].at + RULES.win60.ms - now) / 1000),
        message: '这一小时已经报了 ' + c60 + ' 条，到上限了。' +
          '有紧急情况请直接打后勤值班电话，比在这里排队快。'
      };
    }

    return {
      ok: true,
      left: { in10: RULES.win10.max - c10, in60: RULES.win60.max - c60 }
    };
  }

  /** 提交成功后记一笔 */
  function record(ctx) {
    var o = read();
    ctx = ctx || {};
    o.hits.push({
      at: Date.now(),
      type: ctx.type || '',
      lng: typeof ctx.lng === 'number' ? ctx.lng : null,
      lat: typeof ctx.lat === 'number' ? ctx.lat : null,
      code: ctx.code || '',
      // 只留指纹，不留图。判重够用，也不构成隐私负担
      photoHash: ctx.photoHash || ''
    });
    o.rejectStreak = 0;
    write(o);
    return o;
  }

  /** AI 拦下一次，累计；够 3 次进冷静期 */
  function noteReject() {
    var o = read();
    o.rejectStreak = (o.rejectStreak || 0) + 1;
    if (o.rejectStreak >= RULES.coolAfterReject) {
      o.coolUntil = Date.now() + RULES.coolSec * 1000;
      o.rejectStreak = 0;
    }
    write(o);
    return o;
  }

  /** 通过一次，清掉连败计数 */
  function notePass() {
    var o = read();
    o.rejectStreak = 0;
    write(o);
    return o;
  }

  /** 给界面看的剩余额度 */
  function remain() {
    var o = read();
    var now = Date.now();
    var c10 = o.hits.filter(function (h) { return now - h.at < RULES.win10.ms; }).length;
    var c60 = o.hits.filter(function (h) { return now - h.at < RULES.win60.ms; }).length;
    return {
      in10: Math.max(0, RULES.win10.max - c10),
      in60: Math.max(0, RULES.win60.max - c60),
      coolLeft: Math.max(0, Math.ceil((o.coolUntil - now) / 1000)),
      streak: o.rejectStreak || 0
    };
  }

  function reset() {
    try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
  }

  var Guard = {
    RULES: RULES,
    check: check,
    record: record,
    noteReject: noteReject,
    notePass: notePass,
    remain: remain,
    reset: reset,
    hashImage: hashImage,
    similar: similar
  };

  if (typeof module === 'object' && module.exports) module.exports = Guard;
  global.Guard = Guard;

})(typeof window !== 'undefined' ? window : this);
