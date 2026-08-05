#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
//  scripts/import-tme.mjs — fills the catalogues from the channels themselves.
//
//  The Bot API cannot read history, so a channel the bot joined today shows up
//  empty however many cards it already holds. Every Way2Buy catalogue is a
//  public channel, and Telegram publishes those as web pages — see server/tme.js
//  for why that is the only path that can look backwards.
//
//  Three commands, and the third is the one that runs on a schedule:
//
//    # register a new catalogue (once per channel)
//    npm run import:tme -- --add @w2b_luxury_bags --title "Сумки жіночі" --emoji 👜
//
//    # walk further back into history — repeat until it reports "історію пройдено"
//    npm run import:tme -- --deepen --pages 40
//
//    # catch up on what was published since the last run (all catalogues)
//    npm run import:tme -- --all
//
//  Adding a catalogue therefore needs no code change: a row in `channels` is
//  all the app needs, and the CATALOG tab picks up new chips and new filter
//  values from the data on its own.
//
//  Flags:
//    --channel @name   restrict to one catalogue (repeatable); auto-registers
//    --all             every enabled catalogue that has a @username
//    --deepen          start at the OLDEST post already stored and go back
//    --pages N         stop after N pages per channel (default 8, ~25 posts each)
//    --limit N         stop after N new positions per channel
//    --since DATE      stop at posts older than DATE (YYYY-MM-DD)
//    --refresh         also update captions/photos of posts already stored
//    --reparse         re-derive brand/category/title from stored text, no network
//    --dry             parse and report, write nothing
// ─────────────────────────────────────────────────────────────────────────
import '../server/env.js';
import { init, db, driverKind } from '../server/db.js';
import { parsePostText } from '../server/telegram.js';
import { fetchChannelPage, normalizeUsername, keyFor, sleep, TmeError } from '../server/tme.js';

const argv = process.argv.slice(2);
const has = (name) => argv.includes(`--${name}`);
const val = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : fallback;
};
const all = (name) => argv.reduce((acc, a, i) => (a === `--${name}` && argv[i + 1] && !argv[i + 1].startsWith('--') ? [...acc, argv[i + 1]] : acc), []);

const OPT = {
  channels: all('channel'),
  add: val('add'),
  title: val('title'),
  emoji: val('emoji'),
  key: val('key'),
  everything: has('all'),
  deepen: has('deepen'),
  pages: Number(val('pages', 8)) || 8,
  limit: Number(val('limit', 0)) || Infinity,
  since: val('since'),
  refresh: has('refresh'),
  reparse: has('reparse'),
  dry: has('dry'),
};

// Telegram is being asked for pages nobody is paying for; a human reading a
// channel does not fetch four pages a second.
const PAGE_DELAY_MS = Number(process.env.W2B_TME_DELAY_MS || 700);
const BATCH = 40; // rows per INSERT — one round-trip instead of forty

const sinceTs = OPT.since ? Date.parse(OPT.since) : null;
if (OPT.since && !Number.isFinite(sinceTs)) {
  console.error(`--since: не зрозумів дату "${OPT.since}" (потрібен формат YYYY-MM-DD)`);
  process.exit(1);
}

await init();

// ── channel registry ──────────────────────────────────────────────────────

async function registerChannel({ username, key, title, emoji }) {
  const existing = await db.prepare('SELECT * FROM channels WHERE lower(username)=?').get(username.toLowerCase());
  if (existing) {
    // Title and emoji are the labels Maryna sees on the chips, so an explicit
    // --title overwrites; everything else is left alone.
    if (title || emoji) {
      await db.prepare('UPDATE channels SET title=COALESCE(?,title), emoji=COALESCE(?,emoji) WHERE id=?')
        .run(title || null, emoji || null, existing.id);
    }
    return { ...existing, title: title || existing.title, emoji: emoji || existing.emoji, created: false };
  }

  const finalKey = key || keyFor(username);
  const clash = await db.prepare('SELECT 1 FROM channels WHERE key=?').get(finalKey);
  if (clash) throw new Error(`ключ "${finalKey}" вже зайнятий іншим каналом — задайте --key`);

  await db.prepare(`INSERT INTO channels (key,chat_id,username,title,emoji,kind,enabled,created_at)
    VALUES (?,NULL,?,?,?, 'catalog',true,?)`)
    .run(finalKey, username, title || username, emoji || '🛍️', new Date().toISOString());
  const row = await db.prepare('SELECT * FROM channels WHERE key=?').get(finalKey);
  return { ...row, created: true };
}

