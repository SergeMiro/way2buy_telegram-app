// Every tunable number, and the promises the settings table has to keep.
//
// Three of them matter more than the rest, because breaking any one turns a
// convenience into a hazard:
//   • a restart must never undo an edit made in the cabinet;
//   • an out-of-range value must be refused, not stored and not silently
//     rounded into something the person did not type;
//   • a missing row must never produce NaN — the whole app reads through here,
//     and a NaN interval means a scheduler that fires forever or never.
import './helpers/tmpdb.js';
// Set BEFORE migrate(): these are the first-boot seed, which is the only moment
// the environment is consulted at all.
process.env.W2B_ABANDON_HOURS = '8';
process.env.W2B_PHOTO_MAX_BYTES = String(3 * 1024 * 1024);

import test from 'node:test';
import assert from 'node:assert/strict';
import { migrate, db } from '../server/db.js';
import {
  DEFINITIONS, definitionOf, all, num, nums, set, setMany, reset,
  seedSettings, invalidate, SettingError,
} from '../server/settings.js';
import { config as abandonConfig } from '../server/abandoned.js';

await migrate();

const rowOf = async (key) =>
  await db.prepare('SELECT * FROM app_settings WHERE key=?').get(key);

/* ── the definitions are the contract ────────────────────────────────────── */

test('every definition is complete and internally consistent', () => {
  for (const d of DEFINITIONS) {
    assert.ok(d.key && /^[a-z_]+\.[a-z_]+$/.test(d.key), `ключ ${d.key}`);
    assert.ok(d.label && d.group && d.kind, `опис ${d.key}`);
    assert.equal(typeof d.def, 'number', `default ${d.key}`);
    assert.ok(d.min <= d.def && d.def <= d.max, `${d.key}: default поза межами`);
    assert.ok(d.step > 0, `step ${d.key}`);
  }
});

test('no two settings share a key', () => {
  const keys = DEFINITIONS.map((d) => d.key);
  assert.equal(new Set(keys).size, keys.length);
});

/* ── first boot ──────────────────────────────────────────────────────────── */

test('migrate() creates a row for every setting', async () => {
  const n = (await db.prepare('SELECT COUNT(*) c FROM app_settings').get()).c;
  assert.equal(n, DEFINITIONS.length);
});

test('the environment variable is the seed, and the unit is converted', async () => {
  // W2B_ABANDON_HOURS=8 was set above, so the shop that was already running
  // with 8 keeps 8 instead of being reset to the default 5.
  assert.equal(await num('abandon.hours'), 8);
  // Bytes in the variable, megabytes on the screen.
  assert.equal(await num('photo.max_mb'), 3);
});

test('a setting with no variable set starts at its default', async () => {
  assert.equal(await num('deal.followup_days'), definitionOf('deal.followup_days').def);
});

test('re-seeding never overwrites — this is what makes a restart safe', async () => {
  await set('deal.followup_days', 30);
  const again = await seedSettings();
  assert.equal(again.created, 0);
  assert.equal(await num('deal.followup_days'), 30);
  await reset('deal.followup_days');
});

/* ── writing ─────────────────────────────────────────────────────────────── */

test('a saved value is what comes back, with who saved it and when', async () => {
  await set('sync.pages', 9, { by: '777', now: Date.UTC(2026, 8, 1) });
  assert.equal(await num('sync.pages'), 9);
  const row = await rowOf('sync.pages');
  assert.equal(Number(row.value), 9);
  assert.equal(row.updated_by, '777');
  assert.ok(row.updated_at);
  await reset('sync.pages');
});

test('out of range is refused rather than clamped', async () => {
  const before = await num('photo.quality');
  await assert.rejects(() => set('photo.quality', 5), SettingError);
  await assert.rejects(() => set('photo.quality', 200), SettingError);
  assert.equal(await num('photo.quality'), before, 'значення не мало змінитись');
});

test('not a number is refused', async () => {
  await assert.rejects(() => set('sync.pages', 'скільки треба'), /потрібно число/);
  await assert.rejects(() => set('sync.pages', NaN), /потрібно число/);
});

test('an unknown key is refused — a row nobody defines cannot introduce behaviour', async () => {
  await assert.rejects(() => set('nope.nope', 1), /невідомий параметр/);
});

test('one bad field does not half-save the card', async () => {
  const wasPages = await num('sync.pages');
  const wasDelay = await num('sync.tme_delay_ms');
  await assert.rejects(
    () => setMany({ 'sync.pages': 7, 'sync.tme_delay_ms': 5 }),   // 5ms is below the floor
    SettingError
  );
  assert.equal(await num('sync.pages'), wasPages, 'перше поле не мало зберегтись');
  assert.equal(await num('sync.tme_delay_ms'), wasDelay);
});

test('a whole card saves at once', async () => {
  await setMany({ 'photo.width': 800, 'photo.quality': 90 });
  assert.equal(await num('photo.width'), 800);
  assert.equal(await num('photo.quality'), 90);
  await setMany({ 'photo.width': 720, 'photo.quality': 76 });
});

