import './helpers/tmpdb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { migrate, db } from '../server/db.js';
import { marginOf, totalsOf, setCost, pendingCosts, remindPendingCosts, stats } from '../server/profit.js';

migrate();

const HOUR = 3600000;
const iso = (ms) => new Date(ms).toISOString();
const NOW = Date.UTC(2026, 6, 31, 12);

let seq = 0;
function sale({ amount, cost = null, discount = 0, agoHours = 48 }) {
  seq += 1;
  const cid = Number(db.prepare('INSERT INTO customers (tg_user_id,name,created_at) VALUES (?,?,?)')
    .run(`profit-${seq}`, `Клієнт ${seq}`, iso(NOW)).lastInsertRowid);
  const id = Number(db.prepare(`INSERT INTO purchases
    (customer_id,title,amount_usd,discount_usd,cost_usd,status,created_at)
    VALUES (?,?,?,?,?,'confirmed',?)`)
    .run(cid, `Сумка ${seq}`, amount, discount, cost, iso(NOW - agoHours * HOUR)).lastInsertRowid);
  return id;
}

test('profit per bag = what the client paid − discount − what it cost', () => {
  const m = marginOf({ amount_usd: 1200, discount_usd: 50, cost_usd: 700 });
  assert.equal(m.revenueUsd, 1200);
  assert.equal(m.netUsd, 1150);
  assert.equal(m.profitUsd, 450);
  assert.equal(m.marginPct, 39);
  assert.equal(m.complete, true);
});

test('a sale with no cost yields no profit figure — it is not guessed', () => {
  const m = marginOf({ amount_usd: 1200, cost_usd: null });
  assert.equal(m.profitUsd, null);
  assert.equal(m.marginPct, null);
  assert.equal(m.complete, false);
});

test('totals exclude cost-less sales from profit but still report their revenue', () => {
  const t = totalsOf([
    { amount_usd: 1000, cost_usd: 600 },
    { amount_usd: 2000, cost_usd: 1200 },
    { amount_usd: 500, cost_usd: null },
  ]);
  assert.equal(t.orders, 3);
  assert.equal(t.revenueUsd, 3500);
  assert.equal(t.costUsd, 1800);
  assert.equal(t.profitUsd, 1200);
  assert.equal(t.ordersWithCost, 2);
  assert.equal(t.ordersMissingCost, 1);
  assert.equal(t.revenueMissingCostUsd, 500);
  assert.equal(t.marginPct, 40, 'margin is computed over the $3000 that has costs, not $3500');
  assert.equal(t.avgProfitUsd, 600);
});

test('an empty period does not divide by zero', () => {
  const t = totalsOf([]);
  assert.equal(t.orders, 0);
  assert.equal(t.profitUsd, 0);
  assert.equal(t.marginPct, null);
  assert.equal(t.avgProfitUsd, null);
});

test('entering the cost later completes the record', () => {
  const id = sale({ amount: 900 });
  assert.equal(marginOf(db.prepare('SELECT * FROM purchases WHERE id=?').get(id)).complete, false);

  const result = setCost(id, { costUsd: 520, note: 'фабрика + доставка' });
  assert.equal(result.profitUsd, 380);
  const row = db.prepare('SELECT * FROM purchases WHERE id=?').get(id);
  assert.equal(row.cost_note, 'фабрика + доставка');
  assert.ok(row.cost_entered_at, 'entry timestamped for the audit trail');
});

test('a negative cost is refused', () => {
  const id = sale({ amount: 900 });
  assert.throws(() => setCost(id, { costUsd: -1 }), /costUsd/);
});

test('the reminder only fires the day AFTER the sale', () => {
  db.exec('DELETE FROM purchases; DELETE FROM notifications;');
  const fresh = sale({ amount: 700, agoHours: 2 });
  const yesterday = sale({ amount: 800, agoHours: 30 });

  const pending = pendingCosts(NOW).map((p) => p.id);
  assert.ok(!pending.includes(fresh), 'a sale from two hours ago is not chased yet');
  assert.ok(pending.includes(yesterday), 'a sale from yesterday is');
});

test('reminders are idempotent — a second tick the same day sends nothing new', () => {
  db.exec('DELETE FROM purchases; DELETE FROM notifications;');
  sale({ amount: 800, agoHours: 30 });
  sale({ amount: 400, agoHours: 40 });

  const first = remindPendingCosts(NOW);
  assert.equal(first.pending, 2);
  assert.equal(first.reminded, 2);

  const second = remindPendingCosts(NOW);
  assert.equal(second.reminded, 0, 'no duplicate nudges');

  const alerts = db.prepare("SELECT COUNT(*) n FROM notifications WHERE kind='cost_missing'").get().n;
  assert.equal(alerts, 2);
});

test('once the cost is entered the sale stops being chased', () => {
  db.exec('DELETE FROM purchases; DELETE FROM notifications;');
  const id = sale({ amount: 800, agoHours: 30 });
  setCost(id, { costUsd: 500 });
  assert.equal(remindPendingCosts(NOW).pending, 0);
});

test('stats() shapes the admin report', () => {
  db.exec('DELETE FROM purchases; DELETE FROM notifications;');
  sale({ amount: 1000, cost: 600, agoHours: 30 });
  sale({ amount: 2000, cost: null, agoHours: 30 });

  const s = stats({});
  assert.equal(s.totals.orders, 2);
  assert.equal(s.totals.profitUsd, 400);
  assert.equal(s.items.length, 2);
  assert.ok(s.items.every((i) => i.customerName), 'each line names the client');
});
