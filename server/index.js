// ─────────────────────────────────────────────────────────────────────────
//  index.js — Way2Buy Mini App server.
//  Serves the Mini App (static) + JSON API + Telegram webhook + AI reports.
// ─────────────────────────────────────────────────────────────────────────
import './env.js';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { db, init } from './db.js';
import { loyaltyFor, snapshotBatch, TIERS } from './loyalty.js';
import { CHANNELS, liveMode, publishPost, ingestChannelPost } from './telegram.js';
import { buildReport, sendReport } from './ai.js';
import * as campaigns from './campaigns.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
init();

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, '..', 'public')));

const PORT = process.env.PORT || 4010;
const ADMIN_IDS = (process.env.ADMIN_TG_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
const DEMO = ADMIN_IDS.length === 0; // no admins configured ⇒ open demo mode

// ── FX: normalise everything to USD for the cashback engine ────────────────
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
const customerCard = (c) => ({
  id: c.id, tgId: c.tg_user_id, name: c.name, login: c.login,
  phone: c.phone, email: c.email, birthday: c.birthday, city: c.city,
  loyalty: loyaltyFor(c.id),
});

// ── config ─────────────────────────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  res.json({
    channels: Object.values(CHANNELS),
    tiers: TIERS,
    cashback: { step: Number(process.env.CASHBACK_STEP_USD || 3000), reward: Number(process.env.CASHBACK_REWARD_USD || 100) },
    live: liveMode(),
    demo: DEMO,
  });
});

// ── me / register ────────────────────────────────────────────────────────
app.get('/api/me', (req, res) => {
  const c = findCustomer(tgid(req));
  if (!c) return res.json({ registered: false, admin: isAdmin(req) });
  res.json({ registered: true, admin: isAdmin(req), customer: customerCard(c) });
});

