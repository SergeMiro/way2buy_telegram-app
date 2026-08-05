// ─────────────────────────────────────────────────────────────────────────
//  rules.js — the admin-editable bonus rules.
//
//  Maryna's requirement (31.07.2026): every discount must be switchable
//  between a dollar amount and a percentage from the admin panel, and the
//  same must hold for holiday discounts. So there is exactly ONE place that
//  turns a rule + an order total into money: `computeDiscount()`. Cashback,
//  birthday and holidays all go through it, which is what makes the $/%
//  toggle work everywhere without special cases.
//
//  Rules live in the `discount_rules` table (created and defaulted in db.js);
//  holidays live in `holidays` with the same mode/value/min_order columns.
// ─────────────────────────────────────────────────────────────────────────
import { db } from './db.js';

export const MODES = ['fixed', 'percent'];

export class RuleValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RuleValidationError';
  }
}

const bad = (msg) => {
  throw new RuleValidationError(msg);
};

const round2 = (n) => Math.round(n * 100) / 100;

// ── read ──────────────────────────────────────────────────────────────────

export async function getRule(key) {
  return await db.prepare('SELECT * FROM discount_rules WHERE key=?').get(key) || null;
}

export async function listRules() {
  return (await db.prepare('SELECT * FROM discount_rules ORDER BY id').all()).map(shapeRule);
}

export function shapeRule(r) {
  if (!r) return null;
  return {
    key: r.key,
    kind: r.kind,
    name: r.name,
    emoji: r.emoji,
    enabled: Boolean(r.enabled),
    mode: r.mode,
    value: r.value,
    minOrderUsd: r.min_order_usd ?? 0,
    capUsd: r.cap_usd ?? null,
    validDays: r.valid_days ?? null,
    // Ukrainian one-liner the admin panel shows under the rule so a
    // non-technical owner can read back what she just configured.
    summary: describeRule(r),
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

export function describeRule(r) {
  if (!r) return '';
  const amount = r.mode === 'percent' ? `${fmtNum(r.value)}%` : `$${fmtNum(r.value)}`;
  const min = r.min_order_usd ? ` від замовлення $${fmtNum(r.min_order_usd)}` : '';
  if (r.kind === 'cashback') {
    const cap = r.cap_usd ? `, накопичення максимум $${fmtNum(r.cap_usd)}` : '';
    return `${amount} за кожну покупку${min || ' будь-якої суми'}${cap}`;
  }
  if (r.kind === 'birthday') {
    const days = r.valid_days ? `, діє ${r.valid_days} дн.` : '';
    return `${amount}${min}${days}`;
  }
  return `${amount}${min}`;
}

function fmtNum(n) {
  const v = Number(n) || 0;
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

// ── the single money calculation ──────────────────────────────────────────

// Turn a rule (or a holiday row — same column shape) + an order total into a
// discount in USD. Returns `{ applicable, amountUsd, reason }`.
//
// `orderUsd` may be null when we only want to know whether the rule is on and
// what it would give on a qualifying order (percent rules then return null
// because the amount depends on the order).
export function computeDiscount(rule, orderUsd = null) {
  if (!rule) return { applicable: false, amountUsd: 0, reason: 'no_rule' };
  if (!rule.enabled) return { applicable: false, amountUsd: 0, reason: 'disabled' };

  const min = Number(rule.min_order_usd ?? rule.minOrderUsd ?? 0);
  const mode = rule.mode;
  const value = Number(rule.value);

  if (orderUsd === null || orderUsd === undefined) {
    return {
      applicable: true,
      amountUsd: mode === 'fixed' ? round2(value) : null,
      reason: 'no_order_context',
    };
  }

  const order = Number(orderUsd);
  if (!Number.isFinite(order) || order <= 0) {
    return { applicable: false, amountUsd: 0, reason: 'invalid_order' };
  }
  if (order < min) {
    return { applicable: false, amountUsd: 0, reason: 'below_min_order', minOrderUsd: min };
  }

  // A discount can never exceed the order itself.
  const raw = mode === 'percent' ? (order * value) / 100 : value;
  return { applicable: true, amountUsd: round2(Math.min(raw, order)), reason: 'ok' };
}

// ── write ─────────────────────────────────────────────────────────────────

const RULE_FIELDS = {
  enabled: (v) => Boolean(v),
  mode: (v) => {
    if (!MODES.includes(v)) bad(`mode must be one of ${MODES.join('|')}`);
    return v;
  },
  value: (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) bad('value must be a positive number');
    return n;
  },
  min_order_usd: (v) => nonNegative(v, 'minOrderUsd'),
  cap_usd: (v) => (v === null || v === '' ? null : nonNegative(v, 'capUsd')),
  valid_days: (v) => {
    if (v === null || v === '') return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 365) bad('validDays must be 1..365');
    return n;
  },
  name: (v) => String(v).slice(0, 80),
};

function nonNegative(v, label) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) bad(`${label} must be >= 0`);
  return n;
}

// Accepts camelCase from the admin UI and maps it onto the columns.
const PATCH_ALIASES = {
  minOrderUsd: 'min_order_usd',
  capUsd: 'cap_usd',
  validDays: 'valid_days',
};

