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
} from './telegram.js';
import { buildReport, sendReport } from './ai.js';
import * as campaigns from './campaigns.js';
import * as rules from './rules.js';
import * as birthday from './birthday.js';
import * as profit from './profit.js';
import * as cart from './cart.js';
import * as scheduler from './scheduler.js';
import { adminAlerts } from './notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
init();

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, '..', 'public')));

const PORT = process.env.PORT || 4010;
const ADMIN_IDS = (process.env.ADMIN_TG_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
const DEMO = ADMIN_IDS.length === 0; // no admins configured ⇒ open demo mode

// ── FX: normalise everything to USD ────────────────────────────────────────
const RATE = { USD: 1, EUR: 1.08, UAH: 1 / 41 };
const toUsd = (amount, currency) => Math.round(amount * (RATE[currency] ?? 1) * 100) / 100;

// ── identity helpers ───────────────────────────────────────────────────────
// Demo: identity comes from ?tgid= (frontend supplies it). In production this
// is replaced by Telegram initData HMAC validation — the shape stays the same.
const tgid = (req) => String(req.query.tgid || req.body?.tgid || '').trim();
const findCustomer = (id) => db.prepare('SELECT * FROM customers WHERE tg_user_id=?').get(id);
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

const customerCard = (c) => ({
  id: c.id, tgId: c.tg_user_id, name: c.name, login: c.login,
  phone: c.phone, address: c.address, birthday: c.birthday,
  birthdaySource: c.birthday_source,
  // email/city stay in the row for existing data but are no longer collected —
  // Maryna asked for name / address / phone / birthday only.
  loyalty: loyaltyFor(c.id),
});

// ── config ─────────────────────────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  const cashback = cashbackRule();
  res.json({
    channels: listChannels(),
    rules: rules.listRules(),
    cashback: {
      mode: cashback.mode,
      value: Number(cashback.value),
      minOrderUsd: Number(cashback.min_order_usd ?? 0),
      capUsd: cashback.cap_usd ?? null,
      enabled: Boolean(cashback.enabled),
    },
    holidays: rules.activeHolidays(),
    // The client UI stays deliberately bare: two bonuses, no tiers/badges/
    // streaks. The data still exists for the admin view.
    // Dasha is the human every price question ends at. The Mini App never
    // replaces her — it only pre-writes the message.
    support: { username: (process.env.SUPPORT_USERNAME || 'daschamelnyk').replace(/^@/, '') },
    features: { tiers: false, badges: false, streak: false, aiChat: false },
    tiers: TIERS,
    live: liveMode(),
    demo: DEMO,
  });
});

// ── me / register ────────────────────────────────────────────────────────
app.get('/api/me', (req, res) => {
  const c = findCustomer(tgid(req));
  if (!c) return res.json({ registered: false, admin: isAdmin(req) });
  res.json({
    registered: true,
    admin: isAdmin(req),
    customer: customerCard(c),
    birthday: birthday.birthdayStatus(c),
    cartCount: cart.cartCount(c.id),
  });
});

