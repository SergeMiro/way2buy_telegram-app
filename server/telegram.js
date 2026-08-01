// ─────────────────────────────────────────────────────────────────────────
//  telegram.js — the bridge between the channels and the Mini App.
//
//  Maryna, 31.07.2026: "Если админ выкладывает что-то внутри канала то оно
//  всё должно автоматом дублироваться в mini app Telegram и наоборот."
//
//   • CHANNEL → APP: the bot (an admin of the channel) receives `channel_post`
//     updates and we upsert them into `posts`. Photos, albums, article numbers
//     and later edits are all carried over, because a catalogue post is mostly
//     a photo plus an article number.
//   • APP → CHANNEL: publishing from the admin panel sends the post to the
//     channel and stores the same row, so both surfaces show one feed.
//
//  Channels are DATA, not constants: one main channel plus ~15 catalogues, and
//  a brand-new channel registers itself the first time it posts — so Maryna
//  can create the test channel, add the bot, and it just starts working.
//
//  DEMO MODE: with no TELEGRAM_BOT_TOKEN, publishing is simulated locally so
//  the whole flow is demonstrable without a real bot.
//
//  KNOWN LIMIT: the Bot API cannot read a channel's history and does not
//  report deletions. Only posts made after the bot became an admin arrive, and
//  a post deleted in the channel stays in the app until an admin hides it.
// ─────────────────────────────────────────────────────────────────────────
import { db } from './db.js';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const API = (m) => `https://api.telegram.org/bot${TOKEN}/${m}`;

export const liveMode = () => Boolean(TOKEN);

// ── channels ──────────────────────────────────────────────────────────────

export function listChannels({ includeDisabled = false } = {}) {
  const rows = includeDisabled
    ? db.prepare('SELECT * FROM channels ORDER BY kind DESC, id').all()
    : db.prepare('SELECT * FROM channels WHERE enabled=1 ORDER BY kind DESC, id').all();
  return rows.map(shapeChannel);
}

export function shapeChannel(c) {
  if (!c) return null;
  return {
    key: c.key, title: c.title, username: c.username, emoji: c.emoji,
    kind: c.kind, enabled: Boolean(c.enabled), chatId: c.chat_id,
  };
}

export function getChannel(key) {
  return shapeChannel(db.prepare('SELECT * FROM channels WHERE key=?').get(key));
}

// Back-compat for callers that still expect the old CHANNELS map.
export function channelMap() {
  const out = {};
  for (const c of listChannels({ includeDisabled: true })) out[c.key] = c;
  return out;
}

const slugify = (s, fallback) =>
  String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || fallback;

// Find the channel a Telegram post came from; register it if it is new.
// This is what lets Maryna spin up a test channel without touching config.
export function resolveChannel(chat) {
  if (!chat) return null;
  const chatId = chat.id != null ? String(chat.id) : null;
  const uname = chat.username ? chat.username.toLowerCase() : null;

  if (chatId) {
    const byId = db.prepare('SELECT * FROM channels WHERE chat_id=?').get(chatId);
    if (byId) return shapeChannel(byId);
  }
  if (uname) {
    const byName = db.prepare('SELECT * FROM channels WHERE lower(username)=?').get(uname);
    if (byName) {
      // First post from a channel we only knew by @username — bind the numeric
      // id so private channels and username changes keep working.
      if (chatId && !byName.chat_id) {
        db.prepare('UPDATE channels SET chat_id=? WHERE id=?').run(chatId, byName.id);
        byName.chat_id = chatId;
      }
      return shapeChannel(byName);
    }
  }

  const key = slugify(chat.username || chat.title, `ch${chatId || Date.now()}`);
  const unique = db.prepare('SELECT 1 FROM channels WHERE key=?').get(key) ? `${key}-${Math.random().toString(36).slice(2, 5)}` : key;
  db.prepare(`INSERT INTO channels (key,chat_id,username,title,emoji,kind,enabled,created_at)
    VALUES (?,?,?,?,?, 'catalog',1,?)`)
    .run(unique, chatId, chat.username || null, chat.title || unique, '🛍️', new Date().toISOString());
  return getChannel(unique);
}

// ── Telegram API ──────────────────────────────────────────────────────────

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

