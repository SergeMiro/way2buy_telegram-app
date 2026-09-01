// ─────────────────────────────────────────────────────────────────────────
//  settings.js — every number the shop can tune, in one place.
//
//  Each of these used to be an environment variable. On Vercel that makes
//  «нагадувати через 7 днів, а не 5» a redeploy, which is why in practice not
//  one of them was ever changed. They are rows in `app_settings` now and a text
//  field in «Параметри» in the cabinet.
//
//  DEFINITIONS IS THE SOURCE OF TRUTH — not the table. The table holds key →
//  value and nothing else; the label, the unit, the bounds and the group live
//  here, beside the code that reads them, for three reasons:
//    • the bounds are validation the server must enforce anyway, and validation
//      that lives in editable data is validation somebody can edit away;
//    • a typo in a Ukrainian label should be a one-line diff, not a migration;
//    • a row nobody defines is ignored rather than obeyed, so a stray INSERT
//      into this table cannot introduce behaviour.
//
//  RESOLUTION. `num()` reads the row. If the table has no row — a database that
//  predates it, or a read that raced the first boot — the definition's default
//  answers, so no caller ever gets NaN and nothing has to be migrated before the
//  app will start. The environment variable is consulted exactly once, by
//  seedSettings(), as the value the row is CREATED with: a shop already running
//  with W2B_ABANDON_HOURS=8 keeps 8, and after that the cabinet owns the number.
//
//  CACHING. The whole table is one small read, cached for a few seconds like
//  roles.js does — these values are read on nearly every sync page, every photo
//  and every scheduler tick, and a settings lookup must not be a round trip each
//  time. A write invalidates immediately, so saving in the cabinet is visible at
//  once rather than "in a moment".
// ─────────────────────────────────────────────────────────────────────────
import { db } from './db.js';

