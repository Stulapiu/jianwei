/* ============================================================
   见微 · 通用 UI 层
   ------------------------------------------------------------
   1. 图标：全套 24×24 线条图标，统一 stroke-width 1.7。
      不用 emoji —— emoji 在不同系统上字形差异极大，且无法跟主题色。
   2. toast / sheet：自绘，替代 alert。
   3. 小工具：日期格式化、HTML 转义。
   ============================================================ */
(function (global) {
  'use strict';

  /* ---------------- 图标 ---------------- */
  // 统一描边参数，改一处全套生效
  const P = 'stroke="currentColor" stroke-width="1.7" fill="none" ' +
            'stroke-linecap="round" stroke-linejoin="round"';

  const ICONS = {
    map: '<path d="M9.2 3.8 3.6 6.2v14l5.6-2.4 5.6 2.4 5.6-2.4v-14l-5.6 2.4-5.6-2.4Z" ' + P + '/><path d="M9.2 3.8v14M14.8 6.2v14" ' + P + '/>',
    list: '<path d="M8.4 6.4h11.2M8.4 12h11.2M8.4 17.6h11.2" ' + P + '/><circle cx="4.6" cy="6.4" r="1.1" fill="currentColor"/><circle cx="4.6" cy="12" r="1.1" fill="currentColor"/><circle cx="4.6" cy="17.6" r="1.1" fill="currentColor"/>',
    user: '<circle cx="12" cy="8.2" r="3.7" ' + P + '/><path d="M4.8 20c0-3.7 3.2-6.2 7.2-6.2s7.2 2.5 7.2 6.2" ' + P + '/>',
    back: '<path d="M14.6 5.4 8 12l6.6 6.6" ' + P + '/>',
    close: '<path d="M6.4 6.4l11.2 11.2M17.6 6.4 6.4 17.6" ' + P + '/>',
    plus: '<path d="M12 5.4v13.2M5.4 12h13.2" ' + P + '/>',
    check: '<path d="M5 12.6l4.4 4.4L19 6.8" ' + P + '/>',
    alert: '<path d="M12 4.6 20.4 19H3.6L12 4.6Z" ' + P + '/><path d="M12 9.8v3.8M12 16.6h.01" ' + P + '/>',
    camera: '<path d="M3.6 8.8A1.8 1.8 0 0 1 5.4 7h2.2l1.4-2h6l1.4 2h2.2a1.8 1.8 0 0 1 1.8 1.8v8.4a1.8 1.8 0 0 1-1.8 1.8H5.4a1.8 1.8 0 0 1-1.8-1.8V8.8Z" ' + P + '/><circle cx="12" cy="13" r="3.4" ' + P + '/>',
    locate: '<circle cx="12" cy="12" r="6.6" ' + P + '/><circle cx="12" cy="12" r="2.2" fill="currentColor"/><path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2" ' + P + '/>',
    spark: '<path d="M12 3.4l1.9 5.2 5.2 1.9-5.2 1.9L12 17.6l-1.9-5.2L4.9 10.5l5.2-1.9L12 3.4Z" ' + P + '/><path d="M18.4 16.6l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7.7-1.9Z" ' + P + '/>',
    /* --- 徽章图标 --- */
    sprout: '<path d="M12 20.4v-6.2" ' + P + '/><path d="M12 14.2c0-3 2.2-5.2 5.2-5.2 0 3-2.2 5.2-5.2 5.2Z" ' + P + '/><path d="M12 14.2c0-3.4-2.4-5.8-5.4-5.8 0 3.4 2.4 5.8 5.4 5.8Z" ' + P + '/><path d="M6.6 20.4h10.8" ' + P + '/>',
    eye: '<path d="M2.6 12S6 5.8 12 5.8 21.4 12 21.4 12 18 18.2 12 18.2 2.6 12 2.6 12Z" ' + P + '/><circle cx="12" cy="12" r="2.9" ' + P + '/>',
    shield: '<path d="M12 3.6l7 2.5v5.5c0 4.4-2.9 7.4-7 8.8-4.1-1.4-7-4.4-7-8.8V6.1l7-2.5Z" ' + P + '/><path d="M9.1 12l2.1 2.1 3.9-4" ' + P + '/>',
    moon: '<path d="M20 14.4A8.4 8.4 0 0 1 9.6 4a8.4 8.4 0 1 0 10.4 10.4Z" ' + P + '/>',
    users: '<circle cx="9.2" cy="8.6" r="3.2" ' + P + '/><path d="M3.2 19.6c0-3.2 2.7-5.4 6-5.4s6 2.2 6 5.4" ' + P + '/><path d="M15.8 5.6a3.2 3.2 0 0 1 0 6.2M17.4 14.4c2 .6 3.4 2.2 3.4 4.4" ' + P + '/>',
    broom: '<path d="M14.6 4.4l5 5M16.4 9.2 11 14.6" ' + P + '/><path d="M11 14.6l-4.2 4.2c-1.4 1.4-3.4 1.6-4 .6-.6-.6-.4-2.6 1-4L8 11.2l3 3.4Z" ' + P + '/><path d="M6.4 15.4 8 17" ' + P + '/>',
    zap: '<path d="M13.4 2.8 5.4 13.4h5.4l-1.2 7.8 8-10.6h-5.4l1.2-7.8Z" ' + P + '/>',
    /* --- 其他 --- */
    chevron: '<path d="M9.4 5.4 16 12l-6.6 6.6" ' + P + '/>',
    pin: '<path d="M12 21s6.4-6 6.4-11.2A6.4 6.4 0 0 0 5.6 9.8C5.6 15 12 21 12 21Z" ' + P + '/><circle cx="12" cy="9.8" r="2.4" ' + P + '/>',
    clock: '<circle cx="12" cy="12" r="8.2" ' + P + '/><path d="M12 7.4V12l3.2 1.9" ' + P + '/>',
    search: '<circle cx="10.8" cy="10.8" r="6.2" ' + P + '/><path d="M15.4 15.4L20 20" ' + P + '/>',
    ticket: '<path d="M4 8.4a1.6 1.6 0 0 1 1.6-1.6h12.8A1.6 1.6 0 0 1 20 8.4v1.4a2.2 2.2 0 0 0 0 4.4v1.4a1.6 1.6 0 0 1-1.6 1.6H5.6A1.6 1.6 0 0 1 4 15.6v-1.4a2.2 2.2 0 0 0 0-4.4V8.4Z" ' + P + '/><path d="M13.6 7v10" ' + P + ' stroke-dasharray="2 2.4"/>',
    image: '<rect x="3.4" y="5.2" width="17.2" height="13.6" rx="2" ' + P + '/><circle cx="8.8" cy="10" r="1.5" ' + P + '/><path d="M4.4 16.6l4.6-4 3.4 3 2.8-2.4 4.4 4" ' + P + '/>',
    inbox: '<path d="M3.8 13.4V6.4A1.8 1.8 0 0 1 5.6 4.6h12.8a1.8 1.8 0 0 1 1.8 1.8v7" ' + P + '/><path d="M3.8 13.4h4l1.2 2.2h6l1.2-2.2h4v4.2a2 2 0 0 1-2 2H7.8a2 2 0 0 1-2-2v-4.2Z" ' + P + '/>',
    shieldCheck: '<path d="M12 3.6l7 2.5v5.5c0 4.4-2.9 7.4-7 8.8-4.1-1.4-7-4.4-7-8.8V6.1l7-2.5Z" ' + P + '/>',
    /* 状态栏 */
    signal: '<rect x="2" y="13" width="3" height="6" rx="1" fill="currentColor"/><rect x="6.6" y="10" width="3" height="9" rx="1" fill="currentColor"/><rect x="11.2" y="7" width="3" height="12" rx="1" fill="currentColor"/><rect x="15.8" y="4" width="3" height="15" rx="1" fill="currentColor"/>',
    wifi: '<path d="M2.6 8.4a13.4 13.4 0 0 1 18.8 0M6 11.8a8.6 8.6 0 0 1 12 0M9.4 15.2a3.8 3.8 0 0 1 5.2 0" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round"/><circle cx="12" cy="18.4" r="1.2" fill="currentColor"/>',
    battery: '<rect x="2.4" y="7.4" width="17.4" height="9.2" rx="2.4" stroke="currentColor" stroke-width="1.5" fill="none" opacity=".5"/><rect x="4.2" y="9.2" width="13" height="5.6" rx="1.2" fill="currentColor"/><path d="M21.4 10.6v2.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" opacity=".5"/>'
  };

  function icon(name, size) {
    const s = size || 18;
    return '<svg viewBox="0 0 24 24" width="' + s + '" height="' + s +
           '" aria-hidden="true">' + (ICONS[name] || '') + '</svg>';
  }

  /* ---------------- toast ---------------- */
  function toastHost() {
    let w = document.querySelector('.toast-wrap');
    if (!w) {
      w = document.createElement('div');
      w.className = 'toast-wrap';
      // 挂在手机画布内，否则会跑到整个浏览器窗口的底部
      (document.getElementById('device') || document.body).appendChild(w);
    }
    return w;
  }

  function toast(msg, type) {
    const el = document.createElement('div');
    el.className = 'toast' + (type ? ' toast--' + type : '');
    const ic = type === 'ok' ? icon('check', 14) : type === 'err' ? icon('alert', 14) : '';
    el.innerHTML = ic + '<span>' + escapeHtml(msg) + '</span>';
    toastHost().appendChild(el);
    setTimeout(function () {
      el.classList.add('out');
      setTimeout(function () { el.remove(); }, 280);
    }, 2400);
  }

  /* ---------------- 底部弹层 ---------------- */
  function sheet(o) {
    o = o || {};
    const host = document.getElementById('device') || document.body;

    const mask = document.createElement('div');
    mask.className = 'mask';
    mask.innerHTML =
      '<div class="sheet" role="dialog" aria-modal="true">' +
        (o.title ? '<div class="h3" style="margin-bottom:4px">' + escapeHtml(o.title) + '</div>' : '') +
        (o.sub ? '<div class="muted" style="margin-bottom:12px">' + escapeHtml(o.sub) + '</div>' : '') +
        '<div class="sheet-bd">' + (o.body || '') + '</div>' +
      '</div>';

    host.appendChild(mask);

    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      mask.classList.add('is-out');
      mask.firstChild.classList.add('is-out');
      setTimeout(function () { mask.remove(); }, 240);
      document.removeEventListener('keydown', onKey);
      o.onClose && o.onClose();
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);

    mask.addEventListener('click', function (e) {
      if (e.target === mask || e.target.closest('[data-close]')) close();
    });

    const api = { el: mask, close: close };
    o.onMount && o.onMount(api);
    return api;
  }

  /* ---------------- 工具 ---------------- */
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** 相对时间：刚刚 / 26 分钟前 / 3 小时前 / 2 天前 */
  function fromNow(ms) {
    const diff = Date.now() - ms;
    if (diff < 60e3) return '刚刚';
    if (diff < 3600e3) return Math.floor(diff / 60e3) + ' 分钟前';
    if (diff < 86400e3) return Math.floor(diff / 3600e3) + ' 小时前';
    return Math.floor(diff / 86400e3) + ' 天前';
  }

  /** 日期文本：11 月 24 日 */
  function dateText(d) {
    return (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日';
  }

  global.UI = { icon: icon, ICONS: ICONS, toast: toast, sheet: sheet, escapeHtml: escapeHtml, fromNow: fromNow, dateText: dateText };
})(window);
