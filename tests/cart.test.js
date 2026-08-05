import './helpers/tmpdb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { migrate, db } from '../server/db.js';
import {
  addToCart, removeFromCart, listCart, cartCount, cartView, bestPromo,
  sendInquiry, listInquiries, setInquiryStatus,
  popularItems, popularityStats, resolvePeriod,
} from '../server/cart.js';

await migrate();

const DAY = 86400000;
const NOW = Date.UTC(2026, 6, 31, 12);
const iso = (ms) => new Date(ms).toISOString();

let seq = 0;
async function customer(name = 'Клієнт') {
  seq += 1;
  return await db.prepare('SELECT * FROM customers WHERE id=?').get(
    (await db.prepare('INSERT INTO customers (tg_user_id,name,phone,created_at) VALUES (?,?,?,?)')
      .run(`cart-${seq}`, `${name} ${seq}`, '+1555000' + seq, iso(NOW))).lastInsertRowid
  );
}

async function post({ title = 'Chanel 22 Bag', article = 'CH22', channel = 'bags', price = null, at = NOW } = {}) {
  return Number((await db.prepare(`INSERT INTO posts
    (channel,tg_message_id,title,body,price,currency,image_url,article,source,status,created_at)
    VALUES (?,?,?,?,?,?,?,?, 'channel','published',?)`)
    .run(channel, ++seq, title, '', price, 'USD', '👜', article, iso(at))).lastInsertRowid);
}

// ── the fitting room ──────────────────────────────────────────────────────

test('adding a post to the fitting room stores a snapshot of it', async () => {
  const c = await customer('Оксана');
  const p = await post({ title: 'Dior Lady', article: 'DL01', channel: 'dior' });
  const r = await addToCart({ customerId: c.id, postId: p, now: NOW });

  assert.equal(r.ok, true);
  assert.equal(r.added, true);
  assert.equal(r.count, 1);
  assert.equal(r.item.title, 'Dior Lady');
  assert.equal(r.item.article, 'DL01');
  assert.equal(r.item.channel, 'dior');
});

test('tapping «Хочу» twice is not an error and does not duplicate the item', async () => {
  const c = await customer();
  const p = await post();
  await addToCart({ customerId: c.id, postId: p, now: NOW });
  const second = await addToCart({ customerId: c.id, postId: p, now: NOW });

  assert.equal(second.ok, true);
  assert.equal(second.added, false);
  assert.equal(await cartCount(c.id), 1);
  // The journal must not record a second add either — that would inflate stats.
  const adds = (await db.prepare("SELECT COUNT(*) n FROM cart_events WHERE customer_id=? AND action='added'").get(c.id)).n;
  assert.equal(adds, 1);
});

