// ─────────────────────────────────────────────────────────────────────────
//  db.js — PostgreSQL data layer (Supabase).
//
//  Two drivers behind one interface:
//    • `pg` against DATABASE_URL — production and any real deployment.
//    • PGlite (Postgres 17 compiled to WASM, in-process) when no DATABASE_URL
//      is set — the test suite and a zero-config local run. It is the same
//      Postgres, so the tests exercise the real dialect instead of a stand-in.
//
//  The statement API deliberately mirrors better-sqlite3 (prepare().get/.all/
//  .run(), `?` and `@named` parameters) — see sql.js. Queries are now
//  asynchronous, so every call site awaits, but the SQL itself did not have to
//  be rewritten.
//
//  The schema lives in sql/schema.sql, not in this file. DDL as a data file is
//  reviewable, is what gets applied to Supabase, and is what the tests load.
// ─────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { compile, bindArgs, withReturning, normalizeRows } from './sql.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, 'sql', 'schema.sql');

const CONNECTION_STRING =
  process.env.DATABASE_URL || process.env.W2B_DATABASE_URL || '';

// ── driver ────────────────────────────────────────────────────────────────
// A driver is just { query(text, params) → {rows, fields, rowCount}, close() }
// plus an optional acquire() for transactions.

let driver = null;
let ready = null;

async function createPgDriver(connectionString) {
  const { default: pg } = await import('pg');

  // Never pass `name` to query(): a named statement becomes a server-side
  // prepared statement, which the Supabase transaction pooler (port 6543)
  // cannot carry across pooled connections. Leaving it out keeps the same code
  // working on the pooler and on a direct connection.
  const pool = new pg.Pool({
    connectionString,
    max: Number(process.env.W2B_DB_POOL_MAX || (process.env.VERCEL ? 1 : 10)),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: Number(process.env.W2B_DB_CONNECT_TIMEOUT_MS || 15_000),
    // Supabase terminates TLS with a publicly trusted certificate. Verification
    // stays on unless explicitly waived, so a misrouted connection fails loudly
    // instead of trusting whatever answered.
    ssl: process.env.W2B_DB_SSL_INSECURE === '1'
      ? { rejectUnauthorized: false }
      : undefined,
  });

  // An idle client dying (pooler recycling, network blip) must not take the
  // process with it — the pool replaces it on the next checkout.
  pool.on('error', (err) => {
    console.error('[db] idle client error:', err.message);
  });

  return {
    kind: 'pg',
    async query(text, params) {
      const r = await pool.query(text, params);
      return { rows: r.rows, fields: r.fields, rowCount: r.rowCount };
    },
    // Simple protocol: the only one that accepts several statements in one
    // string, which is how schema.sql is applied. Never takes parameters.
    async exec(text) {
      await pool.query(text);
    },
    async acquire() {
      const client = await pool.connect();
      return {
        async query(text, params) {
          const r = await client.query(text, params);
          return { rows: r.rows, fields: r.fields, rowCount: r.rowCount };
        },
        async exec(text) {
          await client.query(text);
        },
        release: () => client.release(),
      };
    },
    close: () => pool.end(),
  };
}

async function createPgliteDriver() {
  const { PGlite } = await import('@electric-sql/pglite');
  const dataDir = process.env.W2B_PGLITE_DIR || undefined; // undefined = in-memory
  const lite = await PGlite.create(dataDir ? { dataDir } : undefined);

  const run = async (text, params) => {
    const r = await lite.query(text, params);
    return {
      rows: r.rows ?? [],
      fields: r.fields ?? [],
      // PGlite calls it affectedRows; for a SELECT it reports 0, so fall back to
      // the row count to keep `changes` meaningful for both.
      rowCount: r.affectedRows ?? (r.rows ? r.rows.length : 0),
    };
  };

  const execAll = (text) => lite.exec(text);

  return {
    kind: 'pglite',
    query: run,
    exec: execAll,
    // Single connection: a transaction is BEGIN/COMMIT on the same instance.
    async acquire() {
      return { query: run, exec: execAll, release: () => {} };
    },
    close: () => lite.close(),
  };
}

async function connect() {
  if (driver) return driver;
  driver = CONNECTION_STRING
    ? await createPgDriver(CONNECTION_STRING)
    : await createPgliteDriver();
  return driver;
}

/** Resolves once the driver exists. Every statement awaits this first. */
async function connection() {
  if (driver) return driver;
  if (!ready) ready = await connect();
  return ready;
}

