/* ==========================================================================
 * 见微 · 轻量瓦片地图
 * --------------------------------------------------------------------------
 * 为什么自己写而不引 Leaflet / 高德 JS API：
 *   1. Leaflet 走 CDN，单文件离线演示会挂；高德 JS API 需要 key，GitHub Pages
 *      上把 key 明文放进前端等于公开，谁都能盗刷。
 *   2. 这个项目只需要「铺一张真实底图 + 打点 + 叠热力」，四个能力。Leaflet
 *      130KB 里 90% 用不上，自己写 400 行还完全可控。
 *
 * 底图用高德栅格瓦片，坐标是 GCJ-02（国测局火星坐标）。浏览器
 * navigator.geolocation 给的是 WGS-84，直接拿去打在 GCJ-02 底图上会偏
 * 300~600 米 —— 在城市尺度看不出来，但校园尺度上就是「点错了一栋楼」。
 * 所以内部统一做 WGS-84 → GCJ-02 转换。
 *
 * 生产环境请换成申请了 key 的高德/天地图服务，别直连瓦片。
 * ========================================================================== */

(function (global) {
  'use strict';

  var TILE_SIZE = 256;
  var PI = Math.PI;

  /* ======================================================================
   * 一、坐标转换
   * ==================================================================== */

  var CRS_A = 6378245.0;            // 克拉索夫斯基椭球长半轴
  var CRS_EE = 0.00669342162296594323; // 第一偏心率平方

  /** 粗略判断是否在中国境外（境外不做偏移） */
  function outOfChina(lng, lat) {
    return !(lng > 73.66 && lng < 135.05 && lat > 3.86 && lat < 53.55);
  }

  function transformLat(lng, lat) {
    var ret = -100.0 + 2.0 * lng + 3.0 * lat + 0.2 * lat * lat +
      0.1 * lng * lat + 0.2 * Math.sqrt(Math.abs(lng));
    ret += (20.0 * Math.sin(6.0 * lng * PI) + 20.0 * Math.sin(2.0 * lng * PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(lat * PI) + 40.0 * Math.sin(lat / 3.0 * PI)) * 2.0 / 3.0;
    ret += (160.0 * Math.sin(lat / 12.0 * PI) + 320 * Math.sin(lat * PI / 30.0)) * 2.0 / 3.0;
    return ret;
  }

  function transformLng(lng, lat) {
    var ret = 300.0 + lng + 2.0 * lat + 0.1 * lng * lng +
      0.1 * lng * lat + 0.1 * Math.sqrt(Math.abs(lng));
    ret += (20.0 * Math.sin(6.0 * lng * PI) + 20.0 * Math.sin(2.0 * lng * PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(lng * PI) + 40.0 * Math.sin(lng / 3.0 * PI)) * 2.0 / 3.0;
    ret += (150.0 * Math.sin(lng / 12.0 * PI) + 300.0 * Math.sin(lng / 30.0 * PI)) * 2.0 / 3.0;
    return ret;
  }

  /** WGS-84 → GCJ-02 */
  function wgs2gcj(lng, lat) {
    if (outOfChina(lng, lat)) return [lng, lat];
    var dLat = transformLat(lng - 105.0, lat - 35.0);
    var dLng = transformLng(lng - 105.0, lat - 35.0);
    var radLat = lat / 180.0 * PI;
    var magic = Math.sin(radLat);
    magic = 1 - CRS_EE * magic * magic;
    var sqrtMagic = Math.sqrt(magic);
    dLat = (dLat * 180.0) / ((CRS_A * (1 - CRS_EE)) / (magic * sqrtMagic) * PI);
    dLng = (dLng * 180.0) / (CRS_A / sqrtMagic * Math.cos(radLat) * PI);
    return [lng + dLng, lat + dLat];
  }

  /** GCJ-02 → WGS-84（迭代反解，两次就够 1 米精度） */
  function gcj2wgs(lng, lat) {
    var wgsLng = lng, wgsLat = lat;
    for (var i = 0; i < 2; i++) {
      var g = wgs2gcj(wgsLng, wgsLat);
      wgsLng += lng - g[0];
      wgsLat += lat - g[1];
    }
    return [wgsLng, wgsLat];
  }

  /** 经纬度 → 世界像素坐标（Web Mercator，zoom 决定总像素边长） */
  function project(lng, lat, zoom) {
    var scale = TILE_SIZE * Math.pow(2, zoom);
    var x = (lng + 180) / 360 * scale;
    var s = Math.sin(lat * PI / 180);
    s = Math.max(-0.9999, Math.min(0.9999, s));
    var y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * PI)) * scale;
    return { x: x, y: y };
  }

  /** Haversine 距离，米 */
  function distance(lng1, lat1, lng2, lat2) {
    var R = 6371000;
    var dLat = (lat2 - lat1) * PI / 180;
    var dLng = (lng2 - lng1) * PI / 180;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * PI / 180) * Math.cos(lat2 * PI / 180) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /* ======================================================================
   * 二、瓦片源
   * ==================================================================== */

  var SOURCES = {
    /** 高德矢量底图，含路网与 POI 注记 */
    gaode: {
      url: 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
      sub: [1, 2, 3, 4],
      maxZoom: 19,
      minZoom: 3
    },
    /** 高德卫星影像 */
    satellite: {
      url: 'https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}',
      sub: [1, 2, 3, 4],
      maxZoom: 19,
      minZoom: 3
    },
    /** 无注记的浅色底图，适合叠热力 —— 注记会把色块搅浑 */
    plain: {
      url: 'https://wprd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&style=7&x={x}&y={y}&z={z}',
      sub: [1, 2, 3, 4],
      maxZoom: 19,
      minZoom: 3
    }
  };

  function fillTemplate(url, x, y, z, s) {
    return url
      .replace('{s}', s)
      .replace('{x}', x)
      .replace('{y}', y)
      .replace('{z}', z);
  }

  /* ======================================================================
   * 三、地图实例
   * ==================================================================== */

  /**
   * @param {HTMLElement} container 容器，需有明确宽高
   * @param {Object} opts
   *   center  [lng, lat] 中心点（WGS-84）
   *   zoom    初始缩放级别，校园尺度 16~17 合适
   *   source  'gaode' | 'satellite' | 'plain'
   *   minZoom / maxZoom
   *   draggable 是否可拖拽，默认 true
   *   interactive 是否可缩放，默认 true
   *   grid   瓦片加载失败时是否显示网格兜底，默认 true
   */
  function createTileMap(container, opts) {
    opts = opts || {};
    var source = SOURCES[opts.source || 'gaode'] || SOURCES.gaode;
    var state = {
      center: opts.center ? opts.center.slice() : [113.5315, 34.8172],
      zoom: opts.zoom || 17,
      minZoom: opts.minZoom || source.minZoom,
      maxZoom: opts.maxZoom || source.maxZoom,
      // 视口左上角在世界坐标系里的像素位置
      originX: 0,
      originY: 0,
      width: 0,
      height: 0,
      tiles: {},        // key: z/x/y → img 元素
      markers: [],
      heat: [],
      failedTiles: 0,
      loadedTiles: 0,
      ready: false
    };

    var layerTiles = document.createElement('div');
    layerTiles.className = 'tm-tiles';

    var layerHeat = document.createElement('canvas');
    layerHeat.className = 'tm-heat';

    var layerMarks = document.createElement('div');
    layerMarks.className = 'tm-marks';

    var gridHint = document.createElement('div');
    gridHint.className = 'tm-grid';
    gridHint.style.display = 'none';

    container.classList.add('tm-root');
    container.appendChild(gridHint);
    container.appendChild(layerTiles);
    container.appendChild(layerHeat);
    container.appendChild(layerMarks);

    var ctx = layerHeat.getContext('2d');

    /* -------- 尺寸与原点 -------- */

    function measure() {
      var r = container.getBoundingClientRect();
      state.width = Math.max(1, Math.round(r.width));
      state.height = Math.max(1, Math.round(r.height));
      layerHeat.width = state.width * (global.devicePixelRatio || 1);
      layerHeat.height = state.height * (global.devicePixelRatio || 1);
      layerHeat.style.width = state.width + 'px';
      layerHeat.style.height = state.height + 'px';
    }

    /**
     * 以视口中心为准，重算 originX/originY。
     * 注意：state.center 存的是 WGS-84（和定位 API 一致），
     * 但瓦片和投影都在 GCJ-02 上，所以这里必须先转换。
     * 漏了这一步，地图和标记会整体错开 300~600 米。
     */
    function syncOrigin() {
      var g = wgs2gcj(state.center[0], state.center[1]);
      var c = project(g[0], g[1], state.zoom);
      state.originX = c.x - state.width / 2;
      state.originY = c.y - state.height / 2;
    }

    /** 经纬度 → 容器内像素 */
    function toPixel(lng, lat) {
      var p = project(lng, lat, state.zoom);
      return { x: p.x - state.originX, y: p.y - state.originY };
    }

    /** 容器内像素 → 经纬度 */
    function toLngLat(px, py) {
      var scale = TILE_SIZE * Math.pow(2, state.zoom);
      var wx = state.originX + px;
      var wy = state.originY + py;
      var lng = wx / scale * 360 - 180;
      var n = PI - 2 * PI * wy / scale;
      var lat = 180 / PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
      return [lng, lat];
    }

    /* -------- 瓦片 -------- */

    function renderTiles() {
      var z = Math.round(state.zoom);
      var scale = Math.pow(2, z);
      var tileX0 = Math.floor(state.originX / TILE_SIZE);
      var tileY0 = Math.floor(state.originY / TILE_SIZE);
      var tileX1 = Math.floor((state.originX + state.width) / TILE_SIZE);
      var tileY1 = Math.floor((state.originY + state.height) / TILE_SIZE);
      var wanted = {};

      for (var tx = tileX0; tx <= tileX1; tx++) {
        for (var ty = tileY0; ty <= tileY1; ty++) {
          if (ty < 0 || ty >= scale) continue;
          var wx = ((tx % scale) + scale) % scale;
          var key = z + '/' + wx + '/' + ty;
          wanted[key] = true;

          if (state.tiles[key]) continue;

          var img = document.createElement('img');
          img.className = 'tm-tile';
          img.alt = '';
          img.decoding = 'async';
          img.draggable = false;
          var sub = source.sub[(tx + ty) % source.sub.length];
          img.src = fillTemplate(source.url, wx, ty, z, sub);
          img._key = key;
          img._tx = tx;
          img._ty = ty;
          img._z = z;

          img.addEventListener('load', function () {
            state.loadedTiles++;
            this.classList.add('is-on');
            if (state.failedTiles > 0 && state.loadedTiles > 2) hideGrid();
          });
          img.addEventListener('error', function () {
            state.failedTiles++;
            this.classList.add('is-bad');
            if (state.failedTiles > 3 && state.loadedTiles === 0) showGrid();
          });

          layerTiles.appendChild(img);
          state.tiles[key] = img;
        }
      }

      // 位置每次都要重算（拖拽时瓦片只移不改 src）
      for (var k in state.tiles) {
        var t = state.tiles[k];
        if (!wanted[k]) {
          // 缩放过期的瓦片直接移除，避免内存堆积
          if (t._z !== z) {
            t.parentNode && t.parentNode.removeChild(t);
            delete state.tiles[k];
            continue;
          }
        }
        t.style.transform = 'translate3d(' +
          (t._tx * TILE_SIZE - state.originX) + 'px,' +
          (t._ty * TILE_SIZE - state.originY) + 'px,0)';
      }
    }

    function showGrid() {
      gridHint.style.display = 'block';
      gridHint.innerHTML = '<span>底图未能加载 · 点位分布仍可查看</span>';
    }
    function hideGrid() {
      gridHint.style.display = 'none';
    }

    /* -------- 标记 -------- */

    /**
     * @param {Array} list [{ id, lng, lat, html, className, onClick, title }]
     *   坐标传 WGS-84；内部自动转 GCJ-02 再投影
     */
    function setMarkers(list) {
      layerMarks.innerHTML = '';
      state.markers = list || [];
      state.markers.forEach(function (m) {
        var el = document.createElement('div');
        el.className = 'tm-mark ' + (m.className || '');
        el.innerHTML = m.html || '';
        if (m.title) el.title = m.title;
        // 逐条写，避免 cssText 覆盖掉组件后面要设的 left/top
        if (m.style) {
          Object.keys(m.style).forEach(function (k) {
            el.style[k] = m.style[k];
          });
        }
        var c = m.lnglat || wgs2gcj(m.lng, m.lat);
        m._c = c;
        if (m.onClick) {
          el.addEventListener('click', function (e) {
            e.stopPropagation();
            m.onClick(m);
          });
        }
        layerMarks.appendChild(el);
        m._el = el;
      });
      placeMarkers();
    }

    function placeMarkers() {
      state.markers.forEach(function (m) {
        if (!m._el) return;
        var p = toPixel(m._c[0], m._c[1]);
        // 只写 left/top，居中偏移交给 CSS 的 translate(-50%,-50%)，
        // 这样标记自身的出现动画还能继续用 transform
        m._el.style.left = p.x + 'px';
        m._el.style.top = p.y + 'px';
        // 屏幕外的标记直接藏起来，省得堆在容器边缘堆成一坨
        var pad = 80;
        var visible = p.x > -pad && p.x < state.width + pad &&
                      p.y > -pad && p.y < state.height + pad;
        m._el.style.visibility = visible ? 'visible' : 'hidden';
      });
    }

    /* -------- 热力 -------- */

    /**
     * @param {Array} pts [{ lng, lat, value }] value 0~1，越大越红
     * @param {Object} cfg { radius, max, color }
     */
    function setHeat(pts, cfg) {
      state.heat = pts || [];
      state.heatCfg = cfg || {};
      renderHeat();
    }

    function renderHeat() {
      var dpr = global.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, state.width, state.height);
      if (!state.heat.length) return;

      var radius = (state.heatCfg.radius || 46);
      var maxVal = state.heatCfg.max || 1;

      // 第一步：把每个点画成灰度径向渐变。
      // 用 lighter 让重叠处的 alpha 累加 —— 默认的 source-over 会让
      // 两个半透明圆叠在一起反而更淡，热力图就出不来「这里最密」的效果。
      ctx.globalCompositeOperation = 'lighter';
      state.heat.forEach(function (h) {
        var c = h.lnglat || wgs2gcj(h.lng, h.lat);
        var p = toPixel(c[0], c[1]);
        if (p.x < -radius || p.y < -radius ||
            p.x > state.width + radius || p.y > state.height + radius) return;
        var v = Math.max(0.05, Math.min(1, (h.value || 0.5) / maxVal));
        var r = radius * (0.62 + v * 0.5);
        var g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
        g.addColorStop(0, 'rgba(0,0,0,' + (0.85 * v) + ')');
        g.addColorStop(0.45, 'rgba(0,0,0,' + (0.42 * v) + ')');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, PI * 2);
        ctx.fill();
      });

      ctx.globalCompositeOperation = 'source-over';

      // 第二步：按累积的 alpha 查色带，把灰度染成热力色
      var img = ctx.getImageData(0, 0, layerHeat.width, layerHeat.height);
      var d = img.data;
      var ramp = state.heatCfg.ramp || [
        [0.00, [ 43, 122, 120]],   // 青绿：低密度
        [0.34, [ 62, 160, 130]],
        [0.52, [222, 186,  74]],   // 黄：中密度
        [0.72, [226, 138,  54]],   // 橙
        [1.00, [201,  60,  52]]    // 红：高密度
      ];
      for (var i = 0; i < d.length; i += 4) {
        var a = d[i + 3];
        if (!a) continue;
        var t = a / 255;
        var c1 = ramp[0], c2 = ramp[ramp.length - 1];
        for (var j = 0; j < ramp.length - 1; j++) {
          if (t >= ramp[j][0] && t <= ramp[j + 1][0]) { c1 = ramp[j]; c2 = ramp[j + 1]; break; }
        }
        var span = (c2[0] - c1[0]) || 1;
        var f = Math.max(0, Math.min(1, (t - c1[0]) / span));
        d[i]     = c1[1][0] + (c2[1][0] - c1[1][0]) * f;
        d[i + 1] = c1[1][1] + (c2[1][1] - c1[1][1]) * f;
        d[i + 2] = c1[1][2] + (c2[1][2] - c1[1][2]) * f;
        d[i + 3] = Math.min(255, a * 1.9);
      }
      ctx.putImageData(img, 0, 0);
    }

    /* -------- 渲染总入口 -------- */

    function render() {
      if (!state.width) measure();
      syncOrigin();
      renderTiles();
      placeMarkers();
      renderHeat();
    }

    /* -------- 交互 -------- */

    var drag = null;

    function onDown(e) {
      if (opts.draggable === false) return;
      if (e.button != null && e.button !== 0) return;
      var pt = e.touches ? e.touches[0] : e;
      var r = container.getBoundingClientRect();
      drag = {
        x: pt.clientX, y: pt.clientY,
        ox: state.originX, oy: state.originY,
        localX: pt.clientX - r.left,
        localY: pt.clientY - r.top,
        moved: false
      };
      container.classList.add('is-dragging');
      if (e.touches) {
        container.addEventListener('touchmove', onMove, { passive: false });
        container.addEventListener('touchend', onUp);
      } else {
        global.addEventListener('mousemove', onMove);
        global.addEventListener('mouseup', onUp);
      }
    }

    function onMove(e) {
      if (!drag) return;
      var pt = e.touches ? e.touches[0] : e;
      var dx = pt.clientX - drag.x;
      var dy = pt.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      if (e.cancelable) e.preventDefault();
      state.originX = drag.ox - dx;
      state.originY = drag.oy - dy;
      renderTiles();
      placeMarkers();
      renderHeat();
    }

    function onUp() {
      if (!drag) return;
      var moved = drag.moved;
      var localX = drag.localX;
      var localY = drag.localY;
      drag = null;
      container.classList.remove('is-dragging');
      container.removeEventListener('touchmove', onMove);
      container.removeEventListener('touchend', onUp);
      global.removeEventListener('mousemove', onMove);
      global.removeEventListener('mouseup', onUp);
      // 拖完把中心点回写。toLngLat 给的是 GCJ，要转回 WGS 再存，
      // 否则下一次 syncOrigin 会把它当成 WGS 再转一次，越转越偏。
      var mid = toLngLat(state.width / 2, state.height / 2);
      var w = gcj2wgs(mid[0], mid[1]);
      state.center = [w[0], w[1]];
      // 没拖动才算「点击」，并把 GCJ-02 转回 WGS-84 交给业务层，
      // 否则外面拿到的坐标和定位 API 给的坐标系不一致
      if (!moved && typeof opts.onClick === 'function') {
        var ll = toLngLat(localX, localY);
        var wgs = gcj2wgs(ll[0], ll[1]);
        opts.onClick(wgs[0], wgs[1]);
      }
    }

    function zoomTo(z, anchorPx, anchorPy) {
      z = Math.max(state.minZoom, Math.min(state.maxZoom, z));
      if (z === state.zoom) return;
      var ax = anchorPx == null ? state.width / 2 : anchorPx;
      var ay = anchorPy == null ? state.height / 2 : anchorPy;
      var before = toLngLat(ax, ay);          // GCJ
      state.zoom = z;
      // 缩放后保持锚点下的地理位置不动
      var after = project(before[0], before[1], z);
      state.originX = after.x - ax;
      state.originY = after.y - ay;
      var mid = toLngLat(state.width / 2, state.height / 2);
      var w = gcj2wgs(mid[0], mid[1]);
      state.center = [w[0], w[1]];
      render();
    }

    container.addEventListener('mousedown', onDown);
    container.addEventListener('touchstart', onDown, { passive: true });

    if (opts.interactive !== false) {
      container.addEventListener('wheel', function (e) {
        e.preventDefault();
        var r = container.getBoundingClientRect();
        var delta = e.deltaY > 0 ? -1 : 1;
        zoomTo(state.zoom + delta, e.clientX - r.left, e.clientY - r.top);
      }, { passive: false });

      // 双击放大
      container.addEventListener('dblclick', function (e) {
        var r = container.getBoundingClientRect();
        zoomTo(state.zoom + 1, e.clientX - r.left, e.clientY - r.top);
      });
    }

    /* -------- 尺寸变化 -------- */

    var ro = null;
    if (global.ResizeObserver) {
      ro = new ResizeObserver(function () {
        var oldW = state.width, oldH = state.height;
        measure();
        if (oldW !== state.width || oldH !== state.height) render();
      });
      ro.observe(container);
    } else {
      global.addEventListener('resize', function () { measure(); render(); });
    }

    /* -------- 对外 API -------- */

    var api = {
      el: container,
      /** 重新测量容器尺寸（display:none → block 之后必须调一次） */
      resize: function () {
        measure();
        syncOrigin();
        render();
        return api;
      },
      render: render,
      setMarkers: setMarkers,
      setHeat: setHeat,
      /**
       * 运行期换底图（标准 / 卫星 / 路网）。
       * 换源要把已加载的瓦片全部丢掉，否则旧图会留在屏幕上，
       * 新瓦片因为 key 已存在而被跳过。
       */
      setSource: function (name) {
        var next = SOURCES[name] || SOURCES.gaode;
        if (next === source) return api;
        source = next;
        state.minZoom = source.minZoom;
        state.maxZoom = source.maxZoom;
        Object.keys(state.tiles).forEach(function (k) {
          var img = state.tiles[k];
          if (img && img.parentNode) img.parentNode.removeChild(img);
        });
        state.tiles = {};
        renderTiles();
        return api;
      },
      /** 平滑移动到某点 */
      flyTo: function (lng, lat, zoom) {
        state.center = [lng, lat];
        if (zoom) state.zoom = Math.max(state.minZoom, Math.min(state.maxZoom, zoom));
        render();
        return api;
      },
      zoomIn: function () { zoomTo(state.zoom + 1); return api; },
      zoomOut: function () { zoomTo(state.zoom - 1); return api; },
      getZoom: function () { return state.zoom; },
      /** 容器内像素坐标换算 */
      toPixel: function (lng, lat) {
        var c = wgs2gcj(lng, lat);
        return toPixel(c[0], c[1]);
      },
      toLngLat: toLngLat,
      center: function () { return state.center.slice(); },
      destroy: function () {
        if (ro) ro.disconnect();
        container.innerHTML = '';
      }
    };

    measure();
    render();
    state.ready = true;
    return api;
  }

  /* ======================================================================
   * 四、导出
   * ==================================================================== */

  var TM = {
    create: createTileMap,
    wgs2gcj: wgs2gcj,
    gcj2wgs: gcj2wgs,
    project: project,
    distance: distance,
    SOURCES: SOURCES,
    /** 郑州大学主校区中心（WGS-84） */
    CAMPUS: { lng: 113.5315, lat: 34.8172, name: '郑州大学主校区' }
  };

  if (typeof module === 'object' && module.exports) module.exports = TM;
  global.TileMap = TM;

})(typeof window !== 'undefined' ? window : this);
