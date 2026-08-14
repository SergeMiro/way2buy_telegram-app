// ─────────────────────────────────────────────────────────────────────────
//  loyalty.js — the cashback engine.
//
//  RULE (Maryna, 31.07.2026 — supersedes the earlier "$3000 cumulative"):
//    "$2000 — это одна покупка"  → a SINGLE order of $2000 or more earns $100.
//    "аккумулировать максимум до $300" → the unspent bonus balance is capped
//    at $300; once a client is at the ceiling, further orders earn nothing
//    until part of the balance is spent.
//
//  Both numbers, and whether the bonus is a dollar amount or a percentage,
//  are read from the `cashback` row in `discount_rules` — the admin can change
//  them without a deploy. Nothing here hardcodes 2000/100/300.
//
//  Tiers/badges/streak are kept for the admin view but are hidden from the
//  client UI (features.tiers = off): Maryna's audience needs two bonuses and
//  nothing else on screen.
// ─────────────────────────────────────────────────────────────────────────
import { db } from './db.js';
import { getRule, computeDiscount } from './rules.js';

// Fallback used only if the rules table has not been seeded yet (fresh file,
// migrate() not yet run). Mirrors the defaults written by db.js.
const FALLBACK_CASHBACK = {
  key: 'cashback', kind: 'cashback', enabled: 1,
  mode: 'fixed', value: 100, min_order_usd: 2000, cap_usd: 300,
};

export async function cashbackRule() {
  try {
    return await getRule('cashback') || FALLBACK_CASHBACK;
  } catch {
    return FALLBACK_CASHBACK;
  }
}

export const TIERS = [
  { key: 'silver',   name: 'Silver',   min: 0,     perk: 'Кешбек за кожну велику покупку' },
  { key: 'gold',     name: 'Gold',     min: 3000,  perk: '+ пріоритетний викуп та знижка на доставку' },
  { key: 'platinum', name: 'Platinum', min: 10000, perk: '+ персональний менеджер' },
];

const TIER_EMOJI = { silver: '🥈', gold: '🥇', platinum: '💎' };

export function tierFor(totalUsd) {
  let t = TIERS[0];
  for (const tier of TIERS) if (totalUsd >= tier.min) t = tier;
  return t;
}

// ── Pure helpers (no DB access — unit-testable in isolation) ───────────────

const round2 = (n) => Math.round(n * 100) / 100;
const ymKey = (year, month0) => `${year}-${String(month0 + 1).padStart(2, '0')}`;

// Consecutive-month purchase streak ending at the current month (UTC).
export function streakFrom(months, now = Date.now()) {
  const set = months instanceof Set ? months : new Set(months || []);
  const d = new Date(now);
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth();
  let count = 0;
  while (set.has(ymKey(y, m))) {
    count += 1;
    m -= 1;
    if (m < 0) { m = 11; y -= 1; }
  }
  return count;
}

export function badgesFor(totalSpent, purchaseCount, qualifyingCount) {
  const badges = [
    { key: 'first_purchase', name: 'Перша покупка', emoji: '🛍️', earned: purchaseCount >= 1 },
    { key: 'buyer_5',        name: '5 покупок',     emoji: '🏅', earned: purchaseCount >= 5 },
    { key: 'buyer_10',       name: '10 покупок',    emoji: '🎖️', earned: purchaseCount >= 10 },
  ];
  for (const t of TIERS) {
    badges.push({
      key: `tier_${t.key}`,
      name: t.name,
      emoji: TIER_EMOJI[t.key] || '⭐',
      earned: totalSpent >= t.min,
    });
  }
  badges.push({ key: 'cashback_unlocked', name: 'Кешбек розблоковано', emoji: '💰', earned: qualifyingCount >= 1 });
  return badges;
}

// ── The cashback calculation ──────────────────────────────────────────────
//
//  earned    — one payout per QUALIFYING order (single order ≥ minOrderUsd).
//              Fixed rule → value per order. Percent rule → value% of each
//              qualifying order, so the $/% toggle works here too.
//  available — min(earned − redeemed, cap). The cap is on the *unspent*
//              balance, which is exactly what Maryna asked for: a client
//              cannot sit on $500 of bonuses waiting to use them.
export function computeCashback(agg, rule = FALLBACK_CASHBACK) {
  const qualifyingCount = agg?.qualifyingCount || 0;
  const qualifyingSum = agg?.qualifyingSum || 0;
  const redeemed = round2(agg?.redeemedRaw || 0);
  const enabled = Boolean(rule.enabled);
  const cap = rule.cap_usd === null || rule.cap_usd === undefined ? null : Number(rule.cap_usd);

  let earned = 0;
  if (enabled) {
    earned = rule.mode === 'percent'
      ? round2((qualifyingSum * Number(rule.value)) / 100)
      : round2(qualifyingCount * Number(rule.value));
  }

  const uncapped = round2(Math.max(earned - redeemed, 0));
  const available = cap === null ? uncapped : round2(Math.min(uncapped, cap));
  // What the client forfeits by sitting on the balance instead of spending it.
  const withheld = round2(Math.max(uncapped - available, 0));

  return {
    enabled,
    mode: rule.mode,
    value: Number(rule.value),
    minOrderUsd: Number(rule.min_order_usd ?? 0),
    capUsd: cap,
    qualifyingPurchases: qualifyingCount,
    cashbackEarned: earned,
    cashbackRedeemed: redeemed,
    cashbackAvailable: available,
    cashbackWithheld: withheld,
    capReached: cap !== null && available >= cap,
    capHeadroomUsd: cap === null ? null : round2(Math.max(cap - available, 0)),
    progressPct: cap ? Math.min(100, Math.round((available / cap) * 100)) : 0,
  };
}

