// What the inquiry carries, and who is told about it.
//
// Two separate promises live in this feature and they pull in opposite
// directions, which is why they are tested together:
//
//   • whoever answers must be one tap from the actual post — «Сумка» and
//     «Prada · окуляри» each name a dozen things, and an article code only
//     helps somebody already holding the catalogue;
//   • the client must see one contact person and no sign that the message also
//     reached the owner. Nothing they are shown may name an admin.
import './helpers/tmpdb.js';
process.env.SUPPORT_NAME = 'Даша';
process.env.SUPPORT_NAME_DATIVE = 'Даші';
process.env.SUPPORT_USERNAME = '@daschamelnyk';
process.env.ADMIN_TG_IDS = '555000111'; // «Maryna»

import test from 'node:test';
import assert from 'node:assert/strict';
import { migrate, db } from '../server/db.js';
import { addToCart, sendInquiry, listInquiries, tgPostUrl, support } from '../server/cart.js';

await migrate();

const NOW = Date.UTC(2026, 7, 14, 12);
const iso = (ms) => new Date(ms).toISOString();

let seq = 0;
async function customer(name = 'Клієнтка') {
  seq += 1;
  return await db.prepare('SELECT * FROM customers WHERE id=?').get(
    (await db.prepare('INSERT INTO customers (tg_user_id,name,phone,created_at) VALUES (?,?,?,?)')
      .run(`inq-${seq}`, `${name} ${seq}`, '+15550001', iso(NOW))).lastInsertRowid
  );
}

async function channel({ key, username = null, chatId = null, title = key }) {
  await db.prepare(`INSERT INTO channels (key,chat_id,username,title,emoji,kind,enabled,created_at)
    VALUES (?,?,?,?,'🛍️','catalog',true,?)`).run(key, chatId, username, title, iso(NOW));
}

async function post({ title, article = null, channel: ch, messageId }) {
  return Number((await db.prepare(`INSERT INTO posts
    (channel,tg_message_id,title,body,price,currency,image_url,article,source,status,created_at)
    VALUES (?,?,?,'',NULL,'USD','👜',?, 'channel','published',?)`)
    .run(ch, messageId, title, article, iso(NOW))).lastInsertRowid);
}

/* ── the link itself ─────────────────────────────────────────────────────── */

test('a public channel links by @username, a private one by its numeric form', () => {
  assert.equal(
    tgPostUrl({ username: 'w2b_luxury_bags', messageId: 4211 }),
    'https://t.me/w2b_luxury_bags/4211',
  );
  // A leading @ is what the admin form and the database both hand back.
  assert.equal(tgPostUrl({ username: '@w2b_hermes', messageId: 7 }), 'https://t.me/w2b_hermes/7');
  // No username: the /c/ form, which opens for members — and everyone who
  // receives this message is one.
  assert.equal(
    tgPostUrl({ chatId: '-1002295761768', messageId: 15355 }),
    'https://t.me/c/2295761768/15355',
  );
});

test('a link is never invented out of nothing', () => {
  assert.equal(tgPostUrl({ username: 'x' }), null, 'no message id → no link');
  assert.equal(tgPostUrl({ messageId: 5 }), null, 'no channel → no link');
  // A group id that is not a supergroup has no /c/ form.
  assert.equal(tgPostUrl({ chatId: '-4004', messageId: 5 }), null);
});

/* ── the message ─────────────────────────────────────────────────────────── */

test('every item in the inquiry carries a link to its post', async () => {
  await channel({ key: 'pub', username: 'w2b_luxury_bags' });
  await channel({ key: 'priv', chatId: '-1002295761768', title: 'Way2Buy - Luxury' });

  const c = await customer('Олена');
  const a = await post({ title: 'GG Marmont small', article: 'GG-77', channel: 'pub', messageId: 4211 });
  const b = await post({ title: 'Prada · окуляри', channel: 'priv', messageId: 15355 });
  await addToCart({ customerId: c.id, postId: a, now: NOW });
  await addToCart({ customerId: c.id, postId: b, now: NOW });

  const res = await sendInquiry({ customer: c, message: 'Підкажіть ціну', now: NOW });
  assert.equal(res.ok, true);

  // The record the cabinet renders keeps the links as text…
  const alert = await db.prepare(
    "SELECT title, body FROM notifications WHERE customer_id IS NULL AND kind='inquiry' ORDER BY id DESC LIMIT 1"
  ).get();
  assert.match(alert.body, /https:\/\/t\.me\/w2b_luxury_bags\/4211/);
  assert.match(alert.body, /https:\/\/t\.me\/c\/2295761768\/15355/);
  assert.match(alert.body, /GG Marmont small · арт\. GG-77/);
  assert.match(alert.body, /«Підкажіть ціну»/);

  // …and the stored inquiry carries them per item, so the cabinet can offer
  // them months later without re-deriving anything.
  const [stored] = await listInquiries({ limit: 1 });
  const urls = stored.items.map((i) => i.url).sort();
  assert.deepEqual(urls, [
    'https://t.me/c/2295761768/15355',
    'https://t.me/w2b_luxury_bags/4211',
  ]);
});

test('an item whose post has no reachable channel still appears, just without a link', async () => {
  await channel({ key: 'orphan' }); // neither username nor chat_id
  const c = await customer('Ірина');
  const p = await post({ title: 'Сумка', channel: 'orphan', messageId: 9 });
  await addToCart({ customerId: c.id, postId: p, now: NOW });

  const res = await sendInquiry({ customer: c, now: NOW });
  assert.equal(res.ok, true);

  const alert = await db.prepare(
    "SELECT body FROM notifications WHERE customer_id IS NULL AND kind='inquiry' ORDER BY id DESC LIMIT 1"
  ).get();
  assert.match(alert.body, /Сумка/, 'the item is still listed');
  assert.doesNotMatch(alert.body, /https:\/\/t\.me/, 'and no link is fabricated for it');
});

/* ── what the client is allowed to know ──────────────────────────────────── */

test('the client is told about Dasha and never about the owner', async () => {
  const c = await customer('Марія');
  await channel({ key: 'pub2', username: 'w2b_hermes' });
  const p = await post({ title: 'Kelly 28', channel: 'pub2', messageId: 12 });
  await addToCart({ customerId: c.id, postId: p, now: NOW });

  const res = await sendInquiry({ customer: c, now: NOW });
  assert.match(res.message, /Даша/);

  // Their own notification feed: the acknowledgement, and nothing else. The
  // admin alert is stored with customer_id NULL precisely so it cannot surface
  // here, and this asserts that separation rather than trusting it.
  const mine = await db.prepare(
    'SELECT kind, title, body FROM notifications WHERE customer_id=? ORDER BY id'
  ).all(c.id);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].kind, 'inquiry_sent');
  assert.match(mine[0].body, /Даша/);
  for (const row of mine) {
    const text = `${row.title} ${row.body}`;
    assert.doesNotMatch(text, /адмін|власни|Марин|555000111/i,
      'nothing a client reads may reveal who else received the inquiry');
  }
});

test('the contact the client sees is one person, with a face to show', () => {
  const s = support();
  assert.equal(s.name, 'Даша');
  assert.equal(s.dative, 'Даші');
  assert.equal(s.username, 'daschamelnyk', 'stored without the @, the UI adds it');
  assert.equal(typeof s.role, 'string');
  // Empty is the honest default and the client falls back to initials; what it
  // must never be is undefined, which would render as the word "undefined".
  assert.equal(typeof s.photo, 'string');
});
