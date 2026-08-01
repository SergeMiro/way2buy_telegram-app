/* ============================================================================
   api.js — the JSON client.

   Every request carries the caller's identity the way the server expects it:
   `tgid` as a query param on GET, in the body on POST. Admin routes additionally
   need `admin=1` while the app runs in open-demo mode (no ADMIN_TG_IDS set) —
   the server still decides, this only asks.

   Exposes: window.W2B.api
============================================================================ */
(function () {
  'use strict';

  var tg = window.W2B.tg;

  function qs(extra) {
    var p = new URLSearchParams(extra || {});
    p.set('tgid', tg.userId);
    if (tg.isDemo) p.set('admin', '1');
    return p.toString();
  }

  async function request(method, path, body, query) {
    var url = path + (path.indexOf('?') === -1 ? '?' : '&') + qs(query);
    var init = { method: method, headers: {} };
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      var payload = Object.assign({ tgid: tg.userId }, body);
      if (tg.isDemo) payload.admin = '1';
      init.body = JSON.stringify(payload);
    }

    var res;
    try {
      res = await fetch(url, init);
    } catch (e) {
      // Network/offline: surface a message the UI can show verbatim.
      throw new Error('Немає зʼєднання з сервером');
    }

    var text = await res.text();
    var data = null;
    if (text) {
      try { data = JSON.parse(text); } catch (e) { data = null; }
    }
    if (!res.ok) {
      var msg = (data && (data.error || data.message)) || ('Помилка ' + res.status);
      var err = new Error(msg);
      err.status = res.status;
      err.data = data; // a business refusal (409) still carries a usable payload
      throw err;
    }
    return data;
  }

  window.W2B.api = {
    get: function (path, query) { return request('GET', path, undefined, query); },
    post: function (path, body) { return request('POST', path, body || {}); },
    patch: function (path, body) { return request('PATCH', path, body || {}); },

    // ── read models ──
    config: function () { return request('GET', '/api/config'); },
    me: function () { return request('GET', '/api/me'); },
    feed: function (channel) { return request('GET', '/api/feed', undefined, channel && channel !== 'all' ? { channel: channel } : {}); },
    // kind='catalog' → all ~15 catalogues at once; kind='main' → the channel feed.
    feedKind: function (kind) { return request('GET', '/api/feed', undefined, { kind: kind }); },
    purchases: function () { return request('GET', '/api/purchases'); },
    discounts: function () { return request('GET', '/api/discounts'); },
    notifications: function () { return request('GET', '/api/notifications'); },
    demoProfiles: function () { return request('GET', '/api/demo/profiles'); },
    birthday: function () { return request('GET', '/api/birthday'); },

    // ── customer actions ──
    register: function (form) { return request('POST', '/api/register', form); },
    // The birthday claim: sending the date is only needed the first time — after
    // that the server verifies against the date it already has on file.
    claimBirthday: function (date) {
      return request('POST', '/api/birthday/claim', date ? { birthday: date } : {})
        .catch(function (e) {
          // "Не той день", "вже отримано", "поза періодом" are answers, not
          // failures — the server returns 409 with the reason and the caller
          // shows it as-is.
          if (e.status === 409 && e.data && e.data.verdict) return e.data;
          throw e;
        });
    },
    interest: function (postId, type) { return request('POST', '/api/interest', { postId: postId, type: type || 'want' }); },
    redeem: function (amount) { return request('POST', '/api/redeem', amount ? { amount: amount } : {}); },
    markRead: function () { return request('POST', '/api/notifications/read', {}); },

    // ── примірочна ──
    cart: {
      get: function () { return request('GET', '/api/cart'); },
      add: function (postId) { return request('POST', '/api/cart/add', { postId: postId }); },
      remove: function (itemId) { return request('POST', '/api/cart/remove', { itemId: itemId }); },
      // The inquiry to Dasha: the text is optional, the items are already known.
      send: function (message) { return request('POST', '/api/cart/send', { message: message || '' }); },
    },

    // ── admin ──
    admin: {
      customers: function () { return request('GET', '/api/admin/customers'); },
      addPurchase: function (form) { return request('POST', '/api/admin/purchase', form); },
      publishPost: function (form) { return request('POST', '/api/admin/post', form); },
      grantPromo: function (form) { return request('POST', '/api/admin/promo', form); },
      campaigns: function (status) { return request('GET', '/api/admin/campaigns', undefined, status ? { status: status } : {}); },
      createCampaign: function (form) { return request('POST', '/api/admin/campaigns', form); },
      materialize: function (id) { return request('POST', '/api/admin/campaigns/' + id + '/materialize', {}); },
      report: function (period) { return request('GET', '/api/admin/report', undefined, { period: period || 'day' }); },
      sendReport: function (period) { return request('POST', '/api/admin/report/send', { period: period || 'day' }); },

      // ── bonus rules: the $ ⇄ % switch Maryna edits herself ──
      rules: function () { return request('GET', '/api/admin/rules'); },
      updateRule: function (key, patch) { return request('PATCH', '/api/admin/rules/' + encodeURIComponent(key), patch); },

      // ── holidays: same shape, so New Year / Christmas / Easter are $ or % too ──
      holidays: function () { return request('GET', '/api/admin/holidays'); },
      updateHoliday: function (id, patch) { return request('PATCH', '/api/admin/holidays/' + id, patch); },
      createHoliday: function (form) { return request('POST', '/api/admin/holidays', form); },

      // ── profit: what the client paid vs what the bag cost ──
      profit: function (query) { return request('GET', '/api/admin/profit', undefined, query || {}); },
      pendingCosts: function () { return request('GET', '/api/admin/pending-costs'); },
      setCost: function (purchaseId, form) { return request('POST', '/api/admin/purchases/' + purchaseId + '/cost', form); },

      // ── Dasha's queue + what clients actually want ──
      inquiries: function (status) { return request('GET', '/api/admin/inquiries', undefined, status ? { status: status } : {}); },
      setInquiryStatus: function (id, status) { return request('PATCH', '/api/admin/inquiries/' + id, { status: status }); },
      // period: 'month' | 'year' | 'all', or { from, to }
      popular: function (query) { return request('GET', '/api/admin/popular', undefined, query || {}); },

      // ── birthday audit trail ──
      birthdayClaims: function (verdict) { return request('GET', '/api/admin/birthday-claims', undefined, verdict ? { verdict: verdict } : {}); },
      setBirthday: function (customerId, date) { return request('POST', '/api/admin/customers/' + customerId + '/birthday', { birthday: date }); },

      // ── channels + the scheduler tick ──
      channels: function () { return request('GET', '/api/admin/channels'); },
      updateChannel: function (key, patch) { return request('PATCH', '/api/admin/channels/' + encodeURIComponent(key), patch); },
      tick: function () { return request('POST', '/api/admin/tick', {}); },
    },
  };
})();
