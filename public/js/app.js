/* ============================================================================
   app.js — the Mini App shell: router, views, and the small amount of state
   they share. Vanilla, zero-build (ADR-001), classic script (loaded after
   telegram.js + api.js, which publish window.W2B.*).

   Views: Клуб (loyalty + discount cards) · Стрічка (both channels) ·
          Покупки (history + promo codes) · Кабінет (admin).
============================================================================ */
(function () {
  'use strict';

  var tg = window.W2B.tg;
  var api = window.W2B.api;

  var $app = document.getElementById('app');
  var $nav = document.getElementById('nav');
  var $sheet = document.getElementById('sheet');
  var $sheetPanel = document.getElementById('sheetPanel');
  var $toast = document.getElementById('toast');
  var $demobar = document.getElementById('demobar');
  var $demoUser = document.getElementById('demoUser');

  var state = {
    config: null,
    me: null,
    tab: 'catalog',
    feedChannel: 'all',
    discounts: { promos: [], publicCampaigns: [] },
    purchases: { purchases: [], promos: [], loyalty: null },
    feed: [],
    notifications: { notifications: [], unread: 0 },
    birthday: null,
    cart: { items: [], count: 0, promo: null, draft: '' },
    cartCount: 0,
    catalogs: [],
    catalogTotal: 0,
    inStockKey: 'available',
    search: '',
    // The vitrine's selection and what the server says can be filtered inside
    // it. Nothing here is a hardcoded list: a new catalogue full of a brand
    // nobody has posted before grows its own chip.
    filters: { brand: null, category: null },
    facets: { total: 0, brands: [], categories: [] },
    nextCursor: null,
    loadingMore: false,
    admin: {
      customers: [], campaigns: [], report: null, reportPeriod: 'day',
      rules: [], holidays: [], profit: null, pendingCosts: [], claims: [],
      inquiries: [], popular: null, popularPeriod: 'month', posts: [],
      channels: [],
      // Per-channel sync progress, keyed by channel: { running, note, error }.
      // A deep backfill is many calls, so the admin needs to see it moving.
      sync: {},
      adminTab: 'bonuses',
    },
  };

  // Every discount in the system is either a dollar amount or a percentage —
  // that is the one toggle Maryna asked for, so the UI never assumes '%'.
  function discountLabel(mode, value) {
    var v = Number(value || 0);
    if (mode === 'percent') return (Number.isInteger(v) ? v : v.toFixed(1)) + '%';
    return usd(v);
  }

  // Who the client is writing to. A name in the interface is a setting, not a
  // string literal: during the test everything routes to Serhiy, in production
  // to Dasha. Ukrainian needs the dative ("написати Даші / Сергію").
  function support() {
    return (state.config && state.config.support) || { name: 'Менеджер', dative: 'менеджеру', username: '' };
  }

  function minOrderNote(minOrderUsd) {
    return Number(minOrderUsd) > 0 ? ' від замовлення ' + usd(minOrderUsd) : '';
  }

  /* ── tiny helpers ───────────────────────────────────────────────────────── */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function usd(n) {
    var v = Math.round(Number(n || 0) * 100) / 100;
    return '$' + (Number.isInteger(v) ? v.toLocaleString('uk-UA') : v.toFixed(2));
  }

  function money(amount, currency) {
    if (amount == null) return '';
    var n = Number(amount).toLocaleString('uk-UA');
    if (currency === 'USD') return '$' + n;
    if (currency === 'EUR') return '€' + n;
    return n + ' ₴';
  }

  function dateShort(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleDateString('uk-UA', { day: 'numeric', month: 'short' });
  }

  function timeAgo(iso) {
    if (!iso) return '';
    var diff = Date.now() - new Date(iso).getTime();
    if (isNaN(diff)) return '';
    var min = Math.floor(diff / 60000);
    if (min < 1) return 'щойно';
    if (min < 60) return min + ' хв';
    var h = Math.floor(min / 60);
    if (h < 24) return h + ' год';
    var d = Math.floor(h / 24);
    if (d < 7) return d + ' дн';
    return dateShort(iso);
  }

  // "2 дні 4 год" — the human string the countdown ticker writes into cards.
  function untilText(iso) {
    var ms = new Date(iso).getTime() - Date.now();
    if (isNaN(ms)) return '';
    if (ms <= 0) return 'Термін вичерпано';
    var totalMin = Math.floor(ms / 60000);
    var d = Math.floor(totalMin / 1440);
    var h = Math.floor((totalMin % 1440) / 60);
    var m = totalMin % 60;
    if (d > 0) return d + ' ' + plural(d, ['день', 'дні', 'днів']) + (h ? ' ' + h + ' год' : '');
    if (h > 0) return h + ' год' + (m ? ' ' + m + ' хв' : '');
    return m + ' хв';
  }

  function plural(n, forms) {
    var a = Math.abs(n) % 100;
    var b = a % 10;
    if (a > 10 && a < 20) return forms[2];
    if (b > 1 && b < 5) return forms[1];
    if (b === 1) return forms[0];
    return forms[2];
  }

  function toast(msg, kind) {
    $toast.textContent = msg;
    $toast.className = 'toast' + (kind ? ' toast--' + kind : '');
    $toast.hidden = false;
    tg.haptic(kind === 'error' ? 'error' : 'success');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { $toast.hidden = true; }, 2600);
  }

  function openSheet(title, html) {
    $sheetPanel.innerHTML = '<div class="sheet__title">' + esc(title) + '</div>' + html;
    $sheet.hidden = false;
  }

  function closeSheet() {
    $sheet.hidden = true;
    $sheetPanel.innerHTML = '';
  }

  $sheet.addEventListener('click', function (e) {
    if (e.target.hasAttribute('data-close')) closeSheet();
  });

  /* ── discount card ──────────────────────────────────────────────────────── */

  var VARIANT_LABEL = {
    birthday: 'День народження',
    holiday: 'Свято',
    vip: 'VIP-клуб',
    generic: 'Знижка',
  };

  function cardHtml(d) {
    var variant = VARIANT_LABEL[d.variant] ? d.variant : 'generic';
    var expired = d.expiresAt && new Date(d.expiresAt).getTime() <= Date.now();
    var confetti = '';
    if (variant === 'birthday') {
      // Exactly 12 pieces, rendered up front; fired once via .is-revealed.
      confetti = '<div class="confetti" aria-hidden="true">' +
        new Array(12).fill('<span class="confetti__bit"></span>').join('') + '</div>';
    }

    var code = '';
    if (d.code) {
      code = '<div class="card__code">' +
        '<code class="card__code-value">' + esc(d.code) + '</code>' +
        (expired ? '' : '<button class="card__copy" type="button" data-copy="' + esc(d.code) + '">Копіювати</button>') +
        '</div>';
    }

    var foot = '';
    if (d.expiresAt) {
      foot = '<footer class="card__foot"><span class="card__countdown" data-expires-at="' +
        esc(d.expiresAt) + '">' + esc(untilText(d.expiresAt)) + '</span></footer>';
    }

    return '<article class="card card--' + variant + (expired ? ' card--expired' : '') +
        '" data-variant="' + variant + '">' +
      '<span class="card__glow" aria-hidden="true"></span>' +
      '<span class="card__shimmer" aria-hidden="true"></span>' +
      '<span class="card__rim" aria-hidden="true"></span>' +
      confetti +
      '<header class="card__head">' +
        '<span class="card__emoji" aria-hidden="true">' + esc(d.emoji || '🏷️') + '</span>' +
        '<span class="card__label">' + esc(VARIANT_LABEL[variant]) + '</span>' +
      '</header>' +
      // A card shows either "50" + "$" or "20" + "%" — the server tells us which.
      '<div class="card__percent">' +
        '<span class="card__percent-num">' + esc(d.mode === 'percent' ? d.value : usd(d.value).replace('$', '')) + '</span>' +
        '<span class="card__percent-sign">' + (d.mode === 'percent' ? '%' : '$') + '</span>' +
      '</div>' +
      '<p class="card__title">' + esc(d.title || d.campaignName || 'Знижка') + '</p>' +
      '<p class="card__desc">' + esc(
        (d.minOrderUsd ? 'Діє від замовлення ' + usd(d.minOrderUsd) + '. ' : '') +
        (d.code ? 'Персональний промокод' : 'Діє для всіх учасників клубу')
      ) + '</p>' +
      code + foot +
    '</article>';
  }

  // One shared 1 Hz ticker for every visible countdown (not one timer per card).
  setInterval(function () {
    var nodes = $app.querySelectorAll('.card__countdown[data-expires-at]');
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var iso = n.getAttribute('data-expires-at');
      n.textContent = untilText(iso);
      var left = new Date(iso).getTime() - Date.now();
      n.classList.toggle('card__countdown--urgent', left > 0 && left < 86400000);
    }
  }, 1000);

  /* ── loyalty widgets ────────────────────────────────────────────────────── */

  // The ring fills with the bonus balance against its ceiling ($300), which is
  // the only progress the client has now that tiers are hidden.
  function ringHtml(l) {
    var pct = l.progressPct || 0;
    var caption = l.capUsd ? 'з ' + usd(l.capUsd) : 'бонуси';
    return '<div class="loyalty-ring" style="--w2b-ring-pct: ' + pct + '%">' +
      '<div class="loyalty-ring__hole">' +
        '<span class="loyalty-ring__value">' + pct + '%</span>' +
        '<span class="loyalty-ring__caption">' + esc(caption) + '</span>' +
      '</div>' +
    '</div>';
  }

  function tierBadge(l) {
    return '<span class="badge badge--' + esc(l.tier) + '">' + esc(l.tierName) + '</span>';
  }

  function badgesHtml(l) {
    return '<div class="badge-strip">' + (l.badges || []).map(function (b) {
      return '<span class="badge-chip' + (b.earned ? '' : ' badge-chip--locked') + '">' +
        esc(b.emoji) + ' ' + esc(b.name) + '</span>';
    }).join('') + '</div>';
  }

  /* ── views ──────────────────────────────────────────────────────────────── */

  function topbarHtml() {
    var c = state.me && state.me.customer;
    var initials = c ? c.name.split(/\s+/).slice(0, 2).map(function (w) { return w[0]; }).join('') : '👤';
    var tiersOn = state.config && state.config.features && state.config.features.tiers;
    var sub = c && c.loyalty
      ? (tiersOn ? c.loyalty.tierName + ' · ' : '') + usd(c.loyalty.totalSpent) + ' покупок'
      : 'Гість';
    var unread = state.notifications.unread;
    // The flag beside the wordmark is painted, not an emoji: a coloured OS
    // glyph would break the monochrome storefront. Each sweep is a tapered
    // body — thin at the start, loaded in the middle, frayed where the brush
    // lifts — plus two bristle trails running past the end. That raggedness is
    // what makes paint read as paint rather than as two tidy bars.
    return '<div class="wordmark">' +
        '<div class="wordmark__row">' +
          '<span class="wordmark__name">Way2Buy</span>' +
          '<svg class="brush" viewBox="0 0 40 26" role="img" aria-label="Україна">' +
            '<defs>' +
              // Watercolour is edge behaviour, not colour: turbulence pushes the
              // outline around so it wanders like a wet edge, a slight blur
              // softens it, and the paint stays translucent so the paper shows
              // through and the two washes bleed where they meet.
              '<filter id="w2b-wc" x="-20%" y="-25%" width="140%" height="150%">' +
                '<feTurbulence type="fractalNoise" baseFrequency="0.055" numOctaves="4" seed="9" result="n"/>' +
                '<feDisplacementMap in="SourceGraphic" in2="n" scale="3.4" xChannelSelector="R" yChannelSelector="G"/>' +
                '<feGaussianBlur stdDeviation="0.32"/>' +
              '</filter>' +
            '</defs>' +
            '<g filter="url(#w2b-wc)">' +
              '<path class="wash wash--blue" d="M2.6 7.4c4-1.9 8.2-2.9 12.6-2.9 3.5 0 6.9.5 10.3.7 3.9.2 7.7-.4 11.3-1.9l1.5 5.6c-3.9 1.6-8 2.3-12.2 2.1-3.5-.2-6.9-.7-10.4-.7-4.2 0-8.2.8-12.1 2.4z"/>' +
              '<path class="wash wash--yellow" d="M2.9 14.3c4-1.9 8.2-2.9 12.6-2.9 3.5 0 6.9.5 10.3.7 3.9.2 7.7-.4 11.3-1.9l1.4 5.6c-3.9 1.6-8 2.3-12.2 2.1-3.5-.2-6.9-.7-10.4-.7-4.2 0-8.2.8-12.1 2.4z"/>' +
            '</g>' +
          '</svg>' +
        '</div>' +
        '<div class="wordmark__sub">ваша річ уже існує</div>' +
      '</div>' +
      '<header class="topbar">' +
      '<div class="topbar__avatar">' + esc(initials) + '</div>' +
      '<div class="topbar__meta">' +
        '<div class="topbar__name">' + esc(c ? c.name : 'Вітаємо у Way2Buy') + '</div>' +
        '<div class="topbar__sub">' + esc(sub) + '</div>' +
      '</div>' +
      '<div class="topbar__aside">' +
        (c && c.loyalty && tiersOn ? tierBadge(c.loyalty) : '') +
        '<button class="bell" type="button" data-action="notifications" aria-label="Повідомлення">' +
          '<svg viewBox="0 0 24 24" aria-hidden="true">' +
            '<path d="M18 16V11a6 6 0 1 0-12 0v5l-1.5 2.5h15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/></svg>' +
          '<span class="notif-badge" data-count="' + unread + '"' + (unread ? '' : ' hidden') + '>' + unread + '</span>' +
        '</button>' +
      '</div>' +
    '</header>';
  }

  // The birthday block: one button. Either we already know the date (then the
  // claim is a single tap and the server cross-checks it), or we ask for it once
  // and record it. This is the whole "система записи ДР" from the client side.
  function birthdayBlockHtml() {
    var b = state.birthday || (state.me && state.me.birthday);
    if (!b || !b.enabled) return '';
    var label = discountLabel(b.mode, b.value) + minOrderNote(b.minOrderUsd);

    if (b.state === 'claimed') {
      return '<section class="panel">' +
        '<div class="panel__title">🎂 Знижка на день народження</div>' +
        '<p class="panel__note">Вже отримана цього року. Промокод — у вкладці «Покупки».</p>' +
      '</section>';
    }

    if (b.state === 'unknown_date') {
      return '<section class="panel">' +
        '<div class="panel__title">🎂 Знижка ' + esc(label) + ' на день народження</div>' +
        '<p class="panel__note">Вкажіть дату народження — ми запишемо її один раз, ' +
          'і надалі знижка буде приходити сама. Діє ' + (b.validDays || 30) + ' днів.</p>' +
        '<form class="stack" id="birthdayForm" style="margin-top:var(--w2b-space-3)">' +
          '<label class="field"><span class="field__label">Дата народження</span>' +
            '<input class="field__input" name="birthday" type="date" required /></label>' +
          '<button class="btn btn--primary" type="submit">Отримати знижку</button>' +
        '</form>' +
      '</section>';
    }

    var win = b.window || {};
    if (b.state === 'available') {
      return '<section class="panel">' +
        '<div class="panel__title">🎂 Знижка ' + esc(label) + ' чекає на вас</div>' +
        '<p class="panel__note">Діє до ' + esc(dateShort(win.endsAt)) + '.</p>' +
        '<div class="inline" style="margin-top:var(--w2b-space-3)">' +
          '<button class="btn btn--primary" data-action="claim-birthday">Отримати знижку</button>' +
        '</div>' +
      '</section>';
    }

    // upcoming
    return '<section class="panel">' +
      '<div class="panel__title">🎂 Знижка ' + esc(label) + ' на день народження</div>' +
      '<p class="panel__note">Стане доступною ' + esc(dateShort(win.startsAt)) +
        ' і діятиме ' + (b.validDays || 30) + ' днів.</p>' +
    '</section>';
  }

  function holidayCardsHtml() {
    var list = (state.discounts && state.discounts.holidays) || [];
    return list.map(function (h) {
      return cardHtml({
        variant: 'holiday',
        mode: h.mode,
        value: h.value,
        minOrderUsd: h.minOrderUsd,
        emoji: h.emoji,
        title: h.name,
        expiresAt: h.endsAt,
      });
    }).join('');
  }

  function renderHome() {
    if (!state.me.registered) return renderJoin();

    var l = state.me.customer.loyalty;
    var f = state.config.features || {};
    var cards = state.discounts.promos.concat(state.discounts.publicCampaigns);

    var html = topbarHtml() + '<div class="stack">';

    // wallet — cashback is now per single order, so the hint talks about the
    // order size, not a lifetime total.
    var ruleText = 'Правило: покупка від ' + usd(l.minOrderUsd) + ' → ' +
      discountLabel(l.mode, l.value) + ' бонусу' +
      (l.capUsd ? ', накопичення максимум ' + usd(l.capUsd) : '');
    html += '<section class="wallet">' + ringHtml(l) +
      '<div class="wallet__body">' +
        '<div class="wallet__amount">' + usd(l.cashbackAvailable) + '</div>' +
        '<div class="wallet__caption">бонусів доступно до списання</div>' +
        '<div class="wallet__hint">' + esc(ruleText) +
          (l.capReached ? ' · ліміт досягнуто — використайте бонуси, щоб нараховувати далі' : '') + '</div>' +
        (l.cashbackAvailable > 0
          ? '<div class="wallet__actions"><button class="btn btn--primary" data-action="redeem">Списати ' + usd(l.cashbackAvailable) + '</button></div>'
          : '') +
      '</div>' +
    '</section>';

    // stats
    html += '<section class="stats">' +
      '<div class="stat"><div class="stat__value">' + usd(l.totalSpent) + '</div><div class="stat__label">разом</div></div>' +
      '<div class="stat"><div class="stat__value">' + l.purchases + '</div><div class="stat__label">покупок</div></div>' +
      '<div class="stat"><div class="stat__value">' + usd(l.cashbackEarned) + '</div><div class="stat__label">нараховано</div></div>' +
    '</section>';

    // the two bonuses Maryna actually gives
    html += birthdayBlockHtml();

    // discount cards
    var holidayCards = holidayCardsHtml();
    html += '<div class="section-title">Ваші знижки</div>';
    html += (cards.length || holidayCards)
      ? cards.map(cardHtml).join('') + holidayCards
      : '<div class="empty">Поки що немає активних знижок. Вони зʼявляються на день народження та у свята.</div>';

    html += historySectionsHtml();

    // Tiers/badges/streaks exist in the data but stay off screen unless the
    // server turns them on: Maryna's audience needs two bonuses, nothing else.
    if (f.badges || f.tiers) {
      html += '<div class="section-title">Прогрес</div>' + badgesHtml(l);
      html += '<div class="panel"><div class="panel__note">' + esc(l.tierPerk || '') +
        (l.nextTier ? ' · до ' + esc(l.nextTier.name) + ' — ' + usd(l.nextTier.toGo) : '') + '</div></div>';
    }

    html += '</div>';
    return html;
  }

  function renderJoin() {
    var cb = state.config.cashback || {};
    var bdayRule = (state.config.rules || []).filter(function (r) { return r.key === 'birthday'; })[0];
    var bdayText = bdayRule
      ? 'знижка ' + discountLabel(bdayRule.mode, bdayRule.value) + ' на день народження' +
        minOrderNote(bdayRule.minOrderUsd)
      : 'знижка на день народження';

    return topbarHtml() +
      '<div class="stack">' +
        '<div class="panel">' +
          '<div class="panel__title">Клуб Way2Buy</div>' +
          '<p class="panel__note">' + esc(
            discountLabel(cb.mode, cb.value) + ' бонусу за покупку від ' + usd(cb.minOrderUsd) + ', ' +
            bdayText + ', і вся стрічка каналу в одному місці.'
          ) + '</p>' +
        '</div>' +
        // Exactly the four fields Maryna asked for: ім'я, адреса, телефон, ДН.
        '<form class="stack" id="joinForm">' +
          '<label class="field"><span class="field__label">Імʼя та прізвище</span>' +
            '<input class="field__input" name="name" required placeholder="Олена Ковальчук" /></label>' +
          '<label class="field"><span class="field__label">Адреса доставки</span>' +
            '<input class="field__input" name="address" required placeholder="Chicago, IL, 1234 W Main St" /></label>' +
          '<div class="form-grid">' +
            '<label class="field"><span class="field__label">Номер телефону</span>' +
              '<input class="field__input" name="phone" required placeholder="+1…" /></label>' +
            '<label class="field"><span class="field__label">Дата народження</span>' +
              '<input class="field__input" name="birthday" type="date" required /></label>' +
          '</div>' +
          '<p class="field__hint">Дату народження ми записуємо один раз — вона потрібна для знижки ' +
            'і надалі не змінюється без менеджера.</p>' +
          '<label class="inline"><input type="checkbox" name="consent" checked /> ' +
            '<span class="muted">Погоджуюсь отримувати повідомлення про знижки</span></label>' +
          '<button class="btn btn--primary" type="submit">Приєднатися до клубу</button>' +
        '</form>' +
      '</div>';
  }

  // The photo of a post: the proxy URL when Telegram carries the file, the
  // emoji placeholder otherwise. The audience picks by picture, so this is the
  // most important element on the screen.
  function postMediaHtml(p) {
    // Three sources of an image: a Telegram file_id (served via the proxy), an
    // imported file under /uploads, or the emoji stand-in.
    var url = (p.photoUrls && p.photoUrls[0]) ||
      (p.image_url && /^[/.]|^https?:/.test(p.image_url) ? p.image_url : null);
    return url
      ? '<img src="' + esc(url) + '" alt="' + esc(p.title || '') + '" loading="lazy" />'
      // The emoji stand-in lives in its own element so CSS can desaturate it
      // without touching the labels drawn over the photo.
      : '<span class="ph">' + esc(p.image_url || '🛍️') + '</span>';
  }

  function tileHtml(p) {
    var ch = p.channelMeta || {};
    var inCart = Boolean(p.inCart);
    var isStock = ch.key === state.inStockKey;
    return '<article class="tile' + (isStock ? ' tile--stock' : '') + '">' +
      '<div class="tile__media">' + postMediaHtml(p) +
        '<span class="tile__chan">' + esc(isStock ? 'В наявності' : (ch.title || p.channel)) + '</span>' +
      '</div>' +
      '<div class="tile__body">' +
        '<div class="tile__title">' + esc(p.title || 'Позиція') + '</div>' +
        (p.article ? '<div class="tile__art">' + esc(p.article) + '</div>' : '') +
        (p.price ? '<div class="tile__price">' + esc(money(p.price, p.currency)) + '</div>' : '') +
        '<button class="tile__btn' + (inCart ? ' is-in' : '') +
          '" data-add="' + p.id + '"' + (inCart ? ' disabled' : '') + '>' +
          (inCart ? 'У примірочній' : 'Хочу') + '</button>' +
      '</div>' +
    '</article>';
  }

  // ── Каталоги: search, filters, vitrine ────────────────────────────────────
  //  The filter row is deliberately plain text with an underline — except
  //  «В наявності», which is the one thing that means "ready to ship" and is
  //  the only coloured control in the app.
  function searchHtml() {
    var q = state.search || '';
    return '<div class="search">' +
      '<svg class="search__icon" viewBox="0 0 24 24" aria-hidden="true">' +
        '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>' +
      '<input class="search__input" id="searchInput" type="search" ' +
        'placeholder="Пошук за назвою або артикулом" value="' + esc(q) + '" ' +
        'autocomplete="off" enterkeyhint="search" />' +
      (q ? '<button class="search__clear" type="button" data-search-clear aria-label="Очистити">×</button>' : '') +
    '</div>';
  }

  function chipsHtml() {
    var list = state.catalogs || [];
    var stock = list.filter(function (c) { return c.inStock; });
    var rest = list.filter(function (c) { return !c.inStock; });

    var chip = function (c) {
      var active = state.feedChannel === c.key;
      return '<button class="chip' + (c.inStock ? ' chip--stock' : '') + (active ? ' is-active' : '') +
        '" data-channel="' + esc(c.key) + '">' + esc(c.title) +
        (c.count ? '<span class="chip__count">' + c.count + '</span>' : '') + '</button>';
    };

    return '<div class="chips">' +
      stock.map(chip).join('') +
      '<button class="chip' + (state.feedChannel === 'all' ? ' is-active' : '') +
        '" data-channel="all">Усе' +
        (state.catalogTotal ? '<span class="chip__count">' + state.catalogTotal + '</span>' : '') +
      '</button>' +
      rest.map(chip).join('') +
    '</div>';
  }

  // The content filters. Two rows at most, and each one appears only when it
  // has something to say: a single brand is not a choice, and «Сумки жіночі»
  // has no use for a category filter where every card is a bag. That is what
  // keeps the screen from silting up as catalogues are added.
  function facetRowHtml(kind, label, values, active) {
    if (!values || values.length < 2) return '';
    var chip = function (v) {
      return '<button class="fchip' + (active === v.value ? ' is-active' : '') +
        '" data-facet="' + esc(kind) + '" data-value="' + esc(v.value) + '">' +
        esc(v.value) + '<span class="fchip__count">' + v.count + '</span></button>';
    };
    return '<div class="facets">' +
      '<span class="facets__label">' + esc(label) + '</span>' +
      '<button class="fchip' + (active ? '' : ' is-active') +
        '" data-facet="' + esc(kind) + '" data-value="">Усі</button>' +
      values.map(chip).join('') +
    '</div>';
  }

  function facetsHtml() {
    var f = state.facets || {};
    return facetRowHtml('brand', 'Бренд', f.brands, state.filters.brand) +
      facetRowHtml('category', 'Категорія', f.categories, state.filters.category);
  }

  // Everything that changes when the selection changes lives in one container.
  // Typing in the search box repaints only this, so the input keeps its focus
  // and its caret — retyping a word because the field blurred mid-letter is the
  // kind of thing that makes an app feel broken.
  function vitrineBodyHtml() {
    var current = (state.catalogs || []).filter(function (c) { return c.key === state.feedChannel; })[0];
    var title = state.search
      ? 'Пошук'
      : (state.filters.brand || (current ? current.title : 'Усі каталоги'));

    // The count is the size of the whole selection, not of the page in hand:
    // «60 позицій» under a filter holding 900 of them is a number the client
    // would act on.
    var total = state.facets && state.facets.total ? state.facets.total : state.feed.length;

    var html = facetsHtml() +
      '<div class="vitrine-head">' +
        '<span class="vitrine-head__title">' + esc(title) + '</span>' +
        '<span class="vitrine-head__count">' + total + ' ' +
          plural(total, ['позиція', 'позиції', 'позицій']) + '</span>' +
      '</div>';

    html += state.feed.length
      ? '<div class="tiles">' + state.feed.map(tileHtml).join('') + '</div>'
      : '<div class="empty">' + (state.search
          ? 'За запитом «' + esc(state.search) + '» нічого не знайшли'
          : (state.filters.brand || state.filters.category
              ? 'За цим фільтром нічого немає'
              : 'У цьому каталозі ще немає позицій')) + '</div>';

    if (state.nextCursor) {
      html += '<button class="btn btn--ghost more" type="button" data-more="1"' +
        (state.loadingMore ? ' disabled' : '') + '>' +
        (state.loadingMore ? 'Завантажую…' : 'Показати ще') + '</button>';
    }
    return html;
  }

  function renderCatalog() {
    return topbarHtml() + '<div class="stack">' + searchHtml() + chipsHtml() +
      '<div id="vitrine">' + vitrineBodyHtml() + '</div>' +
    '</div>';
  }

  function repaintVitrine() {
    var host = document.getElementById('vitrine');
    if (host) host.innerHTML = vitrineBodyHtml();
  }

  // ── Канал: the main channel's posts, read like a feed ────────────────────
  function renderFeed() {
    var html = topbarHtml() + '<div class="stack">';

    if (!state.feed.length) {
      html += '<div class="empty">У каналі ще немає публікацій.</div>';
    } else {
      html += state.feed.map(function (p) {
        var ch = p.channelMeta || {};
        var inCart = Boolean(p.inCart);
        return '<article class="post">' +
          '<div class="post__thumb">' + postMediaHtml(p) + '</div>' +
          '<div class="post__body">' +
            '<div class="post__head">' + esc((ch.emoji || '') + ' ' + (ch.title || p.channel)) +
              ' · ' + esc(timeAgo(p.created_at)) + '</div>' +
            '<div class="post__title">' + esc(p.title) + '</div>' +
            (p.body ? '<p class="post__text">' + esc(p.body) + '</p>' : '') +
            '<div class="post__foot">' +
              '<span class="post__price">' + esc(money(p.price, p.currency)) + '</span>' +
              '<button class="btn ' + (inCart ? 'btn--ghost is-in' : 'btn--primary') +
                '" data-add="' + p.id + '"' + (inCart ? ' disabled' : '') + '>' +
                (inCart ? 'У примірочній ✓' : 'Хочу') + '</button>' +
            '</div>' +
          '</div>' +
        '</article>';
      }).join('');
    }
    return html + '</div>';
  }

  // ── Примірочна: the message is already written; one button sends it ───────
  function renderCart() {
    if (!state.me.registered) return renderJoin();
    var c = state.cart || { items: [], count: 0 };
    var html = topbarHtml() + '<div class="stack">';

    if (!c.items.length) {
      return html +
        '<div class="empty">Примірочна порожня. Відкрийте «Каталоги», ' +
          'натисніть «Хочу цю позицію» — і всі обрані речі зберуться тут.</div>' +
        '</div>';
    }

    html += '<div class="section-title">Обрані позиції (' + c.items.length + ')</div>';
    html += c.items.map(function (i) {
      return '<div class="row">' +
        '<div class="fit-row__thumb">' +
          (i.photo ? '<img src="' + esc(i.photo) + '" alt="" loading="lazy" />' : '<span class="ph">' + esc(i.emoji || '🛍️') + '</span>') +
        '</div>' +
        '<div class="row__body">' +
          '<div class="row__title">' + esc(i.title || 'Позиція') + '</div>' +
          '<div class="row__sub">' + (i.article ? 'арт. ' + esc(i.article) + ' · ' : '') +
            esc(i.channel || '') + (i.price ? ' · ' + esc(money(i.price, i.currency)) : '') + '</div>' +
        '</div>' +
        '<button class="btn btn--ghost" data-remove="' + i.id + '" aria-label="Прибрати">✕</button>' +
      '</div>';
    }).join('');

    // The coupon applies itself — the client only sees that it is already on.
    if (c.promo) {
      html += '<div class="coupon">' +
        '<span class="coupon__badge">−' + esc(c.promo.label) + '</span>' +
        '<div class="grow">' +
          '<div class="row__title">' + (c.promo.usable ? 'Знижку застосовано автоматично' : 'Знижка вже ваша') + '</div>' +
          '<div class="row__sub">' + esc(c.promo.reason || 'Промокод ' + c.promo.code) +
            (c.promo.usable
              ? ''
              : (c.promo.minOrderUsd ? ' · діє від замовлення ' + usd(c.promo.minOrderUsd) : ' · застосуємо при замовленні')) +
          '</div>' +
        '</div>' +
      '</div>';
    }

    // Pre-filled text: they may send as-is or add a line of their own.
    html += '<div class="section-title">Повідомлення ' + esc(support().dative) + '</div>' +
      '<form class="stack" id="inquiryForm">' +
        '<label class="field">' +
          '<textarea class="field__textarea" name="message" rows="5" ' +
            'placeholder="Можете дописати, що саме вас цікавить">' + esc(c.draft || '') + '</textarea>' +
          '<span class="field__hint">' + esc(support().name) + ' отримає це повідомлення разом зі списком обраних позицій.</span>' +
        '</label>' +
        '<button class="btn btn--primary btn--send" type="submit">Відправити ' + esc(support().dative) + '</button>' +
      '</form>';

    // The escape hatch: a client who does not trust a form can always write
    // directly. Losing the client to confusion costs more than a tap.
    var uname = support().username;
    if (uname) {
      html += '<div class="panel"><p class="panel__note">Або напишіть ' + esc(support().dative) +
        ' напряму: <a href="https://t.me/' + esc(uname) + '" target="_blank" rel="noopener">@' +
        esc(uname) + '</a></p></div>';
    }

    return html + '</div>';
  }

  // Promo codes + purchase history. Shown as sections of the «Знижки» tab, so a
  // client has one place for everything money-related instead of two tabs.
  function historySectionsHtml() {
    var p = state.purchases;
    var html = '';

    html += '<div class="section-title">Промокоди</div>';
    html += p.promos.length
      ? p.promos.map(function (pr) {
          return '<div class="row">' +
            '<div class="row__icon">🎟️</div>' +
            '<div class="row__body">' +
              '<div class="row__title">' + esc(pr.code) + ' · −' +
                esc(pr.label || discountLabel(pr.mode, pr.value)) + '</div>' +
              '<div class="row__sub">' + esc(pr.reason || '') + esc(minOrderNote(pr.minOrderUsd)) +
                (pr.expiresAt ? ' · до ' + esc(dateShort(pr.expiresAt)) : '') + '</div>' +
            '</div>' +
            '<button class="btn btn--ghost" data-copy="' + esc(pr.code) + '">Копіювати</button>' +
          '</div>';
        }).join('')
      : '<div class="empty">Активних промокодів немає.</div>';

    html += '<div class="section-title">Покупки</div>';
    html += p.purchases.length
      ? p.purchases.map(function (x) {
          return '<div class="row">' +
            '<div class="row__icon">' + (x.source_channel === 'luxury' ? '💎' : '🇺🇦') + '</div>' +
            '<div class="row__body">' +
              '<div class="row__title">' + esc(x.title || 'Покупка') + '</div>' +
              '<div class="row__sub">' + esc(dateShort(x.created_at)) +
                (x.discount_usd ? ' · знижка ' + usd(x.discount_usd) : '') + '</div>' +
            '</div>' +
            '<div class="row__amount">' + esc(money(x.orig_amount || x.amount_usd, x.orig_currency)) +
              '<span>' + usd(x.amount_usd) + '</span></div>' +
          '</div>';
        }).join('')
      : '<div class="empty">Покупок ще не було.</div>';

    if (p.loyalty && p.loyalty.cashbackRedeemed > 0) {
      html += '<div class="panel"><div class="panel__note">Списано бонусів: ' +
        usd(p.loyalty.cashbackRedeemed) + ' · нараховано: ' + usd(p.loyalty.cashbackEarned) + '</div></div>';
    }
    return html;
  }

  var ADMIN_TABS = [
    { key: 'bonuses', label: 'Бонуси' },
    { key: 'inquiries', label: 'Заявки' },
    { key: 'popular', label: 'Популярне' },
    { key: 'profit', label: 'Прибуток' },
    { key: 'customers', label: 'Клієнти' },
    { key: 'content', label: 'Контент' },
  ];

  // ── Заявки: what Dasha and Maryna both work from ──────────────────────────
  function adminInquiriesHtml(a) {
    var html = '<div class="section-title">Заявки від клієнтів</div>';
    if (!a.inquiries.length) return html + '<div class="empty">Заявок ще немає.</div>';

    return html + a.inquiries.map(function (q) {
      var items = (q.items || []).map(function (i) {
        return '• ' + esc(i.title || 'Позиція') + (i.article ? ' · арт. ' + esc(i.article) : '');
      }).join('<br/>');
      var STATUS = { new: ['🆕', 'нова'], answered: ['💬', 'відповіли'], closed: ['✅', 'закрита'] };
      var s = STATUS[q.status] || ['•', q.status];

      return '<div class="panel">' +
        '<div class="panel__head">' +
          '<div class="panel__title">' + esc(q.customerName || ('#' + q.customerId)) + ' · ' +
            q.itemsCount + ' поз.</div>' +
          '<span class="pill' + (q.status === 'new' ? ' pill--warn' : ' pill--ok') + '">' +
            s[0] + ' ' + esc(s[1]) + '</span>' +
        '</div>' +
        '<div class="panel__note">' + items +
          (q.message ? '<br/><br/>Питання клієнта:<br/>«' + esc(q.message) + '»' : '') +
          (q.promoLabel ? '<br/><br/>Знижка: ' + esc(q.promoLabel) : '') +
          (q.phone ? '<br/>📞 ' + esc(q.phone) : '') +
          '<br/>' + esc(timeAgo(q.createdAt)) +
        '</div>' +
        '<div class="inline" style="margin-top:var(--w2b-space-3)">' +
          (q.status === 'new'
            ? '<button class="btn btn--ghost" data-inquiry="' + q.id + '" data-inquiry-status="answered">Відповіли</button>'
            : '') +
          (q.status !== 'closed'
            ? '<button class="btn btn--ghost" data-inquiry="' + q.id + '" data-inquiry-status="closed">Закрити</button>'
            : '') +
        '</div>' +
      '</div>';
    }).join('');
  }

  // ── Популярне: every add to the fitting room, by month or by year ─────────
  function adminPopularHtml(a) {
    var p = a.popular;
    var html = '<div class="section-title">Що цікавить клієнтів</div>' +
      '<div class="seg" style="margin-bottom:var(--w2b-space-3)">' +
        ['month', 'year', 'all'].map(function (k) {
          var label = { month: 'Місяць', year: 'Рік', all: 'Весь час' }[k];
          return '<button class="seg__btn' + (a.popularPeriod === k ? ' is-active' : '') +
            '" data-pop-period="' + k + '">' + label + '</button>';
        }).join('') +
      '</div>';

    if (!p) return html + '<div class="empty">Завантаження…</div>';
    var t = p.totals || {};

    html += '<section class="stats">' +
      '<div class="stat"><div class="stat__value">' + (t.adds || 0) + '</div><div class="stat__label">у примірочну</div></div>' +
      '<div class="stat"><div class="stat__value">' + (t.inquiries || 0) + '</div><div class="stat__label">заявок</div></div>' +
      '<div class="stat"><div class="stat__value">' + (t.people || 0) + '</div><div class="stat__label">клієнтів</div></div>' +
    '</section>';

    html += '<div class="panel"><div class="panel__note">' +
      esc((p.period && p.period.label) || '') + ' · позицій: ' + (t.items || 0) +
      (t.sendRatePct != null ? ' · доходить до заявки ' + t.sendRatePct + '%' : '') +
      ' · прибрали з примірочної: ' + (t.removes || 0) +
    '</div></div>';

    html += '<div class="section-title">Топ позицій</div>';
    html += (p.items || []).length
      ? p.items.map(function (i, n) {
          return '<div class="row">' +
            '<div class="row__icon">' + (n + 1) + '</div>' +
            '<div class="row__body">' +
              '<div class="row__title">' + esc(i.title || 'Позиція') +
                (i.article ? ' · арт. ' + esc(i.article) : '') + '</div>' +
              '<div class="row__sub">' + esc(i.channel || '') + ' · ' + i.people + ' клієнт(ів)' +
                (i.sendRatePct != null ? ' · заявка ' + i.sendRatePct + '%' : '') + '</div>' +
            '</div>' +
            '<div class="row__amount">' + i.adds + '<span>у примірочну</span></div>' +
          '</div>';
        }).join('')
      : '<div class="empty">За цей період нічого не додавали.</div>';

    if ((p.byChannel || []).length) {
      html += '<div class="section-title">По каталогах</div>';
      html += p.byChannel.map(function (c) {
        return '<div class="row">' +
          '<div class="row__icon">🗂️</div>' +
          '<div class="row__body">' +
            '<div class="row__title">' + esc(c.channel) + '</div>' +
            '<div class="row__sub">' + c.people + ' клієнт(ів) · ' + c.sends + ' у заявках</div>' +
          '</div>' +
          '<div class="row__amount">' + c.adds + '<span>додано</span></div>' +
        '</div>';
      }).join('');
    }

    if ((p.timeline || []).length) {
      html += '<div class="section-title">Динаміка</div>';
      html += p.timeline.map(function (b) {
        return '<div class="row">' +
          '<div class="row__body">' +
            '<div class="row__title">' + esc(b.bucket) + '</div>' +
            '<div class="row__sub">' + b.people + ' клієнт(ів) · ' + b.sends + ' у заявках</div>' +
          '</div>' +
          '<div class="row__amount">' + b.adds + '<span>додано</span></div>' +
        '</div>';
      }).join('');
    }

    return html;
  }

  // ── Бонуси: the $ ⇄ % switch for both rules and every holiday ─────────────
  function adminBonusesHtml(a) {
    var html = '<div class="section-title">Бонуси</div>';

    html += a.rules.length
      ? a.rules.map(function (r) {
          return '<div class="row row--tap" data-rule="' + esc(r.key) + '">' +
            '<div class="row__icon">' + esc(r.emoji || '🏷️') + '</div>' +
            '<div class="row__body">' +
              '<div class="row__title">' + esc(r.name) + ' · ' + esc(discountLabel(r.mode, r.value)) + '</div>' +
              '<div class="row__sub">' + esc(r.summary || '') + '</div>' +
            '</div>' +
            '<span class="pill' + (r.enabled ? ' pill--ok' : ' pill--warn') + '">' +
              (r.enabled ? 'увімкнено' : 'вимкнено') + '</span>' +
          '</div>';
        }).join('')
      : '<div class="empty">Правила не завантажені.</div>';

    html += '<div class="section-title">Свята</div>' +
      '<div class="panel"><p class="panel__note">Кожне свято налаштовується так само: сума в $ ' +
      'або відсоток, мінімальне замовлення і скільки днів діє.</p>' +
      '<div class="inline" style="margin-top:var(--w2b-space-3)">' +
        '<button class="btn btn--ghost" data-action="new-holiday">Додати свято</button>' +
      '</div></div>';

    html += a.holidays.map(function (h) {
      return '<div class="row row--tap" data-holiday="' + h.id + '">' +
        '<div class="row__icon">' + esc(h.emoji || '🎉') + '</div>' +
        '<div class="row__body">' +
          '<div class="row__title">' + esc(h.name) + ' · ' + esc(discountLabel(h.mode, h.value)) + '</div>' +
          '<div class="row__sub">' + esc(h.date) + ' · діє ' + (h.validDays || 14) + ' дн' +
            esc(minOrderNote(h.minOrderUsd)) + '</div>' +
        '</div>' +
        '<span class="pill' + (h.enabled ? ' pill--ok' : ' pill--warn') + '">' +
          (h.enabled ? 'увімкнено' : 'вимкнено') + '</span>' +
      '</div>';
    }).join('');

    // The birthday audit trail — every request, granted or refused.
    html += '<div class="section-title">Заявки на знижку ДН</div>';
    html += a.claims.length
      ? a.claims.slice(0, 15).map(function (c) {
          var VERDICT = {
            granted: ['✅', 'видано'],
            mismatch: ['⚠️', 'дата не збігається'],
            already_claimed: ['🔁', 'вже отримано цього року'],
            out_of_window: ['⏳', 'поза періодом'],
            invalid_date: ['❌', 'некоректна дата'],
            disabled: ['🚫', 'знижка вимкнена'],
          };
          var v = VERDICT[c.verdict] || ['•', c.verdict];
          return '<div class="row">' +
            '<div class="row__icon">' + v[0] + '</div>' +
            '<div class="row__body">' +
              '<div class="row__title">' + esc(c.name || ('#' + c.customerId)) + ' · ' + esc(v[1]) + '</div>' +
              '<div class="row__sub">заявлено ' + esc(c.claimed || '—') +
                (c.onFile ? ' · у базі ' + esc(String(c.onFile).slice(5)) : ' · у базі не було') +
                ' · ' + esc(timeAgo(c.createdAt)) + '</div>' +
            '</div>' +
          '</div>';
        }).join('')
      : '<div class="empty">Заявок ще не було.</div>';

    return html;
  }

  // ── Прибуток: revenue − discount − cost, per bag ──────────────────────────
  function adminProfitHtml(a) {
    var p = a.profit || { totals: {}, items: [] };
    var t = p.totals || {};
    var html = '<div class="section-title">Прибуток</div>';

    html += '<section class="stats">' +
      '<div class="stat"><div class="stat__value">' + usd(t.netUsd || 0) + '</div><div class="stat__label">виручка</div></div>' +
      '<div class="stat"><div class="stat__value">' + usd(t.costUsd || 0) + '</div><div class="stat__label">витрати</div></div>' +
      '<div class="stat"><div class="stat__value">' + usd(t.profitUsd || 0) + '</div><div class="stat__label">чистий</div></div>' +
    '</section>';

    html += '<div class="panel"><p class="panel__note">' +
      (t.marginPct != null ? 'Маржа ' + t.marginPct + '% · ' : '') +
      'у прибутку враховано ' + (t.ordersWithCost || 0) + ' з ' + (t.orders || 0) + ' замовлень' +
      (t.avgProfitUsd != null ? ' · середній прибуток ' + usd(t.avgProfitUsd) : '') +
    '</p></div>';

    // Sales still missing a cost: this is what the next-day reminder is about.
    if (a.pendingCosts.length) {
      html += '<div class="section-title">Без собівартості (' + a.pendingCosts.length + ')</div>';
      html += a.pendingCosts.map(function (x) {
        return '<div class="row row--tap" data-cost="' + x.id + '">' +
          '<div class="row__icon">📊</div>' +
          '<div class="row__body">' +
            '<div class="row__title">' + esc(x.title || 'Покупка') + ' · ' + esc(x.customer_name || '') + '</div>' +
            '<div class="row__sub">продано ' + esc(dateShort(x.created_at)) +
              ' · клієнт заплатив ' + usd(x.amount_usd) + ' — введіть, скільки віддали в Китаї</div>' +
          '</div>' +
          '<button class="btn btn--ghost" data-cost="' + x.id + '">Ввести</button>' +
        '</div>';
      }).join('');
    }

    html += '<div class="section-title">По замовленнях</div>';
    html += (p.items || []).length
      ? p.items.slice(0, 30).map(function (x) {
          return '<div class="row' + (x.complete ? '' : ' row--tap') + '"' +
              (x.complete ? '' : ' data-cost="' + x.id + '"') + '>' +
            '<div class="row__icon">' + (x.complete ? '👜' : '❓') + '</div>' +
            '<div class="row__body">' +
              '<div class="row__title">' + esc(x.title || 'Покупка') + ' · ' + esc(x.customerName || '') + '</div>' +
              '<div class="row__sub">' + esc(dateShort(x.createdAt)) + ' · клієнт ' + usd(x.netUsd) +
                (x.complete ? ' · закупка ' + usd(x.costUsd) : ' · собівартість не введена') + '</div>' +
            '</div>' +
            '<div class="row__amount">' + (x.complete ? usd(x.profitUsd) : '—') +
              '<span>' + (x.marginPct != null ? x.marginPct + '%' : 'нема даних') + '</span></div>' +
          '</div>';
        }).join('')
      : '<div class="empty">Підтверджених покупок ще немає.</div>';

    return html;
  }

  function adminCustomersHtml(a) {
    var html = '<div class="section-title">Клієнти (' + a.customers.length + ')</div>';
    html += a.customers.map(function (c) {
      var l = c.loyalty || {};
      return '<div class="row row--tap" data-customer="' + c.id + '">' +
        '<div class="row__icon">' + esc((c.name || '?')[0]) + '</div>' +
        '<div class="row__body">' +
          '<div class="row__title">' + esc(c.name) + '</div>' +
          '<div class="row__sub">' + (l.purchases || 0) + ' покупок' +
            (c.birthday ? ' · ДН ' + esc(String(c.birthday).slice(5)) : ' · ДН невідомий') +
            (c.birthdaySource ? ' (' + esc(c.birthdaySource) + ')' : '') + '</div>' +
        '</div>' +
        '<div class="row__amount">' + usd(l.totalSpent || 0) +
          '<span>бонус ' + usd(l.cashbackAvailable || 0) + '</span></div>' +
      '</div>';
    }).join('');
    return html;
  }

  function adminContentHtml(a) {
    var html = '<div class="section-title">Канали</div>' +
      '<div class="panel"><p class="panel__note">«Синхронізувати» зчитує канал і вирівнює каталог ' +
        'під нього: нові пости додаються, змінені оновлюються, знятих більше не видно. ' +
        'Сам канал не змінюється — застосунок його лише читає. Виправлені вручну назви та ' +
        'приховані картки синхронізація не перезаписує.</p></div>';

    // The channel list carries its own sync state, so it comes from the admin
    // endpoint (with counts) rather than from the client config. `.length` and not
    // just `a.channels`: an empty array is truthy, so the fallback would never
    // fire and the section would render as a heading with nothing under it.
    var channels = (a.channels && a.channels.length) ? a.channels : (state.config.channels || []);
    // Thirty-one rows, of which a dozen are empty placeholders for brands nobody
    // has a channel for yet. The ones that can actually be synced go first, then
    // the fullest — the same ordering rule the client's chips use.
    channels = channels.slice().sort(function (x, y) {
      var sx = (x.username ? 2 : 0) + (x.enabled ? 1 : 0);
      var sy = (y.username ? 2 : 0) + (y.enabled ? 1 : 0);
      if (sx !== sy) return sy - sx;
      return ((y.posts && y.posts.published) || 0) - ((x.posts && x.posts.published) || 0);
    });
    html += channels.map(function (c) {
      var counts = c.posts || null;
      var job = a.sync[c.key];
      var sub = esc(c.username ? '@' + c.username : c.key) +
        (counts ? ' · ' + counts.published + ' поз.' : '') +
        (counts && counts.gone ? ' · ' + counts.gone + ' знято' : '') +
        (counts && counts.hidden ? ' · ' + counts.hidden + ' прихов.' : '') +
        (c.syncedAt ? ' · ' + esc(timeAgo(c.syncedAt)) : ' · ще не синхронізовано');

      return '<div class="row row--sync">' +
        '<div class="row__icon">' + esc(c.emoji || '🛍️') + '</div>' +
        '<div class="row__body">' +
          '<div class="row__title">' + esc(c.title) + '</div>' +
          '<div class="row__sub">' + sub + '</div>' +
          (job ? '<div class="row__sync' + (job.error ? ' is-error' : '') + '">' +
            esc(job.error || job.note) + '</div>' : '') +
        '</div>' +
        (c.username
          ? '<div class="row__actions">' +
              '<button class="btn btn--primary btn--sm" data-sync="' + esc(c.key) + '"' +
                (job && job.running ? ' disabled' : '') + '>' +
                (job && job.running ? '…' : 'Синхронізувати') + '</button>' +
              (c.historyDone ? '' :
                '<button class="btn btn--ghost btn--sm" data-sync-deep="' + esc(c.key) + '"' +
                  (job && job.running ? ' disabled' : '') + '>Уся історія</button>') +
            '</div>'
          : '<span class="pill pill--warn">без @username</span>') +
      '</div>';
    }).join('');

    // Cards that arrived from the channels: this is where a guessed title gets
    // corrected into a brand and a category.
    html += '<div class="section-title">Картки з каналів</div>';
    html += a.posts.length
      ? a.posts.slice(0, 20).map(function (p) {
          var thumb = (p.photoUrls && p.photoUrls[0]) ||
            (p.image_url && /^[/.]|^https?:/.test(p.image_url) ? p.image_url : null);
          return '<div class="row row--tap" data-post="' + p.id + '">' +
            '<div class="fit-row__thumb">' +
              (thumb ? '<img src="' + esc(thumb) + '" alt="" loading="lazy" />' : '<span class="ph">🛍️</span>') +
            '</div>' +
            '<div class="row__body">' +
              '<div class="row__title">' + esc(p.title || 'Без назви') + '</div>' +
              '<div class="row__sub">' + esc(p.channel) +
                (p.brand ? ' · ' + esc(p.brand) : '') +
                (p.category ? ' · ' + esc(p.category) : '') +
                (p.article ? ' · ' + esc(p.article) : '') +
                (p.status === 'hidden' ? ' · прихована' : '') + '</div>' +
            '</div>' +
            '<button class="btn btn--ghost" data-post="' + p.id + '">Змінити</button>' +
          '</div>';
        }).join('')
      : '<div class="empty">Постів із каналів ще немає</div>';

    // Campaigns stay available for one-off percentage promos.
    html += '<div class="section-title">Кампанії</div>';
    html += a.campaigns.length
      ? a.campaigns.map(function (c) {
          var window_ = c.type === 'birthday'
            ? 'за ' + (c.window_days || 0) + ' дн до ДН'
            : (c.starts_at ? dateShort(c.starts_at) : '—') + ' → ' + (c.ends_at ? dateShort(c.ends_at) : '∞');
          return '<div class="row">' +
            '<div class="row__icon">' + ({ birthday: '🎂', holiday: '🎉', vip: '💎' }[c.type] || '🏷️') + '</div>' +
            '<div class="row__body">' +
              '<div class="row__title">' + esc(c.name) + ' · −' + c.percent + '%</div>' +
              '<div class="row__sub">' + esc(c.status) + ' · ' + esc(window_) +
                (c.recurring ? ' · щороку' : '') + '</div>' +
            '</div>' +
            '<button class="btn btn--ghost" data-materialize="' + c.id + '">Видати</button>' +
          '</div>';
        }).join('')
      : '<div class="empty">Кампаній немає.</div>';

    html += '<div class="section-title">Звіт</div>' +
      '<div class="panel">' +
        '<div class="seg" style="margin-bottom:var(--w2b-space-3)">' +
          '<button class="seg__btn' + (a.reportPeriod === 'day' ? ' is-active' : '') + '" data-period="day">День</button>' +
          '<button class="seg__btn' + (a.reportPeriod === 'week' ? ' is-active' : '') + '" data-period="week">Тиждень</button>' +
        '</div>' +
        (a.report
          ? '<div class="report">' + esc(a.report.text) + '</div>' +
            '<div class="panel__note" style="margin-top:var(--w2b-space-3)">Джерело: ' + esc(a.report.engine) + '</div>'
          : '<div class="empty">Натисніть період, щоб побудувати звіт.</div>') +
      '</div>';

    return html;
  }

  function renderAdmin() {
    var a = state.admin;
    var html = topbarHtml() + '<div class="stack">';

    html += '<div class="panel"><div class="panel__head">' +
        '<div class="panel__title">Кабінет</div>' +
        '<span class="pill' + (state.config.live ? ' pill--ok' : ' pill--warn') + '">' +
          (state.config.live ? 'Telegram LIVE' : 'DEMO — публікації симулюються') + '</span>' +
      '</div>' +
      '<div class="inline">' +
        '<button class="btn btn--primary" data-action="new-post">Опублікувати товар</button>' +
        '<button class="btn btn--ghost" data-action="new-purchase">Додати покупку</button>' +
        '<button class="btn btn--ghost" data-action="new-campaign">Нова кампанія</button>' +
      '</div></div>';

    html += '<div class="seg">' + ADMIN_TABS.map(function (t) {
      return '<button class="seg__btn' + (a.adminTab === t.key ? ' is-active' : '') +
        '" data-admin-tab="' + t.key + '">' + esc(t.label) + '</button>';
    }).join('') + '</div>';

    if (a.adminTab === 'profit') html += adminProfitHtml(a);
    else if (a.adminTab === 'inquiries') html += adminInquiriesHtml(a);
    else if (a.adminTab === 'popular') html += adminPopularHtml(a);
    else if (a.adminTab === 'customers') html += adminCustomersHtml(a);
    else if (a.adminTab === 'content') html += adminContentHtml(a);
    else html += adminBonusesHtml(a);

    return html + '</div>';
  }

  /* ── sheets (admin forms) ───────────────────────────────────────────────── */

  function sheetNewPost() {
    openSheet('Опублікувати товар',
      '<form class="stack" id="postForm">' +
        '<label class="field"><span class="field__label">Канал</span>' +
          '<select class="field__select" name="channel">' +
            state.config.channels.map(function (c) {
              return '<option value="' + esc(c.key) + '">' + esc(c.flag + ' ' + c.title) + '</option>';
            }).join('') +
          '</select></label>' +
        '<label class="field"><span class="field__label">Назва</span>' +
          '<input class="field__input" name="title" required placeholder="Calvin Klein сукня" /></label>' +
        '<label class="field"><span class="field__label">Опис</span>' +
          '<textarea class="field__textarea" name="body" placeholder="Нова колекція, доставка 10–14 днів"></textarea></label>' +
        '<div class="form-grid">' +
          '<label class="field"><span class="field__label">Ціна</span>' +
            '<input class="field__input" name="price" type="number" step="0.01" placeholder="3480" /></label>' +
          '<label class="field"><span class="field__label">Валюта</span>' +
            '<select class="field__select" name="currency"><option>UAH</option><option>USD</option><option>EUR</option></select></label>' +
        '</div>' +
        '<p class="field__hint">Пост зʼявиться і в каналі Telegram, і у стрічці застосунку.</p>' +
        '<button class="btn btn--primary" type="submit">Опублікувати</button>' +
      '</form>');
  }

  // The one form that makes every discount switchable between $ and %.
  function modeFieldsHtml(o) {
    return '<div class="form-grid">' +
      '<label class="field"><span class="field__label">Тип знижки</span>' +
        '<select class="field__select" name="mode">' +
          '<option value="fixed"' + (o.mode === 'fixed' ? ' selected' : '') + '>$ — фіксована сума</option>' +
          '<option value="percent"' + (o.mode === 'percent' ? ' selected' : '') + '>% — відсоток</option>' +
        '</select></label>' +
      '<label class="field"><span class="field__label">Розмір</span>' +
        '<input class="field__input" name="value" type="number" step="0.01" min="0.01" required value="' +
          esc(o.value) + '" /></label>' +
    '</div>' +
    '<label class="field"><span class="field__label">Мінімальне замовлення, $</span>' +
      '<input class="field__input" name="minOrderUsd" type="number" step="1" min="0" value="' +
        esc(o.minOrderUsd || 0) + '" /></label>';
  }

  function sheetRule(key) {
    var r = state.admin.rules.filter(function (x) { return x.key === key; })[0];
    if (!r) return;
    var extra = '';
    if (r.key === 'cashback') {
      extra = '<label class="field"><span class="field__label">Максимум накопичення, $</span>' +
        '<input class="field__input" name="capUsd" type="number" step="1" min="0" value="' +
          esc(r.capUsd == null ? '' : r.capUsd) + '" />' +
        '<span class="field__hint">Порожньо — без ліміту.</span></label>';
    } else {
      extra = '<label class="field"><span class="field__label">Скільки днів діє</span>' +
        '<input class="field__input" name="validDays" type="number" min="1" max="365" value="' +
          esc(r.validDays || 30) + '" /></label>';
    }

    openSheet(r.name,
      '<form class="stack" id="ruleForm" data-key="' + esc(r.key) + '">' +
        modeFieldsHtml(r) + extra +
        '<label class="inline"><input type="checkbox" name="enabled"' + (r.enabled ? ' checked' : '') + ' /> ' +
          '<span class="muted">Знижка активна</span></label>' +
        '<p class="field__hint">' + esc(r.summary || '') + '</p>' +
        '<button class="btn btn--primary" type="submit">Зберегти</button>' +
      '</form>');
  }

  function sheetHoliday(id) {
    var h = state.admin.holidays.filter(function (x) { return String(x.id) === String(id); })[0];
    if (!h) return;
    openSheet(h.name,
      '<form class="stack" id="holidayForm" data-id="' + h.id + '">' +
        modeFieldsHtml(h) +
        '<div class="form-grid">' +
          '<label class="field"><span class="field__label">Місяць</span>' +
            '<input class="field__input" name="month" type="number" min="1" max="12" value="' + h.month + '" /></label>' +
          '<label class="field"><span class="field__label">День</span>' +
            '<input class="field__input" name="day" type="number" min="1" max="31" value="' + h.day + '" /></label>' +
        '</div>' +
        '<label class="field"><span class="field__label">Скільки днів діє</span>' +
          '<input class="field__input" name="validDays" type="number" min="1" max="365" value="' +
            (h.validDays || 14) + '" /></label>' +
        '<label class="inline"><input type="checkbox" name="enabled"' + (h.enabled ? ' checked' : '') + ' /> ' +
          '<span class="muted">Свято активне</span></label>' +
        '<button class="btn btn--primary" type="submit">Зберегти</button>' +
      '</form>');
  }

  function sheetNewHoliday() {
    openSheet('Нове свято',
      '<form class="stack" id="newHolidayForm">' +
        '<div class="form-grid">' +
          '<label class="field"><span class="field__label">Назва</span>' +
            '<input class="field__input" name="name" required placeholder="Великдень" /></label>' +
          '<label class="field"><span class="field__label">Емодзі</span>' +
            '<input class="field__input" name="emoji" value="🎉" /></label>' +
        '</div>' +
        '<div class="form-grid">' +
          '<label class="field"><span class="field__label">Місяць</span>' +
            '<input class="field__input" name="month" type="number" min="1" max="12" required /></label>' +
          '<label class="field"><span class="field__label">День</span>' +
            '<input class="field__input" name="day" type="number" min="1" max="31" required /></label>' +
        '</div>' +
        modeFieldsHtml({ mode: 'percent', value: 15, minOrderUsd: 0 }) +
        '<label class="field"><span class="field__label">Скільки днів діє</span>' +
          '<input class="field__input" name="validDays" type="number" min="1" max="365" value="14" /></label>' +
        '<button class="btn btn--primary" type="submit">Додати свято</button>' +
      '</form>');
  }

  // A channel post is prose; this turns it into a catalogue card. Brand and
  // category are what the vitrine and the filters actually show, so they are
  // the first two fields.
  function sheetPost(id) {
    var p = state.admin.posts.filter(function (x) { return String(x.id) === String(id); })[0];
    if (!p) return;
    var thumb = (p.photoUrls && p.photoUrls[0]) ||
      (p.image_url && /^[/.]|^https?:/.test(p.image_url) ? p.image_url : null);

    openSheet('Картка позиції',
      '<form class="stack" id="postEditForm" data-id="' + p.id + '">' +
        (thumb ? '<img src="' + esc(thumb) + '" alt="" style="width:100%;max-height:240px;object-fit:cover" />' : '') +
        '<label class="field"><span class="field__label">Назва у вітрині</span>' +
          '<input class="field__input" name="title" value="' + esc(p.title || '') + '" required /></label>' +
        '<div class="form-grid">' +
          '<label class="field"><span class="field__label">Бренд</span>' +
            '<input class="field__input" name="brand" value="' + esc(p.brand || '') + '" placeholder="Chanel" /></label>' +
          '<label class="field"><span class="field__label">Категорія</span>' +
            '<input class="field__input" name="category" value="' + esc(p.category || '') + '" placeholder="сумка" /></label>' +
        '</div>' +
        '<div class="form-grid">' +
          '<label class="field"><span class="field__label">Артикул</span>' +
            '<input class="field__input" name="article" value="' + esc(p.article || '') + '" /></label>' +
          '<label class="field"><span class="field__label">Ціна, $</span>' +
            '<input class="field__input" name="price" type="number" step="0.01" value="' + esc(p.price == null ? '' : p.price) + '" /></label>' +
        '</div>' +
        '<label class="inline"><input type="checkbox" name="hidden"' + (p.status === 'hidden' ? ' checked' : '') + ' /> ' +
          '<span class="muted">Сховати з вітрини</span></label>' +
        '<p class="field__hint">Оригінальний текст поста зберігається — правки стосуються лише картки.</p>' +
        '<button class="btn btn--primary" type="submit">Зберегти</button>' +
      '</form>');
  }

  // "Скільки ця сумка коштувала нам" — the missing half of the profit figure.
  function sheetCost(purchaseId) {
    var src = state.admin.pendingCosts.filter(function (x) { return String(x.id) === String(purchaseId); })[0]
      || ((state.admin.profit && state.admin.profit.items) || []).filter(function (x) { return String(x.id) === String(purchaseId); })[0];
    var paid = src ? (src.amount_usd != null ? src.amount_usd : src.netUsd) : null;

    openSheet('Собівартість замовлення',
      '<form class="stack" id="costForm" data-id="' + purchaseId + '">' +
        (src ? '<div class="panel"><div class="panel__note">' + esc(src.title || 'Покупка') +
          (paid != null ? ' · клієнт заплатив ' + usd(paid) : '') + '</div></div>' : '') +
        '<label class="field"><span class="field__label">Скільки витрачено разом, $</span>' +
          '<input class="field__input" name="costUsd" type="number" step="0.01" min="0" required ' +
            'placeholder="фабрика + доставка + збори" /></label>' +
        '<label class="field"><span class="field__label">Коментар</span>' +
          '<input class="field__input" name="note" placeholder="фабрика $180 + DHL $45" /></label>' +
        '<p class="field__hint">Без цієї цифри замовлення не потрапляє у прибуток — ' +
          'нагадування приходить наступного дня після продажу.</p>' +
        '<button class="btn btn--primary" type="submit">Зберегти</button>' +
      '</form>');
  }

  function sheetNewCampaign() {
    openSheet('Нове правило знижки',
      '<form class="stack" id="campaignForm">' +
        '<label class="field"><span class="field__label">Назва</span>' +
          '<input class="field__input" name="name" required placeholder="Кожна 5-та покупка" /></label>' +
        '<div class="form-grid">' +
          '<label class="field"><span class="field__label">Тип</span>' +
            '<select class="field__select" name="type">' +
              '<option value="birthday">🎂 День народження</option>' +
              '<option value="holiday">🎉 Свято</option>' +
              '<option value="vip">💎 VIP</option>' +
              '<option value="generic">🏷️ Загальна</option>' +
            '</select></label>' +
          '<label class="field"><span class="field__label">Знижка, %</span>' +
            '<input class="field__input" name="percent" type="number" min="1" max="90" value="20" required /></label>' +
        '</div>' +
        '<div class="form-grid">' +
          '<label class="field"><span class="field__label">За скільки днів до ДН</span>' +
            '<input class="field__input" name="windowDays" type="number" min="0" max="60" value="3" /></label>' +
          '<label class="field"><span class="field__label">Промокод діє, днів</span>' +
            '<input class="field__input" name="promoValidDays" type="number" min="1" max="365" value="14" /></label>' +
        '</div>' +
        '<div class="form-grid">' +
          '<label class="field"><span class="field__label">Початок</span>' +
            '<input class="field__input" name="startsAt" type="date" /></label>' +
          '<label class="field"><span class="field__label">Кінець</span>' +
            '<input class="field__input" name="endsAt" type="date" /></label>' +
        '</div>' +
        '<label class="field"><span class="field__label">Аудиторія — мінімальний рівень</span>' +
          '<select class="field__select" name="tier">' +
            '<option value="">Усі клієнти</option>' +
            state.config.tiers.map(function (t) {
              return '<option value="' + esc(t.key) + '">' + esc(t.name) + ' і вище</option>';
            }).join('') +
          '</select></label>' +
        '<label class="inline"><input type="checkbox" name="recurring" checked /> ' +
          '<span class="muted">Повторювати щороку</span></label>' +
        '<p class="field__hint">Правило можна змінити будь-коли: сьогодні −10% на кожну 5-ту покупку, ' +
          'через пів року — на кожну 3-тю.</p>' +
        '<button class="btn btn--primary" type="submit">Створити</button>' +
      '</form>');
  }

  function sheetNewPurchase(preselectId) {
    openSheet('Додати покупку',
      '<form class="stack" id="purchaseForm">' +
        '<label class="field"><span class="field__label">Клієнт</span>' +
          '<select class="field__select" name="customerId">' +
            state.admin.customers.map(function (c) {
              return '<option value="' + c.id + '"' + (String(c.id) === String(preselectId) ? ' selected' : '') +
                '>' + esc(c.name) + '</option>';
            }).join('') +
          '</select></label>' +
        '<label class="field"><span class="field__label">Товар</span>' +
          '<input class="field__input" name="title" placeholder="Michael Kors сумка" /></label>' +
        '<div class="form-grid">' +
          '<label class="field"><span class="field__label">Сума</span>' +
            '<input class="field__input" name="amount" type="number" step="0.01" required placeholder="410" /></label>' +
          '<label class="field"><span class="field__label">Валюта</span>' +
            '<select class="field__select" name="currency"><option>UAH</option><option>USD</option><option>EUR</option></select></label>' +
        '</div>' +
        '<label class="field"><span class="field__label">Канал</span>' +
          '<select class="field__select" name="channel">' +
            state.config.channels.map(function (c) {
              return '<option value="' + esc(c.key) + '">' + esc(c.title) + '</option>';
            }).join('') +
          '</select></label>' +
        // Cost entered here means no reminder tomorrow.
        '<div class="form-grid">' +
          '<label class="field"><span class="field__label">Собівартість, $</span>' +
            '<input class="field__input" name="costUsd" type="number" step="0.01" min="0" placeholder="скільки віддали в Китаї" /></label>' +
          '<label class="field"><span class="field__label">Знижка, $</span>' +
            '<input class="field__input" name="discountUsd" type="number" step="0.01" min="0" placeholder="0" /></label>' +
        '</div>' +
        '<p class="field__hint">Сума перераховується в USD — бонус рахується від неї. ' +
          'Якщо собівартість не ввести зараз, нагадаємо наступного дня.</p>' +
        '<button class="btn btn--primary" type="submit">Зберегти</button>' +
      '</form>');
  }

  function sheetCustomer(id) {
    var c = state.admin.customers.find(function (x) { return String(x.id) === String(id); });
    if (!c) return;
    var l = c.loyalty || {};
    openSheet(c.name,
      '<div class="stack">' +
        '<div class="panel"><div class="panel__note">' +
          (c.phone ? '📞 ' + esc(c.phone) + '<br/>' : '') +
          (c.address ? '📍 ' + esc(c.address) + '<br/>' : '') +
          (c.birthday
            ? '🎂 ' + esc(c.birthday) + (c.birthdaySource ? ' · джерело: ' + esc(c.birthdaySource) : '')
            : '🎂 дата народження невідома') +
        '</div></div>' +
        '<section class="stats">' +
          '<div class="stat"><div class="stat__value">' + usd(l.totalSpent || 0) + '</div><div class="stat__label">разом</div></div>' +
          '<div class="stat"><div class="stat__value">' + (l.purchases || 0) + '</div><div class="stat__label">покупок</div></div>' +
          '<div class="stat"><div class="stat__value">' + usd(l.cashbackAvailable || 0) + '</div><div class="stat__label">бонус</div></div>' +
        '</section>' +
        // Correcting the stored birthday is an admin action: that date is what
        // every future discount request is verified against.
        '<form class="stack" id="bdayFixForm" data-customer="' + c.id + '">' +
          '<label class="field"><span class="field__label">Дата народження у базі</span>' +
            '<input class="field__input" name="birthday" type="date" value="' +
              esc(c.birthday && c.birthday.slice(0, 4) !== '1900' ? c.birthday : '') + '" required /></label>' +
          '<button class="btn btn--ghost" type="submit">Оновити дату</button>' +
        '</form>' +
        '<form class="stack" id="promoForm" data-customer="' + c.id + '">' +
          modeFieldsHtml({ mode: 'fixed', value: 50, minOrderUsd: 0 }) +
          '<div class="form-grid">' +
            '<label class="field"><span class="field__label">Діє, днів</span>' +
              '<input class="field__input" name="days" type="number" min="1" max="365" value="30" /></label>' +
            '<label class="field"><span class="field__label">Причина</span>' +
              '<input class="field__input" name="reason" placeholder="Персональна знижка" /></label>' +
          '</div>' +
          '<div class="inline">' +
            '<button class="btn btn--primary" type="submit">Видати промокод</button>' +
            '<button class="btn btn--ghost" type="button" data-action="new-purchase" data-customer="' + c.id + '">Додати покупку</button>' +
          '</div>' +
        '</form>' +
      '</div>');
  }

  function sheetNotifications() {
    var list = state.notifications.notifications;
    openSheet('Повідомлення', list.length
      ? '<div class="stack">' + list.map(function (n) {
          var icon = { birthday: '🎂', holiday: '🎉', new_discount: '🏷️', near_reward: '💰' }[n.kind] || '🔔';
          return '<div class="notif' + (n.in_app_status === 'unread' ? ' notif--unread' : '') + '">' +
            '<span class="notif__icon">' + icon + '</span>' +
            '<div class="notif__body">' +
              '<p class="notif__title">' + esc(n.title) + '</p>' +
              (n.body ? '<p class="notif__text">' + esc(n.body) + '</p>' : '') +
              '<span class="notif__time">' + esc(timeAgo(n.created_at)) + '</span>' +
            '</div>' +
            '<span class="notif__dot"></span>' +
          '</div>';
        }).join('') + '</div>'
      : '<div class="empty">Повідомлень ще немає.</div>');

    if (state.notifications.unread) {
      api.markRead().then(function () {
        state.notifications.unread = 0;
        var b = document.querySelector('.notif-badge');
        if (b) { b.hidden = true; b.textContent = '0'; }
      }).catch(function () { /* non-critical */ });
    }
  }

  /* ── data loading ───────────────────────────────────────────────────────── */

  async function loadTab(tab) {
    if (tab === 'home') {
      var r = await Promise.all([api.me(), api.discounts(), api.notifications(), api.purchases()]);
      state.me = r[0];
      state.discounts = r[1];
      state.notifications = r[2];
      state.purchases = r[3];
      state.birthday = r[1].birthday || (r[0].birthday || null);
    } else if (tab === 'catalog') {
      var loaded = await Promise.all([
        loadVitrine(),
        api.facets(selection()),
        // The chips carry per-catalogue totals, which do not depend on the
        // selection — fetched once per session.
        state.catalogs.length ? null : api.catalogs(),
      ]);
      state.facets = loaded[1] || state.facets;
      if (loaded[2]) {
        state.catalogs = loaded[2].catalogs || [];
        state.catalogTotal = loaded[2].total || 0;
        state.inStockKey = loaded[2].inStockKey || 'available';
      }
    } else if (tab === 'feed') {
      var f = await api.feedKind('main');
      state.feed = f.posts || [];
    } else if (tab === 'cart') {
      state.cart = await api.cart.get();
      paintCartBadge(state.cart.count);
    } else if (tab === 'admin') {
      // One round-trip per panel, all in parallel; a failing panel must not
      // blank the whole cabinet, so each result is taken defensively.
      var a = await Promise.all([
        api.admin.customers(), api.admin.campaigns(), api.admin.rules(),
        api.admin.profit(), api.admin.pendingCosts(), api.admin.birthdayClaims(),
      ]);
      state.admin.customers = a[0].customers || [];
      state.admin.campaigns = a[1].campaigns || [];
      state.admin.rules = a[2].rules || [];
      state.admin.holidays = a[2].holidays || [];
      state.admin.profit = a[3] || null;
      state.admin.pendingCosts = a[4].pending || [];
      state.admin.claims = a[5].claims || [];
      if (state.admin.adminTab === 'popular') await loadPopular();
      if (state.admin.adminTab === 'content') {
        var content = await Promise.all([api.admin.posts(), api.admin.channels()]);
        state.admin.posts = content[0].posts || [];
        state.admin.channels = content[1].channels || [];
      }
      if (state.admin.adminTab === 'inquiries') {
        state.admin.inquiries = (await api.admin.inquiries()).inquiries || [];
      }
    }
  }

  // What the client is currently looking at — the one description of the
  // selection, shared by the vitrine and by its filters. api.js turns it into
  // query params (and drops the chip while a search is running, because a
  // search spans every catalogue).
  function selection(extra) {
    var sel = {
      channel: state.feedChannel,
      q: state.search,
      brand: state.filters.brand,
      category: state.filters.category,
    };
    if (extra && extra.cursor) sel.cursor = extra.cursor;
    return sel;
  }

  async function loadVitrine(opts) {
    var append = Boolean(opts && opts.append);
    var r = await api.vitrine(selection(append ? { cursor: state.nextCursor } : null));
    state.feed = append ? state.feed.concat(r.posts || []) : (r.posts || []);
    state.nextCursor = r.nextCursor || null;
    return r;
  }

  // Changing the selection re-queries the vitrine AND its filters: the values
  // worth offering inside «Chanel» are not the ones worth offering across every
  // catalogue. Both are refreshed together so the row never advertises a filter
  // that yields nothing.
  async function refreshVitrine() {
    try {
      state.nextCursor = null;
      var r = await Promise.all([loadVitrine(), api.facets(selection())]);
      state.facets = r[1] || state.facets;
      repaintVitrine();
    } catch (e) { toast(e.message, 'error'); }
  }

  var searchTimer = null;

  async function loadMore() {
    if (!state.nextCursor || state.loadingMore) return;
    state.loadingMore = true;
    repaintVitrine();
    try {
      await loadVitrine({ append: true });
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      state.loadingMore = false;
      repaintVitrine();
    }
  }

  // «Синхронізувати». One request reads a few pages of the channel; the server
  // reports where it stopped and this keeps calling while there is more. That
  // structure exists because the app runs on a serverless host: a whole channel
  // is thousands of pages and a function has seconds, so the loop has to live on
  // this side. The admin sees each round land instead of watching a frozen button.
  async function runSync(key, deep) {
    if (state.admin.sync[key] && state.admin.sync[key].running) return;

    var totals = { added: 0, updated: 0, gone: 0, pages: 0 };
    state.admin.sync[key] = { running: true, note: 'читаю канал…', error: null };
    repaintAdmin();

    try {
      // A hard stop, so a mis-parsed cursor can never turn into an endless loop
      // hammering Telegram. 400 rounds is far more history than any catalogue has.
      for (var round = 0; round < 400; round += 1) {
        var r = await api.admin.syncChannel(key, { deep: deep, pages: 4 });
        totals.added += r.added;
        totals.updated += r.updated;
        totals.gone += r.gone;
        totals.pages += r.pages;

        state.admin.sync[key] = {
          running: !r.done,
          note: '+' + totals.added + ' нових · ' + totals.updated + ' оновлено' +
            (totals.gone ? ' · ' + totals.gone + ' знято' : '') +
            ' · ' + totals.pages + ' стор.' + (r.done ? '' : ' …'),
          error: null,
        };
        repaintAdmin();
        if (r.done) break;
      }
    } catch (e) {
      state.admin.sync[key] = { running: false, note: '', error: e.message };
      repaintAdmin();
      toast(e.message, 'error');
      return;
    }

    // The counts on the rows and the cards below them are both stale now.
    try {
      var fresh = await Promise.all([api.admin.channels(), api.admin.posts()]);
      state.admin.channels = fresh[0].channels || [];
      state.admin.posts = fresh[1].posts || [];
    } catch (e) { /* the sync itself succeeded; a stale count is not worth a toast */ }

    // The vitrine the client sees was just rewritten underneath it.
    state.catalogs = [];
    state.admin.sync[key].running = false;
    repaintAdmin();
    toast('Синхронізовано: +' + totals.added + ' нових, ' + totals.updated + ' оновлено' +
      (totals.gone ? ', ' + totals.gone + ' знято' : ''));
  }

  function repaintAdmin() {
    if (state.tab === 'admin') $app.innerHTML = renderAdmin();
  }

  async function loadPopular() {
    var r = await api.admin.popular({ period: state.admin.popularPeriod });
    state.admin.popular = r;
  }

  var VIEWS = {
    home: renderHome, catalog: renderCatalog, feed: renderFeed,
    cart: renderCart, admin: renderAdmin,
  };

  // The fitting-room counter lives in the nav, so it is visible from every tab.
  function paintCartBadge(count) {
    var badge = document.getElementById('cartBadge');
    if (!badge) return;
    state.cartCount = count;
    badge.textContent = String(count || 0);
    badge.hidden = !count;
  }

  async function go(tab, opts) {
    state.tab = tab;
    if (!(opts && opts.keepScroll)) window.scrollTo(0, 0);
    $app.innerHTML = '<div class="loader">Завантаження…</div>';
    try {
      await loadTab(tab);
      $app.innerHTML = VIEWS[tab]();
      revealCards();
    } catch (e) {
      $app.innerHTML = '<div class="empty">' + esc(e.message || 'Не вдалося завантажити') + '</div>';
    }
    var btns = $nav.querySelectorAll('.nav__btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('is-active', btns[i].getAttribute('data-tab') === tab);
    }
  }

  // Fire the birthday confetti once per painted card (one-shot, per the spec).
  function revealCards() {
    var cards = $app.querySelectorAll('.card--birthday:not(.is-revealed)');
    if (!cards.length) return;
    requestAnimationFrame(function () {
      for (var i = 0; i < cards.length; i++) cards[i].classList.add('is-revealed');
    });
  }

  /* ── events ─────────────────────────────────────────────────────────────── */

  $nav.addEventListener('click', function (e) {
    var btn = e.target.closest('.nav__btn');
    if (!btn) return;
    tg.haptic('light');
    go(btn.getAttribute('data-tab'));
  });

  document.addEventListener('click', async function (e) {
    var t = e.target;

    var copyBtn = t.closest('[data-copy]');
    if (copyBtn) {
      var code = copyBtn.getAttribute('data-copy');
      try { await tg.copy(code); toast('Промокод ' + code + ' скопійовано'); }
      catch (err) { toast('Не вдалося скопіювати', 'error'); }
      var card = copyBtn.closest('.card--birthday');
      if (card) card.classList.add('is-revealed');
      return;
    }

    var chip = t.closest('[data-channel]');
    if (chip) {
      state.feedChannel = chip.getAttribute('data-channel');
      // Tapping a catalogue is an explicit choice — it clears an active search.
      state.search = '';
      // …and the content filters, which belonged to the previous catalogue: a
      // brand carried over into a catalogue that has none leaves the client
      // staring at «нічого немає» with no idea why.
      state.filters = { brand: null, category: null };
      go('catalog');
      return;
    }

    var facet = t.closest('[data-facet]');
    if (facet) {
      var kind = facet.getAttribute('data-facet');
      var value = facet.getAttribute('data-value') || null;
      // Tapping the active value clears it, so a filter is never a trap.
      state.filters[kind] = state.filters[kind] === value ? null : value;
      tg.haptic('light');
      await refreshVitrine();
      return;
    }

    if (t.closest('[data-more]')) {
      await loadMore();
      return;
    }

    if (t.closest('[data-search-clear]')) {
      state.search = '';
      go('catalog');
      return;
    }

    var syncBtn = t.closest('[data-sync]');
    if (syncBtn) {
      tg.haptic('light');
      await runSync(syncBtn.getAttribute('data-sync'), false);
      return;
    }

    var syncDeep = t.closest('[data-sync-deep]');
    if (syncDeep) {
      tg.haptic('light');
      await runSync(syncDeep.getAttribute('data-sync-deep'), true);
      return;
    }

    var popPeriod = t.closest('[data-pop-period]');
    if (popPeriod) {
      state.admin.popularPeriod = popPeriod.getAttribute('data-pop-period');
      try {
        await loadPopular();
        $app.innerHTML = renderAdmin();
      } catch (err) { toast(err.message, 'error'); }
      return;
    }

    var inqStatus = t.closest('[data-inquiry-status]');
    if (inqStatus) {
      try {
        await api.admin.setInquiryStatus(
          Number(inqStatus.getAttribute('data-inquiry')),
          inqStatus.getAttribute('data-inquiry-status')
        );
        state.admin.inquiries = (await api.admin.inquiries()).inquiries || [];
        $app.innerHTML = renderAdmin();
        toast('Статус заявки оновлено');
      } catch (err) { toast(err.message, 'error'); }
      return;
    }

    // One tap adds the item and updates the counter — no page reload, because a
    // client browsing a catalogue must not lose their place.
    var add = t.closest('[data-add]');
    if (add) {
      add.disabled = true;
      try {
        var ares = await api.cart.add(Number(add.getAttribute('data-add')));
        add.textContent = 'У примірочній ✓';
        add.classList.remove('btn--primary');
        add.classList.add('btn--ghost', 'is-in');
        paintCartBadge(ares.count);
        toast(ares.added ? 'Додано в примірочну' : 'Вже у примірочній');
      } catch (err) {
        add.disabled = false;
        toast(err.status === 404 ? 'Спочатку приєднайтесь до клубу' : err.message, 'error');
      }
      return;
    }

    var remove = t.closest('[data-remove]');
    if (remove) {
      remove.disabled = true;
      try {
        var rres = await api.cart.remove(Number(remove.getAttribute('data-remove')));
        paintCartBadge(rres.count);
        await go('cart', { keepScroll: true });
      } catch (err) {
        remove.disabled = false;
        toast(err.message, 'error');
      }
      return;
    }

    var want = t.closest('[data-want]');
    if (want) {
      try {
        await api.interest(Number(want.getAttribute('data-want')), 'want');
        want.textContent = 'Записали ✓';
        want.disabled = true;
        toast('Ми звʼяжемося з вами щодо цього товару');
      } catch (err) { toast(err.message, 'error'); }
      return;
    }

    var adminTab = t.closest('[data-admin-tab]');
    if (adminTab) {
      var key = adminTab.getAttribute('data-admin-tab');
      state.admin.adminTab = key;
      $app.innerHTML = renderAdmin();
      // These two panels are fetched on demand rather than on every cabinet open.
      try {
        if (key === 'popular') { await loadPopular(); $app.innerHTML = renderAdmin(); }
        if (key === 'inquiries') {
          state.admin.inquiries = (await api.admin.inquiries()).inquiries || [];
          $app.innerHTML = renderAdmin();
        }
        if (key === 'content') {
          // Channels come from the admin endpoint, not from the client config:
          // only it carries the post counts and the sync state the rows show.
          var content = await Promise.all([api.admin.posts(), api.admin.channels()]);
          state.admin.posts = content[0].posts || [];
          state.admin.channels = content[1].channels || [];
          $app.innerHTML = renderAdmin();
        }
      } catch (err) { toast(err.message, 'error'); }
      return;
    }

    var ruleRow = t.closest('[data-rule]');
    if (ruleRow) { sheetRule(ruleRow.getAttribute('data-rule')); return; }

    var holidayRow = t.closest('[data-holiday]');
    if (holidayRow) { sheetHoliday(holidayRow.getAttribute('data-holiday')); return; }

    var postRow = t.closest('[data-post]');
    if (postRow) { sheetPost(postRow.getAttribute('data-post')); return; }

    var costRow = t.closest('[data-cost]');
    if (costRow) { sheetCost(costRow.getAttribute('data-cost')); return; }

    var cust = t.closest('[data-customer]');
    if (cust && !t.closest('[data-action]')) { sheetCustomer(cust.getAttribute('data-customer')); return; }

    var mat = t.closest('[data-materialize]');
    if (mat) {
      try {
        var r = await api.admin.materialize(Number(mat.getAttribute('data-materialize')));
        toast('Видано промокодів: ' + r.created + (r.alreadyExisted ? ' (вже мали: ' + r.alreadyExisted + ')' : ''));
      } catch (err) { toast(err.message, 'error'); }
      return;
    }

    var period = t.closest('[data-period]');
    if (period) {
      state.admin.reportPeriod = period.getAttribute('data-period');
      try {
        state.admin.report = await api.admin.report(state.admin.reportPeriod);
        $app.innerHTML = renderAdmin();
      } catch (err) { toast(err.message, 'error'); }
      return;
    }

    var action = t.closest('[data-action]');
    if (!action) return;
    var name = action.getAttribute('data-action');

    if (name === 'notifications') { sheetNotifications(); return; }
    if (name === 'new-post') { sheetNewPost(); return; }
    if (name === 'new-campaign') { sheetNewCampaign(); return; }
    if (name === 'new-holiday') { sheetNewHoliday(); return; }
    if (name === 'new-purchase') { sheetNewPurchase(action.getAttribute('data-customer')); return; }
    // Claiming with a date already on file: the server verifies it and either
    // grants once or refuses with a reason the client can read.
    if (name === 'claim-birthday') {
      action.disabled = true;
      try {
        var res = await api.claimBirthday();
        toast(res.message, res.ok ? 'ok' : 'error');
        await go('home');
      } catch (err) {
        toast(err.message, 'error');
        action.disabled = false;
      }
      return;
    }
    if (name === 'redeem') {
      try {
        await api.redeem();
        toast('Кешбек списано — менеджер врахує його у замовленні');
        go('home');
      } catch (err) { toast(err.message, 'error'); }
    }
  });

  // Dynamic search: 220 ms after the last keystroke, only the vitrine repaints.
  document.addEventListener('input', function (e) {
    if (e.target.id !== 'searchInput') return;
    state.search = e.target.value.trim();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(refreshVitrine, 220);
  });

  document.addEventListener('submit', async function (e) {
    var form = e.target;
    e.preventDefault();
    var data = Object.fromEntries(new FormData(form).entries());
    var submit = form.querySelector('button[type="submit"]');
    if (submit) submit.disabled = true;

    try {
      if (form.id === 'joinForm') {
        await api.register({
          name: data.name, phone: data.phone, address: data.address,
          birthday: data.birthday, consent: data.consent ? 1 : 0,
        });
        toast('Вітаємо у клубі!');
        await go('home');
      } else if (form.id === 'inquiryForm') {
        // The client presses one button; Dasha and Maryna both get the message.
        var ires = await api.cart.send(data.message);
        // The confirmation sheet says it all — a toast on top of it would just
        // cover the text.
        tg.haptic('success');
        paintCartBadge(0);
        openSheet('Готово 💛',
          '<div class="stack">' +
            '<div class="panel"><p class="panel__note">' + esc(support().name) +
              ' звʼяжеться з вами дуже скоро — ваш запит уже видно' +
              (ires.promo ? ' і вашу знижку ' + esc(ires.promo.label) : '') + '.</p></div>' +
            '<button class="btn btn--primary" type="button" data-close>Зрозуміло</button>' +
          '</div>');
        await go('cart', { keepScroll: true });
      } else if (form.id === 'birthdayForm') {
        // First claim: the date is recorded now and checked on every later one.
        var bres = await api.claimBirthday(data.birthday);
        toast(bres.message, bres.ok ? 'ok' : 'error');
        await go('home');
      } else if (form.id === 'ruleForm') {
        await api.admin.updateRule(form.getAttribute('data-key'), {
          mode: data.mode,
          value: Number(data.value),
          minOrderUsd: Number(data.minOrderUsd || 0),
          capUsd: data.capUsd === undefined || data.capUsd === '' ? null : Number(data.capUsd),
          validDays: data.validDays === undefined || data.validDays === '' ? null : Number(data.validDays),
          enabled: Boolean(data.enabled),
        });
        closeSheet();
        toast('Правило збережено');
        await go('admin');
      } else if (form.id === 'holidayForm') {
        await api.admin.updateHoliday(Number(form.getAttribute('data-id')), {
          mode: data.mode, value: Number(data.value),
          minOrderUsd: Number(data.minOrderUsd || 0),
          month: Number(data.month), day: Number(data.day),
          validDays: Number(data.validDays || 14),
          enabled: Boolean(data.enabled),
        });
        closeSheet();
        toast('Свято збережено');
        await go('admin');
      } else if (form.id === 'newHolidayForm') {
        await api.admin.createHoliday({
          name: data.name, emoji: data.emoji || '🎉',
          month: Number(data.month), day: Number(data.day),
          mode: data.mode, value: Number(data.value),
          minOrderUsd: Number(data.minOrderUsd || 0),
          validDays: Number(data.validDays || 14),
        });
        closeSheet();
        toast('Свято додано');
        await go('admin');
      } else if (form.id === 'postEditForm') {
        await api.admin.updatePost(Number(form.getAttribute('data-id')), {
          title: data.title,
          brand: data.brand || null,
          category: data.category || null,
          article: data.article || null,
          price: data.price === '' ? null : Number(data.price),
          status: data.hidden ? 'hidden' : 'published',
        });
        closeSheet();
        toast('Картку оновлено');
        state.admin.posts = (await api.admin.posts()).posts || [];
        $app.innerHTML = renderAdmin();
      } else if (form.id === 'costForm') {
        await api.admin.setCost(Number(form.getAttribute('data-id')), {
          costUsd: Number(data.costUsd), note: data.note || null,
        });
        closeSheet();
        toast('Собівартість збережена — прибуток перерахований');
        state.admin.adminTab = 'profit';
        await go('admin');
      } else if (form.id === 'bdayFixForm') {
        await api.admin.setBirthday(Number(form.getAttribute('data-customer')), data.birthday);
        closeSheet();
        toast('Дату народження оновлено');
        await go('admin');
      } else if (form.id === 'postForm') {
        var r = await api.admin.publishPost({
          channel: data.channel, title: data.title, body: data.body,
          price: data.price ? Number(data.price) : null, currency: data.currency,
        });
        closeSheet();
        toast(r.live ? 'Опубліковано в каналі' : 'Опубліковано (демо-режим)');
        state.feedChannel = data.channel;
        await go('feed');
      } else if (form.id === 'campaignForm') {
        var payload = {
          name: data.name, type: data.type, percent: Number(data.percent),
          windowDays: Number(data.windowDays || 0),
          promoValidDays: Number(data.promoValidDays || 14),
          recurring: Boolean(data.recurring),
        };
        if (data.startsAt) payload.startsAt = new Date(data.startsAt).toISOString();
        if (data.endsAt) payload.endsAt = new Date(data.endsAt).toISOString();
        if (data.tier) payload.audience = { tier: data.tier };
        await api.admin.createCampaign(payload);
        closeSheet();
        toast('Правило створено');
        await go('admin');
      } else if (form.id === 'purchaseForm') {
        var pres = await api.admin.addPurchase({
          customerId: Number(data.customerId), title: data.title,
          amount: Number(data.amount), currency: data.currency, channel: data.channel,
          costUsd: data.costUsd === '' ? null : Number(data.costUsd),
          discountUsd: data.discountUsd === '' ? 0 : Number(data.discountUsd),
        });
        closeSheet();
        toast(pres.costMissing
          ? 'Покупку додано. Собівартість не введена — нагадаємо завтра'
          : 'Покупку додано — бонус і прибуток перерахований');
        await go('admin');
      } else if (form.id === 'promoForm') {
        var res = await api.admin.grantPromo({
          customerId: Number(form.getAttribute('data-customer')),
          mode: data.mode, value: Number(data.value),
          minOrderUsd: Number(data.minOrderUsd || 0),
          days: Number(data.days), reason: data.reason,
        });
        closeSheet();
        toast('Промокод ' + res.code + ' видано');
      }
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      if (submit) submit.disabled = false;
    }
  });

  /* ── boot ───────────────────────────────────────────────────────────────── */

  async function boot() {
    tg.ready();
    try {
      state.config = await api.config();
    } catch (e) {
      $app.innerHTML = '<div class="empty">Сервер недоступний. Спробуйте пізніше.</div>';
      return;
    }

    state.me = await api.me();

    // Demo profile switcher — only outside Telegram, and only while the server
    // reports open-demo mode.
    if (tg.isDemo && state.config.demo) {
      try {
        var p = await api.demoProfiles();
        $demoUser.innerHTML = p.profiles.map(function (x) {
          return '<option value="' + esc(x.tgId) + '"' + (x.tgId === tg.userId ? ' selected' : '') +
            '>' + esc(x.name) + '</option>';
        }).join('');
        $demobar.hidden = false;
        $demoUser.addEventListener('change', function () {
          tg.setUserId($demoUser.value);
          go(state.tab);
        });
      } catch (e) { /* switcher is a convenience, not a requirement */ }
    }

    // The admin tab is shown when the server says this caller is an admin.
    if (state.me.admin) {
      var adminBtn = $nav.querySelector('.nav__btn--admin');
      if (adminBtn) adminBtn.hidden = false;
    }

    $nav.hidden = false;
    paintCartBadge(state.me.cartCount || 0);
    // Catalogues first: browsing pictures is what the client came for, and the
    // discounts tab is one tap away.
    await go(state.me.registered ? 'catalog' : 'home');
  }

  boot();
})();
