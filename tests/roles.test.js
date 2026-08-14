// Who may do what, and the line the brief drew.
//
// Three people work in this shop and they do different jobs. Dasha answers
// clients; she must be able to do everything that answers one and nothing that
// decides what things cost. Sergiy and Maryna own it. The failure this file
// exists to prevent is the quiet one: a route added later that inherits rights
// because it was put in the wrong group, and nobody notices until the manager
// can read the margin on every bag.
import './helpers/tmpdb.js';
process.env.VERCEL = '1';
process.env.VERCEL_ENV = 'production';
process.env.ADMIN_TG_IDS = '387442030';            // Sergiy — the env bootstrap
process.env.TELEGRAM_BOT_TOKEN = '123456:TEST-TOKEN-not-a-real-bot';

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { db } from '../server/db.js';
import * as roles from '../server/roles.js';

const app = (await import('../server/index.js')).default;

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SERGIY = 387442030;   // super, from the environment
const MARYNA = 1494137291;  // super, from the table
const DASHA  = 2004280910;  // admin
const NOBODY = 999000111;

const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

function launch(id) {
  const p = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id, first_name: 'T' }),
  });
  const check = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  p.set('hash', crypto.createHmac('sha256', secret).update(check).digest('hex'));
  return p.toString();
}
const as = (id, init = {}) => ({
  ...init,
  headers: { ...(init.headers || {}), 'x-telegram-init-data': launch(id) },
});

// The team, as the shop actually is.
await db.prepare(`INSERT INTO admins (tg_user_id,name,role,enabled,created_at)
  VALUES (?,?,?,true,?),(?,?,?,true,?)`)
  .run(String(MARYNA), 'Марина', 'super', new Date().toISOString(),
       String(DASHA), 'Даша', 'admin', new Date().toISOString());
roles.invalidate();

/* ── the matrix itself ───────────────────────────────────────────────────── */

// Everything the manager needs to work a day: answer clients, keep the
// catalogue true, record what was sold.
const MANAGER_MAY = [
  ['GET', '/api/admin/inquiries'],
  ['GET', '/api/admin/customers'],
  ['GET', '/api/admin/birthday-claims'],
  ['GET', '/api/admin/posts'],
  ['GET', '/api/admin/channels'],
  ['GET', '/api/admin/popular'],
];

// Everything that decides what a client pays, what the shop keeps, or who
// works here.
const OWNER_ONLY = [
  ['GET', '/api/admin/rules'],
  ['GET', '/api/admin/holidays'],
  ['GET', '/api/admin/campaigns'],
  ['GET', '/api/admin/presets'],
  ['GET', '/api/admin/profit'],
  ['GET', '/api/admin/pending-costs'],
  ['GET', '/api/admin/alerts'],
  ['GET', '/api/admin/team'],
  ['POST', '/api/admin/campaigns/preview'],
];

test('the manager can do her whole day', async () => {
  for (const [method, path] of MANAGER_MAY) {
    const res = await fetch(`${base}${path}`, as(DASHA, { method }));
    assert.equal(res.status, 200, `${path} must be open to an admin`);
  }
});

test('the manager cannot touch money, discounts or the team', async () => {
  for (const [method, path] of OWNER_ONLY) {
    const res = await fetch(`${base}${path}`, as(DASHA, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'POST' ? '{}' : undefined,
    }));
    assert.equal(res.status, 403, `${path} must be refused to an admin`);
    const body = await res.json();
    // The refusal names the missing right — a manager who taps something should
    // be able to say which permission she lacks, and so should the log.
    assert.ok(body.need, `${path} should say which capability was needed`);
  }
});

test('both owners can do everything a manager can, and everything she cannot', async () => {
  for (const who of [SERGIY, MARYNA]) {
    for (const [method, path] of [...MANAGER_MAY, ...OWNER_ONLY]) {
      const res = await fetch(`${base}${path}`, as(who, {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'POST' ? '{}' : undefined,
      }));
      assert.equal(res.status, 200, `${path} must be open to super ${who}`);
    }
  }
});