test('reset goes back to the value the shop was installed with', async () => {
  await set('vision.batch', 40);
  assert.equal(await num('vision.batch'), 40);
  await reset('vision.batch');
  assert.equal(await num('vision.batch'), definitionOf('vision.batch').def);
});

/* ── reading ─────────────────────────────────────────────────────────────── */

test('a write is visible immediately, not after the cache expires', async () => {
  await num('sync.pages');                        // warm the cache
  await set('sync.pages', 11);
  assert.equal(await num('sync.pages'), 11);      // no waiting for the TTL
  await reset('sync.pages');
});

test('a missing row falls back to the default instead of NaN', async () => {
  await db.prepare('DELETE FROM app_settings WHERE key=?').run('llm.budget_ms');
  invalidate();
  const v = await num('llm.budget_ms');
  assert.equal(v, definitionOf('llm.budget_ms').def);
  assert.ok(Number.isFinite(v));
  await seedSettings();                            // put it back
});

test('a value someone wrote past the bounds by hand is clamped on the way out', async () => {
  // Nothing in the app can write this, but a hand at a SQL prompt can — and the
  // reader is the last line of defence before a 0-minute scheduler interval.
  await db.prepare('UPDATE app_settings SET value=0 WHERE key=?').run('scheduler.interval_min');
  invalidate();
  assert.equal(await num('scheduler.interval_min'), definitionOf('scheduler.interval_min').min);
  await reset('scheduler.interval_min');
});

test('an unknown key reads as 0 rather than throwing inside a scheduler pass', async () => {
  assert.equal(await num('nope.nope'), 0);
});

test('nums() answers several at once', async () => {
  const s = await nums('photo.width', 'photo.quality');
  assert.equal(s['photo.width'], 720);
  assert.equal(s['photo.quality'], 76);
});

/* ── what the cabinet draws ──────────────────────────────────────────────── */

test('all() groups the settings in display order with their bounds', async () => {
  const { groups, rows } = await all();
  assert.equal(rows.length, DEFINITIONS.length);
  assert.ok(groups.length >= 5);
  assert.equal(groups[0].title, 'Продажі');

  const item = rows.find((r) => r.key === 'deal.followup_days');
  assert.equal(item.label, definitionOf('deal.followup_days').label);
  assert.equal(item.min, 1);
  assert.equal(item.max, 90);
  assert.equal(item.isDefault, true);
});

test('all() says when a value is no longer the default, so the screen can offer to undo it', async () => {
  await set('deal.followup_days', 7);
  const item = (await all()).rows.find((r) => r.key === 'deal.followup_days');
  assert.equal(item.value, 7);
  assert.equal(item.isDefault, false);
  assert.equal(item.def, 5);
  await reset('deal.followup_days');
  assert.equal((await all()).rows.find((r) => r.key === 'deal.followup_days').isDefault, true);
});

/* ── switches ────────────────────────────────────────────────────────────── */

test('a switch is stored as 1/0 in the same column and read as a boolean', async () => {
  const { flag } = await import('../server/settings.js');
  assert.equal(await flag('deal.followup_enabled'), true, 'типово увімкнено');
  await set('deal.followup_enabled', 0);
  assert.equal(await flag('deal.followup_enabled'), false);
  assert.equal(await num('deal.followup_enabled'), 0);
  await set('deal.followup_enabled', 1);
  assert.equal(await flag('deal.followup_enabled'), true);
});

test('a switch refuses anything but 0 and 1', async () => {
  await assert.rejects(() => set('abandon.enabled', 2), SettingError);
  await assert.rejects(() => set('abandon.enabled', -1), SettingError);
  assert.equal(await num('abandon.enabled'), 1);
});

test('the cabinet gets switches as kind=switch with their two bounds', async () => {
  const rows = (await all()).rows;
  const sw = rows.filter((r) => r.kind === 'switch');
  assert.equal(sw.length, 2, 'два тумблера');
  for (const it of sw) {
    assert.equal(it.min, 0);
    assert.equal(it.max, 1);
    assert.ok(it.value === 0 || it.value === 1);
  }
  // Each sits at the top of its own card, before the numbers it governs.
  const products = rows.filter((r) => r.group === 'Продажі');
  assert.equal(products[0].key, 'deal.followup_enabled');
});

/* ── the consumers actually read it ──────────────────────────────────────── */

test('the abandoned-cart rule takes its four numbers from the table', async () => {
  await setMany({
    'abandon.hours': 6,
    'abandon.percent': 15,
    'abandon.valid_days': 3,
    'abandon.min_order_usd': 250,
  });
  const cfg = await abandonConfig();
  assert.equal(cfg.hours, 6);
  assert.equal(cfg.percent, 15);
  assert.equal(cfg.validDays, 3);
  assert.equal(cfg.minOrderUsd, 250);
  // The rule names itself from those numbers, so editing them renames it — and
  // the rename is what makes the new offer a different one-off from the old.
  assert.equal(cfg.grantKey, '6hour_15per');
});
