// ─────────────────────────────────────────────────────────────────────────
//  polling.js — receive channel posts without a public HTTPS endpoint.
//
//  A webhook needs a public URL; long polling does not. That makes this the
//  mode to develop and demo in: run the app on a laptop, post in the channel,
//  watch the card appear. Production still uses the webhook (one request per
//  update instead of an open connection) — the two are mutually exclusive, and
//  start() deletes any webhook first, because Telegram refuses getUpdates
//  while one is set.
//
//  Enable with W2B_TELEGRAM_POLLING=1.
// ─────────────────────────────────────────────────────────────────────────
import { ingestChannelPost, handleMessage, liveMode } from './telegram.js';

const TOKEN = () => process.env.TELEGRAM_BOT_TOKEN || '';
const API = (m) => `https://api.telegram.org/bot${TOKEN()}/${m}`;
const ALLOWED = ['channel_post', 'edited_channel_post', 'message'];

let running = false;
let offset = 0;
let lastError = null;
let received = 0;

async function call(method, params = {}, timeoutMs = 65000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(API(method), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal: ctl.signal,
    });
    const json = await res.json();
    if (!json.ok) throw new Error(`${method}: ${json.description}`);
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

function apply(update) {
  received += 1;
  try {
    ingestChannelPost(update);
  } catch (e) {
    console.error('[polling] ingest failed:', e.message);
  }
  void Promise.resolve(handleMessage(update)).catch(() => {});
}

async function loop() {
  while (running) {
    try {
      // 50s long poll: Telegram holds the request open until something happens,
      // so an idle channel costs one request per minute, not one per second.
      const updates = await call('getUpdates', { offset, timeout: 50, allowed_updates: ALLOWED });
      for (const u of updates) {
        offset = Math.max(offset, u.update_id + 1);
        apply(u);
      }
      lastError = null;
    } catch (e) {
      if (!running) break;
      lastError = String(e.message || e);
      console.error('[polling]', lastError);
      // Back off so a token or network problem does not become a hot loop.
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

export async function start() {
  if (running || !liveMode()) return false;
  running = true;
  try {
    // A webhook and getUpdates cannot coexist. Dropping pending updates would
    // silently lose posts, so they are kept and delivered on the first poll.
    await call('deleteWebhook', { drop_pending_updates: false }, 10000);
  } catch (e) {
    console.error('[polling] deleteWebhook:', e.message);
  }
  const me = await call('getMe', {}, 10000).catch(() => null);
  console.log(`  Telegram polling → @${me?.username || '?'} (channel posts arrive live)`);
  void loop();
  return true;
}

export function stop() {
  running = false;
}

export const status = () => ({ running, offset, received, lastError });
