// Did the client buy it?
//
// The inquiry is the deal, `deal_status` is the answer, and this file is that
// promise under pressure: the reminder must arrive on the fifth day and not the
// fourth, exactly once however many times the sweep runs, again five days later
// if nobody answered, never for a deal that is already settled, and a wrong tap
// must be one tap to undo.
import './helpers/tmpdb.js';
process.env.W2B_DEAL_FOLLOWUP_DAYS = '5';
delete process.env.PUBLIC_URL;

import test from 'node:test';
import assert from 'node:assert/strict';
import { migrate, db } from '../server/db.js';
import { addToCart, sendInquiry, listInquiries } from '../server/cart.js';
import {
  STATUSES, config, counts, setStatus, pending, remindStaleDeals, daysOpen, dealUrl,
} from '../server/deals.js';
import { set as setSetting } from '../server/settings.js';

await migrate();

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 7, 1, 12);
const iso = (ms) => new Date(ms).toISOString();

let seq = 0;
async function customer(name = 'Клієнт') {
  seq += 1;
  return await db.prepare('SELECT * FROM customers WHERE id=?').get(
    (await db.prepare('INSERT INTO customers (tg_user_id,name,phone,created_at) VALUES (?,?,?,?)')
      .run(`deal-${seq}`, `${name} ${seq}`, '+15550001', iso(NOW - 30 * DAY))).lastInsertRowid
  );
}
async function post(title = 'Chanel 22') {
  seq += 1;
  return Number((await db.prepare(`INSERT INTO posts
    (channel,tg_message_id,title,body,price,currency,image_url,article,source,status,created_at)
    VALUES ('bags',?,?,'',500,'USD','👜',?, 'channel','published',?)`)
    .run(seq, title, `ART-${seq}`, iso(NOW))).lastInsertRowid);
}

/** A client who asked about one bag `daysAgo` days ago. */
async function inquiry({ daysAgo = 0, name = 'Оксана' } = {}) {
  const c = await customer(name);
  const at = NOW - daysAgo * DAY;
  await addToCart({ customerId: c.id, postId: await post(), now: at });
  const r = await sendInquiry({ customer: c, message: 'Скільки?', now: at });
  // sendInquiry stamps `now`; the row is backdated here so the age of a deal is
  // a fact in the table rather than an argument passed to the sweep.
  await db.prepare('UPDATE inquiries SET created_at=? WHERE id=?').run(iso(at), r.inquiryId);
  return { customer: c, id: r.inquiryId };
}

const nudges = async (inquiryId) =>
  (await db.prepare(
    "SELECT COUNT(*) n FROM notifications WHERE kind='deal_followup' AND dedupe_key LIKE ?"
  ).get(`deal-followup:${inquiryId}:%`)).n;

const statusOf = async (id) =>
  (await db.prepare('SELECT deal_status, followup_count, followup_last_at FROM inquiries WHERE id=?').get(id));

/* ── the deal starts by itself ────────────────────────────────────────────── */

test('sending an inquiry opens a deal — nobody has to create one', async () => {
  const { id } = await inquiry();
  const row = await statusOf(id);
  assert.equal(row.deal_status, 'in_progress');
  assert.equal(row.followup_count, 0);
  assert.equal(row.followup_last_at, null);
});

test('the database refuses a fourth state', async () => {
  const { id } = await inquiry();
  await assert.rejects(
    () => db.prepare('UPDATE inquiries SET deal_status=? WHERE id=?').run('maybe', id),
    // The CHECK constraint, not an if — see the comment in schema.sql.
    (e) => /deal_status|check/i.test(String(e.message))
  );
});

test('setStatus refuses anything outside the three', async () => {
  const { id } = await inquiry();
  await assert.rejects(() => setStatus(id, { status: 'paid' }), /in_progress/);
  assert.equal((await statusOf(id)).deal_status, 'in_progress');
});

test('an unknown id is answered with false, not an exception', async () => {
  assert.equal(await setStatus(999_999, { status: 'bought' }), false);
});

/* ── ✓ / ✕, and undoing them ──────────────────────────────────────────────── */

test('купив / не купив are recorded with who said so and when', async () => {
  const { id } = await inquiry();
  assert.equal(await setStatus(id, { status: 'bought', by: '777', now: NOW }), true);

  const row = await db.prepare('SELECT * FROM inquiries WHERE id=?').get(id);
  assert.equal(row.deal_status, 'bought');
  assert.equal(row.deal_status_by, '777');
  assert.equal(iso(new Date(row.deal_status_at).getTime()), iso(NOW));
});

