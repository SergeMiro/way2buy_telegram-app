// ─────────────────────────────────────────────────────────────────────────
//  profit.js — what each bag actually earned.
//
//  Maryna, 31.07.2026: "Интегрировать логику расчета всей цены затраченной
//  Мариной … заказав с Китая и цены в $ взятой с клиента и автоматом считать
//  разницы чтобы понимать чистую прибыль по каждой сумке, если какое то из
//  значений небыло введено, то надо отслеживать и на след день после продажи —
//  напоминать ввести данные для статистики."
//
//  Model:
//    purchases.amount_usd   — what the client paid (revenue)
//    purchases.discount_usd — bonus/promo applied, subtracted from revenue
//    purchases.cost_usd     — everything Maryna paid (factory + shipping + fees)
//    profit = amount_usd − discount_usd − cost_usd
//
//  A sale with no cost entered is not guessed at and not silently averaged: it
//  is excluded from the profit totals, counted separately, and reported back
//  to the admin the day after the sale.
// ─────────────────────────────────────────────────────────────────────────
import { db } from './db.js';
import { notifyAdmins } from './notify.js';

const round2 = (n) => Math.round(n * 100) / 100;
const iso = (ms) => new Date(ms).toISOString();

// ── pure calculation ──────────────────────────────────────────────────────

export function marginOf(purchase) {
  const revenue = round2(Number(purchase.amount_usd) || 0);
  const discount = round2(Number(purchase.discount_usd) || 0);
  const net = round2(revenue - discount);
  const hasCost = purchase.cost_usd !== null && purchase.cost_usd !== undefined;
  const cost = hasCost ? round2(Number(purchase.cost_usd)) : null;
  const profit = hasCost ? round2(net - cost) : null;
  return {
    revenueUsd: revenue,
    discountUsd: discount,
    netUsd: net,
    costUsd: cost,
    profitUsd: profit,
    marginPct: hasCost && net > 0 ? Math.round((profit / net) * 100) : null,
    complete: hasCost,
  };
}

export function totalsOf(purchases) {
  let revenue = 0; let discount = 0; let cost = 0; let profit = 0;
  let complete = 0; let incomplete = 0; let incompleteRevenue = 0;

  for (const p of purchases) {
    const m = marginOf(p);
    revenue += m.revenueUsd;
    discount += m.discountUsd;
    if (m.complete) {
      cost += m.costUsd;
      profit += m.profitUsd;
      complete += 1;
    } else {
      incomplete += 1;
      incompleteRevenue += m.revenueUsd;
    }
  }
  const net = round2(revenue - discount);
  const completeNet = round2(net - incompleteRevenue);
  return {
    orders: purchases.length,
    revenueUsd: round2(revenue),
    discountUsd: round2(discount),
    netUsd: net,
    costUsd: round2(cost),
    profitUsd: round2(profit),
    // Margin is computed only over orders that HAVE a cost, so a missing cost
    // never inflates the number.
    marginPct: completeNet > 0 ? Math.round((profit / completeNet) * 100) : null,
    ordersWithCost: complete,
    ordersMissingCost: incomplete,
    revenueMissingCostUsd: round2(incompleteRevenue),
    avgProfitUsd: complete > 0 ? round2(profit / complete) : null,
  };
}

// ── reads ─────────────────────────────────────────────────────────────────

export async function stats({ from = null, to = null, limit = 200 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const where = ["status = 'confirmed'"];
  const params = [];
  if (from) { where.push('created_at >= ?'); params.push(from); }
  if (to) { where.push('created_at <= ?'); params.push(to); }

  const rows = await db.prepare(
    `SELECT p.*, c.name AS customer_name
       FROM purchases p JOIN customers c ON c.id = p.customer_id
      WHERE ${where.join(' AND ')}
      ORDER BY p.created_at DESC LIMIT ?`
  ).all(...params, lim);

  return {
    totals: totalsOf(rows),
    items: rows.map((p) => ({
      id: p.id,
      customerId: p.customer_id,
      customerName: p.customer_name,
      title: p.title,
      createdAt: p.created_at,
      channel: p.source_channel,
      costNote: p.cost_note,
      ...marginOf(p),
    })),
  };
}

// Sales that still have no cost entered and are older than `graceHours`
// (default 24h — "на след день после продажи").
export async function pendingCosts(now = Date.now(), { graceHours = 24, limit = 100 } = {}) {
  const cutoff = iso(now - graceHours * 3600000);
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 200);
  return await db.prepare(
    `SELECT p.id, p.title, p.amount_usd, p.created_at, p.cost_reminded_at, c.name AS customer_name
       FROM purchases p JOIN customers c ON c.id = p.customer_id
      WHERE p.status='confirmed' AND p.cost_usd IS NULL AND p.created_at <= ?
      ORDER BY p.created_at ASC LIMIT ?`
  ).all(cutoff, lim);
}

// ── writes ────────────────────────────────────────────────────────────────

export async function setCost(purchaseId, { costUsd, note = null } = {}) {
  const n = Number(costUsd);
  if (!Number.isFinite(n) || n < 0) throw new Error('costUsd must be >= 0');
  const info = await db.prepare(
    'UPDATE purchases SET cost_usd=?, cost_note=?, cost_entered_at=? WHERE id=?'
  ).run(round2(n), note, iso(Date.now()), purchaseId);
  if (info.changes === 0) return null;
  const row = await db.prepare('SELECT * FROM purchases WHERE id=?').get(purchaseId);
  return { id: row.id, ...marginOf(row) };
}

// Called by the scheduler. One reminder per sale per day, deduped both by the
// notification key and by `cost_reminded_at`, so a restart cannot spam.
export async function remindPendingCosts(now = Date.now()) {
  const pending = await pendingCosts(now);
  const today = iso(now).slice(0, 10);
  let sent = 0;

  for (const p of pending) {
    // cost_reminded_at is a Date now, not an ISO string — slice it via iso().
    if (p.cost_reminded_at && iso(p.cost_reminded_at).slice(0, 10) === today) continue;
    const id = await notifyAdmins({
      kind: 'cost_missing',
      title: '📊 Введіть собівартість',
      body: `${p.title || 'Покупка'} · ${p.customer_name} · клієнт заплатив $${p.amount_usd}. Без цієї цифри замовлення не потрапляє у прибуток.`,
      dedupeKey: `cost:${p.id}:${today}`,
    });
    await db.prepare('UPDATE purchases SET cost_reminded_at=? WHERE id=?').run(iso(now), p.id);
    if (id) sent += 1;
  }

  // One rolled-up nudge when the backlog is getting long.
  if (pending.length >= 5) {
    await notifyAdmins({
      kind: 'cost_missing_digest',
      title: `📊 ${pending.length} замовлень без собівартості`,
      body: 'Статистика прибутку рахується лише по замовленнях, де введена закупівельна ціна.',
      dedupeKey: `cost-digest:${today}`,
    });
  }

  return { pending: pending.length, reminded: sent };
}