// The bot token must never reach the browser, so photos are proxied: the app
// stores file_ids and serves the bytes through /api/photo/:fileId.
export async function fetchPhoto(fileId) {
  if (!liveMode()) return null;
  const file = await tg('getFile', { file_id: fileId });
  const res = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`);
  if (!res.ok) throw new Error(`file download ${res.status}`);
  return {
    buffer: Buffer.from(await res.arrayBuffer()),
    contentType: res.headers.get('content-type') || 'image/jpeg',
  };
}

// ── parsing a catalogue post ──────────────────────────────────────────────

// Article numbers as they are actually written in the catalogues.
const ARTICLE_PATTERNS = [
  /(?:артикул|арт\.?|art\.?|code|код)\s*[:#№]?\s*([A-Za-z0-9][A-Za-z0-9\-_/]{2,24})/i,
  /#([A-Za-z0-9][A-Za-z0-9\-_]{2,24})\b/,
];

export function parseArticle(text = '') {
  for (const re of ARTICLE_PATTERNS) {
    const m = text.match(re);
    if (m) return m[1].toUpperCase();
  }
  return null;
}

const PRICE_RE = /(?:^|\s)(?:\$\s*(\d[\d\s.,]*)|(\d[\d\s.,]*)\s*(грн|uah|usd|\$|€|eur))/i;

export function parsePrice(text = '') {
  const m = text.match(PRICE_RE);
  if (!m) return { price: null, currency: null };
  const raw = m[1] || m[2];
  const num = Number(String(raw).replace(/[\s,]/g, ''));
  if (!Number.isFinite(num)) return { price: null, currency: null };
  const unit = (m[3] || '$').toLowerCase();
  const currency = unit === 'грн' || unit === 'uah' ? 'UAH' : unit === '€' || unit === 'eur' ? 'EUR' : 'USD';
  return { price: num, currency };
}

export function parsePostText(text = '') {
  const clean = String(text || '').trim();
  const [firstLine, ...rest] = clean.split('\n');
  const { price, currency } = parsePrice(clean);
  return {
    title: (firstLine || 'Нова позиція').slice(0, 120),
    body: rest.join('\n').slice(0, 1000),
    price,
    currency,
    article: parseArticle(clean),
  };
}

// Largest available size of each photo in the message.
function photoIds(post) {
  const out = [];
  if (Array.isArray(post.photo) && post.photo.length) {
    const largest = post.photo.reduce((a, b) => ((a.file_size || 0) >= (b.file_size || 0) ? a : b));
    out.push(largest.file_id);
  }
  if (post.document && String(post.document.mime_type || '').startsWith('image/')) {
    out.push(post.document.file_id);
  }
  return out;
}

// ── CHANNEL → APP ─────────────────────────────────────────────────────────

export function ingestChannelPost(update) {
  const post = update?.channel_post || update?.edited_channel_post;
  if (!post) return null;
  const edited = Boolean(update.edited_channel_post);

  const channel = resolveChannel(post.chat);
  if (!channel || !channel.enabled) return null;

  const parsed = parsePostText(post.text || post.caption || '');
  const photos = photoIds(post);
  const createdAt = new Date((post.date || Math.floor(Date.now() / 1000)) * 1000).toISOString();

  const existing = db.prepare('SELECT * FROM posts WHERE tg_message_id=? AND channel=?')
    .get(post.message_id, channel.key);

  if (existing) {
    // An edit in the channel must show up in the app — that is the whole point
    // of "и наоборот".
    if (edited) {
      db.prepare(`UPDATE posts SET title=?, body=?, price=COALESCE(?, price), currency=COALESCE(?, currency),
                  article=COALESCE(?, article), photos_json=COALESCE(?, photos_json), edited_at=? WHERE id=?`)
        .run(parsed.title, parsed.body, parsed.price, parsed.currency, parsed.article,
          photos.length ? JSON.stringify(photos) : null, new Date().toISOString(), existing.id);
    }
    return existing.id;
  }

  // Albums arrive as several updates sharing one media_group_id. The first one
  // creates the post; the rest only add their photo, so an album is one card.
  if (post.media_group_id) {
    const groupRow = db.prepare('SELECT * FROM posts WHERE media_group_id=? AND channel=?')
      .get(String(post.media_group_id), channel.key);
    if (groupRow) {
      const current = safeParse(groupRow.photos_json) || [];
      const merged = [...new Set([...current, ...photos])].slice(0, 10);
      db.prepare(`UPDATE posts SET photos_json=?,
                  title = CASE WHEN ? <> '' AND (title IS NULL OR title = 'Нова позиція') THEN ? ELSE title END,
                  body  = CASE WHEN ? <> '' AND (body IS NULL OR body = '') THEN ? ELSE body END,
                  price = COALESCE(price, ?), article = COALESCE(article, ?)
                  WHERE id=?`)
        .run(JSON.stringify(merged), parsed.title, parsed.title, parsed.body, parsed.body,
          parsed.price, parsed.article, groupRow.id);
      return groupRow.id;
    }
  }

  const info = db.prepare(`INSERT INTO posts
    (channel,tg_message_id,title,body,price,currency,image_url,article,photos_json,media_group_id,source,status,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?, 'channel','published',?)`)
    .run(
      channel.key, post.message_id, parsed.title, parsed.body,
      parsed.price, parsed.currency || 'USD',
      photos.length ? null : '🛍️',
      parsed.article,
      photos.length ? JSON.stringify(photos) : null,
      post.media_group_id ? String(post.media_group_id) : null,
      createdAt,
    );
  return Number(info.lastInsertRowid);
}

function safeParse(s) {
  try { return s ? JSON.parse(s) : null; } catch { return null; }
}

// ── APP → CHANNEL ─────────────────────────────────────────────────────────

function renderPost({ title, body, price, currency, article }) {
  const money = price ? `\n\n💰 <b>${price} ${currency || ''}</b>` : '';
  const art = article ? `\n<code>${escapeHtml(article)}</code>` : '';
  return `<b>${escapeHtml(title)}</b>\n${escapeHtml(body || '')}${art}${money}`.trim();
}

export async function publishPost({ channel, title, body, price, currency, article, photoUrl }) {
  const ch = getChannel(channel);
  if (!ch) throw new Error('unknown channel');
  const created_at = new Date().toISOString();
  const text = renderPost({ title, body, price, currency, article });

  let tg_message_id = null;
  if (liveMode()) {
    const target = ch.chatId || `@${ch.username}`;
    const msg = photoUrl
      ? await tg('sendPhoto', { chat_id: target, photo: photoUrl, caption: text, parse_mode: 'HTML' })
      : await tg('sendMessage', { chat_id: target, text, parse_mode: 'HTML' });
    tg_message_id = msg.message_id;
  } else {
    tg_message_id = Math.floor(90000 + Math.abs(hash(title + created_at)) % 9999);
  }

  const info = db.prepare(`INSERT INTO posts
    (channel,tg_message_id,title,body,price,currency,image_url,article,source,status,created_at)
    VALUES (?,?,?,?,?,?,?,?, 'app','published',?)`)
    .run(ch.key, tg_message_id, title, body || '', price || null, currency || 'USD',
      photoUrl || '🛍️', article || null, created_at);

  return { id: Number(info.lastInsertRowid), tg_message_id, live: liveMode() };
}

export async function sendToUser(tgUserId, text) {
  if (!liveMode()) return { simulated: true, text };
  return tg('sendMessage', { chat_id: tgUserId, text, parse_mode: 'HTML' });
}

export async function setWebhook(publicUrl) {
  if (!liveMode() || !publicUrl) return { skipped: true };
  return tg('setWebhook', {
    url: `${publicUrl.replace(/\/$/, '')}/telegram/webhook`,
    allowed_updates: ['channel_post', 'edited_channel_post', 'message'],
    secret_token: process.env.TELEGRAM_WEBHOOK_SECRET || undefined,
  });
}

function escapeHtml(s = '') {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i) | 0;
  return h;
}

// Legacy export kept so older imports keep resolving; prefer listChannels().
export const CHANNELS = new Proxy({}, {
  get: (_t, prop) => (typeof prop === 'string' ? getChannel(prop) : undefined),
  ownKeys: () => listChannels({ includeDisabled: true }).map((c) => c.key),
  getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
});
