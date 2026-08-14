// ─────────────────────────────────────────────────────────────────────────
//  campaigns.js — the discount / campaign engine (ADR-002).
//
//  Campaigns are the source of truth for discounts; `promo_codes` rows are the
//  materialized per-customer instances, linked via `campaign_id`. This module
//  owns the campaign lifecycle (draft→scheduled→active→ended→archived), audience
//  resolution, idempotent promo materialization and the customer-facing discount
//  card shaping.
//
//  Idempotency (R-02, THE critical property): materialize() relies on
//  `ON CONFLICT DO NOTHING` against the UNIQUE index
//    uq_promo_campaign_customer_year
//      (campaign_id, customer_id, extract(year from created_at at time zone 'UTC'))
//  so re-running it for the same campaign in the same calendar year is a silent
//  per-customer no-op — exactly one promo per matching customer per year.
//
//  All time-dependent functions accept an injectable `now` (A-6) for testability.
// ─────────────────────────────────────────────────────────────────────────
import { db } from './db.js';
import { TIERS, tierFor } from './loyalty.js';
import { mmddOf, birthdayWindow } from './birthday.js';
import { asJson } from './sql.js';

// ── constants ──────────────────────────────────────────────────────────────
export const CAMPAIGN_TYPES = ['birthday', 'holiday', 'vip', 'generic'];

// ── the conditions a campaign can be aimed with ────────────────────────────
//
// Every condition present must hold — they are ANDed, always, with no operator
// to choose. That is a decision about the person using this, not a limitation:
// «клієнти з 3+ покупками АБО тратою від $5000, але НЕ з Києва» is a sentence
// nobody composes correctly in a form, and a wrong audience is money given to
// the wrong people. Anything that genuinely needs OR is two campaigns, which is
// also two things you can read afterwards and tell apart.
//
// Each key is one plain question about a customer, so the cabinet can print the
// whole audience as a list of sentences and the owner can check it by reading.
export const CONDITIONS = {
  // who they are
  tier:            'Рівень клієнта',
  city:            'Місто',
  sourceChannel:   'Купував з каталогу',
  tgIds:           'Конкретні клієнти (Telegram id)',
  joinedWithinDays: 'У клубі не довше, ніж (днів)',
  // what they have spent
  minSpentUsd:     'Сума покупок від, $',
  maxSpentUsd:     'Сума покупок до, $',
  // how often they buy
  minPurchases:    'Покупок від',
  maxPurchases:    'Покупок до',
  firstOrder:      'Ще жодної покупки (перше замовлення)',
  boughtWithinDays: 'Купував за останні (днів)',
  minPurchasesInWindow: '…і саме стільки разів за цей період',
  dormantDays:     'Не купував уже (днів)',
  // the calendar of the person, as opposed to the calendar of the shop —
  // the shop's dates are the campaign window (startsAt / endsAt)
  birthdayWithinDays: 'День народження протягом (днів)',
  hasBirthday:     'Дата народження відома',
};
const AUDIENCE_KEYS = Object.keys(CONDITIONS);
const TIER_KEYS = TIERS.map((t) => t.key); // silver | gold | platinum
// Card variants map 1:1 onto campaign types; `emoji` matches the design tokens.
const VARIANT_EMOJI = { birthday: '🎂', holiday: '🎉', vip: '💎', generic: '🏷️' };
// Campaigns app-wide-visible (non-personal) on the customer discounts surface.
const PUBLIC_TYPES = ['holiday', 'generic'];

// ── errors ───────────────────────────────────────────────────────────────
// A validation failure the caller (route handler) turns into an HTTP 400.
export class CampaignValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CampaignValidationError';
    this.status = 400;
  }
}
const bad = (msg) => { throw new CampaignValidationError(msg); };

// ── time helpers (injectable clock, A-6) ───────────────────────────────────
const toMs = (v) => {
  if (v == null) return null;
  if (v instanceof Date) return v.getTime();
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
};
const toIso = (v) => {
  if (v == null) return new Date().toISOString();
  if (v instanceof Date) return v.toISOString();
  const t = Date.parse(v);
  return Number.isNaN(t) ? new Date().toISOString() : new Date(t).toISOString();
};

// ── validation ─────────────────────────────────────────────────────────────
function validatePercent(percent) {
  if (!Number.isInteger(percent)) bad('percent must be an integer');
  if (percent < 1 || percent > 90) bad('percent must be between 1 and 90');
  return percent;
}

