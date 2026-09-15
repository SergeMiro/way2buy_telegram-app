// ─────────────────────────────────────────────────────────────────────────
//  answers.js — Dasha replies, and the shop learns she did.
//
//  The inquiry already had a status («new» → «answered») and a button in the
//  cabinet to set it. Nobody pressed it. She reads the request in Telegram,
//  answers the client in Telegram, and the cabinet is a second place to go and
//  say she did — so the status told the client «очікує» about a question that
//  had been answered days ago, which is worse than saying nothing.
//
//  So the answer itself is the signal. She REPLIES to the notification the bot
//  sent her; the bot recognises which inquiry that message was, carries her
//  words to the client, and marks the row. No extra step, and the clock on the
//  client's card turns into a check the moment she presses send.
//
//  Why a reply and not "any message from Dasha": a reply names the message it
//  answers. She handles several clients an hour and they are all in the same
//  chat with the bot — anything less specific would guess, and a guess here
//  sends one client's price to another.
//
//  This lives apart from telegram.js on purpose: it needs cart.js and notify.js,
//  and cart.js already needs telegram.js. index.js is the only place that knows
//  about all three, so the webhook calls this next to handleMessage().
// ─────────────────────────────────────────────────────────────────────────
import { db } from './db.js';
import { sendToUser } from './telegram.js';
import { notifyCustomer, adminIds } from './notify.js';
import { setInquiryStatus, supportIds, support, shortName } from './cart.js';

// Who may answer on the shop's behalf: the owners and support. A client can
// reply to a bot message too — hers must never be forwarded to anybody.
async function staffIds() {
  return new Set([...(await adminIds()), ...supportIds()].map(String));
}

/**
 * Handle one update that might be a staff reply to an inquiry notification.
 *
 * Returns null when the update is not that — which is the usual case, and not
 * an error: the same webhook carries channel posts, /start and everything else.
 * Returns a small verdict object otherwise, for the tests and the log.
 */
export async function handleAnswerReply(update) {
  const msg = update?.message;
  if (!msg || msg.chat?.type !== 'private') return null;

  const replyTo = msg.reply_to_message;
  if (!replyTo?.message_id) return null;

  // Text or a caption under a photo — a price list photographed off a screen is
  // a real way to answer. A sticker with no words is not something to forward.
  const answer = String(msg.text || msg.caption || '').trim();
  if (!answer) return null;

  const from = String(msg.from?.id || '');
  if (!(await staffIds()).has(from)) return null;

  const link = await db.prepare(
    'SELECT inquiry_id FROM inquiry_dm WHERE chat_id=? AND message_id=?'
  ).get(String(msg.chat.id), Number(replyTo.message_id));
  // A reply to some other message of the bot's — a birthday nudge, a follow-up.
  // Not an answer to anything, and silence is the right response.
  if (!link) return null;

  const inquiryId = Number(link.inquiry_id);
  const row = await db.prepare(
    `SELECT i.id, i.customer_id, i.status, c.name, c.tg_user_id, c.lang
       FROM inquiries i JOIN customers c ON c.id = i.customer_id
      WHERE i.id=?`
  ).get(inquiryId);
  if (!row) return null;

  // The client hears it first, and the dedupe key is the reply's own id: an
  // update Telegram redelivers must not tell her the same thing twice. A null
  // here means exactly that — already delivered — so everything after it is
  // skipped rather than repeated.
  const delivered = await notifyCustomer({
    customerId: row.customer_id,
    kind: 'inquiry_answer',
    message: { key: 'inquiry_answered', params: { who: support().name, answer } },
    lang: row.lang,
    dedupeKey: `inquiry-answer:${msg.chat.id}:${msg.message_id}`,
  });
  if (!delivered) return { inquiryId, duplicate: true };

  await setInquiryStatus(inquiryId, { status: 'answered', by: from });

  // And she is told it went — to a name, not to an id. Without this she has no
  // way to tell a reply that reached the client from one that reached the bot's
  // chat and stopped there.
  try {
    await sendToUser(msg.chat.id, `✅ Надіслано ${escapeHtml(shortName(row))}`);
  } catch { /* the client has the answer; the receipt is a courtesy */ }

  return { inquiryId, customerId: row.customer_id, answered: true };
}

function escapeHtml(s = '') {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
