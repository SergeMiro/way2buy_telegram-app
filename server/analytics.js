// ─────────────────────────────────────────────────────────────────────────
//  analytics.js — what the fitting room is telling us.
//
//  THE ONE NUMBER THIS FILE EXISTS FOR: a client puts something in the fitting
//  room and then does not ask about it. That gap is the only signal in the shop
//  that says «люди хочуть саме це» while the sale has not happened yet — a
//  purchase tells you what was bought, and an empty catalogue tells you
//  nothing. Everything here is the gap, sliced three ways: over months, per
//  item, and per kind of thing.
//
//  It all reads `cart_events`, the append-only journal that already carries a
//  snapshot of each card at the moment it was touched (title, article, channel,
//  price). That matters: a post edited or deleted in the channel afterwards
//  cannot rewrite last month's numbers. Nothing here writes.
//
//  A note on the storage shape, because it was asked about: the per-customer
//  history is DERIVED from that journal rather than duplicated into two JSON
//  columns on the customer row. Same data, same {yyyyMMdd-HHmm: {…}} shape
//  where it is read (see customerTimeline) — but one copy, so the two cannot
//  drift apart, and it stays indexable. A JSON blob per customer would answer
//  «що додав цей клієнт» and nothing else; the journal also answers «хто додав
//  цю річ», which is the question the stocking advice is built on.
// ─────────────────────────────────────────────────────────────────────────
import { db } from './db.js';

const round = (n, d = 1) => {
  const f = 10 ** d;
  return Math.round(Number(n || 0) * f) / f;
};
const pct = (part, whole) => (whole > 0 ? round((part / whole) * 100) : 0);

