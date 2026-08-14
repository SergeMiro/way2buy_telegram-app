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
