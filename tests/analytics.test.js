// The gap between «додав у примірочну» and «спитав у менеджера».
//
// The whole point of these numbers is a decision — what to put more of in the
// catalogue — so the failure that matters is not a crash, it is a plausible
// wrong number that somebody buys stock on. The fixture below is small enough
// to count by hand, and every assertion is a number I can trace to a line in
// it.
import './helpers/tmpdb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { migrate, db } from '../server/db.js';
import {
  monthKeys, monthlyFunnel, itemFunnel, demandBy, advice, customerTimeline,
} from '../server/analytics.js';

await migrate();

const DAY = 86400000;
const NOW = Date.UTC(2026, 7, 15, 12);          // 15 Aug 2026
const THIS_MONTH = '2026-08';
const LAST_MONTH = '2026-07';
const iso = (ms) => new Date(ms).toISOString();

let seq = 0;
async function customer(name) {
  seq += 1;
  return Number((await db.prepare('INSERT INTO customers (tg_user_id,name,created_at) VALUES (?,?,?)')
    .run(`an-${seq}`, name, iso(NOW - 60 * DAY))).lastInsertRowid);
}
async function post({ title, article, brand, category, channel = 'bags' }) {
  seq += 1;
  return Number((await db.prepare(`INSERT INTO posts
    (channel,tg_message_id,title,body,price,currency,image_url,article,brand,category,source,status,created_at)
    VALUES (?,?,?,'',500,'USD','👜',?,?,?, 'channel','published',?)`)
    .run(channel, seq, title, article, brand, category, iso(NOW - 40 * DAY))).lastInsertRowid);
}
// Straight into the journal: these tests are about what the numbers say, not
// about how a row gets there — cart.test.js already owns that.
async function event({ customerId, postId, action, title, article, channel = 'bags', at }) {
  const t = iso(at);
  await db.prepare(`INSERT INTO cart_events
    (customer_id,post_id,action,title,article,channel,created_at,ym,y)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(customerId, postId, action, title, article, channel, t, t.slice(0, 7), t.slice(0, 4));
}

// ── the shop, countable by hand ───────────────────────────────────────────
//
// August: 10 adds, 3 sent, 1 removed → 6 silent
// July:    2 adds, 2 sent            → 0 silent
const anna = await customer('Анна');
const olha = await customer('Ольга');

const kelly = await post({ title: 'Hermès Kelly', article: 'HK-1', brand: 'Hermès', category: 'сумка' });
const birkin = await post({ title: 'Hermès Birkin', article: 'HB-2', brand: 'Hermès', category: 'сумка' });
const heels = await post({ title: 'Chanel човники', article: 'CH-3', brand: 'Chanel', category: 'взуття', channel: 'shoes' });
const scarf = await post({ title: 'Dior хустка', article: 'DR-4', brand: 'Dior', category: 'аксесуар' });

// Hermès: loud AND people follow through (4 adds, 3 sent)
await event({ customerId: anna, postId: kelly, action: 'added', title: 'Hermès Kelly', article: 'HK-1', at: NOW - 9 * DAY });
await event({ customerId: anna, postId: kelly, action: 'sent',  title: 'Hermès Kelly', article: 'HK-1', at: NOW - 9 * DAY + 3600e3 });
await event({ customerId: olha, postId: kelly, action: 'added', title: 'Hermès Kelly', article: 'HK-1', at: NOW - 6 * DAY });
await event({ customerId: olha, postId: kelly, action: 'sent',  title: 'Hermès Kelly', article: 'HK-1', at: NOW - 6 * DAY + 3600e3 });
await event({ customerId: anna, postId: birkin, action: 'added', title: 'Hermès Birkin', article: 'HB-2', at: NOW - 5 * DAY });
await event({ customerId: anna, postId: birkin, action: 'sent',  title: 'Hermès Birkin', article: 'HB-2', at: NOW - 5 * DAY + 3600e3 });
await event({ customerId: olha, postId: birkin, action: 'added', title: 'Hermès Birkin', article: 'HB-2', at: NOW - 4 * DAY });

// Chanel shoes: loud and SILENT — picked up five times, asked about never.
// Five and not three on purpose: `advice` ignores anything under MIN_ADDS, so a
// three-add fixture would have tested the threshold instead of the finding.
for (const [i, who] of [[1, anna], [2, olha], [3, anna], [7, olha], [8, anna]]) {
  await event({ customerId: who, postId: heels, action: 'added', title: 'Chanel човники', article: 'CH-3', channel: 'shoes', at: NOW - i * DAY });
}
// and one taken back out
await event({ customerId: anna, postId: scarf, action: 'added',   title: 'Dior хустка', article: 'DR-4', at: NOW - 2 * DAY });
await event({ customerId: anna, postId: scarf, action: 'removed', title: 'Dior хустка', article: 'DR-4', at: NOW - 2 * DAY + 600e3 });

// last month
await event({ customerId: anna, postId: kelly, action: 'added', title: 'Hermès Kelly', article: 'HK-1', at: NOW - 40 * DAY });
await event({ customerId: anna, postId: kelly, action: 'sent',  title: 'Hermès Kelly', article: 'HK-1', at: NOW - 40 * DAY + 3600e3 });
await event({ customerId: olha, postId: birkin, action: 'added', title: 'Hermès Birkin', article: 'HB-2', at: NOW - 38 * DAY });
await event({ customerId: olha, postId: birkin, action: 'sent',  title: 'Hermès Birkin', article: 'HB-2', at: NOW - 38 * DAY + 3600e3 });

// one actual sale, attributed to its card
await db.prepare(`INSERT INTO purchases (customer_id,title,amount_usd,source_channel,status,created_at,post_id,article)
  VALUES (?,?,?,?, 'confirmed',?,?,?)`).run(anna, 'Hermès Kelly', 4200, 'bags', iso(NOW - 8 * DAY), kelly, 'HK-1');

/* ── months ──────────────────────────────────────────────────────────────── */

test('the month keys walk backwards from this month, oldest first', () => {
  const keys = monthKeys(3, NOW);
  assert.deepEqual(keys, ['2026-06', '2026-07', '2026-08']);
});

test('the funnel counts added, sent and the silence between them', async () => {
  const { months, totals } = await monthlyFunnel({ months: 3, now: NOW });
  const aug = months.find((m) => m.month === THIS_MONTH);
  const jul = months.find((m) => m.month === LAST_MONTH);

  assert.equal(aug.added, 10);
  assert.equal(aug.sent, 3);
  assert.equal(aug.removed, 1);
  assert.equal(aug.silent, 6, '10 picked up, 3 asked about, 1 put back → 6 never mentioned');
  assert.equal(aug.sentPct, 30);
  assert.equal(aug.silentPct, 60);
  assert.equal(aug.peopleAdded, 2);

  assert.equal(jul.added, 2);
  assert.equal(jul.sent, 2);
  assert.equal(jul.silent, 0, 'a month where everything got asked about');

  assert.equal(totals.added, 12);
  assert.equal(totals.sent, 5);
});

/* ── items ───────────────────────────────────────────────────────────────── */

test('item by item: what gets picked up, and what gets asked about', async () => {
  const { items, month } = await itemFunnel({ month: THIS_MONTH, now: NOW });
  assert.equal(month, THIS_MONTH);

  const heelsRow = items.find((i) => i.article === 'CH-3');
  assert.equal(heelsRow.adds, 5);
  assert.equal(heelsRow.sends, 0);
  assert.equal(heelsRow.silent, 5);
  assert.equal(heelsRow.sentPct, 0, 'five pickups and not one question — that is the finding');
  assert.equal(heelsRow.brand, 'Chanel');

  const kellyRow = items.find((i) => i.article === 'HK-1');
  assert.equal(kellyRow.adds, 2);
  assert.equal(kellyRow.sends, 2);
  assert.equal(kellyRow.sentPct, 100);
  assert.equal(kellyRow.people, 2);
  assert.ok(kellyRow.postId, 'the post id travels along so the card can be found again');

  // A card taken back out is neither a question nor silence.
  const scarfRow = items.find((i) => i.article === 'DR-4');
  assert.equal(scarfRow.removes, 1);
  assert.equal(scarfRow.silent, 0);
});

/* ── kinds of thing ──────────────────────────────────────────────────────── */

test('demand by brand, with what was actually bought beside it', async () => {
  const { rows } = await demandBy({ facet: 'brand', months: 2, now: NOW });
  const hermes = rows.find((r) => r.key === 'Hermès');
  const chanel = rows.find((r) => r.key === 'Chanel');

  assert.equal(hermes.adds, 6, '4 this month + 2 last');
  assert.equal(hermes.sends, 5, '3 this month + 2 last');
  assert.equal(hermes.bought, 1, 'attributed through purchases.post_id');
  assert.equal(hermes.items, 2);

  assert.equal(chanel.adds, 5);
  assert.equal(chanel.sends, 0);
  assert.equal(chanel.bought, 0);
  assert.ok(hermes.sentPct > chanel.sentPct);
});

test('demand by category and by catalogue answer the same question', async () => {
  const cat = await demandBy({ facet: 'category', months: 2, now: NOW });
  assert.equal(cat.rows.find((r) => r.key === 'сумка').adds, 6);
  assert.equal(cat.rows.find((r) => r.key === 'взуття').adds, 5);

  const ch = await demandBy({ facet: 'channel', months: 2, now: NOW });
  assert.equal(ch.rows.find((r) => r.key === 'shoes').adds, 5);
});

test('an unknown facet is refused rather than interpolated into SQL', async () => {
  await assert.rejects(() => demandBy({ facet: 'brand; drop table posts--' }), /unknown facet/);
});

/* ── the advice ──────────────────────────────────────────────────────────── */

test('the advice separates «add more of this» from «something is in the way»', async () => {
  const tips = await advice({ months: 2, now: NOW });
  const kinds = tips.findings.map((f) => f.kind);
  assert.ok(kinds.includes('check'), 'the silent-but-popular case must be called out');

  const chanelCheck = tips.findings.find((f) => f.kind === 'check' && f.key === 'Chanel');
  assert.ok(chanelCheck, 'Chanel: three adds, zero questions');
  assert.match(chanelCheck.text, /ціна, наявність або фото/);

  // Nothing is said about a facet with too little traffic to mean anything.
  assert.equal(tips.minAdds, 5);
  assert.ok(!tips.findings.some((f) => f.key === 'Dior' && f.kind === 'stock'),
    'one add is not a trend');
});

/* ── one client's own history ────────────────────────────────────────────── */

test('a customer timeline, in the yyyyMMdd-HHmm shape, carrying the post id', async () => {
  const t = await customerTimeline(anna);
  const addedKeys = Object.keys(t.added);
  assert.ok(addedKeys.length >= 3);
  for (const k of addedKeys) assert.match(k, /^\d{8}-\d{4}$/);

  const anyAdd = t.added[addedKeys[0]];
  assert.ok(anyAdd.item && anyAdd.postId, 'the entry can find its card in the channel');

  const boughtKeys = Object.keys(t.bought);
  assert.equal(boughtKeys.length, 1);
  assert.equal(t.bought[boughtKeys[0]].article, 'HK-1');
  assert.equal(t.bought[boughtKeys[0]].amountUsd, 4200);

  // Asked-about is kept apart from added: the difference between the two is
  // the entire subject of this file.
  assert.ok(Object.keys(t.asked).length >= 1);
});