async function targetChannels() {
  if (OPT.add) {
    const username = normalizeUsername(OPT.add);
    // The page title is a better default than the @username: "W2B Luxury Bags"
    // reads like a catalogue, "w2b_luxury_bags" reads like a slug.
    let title = OPT.title;
    if (!title) {
      const page = await fetchChannelPage(username);
      title = page.title || username;
    }
    const ch = await registerChannel({ username, key: OPT.key, title, emoji: OPT.emoji });
    console.log(`${ch.created ? '＋ додано' : '· вже було'}: ${ch.emoji} ${ch.title} (key=${ch.key}, @${ch.username})`);
    return [ch];
  }

  if (OPT.channels.length) {
    const out = [];
    for (const raw of OPT.channels) {
      const username = normalizeUsername(raw);
      const known = await db.prepare('SELECT * FROM channels WHERE lower(username)=?').get(username.toLowerCase());
      if (known) { out.push(known); continue; }
      // A channel named on the command line but unknown to the database is a
      // new catalogue — registering it here is what makes "add a channel" a
      // one-command operation.
      const page = await fetchChannelPage(username);
      const ch = await registerChannel({ username, key: OPT.key, title: OPT.title || page.title || username, emoji: OPT.emoji });
      console.log(`＋ новий каталог: ${ch.emoji} ${ch.title} (key=${ch.key})`);
      out.push(ch);
    }
    return out;
  }

  if (OPT.everything || OPT.deepen || OPT.reparse) {
    return await db.prepare(
      "SELECT * FROM channels WHERE enabled AND username IS NOT NULL AND kind='catalog' ORDER BY id"
    ).all();
  }

  console.error('нічого не вибрано: вкажіть --all, --channel @name, --add @name або --reparse');
  console.error('  npm run import:tme -- --help  для повного списку прапорців');
  process.exit(1);
}

// ── writing posts ─────────────────────────────────────────────────────────

const COLUMNS = [
  'channel', 'tg_message_id', 'title', 'body', 'price', 'currency', 'image_url',
  'article', 'brand', 'category', 'photos_json', 'source', 'status', 'created_at',
];

function rowFor(channel, post) {
  const parsed = parsePostText(post.text, { channelTitle: channel.title });
  return [
    channel.key,
    post.messageId,
    parsed.title,
    parsed.body,
    parsed.price,
    parsed.currency || 'USD',
    // A post with no photo keeps the emoji stand-in, exactly like the live path.
    post.photos[0] || '🛍️',
    parsed.article,
    parsed.brand,
    parsed.category,
    post.photos.length ? JSON.stringify(post.photos) : null,
    'channel',
    'published',
    post.date || new Date().toISOString(),
  ];
}

// One INSERT per batch: at ~100 ms to us-east-2, forty separate statements cost
// four seconds and one costs a tenth of that.
async function insertBatch(rows) {
  if (!rows.length) return 0;
  const placeholders = rows.map(() => `(${COLUMNS.map(() => '?').join(',')})`).join(',');
  const sql = `INSERT INTO posts (${COLUMNS.join(',')}) VALUES ${placeholders}
    ON CONFLICT (channel, tg_message_id) WHERE tg_message_id IS NOT NULL DO NOTHING`;
  const info = await db.prepare(sql).run(...rows.flat());
  return info.changes;
}

