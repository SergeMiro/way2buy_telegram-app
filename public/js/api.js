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
    purchases: function () { return request('GET', '/api/purchases'); },
    discounts: function () { return request('GET', '/api/discounts'); },
    notifications: function () { return request('GET', '/api/notifications'); },
    demoProfiles: function () { return request('GET', '/api/demo/profiles'); },

    // ── customer actions ──
    register: function (form) { return request('POST', '/api/register', form); },
    interest: function (postId, type) { return request('POST', '/api/interest', { postId: postId, type: type || 'want' }); },
    redeem: function (amount) { return request('POST', '/api/redeem', amount ? { amount: amount } : {}); },
    markRead: function () { return request('POST', '/api/notifications/read', {}); },

    // ── admin ──
    admin: {
      customers: function () { return request('GET', '/api/admin/customers'); },
      addPurchase: function (form) { return request('POST', '/api/admin/purchase', form); },
      publishPost: function (form) { return request('POST', '/api/admin/post', form); },
      grantPromo: function (form) { return request('POST', '/api/admin/promo', form); },
      campaigns: function (status) { return request('GET', '/api/admin/campaigns', undefined, status ? { status: status } : {}); },
      createCampaign: function (form) { return request('POST', '/api/admin/campaigns', form); },
      materialize: function (id) { return request('POST', '/api/admin/campaigns/' + id + '/materialize', {}); },
      holidays: function () { return request('GET', '/api/admin/holidays'); },
      report: function (period) { return request('GET', '/api/admin/report', undefined, { period: period || 'day' }); },
      sendReport: function (period) { return request('POST', '/api/admin/report/send', { period: period || 'day' }); },
    },
  };
})();
