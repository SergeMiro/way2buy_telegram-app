#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
//  scripts/backfill-photos.mjs — puts the pictures back in the vitrine.
//
//  Every imported card stored a cdn.telesco.pe link, those links expire, and by
//  18.08.2026 all 6349 of them had. This walks each catalogue's public pages
//  again — which is the only way to get a LIVE link for an old post — copies
//  each cover into object storage, and rewrites the row to point at a URL that
//  will still work next year.
//
//  It is the ordinary deep sync doing its ordinary job; the only special part is
//  clearing `history_done` and `sync_cursor` first, because a channel that has
//  already been walked to the end considers a deepen pass finished before it
//  starts. That reset is documented in sql/schema.sql for exactly this case.
//
//    npm run photos -- --dry            # what would be walked, nothing written
//    npm run photos -- --channel bags   # one catalogue
//    npm run photos                     # all of them, ~3-4 hours, resumable
//
//  Resumable by construction: the cursor is persisted on the channel row after
//  every call, so a killed run continues where it stopped. Re-running is cheap —
//  a cover already in storage is recognised and skipped.
// ─────────────────────────────────────────────────────────────────────────
import '../server/env.js';
import { init, db, driverKind } from '../server/db.js';
import { syncChannel } from '../server/sync.js';
import * as photos from '../server/photos.js';

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? true);
};
const dry = process.argv.includes('--dry');
const only = arg('channel');
const pages = Number(arg('pages', 4));

await init();
if (driverKind() !== 'pg') {
  console.error('DATABASE_URL не заданий — це не та база, яку ви хотіли лікувати.');
  process.exit(1);
}
if (!photos.configured() && !dry) {
  console.error('Немає SUPABASE_PROJECT_REF / SUPABASE_SERVICE_ROLE_KEY — копіювати нікуди.');
  process.exit(1);
}

const channels = await db.prepare(`SELECT * FROM channels
   WHERE enabled AND username IS NOT NULL ${only ? 'AND key = ?' : ''}
   ORDER BY key`).all(...(only ? [only] : []));

const stats = await db.prepare(`SELECT
    count(*) FILTER (WHERE photos_json->>0 LIKE '%/storage/v1/object/public/%') stored,
    count(*) FILTER (WHERE photos_json->>0 LIKE 'http%' AND photos_json->>0 NOT LIKE '%/storage/%') expiring,
    count(*) FILTER (WHERE photos_json IS NOT NULL AND photos_json->>0 NOT LIKE 'http%') file_ids
  FROM posts WHERE status='published' AND photos_json IS NOT NULL`).get();
console.log(`Картки: ${stats.stored} вже в сховищі · ${stats.expiring} на тимчасових посиланнях · ${stats.file_ids} на file_id (їх лікувати не треба)`);
console.log(`Каталогів до обходу: ${channels.length}\n`);

if (dry) {
  console.table(channels.map((c) => ({ key: c.key, username: c.username, history_done: c.history_done })));
  console.log('--dry: нічого не змінено.');
  await db.close();
  process.exit(0);
}

let totalStored = 0;
for (const channel of channels) {
  // A channel already walked to its end will not walk again without this.
  await db.prepare('UPDATE channels SET history_done = false, sync_cursor = NULL WHERE key = ?').run(channel.key);

  let pass = 0;
  let done = false;
  let stored = 0;
  const startedAt = Date.now();
  while (!done) {
    const fresh = await db.prepare('SELECT * FROM channels WHERE key = ?').get(channel.key);
    const r = await syncChannel(fresh, { deep: true, pages });
    pass += 1;
    stored += r.photosStored || 0;
    totalStored += r.photosStored || 0;
    done = r.done;
    process.stdout.write(
      `\r  ${channel.key.padEnd(14)} прохід ${String(pass).padStart(3)} · сторінок ${pass * pages}` +
      ` · фото збережено ${stored} · ${Math.round((Date.now() - startedAt) / 1000)}с   `);
  }
  console.log(`\r  ${channel.key.padEnd(14)} готово: ${stored} обкладинок за ${Math.round((Date.now() - startedAt) / 1000)}с${' '.repeat(20)}`);
}

const after = await db.prepare(`SELECT
    count(*) FILTER (WHERE photos_json->>0 LIKE '%/storage/v1/object/public/%') stored,
    count(*) FILTER (WHERE photos_json->>0 LIKE 'http%' AND photos_json->>0 NOT LIKE '%/storage/%') expiring
  FROM posts WHERE status='published' AND photos_json IS NOT NULL`).get();
console.log(`\nЗбережено цим запуском: ${totalStored}`);
console.log(`Тепер: ${after.stored} карток на постійних посиланнях · ${after.expiring} ще на тимчасових`);
await db.close();
