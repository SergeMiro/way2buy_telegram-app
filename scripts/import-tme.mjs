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
//    # walk further back into history, to the channel's very first post
//    npm run import:tme -- --deepen --until-done
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
//    --deepen          continue the backfill from where the last pass stopped
//    --until-done      with --deepen: keep going until the channel's first post
//    --pages N         stop after N pages per channel (default 8, ~25 posts each)
//    --reparse         re-derive brand/category/title from stored text, no network
//    --dry             parse and report, write nothing
// ─────────────────────────────────────────────────────────────────────────
import '../server/env.js';
import { init, db, driverKind } from '../server/db.js';
import { parsePostText } from '../server/telegram.js';
import { fetchChannelPage, normalizeUsername, keyFor, sleep, TmeError } from '../server/tme.js';
import { syncChannel, registerChannel } from '../server/sync.js';

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
  reparse: has('reparse'),
  untilDone: has('until-done'),
  dry: has('dry'),
};

// Telegram is being asked for pages nobody is paying for; a human reading a
// channel does not fetch four pages a second.
const PAGE_DELAY_MS = Number(process.env.W2B_TME_DELAY_MS || 700);
const BATCH = 40; // rows per INSERT — one round-trip instead of forty

// Flags that belonged to the old writer and have no meaning for the sync engine.
// Rejected rather than ignored: a flag that is typed and silently dropped is
// worse than one that does not exist.
for (const [flag, why] of [
  ['since',   'синхронізація йде від найновішого назад — обмежте --pages'],
  ['limit',   'синхронізація не рахує позиції, рахує сторінки — використайте --pages'],
  ['refresh', 'оновлення вже вбудоване: існуючі картки оновлюються завжди'],
]) {
  if (has(flag)) {
    console.error(`--${flag} більше не підтримується: ${why}`);
    process.exit(1);
  }
}

await init();

// ── channel registry: server/sync.js owns it, so the cabinet and the command
// line create a catalogue by exactly the same rules.

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
//
// The reading and reconciling live in server/sync.js — the same engine the
// «Синхронізувати» button runs. This used to be a second implementation of it,
// and the two had already drifted: --deepen resumed from the OLDEST message id
// stored, which sounds right and is not. Seeded demo cards carry ids in the
// 2000s, so for a catalogue whose real posts start at 69181 the resume point was
// 2001 and a backfill skipped sixty-seven thousand messages in one jump. The
// button never had that bug because it resumes from a cursor it persisted.
//
// One engine, one cursor, one set of rules about hidden and curated cards.
async function importChannel(channel) {
  // A fresh row each pass: syncChannel resumes from channel.sync_cursor, and the
  // previous pass has just moved it.
  const fresh = await db.prepare('SELECT * FROM channels WHERE key=?').get(channel.key);
  const r = await syncChannel(fresh, { deep: OPT.deepen, pages: OPT.pages });
  return {
    ...r,
    skipped: r.skipped,
    oldest: r.range ? r.range.from : null,
    stopped: r.done
      ? (r.historyDone ? 'історію пройдено до кінця' : 'готово')
      : `зупинились на ${r.cursor}`,
  };
}

// --until-done: keep going until the channel's first post is reached. A full
// catalogue is thousands of pages, far more than one invocation should hold, so
// the loop is here rather than in the engine — and every round persists its
// cursor, so killing this at any moment loses nothing but the current page.
async function importChannelFully(channel) {
  const totals = { added: 0, updated: 0, gone: 0, pages: 0, rounds: 0 };
  let last = null;

  for (let round = 0; round < 5000; round += 1) {
    const fresh = await db.prepare('SELECT * FROM channels WHERE key=?').get(channel.key);
    if (fresh.history_done) break;

    last = await syncChannel(fresh, { deep: true, pages: OPT.pages });
    totals.added += last.added;
    totals.updated += last.updated;
    totals.gone += last.gone;
    totals.pages += last.pages;
    totals.rounds += 1;

    if (round % 5 === 0) {
      process.stdout.write(`\n    ${totals.pages} стор. · +${totals.added} нових · курсор ${last.cursor ?? '—'}`);
    }
    if (last.done || last.historyDone) break;
    await sleep(PAGE_DELAY_MS);
  }

  return {
    ...(last || { total: 0, range: null }),
    ...totals,
    oldest: last?.range ? last.range.from : null,
    stopped: last?.historyDone ? 'історію пройдено до кінця' : `зупинились на ${last?.cursor ?? '—'}`,
  };
}

// ── run ───────────────────────────────────────────────────────────────────

if (has('help')) {
  console.log(`
  npm run import:tme -- --add @channel [--title "Назва"] [--emoji 👜] [--key ключ]
  npm run import:tme -- --all [--pages N]
  npm run import:tme -- --deepen [--pages N] [--until-done]
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
  // One unreachable channel must not end the run. Half the catalogue list is
  // placeholders for brands that have no channel yet, and --all walks all of
  // them; a 404 on one is a line in the report, not a dead batch job.
  let r;
  try {
    r = OPT.reparse ? await reparseChannel(channel)
      : (OPT.untilDone ? await importChannelFully(channel) : await importChannel(channel));
  } catch (e) {
    console.log(`✗ ${e.message}`);
    report.push({ channel, added: 0, updated: 0, gone: 0, pages: 0, total: null, oldest: null, failed: e.message });
    continue;
  }
  console.log(OPT.reparse
    ? `перерозібрано ${r.updated} з ${r.seen}`
    : `+${r.added} нових, ${r.updated} оновлено, ${r.gone} знято, ${r.pages} стор. — ${r.stopped}`);
  // The channel object last: syncChannel also returns a `channel` field, and it
  // is the key string — spreading it after would replace the row with a slug.
  report.push({ ...r, channel });
}

console.log(`\n${'канал'.padEnd(24)}${(OPT.reparse ? 'змінено' : 'нових').padStart(8)}${'усього'.padStart(8)}${'найстаріший id'.padStart(16)}`);
console.log('─'.repeat(56));
for (const r of report) {
  console.log(
    `${r.channel.title.slice(0, 23).padEnd(24)}${String(OPT.reparse ? r.updated : r.added).padStart(8)}${String(r.total ?? '—').padStart(8)}${String(r.failed ? 'недоступний' : (r.oldest ?? '—')).padStart(16)}`
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
