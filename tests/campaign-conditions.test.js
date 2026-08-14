// Who a campaign actually reaches.
//
// This is the part where a mistake costs money rather than dignity: an audience
// that is too wide gives a discount to people who would have paid, and one that
// is too narrow is a campaign that appears to run and reaches nobody. Every
// condition is checked against a fixture of eight customers whose histories are
// deliberately different, and the combinations are checked too — because the
// bug is never in one condition, it is in two of them meeting.
import './helpers/tmpdb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { migrate, db } from '../server/db.js';
import {
  validateAudience, resolveAudience, describeAudience, previewAudience,
  create, materialize, CampaignValidationError,
} from '../server/campaigns.js';
import { listPresets, expandPreset, orthodoxEaster, blackFriday } from '../server/presets.js';

await migrate();

const DAY = 86400000;
const NOW = Date.UTC(2026, 7, 14, 12); // 14 Aug 2026
const iso = (ms) => new Date(ms).toISOString();
const daysAgo = (n) => iso(NOW - n * DAY);

// ── the shop, as a fixture ────────────────────────────────────────────────
// name              purchases   spent   last buy   birthday   joined
const PEOPLE = [
  ['Ніхто',            [],                        null,      400], // in the club, never bought
  ['Оксана',           [[300, 5]],                '11-20',   200], // one small purchase
  ['Ірина',            [[2000, 40], [1500, 10]],  '08-20',   300], // two, one recent-ish
  ['Марія',            [[900, 2], [800, 1]],      '01-15',   150], // two, both this week
  ['Софія',            [[6000, 200]],             null,      900], // big spender, long ago
  ['Ганна',            [[400, 500]],              '08-14',   950], // dormant, birthday today
  ['Леся',             [[1200, 3], [1100, 3], [900, 2]], '12-31', 60], // three, all this week
  ['Новенька',         [],                        '09-01',   5],   // joined last week
];

const ids = {};
for (const [name, purchases, birthday, joinedDaysAgo] of PEOPLE) {
  const cid = Number((await db.prepare(
    'INSERT INTO customers (tg_user_id,name,birthday,city,created_at) VALUES (?,?,?,?,?)'
  ).run(`cond-${name}`, name, birthday, name === 'Оксана' ? 'Київ' : 'Chicago',
        daysAgo(joinedDaysAgo))).lastInsertRowid);
  ids[name] = cid;
  for (const [amount, ago] of purchases) {
    await db.prepare(
      "INSERT INTO purchases (customer_id,title,amount_usd,source_channel,status,created_at) VALUES (?,?,?,?, 'confirmed',?)"
    ).run(cid, 'Сумка', amount, 'bags', daysAgo(ago));
  }
}

const who = async (audience) => {
  const list = await resolveAudience(audience, NOW);
  const byId = new Map(Object.entries(ids).map(([n, i]) => [i, n]));
  return list.map((i) => byId.get(i)).filter(Boolean).sort();
};

/* ── one condition at a time ─────────────────────────────────────────────── */

test('no conditions means everybody', async () => {
  assert.equal((await who(null)).length, PEOPLE.length);
  assert.deepEqual(describeAudience(null), ['усі клієнти']);
});

test('перше замовлення: in the club, nothing bought yet', async () => {
  assert.deepEqual(await who({ firstOrder: true }), ['Новенька', 'Ніхто']);
});

test('кількість покупок, from and to', async () => {
  assert.deepEqual(await who({ minPurchases: 3 }), ['Леся']);
  assert.deepEqual(await who({ minPurchases: 2 }), ['Ірина', 'Леся', 'Марія']);
  assert.deepEqual(await who({ minPurchases: 1, maxPurchases: 1 }), ['Ганна', 'Оксана', 'Софія']);
});

test('сума покупок, from and to', async () => {
  // Ніхто 0 · Оксана 300 · Ганна 400 · Новенька 0 · Марія 1700 · Леся 3200 ·
  // Ірина 3500 · Софія 6000 — and the bound is inclusive at both ends.
  assert.deepEqual(await who({ minSpentUsd: 3500 }), ['Ірина', 'Софія']);
  assert.deepEqual(await who({ maxSpentUsd: 500 }), ['Ганна', 'Новенька', 'Ніхто', 'Оксана']);
  assert.deepEqual(await who({ minSpentUsd: 1000, maxSpentUsd: 3500 }), ['Ірина', 'Леся', 'Марія']);
});