// A campaign is either a percentage or a sum of money, the same toggle every
// other discount in this app has. `percent` is still written for older rows and
// older clients; when the campaign is a fixed sum it is 0 there and the truth is
// in mode/value, which is why nothing reads `percent` alone any more.
function validateMoney(input = {}) {
  const hasNew = input.mode !== undefined || input.value !== undefined;
  const minOrderUsd = input.minOrderUsd == null && input.min_order_usd == null
    ? 0
    : Number(input.minOrderUsd ?? input.min_order_usd);
  if (!Number.isFinite(minOrderUsd) || minOrderUsd < 0) bad('minOrderUsd must be a number >= 0');

  if (!hasNew) {
    const p = validatePercent(input.percent);
    return { mode: 'percent', value: p, percent: p, minOrderUsd };
  }
  const mode = input.mode === 'fixed' ? 'fixed' : 'percent';
  const value = Number(input.value);
  if (!Number.isFinite(value) || value <= 0) bad('value must be a positive number');
  if (mode === 'percent') {
    const p = validatePercent(Math.round(value));
    return { mode, value: p, percent: p, minOrderUsd };
  }
  // A fixed campaign has no meaningful percentage; 0 is the honest value and
  // discountsFor() reads mode first, so nothing renders «0%».
  return { mode, value, percent: 0, minOrderUsd };
}

function validateType(type) {
  if (!CAMPAIGN_TYPES.includes(type)) bad(`type must be one of ${CAMPAIGN_TYPES.join('|')}`);
  return type;
}

// Validate + normalize an audience filter object. Rejects unknown keys and
// out-of-range / wrong-typed values. Returns a clean object (only known keys),
// or null when the audience matches everyone (empty / absent). Centralized here
// so every write path (create/update) and read path (resolve/preview) enforce
// the same enum discipline (R-12).
export function validateAudience(audience) {
  if (audience == null) return null;
  if (typeof audience !== 'object' || Array.isArray(audience)) bad('audience must be an object');

  const unknown = Object.keys(audience).filter((k) => !AUDIENCE_KEYS.includes(k));
  if (unknown.length) bad(`unknown audience keys: ${unknown.join(', ')}`);

  const out = {};
  if (audience.tier !== undefined && audience.tier !== null) {
    if (typeof audience.tier !== 'string' || !TIER_KEYS.includes(audience.tier)) {
      bad(`audience.tier must be one of ${TIER_KEYS.join('|')}`);
    }
    out.tier = audience.tier;
  }
  if (audience.minSpentUsd !== undefined && audience.minSpentUsd !== null) {
    const n = Number(audience.minSpentUsd);
    if (!Number.isFinite(n) || n < 0) bad('audience.minSpentUsd must be a number >= 0');
    out.minSpentUsd = n;
  }
  if (audience.city !== undefined && audience.city !== null) {
    if (typeof audience.city !== 'string' || !audience.city.trim()) bad('audience.city must be a non-empty string');
    out.city = audience.city.trim();
  }
  if (audience.sourceChannel !== undefined && audience.sourceChannel !== null) {
    if (typeof audience.sourceChannel !== 'string' || !audience.sourceChannel.trim()) {
      bad('audience.sourceChannel must be a non-empty string');
    }
    out.sourceChannel = audience.sourceChannel.trim();
  }
  if (audience.tgIds !== undefined && audience.tgIds !== null) {
    if (!Array.isArray(audience.tgIds) || audience.tgIds.length === 0) bad('audience.tgIds must be a non-empty array');
    const list = audience.tgIds.map((v) => {
      if (typeof v !== 'string' && typeof v !== 'number') bad('audience.tgIds entries must be string or number');
      return String(v).trim();
    });
    if (list.some((v) => !v)) bad('audience.tgIds entries must be non-empty');
    out.tgIds = list;
  }

  // ── the conditions added for the campaign builder ────────────────────────
  const num = (key, { min = 0, integer = false } = {}) => {
    const v = audience[key];
    if (v === undefined || v === null || v === '') return;
    const n = Number(v);
    if (!Number.isFinite(n) || n < min) bad(`audience.${key} must be a number >= ${min}`);
    if (integer && !Number.isInteger(n)) bad(`audience.${key} must be a whole number`);
    out[key] = n;
  };
  const bool = (key) => {
    const v = audience[key];
    if (v === undefined || v === null) return;
    if (typeof v !== 'boolean') bad(`audience.${key} must be true or false`);
    // `false` on a flag means "no opinion", not "the opposite". Storing it would
    // make an empty checkbox into a filter nobody asked for — except
    // hasBirthday, where "we do not know the date" is a real audience.
    if (v || key === 'hasBirthday') out[key] = v;
  };

  num('maxSpentUsd');
  num('minPurchases', { integer: true });
  num('maxPurchases', { integer: true });
  num('boughtWithinDays', { min: 1, integer: true });
  num('minPurchasesInWindow', { min: 1, integer: true });
  num('dormantDays', { min: 1, integer: true });
  num('birthdayWithinDays', { min: 0, integer: true });
  num('joinedWithinDays', { min: 1, integer: true });
  bool('firstOrder');
  bool('hasBirthday');

  // Contradictions are refused rather than silently resolving to nobody. An
  // audience of zero people is a campaign that appears to work and gives away
  // nothing, which is the kind of failure that is noticed a season later.
  if (out.minSpentUsd != null && out.maxSpentUsd != null && out.maxSpentUsd < out.minSpentUsd) {
    bad('audience: «сума покупок до» менша за «від»');
  }
  if (out.minPurchases != null && out.maxPurchases != null && out.maxPurchases < out.minPurchases) {
    bad('audience: «покупок до» менше за «покупок від»');
  }
  if (out.firstOrder && (out.minPurchases > 0 || out.minSpentUsd > 0 || out.boughtWithinDays != null)) {
    bad('audience: «перше замовлення» не поєднується з умовами про попередні покупки');
  }
  if (out.boughtWithinDays != null && out.dormantDays != null) {
    bad('audience: «купував за останні N днів» суперечить «не купував уже N днів»');
  }
  if (out.minPurchasesInWindow != null && out.boughtWithinDays == null) {
    bad('audience: вкажіть період для «саме стільки разів»');
  }

  return Object.keys(out).length ? out : null;
}

