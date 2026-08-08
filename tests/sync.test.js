// «Синхронізувати» — the reconcile pass.
//
// Every case here is a way the naive version ("delete the channel's posts, then
// import them again") loses something: a client's fitting room, a human's
// correction, a card the admin deliberately hid, or a post that is merely older
// than the pages this pass happened to read.
//
// The channel is faked at the fetch boundary, so the SQL under test — the
// multi-row upsert with its per-column CASE, and the scoped 'gone' update — is
// the same SQL production runs.
import './helpers/tmpdb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { migrate, db } from '../server/db.js';
import { syncChannel, windowStart } from '../server/sync.js';

await migrate();

await db.exec(`
  INSERT INTO channels (key,username,title,emoji,kind,enabled,created_at)
  VALUES ('bags','w2b_luxury_bags','Сумки жіночі','👜','catalog',true,now())
  ON CONFLICT (key) DO NOTHING;
`);

const channel = async () => await db.prepare("SELECT * FROM channels WHERE key='bags'").get();

// A page as tme.js hands it over: newest last, `before` is the cursor for the
// older page, null on the channel's first page.
const page = (posts, before = null) => ({ posts, before, title: 'Сумки жіночі' });
const post = (messageId, text, photos = ['https://cdn/x.jpg'], date = '2026-08-01T10:00:00Z') =>
  ({ messageId, text, photos, date, kind: 'photo', forwarded: false, albumSize: photos.length });

// Serves prepared pages instead of the network, and records what was asked for.
function serve(pages) {
  const calls = [];
  return {
    calls,
    fetchPage: async (username, { before = null } = {}) => {
      calls.push(before);
      const next = pages.shift();
      if (!next) throw new Error('запитали більше сторінок, ніж підготовлено');
      return next;
    },
  };
}

const posts = async () => await db.prepare("SELECT * FROM posts WHERE channel='bags' ORDER BY tg_message_id").all();
const byMsg = async (id) => db.prepare('SELECT * FROM posts WHERE channel=? AND tg_message_id=?').get('bags', id);

test('a first sync brings the channel in, and reports what it did', async () => {
  const served = serve([page([post(101, 'Chanel Classic Flap'), post(102, 'Balenciaga')], null)]);
  {
    const r = await syncChannel(await channel(), { pages: 4, fetchPage: served.fetchPage });
    assert.equal(r.added, 2);
    assert.equal(r.updated, 0);
    assert.equal(r.gone, 0);
    assert.equal(r.scanned, 2);
    assert.deepEqual(r.range, { from: 101, to: null, seenTo: 102 },
      'read from the top, so it can speak about everything newer than 101');
    assert.equal(r.total, 2);
    // The channel's first page was reached, so there is no history left to walk.
    assert.equal(r.historyDone, true);
  }

  assert.equal((await byMsg(101)).title, 'Chanel · сумка');
  assert.ok((await channel()).synced_at, 'the sync time is recorded for the admin office');
});

test('a second sync updates rather than duplicates', async () => {
  const served = serve([page([post(101, 'Chanel Classic Flap — знижка'), post(102, 'Balenciaga')], null)]);
  {
    const r = await syncChannel(await channel(), { pages: 4, fetchPage: served.fetchPage });
    assert.equal(r.added, 0, 'nothing is new');
    assert.equal(r.updated, 2);
  }

  assert.equal((await posts()).length, 2, 'still two cards, not four');
  assert.match((await byMsg(101)).body, /знижка/, 'the edited caption arrived');
});

test('a post deleted in the channel becomes gone, and its links survive', async () => {
  // A client has 102 in her fitting room and the demand journal records it.
  const customer = await db.prepare(`INSERT INTO customers (tg_user_id,name,created_at)
    VALUES ('900','Олена',now())`).run();
  const p102 = await byMsg(102);
  await db.prepare(`INSERT INTO cart_items (customer_id,post_id,title,channel,status,created_at)
    VALUES (?,?,?,'bags','active',now())`).run(customer.lastInsertRowid, p102.id, 'Balenciaga');
  await db.prepare(`INSERT INTO cart_events (customer_id,post_id,action,title,channel,created_at,ym,y)
    VALUES (?,?,'added','Balenciaga','bags',now(),'2026-08','2026')`)
    .run(customer.lastInsertRowid, p102.id);

  const served = serve([page([post(101, 'Chanel Classic Flap')], null)]); // 102 is gone
  {
    const r = await syncChannel(await channel(), { pages: 4, fetchPage: served.fetchPage });
    assert.equal(r.gone, 1);
    assert.equal(r.total, 1, 'one card left in the vitrine');
  }

  assert.equal((await byMsg(102)).status, 'gone');
  // The row still exists, so nothing that pointed at it was unhooked. This is
  // the whole reason the sync does not delete.
  const item = await db.prepare('SELECT * FROM cart_items WHERE post_id=?').get(p102.id);
  assert.ok(item, 'the fitting room still points at the card');
  const event = await db.prepare('SELECT * FROM cart_events WHERE post_id=?').get(p102.id);
  assert.ok(event, 'the demand journal keeps its link, so popularity still counts');
});

