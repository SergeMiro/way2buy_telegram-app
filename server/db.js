// ─────────────────────────────────────────────────────────────────────────
//  db.js — SQLite data layer.
//
//  Uses better-sqlite3 (single file, zero-ops). The schema below maps 1:1
//  onto PocketBase collections (the "SQLite Supabase") for production —
//  every table here becomes a PocketBase collection with the same columns,
//  so the move to prod is a data copy, not a rewrite.
// ─────────────────────────────────────────────────────────────────────────
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// W2B_DB_PATH lets a read-only host point the database at a writable location.
// On Vercel only /tmp is writable, so the demo DB lives there: it is recreated
// and re-seeded on a cold start, which is exactly what a preview demo wants. A
// persistent deployment (VPS / PocketBase) overrides W2B_DB_PATH.
const DEFAULT_DB_PATH = process.env.VERCEL
  ? '/tmp/way2buy.db'
  : join(__dirname, '..', 'way2buy.db');
const DB_PATH = process.env.W2B_DB_PATH || DEFAULT_DB_PATH;

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function migrate() {
  db.exec(`
  CREATE TABLE IF NOT EXISTS customers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_user_id  TEXT UNIQUE,
    login       TEXT,
    name        TEXT NOT NULL,
    phone       TEXT,
    email       TEXT,
    birthday    TEXT,               -- YYYY-MM-DD
    city        TEXT,
    consent     INTEGER DEFAULT 1,  -- marketing consent
    notes       TEXT,
    created_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS purchases (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id   INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    title         TEXT,
    amount_usd    REAL NOT NULL,          -- everything normalised to USD for cashback
    orig_amount   REAL,                   -- what the customer actually saw (e.g. UAH)
    orig_currency TEXT DEFAULT 'USD',
    source_channel TEXT,                  -- 'ukraine' | 'luxury' | null
    invoice_ref   TEXT,
    status        TEXT DEFAULT 'confirmed',
    created_at    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS redemptions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    amount_usd  REAL NOT NULL,
    note        TEXT,
    created_at  TEXT NOT NULL
  );

  -- Unified feed. A row can originate in the app (source='app', then pushed
  -- to the Telegram channel) OR be pulled from the channel (source='channel').
  CREATE TABLE IF NOT EXISTS posts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    channel       TEXT NOT NULL,          -- 'ukraine' | 'luxury'
    tg_message_id INTEGER,
    title         TEXT,
    body          TEXT,
    price         REAL,
    currency      TEXT DEFAULT 'UAH',
    image_url     TEXT,
    source        TEXT NOT NULL,          -- 'app' | 'channel'
    status        TEXT DEFAULT 'published',
    created_at    TEXT NOT NULL
  );

  -- Behavioural events → retention + fuel for the AI reports.
  CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
    post_id     INTEGER REFERENCES posts(id) ON DELETE SET NULL,
    type        TEXT NOT NULL,            -- 'view' | 'want' | 'return' | 'purchase' | 'join'
    meta        TEXT,
    created_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS promo_codes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
    code        TEXT NOT NULL UNIQUE,
    percent     INTEGER NOT NULL,
    reason      TEXT,
    status      TEXT DEFAULT 'active',    -- 'active' | 'used' | 'expired'
    created_at  TEXT NOT NULL,
    expires_at  TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_purchases_customer ON purchases(customer_id);
  CREATE INDEX IF NOT EXISTS idx_events_customer   ON events(customer_id);
  CREATE INDEX IF NOT EXISTS idx_posts_channel     ON posts(channel, created_at);
  `);

  // ── Discounts / campaigns / notifications / scheduler / AI agent ──────────
  // Additive schema for the discounts+notifications+scheduler+AI-agent pillars.
  // `holidays` is created before `campaigns` because campaigns.holiday_id FKs it.
  db.exec(`
  CREATE TABLE IF NOT EXISTS holidays (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    month           INTEGER NOT NULL,          -- 1..12
    day             INTEGER NOT NULL,          -- 1..31 (recurring MM-DD)
    emoji           TEXT,
    default_percent INTEGER DEFAULT 15,
    enabled         INTEGER DEFAULT 1,
    created_at      TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS campaigns (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT NOT NULL,
    type             TEXT NOT NULL,            -- 'birthday' | 'holiday' | 'vip' | 'generic'
    percent          INTEGER NOT NULL,         -- discount %
    audience_json    TEXT,                     -- {tier?, minSpentUsd?, city?, sourceChannel?, tgIds?[]}
    holiday_id       INTEGER NULL REFERENCES holidays(id) ON DELETE SET NULL,
    starts_at        TEXT NULL,                -- ISO; null = immediate
    ends_at          TEXT NULL,                -- ISO; null = open-ended
    recurring        INTEGER DEFAULT 0,        -- 1 for annual birthday/holiday rules
    window_days      INTEGER DEFAULT 0,        -- birthday: days before birthday to fire
    promo_valid_days INTEGER DEFAULT 14,       -- validity of generated promo codes
    status           TEXT DEFAULT 'draft',     -- draft|scheduled|active|ended|archived
    source           TEXT DEFAULT 'manual',    -- 'manual' | 'ai'
    created_by       TEXT,                     -- admin tg id
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id   INTEGER NULL REFERENCES customers(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL,               -- birthday|new_discount|holiday|near_reward|manual
    title         TEXT NOT NULL,
    body          TEXT,
    promo_code_id INTEGER NULL REFERENCES promo_codes(id) ON DELETE SET NULL,
    campaign_id   INTEGER NULL REFERENCES campaigns(id) ON DELETE SET NULL,
    dedupe_key    TEXT NOT NULL,               -- UNIQUE; prevents re-send on every tick
    in_app_status TEXT DEFAULT 'unread',       -- unread|read
    dm_status     TEXT DEFAULT 'pending',      -- pending|sent|failed|simulated|skipped
    created_at    TEXT NOT NULL,
    read_at       TEXT NULL
  );

  CREATE TABLE IF NOT EXISTS ai_conversations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_tg_id TEXT NOT NULL,
    title       TEXT,
    created_at  TEXT,
    last_at     TEXT
  );

  CREATE TABLE IF NOT EXISTS ai_messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER REFERENCES ai_conversations(id) ON DELETE CASCADE,
    role            TEXT NOT NULL,             -- user|assistant|tool
    content         TEXT,
    tool_name       TEXT NULL,
    tool_args_json  TEXT NULL,
    created_at      TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ai_proposals (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER REFERENCES ai_conversations(id) ON DELETE CASCADE,
    tool_name       TEXT NOT NULL,             -- create_discount_campaign|create_birthday_rule|create_holiday_campaign
    args_json       TEXT NOT NULL,             -- validated args
    summary         TEXT NOT NULL,             -- human-readable Ukrainian summary shown to admin
    status          TEXT DEFAULT 'pending',    -- pending|applied|rejected|expired
    created_at      TEXT NOT NULL,
    applied_at      TEXT NULL
  );

  CREATE TABLE IF NOT EXISTS scheduler_lock (
    id           INTEGER PRIMARY KEY CHECK (id = 1),  -- single-instance advisory lock
    holder       TEXT,
    heartbeat_at TEXT
  );

  -- Indexes serving the new list/reconciliation queries.
  -- idx_campaigns_status_dates: scheduler reconcileStatus scans by status + window.
  CREATE INDEX IF NOT EXISTS idx_campaigns_status_dates ON campaigns(status, starts_at, ends_at);
  -- idx_notifications_customer: paginated per-customer feed ordered by recency.
  CREATE INDEX IF NOT EXISTS idx_notifications_customer  ON notifications(customer_id, created_at);
  -- idx_ai_messages_conv: transcript fetch by conversation.
  CREATE INDEX IF NOT EXISTS idx_ai_messages_conv        ON ai_messages(conversation_id);
  -- uq_notif_dedupe: idempotent notification writer — one row per dedupe_key.
  CREATE UNIQUE INDEX IF NOT EXISTS uq_notif_dedupe      ON notifications(dedupe_key);
  `);

  // Additive migration for the existing promo_codes table (R-15): add
  // campaign_id linking a materialized promo to its source campaign. Guarded by
  // a PRAGMA check so re-running migrate() against an existing way2buy.db does
  // not error with "duplicate column name".
  const promoCols = db.prepare(`PRAGMA table_info(promo_codes)`).all();
  if (!promoCols.some((c) => c.name === 'campaign_id')) {
    db.exec(
      `ALTER TABLE promo_codes ADD COLUMN campaign_id INTEGER NULL REFERENCES campaigns(id) ON DELETE SET NULL`
    );
  }

  // Promo indexes depend on the campaign_id column existing (created after ALTER).
  // uq_promo_campaign_customer_year: idempotency for recurring materialization —
  // exactly one code per customer per campaign per calendar year (R-02). The
  // year is derived from created_at (YYYY) via substr, matching architecture §4.
  db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS uq_promo_campaign_customer_year
    ON promo_codes(campaign_id, customer_id, substr(created_at, 1, 4));
  CREATE INDEX IF NOT EXISTS idx_promo_campaign ON promo_codes(campaign_id);
  `);
}

// ── Seed: a small, realistic dataset (5–10 customers) ──────────────────────
export function seed({ force = false } = {}) {
  const count = db.prepare('SELECT COUNT(*) c FROM customers').get().c;
  if (count > 0 && !force) return;
  if (force) {
    // Children before parents (foreign_keys = ON). New pillar tables cleared too
    // so `--reseed` recreates a clean, deterministic dataset.
    db.exec(
      'DELETE FROM notifications; DELETE FROM ai_messages; DELETE FROM ai_proposals; DELETE FROM ai_conversations; DELETE FROM scheduler_lock; DELETE FROM redemptions; DELETE FROM promo_codes; DELETE FROM events; DELETE FROM purchases; DELETE FROM posts; DELETE FROM campaigns; DELETE FROM holidays; DELETE FROM customers;'
    );
  }

  const now = new Date('2026-07-21T09:00:00Z');
  const iso = (d) => new Date(d).toISOString();
  const daysAgo = (n) => iso(now.getTime() - n * 86400000);

  const insCustomer = db.prepare(`INSERT INTO customers
    (tg_user_id, login, name, phone, email, birthday, city, consent, notes, created_at)
    VALUES (@tg_user_id,@login,@name,@phone,@email,@birthday,@city,@consent,@notes,@created_at)`);
  const insPurchase = db.prepare(`INSERT INTO purchases
    (customer_id,title,amount_usd,orig_amount,orig_currency,source_channel,invoice_ref,status,created_at)
    VALUES (@customer_id,@title,@amount_usd,@orig_amount,@orig_currency,@source_channel,@invoice_ref,'confirmed',@created_at)`);
  const insPost = db.prepare(`INSERT INTO posts
    (channel,tg_message_id,title,body,price,currency,image_url,source,status,created_at)
    VALUES (@channel,@tg_message_id,@title,@body,@price,@currency,@image_url,@source,'published',@created_at)`);
  const insEvent = db.prepare(`INSERT INTO events (customer_id,post_id,type,meta,created_at)
    VALUES (@customer_id,@post_id,@type,@meta,@created_at)`);
  const insPromo = db.prepare(`INSERT INTO promo_codes
    (customer_id,code,percent,reason,status,created_at,expires_at,campaign_id)
    VALUES (@customer_id,@code,@percent,@reason,@status,@created_at,@expires_at,@campaign_id)`);
  const insNotif = db.prepare(`INSERT OR IGNORE INTO notifications
    (customer_id,kind,title,body,promo_code_id,campaign_id,dedupe_key,in_app_status,dm_status,created_at)
    VALUES (@customer_id,@kind,@title,@body,@promo_code_id,@campaign_id,@dedupe_key,@in_app_status,'simulated',@created_at)`);
  const insHoliday = db.prepare(`INSERT INTO holidays
    (name,month,day,emoji,default_percent,enabled,created_at)
    VALUES (@name,@month,@day,@emoji,@default_percent,@enabled,@created_at)`);
  const insCampaign = db.prepare(`INSERT INTO campaigns
    (name,type,percent,audience_json,holiday_id,starts_at,ends_at,recurring,window_days,promo_valid_days,status,source,created_by,created_at,updated_at)
    VALUES (@name,@type,@percent,@audience_json,@holiday_id,@starts_at,@ends_at,@recurring,@window_days,@promo_valid_days,@status,@source,@created_by,@created_at,@updated_at)`);

  const customers = [
    { tg_user_id: '100000001', login: 'olena_k',  name: 'Олена Ковальчук',  phone: '+380671112233', email: 'olena.k@gmail.com',  birthday: '1990-07-28', city: 'Київ',    consent: 1, notes: 'VIP, купує систематично' },
    { tg_user_id: '100000002', login: 'iryna_d',  name: 'Ірина Демченко',   phone: '+380931234567', email: 'iryna.d@gmail.com',  birthday: '1988-03-14', city: 'Львів',   consent: 1, notes: '' },
    { tg_user_id: '100000003', login: 'marina_v', name: 'Марина Волошина',  phone: '+13475550101',  email: 'marina.v@gmail.com', birthday: '1995-11-02', city: 'New York',consent: 1, notes: 'США, luxury' },
    { tg_user_id: '100000004', login: 'kate_s',   name: 'Катерина Сидоренко',phone: '+380509998877', email: 'kate.s@gmail.com',   birthday: '1992-07-24', city: 'Одеса',   consent: 1, notes: 'ДР через 3 дні' },
    { tg_user_id: '100000005', login: 'natali_p', name: 'Наталія Панченко', phone: '+380661239988', email: 'natali.p@gmail.com', birthday: '1985-01-19', city: 'Дніпро',   consent: 1, notes: 'купила один раз, не повертається' },
    { tg_user_id: '100000006', login: 'yulia_h',  name: 'Юлія Гончар',      phone: '+380671114455', email: 'yulia.h@gmail.com',  birthday: '1998-09-30', city: 'Харків',  consent: 1, notes: '' },
    { tg_user_id: '100000007', login: 'sofia_m',  name: 'Софія Мельник',    phone: '+13105550199',  email: 'sofia.m@gmail.com',  birthday: '1993-12-05', city: 'Los Angeles', consent: 1, notes: 'luxury, великі суми' },
  ];

  const ids = customers.map((c) => Number(insCustomer.run({ ...c, created_at: daysAgo(120 - customers.indexOf(c) * 5) }).lastInsertRowid));

  // Purchases — designed so tiers/cashback are visibly different across people.
  // amount_usd is what drives cashback ($3000 → $100).
  const P = [
    // Олена — Gold, two cashback milestones crossed ($200 earned, $100 already
    // redeemed below ⇒ $100 available). The three larger orders below are what
    // push her past $6000; without them the redemption would exceed what she
    // earned and the wallet would render a negative balance.
    [0, 'Burberry тренч', 1450, 60000, 'UAH', 'ukraine', 18],
    [0, 'Chloé сумка', 1200, 49600, 'UAH', 'ukraine', 48],
    [0, 'Max Mara пальто', 980, 40500, 'UAH', 'ukraine', 78],
    [0, 'Ralph Lauren пуховик', 640, 26500, 'UAH', 'ukraine', 8],
    [0, 'Michael Kors сумка', 410, 17000, 'UAH', 'ukraine', 40],
    [0, 'Coach кросівки', 300, 12400, 'UAH', 'ukraine', 70],
    [0, 'Tory Burch чоботи', 520, 21500, 'UAH', 'ukraine', 95],
    [0, 'Levi\'s джинси x3', 210, 8700, 'UAH', 'ukraine', 30],
    [0, 'Calvin Klein пальто', 380, 15700, 'UAH', 'ukraine', 12],
    [0, 'Fossil годинник', 250, 10300, 'UAH', 'ukraine', 55],
    // → total ≈ 2710 (Gold, 90$ earned, close to 3rd hundred)
    // Ірина — Gold
    [1, 'Guess сумка', 240, 9900, 'UAH', 'ukraine', 60],
    [1, 'Nike Air Force', 130, 5400, 'UAH', 'ukraine', 20],
    [1, 'Tommy Hilfiger куртка', 190, 7850, 'UAH', 'ukraine', 44],
    // → 560
    // Марина — Luxury Platinum, big spender (needs ≥ $10 000 for the tier)
    [2, 'Hermès Kelly', 4800, 4800, 'USD', 'luxury', 88],
    [2, 'Bottega Veneta сумка', 2900, 2900, 'USD', 'luxury', 33],
    [2, 'Saint Laurent чоботи', 1250, 1250, 'USD', 'luxury', 66],
    [2, 'Moncler пуховик', 1600, 1600, 'USD', 'luxury', 5],
    // → 5750 (Platinum, $100 earned, huge headroom)
    // Катерина — Gold, birthday in 3 days
    [3, 'Zara total look', 160, 6600, 'UAH', 'ukraine', 22],
    [3, 'Adidas Samba', 120, 4950, 'UAH', 'ukraine', 41],
    // → 280
    // Наталія — one-off, at risk (churn)
    [4, 'Skechers кросівки', 95, 3900, 'UAH', 'ukraine', 110],
    // Юлія — active, small
    [5, 'H&M набір', 70, 2890, 'UAH', 'ukraine', 9],
    [5, 'Mango пальто', 140, 5800, 'UAH', 'ukraine', 3],
    // Софія — Luxury, near next reward
    [6, 'Prada окуляри', 480, 480, 'USD', 'luxury', 50],
    [6, 'Gucci ремінь', 520, 520, 'USD', 'luxury', 25],
    [6, 'Balenciaga кросівки', 950, 950, 'USD', 'luxury', 7],
  ];
  for (const [ci, title, usd, orig, cur, ch, ago] of P) {
    insPurchase.run({
      customer_id: ids[ci], title, amount_usd: usd, orig_amount: orig,
      orig_currency: cur, source_channel: ch, invoice_ref: null, created_at: daysAgo(ago),
    });
  }

  // Feed posts — a few from each channel (source 'channel' = pulled from TG).
  const posts = [
    { channel: 'ukraine', title: 'Levi\'s жіночий шкіряний ремінь', body: 'Оригінал з Macy\'s. Наявність — уточнюйте у боті 🤖', price: 1161, currency: 'UAH', source: 'channel', ago: 1, img: '👜' },
    { channel: 'ukraine', title: 'Lauren Ralph Lauren ремінь двосторонній', body: 'Топ-сервіс, мінімальна комісія 🇺🇦', price: 1935, currency: 'UAH', source: 'channel', ago: 1, img: '🧣' },
    { channel: 'ukraine', title: 'Calvin Klein сукня', body: 'Нова колекція. Доставка 10–14 днів.', price: 3480, currency: 'UAH', source: 'app', ago: 0, img: '👗' },
    { channel: 'ukraine', title: 'Fossil жіночий годинник', body: 'Залишилось 2 шт.', price: 1773, currency: 'UAH', source: 'channel', ago: 2, img: '⌚' },
    { channel: 'luxury', title: 'Bottega Veneta Jodie', body: 'Authentic. Full set, receipt included.', price: 2900, currency: 'USD', source: 'channel', ago: 1, img: '👜' },
    { channel: 'luxury', title: 'Moncler Maya', body: 'Розміри 1–3 в наявності.', price: 1600, currency: 'USD', source: 'app', ago: 0, img: '🧥' },
    { channel: 'luxury', title: 'Gucci GG Marmont ремінь', body: 'Pre-order 7 днів.', price: 520, currency: 'USD', source: 'channel', ago: 3, img: '🔗' },
  ];
  const postIds = posts.map((p) =>
    Number(insPost.run({
      channel: p.channel, tg_message_id: p.source === 'channel' ? 1000 + posts.indexOf(p) : null,
      title: p.title, body: p.body, price: p.price, currency: p.currency,
      image_url: p.img, source: p.source, created_at: daysAgo(p.ago),
    }).lastInsertRowid)
  );

  // Events — interest / return signals
  insEvent.run({ customer_id: ids[3], post_id: postIds[2], type: 'want', meta: null, created_at: daysAgo(0) });
  insEvent.run({ customer_id: ids[0], post_id: postIds[4], type: 'return', meta: '5 переглядів', created_at: daysAgo(0) });
  insEvent.run({ customer_id: ids[5], post_id: postIds[1], type: 'want', meta: null, created_at: daysAgo(1) });
  insEvent.run({ customer_id: ids[6], post_id: postIds[6], type: 'view', meta: null, created_at: daysAgo(1) });

  // Redemption example (Олена вже списала $100)
  db.prepare(`INSERT INTO redemptions (customer_id,amount_usd,note,created_at) VALUES (?,?,?,?)`)
    .run(ids[0], 100, 'Кешбек списано на замовлення #A-204', daysAgo(15));

  // Holiday calendar (A-1): Ukraine-focused + a few global. Recurring by MM-DD;
  // admin-editable at runtime. default_percent is the suggested discount.
  const holidays = [
    { name: 'Новий рік',                    month: 1,  day: 1,  emoji: '🎉', default_percent: 20 },
    { name: 'Різдво (за старим стилем)',    month: 1,  day: 7,  emoji: '✨', default_percent: 15 },
    { name: 'День закоханих',               month: 2,  day: 14, emoji: '💝', default_percent: 15 },
    { name: '8 Березня',                    month: 3,  day: 8,  emoji: '🌷', default_percent: 20 },
    { name: 'Великдень (орієнтовно)',       month: 4,  day: 20, emoji: '🐣', default_percent: 15 },
    { name: 'День Незалежності України',    month: 8,  day: 24, emoji: '🇺🇦', default_percent: 24 },
    { name: 'Чорна пʼятниця',               month: 11, day: 28, emoji: '🖤', default_percent: 30 },
    { name: 'Кіберпонеділок',               month: 12, day: 1,  emoji: '💻', default_percent: 25 },
    { name: 'Різдво (за новим стилем)',     month: 12, day: 25, emoji: '🎄', default_percent: 25 },
  ];
  for (const h of holidays) {
    insHoliday.run({ ...h, enabled: 1, created_at: daysAgo(120) });
  }

  // Demo campaigns.
  // 1) A holiday-type campaign whose window brackets the fixed demo "now"
  //    (2026-07-21T09:00:00Z): active today so its cards render in-app (GA-4).
  const summerSaleId = Number(insCampaign.run({
    name: 'Літній SALE ☀️', type: 'holiday', percent: 20, audience_json: null,
    holiday_id: null, starts_at: daysAgo(4), ends_at: daysAgo(-10),
    recurring: 0, window_days: 0, promo_valid_days: 14, status: 'active',
    source: 'manual', created_by: null, created_at: daysAgo(4), updated_at: daysAgo(4),
  }).lastInsertRowid);
  // 2) A recurring birthday rule (fires window_days before a customer's birthday).
  //    Drives GA-2 once the scheduler materializes promos for Катерина (today).
  const birthdayRuleId = Number(insCampaign.run({
    name: 'День народження 🎂', type: 'birthday', percent: 25, audience_json: null,
    holiday_id: null, starts_at: null, ends_at: null,
    recurring: 1, window_days: 3, promo_valid_days: 14, status: 'active',
    source: 'manual', created_by: null, created_at: daysAgo(30), updated_at: daysAgo(30),
  }).lastInsertRowid);
  // 3) A VIP rule, so the 💎 card variant is demonstrable too.
  const vipRuleId = Number(insCampaign.run({
    name: 'VIP-клуб 💎', type: 'vip', percent: 15,
    audience_json: JSON.stringify({ tier: 'gold' }),
    holiday_id: null, starts_at: daysAgo(30), ends_at: null,
    recurring: 0, window_days: 0, promo_valid_days: 30, status: 'active',
    source: 'manual', created_by: null, created_at: daysAgo(30), updated_at: daysAgo(30),
  }).lastInsertRowid);

  // Promo codes — materialized *from* the campaigns above, so `discountsFor()`
  // can join back and pick the right card variant (🎂 / 🎉 / 💎).
  const bdayKate = Number(insPromo.run({ customer_id: ids[3], code: 'BDAY-KATE-30', percent: 30, reason: 'День народження 🎂', status: 'active', created_at: daysAgo(0), expires_at: daysAgo(-14), campaign_id: birthdayRuleId }).lastInsertRowid);
  const vipOlena = Number(insPromo.run({ customer_id: ids[0], code: 'VIP-OLENA-15', percent: 15, reason: 'Gold-клієнт', status: 'active', created_at: daysAgo(2), expires_at: daysAgo(-10), campaign_id: vipRuleId }).lastInsertRowid);
  const saleSofia = Number(insPromo.run({ customer_id: ids[6], code: 'SUMMER-SOFIA-20', percent: 20, reason: 'Літній SALE ☀️', status: 'active', created_at: daysAgo(1), expires_at: daysAgo(-9), campaign_id: summerSaleId }).lastInsertRowid);

  // Notifications — the in-app feed is the authoritative delivery channel
  // (ADR-005); dedupe_key is what makes a re-run a no-op.
  insNotif.run({ customer_id: ids[3], kind: 'birthday', title: 'Вітаємо з днем народження! 🎂', body: 'Ваша персональна знижка 30% вже у «Покупках».', promo_code_id: bdayKate, campaign_id: birthdayRuleId, dedupe_key: `bday:${ids[3]}:2026`, in_app_status: 'unread', created_at: daysAgo(0) });
  insNotif.run({ customer_id: ids[0], kind: 'near_reward', title: 'Ще трохи до наступних $100 💰', body: 'Кешбек нараховується за кожні $3000 покупок.', promo_code_id: null, campaign_id: null, dedupe_key: `near:${ids[0]}:2026-07`, in_app_status: 'unread', created_at: daysAgo(1) });
  insNotif.run({ customer_id: ids[0], kind: 'new_discount', title: 'VIP-знижка 15% активна 💎', body: `Промокод VIP-OLENA-15 діє до ${daysAgo(-10).slice(0, 10)}.`, promo_code_id: vipOlena, campaign_id: vipRuleId, dedupe_key: `promo:VIP-OLENA-15`, in_app_status: 'read', created_at: daysAgo(2) });
  insNotif.run({ customer_id: ids[6], kind: 'holiday', title: 'Літній SALE ☀️ −20%', body: 'Промокод SUMMER-SOFIA-20 у «Покупках».', promo_code_id: saleSofia, campaign_id: summerSaleId, dedupe_key: `promo:SUMMER-SOFIA-20`, in_app_status: 'unread', created_at: daysAgo(1) });
}

export function init() {
  migrate();
  seed();
}

// CLI: `node server/db.js --reseed`
if (process.argv[1] && process.argv[1].endsWith('db.js')) {
  migrate();
  seed({ force: process.argv.includes('--reseed') });
  console.log('DB ready at', DB_PATH);
}