async function refreshPost(channel, post) {
  const parsed = parsePostText(post.text, { channelTitle: channel.title });
  const info = await db.prepare(`UPDATE posts SET title=?, body=?,
      price=COALESCE(?,price), currency=COALESCE(?,currency), article=COALESCE(?,article),
      brand=COALESCE(?,brand), category=COALESCE(?,category),
      image_url=COALESCE(?,image_url), photos_json=COALESCE(?,photos_json), edited_at=?
    WHERE channel=? AND tg_message_id=?`)
    .run(parsed.title, parsed.body, parsed.price, parsed.currency, parsed.article,
      parsed.brand, parsed.category, post.photos[0] || null,
      post.photos.length ? JSON.stringify(post.photos) : null,
      new Date().toISOString(), channel.key, post.messageId);
  return info.changes;
}

// ── reparse: re-derive the labels from text already stored ────────────────
//
// The parser improves — a house is added to the brand list, a category word is
// added, a catalogue is renamed to something that implies its category. The
// cards already in the database were labelled by the OLD parser and would keep
// their old labels forever, so a filter would quietly disagree with itself:
// «Hermes 81» from last month sitting next to «Hermès 12» from today.
//
// Nothing is fetched. The post's own text is in `body`, which is the input the
// parser wants, so this is a pure recomputation over the local database.
async function reparseChannel(channel) {
  const rows = await db.prepare(
    "SELECT id, body FROM posts WHERE channel=? AND source='channel'"
  ).all(channel.key);

  const upd = db.prepare(`UPDATE posts SET title=?, brand=?, category=?,
      article=COALESCE(?,article), price=COALESCE(?,price), currency=COALESCE(?,currency)
    WHERE id=?`);

  let changed = 0;
  // Eight at a time: the pool holds ten connections, and one round-trip per row
  // to another continent would take a minute where this takes seconds.
  for (let i = 0; i < rows.length; i += 8) {
    const done = await Promise.all(rows.slice(i, i + 8).map(async (r) => {
      const p = parsePostText(r.body || '', { channelTitle: channel.title });
      const info = await upd.run(p.title, p.brand, p.category, p.article, p.price, p.currency, r.id);
      return info.changes;
    }));
    changed += done.reduce((a, b) => a + b, 0);
  }

  const total = (await db.prepare("SELECT COUNT(*) c FROM posts WHERE channel=? AND status='published'").get(channel.key)).c;
  return { pages: 0, seen: rows.length, added: 0, updated: changed, skipped: 0, total, oldest: null, stopped: 'перерозбір' };
}

// ── one channel ───────────────────────────────────────────────────────────

async function importChannel(channel) {
  const username = channel.username;
  const known = new Set(
    (await db.prepare('SELECT tg_message_id FROM posts WHERE channel=? AND tg_message_id IS NOT NULL').all(channel.key))
      .map((r) => Number(r.tg_message_id))
  );

  // --deepen resumes where the last backfill stopped instead of re-reading the
  // newest pages, which is what makes a long history importable in sittings.
  let cursor = null;
  if (OPT.deepen && known.size) {
    cursor = Math.min(...known);
  }

  const stats = { pages: 0, seen: 0, added: 0, updated: 0, skipped: 0, noMedia: 0, stopped: 'ліміт сторінок' };
  let batch = [];

  for (let page = 0; page < OPT.pages; page += 1) {
    let result;
    try {
      result = await fetchChannelPage(username, { before: cursor });
    } catch (e) {
      stats.stopped = `помилка: ${e.message}`;
      break;
    }
    stats.pages += 1;

    // Newest first, so --limit and --since cut off the oldest end.
    const posts = [...result.posts].reverse();
    let stop = null;

    for (const post of posts) {
      stats.seen += 1;

      if (sinceTs && post.date && Date.parse(post.date) < sinceTs) { stop = `дата < ${OPT.since}`; break; }
      if (!post.photos.length && !post.text) { stats.noMedia += 1; continue; }

      if (known.has(post.messageId)) {
        stats.skipped += 1;
        if (OPT.refresh && !OPT.dry) stats.updated += await refreshPost(channel, post);
        // Catching up: the first already-stored post means everything older is
        // stored too, so there is nothing left to do on this channel. During a
        // --deepen run the opposite is true — known ids are what we walk past.
        if (!OPT.deepen && !OPT.refresh) { stop = 'дійшли до вже імпортованого'; break; }
        continue;
      }

      known.add(post.messageId);
      batch.push(rowFor(channel, post));
      if (!OPT.dry && batch.length >= BATCH) { stats.added += await insertBatch(batch); batch = []; }
      else if (OPT.dry) stats.added += 1;

      if (stats.added + batch.length >= OPT.limit) { stop = `ліміт ${OPT.limit} позицій`; break; }
    }

    if (!OPT.dry && batch.length) { stats.added += await insertBatch(batch); batch = []; }
    if (stop) { stats.stopped = stop; break; }
    if (!result.before) { stats.stopped = 'історію пройдено до кінця'; break; }
    cursor = result.before;
    await sleep(PAGE_DELAY_MS);
  }

  if (!OPT.dry && batch.length) stats.added += await insertBatch(batch);

  const total = (await db.prepare("SELECT COUNT(*) c FROM posts WHERE channel=? AND status='published'").get(channel.key)).c;
  const oldest = (await db.prepare('SELECT MIN(tg_message_id) m FROM posts WHERE channel=?').get(channel.key)).m;
  return { ...stats, total, oldest };
}

