// ─────────────────────────────────────────────────────────────────────────
//  campaigns.js — the discount / campaign engine (ADR-002).
//
//  Campaigns are the source of truth for discounts; `promo_codes` rows are the
//  materialized per-customer instances, linked via `campaign_id`. This module
//  owns the campaign lifecycle (draft→scheduled→active→ended→archived), audience
//  resolution, idempotent promo materialization and the customer-facing discount
//  card shaping.
//
//  Idempotency (R-02, THE critical property): `materialize()` uses
//  `INSERT OR IGNORE` against the DB's UNIQUE index
//    uq_promo_campaign_customer_year (campaign_id, customer_id, substr(created_at,1,4))
//  so re-running it for the same campaign in the same calendar year is a silent
//  per-customer no-op — exactly one promo per matching customer per year.
//
//  All time-dependent functions accept an injectable `now` (A-6) for testability.
// ─────────────────────────────────────────────────────────────────────────
import { db } from './db.js';
import { TIERS, tierFor } from './loyalty.js';

// ── constants ──────────────────────────────────────────────────────────────
export const CAMPAIGN_TYPES = ['birthday', 'holiday', 'vip', 'generic'];
const AUDIENCE_KEYS = ['tier', 'minSpentUsd', 'city', 'sourceChannel', 'tgIds'];
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
  return Object.keys(out).length ? out : null;
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
    try { audience = JSON.parse(row.audience_json); } catch { audience = null; }
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
export function create(input = {}, opts = {}) {
  const {
    name, type, percent, audience, holidayId,
    startsAt, endsAt, recurring, windowDays, promoValidDays,
    source, createdBy,
  } = input;

  if (typeof name !== 'string' || !name.trim()) bad('name is required');
  validateType(type);
  validatePercent(percent);
  const cleanAudience = validateAudience(audience);

  const startsIso = startsAt != null ? toIso(startsAt) : null;
  const endsIso = endsAt != null ? toIso(endsAt) : null;
  if (startsIso && endsIso && toMs(endsIso) <= toMs(startsIso)) bad('endsAt must be after startsAt');

  const nowMs = toMs(opts.now) ?? Date.now();
  const nowIso = toIso(opts.now);
  const status = desiredStatus({ starts_at: startsIso, ends_at: endsIso }, nowMs);

  const info = db.prepare(`INSERT INTO campaigns
    (name,type,percent,audience_json,holiday_id,starts_at,ends_at,recurring,window_days,promo_valid_days,status,source,created_by,created_at,updated_at)
    VALUES (@name,@type,@percent,@audience_json,@holiday_id,@starts_at,@ends_at,@recurring,@window_days,@promo_valid_days,@status,@source,@created_by,@created_at,@updated_at)`)
    .run({
      name: name.trim(),
      type,
      percent,
      audience_json: cleanAudience ? JSON.stringify(cleanAudience) : null,
      holiday_id: holidayId != null ? Number(holidayId) : null,
      starts_at: startsIso,
      ends_at: endsIso,
      recurring: recurring ? 1 : 0,
      window_days: Number.isInteger(windowDays) ? windowDays : 0,
      promo_valid_days: Number.isInteger(promoValidDays) ? promoValidDays : 14,
      status,
      source: source === 'ai' ? 'ai' : 'manual',
      created_by: createdBy != null ? String(createdBy) : null,
      created_at: nowIso,
      updated_at: nowIso,
    });
  return getById(Number(info.lastInsertRowid));
}

// ── update ───────────────────────────────────────────────────────────────
// Validates any patched fields, writes them, bumps updated_at. If the window
// changed and the caller did not explicitly set `status`, the "live" status is
// recomputed from the new window (unless the campaign is on a manual hold —
// draft/archived — which we never auto-flip).
export function update(id, patch = {}, opts = {}) {
  const current = getRawById(id);
  if (!current) return null;

  const sets = {};
  if (patch.name !== undefined) {
    if (typeof patch.name !== 'string' || !patch.name.trim()) bad('name must be a non-empty string');
    sets.name = patch.name.trim();
  }
  if (patch.type !== undefined) sets.type = validateType(patch.type);
  if (patch.percent !== undefined) sets.percent = validatePercent(patch.percent);
  if (patch.audience !== undefined) {
    const clean = validateAudience(patch.audience);
    sets.audience_json = clean ? JSON.stringify(clean) : null;
  }
  if (patch.holidayId !== undefined) sets.holiday_id = patch.holidayId != null ? Number(patch.holidayId) : null;
  if (patch.startsAt !== undefined) sets.starts_at = patch.startsAt != null ? toIso(patch.startsAt) : null;
  if (patch.endsAt !== undefined) sets.ends_at = patch.endsAt != null ? toIso(patch.endsAt) : null;
  if (patch.recurring !== undefined) sets.recurring = patch.recurring ? 1 : 0;
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
  db.prepare(`UPDATE campaigns SET ${assign} WHERE id=@id`).run({ ...sets, id });
  return getById(id);
}