test('somebody who does not work here gets nothing, signature or not', async () => {
  for (const [method, path] of [...MANAGER_MAY, ...OWNER_ONLY]) {
    const res = await fetch(`${base}${path}`, as(NOBODY, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'POST' ? '{}' : undefined,
    }));
    assert.equal(res.status, 403, `${path} must be refused to a stranger`);
  }
});

test('/api/me tells the client what it may draw, so nothing is shown then refused', async () => {
  const admin = await (await fetch(`${base}/api/me`, as(DASHA))).json();
  assert.equal(admin.role, 'admin');
  assert.ok(admin.can.includes('inquiries.read'));
  assert.ok(!admin.can.includes('discounts.manage'));
  assert.ok(!admin.can.includes('profit.read'));

  const owner = await (await fetch(`${base}/api/me`, as(MARYNA))).json();
  assert.equal(owner.role, 'super');
  assert.ok(owner.can.includes('discounts.manage'));
  assert.ok(owner.can.includes('team.manage'));

  const client = await (await fetch(`${base}/api/me`, as(NOBODY))).json();
  assert.equal(client.role, null);
  assert.deepEqual(client.can, []);
  assert.equal(client.admin, false);
});

/* ── managing the team ───────────────────────────────────────────────────── */

test('a super admin can appoint, promote and stand somebody down', async () => {
  const add = await fetch(`${base}/api/admin/team`, as(MARYNA, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tgId: '777000111', name: 'Нова', role: 'admin' }),
  }));
  assert.equal(add.status, 200);
  const team = (await add.json()).team;
  assert.equal(team.find((m) => m.tgId === '777000111').role, 'admin');

  const promote = await fetch(`${base}/api/admin/team/777000111`, as(MARYNA, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'super' }),
  }));
  assert.equal((await promote.json()).team.find((m) => m.tgId === '777000111').role, 'super');

  const off = await fetch(`${base}/api/admin/team/777000111`, as(MARYNA, { method: 'DELETE' }));
  assert.equal(off.status, 200);
  // Stood down, not deleted: who did what stays readable and re-hiring is one tap.
  assert.equal((await off.json()).team.find((m) => m.tgId === '777000111').enabled, false);
});

test('the environment bootstrap cannot be demoted from inside the app', async () => {
  // Otherwise the cabinet would appear to change something the next request
  // would silently undo, which is worse than having no control at all.
  const res = await fetch(`${base}/api/admin/team/${SERGIY}`, as(MARYNA, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'admin' }),
  }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /налаштуваннях сервера/);
  assert.equal(await roles.roleOf(SERGIY), 'super');
});

test('the shop can never be left without anybody who can set a price', async () => {
  // The real case only exists without the environment bootstrap: one super in
  // the table and nobody behind it. Maryna is that super here.
  const saved = process.env.ADMIN_TG_IDS;
  process.env.ADMIN_TG_IDS = '';
  roles.invalidate();
  try {
    const supers = (await roles.listTeam()).filter((m) => m.role === 'super' && m.enabled);
    assert.deepEqual(supers.map((m) => m.tgId), [String(MARYNA)], 'precondition: exactly one super');

    await assert.rejects(
      roles.removeMember(String(MARYNA)),
      /останній супер-адмін/,
      'the last super admin must not be removable',
    );
    await assert.rejects(
      roles.setMember({ tgId: String(MARYNA), role: 'admin' }),
      /останній супер-адмін/,
      'nor demotable, which is the same door by a different handle',
    );
    assert.equal(await roles.roleOf(MARYNA), 'super', 'and she is still a super afterwards');
  } finally {
    process.env.ADMIN_TG_IDS = saved;
    roles.invalidate();
  }
});

/* ── who hears about an inquiry ──────────────────────────────────────────── */

test('owner-level alerts go to the owners only', async () => {
  // The manager gets the client-facing copy through the support path in
  // cart.js; these carry cost prices and «this sale has no cost entered yet».
  const ids = (await roles.alertIds()).map(String).sort();
  assert.deepEqual(ids, [String(MARYNA), String(SERGIY)].sort());
  assert.ok(!ids.includes(String(DASHA)), 'the manager is not on the owner alert list');
});
