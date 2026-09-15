// Dasha answers by REPLYING, and the shop learns she did.
//
// The status existed before this and nobody maintained it: answering happens in
// Telegram, marking happened in the cabinet, and a client was told «очікує»
// about a question answered days earlier. The seam is narrow and easy to get
// wrong in ways that are worse than the original bug — forwarding one client's
// price to another, or answering the same person twice because Telegram
// redelivered an update — so both directions are pinned here.
import './helpers/tmpdb.js';
process.env.SUPPORT_TG_IDS = '7001';
process.env.ADMIN_TG_IDS = '';

import test from 'node:test';
import assert from 'node:assert/strict';
import { migrate, db } from '../server/db.js';
import { addToCart, sendInquiry, customerInquiries } from '../server/cart.js';
import { handleAnswerReply } from '../server/answers.js';
import { outbox, clearOutbox } from '../server/telegram.js';

await migrate();

const NOW = Date.UTC(2026, 8, 15, 12);
const iso = (ms) => new Date(ms).toISOString();

let seq = 0;
async function customer(name = 'Клієнт') {
  seq += 1;
  return await db.prepare('SELECT * FROM customers WHERE id=?').get(
    (await db.prepare('INSERT INTO customers (tg_user_id,name,created_at) VALUES (?,?,?)')
      .run(`ans-${seq}`, `${name} ${seq}`, iso(NOW))).lastInsertRowid
  );
}

async function post(title = 'Chanel 22') {
  seq += 1;
  return Number((await db.prepare(`INSERT INTO posts
    (channel,tg_message_id,title,body,price,currency,image_url,article,source,status,created_at)
    VALUES (?,?,?,?,?,?,?,?, 'channel','published',?)`)
    .run('bags', seq, title, '', 1200, 'USD', '👜', `A-${seq}`, iso(NOW))).lastInsertRowid);
}

// One inquiry, sent — and the DM that carried it, as the reply will name it.
async function inquiryWithDm(name = 'Олена') {
  const c = await customer(name);
  await addToCart({ customerId: c.id, postId: await post(), now: NOW });
  const sent = await sendInquiry({ customer: c, message: 'Які кольори є?', now: NOW });
  const dm = await db.prepare(
    'SELECT chat_id, message_id FROM inquiry_dm WHERE inquiry_id=? ORDER BY message_id'
  ).all(sent.inquiryId);
  return { customer: c, inquiryId: sent.inquiryId, dm };
}

// The update Telegram posts when somebody replies in a private chat.
const replyUpdate = ({ chatId, replyToId, from, text = 'Є чорна і бежева, $1 200', messageId = 9001 }) => ({
  message: {
    message_id: messageId,
    chat: { id: chatId, type: 'private' },
    from: { id: Number(from) },
    text,
    reply_to_message: { message_id: Number(replyToId) },
  },
});

test('the inquiry remembers the message it was sent as', async () => {
  const { inquiryId, dm } = await inquiryWithDm();
  // Support is 7001 and there is no separate admin list, so exactly one
  // delivery — and it is remembered, or no reply could ever be matched.
  assert.equal(dm.length, 1);
  assert.equal(dm[0].chat_id, '7001');
  assert.ok(Number(dm[0].message_id) > 0);
  const rows = await db.prepare('SELECT inquiry_id FROM inquiry_dm WHERE chat_id=?').all('7001');
  assert.ok(rows.some((r) => Number(r.inquiry_id) === inquiryId));
});

test('a reply from support answers the client and marks the row', async () => {
  const { customer: c, inquiryId, dm } = await inquiryWithDm('Оксана');
  clearOutbox();

  const verdict = await handleAnswerReply(replyUpdate({
    chatId: dm[0].chat_id, replyToId: dm[0].message_id, from: '7001',
  }));

  assert.equal(verdict.answered, true);
  assert.equal(verdict.inquiryId, inquiryId);

  // The client's own card stops saying «очікує».
  const mine = await customerInquiries(c.id);
  assert.equal(mine[0].answered, true);
  const row = await db.prepare('SELECT status, answered_by, answered_at FROM inquiries WHERE id=?').get(inquiryId);
  assert.equal(row.status, 'answered');
  assert.equal(row.answered_by, '7001');
  assert.ok(row.answered_at);

  // She receives the words that were written, not a paraphrase of them.
  const toClient = outbox().filter((m) => m.to === String(c.tg_user_id));
  assert.equal(toClient.length, 1);
  assert.match(toClient[0].text, /Є чорна і бежева/);
  // And the person who answered is told it landed, by name.
  const receipt = outbox().filter((m) => m.to === '7001');
  assert.equal(receipt.length, 1);
  assert.match(receipt[0].text, /Надіслано Оксана/);
});