/** The audience as sentences, for the cabinet to print and the owner to check
 *  by reading. Order is stable so the same audience always reads the same. */
export function describeAudience(audience) {
  const a = validateAudience(audience);
  if (!a) return ['усі клієнти'];
  const out = [];
  if (a.firstOrder) out.push('ще жодної покупки — перше замовлення');
  if (a.minPurchases != null) out.push(`покупок від ${a.minPurchases}`);
  if (a.maxPurchases != null) out.push(`покупок до ${a.maxPurchases}`);
  if (a.minSpentUsd != null) out.push(`витратив від $${a.minSpentUsd}`);
  if (a.maxSpentUsd != null) out.push(`витратив до $${a.maxSpentUsd}`);
  if (a.boughtWithinDays != null) {
    out.push(a.minPurchasesInWindow != null
      ? `${a.minPurchasesInWindow}+ покупок за останні ${a.boughtWithinDays} дн.`
      : `купував за останні ${a.boughtWithinDays} дн.`);
  }
  if (a.dormantDays != null) out.push(`не купував ${a.dormantDays}+ дн.`);
  if (a.birthdayWithinDays != null) out.push(`день народження протягом ${a.birthdayWithinDays} дн.`);
  if (a.hasBirthday === true) out.push('дата народження відома');
  if (a.hasBirthday === false) out.push('дата народження невідома');
  if (a.joinedWithinDays != null) out.push(`у клубі не довше ${a.joinedWithinDays} дн.`);
  if (a.tier) out.push(`рівень ${a.tier}`);
  if (a.city) out.push(`місто ${a.city}`);
  if (a.sourceChannel) out.push(`купував з каталогу «${a.sourceChannel}»`);
  if (a.tgIds) out.push(`лише ${a.tgIds.length} обраних клієнтів`);
  return out;
}

// ── status derivation (pure, from the window) ──────────────────────────────
// Given a campaign row's window and a clock, what "live" status should it hold?
// Never returns draft/archived — those are manual holds the reconciler leaves
// untouched (see reconcileStatus).
function desiredStatus(row, nowMs) {
  const s = toMs(row.starts_at);
  const e = toMs(row.ends_at);
  if (e != null && nowMs >= e) return 'ended';
  if (s != null && nowMs < s) return 'scheduled';
  return 'active';
}

