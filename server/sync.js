// ─────────────────────────────────────────────────────────────────────────
//  sync.js — «Синхронізувати»: make a catalogue in the app match its channel.
//
//  The channel is the truth and it is never written to. Everything happens on
//  this side: read the channel's own public page (server/tme.js), then reconcile.
//
//  WHY RECONCILE AND NOT "delete, then import". The obvious way to guarantee two
//  identical lists is to empty one and refill it. It would have cost real data
//  here: `cart_items.post_id`, `cart_events.post_id` and `events.post_id` are all
//  ON DELETE SET NULL, so deleting the posts does not remove a client's fitting
//  room — it silently unhooks it. A client with three items would keep three rows
//  pointing at nothing, and the popular-items ranking, which groups by post_id,
//  would lose its history. Upserting reaches the same end state and keeps every
//  link.
//
//  TWO HUMAN DECISIONS THE CHANNEL DOES NOT GET TO OVERRULE:
//    • a card hidden in the admin office stays hidden;
//    • on a curated card, the title/brand/category a human corrected are kept —
//      the channel still supplies the text, the price and the photos.
//
//  DELETIONS. Telegram tells nobody when a channel post is deleted, so absence
//  is the only signal, and absence is only meaningful inside a range that was
//  actually read. A sync therefore records the span of message ids it scanned and
//  marks as 'gone' only the published posts inside THAT span which it did not
//  see. Posts older than the scanned span are not "missing", they are simply
//  beyond what this pass looked at.
//
//  WHY IT WORKS IN CHUNKS. A full channel is thousands of pages, and this runs
//  behind an HTTP request on a serverless host with a seconds-long limit. Each
//  call reads a few pages and returns a cursor; the caller keeps calling. The
//  cursor is also persisted on the channel row, so a deep backfill survives a
//  closed browser and resumes where it stopped.
// ─────────────────────────────────────────────────────────────────────────
import { db } from './db.js';
import { parsePostText } from './telegram.js';
import { fetchChannelPage, sleep } from './tme.js';

// One page is ~3 posts in an album-heavy catalogue and ~16 in a plain one, so
// four pages is a few seconds of work — comfortably inside a serverless limit.
const PAGES_PER_CALL = Number(process.env.W2B_SYNC_PAGES || 4);
const PAGE_DELAY_MS = Number(process.env.W2B_TME_DELAY_MS || 700);

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

/**
 * Upserts a page's worth of posts in one statement.
 *
 * `xmax = 0` is the standard way to tell an INSERT from an UPDATE in the same
 * statement: a freshly inserted row has no previous version, an updated one does.
 * Without it the caller could not report "3 new, 12 updated" and would have to
 * guess.
 */
async function upsertBatch(rows) {
  if (!rows.length) return { added: 0, updated: 0 };

  const placeholders = rows.map(() => `(${COLUMNS.map(() => '?').join(',')})`).join(',');
  const result = await db.prepare(`
    INSERT INTO posts (${COLUMNS.join(',')}) VALUES ${placeholders}
    ON CONFLICT (channel, tg_message_id) WHERE tg_message_id IS NOT NULL DO UPDATE SET
      -- The channel's own facts: always refreshed, so an edited caption or an
      -- added photo shows up in the app.
      body        = excluded.body,
      image_url   = excluded.image_url,
      photos_json = coalesce(excluded.photos_json, posts.photos_json),
      price       = coalesce(excluded.price, posts.price),
      currency    = coalesce(excluded.currency, posts.currency),
      article     = coalesce(excluded.article, posts.article),
      -- Judgement calls: kept when a human has made them.
      title       = case when posts.curated then posts.title    else excluded.title    end,
      brand       = case when posts.curated then posts.brand    else excluded.brand    end,
      category    = case when posts.curated then posts.category else excluded.category end,
      -- A post that had vanished and is back is published again. A post hidden
      -- by hand stays hidden.
      status      = case when posts.status = 'gone' then 'published' else posts.status end,
      edited_at   = now()
    RETURNING id, (xmax = 0) AS inserted`).all(...rows.flat());

  return {
    added: result.filter((r) => r.inserted).length,
    updated: result.filter((r) => !r.inserted).length,
  };
}

/**
 * Reads part of a channel and reconciles it into the app.
 *
 * @param channel    the row from `channels` (needs key, title, username)
 * @param deep       false → the newest pages, the everyday sync.
 *                   true  → continue the backfill from where it stopped.
 * @param pages      how many pages to read in this call.
 * @param fetchPage  the reader, injected so the tests can serve a channel
 *                   without a network — the reconcile SQL is the point here, and
 *                   an ESM export cannot be monkey-patched anyway.
 */
