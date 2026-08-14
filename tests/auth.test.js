// Who Telegram will vouch for.
//
// The cabinet used to be guarded by a query parameter: `?tgid=<an admin's id>`
// and the client list — names, phones, delivery addresses — was yours. These
// tests pin the replacement, and half of them are about the thing that must NOT
// happen: an ordinary client, mid-order, on a Mini App opened before the fix
// shipped, must keep working. A security change that logs shoppers out is not a
// security change, it is an outage.
//
// VERCEL=1 is set before the router is imported: it is what stops index.js from
// binding a port and starting the scheduler, so the app can be mounted on an
// ephemeral port here instead.
import './helpers/tmpdb.js';
process.env.VERCEL = '1';
process.env.VERCEL_ENV = 'production';
process.env.ADMIN_TG_IDS = '387442030';
// Not a real token — it never leaves this process. The signature only has to be
// computed with the same secret the server checks it with.
process.env.TELEGRAM_BOT_TOKEN = '123456:TEST-TOKEN-not-a-real-bot';

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const { verifyInitData } = await import('../server/auth.js');
const app = (await import('../server/index.js')).default;

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = 387442030;
const CLIENT_ID = 100000001; // the first seeded customer

const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

// Build an initData string the way Telegram does: fields sorted, joined with
// '\n', signed with HMAC(HMAC("WebAppData", token)).
function signInitData(fields) {
  const params = new URLSearchParams(fields);
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(check).digest('hex'));
  return params.toString();
}

const launchFor = (id, extra = {}) => signInitData({
  auth_date: String(Math.floor(Date.now() / 1000)),
  query_id: 'AAF_test',
  user: JSON.stringify({ id, first_name: 'Тест', username: 'tester' }),
  ...extra,
});

const withInitData = (initData) => ({ headers: { 'x-telegram-init-data': initData } });

/* ── the verifier itself ─────────────────────────────────────────────────── */

test('a launch signed with the bot token verifies, and yields the id from inside it', () => {
  const v = verifyInitData(launchFor(ADMIN_ID), TOKEN);
  assert.equal(v.ok, true);
  assert.equal(v.id, String(ADMIN_ID));
  assert.equal(v.user.username, 'tester');
});

test('one changed character in any field breaks the signature', () => {
  const good = launchFor(CLIENT_ID);
  // Swap the user for the admin, keeping the hash — the whole attack, in one line.
  const forged = good.replace(
    encodeURIComponent(JSON.stringify({ id: CLIENT_ID, first_name: 'Тест', username: 'tester' })),
    encodeURIComponent(JSON.stringify({ id: ADMIN_ID, first_name: 'Тест', username: 'tester' })),
  );
  assert.notEqual(forged, good);
  assert.equal(verifyInitData(forged, TOKEN).reason, 'bad_signature');
});

test('a launch signed with a different token is not ours', () => {
  const v = verifyInitData(launchFor(ADMIN_ID), '999:SOME-OTHER-BOT');
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'bad_signature');
});

test('missing, empty and shapeless input each say why rather than throwing', () => {
  assert.equal(verifyInitData('', TOKEN).reason, 'absent');
  assert.equal(verifyInitData(undefined, TOKEN).reason, 'absent');
  assert.equal(verifyInitData('user=%7B%7D&auth_date=1', TOKEN).reason, 'no_hash');
  // Nothing to check WITH is a misconfiguration, and must be distinguishable
  // from a forgery: index.js falls back on this one and refuses the other.
  assert.equal(verifyInitData(launchFor(ADMIN_ID), '').reason, 'no_token');
});

