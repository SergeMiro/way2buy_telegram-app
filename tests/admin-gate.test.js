// Who may open the cabinet.
//
// The cabinet holds the client list: names, phones, delivery addresses, purchase
// history. An empty ADMIN_TG_IDS opens it to anyone passing ?admin=1, which is
// what makes the zero-config demo demonstrable — and would publish real clients
// on a production deployment. This asserts the rule that separates the two, and
// it exists because that rule is one boolean away from being silently reversed.
//
// VERCEL=1 is set before the router is imported: it is what stops index.js from
// binding a port and starting the scheduler, so the app can be mounted on an
// ephemeral port here instead.
import './helpers/tmpdb.js';
process.env.VERCEL = '1';
process.env.VERCEL_ENV = 'production';
process.env.ADMIN_TG_IDS = '';

import test from 'node:test';
import assert from 'node:assert/strict';

const app = (await import('../server/index.js')).default;

const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

test('a production deployment with no admins named lets nobody in', async () => {
  // ?admin=1 is the demo's own way in. In production it must mean nothing.
  for (const path of [
    '/api/admin/customers', '/api/admin/inquiries', '/api/admin/profit',
    '/api/admin/channels', '/api/admin/posts',
  ]) {
    const res = await fetch(`${base}${path}?tgid=7&admin=1`);
    assert.equal(res.status, 403, `${path} must be refused`);
  }
});

test('syncing a channel is an admin action too', async () => {
  const res = await fetch(`${base}/api/admin/channels/bags/sync?tgid=7&admin=1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ admin: '1' }),
  });
  assert.equal(res.status, 403);
});

test('the client side is told it is not a demo, so it offers no cabinet', async () => {
  const config = await (await fetch(`${base}/api/config?tgid=7`)).json();
  assert.equal(config.demo, false);
});

test('the shop itself stays open — this closes the office, not the door', async () => {
  const feed = await (await fetch(`${base}/api/feed?kind=catalog&tgid=7`)).json();
  assert.ok(Array.isArray(feed.posts), 'clients can still browse');
  const me = await (await fetch(`${base}/api/me?tgid=7`)).json();
  assert.equal(me.admin, false);
});

test('adding a catalogue is an admin action, and a bad handle is refused there', async () => {
  const res = await fetch(`${base}/api/admin/channels?tgid=7&admin=1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: '@whatever', admin: '1' }),
  });
  assert.equal(res.status, 403, 'no admins named — nobody adds channels either');
});
