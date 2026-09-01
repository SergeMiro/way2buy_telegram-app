import './helpers/tmpdb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { migrate, db } from '../server/db.js';
import { addToCart, sendInquiry } from '../server/cart.js';
import {
  openDeal, listDeals, getDeal, counts, setStatus, stale, remindStaleDeals, config, dealLink,
} from '../server/deals.js';

await migrate();

const DAY = 86400000;
const NOW = Date.UTC(2026, 8, 1, 12);
const iso = (ms) => new Date(ms).toISOString();

let seq = 0;
async function customer(name = 'Клієнт') {
  seq += 1;
  return await db.prepare('SELECT * FROM customers WHERE id=?').get(
    (await db.prepare('INSERT INTO customers (tg_user_id,name,phone,created_at) VALUES (?,?,?,?)')
      .run(`deal-${seq}`, `${name} ${seq}`, '+1555100' + seq, iso(NOW))).lastInsertRowid
  );
}

async function post({ title = 'Chanel 22', article = 'CH22', channel = 'bags' } = {}) {
  return Number((await db.prepare(`INSERT INTO posts
    (channel,tg_message_id,title,body,price,currency,image_url,article,source,status,created_at)
    VALUES (?,?,?,?,?,?,?,?, 'channel','published',?)`)
    .run(channel, ++seq, title, '', null, 'USD', '👜', article, iso(NOW))).lastInsertRowid);
}

// ── the card opens by itself ──────────────────────────────────────────────

test('sending an inquiry files the client under «в процесі»', async () => {
  const c = await customer('Оксана');
  await addToCart({ customerId: c.id, postId: await post({ article: 'DL01' }), now: NOW });
  const sent = await sendInquiry({ customer: c, message: 'Скільки коштує?', now: NOW });
  assert.equal(sent.ok, true);

  const open = await listDeals({ status: 'in_progress', now: NOW });
  const mine = open.find((d) => d.customerId === c.id);
  assert.ok(mine, 'a deal was opened');
  assert.equal(mine.status, 'in_progress');
  assert.equal(mine.inProgress, true);
  assert.equal(mine.bought, false);
  assert.equal(mine.notBought, false);
  assert.equal(mine.inquiryId, sent.inquiryId);
  assert.equal(mine.articles, 'DL01');
  assert.equal(mine.itemsCount, 1);
  // The client's own question travels with the card, so answering it does not
  // need a second screen.
  assert.equal(mine.message, 'Скільки коштує?');
});

test('one deal per inquiry — a retried send cannot open a second card', async () => {
  const c = await customer();
  await addToCart({ customerId: c.id, postId: await post(), now: NOW });
  const sent = await sendInquiry({ customer: c, now: NOW });

  const again = await openDeal({ customerId: c.id, inquiryId: sent.inquiryId, items: [], now: NOW });
  const rows = await db.prepare('SELECT COUNT(*) n FROM deals WHERE inquiry_id=?').get(sent.inquiryId);
  assert.equal(rows.n, 1);
  // …and it hands back the card that already exists rather than nothing.
  assert.ok(again);
});

// ── the three columns ─────────────────────────────────────────────────────

test('the three boolean columns follow the status and can never disagree', async () => {
  const c = await customer();
  const id = await openDeal({ customerId: c.id, inquiryId: null, items: [{ article: 'X1' }], now: NOW });

  await setStatus(id, { status: 'bought', by: '555', amountUsd: 1200, now: NOW });
  let row = await db.prepare('SELECT * FROM deals WHERE id=?').get(id);
  assert.equal(row.in_progress, false);
  assert.equal(row.bought, true);
  assert.equal(row.not_bought, false);
  assert.equal(Number(row.amount_usd), 1200);
  assert.equal(row.decided_by, '555');

  await setStatus(id, { status: 'not_bought', by: '555', now: NOW });
  row = await db.prepare('SELECT * FROM deals WHERE id=?').get(id);
  assert.equal(row.bought, false);
  assert.equal(row.not_bought, true);
  // Correcting the status must not quietly erase the sum somebody typed.
  assert.equal(Number(row.amount_usd), 1200);
});

test('the pencil: a mis-tap goes back to «в процесі», decision and all', async () => {
  const c = await customer();
  const id = await openDeal({ customerId: c.id, inquiryId: null, items: [], now: NOW });
  await setStatus(id, { status: 'bought', by: '777', now: NOW });
  const back = await setStatus(id, { status: 'in_progress', by: '777', now: NOW });

  assert.equal(back.status, 'in_progress');
  assert.equal(back.inProgress, true);
  // "In progress, decided by Dasha on the 4th" would be a lie.
  assert.equal(back.decidedBy, null);
  assert.equal(back.decidedAt, null);
});