test('a missing post is refused instead of creating an empty item', async () => {
  const c = await customer();
  const r = await addToCart({ customerId: c.id, postId: 999999, now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'post_not_found');
  assert.equal(await cartCount(c.id), 0);
});

test('removing keeps the history: the add and the removal both stay in the journal', async () => {
  const c = await customer();
  const p = await post();
  const added = await addToCart({ customerId: c.id, postId: p, now: NOW });
  const r = await removeFromCart({ customerId: c.id, itemId: added.item.id, now: NOW });

  assert.equal(r.ok, true);
  assert.equal(r.count, 0);
  assert.equal((await listCart(c.id)).length, 0);
  const events = await db.prepare('SELECT action FROM cart_events WHERE customer_id=? ORDER BY id').all(c.id);
  assert.deepEqual(events.map((e) => e.action), ['added', 'removed']);
});

test('one client cannot remove another client\'s item', async () => {
  const a = await customer('А');
  const b = await customer('Б');
  const p = await post();
  const added = await addToCart({ customerId: a.id, postId: p, now: NOW });
  const r = await removeFromCart({ customerId: b.id, itemId: added.item.id, now: NOW });

  assert.equal(r.ok, false);
  assert.equal(await cartCount(a.id), 1);
});

test('the fitting room view pre-writes the message so the client types nothing', async () => {
  const c = await customer();
  await addToCart({ customerId: c.id, postId: await post({ title: 'Gucci Marmont', article: 'GM7' }), now: NOW });
  const view = await cartView(c.id, NOW);

  assert.equal(view.count, 1);
  assert.match(view.draft, /Gucci Marmont/);
  assert.match(view.draft, /GM7/);
});

// ── the coupon that applies itself ────────────────────────────────────────

async function promo(customerId, { mode = 'fixed', value = 50, minOrder = 0, expiresInDays = 30 } = {}) {
  return Number((await db.prepare(`INSERT INTO promo_codes
    (customer_id,code,percent,mode,amount_usd,min_order_usd,reason,status,created_at,expires_at)
    VALUES (?,?,?,?,?,?,?, 'active',?,?)`)
    .run(customerId, `T-${++seq}`, mode === 'percent' ? value : 0, mode,
      mode === 'fixed' ? value : null, minOrder, 'Тест', iso(NOW),
      iso(NOW + expiresInDays * DAY))).lastInsertRowid);
}

test('the best usable coupon is picked automatically — no choosing by the client', async () => {
  const c = await customer();
  await promo(c.id, { mode: 'fixed', value: 50 });
  await promo(c.id, { mode: 'percent', value: 20 });   // 20% of $600 = $120 > $50
  const best = await bestPromo(c.id, 600, NOW);

  assert.equal(best.mode, 'percent');
  assert.equal(best.amountUsd, 120);
  assert.equal(best.usable, true);
});

test('a coupon below its minimum order is shown but marked unusable', async () => {
  const c = await customer();
  await promo(c.id, { mode: 'fixed', value: 50, minOrder: 500 });
  const best = await bestPromo(c.id, 200, NOW);

  assert.equal(best.label, '$50');
  assert.equal(best.usable, false);
  assert.equal(best.minOrderUsd, 500);
});

test('an expired coupon is never offered', async () => {
  const c = await customer();
  await promo(c.id, { mode: 'fixed', value: 50, expiresInDays: -1 });
  assert.equal(await bestPromo(c.id, 900, NOW), null);
});

// ── sending the inquiry ───────────────────────────────────────────────────

test('sending builds the message Maryna asked for and notifies the admins', async () => {
  const c = await customer('Катерина');
  await addToCart({ customerId: c.id, postId: await post({ title: 'Chanel Classic', article: 'CC1' }), now: NOW });
  await addToCart({ customerId: c.id, postId: await post({ title: 'LV Neverfull', article: 'LV9' }), now: NOW });

  const r = await sendInquiry({ customer: c, message: 'Чи є чорний колір?', now: NOW });

  assert.equal(r.ok, true);
  assert.equal(r.items, 2);
  assert.match(r.message, /Даша/);

  const alert = await db.prepare("SELECT * FROM notifications WHERE customer_id IS NULL AND kind='inquiry' ORDER BY id DESC").get();
  assert.match(alert.title, /цікавиться товаром/);
  assert.match(alert.body, /Chanel Classic/);
  assert.match(alert.body, /LV Neverfull/);
  assert.match(alert.body, /задав питання адміністратору Даші/);
  assert.match(alert.body, /«Чи є чорний колір\?»/);

  // The client gets their own confirmation.
  const ack = await db.prepare("SELECT * FROM notifications WHERE customer_id=? AND kind='inquiry_sent'").get(c.id);
  assert.ok(ack);
  assert.match(ack.body, /звʼяжеться/);
});

test('sending empties the fitting room but keeps the items on the inquiry', async () => {
  const c = await customer();
  await addToCart({ customerId: c.id, postId: await post({ title: 'Prada Re-Edition' }), now: NOW });
  const r = await sendInquiry({ customer: c, message: '', now: NOW });

  assert.equal(await cartCount(c.id), 0);
  const q = (await listInquiries({ limit: 5 })).find((x) => x.id === r.inquiryId);
  assert.equal(q.itemsCount, 1);
  assert.equal(q.items[0].title, 'Prada Re-Edition');
  assert.equal(q.status, 'new');
});

test('an inquiry with no text still says what the client wants', async () => {
  const c = await customer();
  await addToCart({ customerId: c.id, postId: await post({ title: 'Hermes Evelyne' }), now: NOW });
  await sendInquiry({ customer: c, message: '', now: NOW });

  const alert = await db.prepare("SELECT * FROM notifications WHERE customer_id IS NULL AND kind='inquiry' ORDER BY id DESC").get();
  assert.match(alert.body, /просить ціну та наявність/);
});

test('the usable coupon is attached to the inquiry automatically', async () => {
  const c = await customer();
  await promo(c.id, { mode: 'fixed', value: 50, minOrder: 100 });
  await addToCart({ customerId: c.id, postId: await post({ title: 'Bag', price: 400 }), now: NOW });
  const r = await sendInquiry({ customer: c, message: '', now: NOW });

  assert.equal(r.promo.label, '$50');
  const q = (await listInquiries({ limit: 5 })).find((x) => x.id === r.inquiryId);
  assert.equal(q.promoLabel, '$50');
});

test('an empty fitting room cannot be sent', async () => {
  const c = await customer();
  const r = await sendInquiry({ customer: c, message: 'привіт', now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'empty_cart');
});

test('an inquiry can be marked answered and closed', async () => {
  const c = await customer();
  await addToCart({ customerId: c.id, postId: await post(), now: NOW });
  const r = await sendInquiry({ customer: c, message: '', now: NOW });

  assert.equal(await setInquiryStatus(r.inquiryId, { status: 'answered', by: 'dasha', now: NOW }), true);
  assert.equal((await listInquiries({ status: 'answered' })).some((x) => x.id === r.inquiryId), true);
  await assert.rejects(() => setInquiryStatus(r.inquiryId, { status: 'нет-такого', now: NOW }));
});

// ── popularity: month and year over the same journal ──────────────────────

test('period resolution covers month, year and all time', () => {
  assert.equal(resolvePeriod({ period: 'month', now: NOW }).from, '2026-07-01');
  assert.equal(resolvePeriod({ period: 'month', now: NOW }).to, '2026-07-31');
  assert.equal(resolvePeriod({ period: 'year', now: NOW }).from, '2026-01-01');
  assert.equal(resolvePeriod({ period: 'year', now: NOW }).to, '2026-12-31');
  assert.equal(resolvePeriod({ period: 'all', now: NOW }).kind, 'all');
  // February in a leap year must not end on the 28th.
  assert.equal(resolvePeriod({ period: 'month', now: Date.UTC(2028, 1, 10) }).to, '2028-02-29');
});

test('popularity ranks items by how often they land in a fitting room', async () => {
  // A private database slice: a channel nobody else in this file uses.
  const hot = await post({ title: 'Хіт сезону', article: 'HOT1', channel: 'stats' });
  const mild = await post({ title: 'Спокійна модель', article: 'MILD', channel: 'stats' });

  for (let i = 0; i < 3; i += 1) {
    await addToCart({ customerId: (await customer()).id, postId: hot, now: NOW });
  }
  await addToCart({ customerId: (await customer()).id, postId: mild, now: NOW });

  const top = (await popularItems({ period: 'month', channel: 'stats', now: NOW })).items;
  assert.equal(top[0].article, 'HOT1');
  assert.equal(top[0].adds, 3);
  assert.equal(top[0].people, 3);
  assert.equal(top[1].article, 'MILD');
});

test('the same journal answers monthly and yearly questions', async () => {
  const p = await post({ title: 'Річна модель', article: 'YEAR1', channel: 'yearly' });
  const june = Date.UTC(2026, 5, 15, 10);
  await addToCart({ customerId: (await customer()).id, postId: p, now: june });   // last month
  await addToCart({ customerId: (await customer()).id, postId: p, now: NOW });    // this month

  const month = await popularityStats({ period: 'month', channel: 'yearly', now: NOW });
  const year = await popularityStats({ period: 'year', channel: 'yearly', now: NOW });

  assert.equal(month.totals.adds, 1);
  assert.equal(year.totals.adds, 2);
  // A month is read day by day, a year month by month.
  assert.equal(month.timeline[0].bucket.length, 10);
  assert.equal(year.timeline[0].bucket, '2026-06');
  assert.equal(year.timeline.length, 2);
});

test('an item deleted from the channel keeps its statistics', async () => {
  const p = await post({ title: 'Знята позиція', article: 'GONE', channel: 'gone' });
  await addToCart({ customerId: (await customer()).id, postId: p, now: NOW });
  await db.prepare('DELETE FROM posts WHERE id=?').run(p);

  const top = (await popularItems({ period: 'month', channel: 'gone', now: NOW })).items;
  assert.equal(top.length, 1);
  assert.equal(top[0].title, 'Знята позиція');
  assert.equal(top[0].adds, 1);
});

test('statistics separate "tried on" from "actually asked about"', async () => {
  const kept = await post({ title: 'Запитали', channel: 'conv' });
  const dropped = await post({ title: 'Передумали', channel: 'conv' });
  const c = await customer();
  await addToCart({ customerId: c.id, postId: kept, now: NOW });
  const d = await addToCart({ customerId: c.id, postId: dropped, now: NOW });
  await removeFromCart({ customerId: c.id, itemId: d.item.id, now: NOW });
  await sendInquiry({ customer: c, message: '', now: NOW });

  const s = await popularityStats({ period: 'month', channel: 'conv', now: NOW });
  assert.equal(s.totals.adds, 2);
  assert.equal(s.totals.removes, 1);
  assert.equal(s.totals.sends, 1);
  assert.equal(s.totals.sendRatePct, 50);
});