// ── row shaping ─────────────────────────────────────────────────────────────
function shapeCampaign(row) {
  if (!row) return row;
  let audience = null;
  if (row.audience_json) {
    audience = asJson(row.audience_json);
  }
  return { ...row, audience };
}

// ── create ───────────────────────────────────────────────────────────────
// Inserts a campaign. Initial status is derived from the window vs now:
//   future starts_at            → 'scheduled'
//   window already ended        → 'ended'
//   otherwise (immediate/open)  → 'active'
// (We never create a 'draft' here — create() means "make this campaign real".
//  draft/archived are manual holds reachable via update(), and the reconciler
//  leaves them alone.)
export async function create(input = {}, opts = {}) {
  const {
    name, type, percent, audience, holidayId,
    startsAt, endsAt, recurring, windowDays, promoValidDays,
    source, createdBy, preset,
  } = input;

  if (typeof name !== 'string' || !name.trim()) bad('name is required');
  validateType(type);
  const money = validateMoney(input);
  const cleanAudience = validateAudience(audience);

  const startsIso = startsAt != null ? toIso(startsAt) : null;
  const endsIso = endsAt != null ? toIso(endsAt) : null;
  if (startsIso && endsIso && toMs(endsIso) <= toMs(startsIso)) bad('endsAt must be after startsAt');

  const nowMs = toMs(opts.now) ?? Date.now();
  const nowIso = toIso(opts.now);
  const status = desiredStatus({ starts_at: startsIso, ends_at: endsIso }, nowMs);

  const info = await db.prepare(`INSERT INTO campaigns
    (name,type,percent,mode,value,min_order_usd,preset,audience_json,holiday_id,starts_at,ends_at,recurring,window_days,promo_valid_days,status,source,created_by,created_at,updated_at)
    VALUES (@name,@type,@percent,@mode,@value,@min_order_usd,@preset,@audience_json,@holiday_id,@starts_at,@ends_at,@recurring,@window_days,@promo_valid_days,@status,@source,@created_by,@created_at,@updated_at)`)
    .run({
      name: name.trim(),
      type,
      percent: money.percent,
      mode: money.mode,
      value: money.value,
      min_order_usd: money.minOrderUsd,
      preset: preset ? String(preset) : null,
      audience_json: cleanAudience ? JSON.stringify(cleanAudience) : null,
      holiday_id: holidayId != null ? Number(holidayId) : null,
      starts_at: startsIso,
      ends_at: endsIso,
      recurring: Boolean(recurring),
      window_days: Number.isInteger(windowDays) ? windowDays : 0,
      promo_valid_days: Number.isInteger(promoValidDays) ? promoValidDays : 14,
      status,
      source: source === 'ai' ? 'ai' : 'manual',
      created_by: createdBy != null ? String(createdBy) : null,
      created_at: nowIso,
      updated_at: nowIso,
    });
  return await getById(Number(info.lastInsertRowid));
}

