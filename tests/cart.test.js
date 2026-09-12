import './helpers/tmpdb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { migrate, db } from '../server/db.js';
import {
  addToCart, removeFromCart, listCart, cartCount, cartView, bestPromo,
  sendInquiry, listInquiries, setInquiryStatus, customerInquiries,
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

test('the fitting room asks the client to type nothing at all', async () => {
  const c = await customer();
  await addToCart({ customerId: c.id, postId: await post({ title: 'Gucci Marmont', article: 'GM7' }), now: NOW });
  const view = await cartView(c.id, NOW);

  assert.equal(view.count, 1);
  // The box starts EMPTY. It used to arrive pre-written — «Доброго дня! Мене
  // цікавить: 1… 2… 3…» — which nobody edited, so the manager received the list
  // twice: once as items and once as "the client's question". The list is the
  // question; the box is for what the list cannot say.
  assert.equal(view.draft, '');
  // The item itself still carries everything the message is built from.
  assert.equal(view.items[0].title, 'Gucci Marmont');
  assert.equal(view.items[0].article, 'GM7');
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
  assert.match(alert.body, /Питання клієнта:/);
  assert.match(alert.body, /«Чи є чорний колір\?»/);
  // The catalogue each item came from is NOT repeated on its line: «Dior ·
  // сумка · Сумки жіночі» adds a third word that the two before it already
  // said, five times over, in the message somebody has to read on a phone.
  assert.doesNotMatch(alert.body, /· Сумки жіночі/);

  // The client gets their own confirmation, and it answers the question they
  // actually asked: not "your message was delivered" but "somebody is checking
  // whether you can have this, and what it costs".
  const ack = await db.prepare("SELECT * FROM notifications WHERE customer_id=? AND kind='inquiry_sent'").get(c.id);
  assert.ok(ack);
  assert.match(ack.body, /перевірить наявність/);
  assert.match(ack.body, /ціну/);
  // Stored in Ukrainian whatever the client reads — the row is the record the
  // cabinet shows, and the browser translates it (see tests/i18n.test.js).
  assert.match(ack.title, /Запит надіслано/);
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

test('an inquiry with no text says what the client wants by listing it', async () => {
  const c = await customer();
  await addToCart({ customerId: c.id, postId: await post({ title: 'Hermes Evelyne' }), now: NOW });
  await sendInquiry({ customer: c, message: '', now: NOW });

  const alert = await db.prepare("SELECT * FROM notifications WHERE customer_id IS NULL AND kind='inquiry' ORDER BY id DESC").get();
  assert.match(alert.body, /Hermes Evelyne/);
  // A client who typed nothing is the normal case, not an omission to report.
  // The line that used to announce it — «Питання не додав» — was a sentence
  // about absence in a message that is already a complete request.
  assert.doesNotMatch(alert.body, /Питання не додав/);
  assert.doesNotMatch(alert.body, /Питання клієнта/);
});

/* ── the client's own history of asking ──────────────────────────────────── */

test('a client can see what they asked about after the fitting room emptied', async () => {
  const c = await customer('Леся');
  await addToCart({ customerId: c.id, postId: await post({ title: 'Dior · сумка', article: 'D1' }), now: NOW });
  await addToCart({ customerId: c.id, postId: await post({ title: 'Chanel · прикраси' }), now: NOW });
  await sendInquiry({ customer: c, message: 'Чи є 38 розмір?', now: NOW });

  // Sending empties the fitting room, so without this the list assembled over
  // several evenings vanished the moment the button was pressed.
  assert.equal(await cartCount(c.id), 0);

  const mine = await customerInquiries(c.id);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].itemsCount, 2);
  assert.equal(mine[0].message, 'Чи є 38 розмір?');
  // As a set: both items were added in the same millisecond, so the order the
  // snapshot preserves is the database's, not one this test may assert.
  assert.deepEqual(mine[0].items.map((i) => i.title).sort(), ['Chanel · прикраси', 'Dior · сумка']);
  assert.equal(mine[0].answered, false);
});

test('the shop\'s own funnel is not part of what the client is shown', async () => {
  const c = await customer('Оксана');
  await addToCart({ customerId: c.id, postId: await post({ title: 'Prada' }), now: NOW });
  const r = await sendInquiry({ customer: c, now: NOW });
  await db.prepare("UPDATE inquiries SET deal_status='not_bought', deal_status_by='Марина' WHERE id=?").run(r.inquiryId);
  await setInquiryStatus(r.inquiryId, { status: 'answered', by: 'Даша', now: NOW });

  const [mine] = await customerInquiries(c.id);
  // «не купив» is how Maryna tracks herself. It is a note about the client, not
  // to her, and it must never reach the screen she reads.
  const keys = Object.keys(mine);
  for (const leak of ['dealStatus', 'deal_status', 'answeredBy', 'answered_by', 'phone', 'tgId']) {
    assert.ok(!keys.includes(leak), `the client is shown ${leak}`);
  }
  assert.doesNotMatch(JSON.stringify(mine), /not_bought|Марина|Даша/);
  // What they DO get is the one bit that concerns them: somebody has it.
  assert.equal(mine.answered, true);
});

test('one client never sees another client\'s requests', async () => {
  const a = await customer('Анна');
  const b = await customer('Богдана');
  await addToCart({ customerId: a.id, postId: await post({ title: 'Hermes' }), now: NOW });
  await sendInquiry({ customer: a, now: NOW });

  assert.equal((await customerInquiries(b.id)).length, 0);
  assert.equal((await customerInquiries(a.id)).length, 1);
});

/* ── two questions, asked apart ──────────────────────────────────────────── */

// «Скільки коштує ця сумка» has an answer; «мене цікавить оцей пост» is a
// conversation. Both reach the fitting room through the same button, and run
// together in one list they read as one question — so whoever answers opens
// five links to find out which of them is which.
test('articles and feed posts are two groups, not one list', async () => {
  await db.prepare(
    "INSERT INTO channels (key,title,kind) VALUES ('lenta','Головний канал','main') ON CONFLICT (key) DO UPDATE SET kind='main'"
  ).run();

  const c = await customer('Ярина');
  await addToCart({ customerId: c.id, postId: await post({ title: 'Dior · сумка', channel: 'bags' }), now: NOW });
  await addToCart({ customerId: c.id, postId: await post({ title: 'Chanel · прикраси', channel: 'bags' }), now: NOW });
  await addToCart({ customerId: c.id, postId: await post({ title: 'Вечірня сукня', channel: 'lenta' }), now: NOW });

  await sendInquiry({ customer: c, now: NOW });
  const alert = await db.prepare(
    "SELECT body FROM notifications WHERE customer_id IS NULL AND kind='inquiry' ORDER BY id DESC"
  ).get();

  assert.match(alert.body, /Запитує ціну та наявність:/);
  assert.match(alert.body, /Цікавиться постом:/);
  // Each name under its own heading, and in that order.
  const askAt = alert.body.indexOf('Запитує ціну');
  const postAt = alert.body.indexOf('Цікавиться постом');
  assert.ok(askAt < alert.body.indexOf('Dior · сумка'));
  assert.ok(alert.body.indexOf('Chanel · прикраси') < postAt, 'an article landed under the posts heading');
  assert.ok(postAt < alert.body.indexOf('Вечірня сукня'));
});

test('the heading is there even when only one kind was asked about', async () => {
  // A format that changes shape depending on what is in it is one somebody has
  // to read carefully every time.
  const c = await customer('Уляна');
  await addToCart({ customerId: c.id, postId: await post({ title: 'Prada Re-Edition', channel: 'bags' }), now: NOW });
  await sendInquiry({ customer: c, now: NOW });

  const alert = await db.prepare(
    "SELECT body FROM notifications WHERE customer_id IS NULL AND kind='inquiry' ORDER BY id DESC"
  ).get();
  assert.match(alert.body, /Запитує ціну та наявність:/);
  assert.doesNotMatch(alert.body, /Цікавиться пост/, 'an empty group printed its heading');
});

test('several posts are addressed in the plural', async () => {
  await db.prepare(
    "INSERT INTO channels (key,title,kind) VALUES ('lenta','Головний канал','main') ON CONFLICT (key) DO UPDATE SET kind='main'"
  ).run();

  const c = await customer('Христина');
  await addToCart({ customerId: c.id, postId: await post({ title: 'Пост А', channel: 'lenta' }), now: NOW });
  await addToCart({ customerId: c.id, postId: await post({ title: 'Пост Б', channel: 'lenta' }), now: NOW });
  await sendInquiry({ customer: c, now: NOW });

  const alert = await db.prepare(
    "SELECT body FROM notifications WHERE customer_id IS NULL AND kind='inquiry' ORDER BY id DESC"
  ).get();
  assert.match(alert.body, /Цікавиться постами:/);
  assert.doesNotMatch(alert.body, /Запитує ціну/, 'an empty group printed its heading');
});

// The number itself is tests/phone.test.js; this is only that the inquiry uses it.
test('the message names the client by the id that can be looked up', async () => {
  const c = await customer('Оксана');
  await db.prepare('UPDATE customers SET phone=? WHERE id=?').run('+33 7 54 38 67 68', c.id);
  await addToCart({ customerId: c.id, postId: await post({ title: 'Celine Triomphe' }), now: NOW });
  await sendInquiry({ customer: await db.prepare('SELECT * FROM customers WHERE id=?').get(c.id), now: NOW });

  const alert = await db.prepare("SELECT * FROM notifications WHERE customer_id IS NULL AND kind='inquiry' ORDER BY id DESC").get();
  assert.match(alert.body, /📞 \+33754386768/);
  // «TG id 1712121543» reads as a debugging leftover to the person who has to
  // paste it into a search box.
  assert.match(alert.body, /Telegram User ID: /);
  assert.doesNotMatch(alert.body, /TG id/);
  // The two ways to reach one person sit together, with no blank line between.
  assert.match(alert.body, /📞 \+33754386768\nTelegram User ID: /);
  // No hole where an absent block used to be. This client typed nothing and
  // holds no coupon — the ordinary case, and the one that used to open a gap.
  assert.doesNotMatch(alert.body, /\n{3}/, 'a removed block left a blank line behind');
});

test('the usable coupon is attached to the inquiry automatically', async () => {
  const c = await customer();
  await promo(c.id, { mode: 'fixed', value: 50, minOrder: 100 });
  await addToCart({ customerId: c.id, postId: await post({ title: 'Bag', price: 400 }), now: NOW });
  const r = await sendInquiry({ customer: c, message: '', now: NOW });

  assert.equal(r.promo.label, '$50');
  // By id, not by paging: `listInquiries({limit: 5})` found this row only while
  // it happened to be among the five newest in the whole shop, so adding a test
  // above this one used to break it.
  const [q] = await listInquiries({ id: r.inquiryId });
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
