import './helpers/tmpdb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { migrate, db } from '../server/db.js';
import {
  parseBirthday, mmdd, birthdayWindow, claimBirthdayDiscount, birthdayStatus, claimsFor,
} from '../server/birthday.js';
import { updateRule } from '../server/rules.js';

await migrate();

const ts = new Date().toISOString();
let seq = 0;
const makeCustomer = async (birthday = null) => {
  seq += 1;
  const id = (await db.prepare('INSERT INTO customers (tg_user_id,name,birthday,created_at) VALUES (?,?,?,?)')
    .run(`bday-${seq}`, `Клієнт ${seq}`, birthday, ts)).lastInsertRowid;
  return await db.prepare('SELECT * FROM customers WHERE id=?').get(id);
};

// A date whose window is guaranteed open "now", and one that is not.
const AT = Date.UTC(2026, 6, 15, 12); // 15 July 2026

// ── parsing ───────────────────────────────────────────────────────────────

test('parseBirthday accepts the formats a real person types', () => {
  assert.deepEqual(parseBirthday('1992-07-24'), { year: 1992, month: 7, day: 24 });
  assert.deepEqual(parseBirthday('24.07.1992'), { year: 1992, month: 7, day: 24 });
  assert.deepEqual(parseBirthday('24/07/1992'), { year: 1992, month: 7, day: 24 });
  assert.deepEqual(parseBirthday('24.07'), { year: null, month: 7, day: 24 });
  assert.deepEqual(parseBirthday('07-24'), { year: null, month: 7, day: 24 });
});

test('parseBirthday rejects dates that do not exist', () => {
  assert.equal(parseBirthday('31.02.1990'), null);
  assert.equal(parseBirthday('45.01.1990'), null);
  assert.equal(parseBirthday('01.13.1990'), null);
  assert.equal(parseBirthday(''), null);
  assert.equal(parseBirthday('завтра'), null);
  assert.equal(parseBirthday('1800-01-01'), null);
});

test('mmdd zero-pads', () => {
  assert.equal(mmdd({ month: 3, day: 5 }), '03-05');
});

// ── window ────────────────────────────────────────────────────────────────

test('the window opens on the birthday and lasts one month', () => {
  const w = birthdayWindow({ month: 7, day: 15 }, AT, 30);
  assert.equal(w.open, true);
  assert.equal(new Date(w.startsAt).toISOString().slice(0, 10), '2026-07-15');
  assert.equal(new Date(w.endsAt).toISOString().slice(0, 10), '2026-08-14');
});

test('a birthday later this year is upcoming, not open', () => {
  const w = birthdayWindow({ month: 12, day: 25 }, AT, 30);
  assert.equal(w.open, false);
  assert.equal(new Date(w.startsAt).getUTCFullYear(), 2026);
});

test('a late-December birthday is still open in early January', () => {
  const jan5 = Date.UTC(2027, 0, 5);
  const w = birthdayWindow({ month: 12, day: 25 }, jan5, 30);
  assert.equal(w.open, true, 'the window from 25.12.2026 runs into January');
});

test('29 February falls back to 28 February in a non-leap year', () => {
  const feb28 = Date.UTC(2027, 1, 28, 12); // 2027 is not a leap year
  const w = birthdayWindow({ month: 2, day: 29 }, feb28, 30);
  assert.equal(w.open, true);
  assert.equal(new Date(w.startsAt).toISOString().slice(0, 10), '2027-02-28');
});

// ── the claim flow ────────────────────────────────────────────────────────

test('first claim records the date and grants the discount', async () => {
  const c = await makeCustomer(null);
  const r = await claimBirthdayDiscount({ customer: c, birthdayInput: '15.07.1990', now: AT });

  assert.equal(r.verdict, 'granted');
  assert.equal(r.discount.amountUsd, 50);
  assert.equal(r.discount.minOrderUsd, 500);

  const stored = await db.prepare('SELECT * FROM customers WHERE id=?').get(c.id);
  assert.equal(stored.birthday, '1990-07-15', 'the date is now on file');
  assert.equal(stored.birthday_source, 'claim');

  const promo = await db.prepare('SELECT * FROM promo_codes WHERE id=?').get(r.promo.id);
  assert.equal(promo.mode, 'fixed');
  assert.equal(promo.amount_usd, 50);
  assert.equal(promo.min_order_usd, 500);
  assert.equal(promo.rule_key, 'birthday');
});

test('a second claim the same year is refused', async () => {
  const c = await makeCustomer(null);
  await claimBirthdayDiscount({ customer: c, birthdayInput: '15.07.1990', now: AT });
  const again = await claimBirthdayDiscount({ customer: c, birthdayInput: '15.07.1990', now: AT });
  assert.equal(again.verdict, 'already_claimed');
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM promo_codes WHERE customer_id=? AND rule_key='birthday'").get(c.id)).n, 1);
});

