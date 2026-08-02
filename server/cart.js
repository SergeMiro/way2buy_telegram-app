// ─────────────────────────────────────────────────────────────────────────
//  cart.js — the fitting room ("примірочна"), the inquiry to Dasha, and the
//  popularity statistics behind both.
//
//  Maryna, 31.07.2026:
//    "ползая по каталогам добавлять их в примерочную … перейдя в неё формируют
//     сообщение Даше и в него могут сами дописать ещё что хотят и нажать
//     отправить. И получат ответ что Даша с вами свяжется очень скоро. Но в
//     реальности сообщение получает так же Марина: клиент А интересуется
//     товаром Б и задал вопрос администратору Даше: «текст клиента»."
//    "Все попадания в корзину надо отслеживать в таблице с целью статистики
//     какие товары пользуются большей популярностью."
//
//  Design decisions that follow from the audience (low digital literacy):
//   • Adding is idempotent — a second tap on «Хочу» is not an error and not a
//     duplicate; it just stays in the fitting room.
//   • Sending needs no typing: the message is pre-built from the items and the
//     client's own text is optional.
//   • The best active promo code is attached automatically, so "applying a
//     coupon" is not a step the client has to understand.
//
//  Statistics are computed only from `cart_events`, an append-only journal with
//  a snapshot of each item, so a post edited or deleted in the channel never
//  rewrites history. Every read takes an explicit period, which is what makes
//  monthly and yearly views the same query.
// ─────────────────────────────────────────────────────────────────────────
import { db } from './db.js';
import { notifyCustomer, notifyAdmins, adminIds } from './notify.js';
import { sendToUser } from './telegram.js';

const iso = (ms) => new Date(ms).toISOString();
const round2 = (n) => Math.round(n * 100) / 100;

// Dasha is support, Maryna is the owner: the inquiry goes to BOTH, which is
// exactly what Maryna asked for. Falls back to the admin list when no separate
// support id is configured, so nothing is silently lost.
export const supportIds = () =>
  (process.env.SUPPORT_TG_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);

const FX = { USD: 1, EUR: 1.08, UAH: 1 / 41 };
const toUsd = (amount, currency) =>
  amount == null ? null : round2(Number(amount) * (FX[currency] ?? 1));

// ── the fitting room ──────────────────────────────────────────────────────

// The stored `channel` is a slug ('clothes'); nobody outside the code should
// ever see it. The human title is looked up, with the slug as a last resort in
// case the channel row was removed.
const channelTitle = (key) => {
  if (!key) return null;
  const row = db.prepare('SELECT title FROM channels WHERE key=?').get(key);
  return row?.title || key;
};

export function shapeItem(r) {
  return {
    id: r.id,
    postId: r.post_id,
    title: r.title,
    article: r.article,
    channel: channelTitle(r.channel),
    channelKey: r.channel,
    price: r.price,
    currency: r.currency,
    // A Telegram file_id is served through the photo proxy; an emoji is shown
    // as-is. The client never sees a bot token.
    photo: r.photo && r.photo.length > 8 ? `/api/photo/${encodeURIComponent(r.photo)}` : null,
    emoji: r.photo && r.photo.length <= 8 ? r.photo : '🛍️',
    createdAt: r.created_at,
  };
}

export function listCart(customerId) {
  const rows = db.prepare(
    "SELECT * FROM cart_items WHERE customer_id=? AND status='active' ORDER BY created_at DESC"
  ).all(customerId);
  return rows.map(shapeItem);
}

export function cartCount(customerId) {
  return db.prepare("SELECT COUNT(*) c FROM cart_items WHERE customer_id=? AND status='active'")
    .get(customerId).c;
}

