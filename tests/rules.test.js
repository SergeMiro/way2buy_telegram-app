import './helpers/tmpdb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { migrate } from '../server/db.js';
import { computeDiscount, getRule, updateRule, listRules, RuleValidationError } from '../server/rules.js';

migrate();

test('default rules match what Maryna approved on 31.07.2026', () => {
  const cashback = getRule('cashback');
  assert.equal(cashback.mode, 'fixed');
  assert.equal(cashback.value, 100);
  assert.equal(cashback.min_order_usd, 2000, 'a SINGLE order of $2000 qualifies');
  assert.equal(cashback.cap_usd, 300, 'unspent balance capped at $300');

  const bday = getRule('birthday');
  assert.equal(bday.mode, 'fixed');
  assert.equal(bday.value, 50);
  assert.equal(bday.min_order_usd, 500, '$50 off an order of $500+');
  assert.equal(bday.valid_days, 30, 'valid for one month');
});

test('computeDiscount — fixed amount', () => {
  const rule = { enabled: 1, mode: 'fixed', value: 50, min_order_usd: 500 };
  assert.deepEqual(computeDiscount(rule, 500), { applicable: true, amountUsd: 50, reason: 'ok' });
  assert.deepEqual(computeDiscount(rule, 1200), { applicable: true, amountUsd: 50, reason: 'ok' });

  const tooSmall = computeDiscount(rule, 499.99);
  assert.equal(tooSmall.applicable, false);
  assert.equal(tooSmall.reason, 'below_min_order');
  assert.equal(tooSmall.amountUsd, 0);
});

test('computeDiscount — percent mode uses the same call site', () => {
  const rule = { enabled: 1, mode: 'percent', value: 20, min_order_usd: 500 };
  assert.equal(computeDiscount(rule, 1000).amountUsd, 200);
  assert.equal(computeDiscount(rule, 500).amountUsd, 100);
  assert.equal(computeDiscount(rule, 100).applicable, false);
});

test('a discount can never exceed the order', () => {
  const rule = { enabled: 1, mode: 'fixed', value: 500, min_order_usd: 0 };
  assert.equal(computeDiscount(rule, 120).amountUsd, 120);
});

test('a disabled rule pays nothing', () => {
  const rule = { enabled: 0, mode: 'fixed', value: 50, min_order_usd: 0 };
  assert.deepEqual(computeDiscount(rule, 1000), { applicable: false, amountUsd: 0, reason: 'disabled' });
});

test('invalid orders are refused, not treated as zero-discount', () => {
  const rule = { enabled: 1, mode: 'fixed', value: 50, min_order_usd: 0 };
  assert.equal(computeDiscount(rule, -5).reason, 'invalid_order');
  assert.equal(computeDiscount(rule, 'abc').reason, 'invalid_order');
});

test('admin can switch a rule between $ and % and back', () => {
  updateRule('birthday', { mode: 'percent', value: 15 }, 'admin-1');
  let r = getRule('birthday');
  assert.equal(r.mode, 'percent');
  assert.equal(computeDiscount(r, 1000).amountUsd, 150);

  updateRule('birthday', { mode: 'fixed', value: 50 }, 'admin-1');
  r = getRule('birthday');
  assert.equal(computeDiscount(r, 1000).amountUsd, 50);
});

test('a percent above 90 is rejected — that is a $ typed into a % field', () => {
  assert.throws(() => updateRule('cashback', { mode: 'percent', value: 150 }), RuleValidationError);
  // …and the rule is left untouched.
  assert.equal(getRule('cashback').mode, 'fixed');
});

test('unknown patch fields are ignored rather than crashing the panel', () => {
  const before = getRule('cashback');
  const after = updateRule('cashback', { somethingNew: true, value: 100 });
  assert.equal(after.value, 100);
  assert.equal(getRule('cashback').mode, before.mode);
});

test('every rule renders a Ukrainian summary for the admin panel', () => {
  for (const r of listRules()) {
    assert.ok(r.summary.length > 5, `${r.key} has no summary`);
  }
});
