/* ============================================================
   见微 · 用户端数据层
   ------------------------------------------------------------
   三块内容：
     1. 静态数据：郑州大学主校区的真实经纬度点位、我的上报、徽章
     2. 现场照片：用 SVG 画，不依赖任何图片文件
        —— 演示需要稳定复现「糊图」「风景照」这类失败用例，
           现成照片没法控，自己画才能保证每次讲都一样
     3. 判定入口：转交给 SentinelAgent（真实图像算法 + DeepSeek）

   坐标说明：全部为 WGS-84，与 navigator.geolocation 同一坐标系。
   地图组件内部会转成 GCJ-02 再打在高德底图上。
   ============================================================ */
(function (global) {
  'use strict';

  var D = global.Domain;
  var TM = global.TileMap;

  /* ================= 1. 常量 ================= */

  // 类型直接用领域词汇表，用户端和管理端不会再各写一份
  var TYPES = D.TYPES.map(function (t) {
    return { key: t.id, label: t.label, icon: t.icon, hint: t.hint, color: t.color };
  });
  var TYPE_LABEL = {};
  TYPES.forEach(function (t) { TYPE_LABEL[t.key] = t.label; });

  var STATUS = {
    pending:    { label: '待处理',   color: '#D9483F' },
    processing: { label: '处理中',   color: '#C97E15' },
    review:     { label: '人工复核', color: '#6B7C8A' },
    resolved:   { label: '已解决',   color: '#3E8A5F' },
    rejected:   { label: '被驳回',   color: '#93A2A0' }
  };

  /* ================= 2. 校园地块（给地图画注记用） ================= */

  /**
   * 校区主要地标。用户端不画这些，只是给「附近有什么」的文案用；
   * 管理端会拿来做区域聚合命名。
   */
  var LANDMARKS = [
    { id: 'lib',    name: '图书馆',     lng: 113.5315, lat: 34.8181 },
    { id: 'admin',  name: '行政楼',     lng: 113.5296, lat: 34.8190 },
    { id: 'teach',  name: '教学区',     lng: 113.5355, lat: 34.8166 },
    { id: 'eng',    name: '工科园',     lng: 113.5332, lat: 34.8196 },
    { id: 'med',    name: '医学院',     lng: 113.5368, lat: 34.8210 },
    { id: 'liuyuan',name: '柳园宿舍',   lng: 113.5276, lat: 34.8129 },
    { id: 'heyuan', name: '荷园宿舍',   lng: 113.5270, lat: 34.8202 },
    { id: 'canteen',name: '菊园食堂',   lng: 113.5312, lat: 34.8133 },
    { id: 'sport',  name: '体育场',     lng: 113.5352, lat: 34.8123 },
    { id: 'lake',   name: '人工湖',     lng: 113.5341, lat: 34.8197 },
    { id: 'south',  name: '南门',       lng: 113.5311, lat: 34.8100 },
    { id: 'north',  name: '北门',       lng: 113.5321, lat: 34.8236 }
  ];

  /* ================= 3. 地图点位 ================= */

  /**
   * 说明：这些坐标是按校区布局换算的真实经纬度（演示用近似值，
   * 误差在 20 米内）。用户端展示时会再做一次「脱敏」——
   * 把坐标随机偏移 ±15 米显示，避免精确暴露具体楼栋。
   */
  var POINTS = [
    // --- 待处理 ---
    { id: 'p1', type: 'sanitation', lng: 113.5279, lat: 34.8132, status: 'pending', addr: '柳园 6 号楼东侧垃圾点', ago: 0.2, by: '陈', merged: 0 },
    { id: 'p2', type: 'lighting',   lng: 113.5314, lat: 34.8175, status: 'pending', addr: '图书馆南广场路灯', ago: 0.6, by: '李', merged: 3, reporters: 4 },
    { id: 'p3', type: 'safety',     lng: 113.5336, lat: 34.8152, status: 'pending', addr: '教学区主路井盖缺失', ago: 1.1, by: '王', merged: 0, reporters: 1 },
    { id: 'p4', type: 'lighting',   lng: 113.5290, lat: 34.8155, status: 'pending', addr: '柳园至食堂小路',     ago: 1.8, by: '张', merged: 2 },
    { id: 'p5', type: 'sanitation', lng: 113.5316, lat: 34.8136, status: 'pending', addr: '菊园食堂东南角',     ago: 2.4, by: '刘', merged: 0 },
    { id: 'p6', type: 'facility',   lng: 113.5310, lat: 34.8186, status: 'pending', addr: '图书馆二层无障碍坡道', ago: 3.2, by: '赵', merged: 0 },
    { id: 'p7', type: 'safety',     lng: 113.5375, lat: 34.8192, status: 'pending', addr: '医学院北侧围墙',    ago: 4.5, by: '孙', merged: 0 },
    { id: 'p8', type: 'road',       lng: 113.5313, lat: 34.8113, status: 'pending', addr: '南门内主干道',      ago: 5.1, by: '周', merged: 1 },
    { id: 'p9', type: 'traffic',    lng: 113.5344, lat: 34.8113, status: 'pending', addr: '体育场东门非机动车占道', ago: 6.2, by: '吴', merged: 0 },
    { id: 'p10', type: 'green',     lng: 113.5288, lat: 34.8198, status: 'pending', addr: '荷园 3 号楼前树枝断裂', ago: 7.4, by: '郑', merged: 0 },

    // --- 已解决 ---
    { id: 'r1', type: 'sanitation', lng: 113.5283, lat: 34.8140, status: 'resolved', addr: '柳园 4 号楼下',     ago: 2.6, by: '李', merged: 0 },
    { id: 'r2', type: 'lighting',   lng: 113.5322, lat: 34.8168, status: 'resolved', addr: '图书馆东侧公告栏旁', ago: 3.9, by: '吴', merged: 2 },
    { id: 'r3', type: 'facility',   lng: 113.5346, lat: 34.8196, status: 'resolved', addr: '人工湖西岸护栏',    ago: 5.4, by: '郑', merged: 0 },
    { id: 'r4', type: 'safety',     lng: 113.5266, lat: 34.8168, status: 'resolved', addr: '西门内坡道',        ago: 6.8, by: '冯', merged: 1 },
    { id: 'r5', type: 'sanitation', lng: 113.5321, lat: 34.8122, status: 'resolved', addr: '菊园南侧垃圾房',    ago: 8.2, by: '何', merged: 0 },
    { id: 'r6', type: 'water',      lng: 113.5356, lat: 34.8172, status: 'resolved', addr: '教学区 B 座饮水机',  ago: 9.5, by: '钱', merged: 0 }
  ];

  /* ================= 4. 我的上报 ================= */

  var MY_REPORTS = [
    { id: 'q1', type: 'sanitation', status: 'pending',    addr: '柳园 6 号楼东侧垃圾点',     ago: 0.2, merged: 0, photo: 'trash' },
    { id: 'q2', type: 'lighting',   status: 'processing', addr: '图书馆南广场路灯',          ago: 0.6, merged: 3, photo: 'lamp' },
    { id: 'q3', type: 'safety',     status: 'pending',    addr: '教学区主路井盖缺失',        ago: 1.1, merged: 0, photo: 'pothole' },
    { id: 'q4', type: 'sanitation', status: 'resolved',   addr: '柳园 4 号楼下',             ago: 2.6, merged: 0, photo: 'trash' },
    { id: 'q5', type: 'lighting',   status: 'resolved',   addr: '图书馆东侧公告栏旁',        ago: 3.9, merged: 2, photo: 'lamp' },
    { id: 'q6', type: 'facility',   status: 'resolved',   addr: '图书馆二层无障碍坡道',      ago: 5.2, merged: 0, photo: 'pothole' },
    { id: 'q7', type: 'other',      status: 'rejected',   addr: '未识别坐标',                ago: 6.4, merged: 0, photo: 'scenery' },
    { id: 'q8', type: 'safety',     status: 'resolved',   addr: '西门内坡道',                ago: 7.1, merged: 1, photo: 'pothole' },
    { id: 'q9', type: 'road',       status: 'processing', addr: '南门内主干道',              ago: 5.1, merged: 1, photo: 'pothole' }
  ];

  /* ================= 5. 徽章 ================= */

  var BADGES = [
    { code: 'first_report',  name: '初次出勤', icon: 'sprout', desc: '完成第一次有效上报',     tip: '上报一次就能拿到' },
    { code: 'eagle_eye',     name: '火眼金睛', icon: 'eye',    desc: '识别出被忽视的安全隐患', tip: '提交安全隐患类问题，且紧急度达到 4 星' },
    { code: 'gold_sentinel', name: '金牌哨兵', icon: 'shield', desc: '连续 7 天有效上报',      tip: '一天至少一次，连续七天' },
    { code: 'night_watch',   name: '夜巡者',   icon: 'moon',   desc: '在 22:00–06:00 之间上报', tip: '晚上回宿舍路上顺手拍一张' },
    { code: 'crowd',         name: '众人拾柴', icon: 'users',  desc: '你的上报与邻居的合并为同一工单', tip: '同一位置 15 米内、24 小时内有人先报过' },
    { code: 'clean_hand',    name: '清道夫',   icon: 'broom',  desc: '累计 10 条卫生类有效上报', tip: '卫生类问题攒够 10 条' }
  ];

  /* ================= 6. 用户 ================= */

  var USER = {
    name: '李知远',
    initial: '李',
    credit: 86,
    streak: 3,
    validCnt: 12,
    resolvedCnt: 8,
    invalidCnt: 1,
    badges: ['first_report', 'night_watch'],
    openid: 'u_demo_li'
  };

  /* ================= 7. 现场照片（纯 SVG） =================
     尺寸统一 240×180（4:3），够算法算清晰度，也不至于太重。
     这些图会被渲染到 canvas 上再做真实的拉普拉斯方差计算 ——
     所以「拍糊了」那张是真的糊，不是打了个标签。 */

  var uid = 0;

  function photoSVG(kind) {
    var id = 'p' + (++uid);

    function shell(inner, defs) {
      return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 180" ' +
             'width="240" height="180" preserveAspectRatio="xMidYMid slice">' +
             '<defs>' + (defs || '') + '</defs>' + inner + '</svg>';
    }

    switch (kind) {
      /* --- 垃圾桶满溢：清晰、含设施、语义一致 --- */
      case 'trash':
        return shell(
          '<rect width="240" height="180" fill="#94A096"/>' +
          '<rect width="240" height="180" fill="url(#' + id + 'g)"/>' +
          '<path d="M0 146h240" stroke="#77837B" stroke-width="2" opacity=".5"/>' +
          '<path d="M0 166h240" stroke="#77837B" stroke-width="1.6" opacity=".28"/>' +
          '<path d="M76 82h88l-10 82H86z" fill="#3C6B4F"/>' +
          '<path d="M76 82h88l-3 15H79z" fill="#2E5740"/>' +
          '<rect x="66" y="68" width="108" height="15" rx="5" fill="#4A7D5E"/>' +
          '<circle cx="100" cy="64" r="15" fill="#E6E2D6"/>' +
          '<circle cx="128" cy="56" r="18" fill="#D9D4C4"/>' +
          '<circle cx="154" cy="66" r="13" fill="#EDE9DF"/>' +
          '<path d="M112 60l13-17 8 21z" fill="#C7C0AE"/>' +
          '<circle cx="194" cy="158" r="8" fill="#DCD8CA"/>' +
          '<rect x="36" y="152" width="20" height="12" rx="4" fill="#D0CCBE" transform="rotate(-12 46 158)"/>' +
          '<path d="M88 106h64M88 128h64" stroke="#2E5740" stroke-width="2.4" opacity=".55"/>' +
          '<path d="M150 74c8-10 22-12 32-4" stroke="#B9C3BA" stroke-width="2.4" fill="none" opacity=".7"/>',
          '<linearGradient id="' + id + 'g" x1="0" y1="0" x2="0" y2="1">' +
            '<stop offset="0" stop-color="#C4CDC6" stop-opacity=".9"/>' +
            '<stop offset="1" stop-color="#7F8C83" stop-opacity=".9"/></linearGradient>'
        );

      /* --- 路灯不亮：夜间，主体暗 --- */
      case 'lamp':
        return shell(
          '<rect width="240" height="180" fill="#16202C"/>' +
          '<rect width="240" height="180" fill="url(#' + id + 's)"/>' +
          '<path d="M0 128h56V100h40v28h36V94h48v34h60v52H0z" fill="#1B2734"/>' +
          '<rect y="158" width="240" height="22" fill="#232D36"/>' +
          '<rect x="110" y="50" width="8" height="110" rx="4" fill="#7A8894"/>' +
          '<path d="M114 50c0-12 16-16 28-16" stroke="#7A8894" stroke-width="7.4" fill="none" stroke-linecap="round"/>' +
          '<ellipse cx="146" cy="30" rx="17" ry="8" fill="#4E4839"/>' +
          '<ellipse cx="146" cy="33" rx="11" ry="4.6" fill="#6E6448"/>' +
          '<ellipse cx="146" cy="40" rx="12" ry="3.6" fill="#8A8264" opacity=".2"/>' +
          '<circle cx="40" cy="30" r="2.4" fill="#8FA5B8" opacity=".5"/>' +
          '<circle cx="196" cy="24" r="2" fill="#8FA5B8" opacity=".4"/>' +
          '<circle cx="72" cy="18" r="1.8" fill="#8FA5B8" opacity=".35"/>' +
          '<rect x="160" y="138" width="30" height="20" rx="3" fill="#5C6B78" opacity=".8"/>',
          '<linearGradient id="' + id + 's" x1="0" y1="0" x2="0" y2="1">' +
            '<stop offset="0" stop-color="#101823"/>' +
            '<stop offset=".7" stop-color="#26333F"/>' +
            '<stop offset="1" stop-color="#33414C"/></linearGradient>'
        );

      /* --- 井盖缺失：路面黑洞 + 警示锥 --- */
      case 'pothole':
        return shell(
          '<rect width="240" height="180" fill="#4E5457"/>' +
          '<rect width="240" height="180" fill="url(#' + id + 'a)"/>' +
          '<g fill="#6E7477" opacity=".5">' +
            '<circle cx="28" cy="36" r="2"/><circle cx="72" cy="20" r="2.6"/>' +
            '<circle cx="196" cy="44" r="2"/><circle cx="40" cy="150" r="2.6"/>' +
            '<circle cx="212" cy="156" r="2"/><circle cx="144" cy="170" r="2.2"/>' +
            '<circle cx="16" cy="90" r="2.2"/><circle cx="224" cy="96" r="2.4"/>' +
            '<circle cx="180" cy="120" r="1.8"/><circle cx="62" cy="120" r="1.8"/>' +
          '</g>' +
          '<path d="M0 40h240M0 132h240" stroke="#3E4345" stroke-width="2" opacity=".5"/>' +
          '<ellipse cx="120" cy="96" rx="62" ry="46" fill="#171B1D"/>' +
          '<ellipse cx="120" cy="93" rx="54" ry="39" fill="#0A0D0F"/>' +
          '<path d="M64 96c8-24 44-40 72-32" stroke="#808789" stroke-width="4" fill="none" opacity=".42"/>' +
          '<path d="M188 156l14-40 14 40z" fill="#E08A2B"/>' +
          '<rect x="182" y="156" width="40" height="9" rx="4" fill="#C87A1C"/>' +
          '<rect x="190" y="136" width="24" height="7" rx="3" fill="#F2F4F3" opacity=".8"/>' +
          '<path d="M120 60v14" stroke="#9AA1A3" stroke-width="3" stroke-linecap="round" opacity=".6"/>',
          '<linearGradient id="' + id + 'a" x1="0" y1="0" x2="1" y2="1">' +
            '<stop offset="0" stop-color="#5F6568"/>' +
            '<stop offset="1" stop-color="#3E4345"/></linearGradient>'
        );

      /* --- 风景照：会被判定为非设施 --- */
      case 'scenery':
        return shell(
          '<rect width="240" height="180" fill="#D9E8EE"/>' +
          '<rect width="240" height="180" fill="url(#' + id + 'k)"/>' +
          '<circle cx="178" cy="44" r="22" fill="#F4D391" opacity=".9"/>' +
          '<path d="M0 118l54-54 34 34 30-22 62 50z" fill="#96B2A9"/>' +
          '<path d="M100 118l46-46 42 46z" fill="#7E9C93"/>' +
          '<path d="M0 118h240v62H0z" fill="#86A67E"/>' +
          '<path d="M0 136h240v44H0z" fill="#788F71"/>' +
          '<rect x="58" y="124" width="8" height="28" fill="#5E5342"/>' +
          '<circle cx="62" cy="112" r="22" fill="#61905D"/>' +
          '<circle cx="46" cy="124" r="16" fill="#57854F"/>' +
          '<circle cx="80" cy="126" r="14" fill="#6A9A62"/>' +
          '<path d="M184 144l28-12" stroke="#E7EDE5" stroke-width="4" opacity=".45" stroke-linecap="round"/>' +
          '<path d="M20 160c40-8 80-6 120 4" stroke="#93AE88" stroke-width="5" fill="none" opacity=".5"/>',
          '<linearGradient id="' + id + 'k" x1="0" y1="0" x2="0" y2="1">' +
            '<stop offset="0" stop-color="#A3C6D9"/>' +
            '<stop offset=".6" stop-color="#D6E6EB"/>' +
            '<stop offset="1" stop-color="#EAF1EA"/></linearGradient>'
        );

      /* --- 拍糊了：同一栈灯加真实高斯模糊 ---
             注意这里用的 SVG filter 会在渲染到 canvas 时真被执行，
             所以交给算法的是真的模糊像素，不是"假装糊"的元数据 */
      case 'blur':
        return shell(
          '<g filter="url(#' + id + 'f)">' +
            '<rect width="240" height="180" fill="#1A2430"/>' +
            '<rect width="240" height="180" fill="url(#' + id + 's)"/>' +
            '<path d="M0 132h240v48H0z" fill="#28323B"/>' +
            '<rect x="110" y="54" width="10" height="108" fill="#7C8A96"/>' +
            '<path d="M114 54c0-14 16-18 30-18" stroke="#7C8A96" stroke-width="8.8" fill="none" stroke-linecap="round"/>' +
            '<ellipse cx="148" cy="32" rx="20" ry="10" fill="#5A5340"/>' +
          '</g>',
          '<filter id="' + id + 'f" x="-30%" y="-30%" width="160%" height="160%">' +
            '<feGaussianBlur stdDeviation="6.5"/></filter>' +
          '<linearGradient id="' + id + 's" x1="0" y1="0" x2="0" y2="1">' +
            '<stop offset="0" stop-color="#131C26"/>' +
            '<stop offset="1" stop-color="#303C47"/></linearGradient>'
        );

      /* --- 积水：给 05 场景用 --- */
      case 'puddle':
        return shell(
          '<rect width="240" height="180" fill="#5A6165"/>' +
          '<rect width="240" height="180" fill="url(#' + id + 'a)"/>' +
          '<path d="M0 60h240M0 140h240" stroke="#464C4F" stroke-width="3" opacity=".6"/>' +
          '<path d="M20 88c30-14 70-16 104-6 26 8 60 10 96 2v46c-40 10-86 8-120-2-30-9-56-6-80 4z" fill="#2E4A5C" opacity=".92"/>' +
          '<path d="M40 96c26-8 56-9 84-3" stroke="#6E93A8" stroke-width="3" fill="none" opacity=".55"/>' +
          '<path d="M150 104c14 4 30 5 46 2" stroke="#6E93A8" stroke-width="3" fill="none" opacity=".45"/>' +
          '<rect x="196" y="52" width="6" height="52" rx="3" fill="#8E9AA2"/>' +
          '<path d="M199 52c0-8 10-10 18-10" stroke="#8E9AA2" stroke-width="5" fill="none" stroke-linecap="round"/>' +
          '<circle cx="44" cy="40" r="3" fill="#9AA1A3" opacity=".5"/>',
          '<linearGradient id="' + id + 'a" x1="0" y1="0" x2="1" y2="1">' +
            '<stop offset="0" stop-color="#6A7176"/>' +
            '<stop offset="1" stop-color="#4B5155"/></linearGradient>'
        );

      default:
        return shell('<rect width="240" height="180" fill="#DDE5E3"/>');
    }
  }

  /** SVG 字符串 → data URI（给 <img> 和 canvas 用） */
  function photoDataURI(kind) {
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(photoSVG(kind));
  }

  /* ================= 8. 演示场景 ================= */

  var SCENES = [
    {
      key: 'normal', tone: 'ok', n: '01', label: '垃圾桶满溢',
      sub: '完整通过 · 看合并与徽章',
      photo: 'trash', type: 'sanitation',
      desc: '垃圾已经堆到路上了，味道挺大',
      addr: '柳园 6 号楼东侧垃圾点',
      lng: 113.5279, lat: 34.8132
    },
    {
      key: 'blur', tone: 'bad', n: '02', label: '拍糊了',
      sub: '视觉闸门 · 清晰度不足',
      photo: 'blur', type: 'lighting',
      desc: '这盏灯坏了',
      addr: '图书馆南广场路灯',
      lng: 113.5314, lat: 34.8175
    },
    {
      key: 'scenery', tone: 'bad', n: '03', label: '风景照',
      sub: '语义闸门 · 没有设施',
      photo: 'scenery', type: 'other',
      desc: '随手拍的',
      addr: '人工湖边',
      lng: 113.5341, lat: 34.8197
    },
    {
      key: 'mismatch', tone: 'ok', n: '04', label: '图文矛盾',
      sub: '矛盾确认 · 以图为准',
      photo: 'pothole', type: 'lighting',
      desc: '这里水管漏水，地上都是积水',
      addr: '教学区主路',
      lng: 113.5336, lat: 34.8152
    },
    {
      key: 'crowd', tone: 'ok', n: '05', label: '多人续报',
      sub: '合并工单 · 优先级抬升',
      photo: 'pothole', type: 'safety',
      desc: '井盖没了，晚上有人差点掉进去',
      addr: '教学区主路井盖缺失',
      lng: 113.5337, lat: 34.8153   // 距离 p3 约 12 米，会触发合并
    },
    {
      key: 'water', tone: 'ok', n: '06', label: '积水返水',
      sub: '新类型 · 派给水电班组',
      photo: 'puddle', type: 'water',
      desc: '下水道堵了，一直往上返水，积了一大片',
      addr: '菊园食堂东侧排水口',
      lng: 113.5317, lat: 34.8135
    }
  ];

  /* ================= 9. 交互辅助 ================= */

  /** 用真实球面距离找附近未处理点位 */
  function findNearby(lng, lat, type, list, myOpenid) {
    list = list || POINTS;
    return list.filter(function (p) {
      if (p.status !== 'pending' && p.status !== 'processing') return false;
      if (type && p.type !== type) return false;
      return TM.distance(lng, lat, p.lng, p.lat) <= D.MERGE.radius;
    });
  }

  /** 用户端展示用：坐标脱敏偏移 ±15 米，避免暴露到具体楼栋 */
  function fuzz(lng, lat, seed) {
    var s = seed || 1;
    var r = function (n) {
      s = (s * 9301 + 49297) % 233280;
      return s / 233280 - 0.5;
    };
    return [lng + r() * 0.00028, lat + r() * 0.00022];
  }

  global.DATA = {
    TYPES: TYPES,
    TYPE_LABEL: TYPE_LABEL,
    STATUS: STATUS,
    LANDMARKS: LANDMARKS,
    POINTS: POINTS,
    MY_REPORTS: MY_REPORTS,
    BADGES: BADGES,
    USER: USER,
    SCENES: SCENES,
    photoSVG: photoSVG,
    photoDataURI: photoDataURI,
    findNearby: findNearby,
    fuzz: fuzz
  };
})(window);