test('купував за останні N днів — and how many times in them', async () => {
  // "today's purchases" is this condition with a one-day window.
  assert.deepEqual(await who({ boughtWithinDays: 4 }), ['Леся', 'Марія']);
  // …and the same window with a count is what «дві покупки за місяць» means.
  assert.deepEqual(await who({ boughtWithinDays: 4, minPurchasesInWindow: 3 }), ['Леся']);
  assert.deepEqual(await who({ boughtWithinDays: 4, minPurchasesInWindow: 4 }), []);
});

test('не купував уже N днів — and somebody who never bought is not dormant', async () => {
  // Софія last bought 200 days ago, Ганна 500.
  assert.deepEqual(await who({ dormantDays: 90 }), ['Ганна', 'Софія']);
  assert.deepEqual(await who({ dormantDays: 400 }), ['Ганна']);
  // «Ніхто» has no purchases at all: they are a first-order case, not a
  // win-back one, and a win-back message would read as nonsense to them.
  assert.ok(!(await who({ dormantDays: 90 })).includes('Ніхто'));
});

test('день народження протягом N днів, with the year-end wrap', async () => {
  assert.deepEqual(await who({ birthdayWithinDays: 0 }), ['Ганна']);   // 14 Aug — today
  // Sorted by code unit, where 'І' (U+0406) comes before 'Г' (U+0413).
  assert.deepEqual(await who({ birthdayWithinDays: 7 }), ['Ірина', 'Ганна']); // Ірина: 20 Aug
  // 31 December from mid-August is 139 days off, and the wrap must not make it
  // negative or "yesterday".
  assert.ok((await who({ birthdayWithinDays: 200 })).includes('Леся'));
  assert.ok(!(await who({ birthdayWithinDays: 100 })).includes('Леся'));
});

test('чи відома дата народження', async () => {
  assert.deepEqual(await who({ hasBirthday: false }), ['Ніхто', 'Софія']);
  assert.equal((await who({ hasBirthday: true })).length, 6);
});

test('новачки клубу', async () => {
  assert.deepEqual(await who({ joinedWithinDays: 30 }), ['Новенька']);
});

test('місто і каталог', async () => {
  assert.deepEqual(await who({ city: 'Київ' }), ['Оксана']);
  assert.equal((await who({ sourceChannel: 'bags' })).length, 6, 'everyone who ever bought');
  assert.deepEqual(await who({ sourceChannel: 'shoes' }), []);
});

/* ── combinations, which is where the money is ───────────────────────────── */

test('conditions are ANDed, and the combination narrows', async () => {
  // «постійний клієнт, який купував цього тижня»
  assert.deepEqual(await who({ minPurchases: 2, boughtWithinDays: 4 }), ['Леся', 'Марія']);
  // «постійний клієнт, який витратив від $3000, і купував цього тижня»
  assert.deepEqual(await who({ minPurchases: 2, minSpentUsd: 3000, boughtWithinDays: 4 }), ['Леся']);
  // «сплячий великий клієнт» — dormant AND has spent a lot
  assert.deepEqual(await who({ dormantDays: 90, minSpentUsd: 5000 }), ['Софія']);
  // and a combination that reaches nobody is allowed to reach nobody
  assert.deepEqual(await who({ minPurchases: 3, city: 'Київ' }), []);
});

test('a preview counts the same people the campaign would reach', async () => {
  const p = await previewAudience({ minPurchases: 2, boughtWithinDays: 4 }, NOW);
  assert.equal(p.count, 2);
  assert.deepEqual(p.audience, ['покупок від 2', 'купував за останні 4 дн.']);
});

/* ── refusing nonsense rather than silently reaching nobody ──────────────── */

test('contradictions are refused at the door', async () => {
  const rejects = (audience, re) =>
    assert.throws(() => validateAudience(audience), (e) => e instanceof CampaignValidationError && re.test(e.message));

  rejects({ minSpentUsd: 500, maxSpentUsd: 100 }, /сума покупок/);
  rejects({ minPurchases: 5, maxPurchases: 2 }, /покупок до/);
  rejects({ firstOrder: true, minPurchases: 2 }, /перше замовлення/);
  rejects({ boughtWithinDays: 7, dormantDays: 30 }, /суперечить/);
  rejects({ minPurchasesInWindow: 2 }, /вкажіть період/);
  assert.throws(() => validateAudience({ whatever: 1 }), /unknown audience keys/);
});

