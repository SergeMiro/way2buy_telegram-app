// The daily/weekly report — «Звіт» in the cabinet, and the same text the bot DMs.
//
// This file exists because the route answered 500 in production for months and
// nothing here noticed. Two of its queries were written against SQLite and only
// break on Postgres, which is what production runs:
//
//   • `HAVING n <= 1` referred to a select-list alias. HAVING is evaluated
//     before the select list exists, so Postgres sees an unknown column.
//   • `MAX(created_at).slice(0, 10)` assumed a string. node-postgres returns a
//     Date, and Date has no .slice.
//
// Neither is visible by reading — both need the query actually run, so every
// test here goes through the real buildSignals/buildReport against the real
// schema rather than against a stub.
import './helpers/tmpdb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { migrate, db } from '../server/db.js';
import { buildSignals, buildReport, renderReportText } from '../server/ai.js';

await migrate();

const DAY = 86400000;
const NOW = new Date(Date.UTC(2026, 7, 17, 12));
const iso = (ms) => new Date(ms).toISOString();

let seq = 0;
async function customer({ name, birthday = null, createdDaysAgo = 400 }) {
  seq += 1;
  return Number((await db.prepare(
    'INSERT INTO customers (tg_user_id,name,birthday,created_at) VALUES (?,?,?,?)')
    .run(`rep-${seq}`, name, birthday, iso(NOW.getTime() - createdDaysAgo * DAY))).lastInsertRowid);
}
const sale = (cid, amount, daysAgo) => db.prepare(
  `INSERT INTO purchases (customer_id,title,amount_usd,status,created_at)
   VALUES (?,?,?,'confirmed',?)`).run(cid, 'Сумка', amount, iso(NOW.getTime() - daysAgo * DAY));

// One buyer who came back, one who bought once and vanished in the spring, and
// one whose birthday is a week out.
const loyal = await customer({ name: 'Оксана Лоял' });
await sale(loyal, 1200, 200);
await sale(loyal, 800, 0.5);

const lost = await customer({ name: 'Ірина Зникла' });
await sale(lost, 600, 150);

const fresh = await customer({ name: 'Ніна Нова', birthday: '1990-08-24', createdDaysAgo: 0.2 });

test('the report builds at all — the churn query runs on Postgres', async () => {
  // The regression itself: before the fix this threw `column "n" does not exist`
  // and the route turned it into a 500.
  const s = await buildSignals('week', NOW);
  assert.ok(s, 'signals came back');
  assert.equal(s.period, 'week');
});

test('churn risk is who bought once and long ago — and its date is a plain day', async () => {
  const s = await buildSignals('week', NOW);
  const names = s.churn.map((c) => c.name);
  assert.ok(names.includes('Ірина Зникла'), 'bought once, 150 days ago');
  assert.ok(!names.includes('Оксана Лоял'), 'two purchases is not churn');
  // `.last` came off a timestamptz. The second bug lived here.
  const gone = s.churn.find((c) => c.name === 'Ірина Зникла');
  assert.match(gone.last, /^\d{4}-\d{2}-\d{2}$/, 'a day, not a Date and not a full timestamp');
});

test('the window follows the real clock instead of a date frozen in the source', async () => {
  // A fixed `new Date('2026-07-21…')` sat in buildSignals, so every "звіт за
  // сьогодні" reported on the same July evening no matter when it was asked for.
  const week = await buildSignals('week', NOW);
  const day = await buildSignals('day', NOW);
  assert.equal(week.since, iso(NOW.getTime() - 7 * DAY));
  assert.equal(day.since, iso(NOW.getTime() - 1 * DAY));
  // And the counts follow the window: the fresh client and the recent sale are
  // inside a day, the 150-day-old one is not.
  assert.equal(Number(day.newCustomers), 1, 'only Ніна registered within the day');
  assert.equal(Number(day.salesCount), 1, 'only the half-day-old sale');
});

test('a birthday a week out is flagged, one months away is not', async () => {
  const s = await buildSignals('week', NOW);
  const names = s.birthdays.map((b) => b.name);
  assert.ok(names.includes('Ніна Нова'), '24 August is seven days from 17 August');
  assert.equal(names.length, 1);
  assert.ok(fresh > 0);
});

test('the rendered text carries the numbers, not just headings', async () => {
  const report = await buildReport('week', NOW);
  assert.equal(report.engine, 'template', 'no Gemini key in tests');
  assert.ok(report.text.includes('Ірина Зникла'), 'the churn list reached the text');
  assert.ok(report.text.includes('$'), 'money is rendered');
  // renderReportText must survive a database with nothing in it — the first
  // week of a new shop is exactly when somebody opens this.
  const empty = renderReportText({
    period: 'day', since: iso(NOW.getTime()), newCustomers: 0, salesCount: 0, salesSum: 0,
    topSpenders: [], nearReward: [], birthdays: [], churn: [], hot: [],
  });
  assert.ok(empty.includes('Продажів'), 'still a readable report, not a crash');
});

test('the report goes to the supers the roles table knows, not to a raw env list', async () => {
  // ai.js read ADMIN_TG_IDS by hand while every other alert had already moved to
  // roles.js, so a super appointed from the cabinet received the abandoned-cart
  // alerts and never the report. Same recipients now, one source.
  const { alertIds } = await import('../server/roles.js');
  const { sendReport } = await import('../server/ai.js');
  const expected = await alertIds();
  const sent = await sendReport('week', NOW);
  assert.equal(sent.sentTo, expected.length);
  assert.ok(sent.text.length > 0);
});