// ── update ───────────────────────────────────────────────────────────────
// Validates any patched fields, writes them, bumps updated_at. If the window
// changed and the caller did not explicitly set `status`, the "live" status is
// recomputed from the new window (unless the campaign is on a manual hold —
// draft/archived — which we never auto-flip).
export async function update(id, patch = {}, opts = {}) {
  const current = await getRawById(id);
  if (!current) return null;

  const sets = {};
  if (patch.name !== undefined) {
    if (typeof patch.name !== 'string' || !patch.name.trim()) bad('name must be a non-empty string');
    sets.name = patch.name.trim();
  }
  if (patch.type !== undefined) sets.type = validateType(patch.type);
  if (patch.percent !== undefined || patch.mode !== undefined || patch.value !== undefined) {
    const money = validateMoney({ ...current, mode: patch.mode ?? current.mode, value: patch.value ?? current.value,
      percent: patch.percent ?? current.percent, minOrderUsd: patch.minOrderUsd ?? current.min_order_usd });
    sets.percent = money.percent;
    sets.mode = money.mode;
    sets.value = money.value;
    sets.min_order_usd = money.minOrderUsd;
  } else if (patch.minOrderUsd !== undefined) {
    const n = Number(patch.minOrderUsd);
    if (!Number.isFinite(n) || n < 0) bad('minOrderUsd must be a number >= 0');
    sets.min_order_usd = n;
  }
  if (patch.preset !== undefined) sets.preset = patch.preset ? String(patch.preset) : null;
  if (patch.audience !== undefined) {
    const clean = validateAudience(patch.audience);
    sets.audience_json = clean ? JSON.stringify(clean) : null;
  }
  if (patch.holidayId !== undefined) sets.holiday_id = patch.holidayId != null ? Number(patch.holidayId) : null;
  if (patch.startsAt !== undefined) sets.starts_at = patch.startsAt != null ? toIso(patch.startsAt) : null;
  if (patch.endsAt !== undefined) sets.ends_at = patch.endsAt != null ? toIso(patch.endsAt) : null;
  if (patch.recurring !== undefined) sets.recurring = Boolean(patch.recurring);
  if (patch.windowDays !== undefined) {
    if (!Number.isInteger(patch.windowDays) || patch.windowDays < 0) bad('windowDays must be a non-negative integer');
    sets.window_days = patch.windowDays;
  }
  if (patch.promoValidDays !== undefined) {
    if (!Number.isInteger(patch.promoValidDays) || patch.promoValidDays < 1) bad('promoValidDays must be a positive integer');
    sets.promo_valid_days = patch.promoValidDays;
  }
  if (patch.status !== undefined) {
    const allowed = ['draft', 'scheduled', 'active', 'ended', 'archived'];
    if (!allowed.includes(patch.status)) bad(`status must be one of ${allowed.join('|')}`);
    sets.status = patch.status;
  }

  const startsIso = sets.starts_at !== undefined ? sets.starts_at : current.starts_at;
  const endsIso = sets.ends_at !== undefined ? sets.ends_at : current.ends_at;
  if (startsIso && endsIso && toMs(endsIso) <= toMs(startsIso)) bad('endsAt must be after startsAt');

  // Re-derive live status when the window moved and status wasn't set explicitly.
  const windowChanged = sets.starts_at !== undefined || sets.ends_at !== undefined;
  const onManualHold = current.status === 'draft' || current.status === 'archived';
  if (patch.status === undefined && windowChanged && !onManualHold) {
    const nowMs = toMs(opts.now) ?? Date.now();
    sets.status = desiredStatus({ starts_at: startsIso, ends_at: endsIso }, nowMs);
  }

  sets.updated_at = toIso(opts.now);

  const cols = Object.keys(sets);
  const assign = cols.map((c) => `${c}=@${c}`).join(', ');
  await db.prepare(`UPDATE campaigns SET ${assign} WHERE id=@id`).run({ ...sets, id });
  return await getById(id);
}

// ── reconcileStatus ─────────────────────────────────────────────────────────
// Pure lifecycle reconciler (idempotent). For every non-hold campaign
// (status IN scheduled|active|ended) compute the desired status from its window
// vs `now` and apply a DB update ONLY where the status actually changes. Calling
// it twice with the same `now` performs zero writes the second time. draft &
// archived are manual holds and are never auto-transitioned.
export async function reconcileStatus(now) {
  const nowMs = toMs(now) ?? Date.now();
  const nowIso = toIso(now);
  const rows = await db.prepare(
    "SELECT id, starts_at, ends_at, status FROM campaigns WHERE status IN ('scheduled','active','ended')",
  ).all();
  const transitions = [];
  // The statement is prepared from `tx`, not from the module-level db: on a
  // connection pool anything prepared elsewhere would execute on a different
  // connection and land outside this transaction.
  await db.transaction(async (tx) => {
    const upd = tx.prepare('UPDATE campaigns SET status=?, updated_at=? WHERE id=?');
    for (const r of rows) {
      const desired = desiredStatus(r, nowMs);
      if (desired !== r.status) {
        await upd.run(desired, nowIso, r.id);
        transitions.push({ id: r.id, from: r.status, to: desired });
      }
    }
  });
  return { scanned: rows.length, changed: transitions.length, transitions };
}

