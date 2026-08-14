// ─────────────────────────────────────────────────────────────────────────
//  catalog.js — the vitrine query: what the client is looking at, and what is
//  worth offering them as a filter inside it.
//
//  It lives apart from index.js for one reason: /api/feed and /api/facets MUST
//  agree about what "the current selection" means. The moment they disagree the
//  filter row advertises a brand the vitrine will not show, or promises 40
//  positions and delivers 12. One WHERE builder, used by both, makes that class
//  of bug unrepresentable — and being a module rather than a closure inside a
//  route handler, it can be tested without booting Express.
//
//  The catalogues are DATA. Nothing here holds a list of channels, brands or
//  categories: a catalogue added tomorrow is one row in `channels`, its brands
//  are whatever the parser found in its posts, and both surface by themselves.
// ─────────────────────────────────────────────────────────────────────────
import { db } from './db.js';
import { listChannels } from './telegram.js';

// What `?q=` searches. Kept as one constant because `idx_posts_search_trgm` in
// schema.sql indexes this exact expression: a query that words it differently
// gets a table scan instead, silently.
export const SEARCH_EXPR =
  "(coalesce(title,'') || ' ' || coalesce(body,'') || ' ' || coalesce(article,''))";

/** The filters, clamped to what the server will accept. */
export function selectionFrom(query = {}) {
  return {
    channel: query.channel || null,
    kind: query.kind || null,
    // Search runs across ALL catalogues, not just the selected one: a client
    // who types "kelly" wants the bag, not "the bag inside the chip they
    // happened to tap".
    q: String(query.q || '').trim().slice(0, 60),
    brand: String(query.brand || '').trim().slice(0, 40) || null,
    category: String(query.category || '').trim().slice(0, 40) || null,
  };
}

/**
 * The selection as SQL.
 *
 * `skip` leaves one facet out of its own count — the standard trick that keeps
 * a filter row usable. Counting brands with the brand filter applied would
 * report "Chanel 12" and nothing else, so switching brand would be impossible
 * without clearing the filter first.
 *
 * @returns {{text: string, params: Array}|null} null means "an empty selection"
 *   — as opposed to no filter at all, which is what an empty WHERE would mean.
 */
export async function feedWhere(selection = {}, { skip = null } = {}) {
  const { channel, kind, q, brand, category } = selection;
  const where = ["status='published'"];
  const params = [];

  if (channel && channel !== 'all') {
    where.push('channel = ?');
    params.push(channel);
  } else if (kind === 'main' || kind === 'catalog') {
    const keys = (await listChannels()).filter((c) => c.kind === kind).map((c) => c.key);
    if (!keys.length) return null;
    where.push(`channel IN (${keys.map(() => '?').join(',')})`);
    params.push(...keys);
  }

  if (q) {
    // Title, body and article in ONE expression, not three ORed together — and
    // that is a performance decision, not a style one. Postgres can only use
    // indexes for an OR if every branch has one, so `title ILIKE ? OR body
    // ILIKE ? OR article ILIKE ?` falls back to scanning the table and testing
    // each row. Concatenated, it is a single condition that the trigram index in
    // schema.sql answers directly. The index is declared over exactly this
    // expression, so the two must be changed together.
    //
    // ILIKE, not LIKE: SQLite's LIKE ignored case for ASCII and Postgres's does
    // not, so "chanel" stopped matching "Chanel" the day the store moved.
    where.push(`${SEARCH_EXPR} ILIKE ?`);
    params.push(`%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`);
  }

  if (brand && skip !== 'brand') {
    where.push('brand = ?');
    params.push(brand);
  }
  if (category && skip !== 'category') {
    where.push('category = ?');
    params.push(category);
  }

  return { text: where.join(' AND '), params };
}

// Paging is keyset, not OFFSET: the catalogues gain posts while a client
// scrolls, and OFFSET would then show a card twice or skip one. (created_at, id)
// is unique and matches the ORDER BY, so the cursor is exact.
export function parseCursor(raw) {
  const s = String(raw || '');
  const sep = s.lastIndexOf('|');
  if (sep < 1) return null;
  const at = s.slice(0, sep);
  const id = Number(s.slice(sep + 1));
  if (!Number.isInteger(id) || Number.isNaN(Date.parse(at))) return null;
  return { at, id };
}

export const cursorOf = (row) => `${new Date(row.created_at).toISOString()}|${row.id}`;

export const clampLimit = (raw, fallback = 60, max = 200) =>
  Math.min(Math.max(Number(raw) || fallback, 1), max);

/** One page of the vitrine. `nextCursor` is null once the last page is in. */
export async function listPosts(selection, { limit = 60, cursor = null } = {}) {
  const filters = await feedWhere(selection);
  if (!filters) return { rows: [], nextCursor: null };

  const clauses = [filters.text];
  const params = [...filters.params];
  const from = parseCursor(cursor);
  if (from) {
    clauses.push('(created_at, id) < (?::timestamptz, ?::integer)');
    params.push(from.at, from.id);
  }

  const rows = await db.prepare(
    `SELECT * FROM posts WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`
  ).all(...params, limit);

  return {
    rows,
    // Only when the page came back full: a short page is the last one, and
    // offering «Показати ще» that returns nothing is worse than not offering it.
    nextCursor: rows.length === limit ? cursorOf(rows[rows.length - 1]) : null,
  };
}

/**
 * The filter values worth showing for this selection, with counts.
 *
 * Brands and categories are not a fixed list anywhere in the code — they are
 * whatever the parser found in the posts that are actually in the selection. A
 * new catalogue full of Loewe therefore grows a «Loewe» filter by itself, and a
 * catalogue nobody posts to grows nothing.
 */
export async function facetsFor(selection) {
  const [brandWhere, categoryWhere, allWhere] = await Promise.all([
    feedWhere(selection, { skip: 'brand' }),
    feedWhere(selection, { skip: 'category' }),
    feedWhere(selection),
  ]);
  if (!allWhere) return { total: 0, brands: [], categories: [], priceRange: null };

  const facet = async (column, filters) => (await db.prepare(
    `SELECT ${column} value, COUNT(*) count FROM posts
      WHERE ${filters.text} AND ${column} IS NOT NULL
      GROUP BY ${column} ORDER BY count DESC, value ASC LIMIT 40`
  ).all(...filters.params)).map((r) => ({ value: r.value, count: Number(r.count) }));

  const [brands, categories, totals] = await Promise.all([
    facet('brand', brandWhere),
    facet('category', categoryWhere),
    db.prepare(`SELECT COUNT(*) total, MIN(price) min_price, MAX(price) max_price
                FROM posts WHERE ${allWhere.text}`).get(...allWhere.params),
  ]);

  return {
    total: Number(totals.total || 0),
    brands,
    categories,
    priceRange: totals.min_price == null
      ? null
      : { min: Number(totals.min_price), max: Number(totals.max_price) },
  };
}
