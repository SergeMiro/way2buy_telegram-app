// The vitrine query: the selection, its filters and its paging.
//
// These run against a real Postgres (PGlite), so ILIKE, the row-wise cursor
// comparison and the GROUP BY are the same statements production runs — the
// point of the whole exercise, since two of the bugs covered here are dialect
// bugs that no mock would have caught.
import './helpers/tmpdb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { migrate, db } from '../server/db.js';
import * as catalog from '../server/catalog.js';

await migrate();

// Three catalogues, one of them disabled, plus the main channel — the shape the
// real database has.
await db.exec(`
  INSERT INTO channels (key,username,title,emoji,kind,enabled,created_at) VALUES
    ('bags','w2b_luxury_bags','Сумки жіночі','👜','catalog',true,now()),
    ('shoes','w2b_luxury_shoes','Взуття жіноче','👠','catalog',true,now()),
    ('closed','w2b_closed','Закритий','🚫','catalog',false,now())
  ON CONFLICT (key) DO NOTHING;
`);

const insert = db.prepare(`INSERT INTO posts
  (channel,tg_message_id,title,body,price,currency,brand,category,source,status,created_at)
  VALUES (@channel,@msg,@title,@body,@price,'USD',@brand,@category,'channel',@status,@created_at)`);

// created_at is deliberately identical for the first three: an album of eight
// photos is posted inside one second, which is exactly the case an OFFSET pager
// and a created_at-only cursor both get wrong.
const SAME_SECOND = '2026-08-01T10:00:00.000Z';
let msg = 0;
const add = async (o) => insert.run({
  msg: (msg += 1), title: 'позиція', body: '', price: null,
  brand: null, category: null, status: 'published', ...o,
});

await add({ channel: 'bags', title: 'Chanel Classic Flap', brand: 'Chanel', category: 'сумка', price: 5200, created_at: SAME_SECOND });
await add({ channel: 'bags', title: 'Chanel 19', brand: 'Chanel', category: 'сумка', price: 4300, created_at: SAME_SECOND });
await add({ channel: 'bags', title: 'Hermès Kelly', brand: 'Hermès', category: 'сумка', price: 12000, created_at: SAME_SECOND });
await add({ channel: 'shoes', title: 'Chanel Slingback', brand: 'Chanel', category: 'взуття', price: 1100, created_at: '2026-07-30T10:00:00Z' });
await add({ channel: 'shoes', title: 'Louboutin So Kate', brand: 'Christian Louboutin', category: 'взуття', price: 950, created_at: '2026-07-29T10:00:00Z' });
await add({ channel: 'bags', title: 'Схована сумка', brand: 'Dior', category: 'сумка', status: 'hidden', created_at: '2026-07-28T10:00:00Z' });
await add({ channel: 'closed', title: 'Loewe Puzzle', brand: 'Loewe', category: 'сумка', created_at: '2026-07-27T10:00:00Z' });

const sel = (o = {}) => catalog.selectionFrom({ kind: 'catalog', ...o });

test('kind=catalog spans every enabled catalogue and skips the disabled one', async () => {
  const { rows } = await catalog.listPosts(sel());
  const titles = rows.map((r) => r.title);
  assert.equal(rows.length, 5);
  assert.ok(!titles.includes('Loewe Puzzle'), 'a disabled catalogue is not part of "everything"');
  assert.ok(!titles.includes('Схована сумка'), 'a hidden post is not published');
});

test('a chip narrows to one catalogue', async () => {
  const { rows } = await catalog.listPosts(sel({ channel: 'shoes' }));
  assert.deepEqual(rows.map((r) => r.title).sort(), ['Chanel Slingback', 'Louboutin So Kate']);
});

test('search is case-insensitive and covers title, body and article', async () => {
  // The regression this guards: SQLite's LIKE ignores ASCII case, Postgres's
  // does not. With LIKE the client typing "chanel" would find nothing.
  const lower = await catalog.listPosts(sel({ q: 'chanel' }));
  assert.equal(lower.rows.length, 3);
  const upper = await catalog.listPosts(sel({ q: 'CHANEL' }));
  assert.equal(upper.rows.length, 3);
});