test('the same client CAN claim again the following year', async () => {
  const c = await makeCustomer(null);
  await claimBirthdayDiscount({ customer: c, birthdayInput: '15.07.1990', now: AT });
  const nextYear = await claimBirthdayDiscount({
    customer: await db.prepare('SELECT * FROM customers WHERE id=?').get(c.id),
    birthdayInput: '15.07.1990',
    now: Date.UTC(2027, 6, 15, 12),
  });
  assert.equal(nextYear.verdict, 'granted');
});

test('a date that does not match the one on file is refused and raised to the admin', async () => {
  const c = await makeCustomer('1990-07-15');
  const r = await claimBirthdayDiscount({ customer: c, birthdayInput: '20.05.1990', now: AT });

  assert.equal(r.verdict, 'mismatch');
  assert.equal(r.ok, false);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM promo_codes WHERE customer_id=?').get(c.id)).n, 0, 'no discount minted');
  assert.equal((await db.prepare('SELECT birthday FROM customers WHERE id=?').get(c.id)).birthday, '1990-07-15', 'stored date not overwritten');

  const alert = await db.prepare("SELECT * FROM notifications WHERE kind='bday_mismatch' AND customer_id IS NULL ORDER BY id DESC").get();
  assert.ok(alert, 'the admin is told');
  assert.match(alert.body, /07-15/);
  assert.match(alert.body, /05-20/);
});

test('claiming outside the window tells the client when it opens', async () => {
  const c = await makeCustomer(null);
  const r = await claimBirthdayDiscount({ customer: c, birthdayInput: '25.12.1990', now: AT });
  assert.equal(r.verdict, 'out_of_window');
  assert.equal(r.window.open, false);
  // The date is still recorded — that is the point of the register.
  assert.equal((await db.prepare('SELECT birthday FROM customers WHERE id=?').get(c.id)).birthday, '1990-12-25');
});

test('an unparseable date is logged, not silently ignored', async () => {
  const c = await makeCustomer(null);
  const r = await claimBirthdayDiscount({ customer: c, birthdayInput: '31.02.1990', now: AT });
  assert.equal(r.verdict, 'invalid_date');
  assert.equal((await claimsFor(c.id))[0].verdict, 'invalid_date');
});

test('every request is written to the register regardless of verdict', async () => {
  const c = await makeCustomer('1990-07-15');
  await claimBirthdayDiscount({ customer: c, birthdayInput: '15.07.1990', now: AT });   // granted
  await claimBirthdayDiscount({ customer: c, birthdayInput: '15.07.1990', now: AT });   // already_claimed
  await claimBirthdayDiscount({ customer: c, birthdayInput: '01.01.1990', now: AT });   // mismatch
  const verdicts = (await claimsFor(c.id)).map((r) => r.verdict).sort();
  assert.deepEqual(verdicts, ['already_claimed', 'granted', 'mismatch']);
});

test('a client with no date on file may claim by supplying it — but not with nothing', async () => {
  const c = await makeCustomer(null);
  const r = await claimBirthdayDiscount({ customer: c, birthdayInput: null, now: AT });
  assert.equal(r.verdict, 'invalid_date');
});

test('the discount follows the rule: switch to 10% and the promo changes shape', async () => {
  await updateRule('birthday', { mode: 'percent', value: 10 });
  const c = await makeCustomer(null);
  const r = await claimBirthdayDiscount({ customer: c, birthdayInput: '15.07.1990', now: AT });
  const promo = await db.prepare('SELECT * FROM promo_codes WHERE id=?').get(r.promo.id);
  assert.equal(promo.mode, 'percent');
  assert.equal(promo.percent, 10);
  await updateRule('birthday', { mode: 'fixed', value: 50 });
});

test('a disabled birthday rule grants nothing', async () => {
  await updateRule('birthday', { enabled: false });
  const c = await makeCustomer(null);
  const r = await claimBirthdayDiscount({ customer: c, birthdayInput: '15.07.1990', now: AT });
  assert.equal(r.verdict, 'disabled');
  await updateRule('birthday', { enabled: true });
});

test('birthdayStatus drives the card the client sees', async () => {
  const unknown = await birthdayStatus(await makeCustomer(null), AT);
  assert.equal(unknown.state, 'unknown_date');

  const open = await birthdayStatus(await makeCustomer('1990-07-15'), AT);
  assert.equal(open.state, 'available');

  const later = await birthdayStatus(await makeCustomer('1990-12-25'), AT);
  assert.equal(later.state, 'upcoming');

  const c = await makeCustomer('1990-07-15');
  await claimBirthdayDiscount({ customer: c, birthdayInput: '15.07.1990', now: AT });
  assert.equal((await birthdayStatus(c, AT)).state, 'claimed');
});
