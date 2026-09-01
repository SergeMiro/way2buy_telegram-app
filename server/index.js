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
  listChannels, getChannel, channelMap, liveMode, publishPost, ingestChannelPost, fetchPhoto,
  handleMessage, botInfo, webhookInfo, checkChannelAccess, userProfilePhotoId,
} from './telegram.js';
import { mediaUrl } from './media.js';
import { buildReport, sendReport } from './ai.js';
import * as campaigns from './campaigns.js';
import * as rules from './rules.js';
import * as birthday from './birthday.js';
import * as profit from './profit.js';
import * as cart from './cart.js';
import * as deals from './deals.js';
import * as catalog from './catalog.js';
import * as sync from './sync.js';
import * as scheduler from './scheduler.js';
import * as polling from './polling.js';
import { adminAlerts } from './notify.js';
import { identify } from './auth.js';
import * as roles from './roles.js';
import * as presets from './presets.js';
import * as analytics from './analytics.js';
import * as abandoned from './abandoned.js';
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

// An empty ADMIN_TG_IDS opens the cabinet to anyone who passes ?admin=1. That is
// deliberate and it is what makes the zero-config demo demonstrable — there is
// nothing in it but seeded data.
//
// On a production deployment the same rule would publish the client list: names,
// phones, delivery addresses, purchase history. So there it fails CLOSED instead
// — no admin ids configured means no admins, and the cabinet is reachable by
// nobody until somebody is named. Forgetting to set a variable must not be the
// thing that opens the door.
const PRODUCTION = process.env.VERCEL_ENV === 'production' || process.env.W2B_ENV === 'production';
const DEMO = ADMIN_IDS.length === 0 && !PRODUCTION;

// «Товари в наявності» — the one catalogue that means "ready to ship". It is
// pinned and highlighted in the UI; the key is overridable because the channel
// could be renamed.
const IN_STOCK_KEY = process.env.IN_STOCK_CHANNEL_KEY || 'available';

// ── FX: normalise everything to USD ────────────────────────────────────────
const RATE = { USD: 1, EUR: 1.08, UAH: 1 / 41 };
const toUsd = (amount, currency) => Math.round(amount * (RATE[currency] ?? 1) * 100) / 100;

// ── identity ───────────────────────────────────────────────────────────────
// Identity used to be a query parameter, which meant `?tgid=<an admin's id>`
// was the whole of the lock on the cabinet. auth.js now checks the HMAC that
// Telegram puts on every Mini App launch; what that answer GATES is decided
// here, in one place:
//
//   • a signature offered that does not hold → 401, always. That is forgery,
//     and there is no reading of it where the request should proceed.
//   • the cabinet → a held signature is REQUIRED. This is the door that was
//     open to anyone who knew a nine-digit number.
//   • ordinary client routes → the signature is used when it is there, and the
//     old parameter still works when it is not. A Mini App already open in
//     somebody's hand is running the previous bundle and does not send one;
//     refusing it would log a client out in the middle of an order to fix a
//     hole that is not in front of them. W2B_REQUIRE_SIGNED=1 closes that
//     fallback, and the warning below is how we know when it is safe to.
const REQUIRE_SIGNED = process.env.W2B_REQUIRE_SIGNED === '1';

app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  const who = identify(req);
  req.w2b = who;

  if (who.tampered) return res.status(401).json({ error: 'invalid initData', reason: who.reason });
  // An identity CLAIMED without a signature. No claim at all (the photo proxy,
  // an anonymous look at the vitrine) is not this case and stays open.
  if (!who.verified && who.id) {
    if (REQUIRE_SIGNED) return res.status(401).json({ error: 'initData required' });
    console.warn(`[auth] unsigned ${req.method} ${req.path}`);
  }
  return next();
});