// ── reconcileStatus ─────────────────────────────────────────────────────────
// Pure lifecycle reconciler (idempotent). For every non-hold campaign
// (status IN scheduled|active|ended) compute the desired status from its window
// vs `now` and apply a DB update ONLY where the status actually changes. Calling
// it twice with the same `now` performs zero writes the second time. draft &
// archived are manual holds and are never auto-transitioned.
export function reconcileStatus(now) {
  const nowMs = toMs(now) ?? Date.now();
  const nowIso = toIso(now);
  const rows = db.prepare(
    "SELECT id, starts_at, ends_at, status FROM campaigns WHERE status IN ('scheduled','active','ended')",
  ).all();
  const upd = db.prepare('UPDATE campaigns SET status=?, updated_at=? WHERE id=?');
  const transitions = [];
  const tx = db.transaction(() => {
    for (const r of rows) {
      const desired = desiredStatus(r, nowMs);
      if (desired !== r.status) {
        upd.run(desired, nowIso, r.id);
        transitions.push({ id: r.id, from: r.status, to: desired });
      }
    }
  });
  tx();
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
export function resolveAudience(audience) {
  const a = validateAudience(audience);
  const customers = db.prepare('SELECT id, tg_user_id, city FROM customers').all();
  if (!a) return customers.map((c) => c.id);

  let result = customers;

  if (a.city) result = result.filter((c) => c.city === a.city);

  if (a.tgIds) {
    const wanted = new Set(a.tgIds.map(String));
    result = result.filter((c) => wanted.has(String(c.tg_user_id)));
  }

  if (a.sourceChannel) {
    const chRows = db.prepare('SELECT DISTINCT customer_id FROM purchases WHERE source_channel=?').all(a.sourceChannel);
    const chSet = new Set(chRows.map((r) => r.customer_id));
    result = result.filter((c) => chSet.has(c.id));
  }

  if (a.tier || a.minSpentUsd != null) {
    // One aggregate over purchases → spend map (customers with none default 0).
    const spendRows = db.prepare(
      "SELECT customer_id, COALESCE(SUM(amount_usd),0) total FROM purchases WHERE status='confirmed' GROUP BY customer_id",
    ).all();
    const spend = new Map(spendRows.map((r) => [r.customer_id, r.total]));
    result = result.filter((c) => {
      const total = spend.get(c.id) || 0;
      if (a.tier && tierFor(total).key !== a.tier) return false;
      if (a.minSpentUsd != null && total < a.minSpentUsd) return false;
      return true;
    });
  }

  return result.map((c) => c.id);
}

// ── preview ─────────────────────────────────────────────────────────────────
// Audience size for a campaign, without materializing any promos.
export function preview(campaignId) {
  const c = shapeCampaign(getRawById(campaignId));
  if (!c) return null;
  const ids = resolveAudience(c.audience);
  return { campaignId: c.id, count: ids.length };
}

// ── code generation (matches the existing /api/admin/promo pattern) ─────────
const genCode = () => `W2B-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

// ── materialize ─────────────────────────────────────────────────────────────
// For a campaign, mint one promo per matching customer. Idempotent per
// (campaign, customer, calendar-year) via the DB UNIQUE index +
// `INSERT OR IGNORE`: a re-run in the same year is a silent per-customer no-op,
// so calling twice yields exactly ONE promo per customer (R-02). `created_at` is
// set to an ISO string (leading YYYY) so the year bucket of the unique index is
// well-defined. Returns { created, alreadyExisted, total }.
export function materialize(campaignId, now) {
  const campaign = getRawById(campaignId);
  if (!campaign) return null;

  const shaped = shapeCampaign(campaign);
  const ids = resolveAudience(shaped.audience);

  const nowMs = toMs(now) ?? Date.now();
  const createdAt = toIso(now);
  const validDays = campaign.promo_valid_days || 14;
  const expiresAt = new Date(nowMs + validDays * 86400000).toISOString();

  const ins = db.prepare(
    `INSERT OR IGNORE INTO promo_codes
       (customer_id, code, percent, reason, status, created_at, expires_at, campaign_id)
     VALUES (?,?,?,?,'active',?,?,?)`,
  );

  let created = 0;
  let alreadyExisted = 0;
  const tx = db.transaction((custIds) => {
    for (const cid of custIds) {
      const info = ins.run(cid, genCode(), campaign.percent, campaign.name, createdAt, expiresAt, campaign.id);
      if (info.changes === 1) created += 1; else alreadyExisted += 1;
    }
  });
  tx(ids);

  return { campaignId: campaign.id, created, alreadyExisted, total: ids.length };
}

// ── customer-facing discounts (card shaping) ────────────────────────────────
// Returns the caller's own active promos (joined with campaign type/name for the
// card variant) plus the app-wide public campaigns (holiday|generic only — vip &
// birthday are personal and never surface here). `customerId` may be null for an
// unregistered caller (they still see public campaigns).
export function discountsFor(customerId) {
  const promos = customerId
    ? db.prepare(
        `SELECT p.id, p.code, p.percent, p.expires_at, p.created_at, p.campaign_id,
                c.type AS campaign_type, c.name AS campaign_name
           FROM promo_codes p
           LEFT JOIN campaigns c ON c.id = p.campaign_id
          WHERE p.customer_id = ? AND p.status = 'active'
          ORDER BY p.created_at DESC
          LIMIT 100`,
      ).all(customerId)
    : [];

  const publicRows = db.prepare(
    `SELECT id, type, name, percent, ends_at
       FROM campaigns
      WHERE status = 'active' AND type IN ('holiday','generic')
      ORDER BY created_at DESC
      LIMIT 50`,
  ).all();

  return {
    promos: promos.map((p) => {
      const variant = p.campaign_type || 'generic';
      return {
        id: p.id,
        variant,
        percent: p.percent,
        code: p.code,
        expiresAt: p.expires_at,
        campaignName: p.campaign_name || null,
        title: p.campaign_name || 'Промокод',
        emoji: VARIANT_EMOJI[variant] || VARIANT_EMOJI.generic,
      };
    }),
    publicCampaigns: publicRows.map((c) => ({
      id: c.id,
      variant: c.type,
      percent: c.percent,
      code: null,
      expiresAt: c.ends_at,
      campaignName: c.name,
      title: c.name,
      emoji: VARIANT_EMOJI[c.type] || VARIANT_EMOJI.generic,
    })),
  };
}

// ── list / lookup helpers ────────────────────────────────────────────────
export function getRawById(id) {
  return db.prepare('SELECT * FROM campaigns WHERE id=?').get(id);
}
export function getById(id) {
  return shapeCampaign(getRawById(id));
}

// Paginated, optionally status-filtered campaign list. Never unbounded (GA-8).
export function list({ status, limit = 50, offset = 0 } = {}) {
  const lim = clampLimit(limit);
  const off = Math.max(0, Number(offset) || 0);
  let rows;
  let total;
  if (status) {
    rows = db.prepare('SELECT * FROM campaigns WHERE status=? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(status, lim, off);
    total = db.prepare('SELECT COUNT(*) c FROM campaigns WHERE status=?').get(status).c;
  } else {
    rows = db.prepare('SELECT * FROM campaigns ORDER BY created_at DESC LIMIT ? OFFSET ?').all(lim, off);
    total = db.prepare('SELECT COUNT(*) c FROM campaigns').get().c;
  }
  return { campaigns: rows.map(shapeCampaign), total, limit: lim, offset: off };
}

export function clampLimit(limit, def = 50, max = 100) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}

// ── holidays ─────────────────────────────────────────────────────────────
export function listHolidays({ limit = 100, offset = 0 } = {}) {
  const lim = clampLimit(limit, 100, 200);
  const off = Math.max(0, Number(offset) || 0);
  const rows = db.prepare('SELECT * FROM holidays ORDER BY month, day LIMIT ? OFFSET ?').all(lim, off);
  const total = db.prepare('SELECT COUNT(*) c FROM holidays').get().c;
  return { holidays: rows, total, limit: lim, offset: off };
}

export function createHoliday(input = {}, opts = {}) {
  const { name, month, day, emoji, defaultPercent, enabled } = input;
  if (typeof name !== 'string' || !name.trim()) bad('name is required');
  if (!Number.isInteger(month) || month < 1 || month > 12) bad('month must be an integer 1..12');
  if (!Number.isInteger(day) || day < 1 || day > 31) bad('day must be an integer 1..31');
  const pct = defaultPercent == null ? 15 : validatePercent(defaultPercent);
  const info = db.prepare(
    `INSERT INTO holidays (name,month,day,emoji,default_percent,enabled,created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(name.trim(), month, day, emoji || null, pct, enabled === 0 ? 0 : 1, toIso(opts.now));
  return db.prepare('SELECT * FROM holidays WHERE id=?').get(Number(info.lastInsertRowid));
}