test('auth_date is enforced, but generously — and a future one is refused outright', () => {
  const old = launchFor(ADMIN_ID, { auth_date: String(Math.floor(Date.now() / 1000) - 40 * 24 * 3600) });
  assert.equal(verifyInitData(old, TOKEN).reason, 'expired');
  // A month-old launch still passes the default window: the failure mode we
  // refuse is logging somebody out, not a wide replay window.
  assert.equal(verifyInitData(old, TOKEN, { maxAgeH: 24 * 60 }).ok, true);
  // …and it can be tightened by configuration without touching code.
  assert.equal(verifyInitData(launchFor(ADMIN_ID), TOKEN, { maxAgeH: 1 }).ok, true);

  const future = launchFor(ADMIN_ID, { auth_date: String(Math.floor(Date.now() / 1000) + 7 * 24 * 3600) });
  assert.equal(verifyInitData(future, TOKEN).reason, 'future');
});

test('a launch carrying the newer `signature` field still verifies', () => {
  // Telegram's Ed25519 field rides along for third-party validation. Whichever
  // way it is read into the HMAC data-check string, our own signature holds.
  const withSig = signInitData({
    auth_date: String(Math.floor(Date.now() / 1000)),
    signature: 'ZmFrZS1lZDI1NTE5LXNpZ25hdHVyZQ',
    user: JSON.stringify({ id: ADMIN_ID, first_name: 'Тест' }),
  });
  assert.equal(verifyInitData(withSig, TOKEN).ok, true);
});

/* ── the cabinet ─────────────────────────────────────────────────────────── */

test('the hole is closed: an admin id without a signature no longer opens the cabinet', async () => {
  for (const path of [
    '/api/admin/customers', '/api/admin/profit', '/api/admin/channels',
    '/api/admin/inquiries', '/api/admin/posts',
  ]) {
    const res = await fetch(`${base}${path}?tgid=${ADMIN_ID}&admin=1`);
    assert.equal(res.status, 403, `${path} must refuse an unsigned admin id`);
  }
});

test('the same id WITH Telegram behind it does open it', async () => {
  const res = await fetch(`${base}/api/admin/customers`, withInitData(launchFor(ADMIN_ID)));
  assert.equal(res.status, 200);
  assert.ok(Array.isArray((await res.json()).customers));
});

test('a signed launch by somebody who is not an admin is still refused', async () => {
  const res = await fetch(`${base}/api/admin/customers`, withInitData(launchFor(CLIENT_ID)));
  assert.equal(res.status, 403);
});

test('a forged signature is refused before the route is reached, not merely un-admined', async () => {
  const res = await fetch(`${base}/api/admin/customers`, withInitData(`${launchFor(ADMIN_ID)}x`));
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'invalid initData');
});

test('writing routes are gated by the same rule, not only the reading ones', async () => {
  const res = await fetch(`${base}/api/admin/channels/bags/sync?tgid=${ADMIN_ID}&admin=1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ admin: '1', tgid: String(ADMIN_ID) }),
  });
  assert.equal(res.status, 403);
});

/* ── nobody gets thrown out ──────────────────────────────────────────────── */

test('a client on the previous bundle, sending no signature, still shops', async () => {
  // This is the whole reason the fallback exists. It must keep working until
  // W2B_REQUIRE_SIGNED closes it deliberately.
  const res = await fetch(`${base}/api/me?tgid=${CLIENT_ID}`);
  assert.equal(res.status, 200);
  const me = await res.json();
  assert.equal(me.registered, true);
  assert.equal(me.admin, false, 'and being unsigned must not make them an admin');
});

test('a signed client reads as the id Telegram named, not the one the URL claims', async () => {
  const res = await fetch(
    `${base}/api/me?tgid=${ADMIN_ID}`, // the parameter lies…
    withInitData(launchFor(CLIENT_ID)), // …the signature does not
  );
  assert.equal(res.status, 200);
  const me = await res.json();
  assert.equal(me.admin, false);
  assert.equal(String(me.customer.tgId), String(CLIENT_ID));
});

test('the photo proxy carries no identity and must not start demanding one', async () => {
  // <img src> cannot send a header. If this ever 401s, every photograph in the
  // vitrine goes blank.
  const res = await fetch(`${base}/api/photo/nonexistent-file-id`);
  assert.notEqual(res.status, 401);
});
