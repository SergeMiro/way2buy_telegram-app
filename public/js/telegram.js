/* ============================================================================
   telegram.js — the host bridge.

   One job: tell the app WHO the user is and WHERE it runs, with the same shape
   whether we are inside the Telegram client or in a plain browser (demo).

   Identity:
     • inside Telegram → initDataUnsafe.user.id (in production the server will
       re-derive this from a validated initData HMAC; the client shape is
       already correct, so nothing here changes when that lands).
     • plain browser   → ?tgid=… , else the last picked demo profile
       (localStorage), else the first seeded customer.

   Exposes: window.W2B.tg
============================================================================ */
(function () {
  'use strict';

  var wa = (window.Telegram && window.Telegram.WebApp) || null;
  // A real client always carries initData; the injected SDK alone is not proof.
  var inTelegram = Boolean(wa && wa.initData && wa.initData.length > 0);

  var LS_KEY = 'w2b:demo-tgid';
  var params = new URLSearchParams(window.location.search);

  function readDemoId() {
    var fromUrl = params.get('tgid');
    if (fromUrl) return fromUrl;
    try {
      var saved = window.localStorage.getItem(LS_KEY);
      if (saved) return saved;
    } catch (e) { /* private mode — fall through to the default */ }
    return '100000001'; // first seeded customer
  }

  var userId = inTelegram ? String(wa.initDataUnsafe.user.id) : readDemoId();

  var tg = {
    inTelegram: inTelegram,
    // Demo mode also unlocks the admin tab; in production ADMIN_TG_IDS decides
    // and the server is the authority either way (requireAdmin).
    isDemo: !inTelegram,
    userId: userId,

    name: inTelegram
      ? [wa.initDataUnsafe.user.first_name, wa.initDataUnsafe.user.last_name].filter(Boolean).join(' ')
      : null,
    username: inTelegram ? wa.initDataUnsafe.user.username || null : null,

    setUserId: function (id) {
      tg.userId = String(id);
      try { window.localStorage.setItem(LS_KEY, tg.userId); } catch (e) { /* ignore */ }
    },

    ready: function () {
      if (!wa) return;
      wa.ready();
      wa.expand();
      if (wa.setHeaderColor) {
        try { wa.setHeaderColor('#14122b'); } catch (e) { /* older clients */ }
      }
      if (wa.enableClosingConfirmation) wa.enableClosingConfirmation();
    },

    haptic: function (style) {
      if (!wa || !wa.HapticFeedback) return;
      try {
        if (style === 'success' || style === 'error' || style === 'warning') {
          wa.HapticFeedback.notificationOccurred(style);
        } else {
          wa.HapticFeedback.impactOccurred(style || 'light');
        }
      } catch (e) { /* haptics are best-effort */ }
    },

    // Clipboard with a graceful fallback: the async API is unavailable on
    // http:// origins and in some in-app webviews.
    copy: function (text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text);
      }
      return new Promise(function (resolve, reject) {
        try {
          var el = document.createElement('textarea');
          el.value = text;
          el.setAttribute('readonly', '');
          el.style.position = 'fixed';
          el.style.opacity = '0';
          document.body.appendChild(el);
          el.select();
          var ok = document.execCommand('copy');
          document.body.removeChild(el);
          ok ? resolve() : reject(new Error('copy failed'));
        } catch (e) { reject(e); }
      });
    },
  };

  window.W2B = window.W2B || {};
  window.W2B.tg = tg;
})();