// kind drives only how the UI renders the unit; the server treats every value
// as a number and clamps it to [min, max].
export const DEFINITIONS = [
  // ── Продажі ────────────────────────────────────────────────────────────
  {
    key: 'deal.followup_enabled', group: 'Продажі', sort: 9,
    label: 'Нагадувати про угоди', kind: 'switch',
    def: 1, min: 0, max: 1, step: 1,
    env: 'W2B_DEAL_FOLLOWUP_ENABLED', envBool: true,
    hint: 'Вимкнено — три вкладки і статуси працюють як завжди, просто «клієнт у процесі, купив?» більше не приходить.',
  },
  {
    key: 'deal.followup_days', group: 'Продажі', sort: 10,
    label: 'Нагадувати про угоду в процесі кожні', kind: 'days',
    def: 5, min: 1, max: 90, step: 1, env: 'W2B_DEAL_FOLLOWUP_DAYS',
    hint: 'Через стільки днів Marina і Даша отримають «клієнт у процесі, купив?» — і далі з тим самим кроком, поки статус не змінять.',
  },

  // ── Примірочна ─────────────────────────────────────────────────────────
  {
    key: 'abandon.enabled', group: 'Примірочна', sort: 19,
    label: 'Давати знижку за покинуту примірочну', kind: 'switch',
    def: 1, min: 0, max: 1, step: 1,
    env: 'W2B_ABANDON_ENABLED', envBool: true,
    hint: 'Вимкнено — нічого не нараховується й не надсилається. Хто знижку вже отримав, її не втрачає.',
  },
  {
    key: 'abandon.hours', group: 'Примірочна', sort: 20,
    label: 'Чекати перед знижкою за покинуту примірочну', kind: 'hours',
    def: 5, min: 1, max: 336, step: 1, env: 'W2B_ABANDON_HOURS',
    hint: 'Клієнт набрав речі й не натиснув «Відправити». Знижка йде один раз на людину — зміна цього числа створює НОВЕ правило, тому той, хто вже отримав старе, отримає й нове.',
  },
  {
    key: 'abandon.percent', group: 'Примірочна', sort: 21,
    label: 'Розмір цієї знижки', kind: 'percent',
    def: 10, min: 1, max: 90, step: 1, env: 'W2B_ABANDON_PERCENT',
    hint: 'Так само входить у назву правила: 5 годин і 10% — це «5hour_10per».',
  },
  {
    key: 'abandon.valid_days', group: 'Примірочна', sort: 22,
    label: 'Скільки днів вона діє', kind: 'days',
    def: 7, min: 1, max: 120, step: 1, env: 'W2B_ABANDON_VALID_DAYS',
  },
  {
    key: 'abandon.min_order_usd', group: 'Примірочна', sort: 23,
    label: 'Мінімальне замовлення для неї', kind: 'usd',
    def: 0, min: 0, max: 100000, step: 10, env: 'W2B_ABANDON_MIN_ORDER',
    hint: '0 — без мінімуму.',
  },

  // ── Витрина і синхронізація ────────────────────────────────────────────
  {
    key: 'catalog.months', group: 'Витрина', sort: 30,
    label: 'Скільки місяців каналу тримати у витрині', kind: 'months',
    def: 3, min: 0, max: 120, step: 1, env: 'W2B_CATALOG_MONTHS',
    hint: '0 — тримати все. Розширення вікна саме собою нічого не додасть: щоб добрати старіші пости, потрібен ще один прохід «вся історія».',
  },
  {
    key: 'sync.pages', group: 'Витрина', sort: 31,
    label: 'Сторінок каналу за один прохід «Синхронізувати»', kind: 'count',
    def: 4, min: 1, max: 50, step: 1, env: 'W2B_SYNC_PAGES',
    hint: 'Більше — швидше, але один виклик на Vercel живе секунди: завеликий крок не встигне завершитись.',
  },
  {
    key: 'sync.tme_delay_ms', group: 'Витрина', sort: 32,
    label: 'Пауза між запитами до Telegram', kind: 'ms',
    def: 700, min: 100, max: 10000, step: 50, env: 'W2B_TME_DELAY_MS',
    hint: 'Це публічна веб-сторінка каналу, і бекфіл просить її тисячі разів. Занизька пауза — шлях до блокування.',
  },

  // ── Фото ───────────────────────────────────────────────────────────────
  {
    key: 'photo.width', group: 'Фото', sort: 40,
    label: 'Ширина збереженого фото', kind: 'px',
    def: 720, min: 240, max: 2048, step: 20, env: 'W2B_PHOTO_WIDTH',
    hint: 'Джерело — 800×800, тож більше за 800 нічого не додасть, лише займе місце.',
  },
  {
    key: 'photo.quality', group: 'Фото', sort: 41,
    label: 'Якість JPEG', kind: 'percent',
    def: 76, min: 40, max: 95, step: 1, env: 'W2B_PHOTO_QUALITY',
    hint: '720px при 76 — близько 77 КБ на карточку, тобто вся витрина ≈ 0,46 ГБ із 1 ГБ тарифу.',
  },
  {
    key: 'photo.max_mb', group: 'Фото', sort: 42,
    label: 'Не копіювати фото важче', kind: 'mb',
    def: 5, min: 1, max: 25, step: 1, env: 'W2B_PHOTO_MAX_BYTES', envScale: 1 / (1024 * 1024),
  },
  {
    key: 'photo.keep', group: 'Фото', sort: 43,
    label: 'Скільки фото з поста зберігати назавжди', kind: 'count',
    def: 1, min: 1, max: 10, step: 1, env: 'W2B_PHOTO_KEEP',
    hint: 'Решта залишаються посиланнями Telegram, які з часом перестають відкриватись.',
  },

  // ── ШІ ─────────────────────────────────────────────────────────────────
  {
    key: 'vision.batch', group: 'ШІ', sort: 50,
    label: 'Скільки фото за раз віддавати на розпізнавання бренду', kind: 'count',
    def: 8, min: 1, max: 50, step: 1, env: 'W2B_VISION_BATCH',
    hint: 'Єдина робота планувальника, що коштує за кожну позицію.',
  },
  {
    key: 'llm.timeout_ms', group: 'ШІ', sort: 51,
    label: 'Таймаут одного запиту до моделі', kind: 'ms',
    def: 25000, min: 2000, max: 120000, step: 1000, env: 'W2B_LLM_TIMEOUT_MS',
  },
  {
    key: 'llm.budget_ms', group: 'ШІ', sort: 52,
    label: 'Бюджет часу на весь ланцюг моделей', kind: 'ms',
    def: 60000, min: 5000, max: 300000, step: 5000, env: 'W2B_LLM_BUDGET_MS',
    hint: 'Ланцюг пробує моделі одну за одною; коли бюджет вичерпано — віддає те, що є.',
  },

  // ── Планувальник ───────────────────────────────────────────────────────
  {
    key: 'scheduler.interval_min', group: 'Планувальник', sort: 60,
    label: 'Як часто планувальник перевіряє справи', kind: 'minutes',
    def: 15, min: 1, max: 1440, step: 1, env: 'SCHEDULER_INTERVAL_MIN',
    hint: 'Дні народження, собівартість, покинуті примірочні, угоди в процесі, акції, бренди з фото. На Vercel постійного процесу немає — там це робить зовнішній cron, і тут число ні на що не впливає.',
  },
];