export async function syncChannel(channel, {
  deep = false,
  pages = PAGES_PER_CALL,
  fetchPage = fetchChannelPage,
} = {}) {
  if (!channel?.username) {
    throw new Error(`канал «${channel?.title || channel?.key}» без @username — синхронізувати нічого`);
  }

  const stats = {
    channel: channel.key,
    pages: 0,
    scanned: 0,
    added: 0,
    updated: 0,
    gone: 0,
    skipped: 0,
    cursor: null,
    done: false,
    historyDone: Boolean(channel.history_done),
  };

  let cursor = deep ? (channel.sync_cursor ?? null) : null;
  // Where this pass started reading. It is the UPPER bound of what the pass can
  // speak about, and it is not the same as the highest id it saw: a post deleted
  // at the very top of the channel has a HIGHER id than anything still there, so
  // bounding by "highest seen" would make exactly the most recent deletion
  // invisible. `before=X` returns posts older than X, so the window read is
  // [lowest seen, X); starting from the top, it is [lowest seen, ∞).
  const startedAt = cursor;
  const seen = [];
  let minId = null;
  let maxId = null;

  for (let page = 0; page < pages; page += 1) {
    const result = await fetchPage(channel.username, { before: cursor });
    stats.pages += 1;

    const posts = [];
    for (const post of result.posts) {
      // Nothing to sell and nothing to show: service messages, stickers, polls.
      if (!post.photos.length && !post.text) { stats.skipped += 1; continue; }
      posts.push(post);
      seen.push(post.messageId);
      if (minId === null || post.messageId < minId) minId = post.messageId;
      if (maxId === null || post.messageId > maxId) maxId = post.messageId;
    }
    stats.scanned += posts.length;

    // Deduplicate within the statement: ON CONFLICT DO UPDATE cannot touch the
    // same row twice in one command, and a page can repeat an album's id.
    const byId = new Map(posts.map((p) => [p.messageId, p]));
    const batch = await upsertBatch([...byId.values()].map((p) => rowFor(channel, p)));
    stats.added += batch.added;
    stats.updated += batch.updated;

    if (!result.before) {
      // The first post of the channel. There is nothing older to read.
      stats.historyDone = true;
      cursor = null;
      break;
    }
    cursor = result.before;
    if (page < pages - 1) await sleep(PAGE_DELAY_MS);
  }

  // Deletions, scoped to the window actually read — see the header and
  // `startedAt` above.
  //
  // `source = 'channel'` keeps the app's own publications out of it. Those are
  // the app's records: in live mode the post is in the channel and this pass sees
  // it anyway, and in demo mode it was never sent, so retiring it would only be
  // confusing.
  if (minId !== null) {
    const clauses = ["channel = ?", "status = 'published'", "source = 'channel'", 'tg_message_id >= ?'];
    const params = [channel.key, minId];
    if (startedAt !== null) {
      clauses.push('tg_message_id < ?');
      params.push(startedAt);
    }
    const gone = await db.prepare(`
      UPDATE posts SET status = 'gone', edited_at = now()
       WHERE ${clauses.join(' AND ')} AND tg_message_id <> ALL(?::bigint[])`)
      .run(...params, seen);
    stats.gone = gone.changes;
  }

  stats.cursor = cursor;
  // A shallow sync is one pass and it is finished; a deep one is finished when
  // it has walked back to the beginning.
  stats.done = deep ? (cursor === null || stats.historyDone) : true;
  // What the pass can speak about: from the oldest post it saw up to where it
  // started reading (the newest end of the channel when it started at the top).
  stats.range = minId === null ? null : { from: minId, to: startedAt === null ? null : startedAt - 1, seenTo: maxId };

  await db.prepare(`UPDATE channels SET synced_at = now(),
      sync_cursor = ?, history_done = ? WHERE key = ?`)
    .run(deep ? cursor : (channel.sync_cursor ?? null), stats.historyDone, channel.key);

  const totals = await db.prepare(`SELECT
      count(*) FILTER (WHERE status = 'published') published,
      count(*) FILTER (WHERE status = 'gone')      gone,
      count(*) FILTER (WHERE status = 'hidden')    hidden
    FROM posts WHERE channel = ?`).get(channel.key);

  return {
    ...stats,
    total: Number(totals.published),
    totalGone: Number(totals.gone),
    totalHidden: Number(totals.hidden),
  };
}