test('a wrong tap is one tap to undo — in both directions', async () => {
  const { id } = await inquiry();
  await setStatus(id, { status: 'bought', now: NOW });
  await setStatus(id, { status: 'not_bought', now: NOW });
  assert.equal((await statusOf(id)).deal_status, 'not_bought');
  // …and all the way back into the open tab.
  await setStatus(id, { status: 'in_progress', now: NOW });
  assert.equal((await statusOf(id)).deal_status, 'in_progress');
});

test('the three tabs are one query, and the counters add up', async () => {
  const before = await counts();
  const a = await inquiry();
  const b = await inquiry();
  await setStatus(a.id, { status: 'bought', now: NOW });
  await setStatus(b.id, { status: 'not_bought', now: NOW });

  const after = await counts();
  assert.equal(after.bought, before.bought + 1);
  assert.equal(after.not_bought, before.not_bought + 1);

  const boughtTab = await listInquiries({ deal: 'bought', limit: 200 });
  assert.ok(boughtTab.some((q) => q.id === a.id));
  assert.ok(!boughtTab.some((q) => q.id === b.id));
  assert.equal(boughtTab.every((q) => q.dealStatus === 'bought'), true);
});

test('the cabinet reads the deal back with the row', async () => {
  const { id } = await inquiry();
  await setStatus(id, { status: 'bought', by: 'maryna', now: NOW });
  const one = (await listInquiries({ id, limit: 1 }))[0];
  assert.equal(one.id, id);
  assert.equal(one.dealStatus, 'bought');
  assert.equal(one.dealStatusBy, 'maryna');
});

/* ── the nudge: on the fifth day, and not before ──────────────────────────── */

test('a deal younger than the window is not due', async () => {
  const { id } = await inquiry({ daysAgo: 4 });
  const due = await pending(NOW, await config());
  assert.ok(!due.some((r) => r.id === id));

  await remindStaleDeals(NOW);
  assert.equal(await nudges(id), 0);
});

test('on the fifth day the owners are asked', async () => {
  const { id } = await inquiry({ daysAgo: 5 });
  const res = await remindStaleDeals(NOW);
  assert.equal(res.days, 5);
  assert.ok(res.reminded >= 1);
  assert.equal(await nudges(id), 1);

  const row = await statusOf(id);
  assert.equal(row.followup_count, 1);
  assert.ok(row.followup_last_at);
  // Asking is not answering: the deal stays exactly where it was.
  assert.equal(row.deal_status, 'in_progress');
});

test('the message says how long it has been and what to do', async () => {
  const { id } = await inquiry({ daysAgo: 7 });
  await remindStaleDeals(NOW);
  const n = await db.prepare(
    "SELECT title, body FROM notifications WHERE dedupe_key=?"
  ).get(`deal-followup:${id}:1`);
  assert.match(n.title, /7 днів/);
  assert.match(n.body, /Купив\?/);
  assert.match(n.body, /через 5 днів/);
});

/* ── exactly once, however many times the sweep runs ──────────────────────── */

test('running the sweep five times sends one nudge', async () => {
  const { id } = await inquiry({ daysAgo: 6 });
  for (let i = 0; i < 5; i += 1) await remindStaleDeals(NOW);
  assert.equal(await nudges(id), 1);
  assert.equal((await statusOf(id)).followup_count, 1);
});

test('two sweeps racing produce one nudge, not two', async () => {
  const { id } = await inquiry({ daysAgo: 6 });
  await Promise.all([remindStaleDeals(NOW), remindStaleDeals(NOW), remindStaleDeals(NOW)]);
  assert.equal(await nudges(id), 1);
  assert.equal((await statusOf(id)).followup_count, 1);
});

/* ── and again five days later ────────────────────────────────────────────── */

test('silence is an answer that expires: the next nudge comes N days later', async () => {
  const { id } = await inquiry({ daysAgo: 5 });
  await remindStaleDeals(NOW);
  assert.equal(await nudges(id), 1);

  // Four days after the first nudge — still nothing.
  await remindStaleDeals(NOW + 4 * DAY);
  assert.equal(await nudges(id), 1);

  // Five days after it — asked again, and the second nudge is its own message
  // rather than a repeat swallowed by the dedupe key.
  await remindStaleDeals(NOW + 5 * DAY);
  assert.equal(await nudges(id), 2);
  assert.equal((await statusOf(id)).followup_count, 2);
});

/* ── a settled deal is left alone ─────────────────────────────────────────── */