// ── resolveAudience ─────────────────────────────────────────────────────────
// Returns the matching customer ids for an audience filter using a BOUNDED set
// of aggregate queries (never a per-customer loop — R-01). Empty/absent audience
// matches every customer.
//   tier          → derived from lifetime confirmed spend via loyalty.tierFor
//   minSpentUsd   → summed confirmed purchases >= threshold
//   city          → customers.city exact match
//   sourceChannel → has ≥1 purchase with that source_channel
//   tgIds         → direct tg_user_id list
export async function resolveAudience(audience, now = Date.now()) {
  const a = validateAudience(audience);
  const customers = await db.prepare(
    'SELECT id, tg_user_id, city, birthday, created_at FROM customers'
  ).all();
  if (!a) return customers.map((c) => c.id);

  let result = customers;

  if (a.city) result = result.filter((c) => c.city === a.city);

  if (a.tgIds) {
    const wanted = new Set(a.tgIds.map(String));
    result = result.filter((c) => wanted.has(String(c.tg_user_id)));
  }

  if (a.sourceChannel) {
    const chRows = await db.prepare('SELECT DISTINCT customer_id FROM purchases WHERE source_channel=?').all(a.sourceChannel);
    const chSet = new Set(chRows.map((r) => r.customer_id));
    result = result.filter((c) => chSet.has(c.id));
  }

  // One aggregate for spend, count and recency together — the three questions
  // that used to be one query are still one query. Never a per-customer loop.
  const needsHistory = a.tier || a.minSpentUsd != null || a.maxSpentUsd != null
    || a.minPurchases != null || a.maxPurchases != null || a.firstOrder || a.dormantDays != null;
  if (needsHistory) {
    const rows = await db.prepare(
      `SELECT customer_id,
              COUNT(*)                        AS n,
              COALESCE(SUM(amount_usd), 0)    AS total,
              MAX(created_at)                 AS last_at
         FROM purchases WHERE status='confirmed' GROUP BY customer_id`
    ).all();
    const hist = new Map(rows.map((r) => [r.customer_id, {
      n: Number(r.n) || 0,
      total: Number(r.total) || 0,
      lastMs: r.last_at ? Date.parse(r.last_at) : null,
    }]));
    result = result.filter((c) => {
      const h = hist.get(c.id) || { n: 0, total: 0, lastMs: null };
      if (a.firstOrder && h.n > 0) return false;
      if (a.tier && tierFor(h.total).key !== a.tier) return false;
      if (a.minSpentUsd != null && h.total < a.minSpentUsd) return false;
      if (a.maxSpentUsd != null && h.total > a.maxSpentUsd) return false;
      if (a.minPurchases != null && h.n < a.minPurchases) return false;
      if (a.maxPurchases != null && h.n > a.maxPurchases) return false;
      if (a.dormantDays != null) {
        // Somebody who has never bought is not dormant, they are new — the
        // win-back campaign is not for them, and «перше замовлення» is.
        if (h.lastMs == null) return false;
        if (now - h.lastMs < a.dormantDays * DAY) return false;
      }
      return true;
    });
  }

  // «Купував за останні N днів», and optionally how many times. One more
  // aggregate, bounded by the window rather than by the number of customers.
  if (a.boughtWithinDays != null) {
    const since = new Date(now - a.boughtWithinDays * DAY).toISOString();
    const rows = await db.prepare(
      "SELECT customer_id, COUNT(*) AS n FROM purchases WHERE status='confirmed' AND created_at >= ? GROUP BY customer_id"
    ).all(since);
    const need = a.minPurchasesInWindow != null ? a.minPurchasesInWindow : 1;
    const recent = new Map(rows.map((r) => [r.customer_id, Number(r.n) || 0]));
    result = result.filter((c) => (recent.get(c.id) || 0) >= need);
  }

  if (a.hasBirthday !== undefined) {
    result = result.filter((c) => Boolean(mmddOf(c.birthday)) === a.hasBirthday);
  }

  if (a.birthdayWithinDays != null) {
    result = result.filter((c) => {
      const days = daysUntilBirthday(c.birthday, now);
      return days != null && days <= a.birthdayWithinDays;
    });
  }

  if (a.joinedWithinDays != null) {
    result = result.filter((c) => {
      const t = c.created_at ? Date.parse(c.created_at) : null;
      return t != null && now - t <= a.joinedWithinDays * DAY;
    });
  }

  return result.map((c) => c.id);
}

const DAY = 86400000;

