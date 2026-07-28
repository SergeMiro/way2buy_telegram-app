// ─────────────────────────────────────────────────────────────────────────
//  telegram.js — the bridge to the two channels.
//
//  Two directions, exactly as requested:
//   • APP → CHANNEL:  publish a post from the Mini App; it is sent to the
//     Telegram channel AND stored in `posts` so it shows in the in-app feed.
//   • CHANNEL → APP:  the bot (admin of the channel) receives `channel_post`
//     updates via webhook; we upsert them into `posts` so anything posted
//     directly in the channel also appears in the app. The app "watches" the
//     channel.
//
//  DEMO MODE: with no TELEGRAM_BOT_TOKEN the posting is simulated locally
//  (a fake message id) so the whole flow is demonstrable without a real bot.
// ─────────────────────────────────────────────────────────────────────────
import { db } from './db.js';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const API = (m) => `https://api.telegram.org/bot${TOKEN}/${m}`;

export const CHANNELS = {
  ukraine: { key: 'ukraine', title: 'Way2Buy Ukraine', username: process.env.CHANNEL_UKRAINE || 'Way2Buy_Ukraine', flag: '🇺🇦' },
  luxury:  { key: 'luxury',  title: 'Way2Buy Luxury',  username: process.env.CHANNEL_LUXURY  || 'Way2Buy_Luxury',  flag: '💎' },
};

export const liveMode = () => Boolean(TOKEN);

async function tg(method, params) {
  const res = await fetch(API(method), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram ${method}: ${json.description}`);
  return json.result;
}

function renderPost({ title, body, price, currency }) {
  const money = price ? `\n\n💰 <b>${price} ${currency || ''}</b>` : '';
  return `<b>${escapeHtml(title)}</b>\n${escapeHtml(body || '')}${money}`.trim();
}

// APP → CHANNEL (+ store in feed)
export async function publishPost({ channel, title, body, price, currency }) {
  const ch = CHANNELS[channel];
  if (!ch) throw new Error('unknown channel');
  const created_at = new Date().toISOString();

  let tg_message_id = null;
  if (liveMode()) {
    const msg = await tg('sendMessage', {
      chat_id: `@${ch.username}`,
      text: renderPost({ title, body, price, currency }),
      parse_mode: 'HTML',
    });
    tg_message_id = msg.message_id;
  } else {
    // simulated id so the demo shows "published to channel"
    tg_message_id = Math.floor(90000 + Math.abs(hash(title + created_at)) % 9999);
  }

  const info = db.prepare(`INSERT INTO posts
    (channel,tg_message_id,title,body,price,currency,image_url,source,status,created_at)
    VALUES (?,?,?,?,?,?,?, 'app','published',?)`)
    .run(channel, tg_message_id, title, body || '', price || null, currency || (channel === 'luxury' ? 'USD' : 'UAH'), '🛍️', created_at);

  return { id: Number(info.lastInsertRowid), tg_message_id, live: liveMode() };
}

// CHANNEL → APP: called from the webhook when someone posts in the channel.
export function ingestChannelPost(update) {
  const post = update.channel_post || update.edited_channel_post;
  if (!post) return null;
  const uname = post.chat?.username?.toLowerCase();
  const channel = Object.values(CHANNELS).find((c) => c.username.toLowerCase() === uname)?.key;
  if (!channel) return null;

  const text = post.text || post.caption || '';
  const [firstLine, ...rest] = text.split('\n');
  const priceMatch = text.match(/(\d[\d\s.,]{1,})\s*(грн|UAH|USD|\$|€)/i);

  const created_at = new Date((post.date || Math.floor(Date.now() / 1000)) * 1000).toISOString();
  const exists = db.prepare('SELECT id FROM posts WHERE tg_message_id=? AND channel=?').get(post.message_id, channel);
  if (exists) return exists.id;

  const info = db.prepare(`INSERT INTO posts
    (channel,tg_message_id,title,body,price,currency,image_url,source,status,created_at)
    VALUES (?,?,?,?,?,?,?, 'channel','published',?)`)
    .run(channel, post.message_id, firstLine.slice(0, 120), rest.join('\n').slice(0, 500),
      priceMatch ? Number(priceMatch[1].replace(/[\s,]/g, '')) : null,
      channel === 'luxury' ? 'USD' : 'UAH', '🛍️', created_at);
  return Number(info.lastInsertRowid);
}

// Send a plain message to a user (used by AI reports → admin DM).
export async function sendToUser(tgUserId, text) {
  if (!liveMode()) return { simulated: true, text };
  return tg('sendMessage', { chat_id: tgUserId, text, parse_mode: 'HTML' });
}

export async function setWebhook(publicUrl) {
  if (!liveMode() || !publicUrl) return { skipped: true };
  return tg('setWebhook', {
    url: `${publicUrl.replace(/\/$/, '')}/telegram/webhook`,
    allowed_updates: ['channel_post', 'edited_channel_post', 'message'],
  });
}

function escapeHtml(s = '') {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i) | 0;
  return h;
}
