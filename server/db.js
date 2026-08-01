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

  migrateV2();
}

// ── V2: Maryna's final rules (31.07.2026) ─────────────────────────────────
//  See docs/BUSINESS-LOGIC.md. Everything additive so an existing database
//  migrates in place with no data loss.
//
//  What it adds:
//   • discount_rules  — the two bonuses as ADMIN-EDITABLE rows, switchable
//     between $ and % (the "гибко в $ или %" requirement). Holidays get the
//     same mode/value/min_order columns so a holiday is configured identically.
//   • birthday_claims — the audit log for every birthday-discount request, so
//     each new request can be checked against the date we already have on file.
//   • channels        — channels become data, not two hardcoded constants: one
//     main channel + N catalog channels, auto-registered on first post.
//   • purchases.cost_usd / revenue — the profit side (what Maryna paid in China
//     vs what the client paid), plus the "remind me next day" tracking columns.
function migrateV2() {
  const addColumn = (table, column, ddl) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
  };

  db.exec(`
  -- The bonus rules Maryna edits from the admin panel. One row per rule; the
  -- key is stable so code can look a rule up without an id.
  CREATE TABLE IF NOT EXISTS discount_rules (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    key           TEXT NOT NULL UNIQUE,   -- 'cashback' | 'birthday'
    kind          TEXT NOT NULL,          -- same as key today; separate so a rule can be cloned
    name          TEXT NOT NULL,
    emoji         TEXT,
    enabled       INTEGER NOT NULL DEFAULT 1,
    mode          TEXT NOT NULL DEFAULT 'fixed',  -- 'fixed' ($) | 'percent' (%)
    value         REAL NOT NULL,          -- $ when mode='fixed', % when mode='percent'
    min_order_usd REAL DEFAULT 0,         -- minimum single-order amount to qualify
    cap_usd       REAL,                   -- cashback: max accumulated unspent balance
    valid_days    INTEGER,                -- birthday: how long the discount lives
    updated_at    TEXT NOT NULL,
    updated_by    TEXT
  );

  -- Every birthday-discount request, granted or not. This is the "система
  -- записи ДР клиентов" — we log the date the client claimed, the date we
  -- already had, and the verdict, so a second request can be cross-checked.
  CREATE TABLE IF NOT EXISTS birthday_claims (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id       INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    claimed_birthday  TEXT,               -- what the client entered, YYYY-MM-DD or MM-DD
    on_file_birthday  TEXT,               -- what we already had (null on first claim)
    year              INTEGER NOT NULL,   -- calendar year of the claim
    verdict           TEXT NOT NULL,      -- granted|mismatch|already_claimed|out_of_window|disabled|invalid_date
    promo_code_id     INTEGER NULL REFERENCES promo_codes(id) ON DELETE SET NULL,
    note              TEXT,
    created_at        TEXT NOT NULL
  );

  -- Telegram channels as data. kind='main' is the 4500-subscriber channel;
  -- kind='catalog' are the ~15 catalogues. Auto-registered on first post.
  CREATE TABLE IF NOT EXISTS channels (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    key         TEXT NOT NULL UNIQUE,     -- slug used in posts.channel
    chat_id     TEXT UNIQUE,              -- numeric Telegram chat id (-100…)
    username    TEXT,                     -- public @username, may be null for private
    title       TEXT NOT NULL,
    emoji       TEXT,
    kind        TEXT NOT NULL DEFAULT 'catalog',  -- 'main' | 'catalog'
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_bday_claims_customer ON birthday_claims(customer_id, year);
  -- One GRANTED birthday discount per customer per year; further requests are
  -- logged with a non-granted verdict and do not collide with this index.
  CREATE UNIQUE INDEX IF NOT EXISTS uq_bday_granted_year
    ON birthday_claims(customer_id, year) WHERE verdict = 'granted';
  `);

  // customers: the fields Maryna actually asked for (ім'я / адреса / телефон /
  // дата народження) + provenance of the birthday, so we know whether the date
  // came from the client's own claim or was entered by an admin.
  addColumn('customers', 'address', 'TEXT');
  addColumn('customers', 'birthday_source', "TEXT");        // 'claim' | 'admin' | 'seed'
  addColumn('customers', 'birthday_recorded_at', 'TEXT');

  // promo_codes: fixed-amount discounts ($50 on a birthday) alongside percent
  // ones, plus the minimum order the discount needs ($500 for the birthday).
  addColumn('promo_codes', 'mode', "TEXT NOT NULL DEFAULT 'percent'");
  addColumn('promo_codes', 'amount_usd', 'REAL');
  addColumn('promo_codes', 'min_order_usd', 'REAL DEFAULT 0');
  addColumn('promo_codes', 'rule_key', 'TEXT');

  // holidays: configured exactly like the other rules — $ or %, own minimum
  // order, own validity — so the admin panel treats them uniformly.
  addColumn('holidays', 'mode', "TEXT NOT NULL DEFAULT 'percent'");
  addColumn('holidays', 'value', 'REAL');
  addColumn('holidays', 'min_order_usd', 'REAL DEFAULT 0');
  addColumn('holidays', 'valid_days', 'INTEGER DEFAULT 14');
  // Back-fill `value` from the legacy default_percent column.
  db.exec('UPDATE holidays SET value = default_percent WHERE value IS NULL');

  // purchases: the profit side. amount_usd stays "what the client paid";
  // cost_usd is everything Maryna spent (factory + shipping + fees).
  addColumn('purchases', 'cost_usd', 'REAL');
  addColumn('purchases', 'cost_note', 'TEXT');
  addColumn('purchases', 'cost_entered_at', 'TEXT');
  addColumn('purchases', 'cost_reminded_at', 'TEXT');
  addColumn('purchases', 'discount_usd', 'REAL DEFAULT 0');

  // posts: what a forwarded catalogue post actually carries — photos and an
  // article number — plus album grouping and edit tracking.
  addColumn('posts', 'article', 'TEXT');
  addColumn('posts', 'photos_json', 'TEXT');
  addColumn('posts', 'media_group_id', 'TEXT');
  addColumn('posts', 'edited_at', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_posts_media_group ON posts(media_group_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_purchases_cost ON purchases(cost_usd, created_at)');

  seedRulesAndChannels();
  migrateV3();
}

// ── V3: the fitting room, the inquiry to Dasha, and item popularity ───────
//  Maryna, 31.07.2026: клиенты "ползая по каталогам добавляют в примерочную",
//  затем одним экраном формируют сообщение Даше; каждое попадание в
//  примерочную должно попадать в статистику (месяц + год).
//
//   • cart_items  — the fitting room itself: what one client is currently
//     considering. Short-lived: cleared when the inquiry is sent.
//   • cart_events — the append-only journal every statistic is computed from.
//     It keeps a SNAPSHOT of the item (title/article/channel), so popularity
//     survives a post being edited or deleted in the channel, and it is never
//     deleted — removing an item from the fitting room writes a new 'removed'
//     row instead.
//   • inquiries   — the message the client sent (their own free text + the
//     items), the record Dasha and Maryna both work from.
function migrateV3() {
  db.exec(`
  CREATE TABLE IF NOT EXISTS cart_items (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id  INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    post_id      INTEGER REFERENCES posts(id) ON DELETE SET NULL,
    title        TEXT,
    article      TEXT,
    channel      TEXT,
    photo        TEXT,                  -- file_id or emoji, snapshot at add time
    price        REAL,
    currency     TEXT,
    note         TEXT,
    status       TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'sent'
    inquiry_id   INTEGER,
    created_at   TEXT NOT NULL,
    sent_at      TEXT
  );

  -- One row per action, forever. All popularity reporting reads only this.
  CREATE TABLE IF NOT EXISTS cart_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id  INTEGER REFERENCES customers(id) ON DELETE SET NULL,
    post_id      INTEGER REFERENCES posts(id) ON DELETE SET NULL,
    action       TEXT NOT NULL,         -- 'added' | 'removed' | 'sent'
    title        TEXT,
    article      TEXT,
    channel      TEXT,
    price_usd    REAL,
    inquiry_id   INTEGER,
    created_at   TEXT NOT NULL,
    -- Denormalised time buckets: the month/year statistics are a GROUP BY on
    -- these instead of a substr() over every row.
    ym           TEXT NOT NULL,         -- 'YYYY-MM'
    y            TEXT NOT NULL          -- 'YYYY'
  );

  CREATE TABLE IF NOT EXISTS inquiries (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id   INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    message       TEXT,                 -- what the client typed themselves
    items_json    TEXT NOT NULL,        -- snapshot of the items at send time
    items_count   INTEGER NOT NULL DEFAULT 0,
    promo_code_id INTEGER REFERENCES promo_codes(id) ON DELETE SET NULL,
    promo_label   TEXT,                 -- '$50' / '20%' as shown to the client
    status        TEXT NOT NULL DEFAULT 'new',   -- 'new' | 'answered' | 'closed'
    answered_by   TEXT,
    answered_at   TEXT,
    created_at    TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_cart_customer ON cart_items(customer_id, status);
  CREATE INDEX IF NOT EXISTS idx_cart_events_ym ON cart_events(ym, action);
  CREATE INDEX IF NOT EXISTS idx_cart_events_y ON cart_events(y, action);
  CREATE INDEX IF NOT EXISTS idx_cart_events_post ON cart_events(post_id, action);
  CREATE INDEX IF NOT EXISTS idx_inquiries_status ON inquiries(status, created_at);
  -- The same post cannot sit twice in one fitting room.
  CREATE UNIQUE INDEX IF NOT EXISTS uq_cart_active
    ON cart_items(customer_id, post_id) WHERE status = 'active';
  `);
}

// Rule rows + channel rows are configuration, not demo data: they are created
// if missing on every boot (including on a production database) and never
// overwritten, so an admin edit is not reverted by a restart.
function seedRulesAndChannels() {
  const ts = new Date().toISOString();
  const insRule = db.prepare(`INSERT OR IGNORE INTO discount_rules
    (key,kind,name,emoji,enabled,mode,value,min_order_usd,cap_usd,valid_days,updated_at,updated_by)
    VALUES (@key,@kind,@name,@emoji,1,@mode,@value,@min_order_usd,@cap_usd,@valid_days,@updated_at,'system')`);

  // Maryna, 31.07.2026: "$2000 — это одна покупка" → $100 per single order of
  // $2000+, accumulating to a hard $300 ceiling.
  insRule.run({
    key: 'cashback', kind: 'cashback', name: 'Кешбек за покупку', emoji: '💰',
    mode: 'fixed', value: 100, min_order_usd: 2000, cap_usd: 300, valid_days: null,
    updated_at: ts,
  });
  // "скидка 50$ на ДР от заказа 500$ … ДЕЙСТВУЕТ 1 месяц"
  insRule.run({
    key: 'birthday', kind: 'birthday', name: 'Знижка на день народження', emoji: '🎂',
    mode: 'fixed', value: 50, min_order_usd: 500, cap_usd: null, valid_days: 30,
    updated_at: ts,
  });

  const insChannel = db.prepare(`INSERT OR IGNORE INTO channels
    (key,chat_id,username,title,emoji,kind,enabled,created_at)
    VALUES (@key,@chat_id,@username,@title,@emoji,@kind,1,@created_at)`);
  insChannel.run({
    key: 'main', chat_id: process.env.CHANNEL_MAIN_CHAT_ID || null,
    username: process.env.CHANNEL_MAIN || 'Way2Buy_Ukraine',
    title: 'Way2Buy', emoji: '🛍️', kind: 'main', created_at: ts,
  });
  // Legacy demo channels — kept so existing seeded posts still resolve.
  insChannel.run({ key: 'ukraine', chat_id: null, username: process.env.CHANNEL_UKRAINE || 'Way2Buy_Ukraine', title: 'Way2Buy Ukraine', emoji: '🇺🇦', kind: 'catalog', created_at: ts });
  insChannel.run({ key: 'luxury',  chat_id: null, username: process.env.CHANNEL_LUXURY  || 'Way2Buy_Luxury',  title: 'Way2Buy Luxury',  emoji: '💎', kind: 'catalog', created_at: ts });
}

// ── Seed: a small, realistic dataset (5–10 customers) ──────────────────────
export function seed({ force = false } = {}) {
  const count = db.prepare('SELECT COUNT(*) c FROM customers').get().c;
  if (count > 0 && !force) return;
  if (force) {
    // Children before parents (foreign_keys = ON). New pillar tables cleared too
    // so `--reseed` recreates a clean, deterministic dataset.
    db.exec(
      'DELETE FROM notifications; DELETE FROM ai_messages; DELETE FROM ai_proposals; DELETE FROM ai_conversations; DELETE FROM scheduler_lock; DELETE FROM redemptions; DELETE FROM birthday_claims; DELETE FROM cart_events; DELETE FROM cart_items; DELETE FROM inquiries; DELETE FROM promo_codes; DELETE FROM events; DELETE FROM purchases; DELETE FROM posts; DELETE FROM campaigns; DELETE FROM holidays; DELETE FROM customers;'
    );
  }

  const now = new Date('2026-07-21T09:00:00Z');
  const iso = (d) => new Date(d).toISOString();
  const daysAgo = (n) => iso(now.getTime() - n * 86400000);

  const insCustomer = db.prepare(`INSERT INTO customers
    (tg_user_id, login, name, phone, email, birthday, city, address, birthday_source, birthday_recorded_at, consent, notes, created_at)
    VALUES (@tg_user_id,@login,@name,@phone,@email,@birthday,@city,@address,'seed',@created_at,@consent,@notes,@created_at)`);
  const insPurchase = db.prepare(`INSERT INTO purchases
    (customer_id,title,amount_usd,orig_amount,orig_currency,source_channel,invoice_ref,status,cost_usd,cost_entered_at,created_at)
    VALUES (@customer_id,@title,@amount_usd,@orig_amount,@orig_currency,@source_channel,@invoice_ref,'confirmed',@cost_usd,@cost_entered_at,@created_at)`);
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
    (name,month,day,emoji,default_percent,enabled,mode,value,min_order_usd,valid_days,created_at)
    VALUES (@name,@month,@day,@emoji,@default_percent,@enabled,'percent',@default_percent,0,14,@created_at)`);
  const insCampaign = db.prepare(`INSERT INTO campaigns
    (name,type,percent,audience_json,holiday_id,starts_at,ends_at,recurring,window_days,promo_valid_days,status,source,created_by,created_at,updated_at)
    VALUES (@name,@type,@percent,@audience_json,@holiday_id,@starts_at,@ends_at,@recurring,@window_days,@promo_valid_days,@status,@source,@created_by,@created_at,@updated_at)`);

  // Катерина's birthday is set to *today's* MM-DD (real clock, not the fixed
  // demo clock) so the birthday-claim flow can be exercised the moment the
  // database is seeded — see docs/BUSINESS-LOGIC.md §7.1.
  const realToday = new Date();
  const todayMmDd = `${String(realToday.getUTCMonth() + 1).padStart(2, '0')}-${String(realToday.getUTCDate()).padStart(2, '0')}`;

  const customers = [
    { tg_user_id: '100000001', login: 'olena_k',  name: 'Олена Ковальчук',  phone: '+380671112233', email: 'olena.k@gmail.com',  birthday: '1990-07-28', city: 'Київ',    address: 'м. Київ, вул. Хрещатик 22, кв. 14',            consent: 1, notes: 'VIP, купує систематично' },
    { tg_user_id: '100000002', login: 'iryna_d',  name: 'Ірина Демченко',   phone: '+380931234567', email: 'iryna.d@gmail.com',  birthday: '1988-03-14', city: 'Львів',   address: 'м. Львів, вул. Городоцька 108, кв. 3',          consent: 1, notes: '' },
    { tg_user_id: '100000003', login: 'marina_v', name: 'Марина Волошина',  phone: '+13475550101',  email: 'marina.v@gmail.com', birthday: '1995-11-02', city: 'New York',address: '350 5th Ave, Apt 21B, New York, NY 10118',      consent: 1, notes: 'США, luxury' },
    { tg_user_id: '100000004', login: 'kate_s',   name: 'Катерина Сидоренко',phone: '+380509998877', email: 'kate.s@gmail.com',  birthday: `1992-${todayMmDd}`, city: 'Одеса', address: 'м. Одеса, вул. Дерибасівська 5, кв. 9',       consent: 1, notes: 'ДР сьогодні — тестовий кейс для знижки' },
    { tg_user_id: '100000005', login: 'natali_p', name: 'Наталія Панченко', phone: '+380661239988', email: 'natali.p@gmail.com', birthday: '1985-01-19', city: 'Дніпро',  address: 'м. Дніпро, пр. Яворницького 60, кв. 41',        consent: 1, notes: 'купила один раз, не повертається' },
    { tg_user_id: '100000006', login: 'yulia_h',  name: 'Юлія Гончар',      phone: '+380671114455', email: 'yulia.h@gmail.com',  birthday: null,         city: 'Харків',  address: 'м. Харків, вул. Сумська 78, кв. 12',            consent: 1, notes: 'дата народження не вказана — перевірка першої заявки' },
    { tg_user_id: '100000007', login: 'sofia_m',  name: 'Софія Мельник',    phone: '+13105550199',  email: 'sofia.m@gmail.com',  birthday: '1993-12-05', city: 'Los Angeles', address: '1234 Sunset Blvd, Apt 7, Los Angeles, CA 90026', consent: 1, notes: 'luxury, великі суми' },
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
  // cost_usd = what Maryna actually paid in China (factory + shipping + fees).
  // Deterministic 52–68% of the sale price so the profit report has real
  // numbers; the three most recent orders are left NULL on purpose so the
  // "next day after the sale, remind me to enter the cost" flow is demonstrable.
  P.forEach(([ci, title, usd, orig, cur, ch, ago], i) => {
    const withCost = i < P.length - 3;
    const cost = withCost ? Math.round(usd * (0.52 + ((i * 7) % 17) / 100) * 100) / 100 : null;
    insPurchase.run({
      customer_id: ids[ci], title, amount_usd: usd, orig_amount: orig,
      orig_currency: cur, source_channel: ch, invoice_ref: null,
      cost_usd: cost, cost_entered_at: cost === null ? null : daysAgo(ago),
      created_at: daysAgo(ago),
    });
  });

  // Feed posts — a few from each channel (source 'channel' = pulled from TG).
  const posts = [
    // The main channel — the 4500-subscriber one. Its posts are the «Канал» tab.
    { channel: 'main', title: 'Нове надходження сумок 👜', body: 'Дівчата, виклала нові позиції Chanel та Dior у каталогах. Дивіться у застосунку — тиснете «Хочу цю позицію», і я скажу ціну.', price: null, currency: 'USD', source: 'channel', ago: 0, img: '👜' },
    { channel: 'main', title: 'Доставка США 10–14 днів ✈️', body: 'Замовлення цього тижня приходять до 20 числа. Оплата після підтвердження ціни.', price: null, currency: 'USD', source: 'channel', ago: 2, img: '✈️' },
    { channel: 'main', title: 'Бонуси клубу 💛', body: '$100 бонусу за покупку від $2000 та $50 на день народження від замовлення $500. Все видно у застосунку.', price: null, currency: 'USD', source: 'channel', ago: 5, img: '💛' },
    // Older demo positions, re-homed into the real catalogues.
    { channel: 'accessories', title: 'Lauren Ralph Lauren ремінь двосторонній', body: 'Ціну підтверджує Марина.', price: null, currency: 'USD', source: 'channel', ago: 1, img: '🧣' },
    { channel: 'clothes', title: 'Calvin Klein сукня', body: 'Нова колекція. Доставка 10–14 днів.', price: null, currency: 'USD', source: 'app', ago: 0, img: '👗' },
    { channel: 'watch', title: 'Fossil жіночий годинник', body: 'Залишилось 2 шт.', price: null, currency: 'USD', source: 'channel', ago: 2, img: '⌚' },
    { channel: 'available', title: 'Bottega Veneta Jodie', body: 'В наявності, повний комплект.', price: 2900, currency: 'USD', source: 'channel', ago: 1, img: '👜' },
    { channel: 'men', title: 'Moncler Maya', body: 'Розміри 1–3 в наявності.', price: 1600, currency: 'USD', source: 'app', ago: 0, img: '🧥' },
    { channel: 'accessories', title: 'Gucci GG Marmont ремінь', body: 'Pre-order 7 днів.', price: 520, currency: 'USD', source: 'channel', ago: 3, img: '🔗' },
  ];
  const postIds = posts.map((p) =>
    Number(insPost.run({
      channel: p.channel, tg_message_id: p.source === 'channel' ? 1000 + posts.indexOf(p) : null,
      title: p.title, body: p.body, price: p.price, currency: p.currency,
      image_url: p.img, source: p.source, created_at: daysAgo(p.ago),
    }).lastInsertRowid)
  );

  // ── The 15 brand catalogues, as Maryna actually runs them ────────────────
  //  One Telegram channel per brand, each a filter chip in the Mini App. Seeded
  //  with two positions apiece so the catalogue tab, the filters and the
  //  popularity report all have something real to show before the test channel
  //  is connected.
  //  These are Maryna's REAL catalogues (list received 01.08.2026) — thematic,
  //  not per-brand. The `username` matters: when the bot is made an admin of a
  //  channel, resolveChannel() matches the first post by @username and binds
  //  the numeric chat_id, so a channel starts working with no configuration.
  const CATALOGS = [
    { key: 'bags',        username: 'w2b_luxury_bags',        title: 'Сумки жіночі',        emoji: '👜', items: [['Chanel Classic Flap Medium', 'CH-1112'], ['Hermès Evelyne III', 'HE-7701']] },
    { key: 'shoes',       username: 'w2b_luxury_shoes',       title: 'Взуття жіноче',       emoji: '👠', items: [['Christian Louboutin So Kate', 'CL-2210'], ['Chanel Slingback', 'CH-2255']] },
    { key: 'clothes',     username: 'w2b_luxury_clothes',     title: 'Одяг жіночий',        emoji: '👗', items: [['Max Mara Teddy Coat', 'MM-3310'], ['Brunello Cucinelli светр', 'BC-3345']] },
    { key: 'available',   username: 'w2b_luxury_available',   title: 'Товари в наявності',  emoji: '✅', items: [['LV Neverfull MM — в наявності', 'LV-4410'], ['Dior Book Tote — в наявності', 'DI-4455']] },
    { key: 'jewelry',     username: 'w2b_luxury_jewelry',     title: 'Прикраси',            emoji: '💍', items: [['Cartier Love браслет', 'CA-5510'], ['Tiffany T кільце', 'TF-5544']] },
    { key: 'men',         username: 'w2b_luxury_men',         title: 'Чоловічий одяг',      emoji: '🤵', items: [['Stone Island худі', 'SI-6610'], ['Moncler пуховик', 'MO-6655']] },
    { key: 'shoes_man',   username: 'w2b_shoes_man',          title: 'Чоловіче взуття',     emoji: '👞', items: [['Gucci Ace кросівки', 'GU-7710'], ['Prada Monolith черевики', 'PR-7745']] },
    { key: 'leather',     username: 'w2b_luxury_leather',     title: 'Шкіра та хутро',      emoji: '🧥', items: [['Шкіряна куртка Bottega', 'BV-8810'], ['Дублянка Loro Piana', 'LP-8855']] },
    { key: 'wallet',      username: 'w2b_luxury_wallet',      title: 'Гаманці',             emoji: '👛', items: [['Chanel Classic гаманець', 'CH-9910'], ['YSL Monogram гаманець', 'YS-9955']] },
    { key: 'accessories', username: 'w2b_luxury_accessories', title: 'Аксесуари',           emoji: '🕶️', items: [['Hermès хустка', 'HE-1010'], ['Dior окуляри', 'DI-1055']] },
    { key: 'watch',       username: 'w2b_luxury_watch',       title: 'Годинники',           emoji: '⌚', items: [['Cartier Tank', 'CA-1110'], ['Rolex Datejust 31', 'RO-1155']] },
    { key: 'chanel',      username: 'w2b_luxury_chanel',      title: 'Chanel',              emoji: '🖤', items: [['Chanel 22 Small', 'CH-2205'], ['Chanel 19 Flap', 'CH-2219']] },
    { key: 'fine_jewelry', username: 'w2b_luxury_jewerly',    title: 'Коштовні прикраси',   emoji: '💎', items: [['Van Cleef Alhambra', 'VC-1310'], ['Bvlgari Serpenti', 'BV-1355']] },
    { key: 'hermes',      username: 'w2b_hermes',             title: 'Hermès',              emoji: '🟠', items: [['Hermès Birkin 25', 'HE-1410'], ['Hermès Kelly 28', 'HE-1455']] },
  ];

  // The two demo channels from the first prototype are not real catalogues —
  // switching them off keeps the filter row honest without dropping old rows.
  db.prepare("UPDATE channels SET enabled=0 WHERE key IN ('ukraine','luxury')").run();
  // A catalogue that is no longer in the list (an earlier per-brand layout, a
  // channel Maryna closed) is hidden rather than deleted: its posts and its
  // popularity history stay readable.
  const keep = CATALOGS.map((c) => c.key);
  db.prepare(
    `UPDATE channels SET enabled=0
      WHERE kind='catalog' AND chat_id IS NULL AND key NOT IN (${keep.map(() => '?').join(',')})`
  ).run(...keep);

  // Upsert, not insert-or-ignore: the catalogue list is configuration that
  // changes (Maryna renames a channel, adds one), and a stale row with the same
  // key must not shadow the new definition. chat_id is never overwritten —
  // that one is learned from Telegram and is the binding that actually works.
  const insCatalogChannel = db.prepare(`INSERT INTO channels
    (key,chat_id,username,title,emoji,kind,enabled,created_at)
    VALUES (?,NULL,?,?,?, 'catalog',1,?)
    ON CONFLICT(key) DO UPDATE SET
      username = excluded.username,
      title    = excluded.title,
      emoji    = excluded.emoji,
      kind     = 'catalog',
      enabled  = 1`);
  const catalogPostIds = [];
  let catSeq = 0;
  for (const cat of CATALOGS) {
    insCatalogChannel.run(cat.key, cat.username, cat.title, cat.emoji, daysAgo(60));
    for (const [title, article] of cat.items) {
      catSeq += 1;
      const id = Number(db.prepare(`INSERT INTO posts
        (channel,tg_message_id,title,body,price,currency,image_url,article,source,status,created_at)
        VALUES (?,?,?,?,NULL,'USD',?,?, 'channel','published',?)`)
        .run(cat.key, 2000 + catSeq, title,
          'Ціну та наявність підтверджує Марина — натисніть «Хочу цю позицію».',
          '👜', article, daysAgo(catSeq % 14))
        .lastInsertRowid);
      catalogPostIds.push({ id, channel: cat.key, title, article });
    }
  }

  // ── Demo popularity: what has been tried on over this month and last ──────
  //  Written straight into the journal (that is the only source the reports
  //  read), so «Популярне» has a month AND a year to show.
  const insCartEvent = db.prepare(`INSERT INTO cart_events
    (customer_id,post_id,action,title,article,channel,price_usd,inquiry_id,created_at,ym,y)
    VALUES (?,?,?,?,?,?,NULL,NULL,?,?,?)`);
  const demoAdd = (customerId, item, ago, action = 'added') => {
    const at = daysAgo(ago);
    insCartEvent.run(customerId, item.id, action, item.title, item.article, item.channel,
      at, at.slice(0, 7), at.slice(0, 4));
  };
  // Chanel Classic Flap is the runaway favourite, then Lady Dior, then LV.
  [0, 1, 2, 3, 4, 5].forEach((n) => demoAdd(ids[n % ids.length], catalogPostIds[0], n % 12));
  [0, 2, 4].forEach((n) => demoAdd(ids[n % ids.length], catalogPostIds[2], n + 1));
  [1, 3].forEach((n) => demoAdd(ids[n % ids.length], catalogPostIds[4], n + 2));
  demoAdd(ids[5], catalogPostIds[6], 3);
  demoAdd(ids[6], catalogPostIds[8], 4);
  // Two of them got as far as an actual question, one changed their mind.
  demoAdd(ids[0], catalogPostIds[0], 1, 'sent');
  demoAdd(ids[2], catalogPostIds[2], 2, 'sent');
  demoAdd(ids[4], catalogPostIds[4], 3, 'removed');
  // Last month, so the yearly view differs from the monthly one.
  [40, 45, 52].forEach((ago, n) => demoAdd(ids[n % ids.length], catalogPostIds[1], ago));

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
  // Maryna's real birthday bonus: $50 fixed, from a $500 order, valid a month.
  const bdayKate = Number(db.prepare(`INSERT INTO promo_codes
    (customer_id,code,percent,mode,amount_usd,min_order_usd,rule_key,reason,status,created_at,expires_at,campaign_id)
    VALUES (?,?,0,'fixed',50,500,'birthday',?, 'active',?,?,?)`)
    .run(ids[3], 'BDAY-KATE-50', 'День народження 🎂', daysAgo(0), daysAgo(-30), birthdayRuleId).lastInsertRowid);
  const vipOlena = Number(insPromo.run({ customer_id: ids[0], code: 'VIP-OLENA-15', percent: 15, reason: 'Gold-клієнт', status: 'active', created_at: daysAgo(2), expires_at: daysAgo(-10), campaign_id: vipRuleId }).lastInsertRowid);
  const saleSofia = Number(insPromo.run({ customer_id: ids[6], code: 'SUMMER-SOFIA-20', percent: 20, reason: 'Літній SALE ☀️', status: 'active', created_at: daysAgo(1), expires_at: daysAgo(-9), campaign_id: summerSaleId }).lastInsertRowid);

  // Notifications — the in-app feed is the authoritative delivery channel
  // (ADR-005); dedupe_key is what makes a re-run a no-op.
  insNotif.run({ customer_id: ids[3], kind: 'birthday', title: 'Вітаємо з днем народження! 🎂', body: 'Ваша знижка $50 від замовлення $500 — промокод BDAY-KATE-50, діє 30 днів.', promo_code_id: bdayKate, campaign_id: birthdayRuleId, dedupe_key: `bday:${ids[3]}:2026`, in_app_status: 'unread', created_at: daysAgo(0) });
  insNotif.run({ customer_id: ids[0], kind: 'near_reward', title: 'Бонус $100 за покупку від $2000 💰', body: 'Нараховуємо $100 за кожну покупку від $2000, накопичення до $300.', promo_code_id: null, campaign_id: null, dedupe_key: `near:${ids[0]}:2026-07`, in_app_status: 'unread', created_at: daysAgo(1) });
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