function logEvent({ customerId, postId, action, title, article, channel, priceUsd = null, inquiryId = null, now }) {
  const at = iso(now);
  db.prepare(`INSERT INTO cart_events
    (customer_id,post_id,action,title,article,channel,price_usd,inquiry_id,created_at,ym,y)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(customerId, postId, action, title, article, channel, priceUsd, inquiryId,
      at, at.slice(0, 7), at.slice(0, 4));
}

// Add a post to the fitting room. Returns { ok, added, item, count } — a repeat
// tap reports added:false rather than failing, because the client will tap twice.
export function addToCart({ customerId, postId, note = null, now = Date.now() }) {
  const post = db.prepare('SELECT * FROM posts WHERE id=?').get(postId);
  if (!post) return { ok: false, error: 'post_not_found' };

  const existing = db.prepare(
    "SELECT * FROM cart_items WHERE customer_id=? AND post_id=? AND status='active'"
  ).get(customerId, postId);
  if (existing) {
    return { ok: true, added: false, item: shapeItem(existing), count: cartCount(customerId) };
  }

  // Photos: first file_id if the post carries them, else the emoji placeholder.
  let photo = post.image_url || '🛍️';
  try {
    const photos = post.photos_json ? JSON.parse(post.photos_json) : null;
    if (Array.isArray(photos) && photos.length) photo = photos[0];
  } catch { /* keep the fallback */ }

  const info = db.prepare(`INSERT INTO cart_items
    (customer_id,post_id,title,article,channel,photo,price,currency,note,status,created_at)
    VALUES (?,?,?,?,?,?,?,?,?, 'active',?)`)
    .run(customerId, postId, post.title, post.article, post.channel, photo,
      post.price, post.currency, note, iso(now));

  logEvent({
    customerId, postId, action: 'added',
    title: post.title, article: post.article, channel: post.channel,
    priceUsd: toUsd(post.price, post.currency), now,
  });

  const row = db.prepare('SELECT * FROM cart_items WHERE id=?').get(info.lastInsertRowid);
  return { ok: true, added: true, item: shapeItem(row), count: cartCount(customerId) };
}

export function removeFromCart({ customerId, itemId, now = Date.now() }) {
  const row = db.prepare("SELECT * FROM cart_items WHERE id=? AND customer_id=? AND status='active'")
    .get(itemId, customerId);
  if (!row) return { ok: false, error: 'not_found' };

  db.prepare('DELETE FROM cart_items WHERE id=?').run(itemId);
  // The journal keeps the add AND the removal, so "added but dropped" is
  // measurable — that is a signal about the item, not noise.
  logEvent({
    customerId, postId: row.post_id, action: 'removed',
    title: row.title, article: row.article, channel: row.channel,
    priceUsd: toUsd(row.price, row.currency), now,
  });
  return { ok: true, count: cartCount(customerId) };
}

// ── the coupon that applies itself ────────────────────────────────────────

// The best promo code the client can use right now, so the UI can show one
// pre-applied line instead of asking them to choose. "Best" = the largest
// discount on the current basket; a percentage is resolved against the basket
// total, a fixed amount is taken as-is.
export function bestPromo(customerId, basketUsd = 0, now = Date.now()) {
  const rows = db.prepare(
    `SELECT * FROM promo_codes
      WHERE customer_id=? AND status='active'
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY created_at DESC LIMIT 50`
  ).all(customerId, iso(now));

  let best = null;
  for (const p of rows) {
    const mode = p.mode || 'percent';
    const min = Number(p.min_order_usd || 0);
    // A promo below its minimum order is still shown, but as "not yet usable" —
    // the client needs to know why $50 is not being applied.
    const usable = basketUsd >= min && basketUsd > 0;
    const value = mode === 'fixed' ? Number(p.amount_usd || 0) : Number(p.percent || 0);
    const amountUsd = mode === 'fixed'
      ? Math.min(value, basketUsd || value)
      : round2((basketUsd * value) / 100);
    const candidate = {
      id: p.id,
      code: p.code,
      mode,
      value,
      label: mode === 'fixed' ? `$${value}` : `${value}%`,
      minOrderUsd: min,
      usable,
      amountUsd: round2(amountUsd),
      reason: p.reason,
      expiresAt: p.expires_at,
    };
    if (!best) { best = candidate; continue; }
    // Usable beats unusable; among equals, the bigger discount wins.
    if (candidate.usable !== best.usable) { if (candidate.usable) best = candidate; continue; }
    if (candidate.amountUsd > best.amountUsd) best = candidate;
  }
  return best;
}

export function basketTotalUsd(items) {
  let sum = 0;
  let known = 0;
  for (const it of items) {
    const v = toUsd(it.price, it.currency);
    if (v != null && v > 0) { sum += v; known += 1; }
  }
  // Catalogue posts usually carry no price (Maryna quotes it personally), so a
  // basket total is a hint, never a promise.
  return { totalUsd: round2(sum), pricedItems: known, allPriced: known === items.length && items.length > 0 };
}

// What the fitting-room screen needs in one call.
export function cartView(customerId, now = Date.now()) {
  const items = listCart(customerId);
  const raw = db.prepare("SELECT price, currency FROM cart_items WHERE customer_id=? AND status='active'").all(customerId);
  const basket = basketTotalUsd(raw);
  return {
    items,
    count: items.length,
    basket,
    promo: bestPromo(customerId, basket.totalUsd, now),
    // The pre-built message: the client only has to press send.
    draft: draftMessage(items),
  };
}

function draftMessage(items) {
  if (!items.length) return '';
  const lines = items.map((i, n) =>
    `${n + 1}. ${i.title || 'Позиція'}${i.article ? ` (арт. ${i.article})` : ''}`);
  return `Доброго дня! Мене цікавить:\n${lines.join('\n')}\nПідкажіть, будь ласка, ціну та наявність.`;
}

// ── sending the inquiry ───────────────────────────────────────────────────

const shortName = (c) => (c.name || `#${c.id}`).trim();

function itemLine(i) {
  return `• ${i.title || 'Позиція'}${i.article ? ` · арт. ${i.article}` : ''}` +
    `${i.channel ? ` · ${i.channel}` : ''}`;
}

// Send the fitting room as one inquiry. Returns { ok, inquiryId, message } and
// never throws for business reasons.
export function sendInquiry({ customer, message = '', now = Date.now() }) {
  const items = listCart(customer.id);
  if (!items.length) return { ok: false, error: 'empty_cart', message: 'Примірочна порожня.' };

  const raw = db.prepare("SELECT price, currency FROM cart_items WHERE customer_id=? AND status='active'").all(customer.id);
  const basket = basketTotalUsd(raw);
  const promo = bestPromo(customer.id, basket.totalUsd, now);
  const clientText = String(message || '').trim().slice(0, 2000);

  const info = db.prepare(`INSERT INTO inquiries
    (customer_id,message,items_json,items_count,promo_code_id,promo_label,status,created_at)
    VALUES (?,?,?,?,?,?, 'new',?)`)
    .run(customer.id, clientText || null, JSON.stringify(items), items.length,
      promo && promo.usable ? promo.id : null,
      // The label is recorded whenever a coupon exists; whether it was already
      // applicable is the promo_code_id.
      promo ? (promo.usable ? promo.label : `${promo.label} (від $${promo.minOrderUsd})`) : null,
      iso(now));
  const inquiryId = Number(info.lastInsertRowid);

  // The items leave the fitting room but stay attached to the inquiry.
  db.prepare("UPDATE cart_items SET status='sent', inquiry_id=?, sent_at=? WHERE customer_id=? AND status='active'")
    .run(inquiryId, iso(now), customer.id);
  for (const i of items) {
    logEvent({
      customerId: customer.id, postId: i.postId, action: 'sent',
      title: i.title, article: i.article, channel: i.channel,
      priceUsd: null, inquiryId, now,
    });
  }

  // ── exactly the wording Maryna asked for ──
  const title = `🛍️ Клієнт ${shortName(customer)} цікавиться товаром`;
  const body =
    `Клієнт ${shortName(customer)} цікавиться товаром:\n${items.map(itemLine).join('\n')}\n` +
    (clientText
      ? `\nі задав питання адміністратору Даші:\n«${clientText}»`
      : '\nПитання не додав — просить ціну та наявність.') +
    // The coupon is stated either way: an unusable one still matters, because
    // Maryna is the person who sets the price the minimum is measured against.
    (promo
      ? promo.usable
        ? `\n\nЗнижка клієнта: ${promo.label} (${promo.code}) — застосована`
        : `\n\nЗнижка клієнта: ${promo.label} (${promo.code})` +
          (promo.minOrderUsd ? ` — діє від замовлення $${promo.minOrderUsd}, врахуйте при розрахунку` : '')
      : '') +
    (customer.phone ? `\n\n📞 ${customer.phone}` : '') +
    (customer.tg_user_id ? `\nTG id ${customer.tg_user_id}` : '');

  // Maryna (admins) get it in the admin alert feed + DM.
  notifyAdmins({ kind: 'inquiry', title, body, dedupeKey: `inquiry:${inquiryId}` });
  // Dasha gets the same text as a DM. Separate ids so support can be someone
  // who is not an admin of the panel.
  const dashaIds = supportIds().filter((id) => !adminIds().includes(id));
  for (const id of dashaIds) {
    void Promise.resolve(sendToUser(id, `<b>${escapeHtml(title)}</b>\n${escapeHtml(body)}`)).catch(() => {});
  }

  // The client's own confirmation, in their language, with no jargon.
  notifyCustomer({
    customerId: customer.id,
    kind: 'inquiry_sent',
    title: 'Заявку надіслано ✅',
    body: `Даша звʼяжеться з вами дуже скоро щодо ${items.length === 1 ? 'позиції' : items.length + ' позицій'}.`,
    dedupeKey: `inquiry-ack:${inquiryId}`,
  });

  return {
    ok: true,
    inquiryId,
    items: items.length,
    promo: promo && promo.usable ? { code: promo.code, label: promo.label } : null,
    message: 'Даша звʼяжеться з вами дуже скоро 💛',
  };
}

function escapeHtml(s = '') {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── admin reads ───────────────────────────────────────────────────────────

export function listInquiries({ status = null, limit = 50 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const rows = status
    ? db.prepare(
        `SELECT i.*, c.name, c.tg_user_id, c.phone FROM inquiries i
           JOIN customers c ON c.id = i.customer_id
          WHERE i.status=? ORDER BY i.created_at DESC LIMIT ?`
      ).all(status, lim)
    : db.prepare(
        `SELECT i.*, c.name, c.tg_user_id, c.phone FROM inquiries i
           JOIN customers c ON c.id = i.customer_id
          ORDER BY i.created_at DESC LIMIT ?`
      ).all(lim);

  return rows.map((r) => ({
    id: r.id,
    customerId: r.customer_id,
    customerName: r.name,
    tgId: r.tg_user_id,
    phone: r.phone,
    message: r.message,
    items: safeJson(r.items_json) || [],
    itemsCount: r.items_count,
    promoLabel: r.promo_label,
    status: r.status,
    createdAt: r.created_at,
    answeredAt: r.answered_at,
  }));
}

export function setInquiryStatus(id, { status, by = null, now = Date.now() }) {
  const allowed = ['new', 'answered', 'closed'];
  if (!allowed.includes(status)) throw new Error(`status must be one of ${allowed.join('|')}`);
  const info = db.prepare('UPDATE inquiries SET status=?, answered_by=?, answered_at=? WHERE id=?')
    .run(status, by, status === 'new' ? null : iso(now), id);
  return info.changes > 0;
}

// ── popularity ────────────────────────────────────────────────────────────

// Period resolution: 'month' → the calendar month containing `now`; 'year' →
// the calendar year; 'all' → everything. `from`/`to` (YYYY-MM-DD) override.
export function resolvePeriod({ period = 'month', from = null, to = null, now = Date.now() } = {}) {
  if (from || to) {
    return { kind: 'custom', from: from || '0000-01-01', to: to || '9999-12-31', label: `${from || '…'} → ${to || '…'}` };
  }
  const d = new Date(now);
  const y = d.getUTCFullYear();
  if (period === 'all') return { kind: 'all', from: '0000-01-01', to: '9999-12-31', label: 'за весь час' };
  if (period === 'year') {
    return { kind: 'year', from: `${y}-01-01`, to: `${y}-12-31`, label: `${y} рік`, y: String(y) };
  }
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const last = new Date(Date.UTC(y, d.getUTCMonth() + 1, 0)).getUTCDate();
  return { kind: 'month', from: `${y}-${m}-01`, to: `${y}-${m}-${last}`, label: `${y}-${m}`, ym: `${y}-${m}` };
}

// Which items are in demand, over any period. Grouped by the post when we have
// one and by article/title otherwise, so a post deleted in the channel still
// shows up under the name it had.
export function popularItems({ period = 'month', from = null, to = null, limit = 25, channel = null, now = Date.now() } = {}) {
  const p = resolvePeriod({ period, from, to, now });
  const lim = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const params = [p.from, `${p.to}T23:59:59.999Z`];
  let channelClause = '';
  if (channel && channel !== 'all') { channelClause = ' AND channel = ?'; params.push(channel); }

  const rows = db.prepare(
    `SELECT COALESCE(CAST(post_id AS TEXT), 'a:' || COALESCE(article, title, '?')) AS group_key,
            MAX(title)   AS title,
            MAX(article) AS article,
            MAX(channel) AS channel,
            MAX(post_id) AS post_id,
            SUM(CASE WHEN action='added'   THEN 1 ELSE 0 END) AS adds,
            SUM(CASE WHEN action='removed' THEN 1 ELSE 0 END) AS removes,
            SUM(CASE WHEN action='sent'    THEN 1 ELSE 0 END) AS sends,
            COUNT(DISTINCT customer_id) AS people,
            MIN(created_at) AS first_at,
            MAX(created_at) AS last_at
       FROM cart_events
      WHERE created_at >= ? AND created_at <= ?${channelClause}
      GROUP BY group_key
      ORDER BY adds DESC, sends DESC, people DESC
      LIMIT ?`
  ).all(...params, lim);

  return {
    period: p,
    items: rows.map((r) => ({
      postId: r.post_id,
      title: r.title,
      article: r.article,
      channel: r.channel,
      adds: r.adds,
      removes: r.removes,
      sends: r.sends,
      people: r.people,
      // How often an item that was tried on actually became an inquiry.
      sendRatePct: r.adds > 0 ? Math.round((r.sends / r.adds) * 100) : null,
      firstAt: r.first_at,
      lastAt: r.last_at,
    })),
  };
}

// Totals + a month-by-month (or day-by-day) timeline, so the same endpoint
// answers "как шёл месяц" and "как шёл год".
export function popularityStats({ period = 'month', from = null, to = null, channel = null, now = Date.now() } = {}) {
  const p = resolvePeriod({ period, from, to, now });
  const params = [p.from, `${p.to}T23:59:59.999Z`];
  let channelClause = '';
  if (channel && channel !== 'all') { channelClause = ' AND channel = ?'; params.push(channel); }

  const totals = db.prepare(
    `SELECT SUM(CASE WHEN action='added' THEN 1 ELSE 0 END) AS adds,
            SUM(CASE WHEN action='removed' THEN 1 ELSE 0 END) AS removes,
            SUM(CASE WHEN action='sent' THEN 1 ELSE 0 END) AS sends,
            COUNT(DISTINCT customer_id) AS people,
            COUNT(DISTINCT COALESCE(CAST(post_id AS TEXT), article, title)) AS items
       FROM cart_events
      WHERE created_at >= ? AND created_at <= ?${channelClause}`
  ).get(...params);

  // A month is read by day, anything longer by month — one query either way.
  const bucket = p.kind === 'month' ? "substr(created_at, 1, 10)" : 'ym';
  const timeline = db.prepare(
    `SELECT ${bucket} AS bucket,
            SUM(CASE WHEN action='added' THEN 1 ELSE 0 END) AS adds,
            SUM(CASE WHEN action='sent'  THEN 1 ELSE 0 END) AS sends,
            COUNT(DISTINCT customer_id) AS people
       FROM cart_events
      WHERE created_at >= ? AND created_at <= ?${channelClause}
      GROUP BY bucket ORDER BY bucket`
  ).all(...params);

  const byChannel = db.prepare(
    `SELECT COALESCE(channel, '—') AS channel,
            SUM(CASE WHEN action='added' THEN 1 ELSE 0 END) AS adds,
            SUM(CASE WHEN action='sent'  THEN 1 ELSE 0 END) AS sends,
            COUNT(DISTINCT customer_id) AS people
       FROM cart_events
      WHERE created_at >= ? AND created_at <= ?${channelClause}
      GROUP BY channel ORDER BY adds DESC`
  ).all(...params);

  const inquiries = db.prepare(
    `SELECT COUNT(*) AS n, SUM(items_count) AS items
       FROM inquiries WHERE created_at >= ? AND created_at <= ?`
  ).get(p.from, `${p.to}T23:59:59.999Z`);

  return {
    period: p,
    totals: {
      adds: totals.adds || 0,
      removes: totals.removes || 0,
      sends: totals.sends || 0,
      people: totals.people || 0,
      items: totals.items || 0,
      inquiries: inquiries.n || 0,
      inquiryItems: inquiries.items || 0,
      // Of everything tried on, how much turned into a real question to Dasha.
      sendRatePct: totals.adds > 0 ? Math.round(((totals.sends || 0) / totals.adds) * 100) : null,
    },
    timeline,
    byChannel,
  };
}

function safeJson(s) {
  try { return s ? JSON.parse(s) : null; } catch { return null; }
}