test('an unknown status is refused rather than stored', async () => {
  const c = await customer();
  const id = await openDeal({ customerId: c.id, inquiryId: null, items: [], now: NOW });
  await assert.rejects(() => setStatus(id, { status: 'maybe' }), /статус/);
});

test('setStatus on a deal that is not there reports it instead of inventing one', async () => {
  assert.equal(await setStatus(999999, { status: 'bought' }), null);
});

test('counts feed the three tabs', async () => {
  const before = await counts();
  const c = await customer();
  const a = await openDeal({ customerId: c.id, inquiryId: null, items: [], now: NOW });
  const b = await openDeal({ customerId: c.id, inquiryId: null, items: [], now: NOW });
  await setStatus(a, { status: 'bought', now: NOW });
  await setStatus(b, { status: 'not_bought', now: NOW });

  const after = await counts();
  assert.equal(after.bought, before.bought + 1);
  assert.equal(after.not_bought, before.not_bought + 1);
  assert.equal(after.total, before.total + 2);
});

// ── the nudge ─────────────────────────────────────────────────────────────

test('a deal younger than the window is not stale, an older one is', async () => {
  const cfg = config();
  const c = await customer('Ірина');
  const fresh = await openDeal({ customerId: c.id, inquiryId: null, items: [], now: NOW });
  const old = await openDeal({ customerId: c.id, inquiryId: null, items: [], now: NOW - 20 * DAY });

  const ids = (await stale(NOW, cfg)).map((d) => d.id);
  assert.ok(!ids.includes(fresh));
  assert.ok(ids.includes(old));
});

test('a decided deal is never nudged again', async () => {
  const c = await customer();
  const id = await openDeal({ customerId: c.id, inquiryId: null, items: [], now: NOW - 30 * DAY });
  await setStatus(id, { status: 'bought', now: NOW });
  assert.ok(!(await stale(NOW)).map((d) => d.id).includes(id));
});

test('the reminder repeats on the configured rhythm and never doubles up', async () => {
  process.env.W2B_DEAL_REMIND_DAYS = '5';
  const c = await customer('Марія');
  const id = await openDeal({ customerId: c.id, inquiryId: null, items: [{ article: 'CH22' }], now: NOW - 6 * DAY });

  const first = await remindStaleDeals(NOW);
  assert.ok(first.reminded >= 1);
  assert.equal(first.days, 5);

  // A tick that runs again five minutes later must write and send nothing.
  const immediately = await remindStaleDeals(NOW + 300_000);
  assert.equal(immediately.reminded, 0);

  const row = await db.prepare('SELECT reminders FROM deals WHERE id=?').get(id);
  assert.equal(row.reminders, 1);

  // Five more days and it asks again — a different round, so a different key.
  const later = await remindStaleDeals(NOW + 6 * DAY);
  assert.ok(later.reminded >= 1);
  assert.equal((await db.prepare('SELECT reminders FROM deals WHERE id=?').get(id)).reminders, 2);

  const notes = await db.prepare(
    "SELECT dedupe_key FROM notifications WHERE kind='deal_stale' AND dedupe_key LIKE ? ORDER BY dedupe_key"
  ).all(`deal-remind:${id}:%`);
  assert.deepEqual(notes.map((n) => n.dedupe_key), [`deal-remind:${id}:1`, `deal-remind:${id}:2`]);
});

test('the reminder can be switched off entirely', async () => {
  process.env.W2B_DEAL_REMIND_ENABLED = '0';
  const r = await remindStaleDeals(NOW + 60 * DAY);
  assert.equal(r.skipped, true);
  delete process.env.W2B_DEAL_REMIND_ENABLED;
});

test('the reminder carries a link that opens this very card', async () => {
  process.env.PUBLIC_URL = 'https://app.way2buy.example/';
  assert.equal(dealLink(42), 'https://app.way2buy.example/?w2b=deal-42');
  delete process.env.PUBLIC_URL;
  // Without a public URL there is simply nothing to link to; the message still
  // reads perfectly well.
  assert.equal(dealLink(42), null);
});

test('the card knows how many days it has been open', async () => {
  const c = await customer();
  const id = await openDeal({ customerId: c.id, inquiryId: null, items: [], now: NOW - 12 * DAY });
  assert.equal((await getDeal(id, NOW)).days, 12);
});
