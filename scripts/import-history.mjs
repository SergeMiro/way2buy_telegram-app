#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
//  scripts/import-history.mjs — pull a channel's EXISTING posts into the app.
//
//  Why this exists: the Bot API cannot read history. A bot only receives posts
//  published after it became an admin, so a channel with 300 existing cards
//  would show up empty. Telegram Desktop can export that history, and this
//  script turns the export into catalogue positions.
//
//  How to export (Telegram Desktop, not the phone):
//    channel → ⋮ → Export chat history
//      • format: JSON (Machine-readable JSON)
//      • tick Photos, size limit whatever fits
//    → produces a folder with result.json + photos/
//
//  Then:
//    npm run import -- <path/to/export> --channel test
//    npm run import -- <path/to/export> --channel test --dry     # preview only
//
//  Photos are copied into public/uploads/<channel>/ and served as plain files;
//  the file_id path (bot getFile) is only available for posts the bot itself
//  received, which is exactly what this import is working around.
// ─────────────────────────────────────────────────────────────────────────
import '../server/env.js';
import { readFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, basename, extname, resolve } from 'node:path';
import { init, db } from '../server/db.js';
import { parsePostText } from '../server/telegram.js';

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true);
};
const channelKey = flag('channel');
const dryRun = Boolean(flag('dry'));
const limit = Number(flag('limit')) || Infinity;

if (!dir || !channelKey) {
  console.error('usage: npm run import -- <path/to/telegram/export> --channel <key> [--dry] [--limit N]');
  process.exit(1);
}

init();

const channel = db.prepare('SELECT * FROM channels WHERE key=?').get(channelKey);
if (!channel) {
  console.error(`unknown channel "${channelKey}". Known: ` +
    db.prepare('SELECT key FROM channels ORDER BY key').all().map((r) => r.key).join(', '));
  process.exit(1);
}

const exportDir = resolve(dir);
const jsonPath = existsSync(join(exportDir, 'result.json'))
  ? join(exportDir, 'result.json')
  : exportDir; // allow passing result.json directly
const data = JSON.parse(readFileSync(jsonPath, 'utf8'));
const baseDir = jsonPath.endsWith('.json') ? resolve(jsonPath, '..') : exportDir;

// Telegram writes `text` either as a plain string or as an array of runs
// (plain strings mixed with {type, text} objects for links, bold, hashtags).
function plainText(text) {
  if (typeof text === 'string') return text;
  if (!Array.isArray(text)) return '';
  return text.map((t) => (typeof t === 'string' ? t : t.text || '')).join('');
}

const uploadsRel = join('uploads', channel.key);
const uploadsAbs = resolve('public', uploadsRel);
if (!dryRun) mkdirSync(uploadsAbs, { recursive: true });

const messages = (data.messages || []).filter((m) => m.type === 'message');
const insert = db.prepare(`INSERT INTO posts
  (channel,tg_message_id,title,body,price,currency,image_url,article,photos_json,media_group_id,source,status,created_at)
  VALUES (@channel,@tg_message_id,@title,@body,@price,@currency,@image_url,@article,NULL,NULL,'channel','published',@created_at)`);
const existing = db.prepare('SELECT id FROM posts WHERE channel=? AND tg_message_id=?');
const update = db.prepare(`UPDATE posts SET title=@title, body=@body, price=COALESCE(@price, price),
  article=COALESCE(@article, article), image_url=COALESCE(@image_url, image_url) WHERE id=@id`);

let added = 0; let updated = 0; let skipped = 0; let withPhoto = 0;

for (const m of messages) {
  if (added + updated >= limit) break;

  const text = plainText(m.text);
  const parsed = parsePostText(text);
  // A card with neither text nor a photo carries nothing — service messages,
  // polls, stickers all land here.
  const photoSrc = m.photo || (m.mime_type && String(m.mime_type).startsWith('image/') ? m.file : null);
  if (!text.trim() && !photoSrc) { skipped += 1; continue; }

  let imageUrl = '🛍️';
  if (photoSrc) {
    const src = resolve(baseDir, photoSrc);
    if (existsSync(src)) {
      const name = `${m.id}${extname(src) || '.jpg'}`;
      if (!dryRun) copyFileSync(src, join(uploadsAbs, name));
      imageUrl = `/${uploadsRel}/${name}`.replace(/\\/g, '/');
      withPhoto += 1;
    }
  }

  const row = {
    channel: channel.key,
    tg_message_id: m.id,
    title: parsed.title,
    body: parsed.body,
    price: parsed.price,
    currency: parsed.currency || 'USD',
    image_url: imageUrl,
    article: parsed.article,
    created_at: new Date(m.date_unixtime ? Number(m.date_unixtime) * 1000 : m.date).toISOString(),
  };

  const hit = existing.get(channel.key, m.id);
  if (hit) {
    if (!dryRun) update.run({ ...row, id: hit.id });
    updated += 1;
  } else {
    if (!dryRun) insert.run(row);
    added += 1;
  }
}

console.log(`${dryRun ? '[dry run] ' : ''}канал «${channel.title}» (${channel.key})`);
console.log(`  повідомлень у експорті: ${messages.length}`);
console.log(`  додано: ${added} · оновлено: ${updated} · пропущено (без тексту й фото): ${skipped}`);
console.log(`  з фотографіями: ${withPhoto}${dryRun ? '' : ` → public/${uploadsRel}/`}`);
if (dryRun) console.log('  нічого не записано — приберіть --dry, щоб імпортувати');