export function driverKind() {
  return driver ? driver.kind : (CONNECTION_STRING ? 'pg' : 'pglite');
}

// ── statement API ─────────────────────────────────────────────────────────

function makeStatement(sql, executor) {
  const compiled = compile(sql);
  const selectText = compiled.text;
  const insertText = withReturning(compiled.text);

  const exec = async (text, args) => {
    const conn = await executor();
    const params = bindArgs(compiled.names, args);
    const res = await conn.query(text, params);
    return { ...res, rows: normalizeRows(res.rows, res.fields) };
  };

  return {
    /** First row, or undefined — better-sqlite3's get() contract. */
    async get(...args) {
      const res = await exec(selectText, args);
      return res.rows[0];
    },
    async all(...args) {
      const res = await exec(selectText, args);
      return res.rows;
    },
    /** { changes, lastInsertRowid } — see withReturning() in sql.js. */
    async run(...args) {
      const res = await exec(insertText, args);
      return {
        changes: res.rowCount ?? 0,
        lastInsertRowid: res.rows[0]?.id ?? null,
      };
    },
    /** The translated Postgres text — used by the tests and for debugging. */
    get source() {
      return insertText;
    },
  };
}

function statementFactory(executor) {
  return {
    prepare: (sql) => makeStatement(sql, executor),
    async exec(sql) {
      const conn = await executor();
      await conn.exec(sql);
    },
  };
}

const defaultExecutor = () => connection();

export const db = {
  ...statementFactory(defaultExecutor),

  /**
   * Runs fn inside a single transaction, on one connection.
   *
   * fn receives a scoped { prepare, exec } — statements must be prepared from it
   * rather than from the module-level db, otherwise they would run on a
   * different pooled connection and fall outside the transaction.
   */
  async transaction(fn) {
    const conn = await connection();
    const held = await conn.acquire();
    const scoped = statementFactory(async () => held);
    try {
      await held.query('BEGIN', []);
      const result = await fn(scoped);
      await held.query('COMMIT', []);
      return result;
    } catch (err) {
      try {
        await held.query('ROLLBACK', []);
      } catch (rollbackErr) {
        // Surface it: a failed rollback means the connection is in an unknown
        // state, which is a different and worse problem than the original error.
        console.error('[db] rollback failed:', rollbackErr.message);
      }
      throw err;
    } finally {
      held.release();
    }
  },

  async close() {
    if (driver) {
      await driver.close();
      driver = null;
      ready = null;
    }
  },
};

// ── migrate ───────────────────────────────────────────────────────────────

/** Applies sql/schema.sql. Idempotent: every statement is CREATE … IF NOT EXISTS. */
export async function migrate() {
  const conn = await connection();
  await conn.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  await seedRulesAndChannels();
}

// Rule and channel rows are configuration, not demo data: created if missing on
// every boot (including against production) and never overwritten, so an admin
// edit is not reverted by a restart.
async function seedRulesAndChannels() {
  const ts = new Date().toISOString();
  const insRule = db.prepare(`INSERT INTO discount_rules
    (key,kind,name,emoji,enabled,mode,value,min_order_usd,cap_usd,valid_days,updated_at,updated_by)
    VALUES (@key,@kind,@name,@emoji,true,@mode,@value,@min_order_usd,@cap_usd,@valid_days,@updated_at,'system')
    ON CONFLICT (key) DO NOTHING`);

  // Maryna, 31.07.2026: "$2000 — это одна покупка" → $100 per single order of
  // $2000+, accumulating to a hard $300 ceiling.
  await insRule.run({
    key: 'cashback', kind: 'cashback', name: 'Кешбек за покупку', emoji: '💰',
    mode: 'fixed', value: 100, min_order_usd: 2000, cap_usd: 300, valid_days: null,
    updated_at: ts,
  });
  // "скидка 50$ на ДР от заказа 500$ … ДЕЙСТВУЕТ 1 месяц"
  await insRule.run({
    key: 'birthday', kind: 'birthday', name: 'Знижка на день народження', emoji: '🎂',
    mode: 'fixed', value: 50, min_order_usd: 500, cap_usd: null, valid_days: 30,
    updated_at: ts,
  });

  const insChannel = db.prepare(`INSERT INTO channels
    (key,chat_id,username,title,emoji,kind,enabled,created_at)
    VALUES (@key,@chat_id,@username,@title,@emoji,@kind,true,@created_at)
    ON CONFLICT (key) DO NOTHING`);
  await insChannel.run({
    key: 'main', chat_id: process.env.CHANNEL_MAIN_CHAT_ID || null,
    username: process.env.CHANNEL_MAIN || 'Way2Buy_Ukraine',
    title: 'Way2Buy', emoji: '🛍️', kind: 'main', created_at: ts,
  });
  // Legacy demo channels — kept so existing seeded posts still resolve.
  await insChannel.run({ key: 'ukraine', chat_id: null, username: process.env.CHANNEL_UKRAINE || 'Way2Buy_Ukraine', title: 'Way2Buy Ukraine', emoji: '🇺🇦', kind: 'catalog', created_at: ts });
  await insChannel.run({ key: 'luxury', chat_id: null, username: process.env.CHANNEL_LUXURY || 'Way2Buy_Luxury', title: 'Way2Buy Luxury', emoji: '💎', kind: 'catalog', created_at: ts });
}