test('a post that comes back is published again', async () => {
  const served = serve([page([post(101, 'Chanel Classic Flap'), post(102, 'Balenciaga')], null)]);
  {
    const r = await syncChannel(await channel(), { pages: 4, fetchPage: served.fetchPage });
    assert.equal(r.updated, 2);
  }
  assert.equal((await byMsg(102)).status, 'published');
});

test('a card hidden by hand stays hidden, however often the channel is synced', async () => {
  await db.prepare("UPDATE posts SET status='hidden' WHERE channel='bags' AND tg_message_id=101").run();

  const served = serve([page([post(101, 'Chanel Classic Flap'), post(102, 'Balenciaga')], null)]);
  await syncChannel(await channel(), { pages: 4, fetchPage: served.fetchPage });

  assert.equal((await byMsg(101)).status, 'hidden', 'the channel does not overrule a human');
});

test('a corrected title survives the sync; the channel still supplies the facts', async () => {
  await db.prepare(`UPDATE posts SET title='Chanel Classic Flap Medium 25', brand='Chanel',
      category='сумка', curated=true WHERE channel='bags' AND tg_message_id=102`).run();

  const served = serve([page([post(102, 'Balenciaga\nЦіна $2 300', ['https://cdn/new.jpg'])], null)]);
  await syncChannel(await channel(), { pages: 4, fetchPage: served.fetchPage });

  const row = await byMsg(102);
  assert.equal(row.title, 'Chanel Classic Flap Medium 25', 'the human wins on judgement');
  assert.equal(row.brand, 'Chanel');
  assert.match(row.body, /Balenciaga/, 'but the channel wins on its own text');
  assert.equal(Number(row.price), 2300, 'and on the price');
  assert.deepEqual(row.photos_json, ['https://cdn/new.jpg'], 'and on the photos');
});

test('an older post outside the scanned pages is never mistaken for deleted', async () => {
  // 50 is older than anything this pass reads. A sync that only looked at the
  // newest page must not conclude it is gone.
  await db.prepare(`INSERT INTO posts (channel,tg_message_id,title,body,source,status,created_at)
    VALUES ('bags',50,'Стара позиція','','channel','published',now())`).run();

  const served = serve([page([post(101, 'Chanel'), post(102, 'Balenciaga')], 101)]);
  {
    const r = await syncChannel(await channel(), { pages: 1, fetchPage: served.fetchPage });
    assert.equal(r.gone, 0);
    assert.deepEqual(r.range, { from: 101, to: null, seenTo: 102 });
  }

  assert.equal((await byMsg(50)).status, 'published', 'beyond the range is not missing');
});

test('a deep pass resumes where the last one stopped instead of re-reading the top', async () => {
  // The earlier passes reached this small fixture's first page, so the channel is
  // marked fully walked. Put it back to "there is history behind this", which is
  // the state a real catalogue of thousands of posts is in.
  await db.prepare("UPDATE channels SET history_done=false, sync_cursor=NULL WHERE key='bags'").run();

  const served = serve([
    page([post(80, 'Dior'), post(81, 'Prada')], 80),   // first call: two pages
    page([post(70, 'Gucci')], 70),
  ]);
  {
    const r = await syncChannel(await channel(), { deep: true, pages: 2, fetchPage: served.fetchPage });
    assert.equal(r.done, false, 'there is more history behind this');
    assert.equal(r.cursor, 70);
  }
  assert.equal(Number((await channel()).sync_cursor), 70, 'the resume point is persisted');

  const next = serve([page([post(60, 'Fendi')], null)]);
  {
    const r = await syncChannel(await channel(), { deep: true, pages: 2, fetchPage: next.fetchPage });
    assert.deepEqual(next.calls, [70], 'it continued from the stored cursor');
    assert.equal(r.done, true);
    assert.equal(r.historyDone, true);
  }

  assert.equal((await channel()).sync_cursor, null, 'nothing left to resume');
  assert.equal((await channel()).history_done, true);
});

test('a channel without a @username is refused with a reason', async () => {
  await db.prepare(`INSERT INTO channels (key,username,title,kind,enabled,created_at)
    VALUES ('private',NULL,'Приватний','catalog',true,now())`).run();
  const row = await db.prepare("SELECT * FROM channels WHERE key='private'").get();
  await assert.rejects(() => syncChannel(row), /@username/);
});

