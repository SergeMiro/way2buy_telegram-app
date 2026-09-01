// The fitting room somebody filled and walked away from.
//
// One rule, one promise: the discount goes out once per person and never again.
// Most of this file is that promise under attack — the job run twice, run five
// times, run again after the person adds something new, run concurrently with
// itself. A second discount is not a cosmetic bug: it is the shop paying twice
// for the same nudge, and finding out about it from a client.
import './helpers/tmpdb.js';
process.env.W2B_ABANDON_HOURS = '5';
process.env.W2B_ABANDON_PERCENT = '10';
process.env.W2B_ABANDON_VALID_DAYS = '7';

import test from 'node:test';
import assert from 'node:assert/strict';
import { migrate, db } from '../server/db.js';
import { addToCart, sendInquiry } from '../server/cart.js';
import { config, remindAbandoned, hasGrant, pending } from '../server/abandoned.js';
import { set as setSetting } from '../server/settings.js';

await migrate();

const HOUR = 3600_000;
const NOW = Date.UTC(2026, 7, 15, 12);
const iso = (ms) => new Date(ms).toISOString();

let seq = 0;
async function customer(name) {
  seq += 1;
  return await db.prepare('SELECT * FROM customers WHERE id=?').get(
    (await db.prepare('INSERT INTO customers (tg_user_id,name,created_at) VALUES (?,?,?)')
      .run(`ab-${seq}`, `${name} ${seq}`, iso(NOW - 30 * 24 * HOUR))).lastInsertRowid
  );
}
async function post(title = 'Сумка') {
  seq += 1;
  return Number((await db.prepare(`INSERT INTO posts
    (channel,tg_message_id,title,body,price,currency,image_url,article,source,status,created_at)
    VALUES ('bags',?,?,'',500,'USD','👜',?, 'channel','published',?)`)
    .run(seq, title, `ART-${seq}`, iso(NOW))).lastInsertRowid);
}
// Put something in the fitting room and backdate it, which is the only way to
// be five hours old inside a test that runs in milliseconds.
async function addedHoursAgo(c, hours, count = 1) {
  for (let i = 0; i < count; i += 1) {
    const p = await post();
    await addToCart({ customerId: c.id, postId: p, now: NOW });
  }
  await db.prepare("UPDATE cart_items SET created_at=? WHERE customer_id=? AND status='active'")
    .run(iso(NOW - hours * HOUR), c.id);
}

/* ── the rule names itself ───────────────────────────────────────────────── */

test('the grant key is the rule, spelled the way it is spoken', async () => {
  const cfg = await config();
  assert.equal(cfg.hours, 5);
  assert.equal(cfg.percent, 10);
  assert.equal(cfg.grantKey, '5hour_10per');
});

/* ── who qualifies ───────────────────────────────────────────────────────── */

test('five hours is the line: four hours is still shopping', async () => {
  const early = await customer('Рано');
  await addedHoursAgo(early, 4);
  const waited = await customer('Чекала');
  await addedHoursAgo(waited, 6);

  const ids = (await pending(NOW, await config())).map((r) => Number(r.customer_id));
  assert.ok(!ids.includes(early.id), 'four hours in, they may still be choosing');
  assert.ok(ids.includes(waited.id));
});

test('somebody who DID write is not abandoned — sending empties the room', async () => {
  const c = await customer('Написала');
  await addedHoursAgo(c, 8, 2);
  await sendInquiry({ customer: c, message: 'Скільки коштує?', now: NOW });

  const ids = (await pending(NOW, await config())).map((r) => Number(r.customer_id));
  assert.ok(!ids.includes(c.id), 'her items are sent, not sitting');

  const res = await remindAbandoned(NOW);
  assert.ok(!(await hasGrant(c.id, '5hour_10per')), 'and she gets no discount for it');
  void res;
});

/* ── the discount itself ─────────────────────────────────────────────────── */