// 'YYYY-MM' for the N months ending with the current one, oldest first.
export function monthKeys(count = 6, now = Date.now()) {
  const d = new Date(now);
  const out = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    out.push(`${m.getUTCFullYear()}-${String(m.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

/**
 * The funnel, month by month.
 *
 * `added`   — cards put in the fitting room
 * `sent`    — cards that left it inside an inquiry to the manager
 * `removed` — cards taken back out, which is a different kind of "no"
 * `silent`  — added and never asked about: added − sent − removed, floored at
 *             zero because a card added in one month can be sent in the next
 *             and the two counts are honest about their own month.
 */
export async function monthlyFunnel({ months = 6, now = Date.now() } = {}) {
  const keys = monthKeys(months, now);
  const rows = await db.prepare(
    `SELECT ym, action,
            COUNT(*)                        AS n,
            COUNT(DISTINCT customer_id)     AS people,
            COUNT(DISTINCT COALESCE(article, title)) AS items
       FROM cart_events
      WHERE ym = ANY(?)
      GROUP BY ym, action`
  ).all(keys);

  const byMonth = new Map(keys.map((k) => [k, {
    month: k, added: 0, sent: 0, removed: 0,
    peopleAdded: 0, peopleSent: 0, itemsAdded: 0,
  }]));
  for (const r of rows) {
    const m = byMonth.get(r.ym);
    if (!m) continue;
    const n = Number(r.n) || 0;
    if (r.action === 'added') {
      m.added = n; m.peopleAdded = Number(r.people) || 0; m.itemsAdded = Number(r.items) || 0;
    } else if (r.action === 'sent') {
      m.sent = n; m.peopleSent = Number(r.people) || 0;
    } else if (r.action === 'removed') {
      m.removed = n;
    }
  }

  const list = keys.map((k) => {
    const m = byMonth.get(k);
    const silent = Math.max(0, m.added - m.sent - m.removed);
    return { ...m, silent, sentPct: pct(m.sent, m.added), silentPct: pct(silent, m.added) };
  });

  const totals = list.reduce((a, m) => ({
    added: a.added + m.added, sent: a.sent + m.sent, removed: a.removed + m.removed,
    silent: a.silent + m.silent,
  }), { added: 0, sent: 0, removed: 0, silent: 0 });
  totals.sentPct = pct(totals.sent, totals.added);
  totals.silentPct = pct(totals.silent, totals.added);

  return { months: list, totals };
}

/**
 * Item by item, inside one month: how often it was picked up, how often it was
 * actually asked about, and whether anybody bought it.
 *
 * Grouped by article where there is one and by title otherwise, because the
 * same bag posted twice in two channels is one thing to a client and the point
 * of this table is what to stock, not which post performed.
 */
export async function itemFunnel({ month = null, limit = 30, now = Date.now() } = {}) {
  const ym = month || monthKeys(1, now)[0];
  const rows = await db.prepare(
    `SELECT COALESCE(e.article, e.title)            AS item,
            MAX(e.title)                            AS title,
            MAX(e.article)                          AS article,
            MAX(e.channel)                          AS channel,
            MAX(e.post_id)                          AS post_id,
            MAX(p.brand)                            AS brand,
            MAX(p.category)                         AS category,
            COUNT(*) FILTER (WHERE e.action='added')   AS adds,
            COUNT(*) FILTER (WHERE e.action='sent')    AS sends,
            COUNT(*) FILTER (WHERE e.action='removed') AS removes,
            COUNT(DISTINCT e.customer_id) FILTER (WHERE e.action='added') AS people
       FROM cart_events e
       LEFT JOIN posts p ON p.id = e.post_id
      WHERE e.ym = ?
      GROUP BY COALESCE(e.article, e.title)
      HAVING COUNT(*) FILTER (WHERE e.action='added') > 0
      ORDER BY adds DESC, sends DESC
      LIMIT ?`
  ).all(ym, Math.min(Math.max(Number(limit) || 30, 1), 100));

  return {
    month: ym,
    items: rows.map((r) => {
      const adds = Number(r.adds) || 0;
      const sends = Number(r.sends) || 0;
      return {
        item: r.item, title: r.title, article: r.article, channel: r.channel,
        postId: r.post_id, brand: r.brand, category: r.category,
        adds, sends, removes: Number(r.removes) || 0, people: Number(r.people) || 0,
        silent: Math.max(0, adds - sends - (Number(r.removes) || 0)),
        sentPct: pct(sends, adds),
      };
    }),
  };
}

/**
 * Demand by kind of thing — brand, category or catalogue.
 *
 * This is the table the stocking advice is computed from, and the two columns
 * that matter are next to each other on purpose: `adds` is how much attention
 * something gets, `sentPct` is how much of that attention turns into a question
 * to the manager. High attention with low follow-through is not the same
 * problem as low attention, and stocking more of the second kind is money.
 */
export async function demandBy({ facet = 'brand', months = 3, now = Date.now() } = {}) {
  const column = { brand: 'p.brand', category: 'p.category', channel: 'e.channel' }[facet];
  if (!column) throw new Error(`unknown facet ${facet}`);
  const keys = monthKeys(months, now);

  const rows = await db.prepare(
    `SELECT ${column}                                  AS key,
            COUNT(*) FILTER (WHERE e.action='added')    AS adds,
            COUNT(*) FILTER (WHERE e.action='sent')     AS sends,
            COUNT(DISTINCT e.customer_id)               AS people,
            COUNT(DISTINCT COALESCE(e.article, e.title)) AS items
       FROM cart_events e
       LEFT JOIN posts p ON p.id = e.post_id
      WHERE e.ym = ANY(?) AND ${column} IS NOT NULL AND ${column} <> ''
      GROUP BY ${column}
      ORDER BY adds DESC
      LIMIT 40`
  ).all(keys);

  // What was actually bought of that kind, over the same window. Attribution
  // needs purchases.post_id, which older sales do not have — those simply do
  // not count here rather than being guessed at from a title.
  const boughtRows = facet === 'channel'
    ? await db.prepare(
        `SELECT pu.source_channel AS key, COUNT(*) AS bought
           FROM purchases pu
          WHERE pu.status='confirmed' AND pu.source_channel IS NOT NULL
            AND to_char(pu.created_at, 'YYYY-MM') = ANY(?)
          GROUP BY pu.source_channel`
      ).all(keys)
    : await db.prepare(
        `SELECT p.${facet} AS key, COUNT(*) AS bought
           FROM purchases pu JOIN posts p ON p.id = pu.post_id
          WHERE pu.status='confirmed' AND p.${facet} IS NOT NULL
            AND to_char(pu.created_at, 'YYYY-MM') = ANY(?)
          GROUP BY p.${facet}`
      ).all(keys);
  const bought = new Map(boughtRows.map((r) => [r.key, Number(r.bought) || 0]));

  return {
    facet,
    months: keys,
    rows: rows.map((r) => {
      const adds = Number(r.adds) || 0;
      const sends = Number(r.sends) || 0;
      return {
        key: r.key,
        adds, sends,
        people: Number(r.people) || 0,
        items: Number(r.items) || 0,
        bought: bought.get(r.key) || 0,
        sentPct: pct(sends, adds),
        // Attention per distinct card: two adds on one bag is a different
        // signal from two adds across two bags, and the second is the one that
        // says "this whole shelf works".
        addsPerItem: r.items ? round(adds / Number(r.items), 2) : 0,
      };
    }),
  };
}

/**
 * The monthly advice: what to put more of in the catalogue.
 *
 * Deliberately a short list of plain sentences rather than a dashboard. Three
 * kinds of finding, and the middle one is the one nobody looks for:
 *
 *   stock    — plenty of attention AND people follow through. Add more.
 *   check    — plenty of attention and almost nobody asks. The interest is
 *              real, so the thing standing in the way is the price, the
 *              availability or the photograph — worth a look, not more stock.
 *   quiet    — the shelf nobody touches, offered so it can be cut.
 *
 * The thresholds are stated, not hidden: a facet needs at least MIN_ADDS in the
 * window to be spoken about at all, because three adds on one bag is noise and
 * advice built on noise is worse than silence.
 */
const MIN_ADDS = 5;

export async function advice({ months = 3, now = Date.now() } = {}) {
  const out = { window: monthKeys(months, now), minAdds: MIN_ADDS, findings: [] };

  for (const facet of ['category', 'brand']) {
    const { rows } = await demandBy({ facet, months, now });
    const loud = rows.filter((r) => r.adds >= MIN_ADDS);
    if (!loud.length) continue;

    const avgSent = loud.reduce((a, r) => a + r.sentPct, 0) / loud.length;
    const label = facet === 'brand' ? 'бренд' : 'категорія';

    for (const r of loud.slice(0, 12)) {
      if (r.sentPct >= avgSent && r.adds >= MIN_ADDS * 2) {
        out.findings.push({
          kind: 'stock', facet, key: r.key,
          text: `${label} «${r.key}»: ${r.adds} додавань, ${r.sentPct}% доходять до заявки — ` +
                `це вище середнього (${round(avgSent)}%). Варто додати більше позицій.`,
          adds: r.adds, sentPct: r.sentPct,
        });
      } else if (r.sentPct <= avgSent / 2) {
        out.findings.push({
          kind: 'check', facet, key: r.key,
          text: `${label} «${r.key}»: беруть у примірочну ${r.adds} разів, але лише ${r.sentPct}% ` +
                `питають про них. Інтерес є — заважає щось інше: ціна, наявність або фото.`,
          adds: r.adds, sentPct: r.sentPct,
        });
      }
    }
    const quiet = rows.filter((r) => r.adds > 0 && r.adds < MIN_ADDS && r.items >= 3);
    if (quiet.length) {
      out.findings.push({
        kind: 'quiet', facet, key: null,
        text: `Майже не чіпають: ${quiet.slice(0, 5).map((r) => `«${r.key}»`).join(', ')}. ` +
              `Позицій там вистачає, уваги немає — місце в каталозі можна віддати іншому.`,
      });
    }
  }

  return out;
}

/**
 * One customer's own history, in the shape it was asked for:
 *   { added:  { 'yyyyMMdd-HHmm': { item… } },
 *     bought: { 'yyyyMMdd-HHmm': { item… } } }
 *
 * `postId` travels with every entry so the card can be found in the channel
 * again months later, which is the whole reason for keeping it.
 */
const stamp = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '00000000-0000';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
};

export async function customerTimeline(customerId, { limit = 300 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 300, 1), 1000);
  const events = await db.prepare(
    `SELECT action, title, article, channel, post_id, inquiry_id, created_at
       FROM cart_events WHERE customer_id = ? ORDER BY created_at DESC LIMIT ?`
  ).all(customerId, lim);
  const buys = await db.prepare(
    `SELECT title, article, post_id, source_channel, amount_usd, created_at
       FROM purchases WHERE customer_id = ? AND status='confirmed'
      ORDER BY created_at DESC LIMIT ?`
  ).all(customerId, lim);

  const added = {};
  const asked = {};
  for (const e of events) {
    const entry = {
      item: e.article || e.title, title: e.title, article: e.article,
      channel: e.channel, postId: e.post_id,
    };
    if (e.action === 'added') added[stamp(e.created_at)] = entry;
    if (e.action === 'sent') asked[stamp(e.created_at)] = { ...entry, inquiryId: e.inquiry_id };
  }

  const bought = {};
  for (const b of buys) {
    bought[stamp(b.created_at)] = {
      item: b.article || b.title, title: b.title, article: b.article,
      channel: b.source_channel, postId: b.post_id, amountUsd: Number(b.amount_usd) || 0,
    };
  }

  return { added, asked, bought };
}