app.post('/api/register', (req, res) => {
  const { name, phone, email, birthday, city, consent } = req.body || {};
  const id = tgid(req);
  if (!name || !id) return res.status(400).json({ error: 'name & tgid required' });
  const exists = findCustomer(id);
  if (exists) {
    db.prepare('UPDATE customers SET name=?,phone=?,email=?,birthday=?,city=?,consent=? WHERE id=?')
      .run(name, phone || null, email || null, birthday || null, city || null, consent ? 1 : 0, exists.id);
    return res.json({ registered: true, customer: customerCard(findCustomer(id)) });
  }
  const info = db.prepare(`INSERT INTO customers (tg_user_id,login,name,phone,email,birthday,city,consent,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, req.body.login || null, name, phone || null, email || null, birthday || null, city || null, consent ? 1 : 0, now());
  db.prepare('INSERT INTO events (customer_id,type,created_at) VALUES (?,?,?)').run(info.lastInsertRowid, 'join', now());
  res.json({ registered: true, customer: customerCard(findCustomer(id)) });
});

// ── feed (both channels) ───────────────────────────────────────────────────
app.get('/api/feed', (req, res) => {
  const ch = req.query.channel;
  const rows = (ch && ch !== 'all')
    ? db.prepare('SELECT * FROM posts WHERE channel=? AND status=\'published\' ORDER BY created_at DESC LIMIT 50').all(ch)
    : db.prepare('SELECT * FROM posts WHERE status=\'published\' ORDER BY created_at DESC LIMIT 50').all();
  res.json({ posts: rows.map((p) => ({ ...p, channelMeta: CHANNELS[p.channel] })) });
});

app.post('/api/interest', (req, res) => {
  const c = findCustomer(tgid(req));
  const { postId, type } = req.body || {};
  db.prepare('INSERT INTO events (customer_id,post_id,type,created_at) VALUES (?,?,?,?)')
    .run(c?.id || null, postId || null, type || 'want', now());
  res.json({ ok: true });
});

// ── purchases + cashback ────────────────────────────────────────────────
app.get('/api/purchases', (req, res) => {
  const c = findCustomer(tgid(req));
  if (!c) return res.json({ purchases: [] });
  const rows = db.prepare('SELECT * FROM purchases WHERE customer_id=? ORDER BY created_at DESC').all(c.id);
  const promos = db.prepare('SELECT * FROM promo_codes WHERE customer_id=? AND status=\'active\' ORDER BY created_at DESC').all(c.id);
  res.json({ purchases: rows, promos, loyalty: loyaltyFor(c.id) });
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
// Own active promos (variant = source campaign type) + app-wide public campaigns.
app.get('/api/discounts', (req, res) => {
  const c = findCustomer(tgid(req));
  res.json(campaigns.discountsFor(c?.id || null));
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

// ── ADMIN ────────────────────────────────────────────────────────────────
app.get('/api/admin/customers', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM customers ORDER BY created_at DESC').all();
  // One batched snapshot instead of a loyaltyFor() call per row (N+1-safe).
  const snaps = snapshotBatch(rows.map((r) => r.id));
  res.json({
    customers: rows.map((c) => ({ ...customerCard(c), loyalty: snaps[c.id] })),
  });
});

app.post('/api/admin/purchase', requireAdmin, (req, res) => {
  const { customerId, title, amount, currency, channel, invoiceRef } = req.body || {};
  if (!customerId || !amount) return res.status(400).json({ error: 'customerId & amount required' });
  const cur = currency || (channel === 'luxury' ? 'USD' : 'UAH');
  db.prepare(`INSERT INTO purchases (customer_id,title,amount_usd,orig_amount,orig_currency,source_channel,invoice_ref,created_at)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(customerId, title || 'Покупка', toUsd(Number(amount), cur), Number(amount), cur, channel || null, invoiceRef || null, now());
  db.prepare('INSERT INTO events (customer_id,type,meta,created_at) VALUES (?,?,?,?)').run(customerId, 'purchase', title || '', now());
  res.json({ ok: true, loyalty: loyaltyFor(customerId) });
});

app.post('/api/admin/post', requireAdmin, async (req, res) => {
  try {
    const { channel, title, body, price, currency } = req.body || {};
    if (!channel || !title) return res.status(400).json({ error: 'channel & title required' });
    const result = await publishPost({ channel, title, body, price: price ? Number(price) : null, currency });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post('/api/admin/promo', requireAdmin, (req, res) => {
  const { customerId, percent, reason, days } = req.body || {};
  const code = `W2B-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  const exp = days ? new Date(Date.now() + days * 86400000).toISOString() : null;
  const info = db.prepare('INSERT INTO promo_codes (customer_id,code,percent,reason,status,created_at,expires_at) VALUES (?,?,?,?,\'active\',?,?)')
    .run(customerId || null, code, Number(percent) || 10, reason || '', now(), exp);
  // In-app notification is the authoritative delivery channel (ADR-005); the
  // dedupe key keeps a retried request from producing a second notification.
  if (customerId) {
    db.prepare(`INSERT OR IGNORE INTO notifications
      (customer_id,kind,title,body,promo_code_id,dedupe_key,in_app_status,dm_status,created_at)
      VALUES (?,?,?,?,?,?, 'unread','skipped',?)`)
      .run(customerId, 'new_discount', `Ваша знижка ${Number(percent) || 10}% готова`,
        `Промокод ${code}${reason ? ` · ${reason}` : ''}`, Number(info.lastInsertRowid),
        `promo:${code}`, now());
  }
  res.json({ ok: true, code });
});

// ── admin: discount campaigns (the admin-editable discount rules) ─────────
app.get('/api/admin/campaigns', requireAdmin, (req, res) => {
  res.json(campaigns.list({ status: req.query.status, limit: req.query.limit }));
});

app.post('/api/admin/campaigns', requireAdmin, (req, res) => {
  try {
    const created = campaigns.create({ ...req.body, createdBy: tgid(req) || null });
    res.json({ ok: true, campaign: created });
  } catch (e) {
    const status = e instanceof campaigns.CampaignValidationError ? 400 : 500;
    res.status(status).json({ error: String(e.message || e) });
  }
});

app.patch('/api/admin/campaigns/:id', requireAdmin, (req, res) => {
  try {
    const updated = campaigns.update(Number(req.params.id), req.body || {});
    if (!updated) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, campaign: updated });
  } catch (e) {
    const status = e instanceof campaigns.CampaignValidationError ? 400 : 500;
    res.status(status).json({ error: String(e.message || e) });
  }
});

// Mint the promo codes for a campaign's audience. Idempotent per calendar year.
app.post('/api/admin/campaigns/:id/materialize', requireAdmin, (req, res) => {
  const result = campaigns.materialize(Number(req.params.id));
  if (!result) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true, ...result });
});

app.get('/api/admin/holidays', requireAdmin, (req, res) => {
  res.json(campaigns.listHolidays({ limit: req.query.limit }));
});

app.get('/api/admin/report', requireAdmin, async (req, res) => {
  res.json(await buildReport(req.query.period === 'week' ? 'week' : 'day'));
});
app.post('/api/admin/report/send', requireAdmin, async (req, res) => {
  res.json(await sendReport(req.body?.period === 'week' ? 'week' : 'day'));
});

// ── Telegram webhook: CHANNEL → APP ────────────────────────────────────────
app.post('/telegram/webhook', (req, res) => {
  try { ingestChannelPost(req.body); } catch { /* swallow — never break TG */ }
  res.sendStatus(200);
});

// On a serverless host (Vercel) the platform owns the listener and imports the
// app as a handler, so binding a port there would be wrong. Everywhere else we
// listen ourselves.
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`\n  Way2Buy Mini App → http://localhost:${PORT}`);
    console.log(`  mode: ${liveMode() ? 'LIVE (bot token set)' : 'DEMO (simulated Telegram)'} · admin: ${DEMO ? 'open (demo)' : ADMIN_IDS.length + ' ids'}\n`);
  });
}

export default app;