// Full snapshot: cashback (what the client sees) + the legacy tier/badge/streak
// block (admin view only).
export function computeSnapshot(agg, now = Date.now(), rule = FALLBACK_CASHBACK) {
  const totalSpent = round2(agg?.spentRaw || 0);
  const purchaseCount = agg?.purchaseCount || 0;
  const months = agg?.monthSet instanceof Set ? agg.monthSet : new Set(agg?.months || []);
  const lastPurchaseAt = agg?.lastPurchaseAt || null;

  const cashback = computeCashback(agg, rule);
  const tier = tierFor(totalSpent);
  const nextTier = TIERS.find((t) => t.min > totalSpent) || null;
  const streakMonths = streakFrom(months, now);

  return {
    totalSpent,
    purchases: purchaseCount,
    ...cashback,
    // How large a single order must be to earn the next bonus. Replaces the old
    // cumulative "toNextReward": with a per-order rule the client needs a big
    // enough ORDER, not a bigger lifetime total.
    nextRewardOrderUsd: cashback.minOrderUsd,
    lastPurchaseAt,
    // ── legacy / admin-only block ──
    tier: tier.key,
    tierName: tier.name,
    tierPerk: tier.perk,
    nextTier: nextTier ? { name: nextTier.name, toGo: round2(nextTier.min - totalSpent) } : null,
    badges: badgesFor(totalSpent, purchaseCount, cashback.qualifyingPurchases),
    streak: { months: streakMonths, active: streakMonths > 0, lastPurchaseAt },
  };
}

// ── DB-backed snapshots ────────────────────────────────────────────────────

export async function loyaltyFor(customerId, now = Date.now()) {
  const id = Number(customerId);
  const batch = await snapshotBatch([id], now);
  return batch[id] || computeSnapshot(null, now, await cashbackRule());
}

// N+1-safe batch snapshot: EXACTLY 2 aggregate queries regardless of how many
// customers are asked for. The qualifying-order counters are computed inside
// the same aggregate via CASE WHEN, so changing the rule threshold does not
// add a query.
export async function snapshotBatch(customerIds, now = Date.now()) {
  const ids = [...new Set((customerIds || []).map(Number).filter((n) => Number.isFinite(n)))];
  const out = {};
  if (ids.length === 0) return out;

  const rule = await cashbackRule();
  const minOrder = Number(rule.min_order_usd ?? 0);
  const placeholders = ids.map(() => '?').join(',');

  const purchaseRows = await db.prepare(
    `SELECT customer_id AS cid,
            to_char(created_at, 'YYYY-MM') AS ym,
            COALESCE(SUM(amount_usd), 0) AS s,
            COUNT(*) AS n,
            SUM(CASE WHEN amount_usd >= ? THEN 1 ELSE 0 END) AS qn,
            COALESCE(SUM(CASE WHEN amount_usd >= ? THEN amount_usd ELSE 0 END), 0) AS qs,
            MAX(created_at) AS last_at
       FROM purchases
      WHERE status = 'confirmed' AND customer_id IN (${placeholders})
      GROUP BY customer_id, ym`
  ).all(minOrder, minOrder, ...ids);

  const redeemRows = await db.prepare(
    `SELECT customer_id AS cid, COALESCE(SUM(amount_usd), 0) AS s
       FROM redemptions
      WHERE customer_id IN (${placeholders})
      GROUP BY customer_id`
  ).all(...ids);

  const agg = new Map();
  for (const id of ids) {
    agg.set(id, {
      spentRaw: 0, purchaseCount: 0, redeemedRaw: 0,
      qualifyingCount: 0, qualifyingSum: 0,
      monthSet: new Set(), lastPurchaseAt: null,
    });
  }
  for (const r of purchaseRows) {
    const a = agg.get(r.cid);
    if (!a) continue;
    a.spentRaw += r.s;
    a.purchaseCount += r.n;
    a.qualifyingCount += r.qn || 0;
    a.qualifyingSum += r.qs || 0;
    if (r.ym) a.monthSet.add(r.ym);
    if (r.last_at && (!a.lastPurchaseAt || r.last_at > a.lastPurchaseAt)) a.lastPurchaseAt = r.last_at;
  }
  for (const r of redeemRows) {
    const a = agg.get(r.cid);
    if (a) a.redeemedRaw += r.s;
  }
  for (const id of ids) out[id] = computeSnapshot(agg.get(id), now, rule);
  return out;
}

// What one specific order earns — used when a purchase is recorded so the admin
// sees the bonus immediately, and by the tests.
// `rule` is resolved in the body rather than as a parameter default: a default
// cannot contain await, and await cashbackRule() is a database read now.
export async function cashbackForOrder(orderUsd, rule = null) {
  return computeDiscount(rule ?? (await cashbackRule()), orderUsd);
}
