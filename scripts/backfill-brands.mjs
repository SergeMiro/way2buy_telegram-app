#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
//  scripts/backfill-brands.mjs — drains the brand queue in one sitting.
//
//  The scheduler works the same queue eight cards an hour, which is right for
//  the trickle of new posts and wrong for a backlog: ~1900 cards would take ten
//  days. This is the one-off that clears it, and after that the hourly tick has
//  only the day's new posts to look at.
//
//  It answers ONLY where the caption and the catalogue's name were both silent
//  — the same rule as everywhere else. A caption that names a house is never
//  second-guessed, however wrong it looks.
//
//    npm run brands                 # drain everything, pausing between calls
//    npm run brands -- --limit 25   # a taste first, to check the answers
//    npm run brands -- --dry        # what WOULD be looked at, no model calls
//
//  Needs GEMINI_API_KEY and W2B_BOT_TOKEN (the photos come from Telegram).
// ─────────────────────────────────────────────────────────────────────────
import '../server/env.js';
import { init, db, driverKind } from '../server/db.js';
import { backfillBrands, pendingCount, configured } from '../server/vision.js';

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? true);
};
const dry = process.argv.includes('--dry');
const limit = Number(arg('limit', 0)) || Infinity;
// Gentle by default: the free tier is rate limited per minute, and a backlog
// that clears in two hours instead of one is not worth a wall of 429s.
const pause = Number(arg('pause', 1200));
const CHUNK = Number(arg('chunk', 5));

await init();
if (driverKind() !== 'pg') {
  console.error('DATABASE_URL не заданий — скрипт підключився до порожньої тимчасової бази.');
  console.error('Це майже напевно не те, чого ви хотіли: вкажіть прод-базу і повторіть.');
  process.exit(1);
}

const pending = await pendingCount();
console.log(`У черзі: ${pending} карток без бренду.`);

if (dry) {
  const sample = await db.prepare(`SELECT id, channel, title, left(body, 60) AS body FROM posts
     WHERE brand_source IS NULL AND status='published' AND photos_json IS NOT NULL
     ORDER BY created_at DESC LIMIT 10`).all();
  console.table(sample);
  console.log('--dry: жодного виклику моделі не зроблено.');
  await db.close();
  process.exit(0);
}

if (!configured()) {
  console.error('Немає GEMINI_API_KEY — див. docs/TODO.md, розділ «Що потрібно від Сергія».');
  await db.close();
  process.exit(1);
}

const totals = { looked: 0, named: 0, unknown: 0, failed: 0 };
const seen = new Map();

while (totals.looked < limit) {
  const r = await backfillBrands({ limit: Math.min(CHUNK, limit - totals.looked) });
  if (!r.looked) break;
  for (const k of ['looked', 'named', 'unknown', 'failed']) totals[k] += r[k] || 0;
  for (const b of r.brands || []) seen.set(b.brand, (seen.get(b.brand) || 0) + 1);
  if (r.error) console.warn('  ⚠', r.error);
  process.stdout.write(
    `\r  переглянуто ${totals.looked} · впізнано ${totals.named} · не видно ${totals.unknown}` +
    ` · помилок ${totals.failed} · лишилось ${r.pending}   `);
  // A batch that only errored means the API is refusing us; backing off is
  // better than burning through the whole queue turning it into 'vision-none'.
  if (r.failed === r.looked && r.looked > 0) {
    console.log('\n  весь батч впав — зупиняюсь, щоб не зіпсувати чергу.');
    break;
  }
  await new Promise((r2) => setTimeout(r2, pause));
}

console.log('\n\nПідсумок:');
console.table([...seen.entries()].map(([brand, cards]) => ({ brand, cards }))
  .sort((a, b) => b.cards - a.cards));
console.log(`Лишилось у черзі: ${await pendingCount()}`);
await db.close();