test('an update Telegram redelivers does not answer the client twice', async () => {
  const { customer: c, dm } = await inquiryWithDm('Ірина');
  const update = replyUpdate({ chatId: dm[0].chat_id, replyToId: dm[0].message_id, from: '7001', messageId: 9100 });

  await handleAnswerReply(update);
  clearOutbox();
  const second = await handleAnswerReply(update);

  assert.equal(second.duplicate, true);
  assert.equal(outbox().filter((m) => m.to === String(c.tg_user_id)).length, 0);
});

test('a reply from someone who is not staff reaches nobody', async () => {
  // The client herself can reply to a bot message. Forwarding that as an answer
  // would put one client's words into another client's chat.
  const { customer: c, inquiryId, dm } = await inquiryWithDm('Наталія');
  clearOutbox();

  const verdict = await handleAnswerReply(replyUpdate({
    chatId: dm[0].chat_id, replyToId: dm[0].message_id, from: c.tg_user_id, text: 'дякую!',
  }));

  assert.equal(verdict, null);
  assert.equal(outbox().length, 0);
  assert.equal((await db.prepare('SELECT status FROM inquiries WHERE id=?').get(inquiryId)).status, 'new');
});

test('a reply to a message that is not an inquiry is ignored, not guessed at', async () => {
  const { inquiryId } = await inquiryWithDm('Софія');
  clearOutbox();

  // A birthday nudge, a follow-up — the bot sends other things too.
  const verdict = await handleAnswerReply(replyUpdate({
    chatId: '7001', replyToId: 777777, from: '7001',
  }));

  assert.equal(verdict, null);
  assert.equal(outbox().length, 0);
  assert.equal((await db.prepare('SELECT status FROM inquiries WHERE id=?').get(inquiryId)).status, 'new');
});

test('a message with no words, and one that is no reply at all, are left alone', async () => {
  const { dm } = await inquiryWithDm('Юлія');
  clearOutbox();

  // A sticker: a reply with nothing to forward.
  assert.equal(await handleAnswerReply({
    message: {
      message_id: 9300, chat: { id: dm[0].chat_id, type: 'private' }, from: { id: 7001 },
      sticker: { file_id: 'x' }, reply_to_message: { message_id: Number(dm[0].message_id) },
    },
  }), null);

  // An ordinary message from support — not a reply to anything.
  assert.equal(await handleAnswerReply({
    message: { message_id: 9301, chat: { id: '7001', type: 'private' }, from: { id: 7001 }, text: 'привіт' },
  }), null);

  // A channel post carries no private chat at all.
  assert.equal(await handleAnswerReply({ channel_post: { message_id: 9302, text: 'нова сумка' } }), null);
  assert.equal(outbox().length, 0);
});

test('a caption under a photo is an answer — a price list is often a picture', async () => {
  const { customer: c, inquiryId, dm } = await inquiryWithDm('Катерина');
  clearOutbox();

  const verdict = await handleAnswerReply({
    message: {
      message_id: 9400, chat: { id: dm[0].chat_id, type: 'private' }, from: { id: 7001 },
      photo: [{ file_id: 'price-list' }], caption: 'Ось ціни на вересень',
      reply_to_message: { message_id: Number(dm[0].message_id) },
    },
  });

  assert.equal(verdict.answered, true);
  assert.equal((await db.prepare('SELECT status FROM inquiries WHERE id=?').get(inquiryId)).status, 'answered');
  assert.match(outbox().filter((m) => m.to === String(c.tg_user_id))[0].text, /Ось ціни на вересень/);
});

test('the DM says how to answer; the cabinet record does not', async () => {
  // Replying to a notification is not something anybody guesses, so the message
  // carries the instruction. The stored row is the cabinet's record of what the
  // CLIENT asked — an instruction addressed to Dasha in it would be read as
  // part of the client's question.
  clearOutbox();
  const { inquiryId } = await inquiryWithDm('Марина');

  const dmText = outbox().filter((m) => m.to === '7001')[0].text;
  assert.match(dmText, /Відповідайте на це повідомлення/);

  const note = await db.prepare(
    "SELECT title, body FROM notifications WHERE dedupe_key=?"
  ).get(`inquiry:${inquiryId}`);
  assert.ok(note, 'the inquiry is recorded for the cabinet');
  assert.doesNotMatch(note.body, /Відповідайте на це повідомлення/);
  assert.match(note.body, /Які кольори є\?/);
});