const BY_KEY = new Map(DEFINITIONS.map((d) => [d.key, d]));

export const definitionOf = (key) => BY_KEY.get(key) || null;

export class SettingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SettingError';
    this.status = 400;
  }
}

// ── cache ─────────────────────────────────────────────────────────────────

let cache = null;
let cacheAt = 0;
const TTL_MS = 5000;

export function invalidate() {
  cache = null;
  cacheAt = 0;
}

async function load(now = Date.now()) {
  if (cache && now - cacheAt < TTL_MS) return cache;
  const map = new Map();
  try {
    for (const r of await db.prepare('SELECT key, value FROM app_settings').all()) {
      map.set(r.key, Number(r.value));
    }
  } catch {
    // A database that predates the table must not take the app down: every
    // definition has a default and that is what answers below.
  }
  cache = map;
  cacheAt = now;
  return map;
}

/**
 * One number. Never throws, never returns NaN: an unknown key is a programming
 * mistake and gets 0, a missing row gets the definition's default.
 */
export async function num(key) {
  const def = BY_KEY.get(key);
  if (!def) return 0;
  const stored = (await load()).get(key);
  const value = Number.isFinite(stored) ? stored : def.def;
  return clamp(def, value);
}

/**
 * A switch, as a boolean. Stored in the same numeric column as everything else
 * — 1 or 0 — because a second column type for two settings would be a second
 * code path for every read, write and validation in this file.
 */
export async function flag(key) {
  return (await num(key)) === 1;
}

/** Several at once, without one round trip each. */
export async function nums(...keys) {
  await load();
  const out = {};
  for (const k of keys) out[k] = await num(k);
  return out;
}

function clamp(def, value) {
  let v = Number(value);
  if (!Number.isFinite(v)) v = def.def;
  if (def.min != null) v = Math.max(def.min, v);
  if (def.max != null) v = Math.min(def.max, v);
  return v;
}

// ── the cabinet ───────────────────────────────────────────────────────────

/** Definitions plus current values, grouped in display order — what the UI draws. */
export async function all() {
  const stored = await load();
  const rows = [...DEFINITIONS]
    .sort((a, b) => a.sort - b.sort)
    .map((d) => ({
      key: d.key,
      group: d.group,
      label: d.label,
      hint: d.hint || null,
      kind: d.kind,
      min: d.min,
      max: d.max,
      step: d.step,
      value: clamp(d, Number.isFinite(stored.get(d.key)) ? stored.get(d.key) : d.def),
      def: d.def,
      // Whether this is still the value the app was first installed with. The
      // cabinet uses it to show «за замовчуванням» rather than making somebody
      // remember what the default was.
      isDefault: !stored.has(d.key) || Number(stored.get(d.key)) === d.def,
    }));

  const groups = [];
  for (const row of rows) {
    let g = groups.find((x) => x.title === row.group);
    if (!g) { g = { title: row.group, items: [] }; groups.push(g); }
    g.items.push(row);
  }
  return { groups, rows };
}

/**
 * Write one setting. Refuses anything the definition does not allow — an out of
 * range number is rejected rather than quietly clamped, because a field that
 * silently stores something else than what was typed is worse than an error.
 */
