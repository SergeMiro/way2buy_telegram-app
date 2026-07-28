// ─────────────────────────────────────────────────────────────────────────
//  loyalty.js — the cashback + gamification engine.
//
//  Rule (Maryna's spec): "Every $3000 a customer spends with us → $100 back."
//  No time limit — lifetime cumulative. Tiers add retention perks on top.
//
//  Step 3 (Way2Buy discounts pillar) adds a gamification snapshot on top of the
//  cashback engine — milestones reached, next milestone, tier/purchase badges,
//  and a simple purchase streak — plus an N+1-safe `snapshotBatch()` that
//  computes the same shape for many customers in exactly 2 aggregate queries.
//
//  ── Definitions (documented per the Step 3 brief) ────────────────────────
//  • milestones   : the $STEP cashback thresholds the customer has crossed.
//                   milestoneCount = floor(totalSpent / STEP); one entry per
//                   crossed threshold ({ index, thresholdUsd, reward }).
//  • nextMilestone: an *enrichment* of the existing `toNextReward` — the next
//                   uncrossed threshold + the USD remaining to reach it
//                   (remainingUsd === toNextReward, not a second calculation).
//  • badges       : purely derived, data-driven flags (earned bool) from
//                   purchase count + spend tier + milestone count. No
//                   per-customer hardcoding.
//  • streak       : number of *consecutive* calendar months, counting backward
//                   from the current month (per an injectable `now`, UTC), in
//                   which the customer made ≥1 confirmed purchase. Breaks at the
//                   first month with no purchase. `active` = purchased this month.
// ─────────────────────────────────────────────────────────────────────────
import { db } from './db.js';

const STEP = Number(process.env.CASHBACK_STEP_USD || 3000);
const REWARD = Number(process.env.CASHBACK_REWARD_USD || 100);

export const TIERS = [
  { key: 'silver',   name: 'Silver',   min: 0,     perk: 'Кешбек $100 за кожні $3000' },
  { key: 'gold',     name: 'Gold',     min: 3000,  perk: '+ пріоритетний викуп та знижка на доставку' },
  { key: 'platinum', name: 'Platinum', min: 10000, perk: '+ персональний менеджер та -15% промокоди' },
];

const TIER_EMOJI = { silver: '🥈', gold: '🥇', platinum: '💎' };

export function tierFor(totalUsd) {
  let t = TIERS[0];
  for (const tier of TIERS) if (totalUsd >= tier.min) t = tier;
  return t;
}

// ── Pure helpers (no DB access — unit-testable in isolation) ───────────────

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

// Data-driven badge catalogue. Every badge is always present with an `earned`
// flag so the UI can render locked/unlocked states; no per-customer logic.
export function badgesFor(totalSpent, purchaseCount, milestoneCount) {
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
  badges.push({ key: 'cashback_unlocked', name: 'Кешбек розблоковано', emoji: '💰', earned: milestoneCount >= 1 });
  return badges;
}

// Pure snapshot computation. Takes pre-aggregated raw inputs (so both the
// single-customer and batch paths share one implementation → guaranteed
// equivalence) and an injectable `now` (A-6) used only for the streak.
export function computeSnapshot(agg, now = Date.now()) {
  const spentRaw = agg?.spentRaw || 0;
  const purchaseCount = agg?.purchaseCount || 0;
  const redeemedRaw = agg?.redeemedRaw || 0;
  const months = agg?.monthSet instanceof Set ? agg.monthSet : new Set(agg?.months || []);
  const lastPurchaseAt = agg?.lastPurchaseAt || null;

  const totalSpent = round(spentRaw);
  const milestoneCount = Math.floor(totalSpent / STEP);
  const earned = milestoneCount * REWARD;
  const available = round(earned - redeemedRaw);

  const intoStep = totalSpent % STEP;
  const toNext = round(STEP - intoStep);
  const progressPct = Math.round((intoStep / STEP) * 100);

  const tier = tierFor(totalSpent);
  const nextTier = TIERS.find((t) => t.min > totalSpent) || null;

  const milestones = [];
  for (let i = 1; i <= milestoneCount; i += 1) {
    milestones.push({ index: i, thresholdUsd: i * STEP, reward: REWARD });
  }
  // nextMilestone enriches (does not duplicate) toNextReward.
  const nextMilestone = {
    index: milestoneCount + 1,
    thresholdUsd: (milestoneCount + 1) * STEP,
    remainingUsd: toNext,
    reward: REWARD,
  };

  const streakMonths = streakFrom(months, now);

  return {
    // ── existing fields — unchanged shape/order for backward compatibility ──
    totalSpent,
    purchases: purchaseCount,
    step: STEP,
    reward: REWARD,
    cashbackEarned: round(earned),
    cashbackRedeemed: round(redeemedRaw),
    cashbackAvailable: available,
    toNextReward: toNext,
    progressPct,
    tier: tier.key,
    tierName: tier.name,
    tierPerk: tier.perk,
    nextTier: nextTier ? { name: nextTier.name, toGo: round(nextTier.min - totalSpent) } : null,
    // ── new gamification fields ──
    milestones,
    nextMilestone,
    badges: badgesFor(totalSpent, purchaseCount, milestoneCount),
    streak: {
      months: streakMonths,
      active: streakMonths > 0,
      lastPurchaseAt,
    },
  };
}