// ── seed: a small, realistic dataset (5–10 customers) ─────────────────────

export async function seed({ force = false } = {}) {
  const count = (await db.prepare('SELECT COUNT(*) c FROM customers').get()).c;
  if (count > 0 && !force) return;
  if (force) {
    // TRUNCATE … CASCADE in one statement: order stops mattering, and the
    // identity sequences restart so a reseed is byte-for-byte reproducible.
    await db.exec(`TRUNCATE TABLE
      notifications, ai_messages, ai_proposals, ai_conversations, scheduler_lock,
      redemptions, birthday_claims, cart_events, cart_items, inquiries,
      promo_codes, events, purchases, posts, campaigns, holidays, customers
      RESTART IDENTITY CASCADE`);
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
  const insNotif = db.prepare(`INSERT INTO notifications
    (customer_id,kind,title,body,promo_code_id,campaign_id,dedupe_key,in_app_status,dm_status,created_at)
    VALUES (@customer_id,@kind,@title,@body,@promo_code_id,@campaign_id,@dedupe_key,@in_app_status,'simulated',@created_at)
    ON CONFLICT DO NOTHING`);
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
    { tg_user_id: '100000001', login: 'olena_k',  name: 'Олена Ковальчук',  phone: '+380671112233', email: 'olena.k@gmail.com',  birthday: '1990-07-28', city: 'Київ',    address: 'м. Київ, вул. Хрещатик 22, кв. 14',            consent: true, notes: 'VIP, купує систематично' },
    { tg_user_id: '100000002', login: 'iryna_d',  name: 'Ірина Демченко',   phone: '+380931234567', email: 'iryna.d@gmail.com',  birthday: '1988-03-14', city: 'Львів',   address: 'м. Львів, вул. Городоцька 108, кв. 3',          consent: true, notes: '' },
    { tg_user_id: '100000003', login: 'marina_v', name: 'Марина Волошина',  phone: '+13475550101',  email: 'marina.v@gmail.com', birthday: '1995-11-02', city: 'New York',address: '350 5th Ave, Apt 21B, New York, NY 10118',      consent: true, notes: 'США, luxury' },
    { tg_user_id: '100000004', login: 'kate_s',   name: 'Катерина Сидоренко',phone: '+380509998877', email: 'kate.s@gmail.com',  birthday: `1992-${todayMmDd}`, city: 'Одеса', address: 'м. Одеса, вул. Дерибасівська 5, кв. 9',       consent: true, notes: 'ДР сьогодні — тестовий кейс для знижки' },
    { tg_user_id: '100000005', login: 'natali_p', name: 'Наталія Панченко', phone: '+380661239988', email: 'natali.p@gmail.com', birthday: '1985-01-19', city: 'Дніпро',  address: 'м. Дніпро, пр. Яворницького 60, кв. 41',        consent: true, notes: 'купила один раз, не повертається' },
    { tg_user_id: '100000006', login: 'yulia_h',  name: 'Юлія Гончар',      phone: '+380671114455', email: 'yulia.h@gmail.com',  birthday: null,         city: 'Харків',  address: 'м. Харків, вул. Сумська 78, кв. 12',            consent: true, notes: 'дата народження не вказана — перевірка першої заявки' },
    { tg_user_id: '100000007', login: 'sofia_m',  name: 'Софія Мельник',    phone: '+13105550199',  email: 'sofia.m@gmail.com',  birthday: '1993-12-05', city: 'Los Angeles', address: '1234 Sunset Blvd, Apt 7, Los Angeles, CA 90026', consent: true, notes: 'luxury, великі суми' },
  ];

  const ids = [];
  for (const [index, c] of customers.entries()) {
    const info = await insCustomer.run({ ...c, created_at: daysAgo(120 - index * 5) });
    ids.push(Number(info.lastInsertRowid));
  }

  // Purchases — designed so tiers/cashback are visibly different across people.
  // amount_usd is what drives cashback.
  const P = [
    // Олена — Gold, two cashback milestones crossed ($200 earned, $100 already
    // redeemed below ⇒ $100 available).
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
    // Ірина — Gold
    [1, 'Guess сумка', 240, 9900, 'UAH', 'ukraine', 60],
    [1, 'Nike Air Force', 130, 5400, 'UAH', 'ukraine', 20],
    [1, 'Tommy Hilfiger куртка', 190, 7850, 'UAH', 'ukraine', 44],
    // Марина — Luxury Platinum, big spender
    [2, 'Hermès Kelly', 4800, 4800, 'USD', 'luxury', 88],
    [2, 'Bottega Veneta сумка', 2900, 2900, 'USD', 'luxury', 33],
    [2, 'Saint Laurent чоботи', 1250, 1250, 'USD', 'luxury', 66],
    [2, 'Moncler пуховик', 1600, 1600, 'USD', 'luxury', 5],
    // Катерина — Gold, birthday today
    [3, 'Zara total look', 160, 6600, 'UAH', 'ukraine', 22],
    [3, 'Adidas Samba', 120, 4950, 'UAH', 'ukraine', 41],
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
  for (const [i, row] of P.entries()) {
    const [ci, title, usd, orig, cur, ch, ago] = row;
    const withCost = i < P.length - 3;
    const cost = withCost ? Math.round(usd * (0.52 + ((i * 7) % 17) / 100) * 100) / 100 : null;
    await insPurchase.run({
      customer_id: ids[ci], title, amount_usd: usd, orig_amount: orig,
      orig_currency: cur, source_channel: ch, invoice_ref: null,
      cost_usd: cost, cost_entered_at: cost === null ? null : daysAgo(ago),
      created_at: daysAgo(ago),
    });
  }

  // Feed posts — a few from each channel (source 'channel' = pulled from TG).
  const posts = [
    { channel: 'main', title: 'Нове надходження сумок 👜', body: 'Дівчата, виклала нові позиції Chanel та Dior у каталогах. Дивіться у застосунку — тиснете «Хочу цю позицію», і я скажу ціну.', price: null, currency: 'USD', source: 'channel', ago: 0, img: '👜' },
    { channel: 'main', title: 'Доставка США 10–14 днів ✈️', body: 'Замовлення цього тижня приходять до 20 числа. Оплата після підтвердження ціни.', price: null, currency: 'USD', source: 'channel', ago: 2, img: '✈️' },
    { channel: 'main', title: 'Бонуси клубу 💛', body: '$100 бонусу за покупку від $2000 та $50 на день народження від замовлення $500. Все видно у застосунку.', price: null, currency: 'USD', source: 'channel', ago: 5, img: '💛' },
    { channel: 'accessories', title: 'Lauren Ralph Lauren ремінь двосторонній', body: 'Ціну підтверджує Марина.', price: null, currency: 'USD', source: 'channel', ago: 1, img: '🧣' },
    { channel: 'clothes', title: 'Calvin Klein сукня', body: 'Нова колекція. Доставка 10–14 днів.', price: null, currency: 'USD', source: 'app', ago: 0, img: '👗' },
    { channel: 'watch', title: 'Fossil жіночий годинник', body: 'Залишилось 2 шт.', price: null, currency: 'USD', source: 'channel', ago: 2, img: '⌚' },
    { channel: 'available', title: 'Bottega Veneta Jodie', body: 'В наявності, повний комплект.', price: 2900, currency: 'USD', source: 'channel', ago: 1, img: '👜' },
    { channel: 'men', title: 'Moncler Maya', body: 'Розміри 1–3 в наявності.', price: 1600, currency: 'USD', source: 'app', ago: 0, img: '🧥' },
    { channel: 'accessories', title: 'Gucci GG Marmont ремінь', body: 'Pre-order 7 днів.', price: 520, currency: 'USD', source: 'channel', ago: 3, img: '🔗' },
  ];
  const postIds = [];
  for (const [index, p] of posts.entries()) {
    const info = await insPost.run({
      channel: p.channel, tg_message_id: p.source === 'channel' ? 1000 + index : null,
      title: p.title, body: p.body, price: p.price, currency: p.currency,
      image_url: p.img, source: p.source, created_at: daysAgo(p.ago),
    });
    postIds.push(Number(info.lastInsertRowid));
  }

  // ── The brand catalogues, as Maryna actually runs them ────────────────────
  //  One Telegram channel per catalogue, each a filter chip in the Mini App.
  //  The `username` matters: when the bot is made an admin of a channel,
  //  await resolveChannel() matches the first post by @username and binds the numeric
  //  chat_id, so a channel starts working with no configuration.
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
  await db.prepare("UPDATE channels SET enabled=false WHERE key IN ('ukraine','luxury')").run();
  // A catalogue no longer in the list is hidden rather than deleted: its posts
  // and its popularity history stay readable.
  const keep = CATALOGS.map((c) => c.key);
  await db.prepare(
    `UPDATE channels SET enabled=false
      WHERE kind='catalog' AND chat_id IS NULL AND key <> ALL(?::text[])`
  ).run(keep);

  // Upsert, not insert-or-ignore: the catalogue list is configuration that
  // changes (Maryna renames a channel, adds one), and a stale row with the same
  // key must not shadow the new definition. chat_id is never overwritten —
  // that one is learned from Telegram and is the binding that actually works.
  const insCatalogChannel = db.prepare(`INSERT INTO channels
    (key,chat_id,username,title,emoji,kind,enabled,created_at)
    VALUES (?,NULL,?,?,?,'catalog',true,?)
    ON CONFLICT(key) DO UPDATE SET
      username = excluded.username,
      title    = excluded.title,
      emoji    = excluded.emoji,
      kind     = 'catalog',
      enabled  = true`);
  const insCatalogPost = db.prepare(`INSERT INTO posts
    (channel,tg_message_id,title,body,price,currency,image_url,article,source,status,created_at)
    VALUES (?,?,?,?,NULL,'USD',?,?,'channel','published',?)`);

  const catalogPostIds = [];
  let catSeq = 0;
  for (const cat of CATALOGS) {
    await insCatalogChannel.run(cat.key, cat.username, cat.title, cat.emoji, daysAgo(60));
    for (const [title, article] of cat.items) {
      catSeq += 1;
      const info = await insCatalogPost.run(
        cat.key, 2000 + catSeq, title,
        'Ціну та наявність підтверджує Марина — натисніть «Хочу цю позицію».',
        '👜', article, daysAgo(catSeq % 14)
      );
      catalogPostIds.push({ id: Number(info.lastInsertRowid), channel: cat.key, title, article });
    }
  }

  // ── Demo popularity: what has been tried on over this month and last ──────
  //  Written straight into the journal (that is the only source the reports
  //  read), so «Популярне» has a month AND a year to show.
  const insCartEvent = db.prepare(`INSERT INTO cart_events
    (customer_id,post_id,action,title,article,channel,price_usd,inquiry_id,created_at,ym,y)
    VALUES (?,?,?,?,?,?,NULL,NULL,?,?,?)`);
  const demoAdd = async (customerId, item, ago, action = 'added') => {
    const at = daysAgo(ago);
    await insCartEvent.run(customerId, item.id, action, item.title, item.article, item.channel,
      at, at.slice(0, 7), at.slice(0, 4));
  };
  // Chanel Classic Flap is the runaway favourite, then Lady Dior, then LV.
  for (const n of [0, 1, 2, 3, 4, 5]) await demoAdd(ids[n % ids.length], catalogPostIds[0], n % 12);
  for (const n of [0, 2, 4]) await demoAdd(ids[n % ids.length], catalogPostIds[2], n + 1);
  for (const n of [1, 3]) await demoAdd(ids[n % ids.length], catalogPostIds[4], n + 2);
  await demoAdd(ids[5], catalogPostIds[6], 3);
  await demoAdd(ids[6], catalogPostIds[8], 4);
  // Two of them got as far as an actual question, one changed their mind.
  await demoAdd(ids[0], catalogPostIds[0], 1, 'sent');
  await demoAdd(ids[2], catalogPostIds[2], 2, 'sent');
  await demoAdd(ids[4], catalogPostIds[4], 3, 'removed');
  // Last month, so the yearly view differs from the monthly one.
  for (const [n, ago] of [40, 45, 52].entries()) {
    await demoAdd(ids[n % ids.length], catalogPostIds[1], ago);
  }

  // Events — interest / return signals
  await insEvent.run({ customer_id: ids[3], post_id: postIds[2], type: 'want', meta: null, created_at: daysAgo(0) });
  await insEvent.run({ customer_id: ids[0], post_id: postIds[4], type: 'return', meta: '5 переглядів', created_at: daysAgo(0) });
  await insEvent.run({ customer_id: ids[5], post_id: postIds[1], type: 'want', meta: null, created_at: daysAgo(1) });
  await insEvent.run({ customer_id: ids[6], post_id: postIds[6], type: 'view', meta: null, created_at: daysAgo(1) });

  // Redemption example (Олена вже списала $100)
  await db.prepare('INSERT INTO redemptions (customer_id,amount_usd,note,created_at) VALUES (?,?,?,?)')
    .run(ids[0], 100, 'Кешбек списано на замовлення #A-204', daysAgo(15));

  // Holiday calendar: Ukraine-focused + a few global. Recurring by MM-DD;
  // admin-editable at runtime. default_percent is the suggested discount.
  const holidays = [
    { name: 'Новий рік',                 month: 1,  day: 1,  emoji: '🎉', default_percent: 20 },
    { name: 'Різдво (за старим стилем)', month: 1,  day: 7,  emoji: '✨', default_percent: 15 },
    { name: 'День закоханих',            month: 2,  day: 14, emoji: '💝', default_percent: 15 },
    { name: '8 Березня',                 month: 3,  day: 8,  emoji: '🌷', default_percent: 20 },
    { name: 'Великдень (орієнтовно)',    month: 4,  day: 20, emoji: '🐣', default_percent: 15 },
    { name: 'День Незалежності України', month: 8,  day: 24, emoji: '🇺🇦', default_percent: 24 },
    { name: 'Чорна пʼятниця',            month: 11, day: 28, emoji: '🖤', default_percent: 30 },
    { name: 'Кіберпонеділок',            month: 12, day: 1,  emoji: '💻', default_percent: 25 },
    { name: 'Різдво (за новим стилем)',  month: 12, day: 25, emoji: '🎄', default_percent: 25 },
  ];
  for (const h of holidays) {
    await insHoliday.run({ ...h, enabled: true, created_at: daysAgo(120) });
  }

  // Demo campaigns.
  // 1) A holiday-type campaign whose window brackets the fixed demo "now"
  //    (2026-07-21T09:00:00Z): active today so its cards render in-app.
  const summerSaleId = Number((await insCampaign.run({
    name: 'Літній SALE ☀️', type: 'holiday', percent: 20, audience_json: null,
    holiday_id: null, starts_at: daysAgo(4), ends_at: daysAgo(-10),
    recurring: false, window_days: 0, promo_valid_days: 14, status: 'active',
    source: 'manual', created_by: null, created_at: daysAgo(4), updated_at: daysAgo(4),
  })).lastInsertRowid);
  // 2) A recurring birthday rule (fires window_days before a customer's birthday).
  const birthdayRuleId = Number((await insCampaign.run({
    name: 'День народження 🎂', type: 'birthday', percent: 25, audience_json: null,
    holiday_id: null, starts_at: null, ends_at: null,
    recurring: true, window_days: 3, promo_valid_days: 14, status: 'active',
    source: 'manual', created_by: null, created_at: daysAgo(30), updated_at: daysAgo(30),
  })).lastInsertRowid);
  // 3) A VIP rule, so the 💎 card variant is demonstrable too.
  const vipRuleId = Number((await insCampaign.run({
    name: 'VIP-клуб 💎', type: 'vip', percent: 15,
    audience_json: JSON.stringify({ tier: 'gold' }),
    holiday_id: null, starts_at: daysAgo(30), ends_at: null,
    recurring: false, window_days: 0, promo_valid_days: 30, status: 'active',
    source: 'manual', created_by: null, created_at: daysAgo(30), updated_at: daysAgo(30),
  })).lastInsertRowid);

  // Promo codes — materialized *from* the campaigns above, so `await discountsFor()`
  // can join back and pick the right card variant (🎂 / 🎉 / 💎).
  // Maryna's real birthday bonus: $50 fixed, from a $500 order, valid a month.
  const bdayKate = Number((await db.prepare(`INSERT INTO promo_codes
    (customer_id,code,percent,mode,amount_usd,min_order_usd,rule_key,reason,status,created_at,expires_at,campaign_id)
    VALUES (?,?,0,'fixed',50,500,'birthday',?,'active',?,?,?)`)
    .run(ids[3], 'BDAY-KATE-50', 'День народження 🎂', daysAgo(0), daysAgo(-30), birthdayRuleId)).lastInsertRowid);
  const vipOlena = Number((await insPromo.run({ customer_id: ids[0], code: 'VIP-OLENA-15', percent: 15, reason: 'Gold-клієнт', status: 'active', created_at: daysAgo(2), expires_at: daysAgo(-10), campaign_id: vipRuleId })).lastInsertRowid);
  const saleSofia = Number((await insPromo.run({ customer_id: ids[6], code: 'SUMMER-SOFIA-20', percent: 20, reason: 'Літній SALE ☀️', status: 'active', created_at: daysAgo(1), expires_at: daysAgo(-9), campaign_id: summerSaleId })).lastInsertRowid);

  // Notifications — the in-app feed is the authoritative delivery channel
  // (ADR-005); dedupe_key is what makes a re-run a no-op.
  await insNotif.run({ customer_id: ids[3], kind: 'birthday', title: 'Вітаємо з днем народження! 🎂', body: 'Ваша знижка $50 від замовлення $500 — промокод BDAY-KATE-50, діє 30 днів.', promo_code_id: bdayKate, campaign_id: birthdayRuleId, dedupe_key: `bday:${ids[3]}:2026`, in_app_status: 'unread', created_at: daysAgo(0) });
  await insNotif.run({ customer_id: ids[0], kind: 'near_reward', title: 'Бонус $100 за покупку від $2000 💰', body: 'Нараховуємо $100 за кожну покупку від $2000, накопичення до $300.', promo_code_id: null, campaign_id: null, dedupe_key: `near:${ids[0]}:2026-07`, in_app_status: 'unread', created_at: daysAgo(1) });
  await insNotif.run({ customer_id: ids[0], kind: 'new_discount', title: 'VIP-знижка 15% активна 💎', body: `Промокод VIP-OLENA-15 діє до ${daysAgo(-10).slice(0, 10)}.`, promo_code_id: vipOlena, campaign_id: vipRuleId, dedupe_key: 'promo:VIP-OLENA-15', in_app_status: 'read', created_at: daysAgo(2) });
  await insNotif.run({ customer_id: ids[6], kind: 'holiday', title: 'Літній SALE ☀️ −20%', body: 'Промокод SUMMER-SOFIA-20 у «Покупках».', promo_code_id: saleSofia, campaign_id: summerSaleId, dedupe_key: 'promo:SUMMER-SOFIA-20', in_app_status: 'unread', created_at: daysAgo(1) });
}

// ─────────────────────────────────────────────────────────────────────────
//  await init(): connect, and apply the schema when it is this process's job to.
//
//  On an ephemeral PGlite database (tests, zero-config local run) the schema
//  has to be created every time. Against a real Postgres it does not: applying
//  66 CREATE ... IF NOT EXISTS statements on every serverless cold start costs
//  latency for nothing, and DDL from a request path is a bad habit. Set
//  W2B_AUTO_MIGRATE=1 to opt in, or run `npm run migrate`.
// ─────────────────────────────────────────────────────────────────────────
export async function init({ migrateIfNeeded = true } = {}) {
  await connection();
  const ephemeral = driverKind() === 'pglite' && !process.env.W2B_PGLITE_DIR;
  if (migrateIfNeeded && (ephemeral || process.env.W2B_AUTO_MIGRATE === '1')) {
    await migrate();
  }
  if (ephemeral || process.env.W2B_AUTO_SEED === '1') {
    await seed();
  }
}

// CLI: `node server/db.js --migrate | --reseed`
if (process.argv[1] && process.argv[1].endsWith('db.js')) {
  const { default: dotenv } = await import('dotenv');
  dotenv.config({ override: true, quiet: true });
  await migrate();
  if (process.argv.includes('--reseed')) await seed({ force: true });
  else await seed();
  const target = CONNECTION_STRING ? CONNECTION_STRING.replace(/:[^:@/]*@/, ':***@') : 'PGlite (in-memory)';
  console.log('DB ready:', target);
  await db.close();
}