test('a forgotten fitting room gets one message and one promo code', async () => {
  const c = await customer('Забула');
  await addedHoursAgo(c, 7, 3);

  const res = await remindAbandoned(NOW);
  assert.ok(res.granted >= 1);
  assert.equal(res.grantKey, '5hour_10per');

  const promos = await db.prepare("SELECT * FROM promo_codes WHERE customer_id=? AND rule_key='5hour_10per'").all(c.id);
  assert.equal(promos.length, 1);
  assert.equal(Number(promos[0].percent), 10);
  assert.equal(promos[0].mode, 'percent');
  assert.equal(promos[0].status, 'active');
  // Seven days, not "some time".
  assert.equal(Math.round((Date.parse(promos[0].expires_at) - NOW) / (24 * HOUR)), 7);

  const notes = await db.prepare("SELECT * FROM notifications WHERE customer_id=? AND kind='abandoned_cart'").all(c.id);
  assert.equal(notes.length, 1);
  assert.match(notes[0].body, /10%/);
  assert.match(notes[0].body, new RegExp(promos[0].code));
  assert.match(notes[0].body, /3 позиції/, 'it says how many things are waiting');

  // The flag the whole rule turns on.
  assert.equal(await hasGrant(c.id, '5hour_10per'), true);
});

/* ── once. ever. ─────────────────────────────────────────────────────────── */

test('running the job again changes nothing', async () => {
  const c = await customer('Двічі');
  await addedHoursAgo(c, 9);

  const first = await remindAbandoned(NOW);
  assert.ok(first.granted >= 1);

  for (let i = 0; i < 4; i += 1) await remindAbandoned(NOW + i * HOUR);

  const promos = await db.prepare("SELECT * FROM promo_codes WHERE customer_id=? AND rule_key='5hour_10per'").all(c.id);
  const notes = await db.prepare("SELECT * FROM notifications WHERE customer_id=? AND kind='abandoned_cart'").all(c.id);
  const grants = await db.prepare("SELECT * FROM customer_grants WHERE customer_id=? AND grant_key='5hour_10per'").all(c.id);
  assert.equal(promos.length, 1, 'one promo code after five runs');
  assert.equal(notes.length, 1, 'one message after five runs');
  assert.equal(grants.length, 1);
});

test('a NEW forgotten fitting room a month later still gets nothing', async () => {
  // The offer is per person, not per fitting room. Somebody who learns that
  // waiting five hours produces ten per cent would otherwise wait every time.
  const c = await customer('Хитра');
  await addedHoursAgo(c, 6);
  await remindAbandoned(NOW);

  await db.prepare("UPDATE cart_items SET status='sent' WHERE customer_id=?").run(c.id);
  await addedHoursAgo(c, 6, 2);
  const later = await remindAbandoned(NOW + 30 * 24 * HOUR);

  const promos = await db.prepare("SELECT COUNT(*) n FROM promo_codes WHERE customer_id=? AND rule_key='5hour_10per'").get(c.id);
  assert.equal(Number(promos.n), 1);
  assert.ok(later.alreadyHad >= 1, 'and the run reports them as already served');
});

test('two ticks racing produce one discount, because the database decides', async () => {
  const c = await customer('Гонка');
  await addedHoursAgo(c, 6);

  // Not a simulation of concurrency — actual concurrency, both awaiting the
  // same insert. Whichever loses ON CONFLICT must not go on to send.
  await Promise.all([remindAbandoned(NOW), remindAbandoned(NOW), remindAbandoned(NOW)]);

  const promos = await db.prepare("SELECT COUNT(*) n FROM promo_codes WHERE customer_id=? AND rule_key='5hour_10per'").get(c.id);
  const notes = await db.prepare("SELECT COUNT(*) n FROM notifications WHERE customer_id=? AND kind='abandoned_cart'").get(c.id);
  assert.equal(Number(promos.n), 1);
  assert.equal(Number(notes.n), 1);
});

test('the rule can be switched off without deleting anything', async () => {
  // The switch is a row in `app_settings` now — «Параметри» → Примірочна — so
  // turning the rule off is a tap in the cabinet, not a redeploy.
  await setSetting('abandon.enabled', 0);
  try {
    const c = await customer('Вимкнено');
    await addedHoursAgo(c, 10);
    const res = await remindAbandoned(NOW);
    assert.equal(res.skipped, true);
    assert.equal(await hasGrant(c.id, '5hour_10per'), false);
  } finally {
    await setSetting('abandon.enabled', 1);
  }
});

test('switching it back on does not re-grant to whoever already had it', async () => {
  const c = await customer('Вже отримав');
  await addedHoursAgo(c, 10);
  await remindAbandoned(NOW);
  assert.equal(await hasGrant(c.id, '5hour_10per'), true);

  await setSetting('abandon.enabled', 0);
  await remindAbandoned(NOW);
  await setSetting('abandon.enabled', 1);
  const res = await remindAbandoned(NOW);
  assert.equal(res.granted, 0, 'второй раз выдавать нельзя');
});