// ── DB-backed snapshots ────────────────────────────────────────────────────

// Full loyalty + gamification snapshot for ONE customer.
// Delegates to snapshotBatch so the single- and batch-paths can never diverge.
export function loyaltyFor(customerId, now = Date.now()) {
  const id = Number(customerId);
  const batch = snapshotBatch([id], now);
  return batch[id] || computeSnapshot(null, now);
}

// N+1-safe batch snapshot: computes the same shape for an array of customer ids
// using EXACTLY 2 aggregate queries total (one grouping purchases by
// customer+month, one grouping redemptions by customer) — never a per-id loop
// of queries. Required by the scheduler (Step 6) and admin list views (R-01).
export function snapshotBatch(customerIds, now = Date.now()) {
  const ids = [...new Set((customerIds || []).map(Number).filter((n) => Number.isFinite(n)))];
  const out = {};
  if (ids.length === 0) return out;

  const placeholders = ids.map(() => '?').join(',');

  // Query 1/2 — purchases grouped by customer_id AND calendar month. Grouping
  // by month lets us derive totalSpent (sum of monthly sums), purchase count,
  // the distinct-month set (for streak) and the latest purchase — all from one
  // aggregate scan. substr(created_at,1,7) = 'YYYY-MM' (created_at is ISO/UTC).
  const purchaseRows = db.prepare(
    `SELECT customer_id AS cid,
            substr(created_at, 1, 7) AS ym,
            COALESCE(SUM(amount_usd), 0) AS s,
            COUNT(*) AS n,
            MAX(created_at) AS last_at
       FROM purchases
      WHERE status = 'confirmed' AND customer_id IN (${placeholders})
      GROUP BY customer_id, ym`
  ).all(...ids);

  // Query 2/2 — redemptions grouped by customer_id.
  const redeemRows = db.prepare(
    `SELECT customer_id AS cid, COALESCE(SUM(amount_usd), 0) AS s
       FROM redemptions
      WHERE customer_id IN (${placeholders})
      GROUP BY customer_id`
  ).all(...ids);

  const agg = new Map();
  for (const id of ids) {
    agg.set(id, { spentRaw: 0, purchaseCount: 0, redeemedRaw: 0, monthSet: new Set(), lastPurchaseAt: null });
  }
  for (const r of purchaseRows) {
    const a = agg.get(r.cid);
    if (!a) continue;
    a.spentRaw += r.s;
    a.purchaseCount += r.n;
    if (r.ym) a.monthSet.add(r.ym);
    if (r.last_at && (!a.lastPurchaseAt || r.last_at > a.lastPurchaseAt)) a.lastPurchaseAt = r.last_at;
  }
  for (const r of redeemRows) {
    const a = agg.get(r.cid);
    if (a) a.redeemedRaw += r.s;
  }
  for (const id of ids) out[id] = computeSnapshot(agg.get(id), now);
  return out;
}

function round(n) {
  return Math.round(n * 100) / 100;
}
