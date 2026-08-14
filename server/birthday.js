// ─────────────────────────────────────────────────────────────────────────
//  birthday.js — birthday discount: record, verify, grant.
//
//  Maryna, 31.07.2026:
//    "скидка 50$ на ДР от заказа 500$ … ДЕЙСТВУЕТ 1 месяц"
//    "Надо создать систему записи др клиентов в базу данных если они указали
//     его и попросили скидку … КаждЫЙ ЗАПРОС скидкИ ДР пользователем =
//     автоматическая проверка нами его даты рождения в базе данных, вдруг у
//     нас уже есть его дата ДР и мы можем сверить прежде чем давать скидку."
//
//  So: the FIRST claim records the date and is trusted; every later claim is
//  checked against the recorded date. A mismatch is refused and raised to the
//  admin instead of silently granting a second discount under a new date.
//  Every request — granted or not — is written to `birthday_claims`.
//
//  The amount, the minimum order and the validity window all come from the
//  `birthday` row in `discount_rules`, so the admin can switch $50 to a
//  percentage, change the $500 threshold or the 30 days without a deploy.
// ─────────────────────────────────────────────────────────────────────────
import { db } from './db.js';
import { getRule, computeDiscount } from './rules.js';
import { notifyCustomer, notifyAdmins } from './notify.js';

const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();

// ── pure date helpers (unit-testable, no DB) ──────────────────────────────

// Accepts YYYY-MM-DD, MM-DD, DD.MM.YYYY, DD/MM/YYYY. Returns
// { month, day, year|null } or null when the input is not a real date.
export function parseBirthday(input) {
  const s = String(input || '').trim();
  if (!s) return null;

  let year = null; let month = null; let day = null;

  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) { year = +m[1]; month = +m[2]; day = +m[3]; }

  if (month === null) {
    m = s.match(/^(\d{1,2})-(\d{1,2})$/);
    if (m) { month = +m[1]; day = +m[2]; }
  }
  if (month === null) {
    m = s.match(/^(\d{1,2})[./](\d{1,2})(?:[./](\d{4}))?$/);
    if (m) { day = +m[1]; month = +m[2]; year = m[3] ? +m[3] : null; }
  }
  if (month === null) return null;

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Reject impossible day-of-month (29 Feb is allowed — handled at grant time).
  const maxDay = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (day > maxDay) return null;
  if (year !== null && (year < 1900 || year > new Date().getUTCFullYear())) return null;

  return { year, month, day };
}

export const mmdd = (parsed) =>
  `${String(parsed.month).padStart(2, '0')}-${String(parsed.day).padStart(2, '0')}`;

// MM-DD of a stored 'YYYY-MM-DD' (or 'MM-DD') value.
export function mmddOf(stored) {
  const p = parseBirthday(stored);
  return p ? mmdd(p) : null;
}

// The discount window for a birthday: [birthday, birthday + validDays].
// Returns the occurrence that is currently open, or the next upcoming one.
// 29 February on a non-leap year falls back to 28 February.
export function birthdayWindow({ month, day }, now = Date.now(), validDays = 30) {
  const occurrence = (year) => {
    const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    const d = month === 2 && day === 29 && !isLeap ? 28 : day;
    const start = Date.UTC(year, month - 1, d);
    return { year, startsAt: start, endsAt: start + validDays * DAY };
  };

  const thisYear = new Date(now).getUTCFullYear();
  // Check last year too: a late-December birthday can still be inside its
  // window in early January.
  for (const y of [thisYear - 1, thisYear]) {
    const w = occurrence(y);
    if (now >= w.startsAt && now <= w.endsAt) return { ...w, open: true };
  }
  const next = occurrence(now < occurrence(thisYear).startsAt ? thisYear : thisYear + 1);
  return { ...next, open: false };
}

// ── the claim flow ────────────────────────────────────────────────────────

const FALLBACK_RULE = {
  key: 'birthday', kind: 'birthday', enabled: 1,
  mode: 'fixed', value: 50, min_order_usd: 500, valid_days: 30,
};

export async function birthdayRule() {
  return await getRule('birthday') || FALLBACK_RULE;
}