const tgid = (req) => (req.w2b ? req.w2b.id : '');
const signedIn = (req) => Boolean(req.w2b && req.w2b.verified);
const findCustomer = async (id) => await db.prepare('SELECT * FROM customers WHERE tg_user_id=?').get(id);
// ── authorisation ──────────────────────────────────────────────────────────
// Authentication answered "who". This answers "what may they do", and the two
// are kept apart: a valid signature makes you a person, not an administrator.
//
// Roles live in the database (roles.js) so the owner can appoint somebody
// without a deploy, and every route names the CAPABILITY it needs rather than a
// role — 'discounts.manage', not 'is super admin'. That way the matrix is
// readable in one place and a new route cannot quietly inherit rights by being
// added to the wrong group.
const roleOf = async (req) => {
  // The zero-config demo has no bot token, so there is no signature to check —
  // and nothing behind the door but seeded data. Production never reaches this
  // branch: DEMO is false the moment ADMIN_TG_IDS names anybody.
  if (DEMO && String(req.query.admin || req.body?.admin || '') === '1') return 'super';
  if (!signedIn(req)) return null;
  return await roles.roleOf(tgid(req));
};

const requirePermission = (capability) => async (req, res, next) => {
  if (DEMO && String(req.query.admin || req.body?.admin || '') === '1') return next();
  if (!signedIn(req)) return res.status(403).json({ error: 'admin only' });
  if (!(await roles.can(tgid(req), capability))) {
    // The capability is named in the refusal on purpose: a manager who taps
    // something they may not have should be able to say WHICH right they are
    // missing, and so should the log.
    return res.status(403).json({ error: 'not allowed', need: capability });
  }
  return next();
};