test('a page of stickers and service messages syncs to nothing, not to an error', async () => {
  const served = serve([page([
    { messageId: 200, text: '', photos: [], date: '2026-08-01T10:00:00Z', kind: 'text', albumSize: 0 },
  ], null)]);
  {
    const r = await syncChannel(await channel(), { pages: 1, fetchPage: served.fetchPage });
    assert.equal(r.scanned, 0);
    assert.equal(r.skipped, 1);
    assert.equal(r.added, 0);
    assert.equal(r.gone, 0, 'an empty page must not wipe the catalogue');
  }
});

// ── the six-month window ──────────────────────────────────────────────────
//
// The catalogue keeps a recent slice, not an archive. A bag posted a year ago is
// almost certainly sold, and a vitrine full of positions nobody can buy costs a
// client a message to Dasha and an answer of "це вже продано".

const MONTH = 30 * 24 * 3600 * 1000;
const NOW = Date.parse('2026-08-08T12:00:00Z');
const ago = (months) => new Date(NOW - months * MONTH).toISOString();
const since = NOW - 6 * MONTH;

test('a post older than the window is never written at all', async () => {
  const served = serve([page([
    post(300, 'Chanel свіжа', ['https://cdn/a.jpg'], ago(1)),
    post(301, 'Dior торішня', ['https://cdn/b.jpg'], ago(9)),
  ], 299)]);
  const r = await syncChannel(await channel(), { pages: 1, since, fetchPage: served.fetchPage });

  assert.equal(r.added, 1, 'only the fresh one');
  assert.equal(r.tooOld, 1);
  assert.ok(await byMsg(300));
  assert.equal(await byMsg(301), undefined, 'the old one is not stored, not even hidden');
});

test('a page entirely outside the window ends the walk', async () => {
  const served = serve([
    page([post(310, 'Свіжа', ['https://cdn/c.jpg'], ago(2))], 309),
    page([post(305, 'Стара', ['https://cdn/d.jpg'], ago(8)),
          post(306, 'Теж стара', ['https://cdn/e.jpg'], ago(10))], 304),
    // A third page exists, and must never be asked for.
  ]);
  const r = await syncChannel(await channel(), { deep: true, pages: 5, since, fetchPage: served.fetchPage });

  assert.deepEqual(served.calls.length, 2, 'stopped at the window edge, did not read on');
  assert.equal(r.reachedWindowEdge, true);
  assert.equal(r.historyDone, true, 'under a window there is nothing left to fetch');
  assert.equal(r.cursor, null);
});

test('the window is a setting, and turning it off keeps everything', async () => {
  const served = serve([page([post(320, 'Дуже стара', ['https://cdn/f.jpg'], ago(24))], null)]);
  const r = await syncChannel(await channel(), { pages: 1, since: null, fetchPage: served.fetchPage });
  assert.equal(r.added, 1, 'since=null reads the lot');
  assert.equal(r.tooOld, 0);
});

test('windowStart counts calendar months back, and 0 means no window', () => {
  const at = Date.parse('2026-08-08T00:00:00Z');
  assert.equal(new Date(windowStart(at, 6)).toISOString().slice(0, 10), '2026-02-08');
  assert.equal(windowStart(at, 0), null);
});

test('what falls out of the window is retired — and deleted only when nothing points at it', async () => {
  // Two old cards. One is in a client's fitting room, one is not.
  await db.prepare(`INSERT INTO posts (channel,tg_message_id,title,body,source,status,created_at)
    VALUES ('bags',400,'Стара без посилань','','channel','published',?),
           ('bags',401,'Стара в примірочній','','channel','published',?)`)
    .run(ago(10), ago(10));
  const wanted = await byMsg(401);
  const customer = await db.prepare("SELECT id FROM customers LIMIT 1").get();
  await db.prepare(`INSERT INTO cart_events (customer_id,post_id,action,title,channel,created_at,ym,y)
    VALUES (?,?,'added','Стара','bags',now(),'2026-02','2026')`).run(customer.id, wanted.id);

  const served = serve([page([post(410, 'Свіжа', ['https://cdn/g.jpg'], ago(1))], null)]);
  const r = await syncChannel(await channel(), { pages: 1, since, fetchPage: served.fetchPage });

  // The count also covers post 320 from the case above, which is two years old
  // and equally outside the window — the rule is about age, not about this test.
  assert.ok(r.deleted >= 1, 'unreferenced old cards are gone from the table');
  assert.equal(await byMsg(400), undefined, 'this one had nothing pointing at it');
  assert.equal(await byMsg(320), undefined, 'and neither did the two-year-old one');

  const kept = await byMsg(401);
  assert.ok(kept, 'the referenced one keeps its row');
  assert.equal(kept.status, 'gone', 'but leaves the vitrine');
  const link = await db.prepare('SELECT * FROM cart_events WHERE post_id=?').get(wanted.id);
  assert.ok(link, 'and the client’s selection still points at something');
});
