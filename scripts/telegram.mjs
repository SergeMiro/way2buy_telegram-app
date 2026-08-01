#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
//  scripts/telegram.mjs — one command to wire the bot up and to check it.
//
//    npm run tg -- status                 what Telegram thinks right now
//    npm run tg -- setup <https-url>      webhook + menu button + commands
//    npm run tg -- channels               is the bot an admin of each channel?
//    npm run tg -- unhook                 detach the webhook (local dev)
//
//  The token comes from .env (TELEGRAM_BOT_TOKEN) and never from an argument,
//  so it cannot end up in the shell history.
// ─────────────────────────────────────────────────────────────────────────
import '../server/env.js';
import { init, db } from '../server/db.js';
import {
  liveMode, botInfo, webhookInfo, setWebhook, configureBot,
  checkChannelAccess, listChannels,
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

async function unhook() {
  const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/deleteWebhook`, { method: 'POST' });
  line(JSON.stringify(await res.json()));
}

const commands = { status, setup, channels, unhook };
const run = commands[cmd];
if (!run) {
  console.error(`unknown command "${cmd}". Use: ${Object.keys(commands).join(' | ')}`);
  process.exit(1);
}
run(arg).catch((e) => { console.error(String(e.message || e)); process.exit(1); });