export async function updateRule(key, patch = {}, updatedBy = null) {
  const current = await getRule(key);
  if (!current) return null;

  const sets = {};
  for (const [rawKey, rawValue] of Object.entries(patch)) {
    const col = PATCH_ALIASES[rawKey] || rawKey;
    const coerce = RULE_FIELDS[col];
    if (!coerce) continue; // silently ignore unknown fields (forward-compatible UI)
    sets[col] = coerce(rawValue);
  }

  // A percent rule with a value above 90 is almost certainly a typo ($ entered
  // while the toggle says %) — that mistake would be expensive, so we block it.
  const mode = sets.mode ?? current.mode;
  const value = sets.value ?? current.value;
  if (mode === 'percent' && value > 90) bad('percent value must be <= 90');

  if (Object.keys(sets).length === 0) return shapeRule(current);

  const assignments = Object.keys(sets).map((c) => `${c}=@${c}`).join(', ');
  await db.prepare(`UPDATE discount_rules SET ${assignments}, updated_at=@updated_at, updated_by=@updated_by WHERE key=@key`)
    .run({ ...sets, key, updated_at: new Date().toISOString(), updated_by: updatedBy });

  return shapeRule(await getRule(key));
}

// ── holidays: same shape, same $/% switch ─────────────────────────────────

export async function listHolidays() {
  return (await db.prepare('SELECT * FROM holidays ORDER BY month, day').all()).map(shapeHoliday);
}

export function shapeHoliday(h) {
  if (!h) return null;
  return {
    id: h.id,
    name: h.name,
    emoji: h.emoji,
    month: h.month,
    day: h.day,
    date: `${String(h.month).padStart(2, '0')}-${String(h.day).padStart(2, '0')}`,
    enabled: Boolean(h.enabled),
    mode: h.mode || 'percent',
    value: h.value ?? h.default_percent,
    minOrderUsd: h.min_order_usd ?? 0,
    validDays: h.valid_days ?? 14,
    summary: describeRule({ kind: 'holiday', mode: h.mode || 'percent', value: h.value ?? h.default_percent, min_order_usd: h.min_order_usd }),
  };
}

const HOLIDAY_FIELDS = {
  enabled: RULE_FIELDS.enabled,
  mode: RULE_FIELDS.mode,
  value: RULE_FIELDS.value,
  min_order_usd: RULE_FIELDS.min_order_usd,
  valid_days: (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 365) bad('validDays must be 1..365');
    return n;
  },
  name: RULE_FIELDS.name,
  month: (v) => intInRange(v, 1, 12, 'month'),
  day: (v) => intInRange(v, 1, 31, 'day'),
  emoji: (v) => String(v).slice(0, 8),
};

function intInRange(v, lo, hi, label) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) bad(`${label} must be ${lo}..${hi}`);
  return n;
}

export async function updateHoliday(id, patch = {}, updatedBy = null) {
  const current = await db.prepare('SELECT * FROM holidays WHERE id=?').get(id);
  if (!current) return null;

  const sets = {};
  for (const [rawKey, rawValue] of Object.entries(patch)) {
    const col = PATCH_ALIASES[rawKey] || rawKey;
    const coerce = HOLIDAY_FIELDS[col];
    if (!coerce) continue;
    sets[col] = coerce(rawValue);
  }
  const mode = sets.mode ?? current.mode ?? 'percent';
  const value = sets.value ?? current.value ?? current.default_percent;
  if (mode === 'percent' && value > 90) bad('percent value must be <= 90');
  if (Object.keys(sets).length === 0) return shapeHoliday(current);

  const assignments = Object.keys(sets).map((c) => `${c}=@${c}`).join(', ');
  await db.prepare(`UPDATE holidays SET ${assignments} WHERE id=@id`).run({ ...sets, id });
  void updatedBy; // holidays carry no audit column yet; kept for signature parity
  return shapeHoliday(await db.prepare('SELECT * FROM holidays WHERE id=?').get(id));
}

export async function createHoliday(input = {}) {
  const name = String(input.name || '').trim();
  if (!name) bad('name required');
  const month = intInRange(input.month, 1, 12, 'month');
  const day = intInRange(input.day, 1, 31, 'day');
  const mode = RULE_FIELDS.mode(input.mode || 'percent');
  const value = RULE_FIELDS.value(input.value);
  if (mode === 'percent' && value > 90) bad('percent value must be <= 90');

  const info = await db.prepare(`INSERT INTO holidays
    (name,month,day,emoji,default_percent,enabled,mode,value,min_order_usd,valid_days,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    name, month, day, input.emoji || '🎉',
    mode === 'percent' ? Math.round(value) : 0,
    input.enabled !== false,
    mode, value, Number(input.minOrderUsd || 0), Number(input.validDays || 14),
    new Date().toISOString(),
  );
  return shapeHoliday(await db.prepare('SELECT * FROM holidays WHERE id=?').get(info.lastInsertRowid));
}

// Holidays whose day is within [today, today + validDays] — i.e. currently
// giving a discount. Used by the client "which discounts can I use" view.
export async function activeHolidays(now = Date.now()) {
  const rows = await db.prepare('SELECT * FROM holidays WHERE enabled').all();
  const d = new Date(now);
  const out = [];
  for (const h of rows) {
    const validDays = h.valid_days ?? 14;
    // Check this year's and last year's occurrence (a late-December holiday
    // can still be active in early January).
    for (const year of [d.getUTCFullYear(), d.getUTCFullYear() - 1]) {
      const start = Date.UTC(year, h.month - 1, h.day);
      const end = start + validDays * 86400000;
      if (now >= start && now <= end) {
        out.push({ ...shapeHoliday(h), startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString() });
        break;
      }
    }
  }
  return out;
}
