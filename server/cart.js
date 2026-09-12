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
import { asJson } from './sql.js';
import { mediaUrl, isEmojiRef } from './media.js';
import { formatPhone } from './phone.js';

const iso = (ms) => new Date(ms).toISOString();
const round2 = (n) => Math.round(n * 100) / 100;

// Dasha is support, Maryna is the owner: the inquiry goes to BOTH, which is
// exactly what Maryna asked for. Falls back to the admin list when no separate
// support id is configured, so nothing is silently lost.
export const supportIds = () =>
  (process.env.SUPPORT_TG_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);

// Who the client is writing to — and it is ONE person, always the same one.
//
// This is a face, not a routing table. A client who has just handed over a wish
// list wants to know a named human has it; «ваш запит зареєстровано» from
// nobody in particular is how a shop reads as a form. So the app shows Dasha,
// with her photograph, everywhere — while the message itself also reaches
// Maryna, who is the owner and needs to see demand, and whom the client has no
// reason to be told about. Nothing in the client's screens is derived from the
// recipient list; the two live apart on purpose (see sendInquiry).
//
// Ukrainian needs the dative case for «написати Даші / Сергію», and a name is
// not something to hardcode: during the test the inquiries land with Serhiy.
export const support = () => ({
  name: process.env.SUPPORT_NAME || 'Даша',
  dative: process.env.SUPPORT_NAME_DATIVE || process.env.SUPPORT_NAME || 'Даші',
  username: (process.env.SUPPORT_USERNAME || '').replace(/^@/, ''),
  role: process.env.SUPPORT_ROLE || 'менеджер Way2Buy',
  // A photograph is the whole point of the confirmation card. By default it is
  // her own Telegram avatar, proxied and re-resolved as it changes, so nobody
  // has to upload anything or remember to replace it. SUPPORT_PHOTO_URL
  // overrides that with a fixed image; empty support ids mean no photo at all.
  // Every one of those endings is handled by the client falling back to
  // initials rather than to a broken image.
  photo: process.env.SUPPORT_PHOTO_URL || (supportIds().length ? '/api/support/photo' : ''),
});

const FX = { USD: 1, EUR: 1.08, UAH: 1 / 41 };
const toUsd = (amount, currency) =>
  amount == null ? null : round2(Number(amount) * (FX[currency] ?? 1));

// ── the fitting room ──────────────────────────────────────────────────────

// The stored `channel` is a slug ('clothes'); nobody outside the code should
// ever see it. The human title is looked up, with the slug as a last resort in
// case the channel row was removed.
// `kind` comes back with the title because the two are always wanted together:
// it is what separates an ARTICLE in a catalogue from a POST in the feed, and
// the inquiry asks two different questions about them.
const channelInfo = async (key) => {
  if (!key) return { title: null, kind: 'catalog' };
  const row = await db.prepare('SELECT title, kind FROM channels WHERE key=?').get(key);
  return { title: row?.title || key, kind: row?.kind || 'catalog' };
};

export async function shapeItem(r) {
  const ch = await channelInfo(r.channel);
  return {
    id: r.id,
    postId: r.post_id,
    title: r.title,
    article: r.article,
    channel: ch.title,
    // 'main' — це пост зі «Стрічки»; 'catalog' — артикул із каталогу.
    channelKind: ch.kind,
    channelKey: r.channel,
    price: r.price,
    currency: r.currency,
    // A file_id goes through the photo proxy, an imported URL is used as it is,
    // an emoji is shown as-is. The client never sees a bot token.
    photo: mediaUrl(r.photo),
    emoji: isEmojiRef(r.photo) ? r.photo : '🛍️',
    createdAt: r.created_at,
  };
}

export async function listCart(customerId) {
  const rows = await db.prepare(
    "SELECT * FROM cart_items WHERE customer_id=? AND status='active' ORDER BY created_at DESC"
  ).all(customerId);
  // shapeItem resolves the channel title from the database, so it is async:
  // rows.map(shapeItem) would hand back an array of promises.
  return await Promise.all(rows.map(shapeItem));
}

export async function cartCount(customerId) {
  return (await db.prepare("SELECT COUNT(*) c FROM cart_items WHERE customer_id=? AND status='active'")
    .get(customerId)).c;
}

