// ─────────────────────────────────────────────────────────────────────────
//  index.js — Way2Buy Mini App server.
//  Serves the Mini App (static) + JSON API + Telegram webhook + AI reports.
// ─────────────────────────────────────────────────────────────────────────
import './env.js';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { db, init } from './db.js';
import { loyaltyFor, snapshotBatch, cashbackRule, TIERS } from './loyalty.js';
import {
  listChannels, getChannel, liveMode, publishPost, ingestChannelPost, fetchPhoto,
  handleMessage, botInfo, webhookInfo, checkChannelAccess,
} from './telegram.js';
import { buildReport, sendReport } from './ai.js';
import * as campaigns from './campaigns.js';
import * as rules from './rules.js';
import * as birthday from './birthday.js';
import * as profit from './profit.js';
import * as cart from './cart.js';
import * as scheduler from './scheduler.js';
import * as polling from './polling.js';
import { adminAlerts } from './notify.js';
import { asJson } from './sql.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
await init();

const app = express();

// ── async handlers ─────────────────────────────────────────────────────────
// Every route below reads the database, so every route is async. Express 4 does
// not notice a rejected promise: without this the request would hang until the
// client gave up, and the reason would only appear as an unhandledRejection.
// Wrapping at registration time keeps the 47 route bodies free of boilerplate.
// (Error-handling middleware takes four arguments and is passed through as-is.)
const wrapAsync = (fn) =>
  typeof fn !== 'function' || fn.length === 4
    ? fn
    : (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

for (const method of ['get', 'post', 'put', 'patch', 'delete', 'all', 'use']) {
  const original = app[method].bind(app);
  app[method] = (...args) => original(...args.map(wrapAsync));
}

app.use(express.json());
app.use(express.static(join(__dirname, '..', 'public')));

const PORT = process.env.PORT || 4010;
const ADMIN_IDS = (process.env.ADMIN_TG_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
const DEMO = ADMIN_IDS.length === 0; // no admins configured ⇒ open demo mode

// «Товари в наявності» — the one catalogue that means "ready to ship". It is
// pinned and highlighted in the UI; the key is overridable because the channel
// could be renamed.
const IN_STOCK_KEY = process.env.IN_STOCK_CHANNEL_KEY || 'available';

// ── FX: normalise everything to USD ────────────────────────────────────────
const RATE = { USD: 1, EUR: 1.08, UAH: 1 / 41 };
const toUsd = (amount, currency) => Math.round(amount * (RATE[currency] ?? 1) * 100) / 100;

// ── identity helpers ───────────────────────────────────────────────────────
// Demo: identity comes from ?tgid= (frontend supplies it). In production this
// is replaced by Telegram initData HMAC validation — the shape stays the same.
const tgid = (req) => String(req.query.tgid || req.body?.tgid || '').trim();
const findCustomer = async (id) => await db.prepare('SELECT * FROM customers WHERE tg_user_id=?').get(id);
const isAdmin = (req) => {
  const id = tgid(req);
  if (DEMO) return String(req.query.admin || req.body?.admin || '') === '1' || ADMIN_IDS.includes(id);
  return ADMIN_IDS.includes(id);
};
const requireAdmin = (req, res, next) => (isAdmin(req) ? next() : res.status(403).json({ error: 'admin only' }));

const now = () => new Date().toISOString();
const badRequest = (res, e) => {
  const validation = e instanceof rules.RuleValidationError || e instanceof campaigns.CampaignValidationError;
  return res.status(validation ? 400 : 500).json({ error: String(e.message || e) });
};

const customerCard = async (c) => ({
  id: c.id, tgId: c.tg_user_id, name: c.name, login: c.login,
  phone: c.phone, address: c.address, birthday: c.birthday,
  birthdaySource: c.birthday_source,
  // email/city stay in the row for existing data but are no longer collected —
  // Maryna asked for name / address / phone / birthday only.
  loyalty: await loyaltyFor(c.id),
});

// ── config ─────────────────────────────────────────────────────────────────
app.get('/api/config', async (req, res) => {
  const cashback = await cashbackRule();
  res.json({
    channels: await listChannels(),
    rules: await rules.listRules(),
    cashback: {
      mode: cashback.mode,
      value: Number(cashback.value),
      minOrderUsd: Number(cashback.min_order_usd ?? 0),
      capUsd: cashback.cap_usd ?? null,
      enabled: Boolean(cashback.enabled),
    },
    holidays: await rules.activeHolidays(),
    // The client UI stays deliberately bare: two bonuses, no tiers/badges/
    // streaks. The data still exists for the admin view.
    // The human every price question ends at. The Mini App never replaces
    // them — it only pre-writes the message. Name and contact are settings, so
    // a test can route everything to someone else.
    support: cart.support(),
    inStockKey: IN_STOCK_KEY,
    features: { tiers: false, badges: false, streak: false, aiChat: false },
    tiers: TIERS,
    live: liveMode(),
    demo: DEMO,
  });
});

// ── me / register ────────────────────────────────────────────────────────
app.get('/api/me', async (req, res) => {
  const c = await findCustomer(tgid(req));
  if (!c) return res.json({ registered: false, admin: isAdmin(req) });
  res.json({
    registered: true,
    admin: isAdmin(req),
    customer: await customerCard(c),
    birthday: await birthday.birthdayStatus(c),
    cartCount: await cart.cartCount(c.id),
  });
});

app.post('/api/register', async (req, res) => {
  // The four fields Maryna asked for. `city` is still accepted so older
  // clients do not break, but nothing asks for it any more.
  const { name, phone, address, birthday: bday, city, consent } = req.body || {};
  const id = tgid(req);
  if (!name || !id) return res.status(400).json({ error: 'name & tgid required' });

  const parsedBday = bday ? birthday.parseBirthday(bday) : null;
  if (bday && !parsedBday) return res.status(400).json({ error: 'invalid birthday' });
  const storedBday = parsedBday
    ? `${parsedBday.year || 1900}-${birthday.mmdd(parsedBday)}`
    : null;

  const exists = await findCustomer(id);
  if (exists) {
    // A birthday already on file is NOT overwritten by a profile edit — it is
    // the value every future discount request is checked against. Changing it
    // is an admin action (see /api/admin/customers/:id/birthday).
    const keepBday = exists.birthday || storedBday;
    await db.prepare('UPDATE customers SET name=?,phone=?,address=?,birthday=?,city=COALESCE(?,city),consent=? WHERE id=?')
      .run(name, phone || null, address || null, keepBday, city || null, Boolean(consent), exists.id);
    if (!exists.birthday && storedBday) {
      await db.prepare('UPDATE customers SET birthday_source=?, birthday_recorded_at=? WHERE id=?')
        .run('claim', now(), exists.id);
    }
    const fresh = await findCustomer(id);
    return res.json({ registered: true, customer: await customerCard(fresh), birthday: await birthday.birthdayStatus(fresh) });
  }

  const info = await db.prepare(`INSERT INTO customers
      (tg_user_id,login,name,phone,address,birthday,birthday_source,birthday_recorded_at,city,consent,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, req.body.login || null, name, phone || null, address || null,
      storedBday, storedBday ? 'claim' : null, storedBday ? now() : null,
      city || null, Boolean(consent), now());
  await db.prepare('INSERT INTO events (customer_id,type,created_at) VALUES (?,?,?)').run(info.lastInsertRowid, 'join', now());
  const fresh = await findCustomer(id);
  res.json({ registered: true, customer: await customerCard(fresh), birthday: await birthday.birthdayStatus(fresh) });
});

// ── birthday discount: record → verify → grant ───────────────────────────
app.get('/api/birthday', async (req, res) => {
  const c = await findCustomer(tgid(req));
  if (!c) return res.json({ registered: false });
  res.json({ registered: true, ...(await birthday.birthdayStatus(c)), history: await birthday.claimsFor(c.id) });
});

app.post('/api/birthday/claim', async (req, res) => {
  const c = await findCustomer(tgid(req));
  if (!c) return res.status(404).json({ error: 'not registered' });
  try {
    const result = await birthday.claimBirthdayDiscount({ customer: c, birthdayInput: req.body?.birthday });
    res.status(result.ok ? 200 : 409).json({ ...result, status: await birthday.birthdayStatus(await findCustomer(tgid(req))) });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ── feed (all channels) ────────────────────────────────────────────────────
const shapePost = async (p) => ({
  ...p,
  photos: safeJson(p.photos_json) || [],
  photoUrls: (safeJson(p.photos_json) || []).map((fid) => `/api/photo/${encodeURIComponent(fid)}`),
  channelMeta: await getChannel(p.channel),
});

// Two surfaces over one table:
//   ?kind=catalog → the ~15 catalogues the client browses and filters by
//   ?kind=main    → the main channel's posts, i.e. "стрічка каналу"
//   ?channel=key  → one specific catalogue
// The client also gets `inCart` per post so «Хочу» renders in the right state
// without a second request.
app.get('/api/feed', async (req, res) => {
  const ch = req.query.channel;
  const kind = req.query.kind;
  const limit = Math.min(Math.max(Number(req.query.limit) || 60, 1), 200);
  // Search runs across ALL catalogues, not just the selected one: a client who
  // types "kelly" wants the bag, not "the bag inside the chip I happened to tap".
  const q = String(req.query.q || '').trim().slice(0, 60);

  const where = ["status='published'"];
  const params = [];

  if (ch && ch !== 'all') {
    where.push('channel = ?');
    params.push(ch);
  } else if (kind === 'main' || kind === 'catalog') {
    const keys = (await listChannels()).filter((c) => c.kind === kind).map((c) => c.key);
    if (!keys.length) return res.json({ posts: [] });
    where.push(`channel IN (${keys.map(() => '?').join(',')})`);
    params.push(...keys);
  }

  if (q) {
    // Title, body and article — an article number is how the catalogues label
    // a position, so it must be searchable verbatim.
    where.push('(title LIKE ? OR body LIKE ? OR article LIKE ?)');
    const like = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    params.push(like, like, like);
  }

  const rows = await db.prepare(
    `SELECT * FROM posts WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`
  ).all(...params, limit);

  const customer = await findCustomer(tgid(req));
  const inCart = new Set(
    customer
      ? (await db.prepare("SELECT post_id FROM cart_items WHERE customer_id=? AND status='active'")
          .all(customer.id)).map((r) => r.post_id)
      : []
  );
  // shapePost resolves the channel title from the database. Spreading it without
  // awaiting yields {} — the response keeps its shape and loses every field.
  res.json({
    posts: await Promise.all(
      rows.map(async (p) => ({ ...(await shapePost(p)), inCart: inCart.has(p.id) }))
    ),
  });
});

// The catalogue chips: every catalogue with how much is in it right now, so a
// client never taps into an empty filter. «Товари в наявності» is flagged —
// it is the only catalogue that means "ready to ship", and Maryna wants it to
// stand out from the rest.
app.get('/api/catalogs', async (req, res) => {
  const counts = new Map(
    (await db.prepare("SELECT channel, COUNT(*) n FROM posts WHERE status='published' GROUP BY channel")
      .all()).map((r) => [r.channel, r.n])
  );
  const catalogs = (await listChannels())
    .filter((c) => c.kind !== 'main')
    .map((c) => ({ ...c, count: counts.get(c.key) || 0, inStock: c.key === IN_STOCK_KEY }))
    // In stock first, then the fullest catalogues — an empty one is useless.
    .sort((a, b) => (b.inStock - a.inStock) || (b.count - a.count));

  const total = catalogs.reduce((s, c) => s + c.count, 0);
  res.json({ catalogs, total, inStockKey: IN_STOCK_KEY });
});

// Photo proxy: the bot token must never reach the browser.
const photoCache = new Map(); // fileId → { buffer, contentType, at }
const PHOTO_TTL = 6 * 3600_000;

app.get('/api/photo/:fileId', async (req, res) => {
  const fileId = String(req.params.fileId || '');
  const hit = photoCache.get(fileId);
  if (hit && Date.now() - hit.at < PHOTO_TTL) {
    res.set('content-type', hit.contentType).set('cache-control', 'public, max-age=21600');
    return res.send(hit.buffer);
  }
  try {
    const file = await fetchPhoto(fileId);
    if (!file) return res.status(404).json({ error: 'photos require a bot token' });
    if (photoCache.size > 200) photoCache.clear();
    photoCache.set(fileId, { ...file, at: Date.now() });
    res.set('content-type', file.contentType).set('cache-control', 'public, max-age=21600');
    res.send(file.buffer);
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

app.post('/api/interest', async (req, res) => {
  const c = await findCustomer(tgid(req));
  const { postId, type } = req.body || {};
  await db.prepare('INSERT INTO events (customer_id,post_id,type,created_at) VALUES (?,?,?,?)')
    .run(c?.id || null, postId || null, type || 'want', now());
  res.json({ ok: true });
});

// ── примірочна: add → look → send to Dasha ───────────────────────────────
app.get('/api/cart', async (req, res) => {
  const c = await findCustomer(tgid(req));
  if (!c) return res.json({ items: [], count: 0, basket: { totalUsd: 0 }, promo: null, draft: '' });
  res.json(await cart.cartView(c.id));
});

app.post('/api/cart/add', async (req, res) => {
  const c = await findCustomer(tgid(req));
  if (!c) return res.status(404).json({ error: 'not registered' });
  const result = await cart.addToCart({ customerId: c.id, postId: Number(req.body?.postId) });
  if (!result.ok) return res.status(404).json({ error: result.error });
  // The tap is also a plain interest event, so the older reports keep working.
  db.prepare('INSERT INTO events (customer_id,post_id,type,created_at) VALUES (?,?,?,?)')
    .run(c.id, Number(req.body?.postId) || null, 'want', now());
  res.json(result);
});

app.post('/api/cart/remove', async (req, res) => {
  const c = await findCustomer(tgid(req));
  if (!c) return res.status(404).json({ error: 'not registered' });
  const result = await cart.removeFromCart({ customerId: c.id, itemId: Number(req.body?.itemId) });
  if (!result.ok) return res.status(404).json({ error: result.error });
  res.json(result);
});

// One button: the message is already written, the coupon is already attached.
app.post('/api/cart/send', async (req, res) => {
  const c = await findCustomer(tgid(req));
  if (!c) return res.status(404).json({ error: 'not registered' });
  const result = await cart.sendInquiry({ customer: c, message: req.body?.message || '' });
  if (!result.ok) return res.status(409).json(result);
  res.json(result);
});

// ── purchases + cashback ────────────────────────────────────────────────
app.get('/api/purchases', async (req, res) => {
  const c = await findCustomer(tgid(req));
  if (!c) return res.json({ purchases: [] });
  const rows = await db.prepare('SELECT * FROM purchases WHERE customer_id=? ORDER BY created_at DESC LIMIT 100').all(c.id);
  const promos = await db.prepare("SELECT * FROM promo_codes WHERE customer_id=? AND status='active' ORDER BY created_at DESC LIMIT 50").all(c.id);
  res.json({
    // Cost/profit columns are admin-only data — the client sees what they paid.
    purchases: rows.map((p) => ({
      id: p.id, title: p.title, amount_usd: p.amount_usd, orig_amount: p.orig_amount,
      orig_currency: p.orig_currency, discount_usd: p.discount_usd, status: p.status,
      source_channel: p.source_channel, created_at: p.created_at,
    })),
    promos: promos.map(shapePromo),
    loyalty: await loyaltyFor(c.id),
  });
});

app.post('/api/redeem', async (req, res) => {
  const c = await findCustomer(tgid(req));
  if (!c) return res.status(404).json({ error: 'not registered' });
  const l = await loyaltyFor(c.id);
  const amount = Math.min(Number(req.body?.amount || l.cashbackAvailable), l.cashbackAvailable);
  if (amount <= 0) return res.status(400).json({ error: 'nothing to redeem' });
  await db.prepare('INSERT INTO redemptions (customer_id,amount_usd,note,created_at) VALUES (?,?,?,?)')
    .run(c.id, amount, 'Списано клієнтом у Mini App', now());
  res.json({ ok: true, loyalty: await loyaltyFor(c.id) });
});

// ── discounts (the cards the client sees) ─────────────────────────────────
app.get('/api/discounts', async (req, res) => {
  const c = await findCustomer(tgid(req));
  const base = await campaigns.discountsFor(c?.id || null);
  res.json({
    ...base,
    birthday: c ? await birthday.birthdayStatus(c) : null,
    holidays: await rules.activeHolidays(),
  });
});

// ── notifications (in-app feed is authoritative — see ADR-005) ───────────
app.get('/api/notifications', async (req, res) => {
  const c = await findCustomer(tgid(req));
  if (!c) return res.json({ notifications: [], unread: 0 });
  const rows = await db.prepare(
    `SELECT id, kind, title, body, in_app_status, created_at
       FROM notifications WHERE customer_id=? ORDER BY created_at DESC LIMIT 50`,
  ).all(c.id);
  res.json({ notifications: rows, unread: rows.filter((r) => r.in_app_status === 'unread').length });
});

app.post('/api/notifications/read', async (req, res) => {
  const c = await findCustomer(tgid(req));
  if (!c) return res.json({ ok: true });
  await db.prepare("UPDATE notifications SET in_app_status='read', read_at=? WHERE customer_id=? AND in_app_status='unread'")
    .run(now(), c.id);
  res.json({ ok: true });
});

// ── demo profile switcher (only exposed while no admins are configured) ───
app.get('/api/demo/profiles', async (req, res) => {
  if (!DEMO) return res.status(404).json({ error: 'not available' });
  const rows = await db.prepare('SELECT tg_user_id, name FROM customers ORDER BY id').all();
  res.json({ profiles: rows.map((r) => ({ tgId: r.tg_user_id, name: r.name })) });
});

// ── ADMIN: clients ───────────────────────────────────────────────────────
app.get('/api/admin/customers', requireAdmin, async (req, res) => {
  const rows = await db.prepare('SELECT * FROM customers ORDER BY created_at DESC LIMIT 500').all();
  const snaps = await snapshotBatch(rows.map((r) => r.id));
  res.json({
    customers: await Promise.all(
      rows.map(async (c) => ({ ...(await customerCard(c)), loyalty: snaps[c.id] }))
    ),
  });
});

// Correcting a birthday is deliberately an admin-only action: the stored date
// is what every future discount request is verified against.
app.post('/api/admin/customers/:id/birthday', requireAdmin, async (req, res) => {
  const parsed = birthday.parseBirthday(req.body?.birthday);
  if (!parsed) return res.status(400).json({ error: 'invalid birthday' });
  const stored = `${parsed.year || 1900}-${birthday.mmdd(parsed)}`;
  const info = await db.prepare('UPDATE customers SET birthday=?, birthday_source=?, birthday_recorded_at=? WHERE id=?')
    .run(stored, 'admin', now(), Number(req.params.id));
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true, birthday: stored });
});

app.get('/api/admin/birthday-claims', requireAdmin, async (req, res) => {
  res.json({ claims: await birthday.allClaims({ limit: req.query.limit, verdict: req.query.verdict || null }) });
});

// ── ADMIN: bonus rules — the $ ⇄ % switch ────────────────────────────────
app.get('/api/admin/rules', requireAdmin, async (req, res) => {
  res.json({ rules: await rules.listRules(), holidays: await rules.listHolidays(), activeHolidays: await rules.activeHolidays() });
});

app.patch('/api/admin/rules/:key', requireAdmin, async (req, res) => {
  try {
    const updated = await rules.updateRule(req.params.key, req.body || {}, tgid(req) || null);
    if (!updated) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, rule: updated });
  } catch (e) { badRequest(res, e); }
});

app.get('/api/admin/holidays', requireAdmin, async (req, res) => {
  res.json({ holidays: await rules.listHolidays(), active: await rules.activeHolidays() });
});

app.patch('/api/admin/holidays/:id', requireAdmin, async (req, res) => {
  try {
    const updated = await rules.updateHoliday(Number(req.params.id), req.body || {}, tgid(req) || null);
    if (!updated) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, holiday: updated });
  } catch (e) { badRequest(res, e); }
});

app.post('/api/admin/holidays', requireAdmin, async (req, res) => {
  try {
    res.json({ ok: true, holiday: await rules.createHoliday(req.body || {}) });
  } catch (e) { badRequest(res, e); }
});

// ── ADMIN: sales, cost and profit ────────────────────────────────────────
app.post('/api/admin/purchase', requireAdmin, async (req, res) => {
  const { customerId, title, amount, currency, channel, invoiceRef, costUsd, discountUsd } = req.body || {};
  if (!customerId || !amount) return res.status(400).json({ error: 'customerId & amount required' });
  const cur = currency || 'USD';
  const amountUsd = toUsd(Number(amount), cur);
  const hasCost = costUsd !== undefined && costUsd !== null && costUsd !== '';

  const info = await db.prepare(`INSERT INTO purchases
    (customer_id,title,amount_usd,orig_amount,orig_currency,source_channel,invoice_ref,discount_usd,cost_usd,cost_entered_at,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(customerId, title || 'Покупка', amountUsd, Number(amount), cur, channel || null,
      invoiceRef || null, Number(discountUsd || 0),
      hasCost ? Number(costUsd) : null, hasCost ? now() : null, now());
  await db.prepare('INSERT INTO events (customer_id,type,meta,created_at) VALUES (?,?,?,?)').run(customerId, 'purchase', title || '', now());

  res.json({
    ok: true,
    purchaseId: Number(info.lastInsertRowid),
    loyalty: await loyaltyFor(customerId),
    costMissing: !hasCost,
  });
});

app.post('/api/admin/purchases/:id/cost', requireAdmin, async (req, res) => {
  try {
    const result = await profit.setCost(Number(req.params.id), { costUsd: req.body?.costUsd, note: req.body?.note || null });
    if (!result) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, margin: result });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

app.get('/api/admin/profit', requireAdmin, async (req, res) => {
  res.json(await profit.stats({ from: req.query.from || null, to: req.query.to || null, limit: req.query.limit }));
});

app.get('/api/admin/pending-costs', requireAdmin, async (req, res) => {
  res.json({ pending: await profit.pendingCosts(Date.now(), { graceHours: Number(req.query.graceHours) || 24 }) });
});

// ── ADMIN: inquiries (Dasha's queue) + popularity ────────────────────────
app.get('/api/admin/inquiries', requireAdmin, async (req, res) => {
  res.json({ inquiries: await cart.listInquiries({ status: req.query.status || null, limit: req.query.limit }) });
});

app.patch('/api/admin/inquiries/:id', requireAdmin, async (req, res) => {
  try {
    const ok = await cart.setInquiryStatus(Number(req.params.id), { status: req.body?.status, by: tgid(req) || null });
    if (!ok) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// period=month|year|all, or explicit from/to — the same endpoint answers both
// "какие сумки популярны в этом месяце" and "за год".
app.get('/api/admin/popular', requireAdmin, async (req, res) => {
  const opts = {
    period: req.query.period || 'month',
    from: req.query.from || null,
    to: req.query.to || null,
    channel: req.query.channel || null,
  };
  res.json({
    ...(await cart.popularityStats(opts)),
    items: (await cart.popularItems({ ...opts, limit: req.query.limit })).items,
  });
});

// ── ADMIN: the catalogue card ────────────────────────────────────────────
//
// A channel post is prose plus a photo — Maryna writes "В наявності в США,
// розмір 38", not "Chanel · взуття". The parser guesses; this is where a human
// corrects the guess. The original text is never overwritten (it stays in
// `body`), so a correction is always reversible.
app.get('/api/admin/posts', requireAdmin, async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 40, 1), 200);
  const rows = req.query.channel && req.query.channel !== 'all'
    ? await db.prepare('SELECT * FROM posts WHERE channel=? ORDER BY created_at DESC LIMIT ?').all(req.query.channel, limit)
    : await db.prepare('SELECT * FROM posts ORDER BY created_at DESC LIMIT ?').all(limit);
  res.json({ posts: await Promise.all(rows.map(shapePost)) });
});

app.patch('/api/admin/posts/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const post = await db.prepare('SELECT * FROM posts WHERE id=?').get(id);
  if (!post) return res.status(404).json({ error: 'not found' });

  const { title, brand, category, article, price, currency, status } = req.body || {};
  if (status && !['published', 'hidden'].includes(status)) {
    return res.status(400).json({ error: 'status must be published|hidden' });
  }
  const clean = (v, max = 120) => (v === undefined || v === null ? null : String(v).trim().slice(0, max) || null);

  await db.prepare(`UPDATE posts SET
      title    = COALESCE(?, title),
      brand    = COALESCE(?, brand),
      category = COALESCE(?, category),
      article  = COALESCE(?, article),
      price    = COALESCE(?, price),
      currency = COALESCE(?, currency),
      status   = COALESCE(?, status),
      edited_at = ?
    WHERE id=?`)
    .run(clean(title), clean(brand, 40), clean(category, 40), clean(article, 40),
      price === undefined || price === '' || price === null ? null : Number(price),
      clean(currency, 4), status || null, now(), id);

  res.json({ ok: true, post: await shapePost(await db.prepare('SELECT * FROM posts WHERE id=?').get(id)) });
});

// ── ADMIN: channels ──────────────────────────────────────────────────────
app.get('/api/admin/channels', requireAdmin, async (req, res) => {
  res.json({ channels: await listChannels({ includeDisabled: true }) });
});

app.patch('/api/admin/channels/:key', requireAdmin, async (req, res) => {
  const { enabled, title, emoji, kind } = req.body || {};
  const existing = await getChannel(req.params.key);
  if (!existing) return res.status(404).json({ error: 'not found' });
  await db.prepare('UPDATE channels SET enabled=COALESCE(?,enabled), title=COALESCE(?,title), emoji=COALESCE(?,emoji), kind=COALESCE(?,kind) WHERE key=?')
    .run(enabled === undefined ? null : Boolean(enabled), title ?? null, emoji ?? null, kind ?? null, req.params.key);
  res.json({ ok: true, channel: await getChannel(req.params.key) });
});

// ── ADMIN: posting, promos, campaigns, reports ───────────────────────────
app.post('/api/admin/post', requireAdmin, async (req, res) => {
  try {
    const { channel, title, body, price, currency, article, photoUrl } = req.body || {};
    if (!channel || !title) return res.status(400).json({ error: 'channel & title required' });
    const result = await publishPost({
      channel, title, body, price: price ? Number(price) : null, currency, article, photoUrl,
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post('/api/admin/promo', requireAdmin, async (req, res) => {
  const { customerId, mode = 'percent', value, percent, reason, days, minOrderUsd } = req.body || {};
  const amount = Number(value ?? percent ?? 10);
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'value must be positive' });
  if (mode === 'percent' && amount > 90) return res.status(400).json({ error: 'percent must be <= 90' });

  const code = `W2B-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  const exp = days ? new Date(Date.now() + Number(days) * 86400000).toISOString() : null;
  const info = await db.prepare(`INSERT INTO promo_codes
      (customer_id,code,percent,mode,amount_usd,min_order_usd,reason,status,created_at,expires_at)
      VALUES (?,?,?,?,?,?,?, 'active',?,?)`)
    .run(customerId || null, code, mode === 'percent' ? Math.round(amount) : 0, mode,
      mode === 'fixed' ? amount : null, Number(minOrderUsd || 0), reason || '', now(), exp);

  if (customerId) {
    const label = mode === 'percent' ? `${amount}%` : `$${amount}`;
    await db.prepare(`INSERT INTO notifications
      (customer_id,kind,title,body,promo_code_id,dedupe_key,in_app_status,dm_status,created_at)
      VALUES (?,?,?,?,?,?, 'unread','skipped',?)
      ON CONFLICT (dedupe_key) DO NOTHING`)
      .run(customerId, 'new_discount', `Ваша знижка ${label} готова`,
        `Промокод ${code}${reason ? ` · ${reason}` : ''}`, Number(info.lastInsertRowid),
        `promo:${code}`, now());
  }
  res.json({ ok: true, code });
});

app.get('/api/admin/campaigns', requireAdmin, async (req, res) => {
  res.json(await campaigns.list({ status: req.query.status, limit: req.query.limit }));
});

app.post('/api/admin/campaigns', requireAdmin, async (req, res) => {
  try {
    res.json({ ok: true, campaign: await campaigns.create({ ...req.body, createdBy: tgid(req) || null }) });
  } catch (e) { badRequest(res, e); }
});

app.patch('/api/admin/campaigns/:id', requireAdmin, async (req, res) => {
  try {
    const updated = await campaigns.update(Number(req.params.id), req.body || {});
    if (!updated) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, campaign: updated });
  } catch (e) { badRequest(res, e); }
});

app.post('/api/admin/campaigns/:id/materialize', requireAdmin, async (req, res) => {
  const result = await campaigns.materialize(Number(req.params.id));
  if (!result) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true, ...result });
});

app.get('/api/admin/alerts', requireAdmin, async (req, res) => {
  res.json({ alerts: await adminAlerts({ limit: req.query.limit }) });
});

// Scheduler status + a manual/cron-callable (await tick (serverless hosts have no
// long-lived process, so the same jobs are reachable over HTTP)).
app.get('/api/admin/scheduler', requireAdmin, (req, res) => res.json({ ...scheduler.status(), polling: polling.status() }));
app.post('/api/admin/tick', requireAdmin, async (req, res) => res.json(await scheduler.tick()));

app.get('/api/admin/report', requireAdmin, async (req, res) => {
  res.json(await buildReport(req.query.period === 'week' ? 'week' : 'day'));
});
app.post('/api/admin/report/send', requireAdmin, async (req, res) => {
  res.json(await sendReport(req.body?.period === 'week' ? 'week' : 'day'));
});

// ── Telegram webhook: CHANNEL → APP ────────────────────────────────────────
app.post('/telegram/webhook', async (req, res) => {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && req.get('x-telegram-bot-api-secret-token') !== secret) return res.sendStatus(401);
  // Telegram retries anything that is not a fast 200, so the ack goes first and
  // the work is best-effort: a bad update must never stall the channel bridge.
  res.sendStatus(200);
  try { await ingestChannelPost(req.body); } catch { /* swallow — never break TG */ }
  // Telegram must get its 200 immediately; the reply is fire-and-forget, so the
  // promise is not awaited and .catch() stays on the promise itself.
  void Promise.resolve(handleMessage(req.body)).catch(() => {});
});

// Bot / webhook diagnostics for the owner: "is the bot really an admin of this
// channel?" answered without waiting for someone to await post.
app.get('/api/admin/telegram', requireAdmin, async (req, res) => {
  try {
    const [me, hook] = await Promise.all([await botInfo(), await webhookInfo()]);
    const channels = await listChannels({ includeDisabled: true });
    const checks = await Promise.all(channels.map(async (c) => {
      const target = c.chatId || c.username;
      if (!target) return { key: c.key, title: c.title, bound: false, error: 'no username/chat_id' };
      try {
        const info = await checkChannelAccess(target);
        // Seeing the chat means the bot is in it; store the numeric id so
        // private channels and username changes keep working.
        if (!c.chatId && info.id) {
          await db.prepare('UPDATE channels SET chat_id=? WHERE key=?').run(String(info.id), c.key);
        }
        return { key: c.key, title: c.title, bound: true, chatId: info.id, username: info.username };
      } catch (e) {
        return { key: c.key, title: c.title, bound: false, error: String(e.message || e) };
      }
    }));
    res.json({ bot: me, webhook: hook, channels: checks, live: liveMode() });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

// ── errors ─────────────────────────────────────────────────────────────────
// The terminus for anything wrapAsync catches. Registered after every route so
// it sees their failures. A database error must not reach the client verbatim —
// it can carry table and column names — but it must reach the log in full.
app.use((err, _req, res, _next) => {
  console.error('[api] unhandled:', err?.stack || err);
  if (res.headersSent) return;
  const validation = err instanceof rules.RuleValidationError
    || err instanceof campaigns.CampaignValidationError;
  res.status(validation ? 400 : 500)
    .json({ error: validation ? String(err.message) : 'internal error' });
});

// ── helpers ────────────────────────────────────────────────────────────────
function safeJson(s) {
  return asJson(s);
}

function shapePromo(p) {
  const mode = p.mode || 'percent';
  return {
    id: p.id,
    code: p.code,
    mode,
    value: mode === 'fixed' ? p.amount_usd : p.percent,
    label: mode === 'fixed' ? `$${p.amount_usd}` : `${p.percent}%`,
    minOrderUsd: p.min_order_usd || 0,
    reason: p.reason,
    ruleKey: p.rule_key,
    status: p.status,
    expiresAt: p.expires_at,
    createdAt: p.created_at,
  };
}

// On a serverless host (Vercel) the platform owns the listener and imports the
// app as a handler, so binding a port there would be wrong. Everywhere else we
// listen ourselves.
if (!process.env.VERCEL) {
  await scheduler.start();
  // Long polling is the no-public-URL path: post in the channel, see the card.
  if (process.env.W2B_TELEGRAM_POLLING === '1') {
    void polling.start().catch((e) => console.error('[polling] start failed:', e.message));
  }
  app.listen(PORT, () => {
    console.log(`\n  Way2Buy Mini App → http://localhost:${PORT}`);
    console.log(`  mode: ${liveMode() ? 'LIVE (bot token set)' : 'DEMO (simulated Telegram)'} · admin: ${DEMO ? 'open (demo)' : `${ADMIN_IDS.length} ids`}\n`);
  });
}

export default app;