async function logClaim({ customerId, claimed, onFile, year, verdict, promoCodeId = null, note = null }) {
  try {
    await db.prepare(`INSERT INTO birthday_claims
      (customer_id,claimed_birthday,on_file_birthday,year,verdict,promo_code_id,note,created_at)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(customerId, claimed, onFile, year, verdict, promoCodeId, note, iso(Date.now()));
  } catch (e) {
    // The unique index only guards GRANTED rows; anything else here is a real
    // problem, but the claim result must still reach the caller.
    if (!String(e.message).includes('UNIQUE')) throw e;
  }
}

const genCode = (customerId) =>
  `BDAY-${String(customerId).padStart(3, '0')}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

// The single entry point. `customer` is a full row from `customers`.
// Returns { ok, verdict, message, discount?, promo?, window? } — never throws
// for business reasons, only for programming errors.
export async function claimBirthdayDiscount({ customer, birthdayInput, now = Date.now() }) {
  const rule = await birthdayRule();
  const year = new Date(now).getUTCFullYear();
  const onFile = customer.birthday || null;
  const onFileMmdd = onFile ? mmddOf(onFile) : null;

  if (!rule.enabled) {
    await logClaim({ customerId: customer.id, claimed: birthdayInput || null, onFile, year, verdict: 'disabled' });
    return { ok: false, verdict: 'disabled', message: 'Знижка на день народження зараз вимкнена.' };
  }

  // The client may omit the date when we already have one on file.
  const parsed = birthdayInput ? parseBirthday(birthdayInput) : (onFile ? parseBirthday(onFile) : null);
  if (!parsed) {
    await logClaim({ customerId: customer.id, claimed: birthdayInput || null, onFile, year, verdict: 'invalid_date' });
    return { ok: false, verdict: 'invalid_date', message: 'Вкажіть дату народження у форматі ДД.ММ.РРРР.' };
  }
  const claimedMmdd = mmdd(parsed);

  // ── the check Maryna asked for: do we already have a date on file? ──
  if (onFileMmdd && onFileMmdd !== claimedMmdd) {
    await logClaim({
      customerId: customer.id, claimed: claimedMmdd, onFile, year, verdict: 'mismatch',
      note: `у базі ${onFileMmdd}, у заявці ${claimedMmdd}`,
    });
    await notifyAdmins({
      kind: 'bday_mismatch',
      title: '⚠️ Дата народження не збігається',
      body: `${customer.name}: у базі ${onFileMmdd}, у заявці ${claimedMmdd}. Знижку не видано.`,
      dedupeKey: `bday-mismatch:${customer.id}:${year}:${claimedMmdd}`,
    });
    return {
      ok: false,
      verdict: 'mismatch',
      message: 'Дата не збігається з тією, що вже є у нас. Напишіть менеджеру — перевіримо.',
    };
  }

  // First claim → record the date. From now on it is the source of truth.
  if (!onFileMmdd) {
    const stored = parsed.year ? `${parsed.year}-${claimedMmdd}` : `1900-${claimedMmdd}`;
    await db.prepare('UPDATE customers SET birthday=?, birthday_source=?, birthday_recorded_at=? WHERE id=?')
      .run(stored, 'claim', iso(now), customer.id);
    customer.birthday = stored;
  }

  // One granted discount per calendar year.
  const already = await db.prepare(
    "SELECT id, created_at FROM birthday_claims WHERE customer_id=? AND year=? AND verdict='granted'"
  ).get(customer.id, year);
  if (already) {
    await logClaim({ customerId: customer.id, claimed: claimedMmdd, onFile, year, verdict: 'already_claimed' });
    return {
      ok: false,
      verdict: 'already_claimed',
      message: `Знижку на день народження вже отримано цього року (${iso(already.created_at).slice(0, 10)}).`,
    };
  }

  // The discount only exists inside its window.
  const validDays = rule.valid_days ?? 30;
  const win = birthdayWindow(parsed, now, validDays);
  if (!win.open) {
    await logClaim({ customerId: customer.id, claimed: claimedMmdd, onFile, year, verdict: 'out_of_window' });
    return {
      ok: false,
      verdict: 'out_of_window',
      message: `Знижка стане доступною ${new Date(win.startsAt).toISOString().slice(0, 10)} і діятиме ${validDays} днів.`,
      window: { startsAt: iso(win.startsAt), endsAt: iso(win.endsAt), open: false },
    };
  }

  // ── grant ──
  const preview = computeDiscount(rule, null);
  const code = genCode(customer.id);
  const info = await db.prepare(`INSERT INTO promo_codes
    (customer_id,code,percent,mode,amount_usd,min_order_usd,rule_key,reason,status,created_at,expires_at)
    VALUES (?,?,?,?,?,?,?,?, 'active',?,?)`).run(
    customer.id,
    code,
    rule.mode === 'percent' ? Math.round(Number(rule.value)) : 0,
    rule.mode,
    rule.mode === 'fixed' ? Number(rule.value) : null,
    Number(rule.min_order_usd || 0),
    'birthday',
    'День народження 🎂',
    iso(now),
    iso(win.endsAt),
  );
  const promoId = Number(info.lastInsertRowid);

  await logClaim({ customerId: customer.id, claimed: claimedMmdd, onFile, year, verdict: 'granted', promoCodeId: promoId });

  const amountLabel = rule.mode === 'percent' ? `${rule.value}%` : `$${rule.value}`;
  const minLabel = rule.min_order_usd ? ` від замовлення $${rule.min_order_usd}` : '';
  await notifyCustomer({
    customerId: customer.id,
    kind: 'birthday',
    title: 'Вітаємо з днем народження! 🎂',
    body: `Ваша знижка ${amountLabel}${minLabel}. Промокод ${code}, діє до ${iso(win.endsAt).slice(0, 10)}.`,
    promoCodeId: promoId,
    dedupeKey: `bday:${customer.id}:${year}`,
  });

  return {
    ok: true,
    verdict: 'granted',
    message: `Знижка ${amountLabel} ваша! Промокод ${code}.`,
    discount: { mode: rule.mode, value: Number(rule.value), amountUsd: preview.amountUsd, minOrderUsd: Number(rule.min_order_usd || 0) },
    promo: { id: promoId, code, expiresAt: iso(win.endsAt) },
    window: { startsAt: iso(win.startsAt), endsAt: iso(win.endsAt), open: true },
  };
}

// What the client should see on the birthday card before they tap it.
export async function birthdayStatus(customer, now = Date.now()) {
  const rule = await birthdayRule();
  const year = new Date(now).getUTCFullYear();
  const parsed = customer?.birthday ? parseBirthday(customer.birthday) : null;
  const granted = customer
    ? await db.prepare("SELECT id, created_at FROM birthday_claims WHERE customer_id=? AND year=? AND verdict='granted'").get(customer.id, year)
    : null;

  const base = {
    enabled: Boolean(rule.enabled),
    mode: rule.mode,
    value: Number(rule.value),
    minOrderUsd: Number(rule.min_order_usd || 0),
    validDays: rule.valid_days ?? 30,
    knownBirthday: parsed ? mmdd(parsed) : null,
    claimedThisYear: Boolean(granted),
  };
  if (!parsed) return { ...base, state: 'unknown_date' };
  const win = birthdayWindow(parsed, now, base.validDays);
  if (granted) return { ...base, state: 'claimed' };
  return {
    ...base,
    state: win.open ? 'available' : 'upcoming',
    window: { startsAt: iso(win.startsAt), endsAt: iso(win.endsAt), open: win.open },
  };
}

// ── reads for the admin panel ─────────────────────────────────────────────

export async function claimsFor(customerId, { limit = 20 } = {}) {
  return await db.prepare(
    `SELECT id, claimed_birthday, on_file_birthday, year, verdict, promo_code_id, note, created_at
       FROM birthday_claims WHERE customer_id=? ORDER BY created_at DESC LIMIT ?`
  ).all(customerId, clamp(limit, 20, 100));
}

export async function allClaims({ limit = 50, verdict = null } = {}) {
  const lim = clamp(limit, 50, 200);
  const rows = verdict
    ? await db.prepare(
        `SELECT bc.*, c.name, c.tg_user_id FROM birthday_claims bc
           JOIN customers c ON c.id = bc.customer_id
          WHERE bc.verdict=? ORDER BY bc.created_at DESC LIMIT ?`
      ).all(verdict, lim)
    : await db.prepare(
        `SELECT bc.*, c.name, c.tg_user_id FROM birthday_claims bc
           JOIN customers c ON c.id = bc.customer_id
          ORDER BY bc.created_at DESC LIMIT ?`
      ).all(lim);
  return rows.map((r) => ({
    id: r.id,
    customerId: r.customer_id,
    name: r.name,
    tgId: r.tg_user_id,
    claimed: r.claimed_birthday,
    onFile: r.on_file_birthday,
    year: r.year,
    verdict: r.verdict,
    note: r.note,
    createdAt: r.created_at,
  }));
}

// Clients whose birthday window opens today — the scheduler uses this to send
// "your birthday discount is available" without waiting for them to ask.
export async function birthdaysOpeningToday(now = Date.now()) {
  const d = new Date(now);
  const key = `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  return await db.prepare(
    `SELECT * FROM customers WHERE birthday IS NOT NULL AND substr(birthday, 6, 5) = ?`
  ).all(key);
}

function clamp(v, def, max) {
  const n = Number(v) || def;
  return Math.min(Math.max(n, 1), max);
}