async function logEvent({ customerId, postId, action, title, article, channel, priceUsd = null, inquiryId = null, now }) {
  const at = iso(now);
  await db.prepare(`INSERT INTO cart_events
    (customer_id,post_id,action,title,article,channel,price_usd,inquiry_id,created_at,ym,y)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(customerId, postId, action, title, article, channel, priceUsd, inquiryId,
      at, at.slice(0, 7), at.slice(0, 4));
}

// Add a post to the fitting room. Returns { ok, added, item, count } — a repeat
// tap reports added:false rather than failing, because the client will tap twice.
export async function addToCart({ customerId, postId, note = null, now = Date.now() }) {
  const post = await db.prepare('SELECT * FROM posts WHERE id=?').get(postId);
  if (!post) return { ok: false, error: 'post_not_found' };

  const existing = await db.prepare(
    "SELECT * FROM cart_items WHERE customer_id=? AND post_id=? AND status='active'"
  ).get(customerId, postId);
  if (existing) {
    return { ok: true, added: false, item: await shapeItem(existing), count: await cartCount(customerId) };
  }

  // Photos: first file_id if the post carries them, else the emoji placeholder.
  let photo = post.image_url || '🛍️';
  try {
    const photos = asJson(post.photos_json);
    if (Array.isArray(photos) && photos.length) photo = photos[0];
  } catch { /* keep the fallback */ }

  const info = await db.prepare(`INSERT INTO cart_items
    (customer_id,post_id,title,article,channel,photo,price,currency,note,status,created_at)
    VALUES (?,?,?,?,?,?,?,?,?, 'active',?)`)
    .run(customerId, postId, post.title, post.article, post.channel, photo,
      post.price, post.currency, note, iso(now));

  await logEvent({
    customerId, postId, action: 'added',
    title: post.title, article: post.article, channel: post.channel,
    priceUsd: toUsd(post.price, post.currency), now,
  });

  const row = await db.prepare('SELECT * FROM cart_items WHERE id=?').get(info.lastInsertRowid);
  return { ok: true, added: true, item: await shapeItem(row), count: await cartCount(customerId) };
}

export async function removeFromCart({ customerId, itemId, now = Date.now() }) {
  const row = await db.prepare("SELECT * FROM cart_items WHERE id=? AND customer_id=? AND status='active'")
    .get(itemId, customerId);
  if (!row) return { ok: false, error: 'not_found' };

  await db.prepare('DELETE FROM cart_items WHERE id=?').run(itemId);
  // The journal keeps the add AND the removal, so "added but dropped" is
  // measurable — that is a signal about the item, not noise.
  await logEvent({
    customerId, postId: row.post_id, action: 'removed',
    title: row.title, article: row.article, channel: row.channel,
    priceUsd: toUsd(row.price, row.currency), now,
  });
  return { ok: true, count: await cartCount(customerId) };
}

// ── the coupon that applies itself ────────────────────────────────────────

// The best promo code the client can use right now, so the UI can show one
// pre-applied line instead of asking them to choose. "Best" = the largest
// discount on the current basket; a percentage is resolved against the basket
// total, a fixed amount is taken as-is.
export async function bestPromo(customerId, basketUsd = 0, now = Date.now()) {
  const rows = await db.prepare(
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
export async function cartView(customerId, now = Date.now()) {
  const items = await listCart(customerId);
  const raw = await db.prepare("SELECT price, currency FROM cart_items WHERE customer_id=? AND status='active'").all(customerId);
  const basket = basketTotalUsd(raw);
  return {
    items,
    count: items.length,
    basket,
    promo: await bestPromo(customerId, basket.totalUsd, now),
    // Always empty, and kept only so a Mini App still open on an older bundle
    // does not break on a missing field.
    //
    // It used to hold a pre-written «Доброго дня! Мене цікавить: 1… 2… 3…
    // Підкажіть ціну та наявність» — which nobody edited, so it arrived at the
    // manager as "the client's question", restating the list she had just read.
    // The list IS the question. The box is for the thing the list cannot say:
    // a size, a colour, a deadline.
    draft: '',
  };
}

// ── sending the inquiry ───────────────────────────────────────────────────

const shortName = (c) => (c.name || `#${c.id}`).trim();

// A direct link to the post the client tapped.
//
// Whoever answers this inquiry has to see the ITEM, not a title a parser
// guessed off a caption — «Сумка» and «Prada · окуляри» name a dozen things
// each, and the article code is only useful to someone already holding the
// catalogue. A public channel links by @username, which opens for anybody; a
// private one links by its numeric /c/ form, which opens for members — and
// everyone who receives this message is a member of every channel in it.
export function tgPostUrl({ username, chatId, messageId }) {
  if (!messageId) return null;
  if (username) return `https://t.me/${String(username).replace(/^@/, '')}/${messageId}`;
  const priv = String(chatId || '').match(/^-100(\d+)$/);
  return priv ? `https://t.me/c/${priv[1]}/${messageId}` : null;
}

// One query for the whole basket rather than one per item: a fitting room can
// hold a dozen things and the database is a hundred milliseconds away.
async function attachPostLinks(items) {
  const ids = items.map((i) => i.postId).filter((id) => id != null);
  if (!ids.length) return items;

  const rows = await db.prepare(
    `SELECT p.id, p.tg_message_id, c.username, c.chat_id
       FROM posts p LEFT JOIN channels c ON c.key = p.channel
      WHERE p.id IN (${ids.map(() => '?').join(',')})`
  ).all(...ids);

  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  return items.map((i) => {
    const r = byId.get(Number(i.postId));
    return {
      ...i,
      url: r ? tgPostUrl({ username: r.username, chatId: r.chat_id, messageId: r.tg_message_id }) : null,
    };
  });
}

const itemLabel = (i) =>
  `${i.title || 'Позиція'}${i.article ? ` · арт. ${i.article}` : ''}`;

// Two renderings of one list. The stored/plain one keeps the URL on its own
// line, because the cabinet shows this as text; the DM one puts the link on the
// title, because Telegram will render it and a wall of raw URLs is unreadable.
//
// The CATALOGUE the item came from is deliberately not named. «Dior · сумка ·
// Сумки жіночі» tells whoever answers nothing they did not already read two
// words earlier, and five of those lines is a message you have to work through
// instead of glance at. The link goes to the post; the post says where it lives.
function itemLine(i) {
  return `• ${itemLabel(i)}${i.url ? `\n  ${i.url}` : ''}`;
}

function itemLineHtml(i) {
  const label = escapeHtml(itemLabel(i));
  return `• ${i.url ? `<a href="${escapeHtml(i.url)}">${label}</a>` : label}`;
}


// Send the fitting room as one inquiry. Returns { ok, inquiryId, message } and
// never throws for business reasons.
export async function sendInquiry({ customer, message = '', now = Date.now(), lang = null }) {
  // The links are resolved once, here, and travel with the stored inquiry — so
  // the cabinet can offer them months later even if the post has since been
  // hidden or the channel renamed.
  const items = await attachPostLinks(await listCart(customer.id));
  if (!items.length) return { ok: false, error: 'empty_cart', message: 'Примірочна порожня.' };

  const raw = await db.prepare("SELECT price, currency FROM cart_items WHERE customer_id=? AND status='active'").all(customer.id);
  const basket = basketTotalUsd(raw);
  const promo = await bestPromo(customer.id, basket.totalUsd, now);
  const clientText = String(message || '').trim().slice(0, 2000);

  const info = await db.prepare(`INSERT INTO inquiries
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
    await logEvent({
      customerId: customer.id, postId: i.postId, action: 'sent',
      title: i.title, article: i.article, channel: i.channel,
      priceUsd: null, inquiryId, now,
    });
  }

  // ── exactly the wording Maryna asked for ──
  //
  // Assembled twice from one source: `body` is the record — it is what the
  // cabinet renders, as text — and `bodyHtml` is the message, where each item
  // is a tap through to the post it came from.
  const who = support();
  const title = `🛍️ Клієнт ${shortName(customer)} цікавиться товаром`;

  // One text, two escapings — never two texts. If the wording of the record and
  // the wording of the message can drift apart, one day they will.
  //
  // Assembled as BLOCKS joined once, not as fragments each carrying its own
  // leading newlines. The old shape left a hole behind whichever block turned
  // out to be absent, and the blocks here are absent most of the time: a client
  // who typed nothing and holds no coupon is the ordinary case.
  const tail = (esc) => {
    const q = esc ? escapeHtml : (s) => s;
    const blocks = [];

    // Only what the client actually WROTE. The fitting room no longer pre-fills
    // the box, so text here is a person typing, not a template coming back.
    if (clientText) blocks.push(`Питання клієнта:\n«${q(clientText)}»`);

    // The coupon is stated either way: an unusable one still matters, because
    // Maryna is the person who sets the price the minimum is measured against.
    if (promo) {
      blocks.push(promo.usable
        ? `Знижка клієнта: ${q(promo.label)} (${q(promo.code)}) — застосована`
        : `Знижка клієнта: ${q(promo.label)} (${q(promo.code)})` +
          (promo.minOrderUsd ? ` — діє від замовлення $${promo.minOrderUsd}, врахуйте при розрахунку` : ''));
    }

    // How to reach them, as one block: two ways of doing the same thing belong
    // on adjacent lines, not separated by the blank line that divides subjects.
    const contact = [
      customer.phone ? `📞 ${q(formatPhone(customer.phone))}` : null,
      customer.tg_user_id ? `Telegram User ID: ${q(String(customer.tg_user_id))}` : null,
    ].filter(Boolean);
    if (contact.length) blocks.push(contact.join('\n'));

    return blocks.join('\n\n');
  };

  // Two questions, asked apart.
  //
  // A catalogue article and a post in the feed reach the fitting room by the
  // same button, and they are not the same request: «скільки коштує ця сумка»
  // has an answer, «мене цікавить оцей пост» is a conversation. Run together in
  // one list they read as one question, and whoever answers has to open five
  // links to find out which of them is which.
  //
  // The headers appear whenever their group has anything in it — including when
  // it is the only group. A format that changes shape depending on what happens
  // to be in it is a format somebody has to read carefully every time.
  const articles = items.filter((i) => i.channelKind !== 'main');
  const posts = items.filter((i) => i.channelKind === 'main');

  // No lead line. `title` above already says «Клієнт X цікавиться товаром», and
  // a DM renders the two one under the other — the same sentence twice, differing
  // by an emoji and a colon. The title is stored separately on the row, so a
  // cabinet panel reading this later still has both halves.
  const group = (head, rows, line) => (rows.length ? `${head}\n${rows.map(line).join('\n')}` : '');
  const compose = (line, esc) => [
    group('Запитує ціну та наявність:', articles, line),
    group(posts.length === 1 ? 'Цікавиться постом:' : 'Цікавиться постами:', posts, line),
    tail(esc),
  ].filter(Boolean).join('\n\n');

  const body = compose(itemLine, false);
  const bodyHtml = compose(itemLineHtml, true);

  // Maryna (admins) get it in the admin alert feed + DM. The client is never
  // told this happened — nothing in the response or in their notification feed
  // names an admin, and the confirmation they see credits Dasha alone.
  await notifyAdmins({ kind: 'inquiry', title, body, bodyHtml, dedupeKey: `inquiry:${inquiryId}` });
  // Dasha gets the same message as a DM. Separate ids so support can be someone
  // who is not an admin of the panel; anyone on both lists is not sent twice.
  const alerted = await adminIds();
  const dashaIds = supportIds().filter((id) => !alerted.includes(id));
  for (const id of dashaIds) {
    void Promise.resolve(await sendToUser(id, `<b>${escapeHtml(title)}</b>\n${bodyHtml}`)).catch(() => {});
  }

  // The client's own confirmation, in their language, with no jargon.
  await notifyCustomer({
    customerId: customer.id,
    kind: 'inquiry_sent',
    message: { key: 'inquiry_sent', params: { who: who.name, items: items.length } },
    // They are looking at the app this second; the request knows their language
    // better than the row does.
    lang,
    dedupeKey: `inquiry-ack:${inquiryId}`,
  });

  return {
    ok: true,
    inquiryId,
    items: items.length,
    promo: promo && promo.usable ? { code: promo.code, label: promo.label } : null,
    // Returned in Ukrainian and translated in the browser like every other
    // string the client sees on screen (public/js/i18n.js) — only the DM, which
    // has no DOM, is rendered server-side.
    message: `${who.name} перевірить наявність і скоро напише вам 💛`,
  };
}

function escapeHtml(s = '') {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── admin reads ───────────────────────────────────────────────────────────

// `status` is how far Dasha got with answering ('new' | 'answered' | 'closed');
// `deal` is how the sale itself ended ('in_progress' | 'bought' | 'not_bought',
// see deals.js). Two different questions about one row, and the cabinet asks
// both: the tabs filter by `deal`, the pill on the card shows `status`.
export async function listInquiries({ id = null, status = null, deal = null, limit = 50 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const where = [];
  const params = [];
  // One inquiry by id: what the «Відкрити заявку» button in a follow-up DM
  // resolves, so the cabinet can open the tab that deal is actually in rather
  // than guessing and paging through the list to look for it.
  if (id) { where.push('i.id=?'); params.push(Number(id)); }
  if (status) { where.push('i.status=?'); params.push(status); }
  if (deal) { where.push('i.deal_status=?'); params.push(deal); }
  const rows = await db.prepare(
    `SELECT i.*, c.name, c.tg_user_id, c.phone FROM inquiries i
       JOIN customers c ON c.id = i.customer_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY i.created_at DESC LIMIT ?`
  ).all(...params, lim);

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
    // The deal: its state, who last said so, and how many nudges it has taken.
    dealStatus: r.deal_status || 'in_progress',
    dealStatusAt: r.deal_status_at,
    dealStatusBy: r.deal_status_by,
    followupCount: Number(r.followup_count) || 0,
  }));
}

// The client's own history of asking.
//
// listInquiries above is the CABINET's view of the same rows and answers "who
// is this and how do we reach them". This one answers "what have I asked for",
// and everything that is the shop's business is left out of it: who picked the
// inquiry up, and whether the shop counted the deal as won or lost. A client
// reading «не купив» about her own request would be reading a note that was
// never addressed to her.
export async function customerInquiries(customerId, { limit = 50 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const rows = await db.prepare(
    `SELECT id, message, items_json, items_count, promo_label, answered_at, created_at
       FROM inquiries WHERE customer_id=? ORDER BY created_at DESC LIMIT ?`
  ).all(customerId, lim);

  return rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    // The snapshot taken when it was sent — the card as it was, with the link
    // that still opens the post. Months later this is the only record of what
    // «Сумка» meant that day.
    items: (safeJson(r.items_json) || []).map((i) => ({
      title: i.title, article: i.article, url: i.url, photo: i.photo, emoji: i.emoji,
    })),
    itemsCount: r.items_count,
    message: r.message,
    promoLabel: r.promo_label,
    // Whether anybody has picked it up yet. One boolean, not the three-state
    // funnel: «в процесі / купив / не купив» is how the shop tracks itself.
    answered: Boolean(r.answered_at),
  }));
}

export async function setInquiryStatus(id, { status, by = null, now = Date.now() }) {
  const allowed = ['new', 'answered', 'closed'];
  if (!allowed.includes(status)) throw new Error(`status must be one of ${allowed.join('|')}`);
  const info = await db.prepare('UPDATE inquiries SET status=?, answered_by=?, answered_at=? WHERE id=?')
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
export async function popularItems({ period = 'month', from = null, to = null, limit = 25, channel = null, now = Date.now() } = {}) {
  const p = resolvePeriod({ period, from, to, now });
  const lim = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const params = [p.from, `${p.to}T23:59:59.999Z`];
  let channelClause = '';
  if (channel && channel !== 'all') { channelClause = ' AND channel = ?'; params.push(channel); }

  const rows = await db.prepare(
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
export async function popularityStats({ period = 'month', from = null, to = null, channel = null, now = Date.now() } = {}) {
  const p = resolvePeriod({ period, from, to, now });
  const params = [p.from, `${p.to}T23:59:59.999Z`];
  let channelClause = '';
  if (channel && channel !== 'all') { channelClause = ' AND channel = ?'; params.push(channel); }

  const totals = await db.prepare(
    `SELECT SUM(CASE WHEN action='added' THEN 1 ELSE 0 END) AS adds,
            SUM(CASE WHEN action='removed' THEN 1 ELSE 0 END) AS removes,
            SUM(CASE WHEN action='sent' THEN 1 ELSE 0 END) AS sends,
            COUNT(DISTINCT customer_id) AS people,
            COUNT(DISTINCT COALESCE(CAST(post_id AS TEXT), article, title)) AS items
       FROM cart_events
      WHERE created_at >= ? AND created_at <= ?${channelClause}`
  ).get(...params);

  // A month is read by day, anything longer by month — one query either way.
  // to_char, not substr: created_at is a timestamptz now, so there is no text
  // to slice. The 'ym' branch reads the pre-computed bucket column.
  const bucket = p.kind === 'month' ? "to_char(created_at, 'YYYY-MM-DD')" : 'ym';
  const timeline = await db.prepare(
    `SELECT ${bucket} AS bucket,
            SUM(CASE WHEN action='added' THEN 1 ELSE 0 END) AS adds,
            SUM(CASE WHEN action='sent'  THEN 1 ELSE 0 END) AS sends,
            COUNT(DISTINCT customer_id) AS people
       FROM cart_events
      WHERE created_at >= ? AND created_at <= ?${channelClause}
      GROUP BY bucket ORDER BY bucket`
  ).all(...params);

  const byChannel = await db.prepare(
    `SELECT COALESCE(channel, '—') AS channel,
            SUM(CASE WHEN action='added' THEN 1 ELSE 0 END) AS adds,
            SUM(CASE WHEN action='sent'  THEN 1 ELSE 0 END) AS sends,
            COUNT(DISTINCT customer_id) AS people
       FROM cart_events
      WHERE created_at >= ? AND created_at <= ?${channelClause}
      GROUP BY channel ORDER BY adds DESC`
  ).all(...params);

  const inquiries = await db.prepare(
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
  return asJson(s);
}
