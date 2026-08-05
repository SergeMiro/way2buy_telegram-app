import './helpers/tmpdb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { migrate, db } from '../server/db.js';
import { computeCashback, loyaltyFor } from '../server/loyalty.js';
import { updateRule, getRule } from '../server/rules.js';

await migrate();

// async: getRule reads the database now.
const RULE = async () => getRule('cashback');

// agg shape as produced by snapshotBatch
const agg = ({ qn = 0, qs = 0, redeemed = 0 }) => ({
  qualifyingCount: qn, qualifyingSum: qs, redeemedRaw: redeemed,
  spentRaw: qs, purchaseCount: qn, monthSet: new Set(),
});

test('one order of $2000+ earns $100 — smaller orders earn nothing', async () => {
  const r = await RULE();
  assert.equal(computeCashback(agg({ qn: 0 }), r).cashbackAvailable, 0, '$1999 → $0');
  assert.equal(computeCashback(agg({ qn: 1, qs: 2000 }), r).cashbackAvailable, 100);
  assert.equal(computeCashback(agg({ qn: 2, qs: 5000 }), r).cashbackAvailable, 200);
});

test('the cap is on the UNSPENT balance, at $300', async () => {
  const r = await RULE();
  const three = computeCashback(agg({ qn: 3, qs: 9000 }), r);
  assert.equal(three.cashbackAvailable, 300);
  assert.equal(three.capReached, true);

  // A fourth and fifth qualifying order earn nothing extra while at the cap.
  const five = computeCashback(agg({ qn: 5, qs: 15000 }), r);
  assert.equal(five.cashbackEarned, 500, 'earned keeps counting…');
  assert.equal(five.cashbackAvailable, 300, '…but the client can only hold $300');
  assert.equal(five.cashbackWithheld, 200);
});

test('spending part of the balance frees headroom again', async () => {
  const r = await RULE();
  const afterSpend = computeCashback(agg({ qn: 5, qs: 15000, redeemed: 300 }), r);
  assert.equal(afterSpend.cashbackAvailable, 200, '500 earned − 300 spent = 200, under the cap');
  assert.equal(afterSpend.capReached, false);
  assert.equal(afterSpend.capHeadroomUsd, 100);
});

test('redeeming more than earned never produces a negative balance', async () => {
  const r = await RULE();
  assert.equal(computeCashback(agg({ qn: 0, redeemed: 100 }), r).cashbackAvailable, 0);
});

test('percent mode applies to each qualifying order', () => {
  const r = { enabled: 1, mode: 'percent', value: 5, min_order_usd: 2000, cap_usd: 300 };
  const c = computeCashback(agg({ qn: 2, qs: 7700 }), r);
  assert.equal(c.cashbackEarned, 385, '5% of 7700');
  assert.equal(c.cashbackAvailable, 300, 'still capped');
});

test('disabling cashback zeroes it without touching history', () => {
  const r = { enabled: 0, mode: 'fixed', value: 100, min_order_usd: 2000, cap_usd: 300 };
  const c = computeCashback(agg({ qn: 3, qs: 9000 }), r);
  assert.equal(c.cashbackEarned, 0);
  assert.equal(c.cashbackAvailable, 0);
});

test('no cap configured ⇒ unlimited accumulation', () => {
  const r = { enabled: 1, mode: 'fixed', value: 100, min_order_usd: 2000, cap_usd: null };
  const c = computeCashback(agg({ qn: 7, qs: 21000 }), r);
  assert.equal(c.cashbackAvailable, 700);
  assert.equal(c.capReached, false);
});

test('end to end against the database: only qualifying orders count', async () => {
  const ts = new Date().toISOString();
  const cid = Number((await db.prepare("INSERT INTO customers (tg_user_id,name,created_at) VALUES ('t-loyal','Тест',?)").run(ts)).lastInsertRowid);
  const ins = db.prepare("INSERT INTO purchases (customer_id,title,amount_usd,status,created_at) VALUES (?,?,?,'confirmed',?)");
  await ins.run(cid, 'дрібна', 1999, ts);
  await ins.run(cid, 'велика', 2000, ts);
  await ins.run(cid, 'дуже велика', 8000, ts);
  // A cancelled order must not earn anything.
  db.prepare("INSERT INTO purchases (customer_id,title,amount_usd,status,created_at) VALUES (?,?,?,'cancelled',?)").run(cid, 'скасована', 5000, ts);

  const l = await loyaltyFor(cid);
  assert.equal(l.purchases, 3, 'cancelled order excluded from the count');
  assert.equal(l.qualifyingPurchases, 2);
  assert.equal(l.cashbackAvailable, 200);
  assert.equal(l.totalSpent, 11999);
});

test('changing the threshold re-scores existing history immediately', async () => {
  const ts = new Date().toISOString();
  const cid = Number((await db.prepare("INSERT INTO customers (tg_user_id,name,created_at) VALUES ('t-thresh','Поріг',?)").run(ts)).lastInsertRowid);
  await db.prepare("INSERT INTO purchases (customer_id,title,amount_usd,status,created_at) VALUES (?,?,?,'confirmed',?)").run(cid, 'середня', 800, ts);

  assert.equal((await loyaltyFor(cid)).cashbackAvailable, 0);
  await updateRule('cashback', { minOrderUsd: 500 });
  assert.equal((await loyaltyFor(cid)).cashbackAvailable, 100, 'the $800 order now qualifies');
  await updateRule('cashback', { minOrderUsd: 2000 });
  assert.equal((await loyaltyFor(cid)).cashbackAvailable, 0);
});
