#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
//  scripts/telegram.mjs — one command to wire the bot up and to check it.
//
//    npm run tg -- status                 what Telegram thinks right now
//    npm run tg -- setup <https-url>      webhook + menu button + commands
//    npm run tg -- app <https-url>        Mini App URL only (keeps polling)
//    npm run tg -- channels               is the bot an admin of each channel?
//    npm run tg -- demo-off               hide seeded demo positions
//    npm run tg -- unhook                 detach the webhook (local dev)
//
//  The token comes from .env (TELEGRAM_BOT_TOKEN) and never from an argument,
//  so it cannot end up in the shell history.
// ─────────────────────────────────────────────────────────────────────────
import '../server/env.js';
import { init, db } from '../server/db.js';
import {
  liveMode, botInfo, webhookInfo, setWebhook, configureBot,
  checkChannelAccess, listChannels, parsePostText,
} from '../server/telegram.js';

const [cmd = 'status', arg] = process.argv.slice(2);

if (!liveMode()) {
  console.error('TELEGRAM_BOT_TOKEN is empty — put it in .env first.');
  process.exit(1);
}

init();

const line = (s = '') => console.log(s);
const ok = (s) => console.log(`  ✓ ${s}`);
const bad = (s) => console.log(`  ✗ ${s}`);

async function status() {
  const me = await botInfo();
  const hook = await webhookInfo();
  line(`bot        @${me.username} (${me.id})`);
  line(`webhook    ${hook.url || '— not set —'}`);
  if (hook.pending_update_count) line(`pending    ${hook.pending_update_count}`);
  if (hook.last_error_message) line(`last error ${hook.last_error_date ? new Date(hook.last_error_date * 1000).toISOString() : ''} ${hook.last_error_message}`);
  line(`updates    ${(hook.allowed_updates || ['(default)']).join(', ')}`);
}

async function setup(url) {
  if (!url || !url.startsWith('https://')) {
    console.error('usage: npm run tg -- setup https://your-app.example');
    process.exit(1);
  }
  const hook = await setWebhook(url);
  line(`webhook → ${url}/telegram/webhook`);
  line(JSON.stringify(hook));
  const conf = await configureBot(url);
  line('menu button + commands set');
  line(JSON.stringify(conf.menuButton ?? conf));
  await status();
}

// The check that actually matters before a test: can the bot see each channel?
// Being able to getChat means it is a member/admin; that is also when we learn
// the numeric chat_id, which is what makes private channels work.
async function channels() {
  const rows = listChannels(); // enabled only — disabled ones are history
  const me = await botInfo();
  let admin = 0;
  const missing = [];

  for (const c of rows) {
    const target = c.chatId || c.username;
    if (!target) { bad(`${c.title} — немає ні @username, ні chat_id`); continue; }
    try {
      const info = await checkChannelAccess(target);
      if (!c.chatId && info.id) {
        db.prepare('UPDATE channels SET chat_id=? WHERE key=?').run(String(info.id), c.key);
      }
      if (info.isAdmin) {
        admin += 1;
        ok(`${c.title} → адмін${info.canPost ? ', може публікувати' : ', тільки читання'} (${info.id})`);
      } else {
        missing.push(c.username ? `@${c.username}` : c.title);
        bad(`${c.title} — бот не адмін (статус: ${info.status}), пости не надходитимуть`);
      }
    } catch (e) {
      missing.push(c.username ? `@${c.username}` : c.title);
      bad(`${c.title} — ${String(e.message || e).replace(/^Telegram get\w+: /, '')}`);
    }
  }

  line();
  line(`${admin}/${rows.length} каналів з ботом-адміністратором.`);
  if (missing.length) {
    line('');
    line(`Додайте @${me.username} адміністратором тут:`);
    for (const m of missing) line(`  ${m}`);
  }
}

// Point the bot's Mini App at a URL WITHOUT touching the webhook. Needed while
// developing over a tunnel: polling and webhooks are mutually exclusive, so
// `setup` (which sets a webhook) would silently kill the local poller.
async function app(url) {
  if (!url || !url.startsWith('https://')) {
    console.error('usage: npm run tg -- app https://your-tunnel.example');
    process.exit(1);
  }
  const conf = await configureBot(url);
  line(`Mini App → ${url}`);
  line(JSON.stringify(conf.menuButton ?? conf));
}

async function unhook() {
  const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/deleteWebhook`, { method: 'POST' });
  line(JSON.stringify(await res.json()));
}

// Hide the seeded demo positions once real channel posts have arrived. A real
// post carries Telegram photo file_ids; a seeded one only has an emoji — that
// is the cleanest way to tell them apart without a flag column. Hidden, not
// deleted: the demo data is still there if a screenshot needs it.
async function demoOff() {
  const info = db.prepare(
    `UPDATE posts SET status='hidden'
      WHERE status='published' AND photos_json IS NULL
        AND (image_url IS NULL OR length(image_url) <= 8)`
  ).run();
  const left = db.prepare("SELECT COUNT(*) n FROM posts WHERE status='published'").get().n;
  line(`сховано демо-позицій: ${info.changes}`);
  line(`лишилось у вітрині: ${left} (справжні пости з каналів)`);
}

// Bring them back.
async function demoOn() {
  const info = db.prepare("UPDATE posts SET status='published' WHERE status='hidden'").run();
  line(`повернуто у вітрину: ${info.changes}`);
}

// Re-derive title/brand/category for posts already stored. Needed whenever the
// parser improves: the raw text is kept in `body`, so nothing is lost and the
// vitrine can be rebuilt from it.
async function reparse() {
  const rows = db.prepare("SELECT id, body, title FROM posts WHERE source='channel'").all();
  const upd = db.prepare('UPDATE posts SET title=?, brand=?, category=?, article=COALESCE(article, ?) WHERE id=?');
  let changed = 0;
  for (const r of rows) {
    const parsed = parsePostText(r.body || r.title || '');
    if (parsed.title !== r.title || parsed.brand || parsed.category) {
      upd.run(parsed.title, parsed.brand, parsed.category, parsed.article, r.id);
      if (parsed.title !== r.title) changed += 1;
    }
  }
  line(`переоброблено ${rows.length} постів, назв змінено: ${changed}`);
  for (const r of db.prepare("SELECT title, brand, category FROM posts WHERE source='channel' ORDER BY id DESC LIMIT 8").all()) {
    ok(`${r.title}${r.brand ? ` · ${r.brand}` : ''}${r.category ? ` · ${r.category}` : ''}`);
  }
}

const commands = { status, setup, app, channels, unhook, reparse, 'demo-off': demoOff, 'demo-on': demoOn };
const run = commands[cmd];
if (!run) {
  console.error(`unknown command "${cmd}". Use: ${Object.keys(commands).join(' | ')}`);
  process.exit(1);
}
run(arg).catch((e) => { console.error(String(e.message || e)); process.exit(1); });
