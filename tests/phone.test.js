// The number Maryna calls when Telegram is not enough.
//
// It used to be stored exactly as typed, and a French phone autofilling its own
// national form wrote «07 54 38 67 68» — a number nobody outside France can
// dial, in the field that exists precisely for reaching somebody. The rule is
// now: a country code, or a refusal that says why.
//
// What this file is really pinning is the REFUSAL TO GUESS. 0X XXXXXXXX is a
// valid mobile in Ukraine and in France, and this club has clients in both. A
// default country code would not produce a slightly-wrong number; it would
// produce somebody else's, and nobody would find out until a manager called it.
import './helpers/tmpdb.js';
process.env.VERCEL = '1';
process.env.ADMIN_TG_IDS = '';

import test from 'node:test';
import assert from 'node:assert/strict';
import { migrate, db } from '../server/db.js';
import { normalizePhone, formatPhone, PHONE_ERRORS } from '../server/phone.js';

await migrate();

const app = (await import('../server/index.js')).default;
const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

let seq = 0;
const join = async (body) => {
  seq += 1;
  const tgId = `ph-${seq}`;
  const res = await fetch(`${base}/api/register?tgid=${tgId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tgid: tgId, name: 'Клієнтка', consent: true, ...body }),
  });
  return { tgId, status: res.status, json: await res.json() };
};
const stored = async (tgId) =>
  (await db.prepare('SELECT phone FROM customers WHERE tg_user_id=?').get(tgId))?.phone ?? undefined;

/* ── normalising ─────────────────────────────────────────────────────────── */

test('the way a person writes a number is not part of the number', () => {
  for (const written of ['+380671112233', '+380 67 111 22 33', '+380 (67) 111-22-33', ' +380671112233 ']) {
    assert.deepEqual(normalizePhone(written), { ok: true, value: '+380671112233' }, written);
  }
});

test('00 is the international prefix spelled the way a landline taught it', () => {
  assert.deepEqual(normalizePhone('0033754386768'), { ok: true, value: '+33754386768' });
  assert.deepEqual(normalizePhone('00 33 7 54 38 67 68'), { ok: true, value: '+33754386768' });
});

test('a bare national number is refused, never assigned a country', () => {
  // The whole point. Both of these are real mobiles — one Ukrainian, one French
  // — and they are indistinguishable, so neither gets a guess.
  assert.deepEqual(normalizePhone('067 111 22 33'), { ok: false, reason: 'no_country_code' });
  assert.deepEqual(normalizePhone('07 54 38 67 68'), { ok: false, reason: 'no_country_code' });
  assert.deepEqual(normalizePhone('4155550123'), { ok: false, reason: 'no_country_code' });
});

test('a country code alone is not a phone number', () => {
  assert.deepEqual(normalizePhone('+380'), { ok: false, reason: 'malformed' });
  assert.deepEqual(normalizePhone('+'), { ok: false, reason: 'malformed' });
  // E.164 stops at fifteen digits.
  assert.deepEqual(normalizePhone(`+${'9'.repeat(16)}`), { ok: false, reason: 'malformed' });
  assert.deepEqual(normalizePhone(`+${'9'.repeat(15)}`), { ok: true, value: `+${'9'.repeat(15)}` });
});

test('an absent phone is a different thing from a bad one', () => {
  // The column is nullable and «нічого не ввели» is not an error to report;
  // the form is what makes it required.
  for (const empty of ['', '   ', null, undefined]) {
    assert.deepEqual(normalizePhone(empty), { ok: true, value: null }, String(empty));
  }
});

/* ── displaying ──────────────────────────────────────────────────────────── */

test('a number stored before the rule is shown marked, not silently repaired', () => {
  assert.equal(formatPhone('+33 7 54 38 67 68'), '+33754386768');
  // Rows written before the form asked for a code still exist. Whoever reads the
  // inquiry has to know to ASK rather than dial something that rings in the
  // wrong country.
  assert.equal(formatPhone('07 54 38 67 68'), '07 54 38 67 68 (без коду країни)');
  assert.equal(formatPhone(''), null);
  assert.equal(formatPhone(null), null);
});

/* ── the form is a courtesy; this is the rule ────────────────────────────── */

test('registering without a country code is refused, with the reason', async () => {
  const r = await join({ phone: '07 54 38 67 68' });
  assert.equal(r.status, 400);
  assert.equal(r.json.reason, 'no_country_code');
  assert.equal(r.json.field, 'phone');
  assert.equal(r.json.error, PHONE_ERRORS.no_country_code);
  // Refused means refused: no half-written client left behind.
  assert.equal(await stored(r.tgId), undefined);
});

test('what is stored is the normalized number, not what the keyboard produced', async () => {
  const r = await join({ phone: '+380 (67) 111-22-33' });
  assert.equal(r.status, 200);
  assert.equal(await stored(r.tgId), '+380671112233');
});

test('editing a profile cannot smuggle a bad number past the rule', async () => {
  const first = await join({ phone: '+380671112233' });
  assert.equal(first.status, 200);

  // The same tgid again is the "edit my details" path, and it writes the phone
  // column too — so it has to answer to the same rule as the first save.
  const again = await fetch(`${base}/api/register?tgid=${first.tgId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tgid: first.tgId, name: 'Клієнтка', consent: true, phone: '067 111 22 33' }),
  });
  assert.equal(again.status, 400);
  assert.equal(await stored(first.tgId), '+380671112233', 'the good number was overwritten by a refused one');
});