export async function set(key, value, { by = null, now = Date.now() } = {}) {
  const def = BY_KEY.get(key);
  if (!def) throw new SettingError(`невідомий параметр «${key}»`);
  const v = Number(value);
  if (!Number.isFinite(v)) throw new SettingError(`«${def.label}»: потрібно число`);
  if (def.min != null && v < def.min) throw new SettingError(`«${def.label}»: не менше ${def.min}`);
  if (def.max != null && v > def.max) throw new SettingError(`«${def.label}»: не більше ${def.max}`);

  await db.prepare(
    // RETURNING key, and not by accident: the statement wrapper appends
    // `RETURNING id` to any INSERT that does not name one, and this table's
    // primary key is the key itself — there is no id column to return.
    `INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES (?,?,?,?)
     ON CONFLICT (key) DO UPDATE SET value=excluded.value,
       updated_at=excluded.updated_at, updated_by=excluded.updated_by
     RETURNING key`
  ).run(key, v, new Date(now).toISOString(), by ? String(by) : null);
  invalidate();
  return v;
}

/** Several, as one transaction of intent: validate everything, then write. */
export async function setMany(values, { by = null, now = Date.now() } = {}) {
  const entries = Object.entries(values || {});
  // Validated in full BEFORE anything is written, so a form with one bad field
  // does not half-save.
  for (const [key, value] of entries) {
    const def = BY_KEY.get(key);
    if (!def) throw new SettingError(`невідомий параметр «${key}»`);
    const v = Number(value);
    if (!Number.isFinite(v)) throw new SettingError(`«${def.label}»: потрібно число`);
    if (def.min != null && v < def.min) throw new SettingError(`«${def.label}»: не менше ${def.min}`);
    if (def.max != null && v > def.max) throw new SettingError(`«${def.label}»: не більше ${def.max}`);
  }
  for (const [key, value] of entries) await set(key, value, { by, now });
  return entries.length;
}

/** Back to the value the shop was installed with. */
export async function reset(key, opts = {}) {
  const def = BY_KEY.get(key);
  if (!def) throw new SettingError(`невідомий параметр «${key}»`);
  return await set(key, def.def, opts);
}

// ── first boot ────────────────────────────────────────────────────────────

/**
 * Creates the rows, once. `ON CONFLICT DO NOTHING` is what makes a restart
 * unable to undo an edit made in the cabinet — the same rule discount_rules and
 * the channel list already follow.
 *
 * The environment variable is read here and only here: a shop already running
 * with a non-default value keeps it, and from then on the number belongs to the
 * cabinet. `envScale` exists for the one setting whose unit changed on the way
 * in — bytes in the variable, megabytes on the screen.
 */
export async function seedSettings() {
  const params = [];
  for (const d of DEFINITIONS) {
    const raw = d.env ? process.env[d.env] : '';
    const unset = raw === undefined || raw === null || String(raw).trim() === '';
    let fromEnv = null;
    if (!unset) {
      // A switch keeps the semantics its variable already had: ONLY '0' turned
      // the rule off, anything else left it on. Changing that quietly would
      // re-enable a rule somebody had deliberately disabled.
      fromEnv = d.envBool
        ? (String(raw).trim() === '0' ? 0 : 1)
        : Number(raw) * (d.envScale || 1);
    }
    params.push(d.key, clamp(d, Number.isFinite(fromEnv) ? fromEnv : d.def));
  }
  // ONE statement, not one per setting. This runs on every boot, and on a
  // serverless host every cold start is a boot — seventeen round trips there
  // would be seventeen round trips on the first request somebody waits for.
  //
  // RETURNING key for the reason described in set(); with DO NOTHING a row that
  // already existed returns nothing, so `changes` counts exactly the ones this
  // call created.
  const tuples = DEFINITIONS.map(() => '(?,?)').join(',');
  try {
    const info = await db.prepare(
      `INSERT INTO app_settings (key, value) VALUES ${tuples}
       ON CONFLICT (key) DO NOTHING RETURNING key`
    ).run(...params);
    const created = info.changes || 0;
    if (created) invalidate();
    return { created, total: DEFINITIONS.length };
  } catch (e) {
    // A database that has not had the table created yet must not stop the app
    // from starting: num() falls back to the definitions until it does.
    //
    // LOUD, though. A seed that fails invisibly is how an instance ends up
    // quietly running on defaults while the table sits empty and nobody can
    // tell why — which is exactly what happened the first time this shipped.
    console.error('[settings] seed failed:', e.message || e);
    return { created: 0, total: DEFINITIONS.length, error: String(e.message || e) };
  }
}