// How many days until this customer's next birthday, 0 meaning today. Null when
// no date is on file. Leap-day and year-end wrap-around are birthdayWindow's
// problem, and it already solves them.
function daysUntilBirthday(stored, now) {
  const mmdd = mmddOf(stored);
  if (!mmdd) return null;
  const [month, day] = mmdd.split('-').map(Number);
  if (!month || !day) return null;
  // A one-day window, not a zero-day one. birthdayWindow treats validDays as a
  // length, so 0 makes the window the single instant of midnight — and anybody
  // asked after midnight on their own birthday came back as "in 365 days".
  const w = birthdayWindow({ month, day }, now, 1);
  if (w.open) return 0;
  return Math.max(0, Math.ceil((w.startsAt - now) / DAY));
}

// ── preview ─────────────────────────────────────────────────────────────────
// Audience size for a campaign, without materializing any promos.
export async function preview(campaignId, now = Date.now()) {
  const c = shapeCampaign(await getRawById(campaignId));
  if (!c) return null;
  const ids = await resolveAudience(c.audience, now);
  return { campaignId: c.id, count: ids.length, audience: describeAudience(c.audience) };
}

/** How many customers an audience would reach RIGHT NOW, before anything is
 *  saved. This is what makes the builder honest: the owner sees «27 клієнтів»
 *  under the conditions before pressing the button, not after. */
export async function previewAudience(audience, now = Date.now()) {
  const ids = await resolveAudience(audience, now);
  return { count: ids.length, audience: describeAudience(audience) };
}

