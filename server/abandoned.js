// ─────────────────────────────────────────────────────────────────────────
//  abandoned.js — the fitting room somebody filled and then walked away from.
//
//  A client picks three bags, does not press «Відправити», and closes the app.
//  Nothing about that is a refusal: they chose those three things. It is the
//  most qualified moment in the whole shop and until now it produced silence.
//
//  Five hours later they get one message with a discount. Once. Ever.
//
//  ONCE IS THE HARD PART, and it is not enforced by an `if`. `customer_grants`
//  holds a UNIQUE (customer_id, grant_key), the insert is the FIRST thing that
//  happens, and the message is only sent if that insert actually created a row.
//  Two scheduler ticks racing, a cron firing twice, a retry after a timeout —
//  all of them lose the insert and none of them sends a second discount. The
//  order matters: send-then-record can double-send, record-then-send cannot.
//
//  The rule names itself. Hours and percentage are settings, and the grant key
//  is built from them — five hours and ten per cent is '5hour_10per', which
//  reads the same in the database as it does in the conversation. Change the
//  setting and it becomes a DIFFERENT rule with a different key, which is
//  correct: somebody who was given the old offer has not been given the new one.
// ─────────────────────────────────────────────────────────────────────────
import { db } from './db.js';
import { notifyCustomer } from './notify.js';

const HOUR = 3600_000;
const iso = (ms) => new Date(ms).toISOString();

export function config() {
  const hours = Math.max(1, Number(process.env.W2B_ABANDON_HOURS || 5));
  const percent = Math.max(1, Math.min(90, Number(process.env.W2B_ABANDON_PERCENT || 10)));
  const validDays = Math.max(1, Number(process.env.W2B_ABANDON_VALID_DAYS || 7));
  const minOrderUsd = Math.max(0, Number(process.env.W2B_ABANDON_MIN_ORDER || 0));
  return {
    hours,
    percent,
    validDays,
    minOrderUsd,
    // '5hour_10per'
    grantKey: `${hours}hour_${percent}per`,
    enabled: process.env.W2B_ABANDON_ENABLED !== '0',
  };
}

const genCode = (customerId, percent) =>
  `WAIT${percent}-${String(customerId).padStart(3, '0')}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

/** Has this person already been given this particular one-off? */
export async function hasGrant(customerId, grantKey) {
  const row = await db.prepare('SELECT 1 FROM customer_grants WHERE customer_id=? AND grant_key=?')
    .get(customerId, grantKey);
  return Boolean(row);
}

export async function grantsFor(customerId) {
  return await db.prepare(
    'SELECT grant_key, granted_at, promo_code_id FROM customer_grants WHERE customer_id=? ORDER BY granted_at DESC'
  ).all(customerId);
}

/**
 * Who is sitting on a full fitting room they never asked about.
 *
 * `status='active'` already means "not sent" — sending an inquiry moves every
 * item to 'sent' — so an active item older than the window IS an unanswered
 * intention. No second query is needed to prove they did not write.
 */
export async function pending(now = Date.now(), { hours } = config()) {
  const cutoff = iso(now - hours * HOUR);
  return await db.prepare(
    `SELECT ci.customer_id                AS customer_id,
            COUNT(*)                      AS items,
            MIN(ci.created_at)            AS oldest,
            SUM(COALESCE(ci.price, 0))    AS basket
       FROM cart_items ci
      WHERE ci.status = 'active'
      GROUP BY ci.customer_id
     HAVING MIN(ci.created_at) <= ?
      ORDER BY MIN(ci.created_at)`
  ).all(cutoff);
}

/**
 * The job. Idempotent, and safe to call as often as anybody likes.
 * Returns { candidates, granted, skipped } — skipped being the people who
 * already had it, which is the number that should grow and then stop.
 */
export async function remindAbandoned(now = Date.now()) {
  const cfg = config();
  if (!cfg.enabled) return { skipped: true, reason: 'disabled' };

  const rows = await pending(now, cfg);
  let granted = 0;
  let alreadyHad = 0;

  for (const row of rows) {
    const customerId = Number(row.customer_id);
    if (!customerId) continue;

    // RECORD FIRST. If this returns zero rows changed, somebody else already
    // gave this person the offer and we must not send a second message.
    const claim = await db.prepare(
      `INSERT INTO customer_grants (customer_id, grant_key, granted_at, meta)
       VALUES (?,?,?,?)
       ON CONFLICT (customer_id, grant_key) DO NOTHING`
    ).run(customerId, cfg.grantKey, iso(now),
      JSON.stringify({ items: Number(row.items) || 0, oldest: row.oldest, hours: cfg.hours }));
    if (!claim.changes) { alreadyHad += 1; continue; }

    const code = genCode(customerId, cfg.percent);
    const expiresAt = iso(now + cfg.validDays * 24 * HOUR);
    const promo = await db.prepare(
      `INSERT INTO promo_codes
         (customer_id,code,percent,mode,amount_usd,min_order_usd,rule_key,reason,status,created_at,expires_at)
       VALUES (?,?,?, 'percent', NULL, ?, ?, ?, 'active', ?, ?)`
    ).run(customerId, code, cfg.percent, cfg.minOrderUsd, cfg.grantKey,
      'Речі чекають у примірочній', iso(now), expiresAt);
    const promoId = Number(promo.lastInsertRowid);
    await db.prepare('UPDATE customer_grants SET promo_code_id=? WHERE customer_id=? AND grant_key=?')
      .run(promoId, customerId, cfg.grantKey);

    const n = Number(row.items) || 0;
    await notifyCustomer({
      customerId,
      kind: 'abandoned_cart',
      title: 'Ваші речі чекають у примірочній 👜',
      body: `Ви обрали ${n} ${plural(n, ['позицію', 'позиції', 'позицій'])}, але ще не написали ` +
            `менеджеру. Тримайте −${cfg.percent}% на це замовлення: промокод ${code}` +
            (cfg.minOrderUsd ? ` (від замовлення $${cfg.minOrderUsd})` : '') +
            `. Діє ${cfg.validDays} ${plural(cfg.validDays, ['день', 'дні', 'днів'])} — ` +
            `відкрийте «Примірочну» і натисніть «Відправити».`,
      promoCodeId: promoId,
      // One per person per rule, which the grant already guarantees; this keeps
      // the notification table honest if the rule is ever re-run by hand.
      dedupeKey: `abandon:${cfg.grantKey}:${customerId}`,
    });
    granted += 1;
  }

  return { candidates: rows.length, granted, alreadyHad, grantKey: cfg.grantKey, hours: cfg.hours, percent: cfg.percent };
}

function plural(n, forms) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}