// ── run ───────────────────────────────────────────────────────────────────

if (has('help')) {
  console.log(`
  npm run import:tme -- --add @channel [--title "Назва"] [--emoji 👜] [--key ключ]
  npm run import:tme -- --all [--pages N] [--limit N] [--since YYYY-MM-DD] [--refresh]
  npm run import:tme -- --deepen [--pages N]
  npm run import:tme -- --channel @channel [--dry]
`);
  process.exit(0);
}

let channels;
try {
  channels = await targetChannels();
} catch (e) {
  console.error(e instanceof TmeError ? e.message : `не вдалося: ${e.message}`);
  process.exit(1);
}

console.log(`база: ${driverKind()}${OPT.dry ? '  (dry run — нічого не пишемо)' : ''}`);
console.log(OPT.reparse
  ? `каналів: ${channels.length}  ·  перерозбір локальних даних, без запитів до Telegram\n`
  : `каналів: ${channels.length}  ·  ${OPT.deepen ? 'догрібаємо історію' : 'нове зверху'}  ·  до ${OPT.pages} сторінок кожен\n`);

const report = [];
for (const channel of channels) {
  process.stdout.write(`@${channel.username} … `);
  const r = OPT.reparse ? await reparseChannel(channel) : await importChannel(channel);
  console.log(OPT.reparse
    ? `перерозібрано ${r.updated} з ${r.seen}`
    : `+${r.added} нових, ${r.skipped} вже було, ${r.pages} стор. — ${r.stopped}`);
  report.push({ channel, ...r });
}

console.log(`\n${'канал'.padEnd(24)}${(OPT.reparse ? 'змінено' : 'нових').padStart(8)}${'усього'.padStart(8)}${'найстаріший id'.padStart(16)}`);
console.log('─'.repeat(56));
for (const r of report) {
  console.log(
    `${r.channel.title.slice(0, 23).padEnd(24)}${String(OPT.reparse ? r.updated : r.added).padStart(8)}${String(r.total).padStart(8)}${String(r.oldest ?? '—').padStart(16)}`
  );
}
console.log('─'.repeat(56));
console.log(OPT.reparse
  ? `разом перерозібрано: ${report.reduce((s, r) => s + r.updated, 0)}`
  : `разом нових позицій: ${report.reduce((s, r) => s + r.added, 0)}`);
if (report.some((r) => r.stopped === 'ліміт сторінок')) {
  console.log('частина каналів обірвалась на ліміті сторінок — запустіть ще раз з --deepen, щоб піти глибше');
}

await db.close();