app.post('/api/register', (req, res) => {
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

  const exists = findCustomer(id);
  if (exists) {
    // A birthday already on file is NOT overwritten by a profile edit — it is
    // the value every future discount request is checked against. Changing it
    // is an admin action (see /api/admin/customers/:id/birthday).
    const keepBday = exists.birthday || storedBday;
    db.prepare('UPDATE customers SET name=?,phone=?,address=?,birthday=?,city=COALESCE(?,city),consent=? WHERE id=?')
      .run(name, phone || null, address || null, keepBday, city || null, consent ? 1 : 0, exists.id);
    if (!exists.birthday && storedBday) {
      db.prepare('UPDATE customers SET birthday_source=?, birthday_recorded_at=? WHERE id=?')
        .run('claim', now(), exists.id);
    }
    const fresh = findCustomer(id);
    return res.json({ registered: true, customer: customerCard(fresh), birthday: birthday.birthdayStatus(fresh) });
  }

  const info = db.prepare(`INSERT INTO customers
      (tg_user_id,login,name,phone,address,birthday,birthday_source,birthday_recorded_at,city,consent,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, req.body.login || null, name, phone || null, address || null,
      storedBday, storedBday ? 'claim' : null, storedBday ? now() : null,
      city || null, consent ? 1 : 0, now());
  db.prepare('INSERT INTO events (customer_id,type,created_at) VALUES (?,?,?)').run(info.lastInsertRowid, 'join', now());
  const fresh = findCustomer(id);
  res.json({ registered: true, customer: customerCard(fresh), birthday: birthday.birthdayStatus(fresh) });
});

// ── birthday discount: record → verify → grant ───────────────────────────
app.get('/api/birthday', (req, res) => {
  const c = findCustomer(tgid(req));
  if (!c) return res.json({ registered: false });
  res.json({ registered: true, ...birthday.birthdayStatus(c), history: birthday.claimsFor(c.id) });
});

app.post('/api/birthday/claim', (req, res) => {
  const c = findCustomer(tgid(req));
  if (!c) return res.status(404).json({ error: 'not registered' });
  try {
    const result = birthday.claimBirthdayDiscount({ customer: c, birthdayInput: req.body?.birthday });
    res.status(result.ok ? 200 : 409).json({ ...result, status: birthday.birthdayStatus(findCustomer(tgid(req))) });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ── feed (all channels) ────────────────────────────────────────────────────
const shapePost = (p) => ({
  ...p,
  photos: safeJson(p.photos_json) || [],
  photoUrls: (safeJson(p.photos_json) || []).map((fid) => `/api/photo/${encodeURIComponent(fid)}`),
  channelMeta: getChannel(p.channel),
});

// Two surfaces over one table:
//   ?kind=catalog → the ~15 catalogues the client browses and filters by
//   ?kind=main    → the main channel's posts, i.e. "стрічка каналу"
//   ?channel=key  → one specific catalogue
// The client also gets `inCart` per post so «Хочу» renders in the right state
// without a second request.
app.get('/api/feed', (req, res) => {
  const ch = req.query.channel;
  const kind = req.query.kind;
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);

  let rows;
  if (ch && ch !== 'all') {
    rows = db.prepare("SELECT * FROM posts WHERE channel=? AND status='published' ORDER BY created_at DESC LIMIT ?").all(ch, limit);
  } else if (kind === 'main' || kind === 'catalog') {
    const keys = listChannels().filter((c) => c.kind === kind).map((c) => c.key);
    if (!keys.length) return res.json({ posts: [] });
    rows = db.prepare(
      `SELECT * FROM posts WHERE status='published' AND channel IN (${keys.map(() => '?').join(',')})
        ORDER BY created_at DESC LIMIT ?`
    ).all(...keys, limit);
  } else {
    rows = db.prepare("SELECT * FROM posts WHERE status='published' ORDER BY created_at DESC LIMIT ?").all(limit);
  }

  const customer = findCustomer(tgid(req));
  const inCart = new Set(
    customer
      ? db.prepare("SELECT post_id FROM cart_items WHERE customer_id=? AND status='active'")
          .all(customer.id).map((r) => r.post_id)
      : []
  );
  res.json({ posts: rows.map((p) => ({ ...shapePost(p), inCart: inCart.has(p.id) })) });
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

app.post('/api/interest', (req, res) => {
  const c = findCustomer(tgid(req));
  const { postId, type } = req.body || {};
  db.prepare('INSERT INTO events (customer_id,post_id,type,created_at) VALUES (?,?,?,?)')
    .run(c?.id || null, postId || null, type || 'want', now());
  res.json({ ok: true });
});

// ── примірочна: add → look → send to Dasha ───────────────────────────────
app.get('/api/cart', (req, res) => {
  const c = findCustomer(tgid(req));
  if (!c) return res.json({ items: [], count: 0, basket: { totalUsd: 0 }, promo: null, draft: '' });
  res.json(cart.cartView(c.id));
});

app.post('/api/cart/add', (req, res) => {
  const c = findCustomer(tgid(req));
  if (!c) return res.status(404).json({ error: 'not registered' });
  const result = cart.addToCart({ customerId: c.id, postId: Number(req.body?.postId) });
  if (!result.ok) return res.status(404).json({ error: result.error });
  // The tap is also a plain interest event, so the older reports keep working.
  db.prepare('INSERT INTO events (customer_id,post_id,type,created_at) VALUES (?,?,?,?)')
    .run(c.id, Number(req.body?.postId) || null, 'want', now());
  res.json(result);
});

app.post('/api/cart/remove', (req, res) => {
  const c = findCustomer(tgid(req));
  if (!c) return res.status(404).json({ error: 'not registered' });
  const result = cart.removeFromCart({ customerId: c.id, itemId: Number(req.body?.itemId) });
  if (!result.ok) return res.status(404).json({ error: result.error });
  res.json(result);
});

// One button: the message is already written, the coupon is already attached.
app.post('/api/cart/send', (req, res) => {
  const c = findCustomer(tgid(req));
  if (!c) return res.status(404).json({ error: 'not registered' });
  const result = cart.sendInquiry({ customer: c, message: req.body?.message || '' });
  if (!result.ok) return res.status(409).json(result);
  res.json(result);
});

// ── purchases + cashback ────────────────────────────────────────────────
app.get('/api/purchases', (req, res) => {
  const c = findCustomer(tgid(req));
  if (!c) return res.json({ purchases: [] });
  const rows = db.prepare('SELECT * FROM purchases WHERE customer_id=? ORDER BY created_at DESC LIMIT 100').all(c.id);
  const promos = db.prepare("SELECT * FROM promo_codes WHERE customer_id=? AND status='active' ORDER BY created_at DESC LIMIT 50").all(c.id);
  res.json({
    // Cost/profit columns are admin-only data — the client sees what they paid.
    purchases: rows.map((p) => ({
      id: p.id, title: p.title, amount_usd: p.amount_usd, orig_amount: p.orig_amount,
      orig_currency: p.orig_currency, discount_usd: p.discount_usd, status: p.status,
      source_channel: p.source_channel, created_at: p.created_at,
    })),
    promos: promos.map(shapePromo),
    loyalty: loyaltyFor(c.id),
  });
});

app.post('/api/redeem', (req, res) => {
  const c = findCustomer(tgid(req));
  if (!c) return res.status(404).json({ error: 'not registered' });
  const l = loyaltyFor(c.id);
  const amount = Math.min(Number(req.body?.amount || l.cashbackAvailable), l.cashbackAvailable);
  if (amount <= 0) return res.status(400).json({ error: 'nothing to redeem' });
  db.prepare('INSERT INTO redemptions (customer_id,amount_usd,note,created_at) VALUES (?,?,?,?)')
    .run(c.id, amount, 'Списано клієнтом у Mini App', now());
  res.json({ ok: true, loyalty: loyaltyFor(c.id) });
});

// ── discounts (the cards the client sees) ─────────────────────────────────
app.get('/api/discounts', (req, res) => {
  const c = findCustomer(tgid(req));
  const base = campaigns.discountsFor(c?.id || null);
  res.json({
    ...base,
    birthday: c ? birthday.birthdayStatus(c) : null,
    holidays: rules.activeHolidays(),
  });
});

// ── notifications (in-app feed is authoritative — see ADR-005) ───────────
app.get('/api/notifications', (req, res) => {
  const c = findCustomer(tgid(req));
  if (!c) return res.json({ notifications: [], unread: 0 });
  const rows = db.prepare(
    `SELECT id, kind, title, body, in_app_status, created_at
       FROM notifications WHERE customer_id=? ORDER BY created_at DESC LIMIT 50`,
  ).all(c.id);
  res.json({ notifications: rows, unread: rows.filter((r) => r.in_app_status === 'unread').length });
});

app.post('/api/notifications/read', (req, res) => {
  const c = findCustomer(tgid(req));
  if (!c) return res.json({ ok: true });
  db.prepare("UPDATE notifications SET in_app_status='read', read_at=? WHERE customer_id=? AND in_app_status='unread'")
    .run(now(), c.id);
  res.json({ ok: true });
});

// ── demo profile switcher (only exposed while no admins are configured) ───
app.get('/api/demo/profiles', (req, res) => {
  if (!DEMO) return res.status(404).json({ error: 'not available' });
  const rows = db.prepare('SELECT tg_user_id, name FROM customers ORDER BY id').all();
  res.json({ profiles: rows.map((r) => ({ tgId: r.tg_user_id, name: r.name })) });
});

// ── ADMIN: clients ───────────────────────────────────────────────────────
app.get('/api/admin/customers', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM customers ORDER BY created_at DESC LIMIT 500').all();
  const snaps = snapshotBatch(rows.map((r) => r.id));
  res.json({ customers: rows.map((c) => ({ ...customerCard(c), loyalty: snaps[c.id] })) });
});

// Correcting a birthday is deliberately an admin-only action: the stored date
// is what every future discount request is verified against.
app.post('/api/admin/customers/:id/birthday', requireAdmin, (req, res) => {
  const parsed = birthday.parseBirthday(req.body?.birthday);
  if (!parsed) return res.status(400).json({ error: 'invalid birthday' });
  const stored = `${parsed.year || 1900}-${birthday.mmdd(parsed)}`;
  const info = db.prepare('UPDATE customers SET birthday=?, birthday_source=?, birthday_recorded_at=? WHERE id=?')
    .run(stored, 'admin', now(), Number(req.params.id));
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true, birthday: stored });
});

app.get('/api/admin/birthday-claims', requireAdmin, (req, res) => {
  res.json({ claims: birthday.allClaims({ limit: req.query.limit, verdict: req.query.verdict || null }) });
});

// ── ADMIN: bonus rules — the $ ⇄ % switch ────────────────────────────────
app.get('/api/admin/rules', requireAdmin, (req, res) => {
  res.json({ rules: rules.listRules(), holidays: rules.listHolidays(), activeHolidays: rules.activeHolidays() });
});

app.patch('/api/admin/rules/:key', requireAdmin, (req, res) => {
  try {
    const updated = rules.updateRule(req.params.key, req.body || {}, tgid(req) || null);
    if (!updated) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, rule: updated });
  } catch (e) { badRequest(res, e); }
});

app.get('/api/admin/holidays', requireAdmin, (req, res) => {
  res.json({ holidays: rules.listHolidays(), active: rules.activeHolidays() });
});

app.patch('/api/admin/holidays/:id', requireAdmin, (req, res) => {
  try {
    const updated = rules.updateHoliday(Number(req.params.id), req.body || {}, tgid(req) || null);
    if (!updated) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, holiday: updated });
  } catch (e) { badRequest(res, e); }
});

app.post('/api/admin/holidays', requireAdmin, (req, res) => {
  try {
    res.json({ ok: true, holiday: rules.createHoliday(req.body || {}) });
  } catch (e) { badRequest(res, e); }
});

// ── ADMIN: sales, cost and profit ────────────────────────────────────────
app.post('/api/admin/purchase', requireAdmin, (req, res) => {
  const { customerId, title, amount, currency, channel, invoiceRef, costUsd, discountUsd } = req.body || {};
  if (!customerId || !amount) return res.status(400).json({ error: 'customerId & amount required' });
  const cur = currency || 'USD';
  const amountUsd = toUsd(Number(amount), cur);
  const hasCost = costUsd !== undefined && costUsd !== null && costUsd !== '';

  const info = db.prepare(`INSERT INTO purchases
    (customer_id,title,amount_usd,orig_amount,orig_currency,source_channel,invoice_ref,discount_usd,cost_usd,cost_entered_at,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(customerId, title || 'Покупка', amountUsd, Number(amount), cur, channel || null,
      invoiceRef || null, Number(discountUsd || 0),
      hasCost ? Number(costUsd) : null, hasCost ? now() : null, now());
  db.prepare('INSERT INTO events (customer_id,type,meta,created_at) VALUES (?,?,?,?)').run(customerId, 'purchase', title || '', now());

  res.json({
    ok: true,
    purchaseId: Number(info.lastInsertRowid),
    loyalty: loyaltyFor(customerId),
    costMissing: !hasCost,
  });
});

app.post('/api/admin/purchases/:id/cost', requireAdmin, (req, res) => {
  try {
    const result = profit.setCost(Number(req.params.id), { costUsd: req.body?.costUsd, note: req.body?.note || null });
    if (!result) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, margin: result });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

app.get('/api/admin/profit', requireAdmin, (req, res) => {
  res.json(profit.stats({ from: req.query.from || null, to: req.query.to || null, limit: req.query.limit }));
});

app.get('/api/admin/pending-costs', requireAdmin, (req, res) => {
  res.json({ pending: profit.pendingCosts(Date.now(), { graceHours: Number(req.query.graceHours) || 24 }) });
});

// ── ADMIN: inquiries (Dasha's queue) + popularity ────────────────────────
app.get('/api/admin/inquiries', requireAdmin, (req, res) => {
  res.json({ inquiries: cart.listInquiries({ status: req.query.status || null, limit: req.query.limit }) });
});

app.patch('/api/admin/inquiries/:id', requireAdmin, (req, res) => {
  try {
    const ok = cart.setInquiryStatus(Number(req.params.id), { status: req.body?.status, by: tgid(req) || null });
    if (!ok) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// period=month|year|all, or explicit from/to — the same endpoint answers both
// "какие сумки популярны в этом месяце" and "за год".
app.get('/api/admin/popular', requireAdmin, (req, res) => {
  const opts = {
    period: req.query.period || 'month',
    from: req.query.from || null,
    to: req.query.to || null,
    channel: req.query.channel || null,
  };
  res.json({
    ...cart.popularityStats(opts),
    items: cart.popularItems({ ...opts, limit: req.query.limit }).items,
  });
});

// ── ADMIN: channels ──────────────────────────────────────────────────────
app.get('/api/admin/channels', requireAdmin, (req, res) => {
  res.json({ channels: listChannels({ includeDisabled: true }) });
});

app.patch('/api/admin/channels/:key', requireAdmin, (req, res) => {
  const { enabled, title, emoji, kind } = req.body || {};
  const existing = getChannel(req.params.key);
  if (!existing) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE channels SET enabled=COALESCE(?,enabled), title=COALESCE(?,title), emoji=COALESCE(?,emoji), kind=COALESCE(?,kind) WHERE key=?')
    .run(enabled === undefined ? null : (enabled ? 1 : 0), title ?? null, emoji ?? null, kind ?? null, req.params.key);
  res.json({ ok: true, channel: getChannel(req.params.key) });
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

app.post('/api/admin/promo', requireAdmin, (req, res) => {
  const { customerId, mode = 'percent', value, percent, reason, days, minOrderUsd } = req.body || {};
  const amount = Number(value ?? percent ?? 10);
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'value must be positive' });
  if (mode === 'percent' && amount > 90) return res.status(400).json({ error: 'percent must be <= 90' });

  const code = `W2B-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  const exp = days ? new Date(Date.now() + Number(days) * 86400000).toISOString() : null;
  const info = db.prepare(`INSERT INTO promo_codes
      (customer_id,code,percent,mode,amount_usd,min_order_usd,reason,status,created_at,expires_at)
      VALUES (?,?,?,?,?,?,?, 'active',?,?)`)
    .run(customerId || null, code, mode === 'percent' ? Math.round(amount) : 0, mode,
      mode === 'fixed' ? amount : null, Number(minOrderUsd || 0), reason || '', now(), exp);

  if (customerId) {
    const label = mode === 'percent' ? `${amount}%` : `$${amount}`;
    db.prepare(`INSERT OR IGNORE INTO notifications
      (customer_id,kind,title,body,promo_code_id,dedupe_key,in_app_status,dm_status,created_at)
      VALUES (?,?,?,?,?,?, 'unread','skipped',?)`)
      .run(customerId, 'new_discount', `Ваша знижка ${label} готова`,
        `Промокод ${code}${reason ? ` · ${reason}` : ''}`, Number(info.lastInsertRowid),
        `promo:${code}`, now());
  }
  res.json({ ok: true, code });
});

app.get('/api/admin/campaigns', requireAdmin, (req, res) => {
  res.json(campaigns.list({ status: req.query.status, limit: req.query.limit }));
});

app.post('/api/admin/campaigns', requireAdmin, (req, res) => {
  try {
    res.json({ ok: true, campaign: campaigns.create({ ...req.body, createdBy: tgid(req) || null }) });
  } catch (e) { badRequest(res, e); }
});

app.patch('/api/admin/campaigns/:id', requireAdmin, (req, res) => {
  try {
    const updated = campaigns.update(Number(req.params.id), req.body || {});
    if (!updated) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, campaign: updated });
  } catch (e) { badRequest(res, e); }
});

app.post('/api/admin/campaigns/:id/materialize', requireAdmin, (req, res) => {
  const result = campaigns.materialize(Number(req.params.id));
  if (!result) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true, ...result });
});

app.get('/api/admin/alerts', requireAdmin, (req, res) => {
  res.json({ alerts: adminAlerts({ limit: req.query.limit }) });
});

// Scheduler status + a manual/cron-callable tick (serverless hosts have no
// long-lived process, so the same jobs are reachable over HTTP).
app.get('/api/admin/scheduler', requireAdmin, (req, res) => res.json(scheduler.status()));
app.post('/api/admin/tick', requireAdmin, (req, res) => res.json(scheduler.tick()));

app.get('/api/admin/report', requireAdmin, async (req, res) => {
  res.json(await buildReport(req.query.period === 'week' ? 'week' : 'day'));
});
app.post('/api/admin/report/send', requireAdmin, async (req, res) => {
  res.json(await sendReport(req.body?.period === 'week' ? 'week' : 'day'));
});

// ── Telegram webhook: CHANNEL → APP ────────────────────────────────────────
app.post('/telegram/webhook', (req, res) => {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && req.get('x-telegram-bot-api-secret-token') !== secret) return res.sendStatus(401);
  try { ingestChannelPost(req.body); } catch { /* swallow — never break TG */ }
  res.sendStatus(200);
});

// ── helpers ────────────────────────────────────────────────────────────────
function safeJson(s) {
  try { return s ? JSON.parse(s) : null; } catch { return null; }
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
  scheduler.start();
  app.listen(PORT, () => {
    console.log(`\n  Way2Buy Mini App → http://localhost:${PORT}`);
    console.log(`  mode: ${liveMode() ? 'LIVE (bot token set)' : 'DEMO (simulated Telegram)'} · admin: ${DEMO ? 'open (demo)' : `${ADMIN_IDS.length} ids`}\n`);
  });
}

export default app;