const now = () => new Date().toISOString();
const badRequest = (res, e) => {
  const validation = e instanceof rules.RuleValidationError || e instanceof campaigns.CampaignValidationError
    || e instanceof roles.RoleError;
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
  const role = await roleOf(req);
  // `admin` stays a boolean for older bundles; `role` and `can` are what the
  // cabinet draws itself from, so a manager is never shown a section that would
  // then refuse her.
  const who = { role, can: roles.capabilitiesOf(role) };
  if (!c) return res.json({ registered: false, admin: Boolean(role), ...who });
  res.json({
    registered: true,
    admin: Boolean(role),
    ...who,
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
//
// `channels` is the key → channel map, fetched ONCE per request. Resolving it
// per post costs one query per card, which is invisible on a seeded demo and
// six seconds for sixty cards once the database is a hundred milliseconds away.
const shapePost = (p, channels = {}) => ({
  ...p,
  photos: safeJson(p.photos_json) || [],
  photoUrls: (safeJson(p.photos_json) || []).map(mediaUrl).filter(Boolean),
  channelMeta: channels[p.channel] || null,
});

const shapeOnePost = async (p) => (p ? shapePost(p, await channelMap()) : null);

// Two surfaces over one table:
//   ?kind=catalog → the catalogues the client browses and filters by
//   ?kind=main    → the main channel's posts, i.e. "стрічка каналу"
//   ?channel=key  → one specific catalogue
//   ?brand= &category= → the content filters, offered by /api/facets
//   ?cursor=      → the next page of the same selection
// The client also gets `inCart` per post so «Хочу» renders in the right state
// without a second request.
app.get('/api/feed', async (req, res) => {
  const { rows, nextCursor } = await catalog.listPosts(catalog.selectionFrom(req.query), {
    limit: catalog.clampLimit(req.query.limit),
    cursor: req.query.cursor,
  });

  const customer = await findCustomer(tgid(req));
  const inCart = new Set(
    customer
      ? (await db.prepare("SELECT post_id FROM cart_items WHERE customer_id=? AND status='active'")
          .all(customer.id)).map((r) => r.post_id)
      : []
  );

  const channels = await channelMap();
  res.json({
    posts: rows.map((p) => ({ ...shapePost(p, channels), inCart: inCart.has(p.id) })),
    nextCursor,
  });
});

// What is worth offering as a filter inside the current selection — see
// catalog.js for why this and /api/feed must build their WHERE the same way.
app.get('/api/facets', async (req, res) => {
  res.json(await catalog.facetsFor(catalog.selectionFrom(req.query)));
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

// The support person's own Telegram avatar, proxied. The bot token never
// reaches the browser, and the file id is resolved on each cache miss rather
// than configured — change the photograph in Telegram and the app follows.
//
// 404 when there is nothing to show (no support id, no bot token, or a person
// the bot cannot see because they have never opened it). The client treats that
// as "draw initials", which is why this must not be a 500.
app.get('/api/support/photo', async (req, res) => {
  const id = process.env.SUPPORT_PHOTO_TG_ID || cart.supportIds()[0] || '';
  if (!id) return res.status(404).json({ error: 'no support id configured' });
  try {
    const fileId = await userProfilePhotoId(id);
    if (!fileId) return res.status(404).json({ error: 'no profile photo visible to the bot' });
    const hit = photoCache.get(fileId);
    const send = (file) => res
      .set('content-type', file.contentType)
      // Cached hard at the edge: a face does not change between two taps, and
      // this is fetched on every confirmation card.
      .set('cache-control', 'public, max-age=21600')
      .send(file.buffer);
    if (hit && Date.now() - hit.at < PHOTO_TTL) return send(hit);
    const file = await fetchPhoto(fileId);
    if (!file) return res.status(404).json({ error: 'photos require a bot token' });
    if (photoCache.size > 200) photoCache.clear();
    photoCache.set(fileId, { ...file, at: Date.now() });
    return send(file);
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e) });
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
app.get('/api/admin/customers', requirePermission('customers.read'), async (req, res) => {
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
app.post('/api/admin/customers/:id/birthday', requirePermission('customers.write'), async (req, res) => {
  const parsed = birthday.parseBirthday(req.body?.birthday);
  if (!parsed) return res.status(400).json({ error: 'invalid birthday' });
  const stored = `${parsed.year || 1900}-${birthday.mmdd(parsed)}`;
  const info = await db.prepare('UPDATE customers SET birthday=?, birthday_source=?, birthday_recorded_at=? WHERE id=?')
    .run(stored, 'admin', now(), Number(req.params.id));
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true, birthday: stored });
});

app.get('/api/admin/birthday-claims', requirePermission('customers.read'), async (req, res) => {
  res.json({ claims: await birthday.allClaims({ limit: req.query.limit, verdict: req.query.verdict || null }) });
});

// ── ADMIN: bonus rules — the $ ⇄ % switch ────────────────────────────────
app.get('/api/admin/rules', requirePermission('discounts.manage'), async (req, res) => {
  res.json({ rules: await rules.listRules(), holidays: await rules.listHolidays(), activeHolidays: await rules.activeHolidays() });
});

app.patch('/api/admin/rules/:key', requirePermission('discounts.manage'), async (req, res) => {
  try {
    const updated = await rules.updateRule(req.params.key, req.body || {}, tgid(req) || null);
    if (!updated) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, rule: updated });
  } catch (e) { badRequest(res, e); }
});

app.get('/api/admin/holidays', requirePermission('discounts.manage'), async (req, res) => {
  res.json({ holidays: await rules.listHolidays(), active: await rules.activeHolidays() });
});

app.patch('/api/admin/holidays/:id', requirePermission('discounts.manage'), async (req, res) => {
  try {
    const updated = await rules.updateHoliday(Number(req.params.id), req.body || {}, tgid(req) || null);
    if (!updated) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, holiday: updated });
  } catch (e) { badRequest(res, e); }
});

app.post('/api/admin/holidays', requirePermission('discounts.manage'), async (req, res) => {
  try {
    res.json({ ok: true, holiday: await rules.createHoliday(req.body || {}) });
  } catch (e) { badRequest(res, e); }
});

// ── ADMIN: sales, cost and profit ────────────────────────────────────────
app.post('/api/admin/purchase', requirePermission('purchases.write'), async (req, res) => {
  const { customerId, title, amount, currency, channel, invoiceRef, costUsd, discountUsd, postId } = req.body || {};
  if (!customerId || !amount) return res.status(400).json({ error: 'customerId & amount required' });
  // A sale attached to the card it came from is the only way «what KIND of
  // thing sells» can be answered later without guessing from a title.
  const card = postId ? await db.prepare('SELECT id, title, article, channel FROM posts WHERE id=?').get(postId) : null;
  const cur = currency || 'USD';
  const amountUsd = toUsd(Number(amount), cur);
  const hasCost = costUsd !== undefined && costUsd !== null && costUsd !== '';

  const info = await db.prepare(`INSERT INTO purchases
    (customer_id,title,amount_usd,orig_amount,orig_currency,source_channel,invoice_ref,discount_usd,cost_usd,cost_entered_at,created_at,post_id,article)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(customerId, title || card?.title || 'Покупка', amountUsd, Number(amount), cur,
      channel || card?.channel || null,
      invoiceRef || null, Number(discountUsd || 0),
      hasCost ? Number(costUsd) : null, hasCost ? now() : null, now(),
      card ? card.id : null, card ? card.article : null);
  await db.prepare('INSERT INTO events (customer_id,type,meta,created_at) VALUES (?,?,?,?)').run(customerId, 'purchase', title || '', now());

  res.json({
    ok: true,
    purchaseId: Number(info.lastInsertRowid),
    loyalty: await loyaltyFor(customerId),
    costMissing: !hasCost,
  });
});

app.post('/api/admin/purchases/:id/cost', requirePermission('purchases.write'), async (req, res) => {
  try {
    const result = await profit.setCost(Number(req.params.id), { costUsd: req.body?.costUsd, note: req.body?.note || null });
    if (!result) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, margin: result });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

app.get('/api/admin/profit', requirePermission('profit.read'), async (req, res) => {
  res.json(await profit.stats({ from: req.query.from || null, to: req.query.to || null, limit: req.query.limit }));
});

app.get('/api/admin/pending-costs', requirePermission('profit.read'), async (req, res) => {
  res.json({ pending: await profit.pendingCosts(Date.now(), { graceHours: Number(req.query.graceHours) || 24 }) });
});

// ── ADMIN: inquiries (Dasha's queue) + popularity ────────────────────────
app.get('/api/admin/inquiries', requirePermission('inquiries.read'), async (req, res) => {
  res.json({ inquiries: await cart.listInquiries({ status: req.query.status || null, limit: req.query.limit }) });
});

app.patch('/api/admin/inquiries/:id', requirePermission('inquiries.write'), async (req, res) => {
  try {
    const ok = await cart.setInquiryStatus(Number(req.params.id), { status: req.body?.status, by: tgid(req) || null });
    if (!ok) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// ── ADMIN: deals — «в процесі / купив / не купив» ────────────────────────
//
// One list endpoint for all three tabs (they are one table and one index), and
// one write for both the checkmark and the pencil: recording an outcome and
// correcting a mis-tap are the same operation on purpose. See deals.js.
app.get('/api/admin/deals', requirePermission('deals.read'), async (req, res) => {
  res.json({
    deals: await deals.listDeals({ status: req.query.status || null, limit: req.query.limit }),
    counts: await deals.counts(),
    remindDays: deals.config().days,
  });
});

app.patch('/api/admin/deals/:id', requirePermission('deals.write'), async (req, res) => {
  try {
    const deal = await deals.setStatus(Number(req.params.id), {
      status: req.body?.status,
      amountUsd: req.body?.amountUsd,
      note: req.body?.note,
      by: tgid(req) || null,
    });
    if (!deal) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, deal, counts: await deals.counts() });
  } catch (e) { res.status(e.status || 400).json({ error: String(e.message || e) }); }
});

// period=month|year|all, or explicit from/to — the same endpoint answers both
// "какие сумки популярны в этом месяце" and "за год".
app.get('/api/admin/popular', requirePermission('popular.read'), async (req, res) => {
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
app.get('/api/admin/posts', requirePermission('catalog.read'), async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 40, 1), 200);
  const rows = req.query.channel && req.query.channel !== 'all'
    ? await db.prepare('SELECT * FROM posts WHERE channel=? ORDER BY created_at DESC LIMIT ?').all(req.query.channel, limit)
    : await db.prepare('SELECT * FROM posts ORDER BY created_at DESC LIMIT ?').all(limit);
  const channels = await channelMap();
  res.json({ posts: rows.map((p) => shapePost(p, channels)) });
});

app.patch('/api/admin/posts/:id', requirePermission('catalog.write'), async (req, res) => {
  const id = Number(req.params.id);
  const post = await db.prepare('SELECT * FROM posts WHERE id=?').get(id);
  if (!post) return res.status(404).json({ error: 'not found' });

  const { title, brand, category, article, price, currency, status } = req.body || {};
  if (status && !['published', 'hidden'].includes(status)) {
    return res.status(400).json({ error: 'status must be published|hidden' });
  }
  // Correcting a card marks it curated, and a sync then stops overwriting the
  // three fields that are somebody's judgement rather than the channel's facts.
  // Without this, «Синхронізувати» would undo every correction ever made here.
  const curated = [title, brand, category].some((v) => v !== undefined && v !== null && String(v).trim() !== '');
  const clean = (v, max = 120) => (v === undefined || v === null ? null : String(v).trim().slice(0, max) || null);

  await db.prepare(`UPDATE posts SET
      title    = COALESCE(?, title),
      brand    = COALESCE(?, brand),
      category = COALESCE(?, category),
      article  = COALESCE(?, article),
      price    = COALESCE(?, price),
      currency = COALESCE(?, currency),
      status   = COALESCE(?, status),
      curated  = curated OR ?,
      edited_at = ?
    WHERE id=?`)
    .run(clean(title), clean(brand, 40), clean(category, 40), clean(article, 40),
      price === undefined || price === '' || price === null ? null : Number(price),
      clean(currency, 4), status || null, curated, now(), id);

  res.json({ ok: true, post: await shapeOnePost(await db.prepare('SELECT * FROM posts WHERE id=?').get(id)) });
});

// ── ADMIN: channels ──────────────────────────────────────────────────────
app.get('/api/admin/channels', requirePermission('channels.read'), async (req, res) => {
  const counts = new Map(
    (await db.prepare(`SELECT channel,
        count(*) FILTER (WHERE status = 'published') published,
        count(*) FILTER (WHERE status = 'hidden')    hidden,
        count(*) FILTER (WHERE status = 'gone')      gone
      FROM posts GROUP BY channel`).all())
      .map((r) => [r.channel, {
        published: Number(r.published), hidden: Number(r.hidden), gone: Number(r.gone),
      }])
  );
  const channels = (await listChannels({ includeDisabled: true }))
    .map((c) => ({ ...c, posts: counts.get(c.key) || { published: 0, hidden: 0, gone: 0 } }));
  res.json({ channels });
});

// «Синхронізувати»: make this catalogue match its channel. The channel itself is
// only read — see server/sync.js for why this reconciles instead of emptying the
// catalogue and refilling it.
//
// One call does a few pages and returns where it stopped, because a full channel
// is thousands of pages and this runs inside an HTTP request with a seconds-long
// budget on a serverless host. The client repeats the call while `done` is false;
// the cursor is also stored on the channel, so closing the browser mid-backfill
// loses nothing.
app.post('/api/admin/channels/:key/sync', requirePermission('channels.sync'), async (req, res) => {
  const row = await db.prepare('SELECT * FROM channels WHERE key=?').get(req.params.key);
  if (!row) return res.status(404).json({ error: 'not found' });
  if (!row.username) {
    return res.status(400).json({ error: 'у цього каналу немає @username — читати нічого' });
  }

  const deep = Boolean(req.body?.deep);
  // Bounded per call, and bounded from the client too: a caller cannot ask for a
  // page count that would time the function out.
  const pages = Math.min(Math.max(Number(req.body?.pages) || 4, 1), 12);

  try {
    res.json({ ok: true, ...await sync.syncChannel(row, { deep, pages }) });
  } catch (e) {
    // A channel that has gone private, or Telegram refusing to serve the page,
    // is an answer the admin office should show, not a 500.
    res.status(502).json({ error: String(e.message || e) });
  }
});

// Adding a catalogue is a row in `channels`, so it is a form and not a deploy.
// That matters as the shop grows: ten more channels are coming, and none of them
// should need a developer. The channel is read once here, so a typo or a private
// channel is refused now rather than failing on every sync afterwards.
app.post('/api/admin/channels', requirePermission('channels.manage'), async (req, res) => {
  const { username, title, emoji } = req.body || {};
  if (!username) return res.status(400).json({ error: 'потрібен @username каналу' });
  try {
    const channel = await sync.registerChannel({
      username: String(username).trim(),
      title: title ? String(title).trim().slice(0, 60) : null,
      emoji: emoji ? String(emoji).trim().slice(0, 8) : null,
    });
    res.json({ ok: true, created: channel.created, channel: await getChannel(channel.key) });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

// Which channel the «Канал» tab shows. A switch rather than a setting, because
// it is going to be flipped from the test channel to the real one and back, and
// that must not be a deploy.
app.post('/api/admin/channels/:key/main', requirePermission('channels.manage'), async (req, res) => {
  try {
    const { main, demoted } = await sync.setMainChannel(req.params.key);
    res.json({ ok: true, channel: await getChannel(main.key), demoted });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.patch('/api/admin/channels/:key', requirePermission('channels.manage'), async (req, res) => {
  const { enabled, title, emoji, kind } = req.body || {};
  const existing = await getChannel(req.params.key);
  if (!existing) return res.status(404).json({ error: 'not found' });
  await db.prepare('UPDATE channels SET enabled=COALESCE(?,enabled), title=COALESCE(?,title), emoji=COALESCE(?,emoji), kind=COALESCE(?,kind) WHERE key=?')
    .run(enabled === undefined ? null : Boolean(enabled), title ?? null, emoji ?? null, kind ?? null, req.params.key);
  res.json({ ok: true, channel: await getChannel(req.params.key) });
});

// ── ADMIN: posting, promos, campaigns, reports ───────────────────────────
app.post('/api/admin/post', requirePermission('posts.publish'), async (req, res) => {
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

app.post('/api/admin/promo', requirePermission('discounts.manage'), async (req, res) => {
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

// ── the campaign builder ───────────────────────────────────────────────────
// The ready-made campaigns, with their dates already resolved for the coming
// occurrence — so a card can say «20 груд — 8 січ» before anything is created.
app.get('/api/admin/presets', requirePermission('discounts.manage'), async (req, res) => {
  res.json({ presets: presets.listPresets(), conditions: campaigns.CONDITIONS });
});

// How many customers a set of conditions reaches RIGHT NOW, before saving. This
// is what keeps the builder honest: an audience of nobody is a campaign that
// looks like it worked and gave away nothing.
app.post('/api/admin/campaigns/preview', requirePermission('discounts.manage'), async (req, res) => {
  try {
    res.json(await campaigns.previewAudience(req.body?.audience ?? null));
  } catch (e) { badRequest(res, e); }
});

app.get('/api/admin/campaigns', requirePermission('discounts.manage'), async (req, res) => {
  res.json(await campaigns.list({ status: req.query.status, limit: req.query.limit }));
});

app.post('/api/admin/campaigns', requirePermission('discounts.manage'), async (req, res) => {
  try {
    // A preset fills the form; anything the owner changed on top of it wins.
    const base = req.body?.preset ? presets.expandPreset(req.body.preset) : {};
    if (req.body?.preset && !base) return res.status(400).json({ error: 'unknown preset' });
    const { preset: _p, ...rest } = req.body || {};
    const input = { ...base, ...rest, preset: req.body?.preset || null };
    res.json({ ok: true, campaign: await campaigns.create({ ...input, createdBy: tgid(req) || null }) });
  } catch (e) { badRequest(res, e); }
});

app.patch('/api/admin/campaigns/:id', requirePermission('discounts.manage'), async (req, res) => {
  try {
    const updated = await campaigns.update(Number(req.params.id), req.body || {});
    if (!updated) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, campaign: updated });
  } catch (e) { badRequest(res, e); }
});

app.post('/api/admin/campaigns/:id/materialize', requirePermission('discounts.manage'), async (req, res) => {
  const result = await campaigns.materialize(Number(req.params.id));
  if (!result) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true, ...result });
});

// ── the team ───────────────────────────────────────────────────────────────
// Who works here, and how far in they get. Only a super admin may look at this
// or change it — appointing people is the one power that can hand away every
// other one.
app.get('/api/admin/team', requirePermission('team.manage'), async (req, res) => {
  res.json({ team: await roles.listTeam(), roles: roles.ROLES, permissions: roles.PERMISSIONS });
});

app.post('/api/admin/team', requirePermission('team.manage'), async (req, res) => {
  try {
    res.json({ ok: true, team: await roles.addMember({ ...req.body, by: tgid(req) }) });
  } catch (e) { badRequest(res, e); }
});

app.patch('/api/admin/team/:tgId', requirePermission('team.manage'), async (req, res) => {
  try {
    res.json({ ok: true, team: await roles.setMember({ ...req.body, tgId: req.params.tgId, by: tgid(req) }) });
  } catch (e) { badRequest(res, e); }
});

app.delete('/api/admin/team/:tgId', requirePermission('team.manage'), async (req, res) => {
  try {
    res.json({ ok: true, team: await roles.removeMember(req.params.tgId) });
  } catch (e) { badRequest(res, e); }
});

// ── analytics: the gap between «додав» and «спитав» ────────────────────────
// Readable by the manager as well as the owner: knowing what clients are
// reaching for is her job too, and none of it carries cost or margin.
app.get('/api/admin/analytics', requirePermission('popular.read'), async (req, res) => {
  const months = Math.min(Math.max(Number(req.query.months) || 6, 1), 24);
  const [funnel, items, byCategory, byBrand, byChannel, tips] = await Promise.all([
    analytics.monthlyFunnel({ months }),
    analytics.itemFunnel({ month: req.query.month || null, limit: 25 }),
    analytics.demandBy({ facet: 'category', months: 3 }),
    analytics.demandBy({ facet: 'brand', months: 3 }),
    analytics.demandBy({ facet: 'channel', months: 3 }),
    analytics.advice({ months: 3 }),
  ]);
  res.json({ funnel, items, byCategory, byBrand, byChannel, advice: tips });
});

// One client's own history, in the {yyyyMMdd-HHmm: {…}} shape.
app.get('/api/admin/customers/:id/timeline', requirePermission('customers.read'), async (req, res) => {
  res.json(await analytics.customerTimeline(Number(req.params.id)));
});

// What the abandoned-fitting-room rule is set to, and who has already had it.
app.get('/api/admin/abandoned', requirePermission('discounts.manage'), async (req, res) => {
  res.json({ config: abandoned.config(), pending: await abandoned.pending() });
});

app.get('/api/admin/alerts', requirePermission('alerts.read'), async (req, res) => {
  res.json({ alerts: await adminAlerts({ limit: req.query.limit }) });
});

// Scheduler status + a manual/cron-callable (await tick (serverless hosts have no
// long-lived process, so the same jobs are reachable over HTTP)).
app.get('/api/admin/scheduler', requirePermission('settings.manage'), (req, res) => res.json({ ...scheduler.status(), polling: polling.status() }));
// The scheduler on a serverless host has no long-lived process, so the tick is
// an endpoint an external cron calls. A cron cannot produce a signed Telegram
// launch, so it authenticates with a shared secret instead — and if that secret
// is unset the route stays admin-only rather than falling open.
const cronAllowed = (req) => {
  const want = process.env.W2B_CRON_SECRET || '';
  if (!want) return false;
  const got = req.get('x-w2b-cron-secret') || req.query.secret || '';
  return String(got) === want;
};
app.post('/api/admin/tick', async (req, res, next) => {
  if (cronAllowed(req)) return res.json(await scheduler.tick());
  return requirePermission('settings.manage')(req, res, next);
}, async (req, res) => res.json(await scheduler.tick()));

app.get('/api/admin/report', requirePermission('reports.read'), async (req, res) => {
  res.json(await buildReport(req.query.period === 'week' ? 'week' : 'day'));
});
app.post('/api/admin/report/send', requirePermission('reports.read'), async (req, res) => {
  res.json(await sendReport(req.body?.period === 'week' ? 'week' : 'day'));
});

// ── Telegram webhook: CHANNEL → APP ────────────────────────────────────────
app.post('/telegram/webhook', async (req, res) => {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && req.get('x-telegram-bot-api-secret-token') !== secret) return res.sendStatus(401);

  // The work happens BEFORE the acknowledgement — the opposite of what a
  // long-lived server would do, and deliberately so.
  //
  // Acknowledging first is the standard trick: Telegram retries anything that is
  // not a fast 200, so you answer immediately and finish the work afterwards. On
  // a serverless host that is a way to lose data. The invocation can be frozen
  // the moment the response is written, so work started after res.send() may
  // simply never run — and Telegram, having received its 200, never redelivers.
  // A channel post could be delivered, acknowledged and silently dropped, which
  // is exactly what happened the first time this was pointed at Vercel.
  //
  // Ingest is one or two statements; there is no latency budget worth risking a
  // post for.
  try {
    await ingestChannelPost(req.body);
    await handleMessage(req.body);
  } catch (e) {
    // Still a 200. Telegram redelivers anything else, so a malformed update
    // would come back forever — but it is LOGGED now. Swallowing it in silence
    // is how a broken bridge stays broken without anyone noticing.
    console.error('[telegram] update failed:', e.message);
  }
  res.sendStatus(200);
});

// Bot / webhook diagnostics for the owner: "is the bot really an admin of this
// channel?" answered without waiting for someone to await post.
app.get('/api/admin/telegram', requirePermission('settings.manage'), async (req, res) => {
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
