// The channel → app bridge, over HTTP, the way Telegram calls it.
//
// The case that matters: the post must be STORED by the time the request is
// answered. Acknowledging first and writing afterwards is the usual shape for a
// webhook, and on a serverless host it loses data — the invocation can be frozen
// as soon as the response is written, and Telegram, having its 200, never
// redelivers. That failure is invisible from the outside: Telegram reports a
// clean delivery and the post simply is not there.
import './helpers/tmpdb.js';
process.env.VERCEL = '1';                       // keeps index.js from binding a port
process.env.TELEGRAM_WEBHOOK_SECRET = 'secret-token';

import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../server/db.js';

// In-process, the old ordering looks fine: the response is written, the event
// loop carries on, and the insert lands microseconds later — before any assertion
// can notice. Serverless is what makes it fatal, and that cannot be reproduced
// here. So the write is slowed down instead: with the acknowledgement first, the
// row is provably not there yet when the request returns; with the work first, it
// is. That is the difference between a test and a comment.
const realPrepare = db.prepare.bind(db);
db.prepare = (sql) => {
  const statement = realPrepare(sql);
  if (!/INSERT INTO posts/i.test(sql)) return statement;
  return {
    ...statement,
    run: async (...args) => {
      await new Promise((r) => setTimeout(r, 150));
      return statement.run(...args);
    },
  };
};

const app = (await import('../server/index.js')).default;
const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

const post = (body, secret = 'secret-token') => fetch(`${base}/telegram/webhook`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
  body: JSON.stringify(body),
});

const update = (messageId, text) => ({
  channel_post: {
    message_id: messageId,
    date: Math.floor(Date.parse('2026-08-08T10:00:00Z') / 1000),
    chat: { id: -1009999, username: 'w2b_hook_test', title: 'Гачок' },
    text,
  },
});

test('a channel post is in the database by the time the request is answered', async () => {
  const res = await post(update(4001, 'Chanel Classic Flap\nАртикул: CH-4001'));
  assert.equal(res.status, 200);

  // No polling, no waiting: if this needs a retry loop, the acknowledgement is
  // racing the write and a serverless host will lose posts.
  const row = await db.prepare('SELECT * FROM posts WHERE tg_message_id=?').get(4001);
  assert.ok(row, 'the post must be stored before the 200 is written');
  assert.equal(row.article, 'CH-4001');
  assert.equal(row.status, 'published');
});

test('an update with a wrong secret is refused and stores nothing', async () => {
  const res = await post(update(4002, 'Dior'), 'not-the-secret');
  assert.equal(res.status, 401);
  assert.equal(await db.prepare('SELECT * FROM posts WHERE tg_message_id=?').get(4002), undefined);
});

test('an update Telegram will redeliver forever is answered 200, not 500', async () => {
  // Malformed, unknown shape, empty: all of these have to end the exchange.
  for (const body of [{}, { edited_channel_post: null }, { message: { chat: null } }]) {
    const res = await post(body);
    assert.equal(res.status, 200, `${JSON.stringify(body)} must not be retried`);
  }
});

test('an edit in the channel reaches the card that is already stored', async () => {
  await post({
    edited_channel_post: {
      ...update(4001, 'Chanel Classic Flap Medium\nАртикул: CH-4001\n$5200').channel_post,
      edit_date: Math.floor(Date.now() / 1000),
    },
  });
  const row = await db.prepare('SELECT * FROM posts WHERE tg_message_id=?').get(4001);
  assert.match(row.body, /Medium/);
  assert.equal(Number(row.price), 5200);
});

test('a staff reply over the webhook marks the inquiry answered', async () => {
  // The whole path, over HTTP, the way Telegram calls it: the handler is wired
  // into the webhook next to handleMessage(), and a feature nothing calls is a
  // feature that does not exist. The unit behaviour is pinned in
  // answers.test.js; what this proves is that the wire reaches it.
  process.env.SUPPORT_TG_IDS = '7009';
  const { addToCart, sendInquiry } = await import('../server/cart.js');

  const customerId = Number((await db.prepare(
    'INSERT INTO customers (tg_user_id,name,created_at) VALUES (?,?,?)'
  ).run('hook-client', 'Олена', new Date().toISOString())).lastInsertRowid);
  const customer = await db.prepare('SELECT * FROM customers WHERE id=?').get(customerId);

  const postId = Number((await db.prepare(`INSERT INTO posts
    (channel,tg_message_id,title,body,price,currency,image_url,article,source,status,created_at)
    VALUES (?,?,?,?,?,?,?,?, 'channel','published',?)`)
    .run('bags', 4777, 'Balenciaga Hourglass', '', 1900, 'USD', '👜', 'BA-4777',
      new Date().toISOString())).lastInsertRowid);

  await addToCart({ customerId, postId });
  const inquiry = await sendInquiry({ customer, message: 'Які кольори є?' });
  const dm = await db.prepare(
    'SELECT chat_id, message_id FROM inquiry_dm WHERE inquiry_id=? LIMIT 1'
  ).get(inquiry.inquiryId);
  assert.ok(dm, 'the DM that carried the inquiry has to be remembered');

  const res = await post({
    message: {
      message_id: 55501,
      chat: { id: dm.chat_id, type: 'private' },
      from: { id: 7009 },
      text: 'Є чорна і бежева, $1 900',
      reply_to_message: { message_id: Number(dm.message_id) },
    },
  });
  assert.equal(res.status, 200);

  const row = await db.prepare('SELECT status, answered_by FROM inquiries WHERE id=?').get(inquiry.inquiryId);
  assert.equal(row.status, 'answered');
  assert.equal(row.answered_by, '7009');
});
