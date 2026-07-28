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
    tab: 'home',
    feedChannel: 'all',
    discounts: { promos: [], publicCampaigns: [] },
    purchases: { purchases: [], promos: [], loyalty: null },
    feed: [],
    notifications: { notifications: [], unread: 0 },
    admin: { customers: [], campaigns: [], report: null, reportPeriod: 'day' },
  };

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
      '<div class="card__percent">' +
        '<span class="card__percent-num">' + esc(d.percent) + '</span>' +
        '<span class="card__percent-sign">%</span>' +
      '</div>' +
      '<p class="card__title">' + esc(d.title || d.campaignName || 'Знижка') + '</p>' +
      '<p class="card__desc">' + esc(d.code ? 'Персональний промокод — діє на всі товари клубу' : 'Діє для всіх учасників клубу') + '</p>' +
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

  function ringHtml(l) {
    var caption = l.nextTier ? ('до ' + l.nextTier.name) : 'максимальний рівень';
    return '<div class="loyalty-ring" style="--w2b-ring-pct: ' + (l.progressPct || 0) + '%">' +
      '<div class="loyalty-ring__hole">' +
        '<span class="loyalty-ring__value">' + (l.progressPct || 0) + '%</span>' +
        '<span class="loyalty-ring__caption">' + esc(caption) + '</span>' +
      '</div>' +
    '</div>';
  }

  function tierBadge(l) {
    return '<span class="badge badge--' + esc(l.tier) + '">' + esc(l.tierName) + '</span>';
  }

  function milestonesHtml(l) {
    var reached = (l.milestones || []).map(function (m) {
      // The ✓ glyph comes from .milestone--reached::before — don't double it.
      return '<span class="milestone milestone--reached">' + usd(m.thresholdUsd) + '</span>';
    });
    if (l.nextMilestone) {
      reached.push('<span class="milestone">' + usd(l.nextMilestone.thresholdUsd) + '</span>');
    }
    return '<div class="milestone-row">' + reached.join('') + '</div>';
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
    var sub = c && c.loyalty
      ? c.loyalty.tierName + ' · ' + usd(c.loyalty.totalSpent) + ' покупок'
      : 'Гість';
    var unread = state.notifications.unread;
    return '<header class="topbar">' +
      '<div class="topbar__avatar">' + esc(initials) + '</div>' +
      '<div class="topbar__meta">' +
        '<div class="topbar__name">' + esc(c ? c.name : 'Вітаємо у Way2Buy') + '</div>' +
        '<div class="topbar__sub">' + esc(sub) + '</div>' +
      '</div>' +
      '<div class="topbar__aside">' +
        (c && c.loyalty ? tierBadge(c.loyalty) : '') +
        '<button class="bell" type="button" data-action="notifications" aria-label="Повідомлення">🔔' +
          '<span class="notif-badge" data-count="' + unread + '"' + (unread ? '' : ' hidden') + '>' + unread + '</span>' +
        '</button>' +
      '</div>' +
    '</header>';
  }

  function renderHome() {
    if (!state.me.registered) return renderJoin();

    var l = state.me.customer.loyalty;
    var cards = state.discounts.promos.concat(state.discounts.publicCampaigns);

    var html = topbarHtml() + '<div class="stack">';

    // wallet
    html += '<section class="wallet">' + ringHtml(l) +
      '<div class="wallet__body">' +
        '<div class="wallet__amount">' + usd(l.cashbackAvailable) + '</div>' +
        '<div class="wallet__caption">кешбек доступний до списання</div>' +
        '<div class="wallet__hint">Ще ' + usd(l.toNextReward) + ' покупок — і ми нарахуємо ' +
          usd(l.reward) + '. Правило: ' + usd(l.step) + ' → ' + usd(l.reward) + '.</div>' +
        (l.cashbackAvailable > 0
          ? '<div class="wallet__actions"><button class="btn btn--primary" data-action="redeem">Списати ' + usd(l.cashbackAvailable) + '</button></div>'
          : '') +
      '</div>' +
    '</section>';

    // stats
    html += '<section class="stats">' +
      '<div class="stat"><div class="stat__value">' + usd(l.totalSpent) + '</div><div class="stat__label">разом</div></div>' +
      '<div class="stat"><div class="stat__value">' + l.purchases + '</div><div class="stat__label">покупок</div></div>' +
      '<div class="stat"><div class="stat__value">' + (l.streak && l.streak.months ? l.streak.months + ' міс' : '—') + '</div><div class="stat__label">серія</div></div>' +
    '</section>';

    // discount cards
    html += '<div class="section-title">Ваші знижки</div>';
    html += cards.length
      ? cards.map(cardHtml).join('')
      : '<div class="empty">Поки що немає активних знижок. Вони зʼявляються на день народження, у свята та за статусом клубу.</div>';

    // gamification
    html += '<div class="section-title">Прогрес</div>' + milestonesHtml(l) + badgesHtml(l);
    html += '<div class="panel"><div class="panel__note">' + esc(l.tierPerk) +
      (l.nextTier ? ' · до ' + esc(l.nextTier.name) + ' — ' + usd(l.nextTier.toGo) : '') + '</div></div>';

    html += '</div>';
    return html;
  }

  function renderJoin() {
    return topbarHtml() +
      '<div class="stack">' +
        '<div class="panel">' +
          '<div class="panel__title">Клуб Way2Buy</div>' +
          '<p class="panel__note">Кешбек ' + usd(state.config.cashback.reward) + ' за кожні ' +
            usd(state.config.cashback.step) + ' покупок, знижка на день народження, персональні промокоди ' +
            'та стрічка обох каналів в одному місці.</p>' +
        '</div>' +
        '<form class="stack" id="joinForm">' +
          '<label class="field"><span class="field__label">Імʼя та прізвище</span>' +
            '<input class="field__input" name="name" required placeholder="Олена Ковальчук" /></label>' +
          '<div class="form-grid">' +
            '<label class="field"><span class="field__label">Телефон</span>' +
              '<input class="field__input" name="phone" placeholder="+380…" /></label>' +
            '<label class="field"><span class="field__label">День народження</span>' +
              '<input class="field__input" name="birthday" type="date" /></label>' +
          '</div>' +
          '<div class="form-grid">' +
            '<label class="field"><span class="field__label">Місто</span>' +
              '<input class="field__input" name="city" placeholder="Київ" /></label>' +
            '<label class="field"><span class="field__label">E-mail</span>' +
              '<input class="field__input" name="email" type="email" placeholder="you@mail.com" /></label>' +
          '</div>' +
          '<label class="inline"><input type="checkbox" name="consent" checked /> ' +
            '<span class="muted">Погоджуюсь отримувати повідомлення про знижки</span></label>' +
          '<button class="btn btn--primary" type="submit">Приєднатися до клубу</button>' +
        '</form>' +
      '</div>';
  }

  function renderFeed() {
    var chips = [{ key: 'all', title: 'Все', flag: '✨' }].concat(state.config.channels);
    var html = topbarHtml() + '<div class="stack">' +
      '<div class="chips">' + chips.map(function (c) {
        return '<button class="chip' + (state.feedChannel === c.key ? ' is-active' : '') +
          '" data-channel="' + esc(c.key) + '">' + esc(c.flag || '') + ' ' + esc(c.title) + '</button>';
      }).join('') + '</div>';

    if (!state.feed.length) {
      html += '<div class="empty">У цьому каналі ще немає публікацій.</div>';
    } else {
      html += state.feed.map(function (p) {
        var ch = p.channelMeta || {};
        return '<article class="post">' +
          '<div class="post__thumb">' + esc(p.image_url || '🛍️') + '</div>' +
          '<div class="post__body">' +
            '<div class="post__head">' + esc(ch.flag || '') + ' ' + esc(ch.title || p.channel) +
              ' · ' + esc(timeAgo(p.created_at)) + '</div>' +
            '<div class="post__title">' + esc(p.title) + '</div>' +
            (p.body ? '<p class="post__text">' + esc(p.body) + '</p>' : '') +
            '<div class="post__foot">' +
              '<span class="post__price">' + esc(money(p.price, p.currency)) + '</span>' +
              '<span class="inline">' +
                '<span class="post__src">' + (p.source === 'channel' ? 'з каналу' : 'з застосунку') + '</span>' +
                '<button class="btn btn--ghost" data-want="' + p.id + '">Хочу</button>' +
              '</span>' +
            '</div>' +
          '</div>' +
        '</article>';
      }).join('');
    }
    return html + '</div>';
  }

  function renderHistory() {
    if (!state.me.registered) return renderJoin();
    var p = state.purchases;
    var html = topbarHtml() + '<div class="stack">';

    html += '<div class="section-title">Промокоди</div>';
    html += p.promos.length
      ? p.promos.map(function (pr) {
          return '<div class="row">' +
            '<div class="row__icon">🎟️</div>' +
            '<div class="row__body">' +
              '<div class="row__title">' + esc(pr.code) + ' · −' + pr.percent + '%</div>' +
              '<div class="row__sub">' + esc(pr.reason || '') +
                (pr.expires_at ? ' · до ' + esc(dateShort(pr.expires_at)) : '') + '</div>' +
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
                (x.invoice_ref ? ' · ' + esc(x.invoice_ref) : '') + '</div>' +
            '</div>' +
            '<div class="row__amount">' + esc(money(x.orig_amount || x.amount_usd, x.orig_currency)) +
              '<span>' + usd(x.amount_usd) + '</span></div>' +
          '</div>';
        }).join('')
      : '<div class="empty">Покупок ще не було.</div>';

    if (p.loyalty && p.loyalty.cashbackRedeemed > 0) {
      html += '<div class="panel"><div class="panel__note">Списано кешбеку: ' +
        usd(p.loyalty.cashbackRedeemed) + ' · нараховано: ' + usd(p.loyalty.cashbackEarned) + '</div></div>';
    }
    return html + '</div>';
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
        '<button class="btn btn--ghost" data-action="new-campaign">Нова знижка</button>' +
        '<button class="btn btn--ghost" data-action="new-purchase">Додати покупку</button>' +
      '</div></div>';

    // campaigns
    html += '<div class="section-title">Правила знижок</div>';
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
      : '<div class="empty">Правил ще немає — створіть перше.</div>';

    // customers
    html += '<div class="section-title">Клієнти (' + a.customers.length + ')</div>';
    html += a.customers.map(function (c) {
      var l = c.loyalty || {};
      return '<div class="row row--tap" data-customer="' + c.id + '">' +
        '<div class="row__icon">' + esc((c.name || '?')[0]) + '</div>' +
        '<div class="row__body">' +
          '<div class="row__title">' + esc(c.name) + '</div>' +
          '<div class="row__sub">' + esc(l.tierName || '') + ' · ' + (l.purchases || 0) + ' покупок' +
            (c.birthday ? ' · ДН ' + esc(c.birthday.slice(5)) : '') + '</div>' +
        '</div>' +
        '<div class="row__amount">' + usd(l.totalSpent || 0) +
          '<span>кешбек ' + usd(l.cashbackAvailable || 0) + '</span></div>' +
      '</div>';
    }).join('');

    // AI report
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
        '<p class="field__hint">Сума перераховується в USD — кешбек рахується від неї.</p>' +
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
          (c.email ? '✉️ ' + esc(c.email) + '<br/>' : '') +
          (c.birthday ? '🎂 ' + esc(c.birthday) + '<br/>' : '') +
          (c.city ? '📍 ' + esc(c.city) : '') +
        '</div></div>' +
        '<section class="stats">' +
          '<div class="stat"><div class="stat__value">' + usd(l.totalSpent || 0) + '</div><div class="stat__label">разом</div></div>' +
          '<div class="stat"><div class="stat__value">' + (l.purchases || 0) + '</div><div class="stat__label">покупок</div></div>' +
          '<div class="stat"><div class="stat__value">' + usd(l.cashbackAvailable || 0) + '</div><div class="stat__label">кешбек</div></div>' +
        '</section>' +
        '<form class="stack" id="promoForm" data-customer="' + c.id + '">' +
          '<div class="form-grid">' +
            '<label class="field"><span class="field__label">Промокод, %</span>' +
              '<input class="field__input" name="percent" type="number" min="1" max="90" value="15" /></label>' +
            '<label class="field"><span class="field__label">Діє, днів</span>' +
              '<input class="field__input" name="days" type="number" min="1" max="365" value="14" /></label>' +
          '</div>' +
          '<label class="field"><span class="field__label">Причина</span>' +
            '<input class="field__input" name="reason" placeholder="Персональна знижка" /></label>' +
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
      var r = await Promise.all([api.me(), api.discounts(), api.notifications()]);
      state.me = r[0];
      state.discounts = r[1];
      state.notifications = r[2];
    } else if (tab === 'feed') {
      var f = await api.feed(state.feedChannel);
      state.feed = f.posts || [];
    } else if (tab === 'history') {
      state.purchases = await api.purchases();
    } else if (tab === 'admin') {
      var a = await Promise.all([api.admin.customers(), api.admin.campaigns()]);
      state.admin.customers = a[0].customers || [];
      state.admin.campaigns = a[1].campaigns || [];
    }
  }

  var VIEWS = { home: renderHome, feed: renderFeed, history: renderHistory, admin: renderAdmin };

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
      go('feed');
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
    if (name === 'new-purchase') { sheetNewPurchase(action.getAttribute('data-customer')); return; }
    if (name === 'redeem') {
      try {
        await api.redeem();
        toast('Кешбек списано — менеджер врахує його у замовленні');
        go('home');
      } catch (err) { toast(err.message, 'error'); }
    }
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
          name: data.name, phone: data.phone, email: data.email,
          birthday: data.birthday, city: data.city, consent: data.consent ? 1 : 0,
        });
        toast('Вітаємо у клубі!');
        await go('home');
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
        await api.admin.addPurchase({
          customerId: Number(data.customerId), title: data.title,
          amount: Number(data.amount), currency: data.currency, channel: data.channel,
        });
        closeSheet();
        toast('Покупку додано — кешбек перерахований');
        await go('admin');
      } else if (form.id === 'promoForm') {
        var res = await api.admin.grantPromo({
          customerId: Number(form.getAttribute('data-customer')),
          percent: Number(data.percent), days: Number(data.days), reason: data.reason,
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
    await go('home');
  }

  boot();
})();