test('a deal marked купив is never nudged again', async () => {
  const { id } = await inquiry({ daysAgo: 30 });
  await setStatus(id, { status: 'bought', now: NOW });
  await remindStaleDeals(NOW);
  await remindStaleDeals(NOW + 30 * DAY);
  assert.equal(await nudges(id), 0);
});

test('a deal marked не купив is never nudged again', async () => {
  const { id } = await inquiry({ daysAgo: 30 });
  await setStatus(id, { status: 'not_bought', now: NOW });
  await remindStaleDeals(NOW + 60 * DAY);
  assert.equal(await nudges(id), 0);
});

test('correcting a status restarts the clock instead of firing at once', async () => {
  const { id } = await inquiry({ daysAgo: 30 });
  await setStatus(id, { status: 'bought', now: NOW });
  // Wrong tap, put back in progress. A 30-day-old inquiry would otherwise be
  // instantly overdue and the nudge would look like a consequence of the fix.
  await setStatus(id, { status: 'in_progress', now: NOW });
  await remindStaleDeals(NOW);
  assert.equal(await nudges(id), 0);

  await remindStaleDeals(NOW + 5 * DAY);
  assert.equal(await nudges(id), 1);
});

/* ── the switch and the arithmetic ────────────────────────────────────────── */

test('the window is a setting in the cabinet, and it is read every time', async () => {
  // No longer an environment variable: the row is what answers, and changing it
  // takes effect on the next sweep with no restart. The env var seeded it — see
  // settings.js — which is why it starts at 5 here.
  assert.equal((await config()).days, 5);
  await setSetting('deal.followup_days', 7);
  assert.equal((await config()).days, 7);
  await setSetting('deal.followup_days', 5);
  assert.equal((await config()).days, 5);
});

test('a value outside the allowed range is refused, not clamped silently', async () => {
  await assert.rejects(() => setSetting('deal.followup_days', 0), /не менше 1/);
  await assert.rejects(() => setSetting('deal.followup_days', 1000), /не більше 90/);
  assert.equal((await config()).days, 5);
});

test('the whole sweep can be switched off from the cabinet', async () => {
  const { id } = await inquiry({ daysAgo: 40 });
  await setSetting('deal.followup_enabled', 0);
  const res = await remindStaleDeals(NOW);
  assert.equal(res.skipped, true);
  assert.equal(await nudges(id), 0);

  // …and switching it back on resumes the nudges for the deals that waited.
  await setSetting('deal.followup_enabled', 1);
  await remindStaleDeals(NOW);
  assert.equal(await nudges(id), 1);
});

test('the three tabs keep working while the nudges are off', async () => {
  await setSetting('deal.followup_enabled', 0);
  const { id } = await inquiry({ daysAgo: 40 });
  assert.equal(await setStatus(id, { status: 'bought', now: NOW }), true);
  assert.equal((await statusOf(id)).deal_status, 'bought');
  await setSetting('deal.followup_enabled', 1);
});

test('daysOpen counts whole days and never goes negative', () => {
  assert.equal(daysOpen(iso(NOW - 5 * DAY), NOW), 5);
  assert.equal(daysOpen(iso(NOW - 5 * DAY - 1000), NOW), 5);
  assert.equal(daysOpen(iso(NOW + DAY), NOW), 0);
});

test('the three states are the three tabs, in the order they are shown', () => {
  assert.deepEqual(STATUSES, ['in_progress', 'bought', 'not_bought']);
});

/* ── the link in the message ──────────────────────────────────────────────── */

test('the nudge links to that one deal — a query parameter, not a fragment', () => {
  // A #fragment would be competing with tgWebAppData=…, which Telegram appends
  // to the URL when it opens a Mini App. See the comment on dealUrl().
  process.env.PUBLIC_URL = 'https://shop.example/app';
  assert.equal(dealUrl(42), 'https://shop.example/app?deal=42');
  // A trailing slash must not become '//?deal=', and an existing query must not
  // be replaced by ours.
  process.env.PUBLIC_URL = 'https://shop.example/app/';
  assert.equal(dealUrl(42), 'https://shop.example/app?deal=42');
  process.env.PUBLIC_URL = 'https://shop.example/app?v=2';
  assert.equal(dealUrl(42), 'https://shop.example/app?v=2&deal=42');
  delete process.env.PUBLIC_URL;
});

test('without a PUBLIC_URL there is no button, and the nudge still goes out', async () => {
  const { id } = await inquiry({ daysAgo: 9 });
  delete process.env.PUBLIC_URL;
  assert.equal(dealUrl(id), null);
  await remindStaleDeals(NOW);
  assert.equal(await nudges(id), 1);
});