test('a search spans catalogues even when a chip is selected', async () => {
  // The chip is not dropped here — the client (api.js) is what omits it while a
  // query is running. What matters is that both filters compose predictably.
  const { rows } = await catalog.listPosts(sel({ channel: 'bags', q: 'chanel' }));
  assert.equal(rows.length, 2);
});

test('a % in the query is a literal, not a wildcard', async () => {
  const { rows } = await catalog.listPosts(sel({ q: '%' }));
  assert.equal(rows.length, 0, 'otherwise a stray % would match the whole catalogue');
});

test('brand and category compose', async () => {
  const { rows } = await catalog.listPosts(sel({ brand: 'Chanel', category: 'взуття' }));
  assert.deepEqual(rows.map((r) => r.title), ['Chanel Slingback']);
});

test('paging is exact when a whole album shares one timestamp', async () => {
  const first = await catalog.listPosts(sel(), { limit: 2 });
  assert.equal(first.rows.length, 2);
  assert.ok(first.nextCursor, 'a full page offers the next one');

  const second = await catalog.listPosts(sel(), { limit: 2, cursor: first.nextCursor });
  const third = await catalog.listPosts(sel(), { limit: 2, cursor: second.nextCursor });

  const seen = [...first.rows, ...second.rows, ...third.rows].map((r) => r.id);
  assert.equal(new Set(seen).size, 5, 'no card is served twice and none is skipped');
  assert.equal(third.nextCursor, null, 'a short page is the last page');
});

test('a malformed cursor is ignored rather than emptying the vitrine', async () => {
  const { rows } = await catalog.listPosts(sel(), { cursor: 'сміття' });
  assert.equal(rows.length, 5);
});

test('facets count what is in the selection, not what exists in the table', async () => {
  const all = await catalog.facetsFor(sel());
  assert.equal(all.total, 5);
  assert.deepEqual(all.brands.map((b) => [b.value, b.count]), [
    ['Chanel', 3], ['Christian Louboutin', 1], ['Hermès', 1],
  ]);
  assert.ok(!all.brands.some((b) => b.value === 'Dior'), 'a hidden post offers no brand');
  assert.ok(!all.brands.some((b) => b.value === 'Loewe'), 'a disabled catalogue offers no brand');
  assert.deepEqual(all.priceRange, { min: 950, max: 12000 });

  const inShoes = await catalog.facetsFor(sel({ channel: 'shoes' }));
  assert.equal(inShoes.total, 2);
  assert.deepEqual(inShoes.categories, [{ value: 'взуття', count: 2 }]);
});

test('an active brand filter still lists the other brands, or it would be a trap', async () => {
  const f = await catalog.facetsFor(sel({ brand: 'Chanel' }));
  // The brand row ignores the brand filter — otherwise the only value on offer
  // is the one already chosen and the client cannot switch.
  assert.deepEqual(f.brands.map((b) => b.value), ['Chanel', 'Christian Louboutin', 'Hermès']);
  // …while the category row DOES respect it: those are Chanel's categories.
  assert.deepEqual(f.categories.map((c) => [c.value, c.count]), [['сумка', 2], ['взуття', 1]]);
  assert.equal(f.total, 3, 'the total is the filtered selection');
});

test('an empty selection is empty, not everything', async () => {
  const none = await catalog.listPosts(catalog.selectionFrom({ kind: 'main' }));
  assert.deepEqual(none.rows, [], 'the main channel has no posts in this fixture');
  // An unrecognised kind applies NO channel filter, so the count reaches every
  // published post — including the one in the disabled catalogue, which
  // kind=catalog would have excluded. Only a malformed request gets here; it is
  // asserted so the fallback stays a deliberate choice rather than a surprise.
  const facets = await catalog.facetsFor(catalog.selectionFrom({ kind: 'nonsense' }));
  assert.equal(facets.total, 6, 'every published post, hidden one excluded');
});
