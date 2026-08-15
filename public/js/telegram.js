/* ============================================================================
   telegram.js — the host bridge.

   One job: tell the app WHO the user is and WHERE it runs, with the same shape
   whether we are inside the Telegram client or in a plain browser (demo).

   Identity:
     • inside Telegram → initDataUnsafe.user.id for what to DISPLAY, and the
       raw signed `initData` string for what to PROVE. The server re-derives
       the id from the HMAC on that string and trusts nothing else — see
       server/auth.js — so `initData` is the credential and `userId` is only
       a label. Never treat *Unsafe as authority; the name says so.
     • plain browser   → ?tgid=… , else the last picked demo profile
       (localStorage), else NOBODY. There is no invented id: on a production
       deployment an unsigned claim is refused, so a made-up one would turn a
       browser visit into a page of errors. app.js picks a seeded profile only
       once the server has confirmed it is running as a demo.

   Exposes: window.W2B.tg
============================================================================ */
(function () {
  'use strict';

  var wa = (window.Telegram && window.Telegram.WebApp) || null;
  // A real client always carries initData; the injected SDK alone is not proof.
  var inTelegram = Boolean(wa && wa.initData && wa.initData.length > 0);

  var LS_KEY = 'w2b:demo-tgid';
  var params = new URLSearchParams(window.location.search);

  // Outside Telegram: only an identity somebody actually asked for. There is no
  // hardcoded fallback any more, because with signed launches required in
  // production a made-up id is not a demo, it is a request that gets refused —
  // and a shop that answers 401 to a plain browser looks broken rather than
  // closed. The demo's own profile is chosen by app.js once the server has said
  // it IS a demo.
  function readDemoId() {
    var fromUrl = params.get('tgid');
    if (fromUrl) return fromUrl;
    try {
      var saved = window.localStorage.getItem(LS_KEY);
      if (saved) return saved;
    } catch (e) { /* private mode — no saved profile */ }
    return '';
  }

  var userId = inTelegram ? String(wa.initDataUnsafe.user.id) : readDemoId();

  // In Fullscreen launch mode the Mini App owns the whole screen — including
  // the strip under the clock and the camera notch. Telegram reports how much
  // room that takes; without honouring it the wordmark sits under the status
  // bar. Compact/Fullsize report zeros, so the same code is correct in all
  // three modes.
  function applyInsets() {
    if (!wa) return;
    var safe = wa.safeAreaInset || {};
    var content = wa.contentSafeAreaInset || {};
    var top = (Number(safe.top) || 0) + (Number(content.top) || 0);
    var bottom = Math.max(Number(safe.bottom) || 0, Number(content.bottom) || 0);
    var root = document.documentElement;
    root.style.setProperty('--w2b-safe-top', top + 'px');
    if (bottom) root.style.setProperty('--w2b-safe-bottom', bottom + 'px');
    root.classList.toggle('is-fullscreen', Boolean(wa.isFullscreen));
  }

  var tg = {
    inTelegram: inTelegram,
    // Demo mode also unlocks the admin tab; in production ADMIN_TG_IDS decides
    // and the server is the authority either way (requireAdmin).
    isDemo: !inTelegram,
    userId: userId,
    // The signed launch payload, verbatim. api.js sends it on every request and
    // the server checks its HMAC. Empty outside Telegram — which is exactly why
    // a plain browser cannot reach the cabinet in production.
    initData: inTelegram ? wa.initData : '',

    name: inTelegram
      ? [wa.initDataUnsafe.user.first_name, wa.initDataUnsafe.user.last_name].filter(Boolean).join(' ')
      : null,
    username: inTelegram ? wa.initDataUnsafe.user.username || null : null,
    languageCode: inTelegram ? wa.initDataUnsafe.user.language_code || null : null,

    setUserId: function (id) {
      tg.userId = String(id);
      try { window.localStorage.setItem(LS_KEY, tg.userId); } catch (e) { /* ignore */ }
    },

    ready: function () {
      if (!wa) return;
      wa.ready();
      wa.expand();
      // The header must match the paper canvas, not the old dark theme.
      if (wa.setHeaderColor) {
        try { wa.setHeaderColor('#f6f4f1'); } catch (e) { /* older clients */ }
      }
      if (wa.setBackgroundColor) {
        try { wa.setBackgroundColor('#f6f4f1'); } catch (e) { /* older clients */ }
      }
      if (wa.enableClosingConfirmation) wa.enableClosingConfirmation();
      applyInsets();
      // Fullscreen mode, rotation and the keyboard all move the safe area, and
      // Telegram reports each as its own event.
      ['safeAreaChanged', 'contentSafeAreaChanged', 'fullscreenChanged', 'viewportChanged']
        .forEach(function (evt) {
          try { wa.onEvent(evt, applyInsets); } catch (e) { /* older clients */ }
        });
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