test('an unchecked box is not a filter', async () => {
  // `false` on a flag means "no opinion". Storing it would turn every empty
  // checkbox in the builder into a condition nobody asked for.
  assert.equal(validateAudience({ firstOrder: false }), null);
  // hasBirthday is the exception: "we do not know their date" is a real
  // audience, and one worth writing to.
  assert.deepEqual(validateAudience({ hasBirthday: false }), { hasBirthday: false });
});

/* ── the presets ─────────────────────────────────────────────────────────── */

test('the movable feasts are computed, not stored', () => {
  const d = (ms) => new Date(ms).toISOString().slice(0, 10);
  // Orthodox Easter, which is what this shop's clients keep.
  assert.equal(d(orthodoxEaster(2025)), '2025-04-20');
  assert.equal(d(orthodoxEaster(2026)), '2026-04-12');
  assert.equal(d(orthodoxEaster(2027)), '2027-05-02');
  assert.equal(d(orthodoxEaster(2028)), '2028-04-16');
  // Black Friday is the day after the fourth Thursday of November — and it had
  // better be a Friday every single year.
  for (const y of [2025, 2026, 2027, 2028]) {
    const bf = new Date(blackFriday(y));
    assert.equal(bf.getUTCDay(), 5, `${y} Black Friday must be a Friday`);
    assert.equal(bf.getUTCMonth(), 10, `${y} Black Friday must be in November`);
  }
});

test('a preset picked after its season offers the next one, not a window in the past', () => {
  const all = listPresets(NOW); // mid-August 2026
  const easter = all.find((p) => p.key === 'easter');
  assert.equal(easter.startsAt.slice(0, 4), '2027', 'Easter 2026 is over — offer 2027');
  const bf = all.find((p) => p.key === 'black_friday');
  assert.equal(bf.startsAt.slice(0, 7), '2026-11', 'Black Friday 2026 has not happened yet');
  const christmas = all.find((p) => p.key === 'christmas');
  assert.equal(christmas.startsAt.slice(0, 10), '2026-12-20');
  assert.equal(christmas.endsAt.slice(0, 10), '2027-01-08', 'the window crosses the new year');
});

test('every preset expands into something a campaign can be created from', async () => {
  for (const p of listPresets(NOW)) {
    const input = expandPreset(p.key, NOW);
    assert.ok(input, `${p.key} must expand`);
    assert.ok(input.name && input.type, `${p.key} needs a name and a type`);
    // The audience must be valid — a preset that cannot be saved is worse than
    // no preset, because it fails at the moment somebody is trying to use it.
    assert.doesNotThrow(() => validateAudience(input.audience), `${p.key} audience`);
    const c = await create({ ...input, createdBy: 'test' }, { now: NOW });
    assert.equal(c.preset, p.key);
    assert.ok(Number(c.value) > 0, `${p.key} must carry a discount`);
  }
});

test('a fixed-sum campaign mints fixed-sum promo codes', async () => {
  const c = await create({
    name: 'Різдво', type: 'holiday', mode: 'fixed', value: 75, minOrderUsd: 400,
    audience: { minPurchases: 3 }, promoValidDays: 10,
  }, { now: NOW });
  assert.equal(c.mode, 'fixed');
  assert.equal(Number(c.value), 75);
  assert.equal(Number(c.percent), 0, 'a sum has no meaningful percentage');

  const res = await materialize(c.id, NOW);
  assert.equal(res.total, 1, 'only Леся has three purchases');
  assert.equal(res.created, 1);
  const promo = await db.prepare('SELECT * FROM promo_codes WHERE campaign_id=?').get(c.id);
  assert.equal(promo.mode, 'fixed');
  assert.equal(Number(promo.amount_usd), 75);
  assert.equal(Number(promo.min_order_usd), 400);

  // Running it again in the same year is a no-op, which is the property the
  // whole materialize design exists for.
  const again = await materialize(c.id, NOW);
  assert.equal(again.created, 0);
  assert.equal(again.alreadyExisted, 1);
});