// ── code generation (matches the existing /api/admin/promo pattern) ─────────
const genCode = () => `W2B-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

// ── materialize ─────────────────────────────────────────────────────────────
// For a campaign, mint one promo per matching customer. Idempotent per
// (campaign, customer, calendar-year) via the UNIQUE index +
// `ON CONFLICT DO NOTHING`: a re-run in the same year is a silent per-customer
// no-op, so calling twice yields exactly ONE promo per customer (R-02). The
// index buckets the year with `extract(year from created_at at time zone 'UTC')`
// — UTC because that is the clock the app writes in, and a literal zone keeps
// the expression immutable, which is what lets it carry an index at all.
// Returns { created, alreadyExisted, total }.
export async function materialize(campaignId, now) {
  const campaign = await getRawById(campaignId);
  if (!campaign) return null;

  const shaped = shapeCampaign(campaign);
  const ids = await resolveAudience(shaped.audience, toMs(now) ?? Date.now());

  const nowMs = toMs(now) ?? Date.now();
  const createdAt = toIso(now);
  const validDays = campaign.promo_valid_days || 14;
  const expiresAt = new Date(nowMs + validDays * 86400000).toISOString();

  let created = 0;
  let alreadyExisted = 0;
  // Prepared from `tx` so every insert runs on the transaction's own connection.
  await db.transaction(async (tx) => {
    const ins = tx.prepare(
      `INSERT INTO promo_codes
         (customer_id, code, percent, mode, amount_usd, min_order_usd, reason, status, created_at, expires_at, campaign_id)
       VALUES (?,?,?,?,?,?,?,'active',?,?,?)
       ON CONFLICT DO NOTHING`,
    );
    const mode = campaign.mode || 'percent';
    const amountUsd = mode === 'fixed' ? Number(campaign.value || 0) : null;
    for (const cid of ids) {
      const info = await ins.run(cid, genCode(), campaign.percent, mode, amountUsd,
        Number(campaign.min_order_usd || 0), campaign.name, createdAt, expiresAt, campaign.id);
      if (info.changes === 1) created += 1; else alreadyExisted += 1;
    }
  });

  return { campaignId: campaign.id, created, alreadyExisted, total: ids.length };
}

// ── customer-facing discounts (card shaping) ────────────────────────────────
// Returns the caller's own active promos (joined with campaign type/name for the
// card variant) plus the app-wide public campaigns (holiday|generic only — vip &
// birthday are personal and never surface here). `customerId` may be null for an
// unregistered caller (they still see public campaigns).
export async function discountsFor(customerId) {
  const promos = customerId
    ? await db.prepare(
        `SELECT p.id, p.code, p.percent, p.mode, p.amount_usd, p.min_order_usd, p.rule_key,
                p.reason, p.expires_at, p.created_at, p.campaign_id,
                c.type AS campaign_type, c.name AS campaign_name
           FROM promo_codes p
           LEFT JOIN campaigns c ON c.id = p.campaign_id
          WHERE p.customer_id = ? AND p.status = 'active'
          ORDER BY p.created_at DESC
          LIMIT 100`,
      ).all(customerId)
    : [];

  const publicRows = await db.prepare(
    `SELECT id, type, name, percent, ends_at
       FROM campaigns
      WHERE status = 'active' AND type IN ('holiday','generic')
      ORDER BY created_at DESC
      LIMIT 50`,
  ).all();

  return {
    promos: promos.map((p) => {
      // A promo issued by a rule (birthday) carries that rule's variant even
      // when it has no campaign behind it.
      const variant = p.campaign_type || p.rule_key || 'generic';
      const mode = p.mode || 'percent';
      return {
        id: p.id,
        variant: VARIANT_EMOJI[variant] ? variant : 'generic',
        // `mode` + `value` are what the UI renders; `percent` stays for older
        // clients that only understood percentages.
        mode,
        value: mode === 'fixed' ? Number(p.amount_usd || 0) : Number(p.percent || 0),
        percent: p.percent,
        minOrderUsd: Number(p.min_order_usd || 0),
        code: p.code,
        expiresAt: p.expires_at,
        campaignName: p.campaign_name || null,
        title: p.campaign_name || p.reason || 'Промокод',
        emoji: VARIANT_EMOJI[variant] || VARIANT_EMOJI.generic,
      };
    }),
    publicCampaigns: publicRows.map((c) => ({
      id: c.id,
      variant: c.type,
      mode: 'percent',
      value: Number(c.percent || 0),
      percent: c.percent,
      minOrderUsd: 0,
      code: null,
      expiresAt: c.ends_at,
      campaignName: c.name,
      title: c.name,
      emoji: VARIANT_EMOJI[c.type] || VARIANT_EMOJI.generic,
    })),
  };
}

// ── list / lookup helpers ────────────────────────────────────────────────
export async function getRawById(id) {
  return await db.prepare('SELECT * FROM campaigns WHERE id=?').get(id);
}
export async function getById(id) {
  return shapeCampaign(await getRawById(id));
}

// Paginated, optionally status-filtered campaign list. Never unbounded (GA-8).
export async function list({ status, limit = 50, offset = 0 } = {}) {
  const lim = clampLimit(limit);
  const off = Math.max(0, Number(offset) || 0);
  let rows;
  let total;
  if (status) {
    rows = await db.prepare('SELECT * FROM campaigns WHERE status=? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(status, lim, off);
    total = (await db.prepare('SELECT COUNT(*) c FROM campaigns WHERE status=?').get(status)).c;
  } else {
    rows = await db.prepare('SELECT * FROM campaigns ORDER BY created_at DESC LIMIT ? OFFSET ?').all(lim, off);
    total = (await db.prepare('SELECT COUNT(*) c FROM campaigns').get()).c;
  }
  return { campaigns: rows.map(shapeCampaign), total, limit: lim, offset: off };
}

export function clampLimit(limit, def = 50, max = 100) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}

// ── holidays ─────────────────────────────────────────────────────────────
export async function listHolidays({ limit = 100, offset = 0 } = {}) {
  const lim = clampLimit(limit, 100, 200);
  const off = Math.max(0, Number(offset) || 0);
  const rows = await db.prepare('SELECT * FROM holidays ORDER BY month, day LIMIT ? OFFSET ?').all(lim, off);
  const total = (await db.prepare('SELECT COUNT(*) c FROM holidays').get()).c;
  return { holidays: rows, total, limit: lim, offset: off };
}

export async function createHoliday(input = {}, opts = {}) {
  const { name, month, day, emoji, defaultPercent, enabled } = input;
  if (typeof name !== 'string' || !name.trim()) bad('name is required');
  if (!Number.isInteger(month) || month < 1 || month > 12) bad('month must be an integer 1..12');
  if (!Number.isInteger(day) || day < 1 || day > 31) bad('day must be an integer 1..31');
  const pct = defaultPercent == null ? 15 : validatePercent(defaultPercent);
  const info = await db.prepare(
    `INSERT INTO holidays (name,month,day,emoji,default_percent,enabled,created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(name.trim(), month, day, emoji || null, pct, enabled !== 0 && enabled !== false, toIso(opts.now));
  return await db.prepare('SELECT * FROM holidays WHERE id=?').get(Number(info.lastInsertRowid));
}
