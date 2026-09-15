// What the bot SAYS, in the language the client reads.
//
// The interface has spoken three languages since the first week and everything
// the server sent spoke one. The fix has a seam that is easy to get subtly
// wrong, so it is pinned here from both sides:
//
//   the notification ROW must stay Ukrainian — the cabinet reads it, the
//   browser translator matches it by exact phrase, and other suites assert its
//   wording;
//   the DM must not — it is the half with no DOM to re-translate, and it is the
//   only half the client reads outside the app.
//
// A test that only checked the DM would pass while the cabinet quietly turned
// Russian; a test that only checked the row would pass while nothing changed at
// all. Both, or neither.
import './helpers/tmpdb.js';
process.env.VERCEL = '1';
process.env.ADMIN_TG_IDS = '';

import test from 'node:test';
import assert from 'node:assert/strict';
import { migrate, db } from '../server/db.js';
import { notifyCustomer } from '../server/notify.js';
import { outbox, clearOutbox } from '../server/telegram.js';
import { render, normalizeLang, messageKeys, LANGS, DEFAULT_LANG, dmy, personName } from '../server/i18n.js';

await migrate();

const app = (await import('../server/index.js')).default;
const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

let seq = 0;
async function customer({ lang = null } = {}) {
  seq += 1;
  const tgId = `lang-${seq}`;
  const info = await db.prepare(
    'INSERT INTO customers (tg_user_id,name,lang,created_at) VALUES (?,?,?,?)'
  ).run(tgId, `Клієнт ${seq}`, lang, new Date().toISOString());
  return await db.prepare('SELECT * FROM customers WHERE id=?').get(info.lastInsertRowid);
}

// The DM is fire-and-forget by design (notify.js): the row is awaited, the
// message is not. Nothing to hook, so give the microtask a turn.
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/* ── reading the request's language ──────────────────────────────────────── */

test('a language tag is read down to its base, and an unknown one is not guessed at', () => {
  assert.equal(normalizeLang('uk-UA'), 'uk');
  assert.equal(normalizeLang('ru-RU'), 'ru');
  assert.equal(normalizeLang('en-US'), 'en');
  assert.equal(normalizeLang('RU'), 'ru');
  // A browser that was never near the app sends a weighted list; the first
  // entry is the one the person actually reads.
  assert.equal(normalizeLang('en-US,en;q=0.9,ru;q=0.8'), 'en');
  // Null rather than a default, so a caller can tell "asked for something we do
  // not have" from "asked for Ukrainian".
  assert.equal(normalizeLang('pl'), null);
  assert.equal(normalizeLang(''), null);
  assert.equal(normalizeLang(undefined), null);
});

/* ── names ───────────────────────────────────────────────────────────────── */

test('a name is spelled in the alphabet of the sentence around it', () => {
  // The mixture this removes: «Даша will check availability and send you the
  // price» — one sentence, two alphabets.
  assert.equal(personName('Даша', 'en'), 'Dasha');
  assert.equal(personName('Марина', 'en'), 'Maryna');
  // Two-letter mappings keep one capital: «Zhanna», never «ZHanna».
  assert.equal(personName('Жанна', 'en'), 'Zhanna');
  // Russian and Ukrainian already read the Cyrillic spelling the shop chose.
  assert.equal(personName('Даша', 'ru'), 'Даша');
  assert.equal(personName('Даша', 'uk'), 'Даша');
  // A Latin name is left exactly as configured, in every language.
  assert.equal(personName('Dasha', 'en'), 'Dasha');
  assert.equal(personName('', 'en'), '');
});

test('every message carrying a name transliterates it for English only', () => {
  for (const key of messageKeys()) {
    const params = {
      items: 1, percent: 10, code: 'C', minOrderUsd: 0, validDays: 7,
      amountLabel: '10%', until: '30.09.2026', who: 'Даша', answer: 'є чорна',
    };
    const en = render('en', key, params);
    const ru = render('ru', key, params);
    // English must not contain the Cyrillic spelling of the name…
    assert.doesNotMatch(`${en.title} ${en.body}`, /Даша/, `${key}/en: a Cyrillic name in an English sentence`);
    // …and Russian must not be handed a transliteration it never asked for.
    assert.doesNotMatch(`${ru.title} ${ru.body}`, /Dasha/, `${key}/ru: a transliterated name in a Russian sentence`);
  }
});

/* ── dates ───────────────────────────────────────────────────────────────── */

test('a date in a sentence is 13.10.2026 — never the ISO string it came from', () => {
  // The bug this pins: `.slice(0, 10)` on an ISO timestamp, which put
  // «діє до 2026-10-13» in front of a client.
  assert.equal(dmy('2026-10-13T00:00:00.000Z'), '13.10.2026');
  // Single digits keep their zero, so a column of dates stays a column.
  assert.equal(dmy('2026-01-05T12:00:00.000Z'), '05.01.2026');
  // Milliseconds and Date objects are the same date as the string form.
  assert.equal(dmy(Date.UTC(2026, 9, 13)), '13.10.2026');
  assert.equal(dmy(new Date('2026-10-13T00:00:00.000Z')), '13.10.2026');
  // UTC, like the columns it reads. Late evening in Kyiv is still the 13th
  // here; reading it locally would have moved the promo code a day.
  assert.equal(dmy('2026-10-13T22:30:00.000Z'), '13.10.2026');
  // Nothing sensible in, nothing in the sentence out — a message that says
  // «діє до Invalid Date» is worse than one that says nothing.
  assert.equal(dmy('не дата'), '');
  assert.equal(dmy(null), '');
});

test('no message renders an ISO date, in any language', () => {
  const params = {
    items: 3, percent: 10, code: 'W2B-TEST', minOrderUsd: 200, validDays: 7,
    amountLabel: '15%', until: dmy('2026-09-30T00:00:00.000Z'), who: 'Даша',
    answer: 'є чорна і бежева',
  };
  for (const key of messageKeys()) {
    for (const lang of LANGS) {
      const { title, body } = render(lang, key, params);
      assert.doesNotMatch(`${title} ${body}`, /\d{4}-\d{2}-\d{2}/,
        `${key}/${lang}: a year-first date reached the client`);
    }
  }
});

/* ── the catalogue ───────────────────────────────────────────────────────── */

test('every message exists in every language, and none of them is empty', () => {
  const params = {
    items: 3, percent: 10, code: 'W2B-TEST', minOrderUsd: 200, validDays: 7,
    amountLabel: '15%', until: '30.09.2026', who: 'Даша',
    // Dasha's own words, carried verbatim. Given the same marker as the code so
    // the "params reached the sentence" check below covers this key too — an
    // answer that renders as «undefined» is the failure this catches.
    answer: 'W2B-TEST',
  };
  for (const key of messageKeys()) {
    for (const lang of LANGS) {
      const { title, body } = render(lang, key, params);
      assert.ok(title && title.trim(), `${key}/${lang}: empty title`);
      assert.ok(body && body.trim(), `${key}/${lang}: empty body`);
      // The parameters have to reach the sentence, not merely be accepted.
      if (key !== 'inquiry_sent') assert.match(body, /W2B-TEST|15%|10%/, `${key}/${lang}: params dropped`);
    }
  }
});

test('the three languages actually differ — a missing translation is a copied one', () => {
  for (const key of messageKeys()) {
    const uk = render('uk', key, { items: 2, percent: 10, code: 'C', minOrderUsd: 0, validDays: 7, amountLabel: '10%', until: '30.09.2026', who: 'Даша', answer: 'є чорна' });
    const ru = render('ru', key, { items: 2, percent: 10, code: 'C', minOrderUsd: 0, validDays: 7, amountLabel: '10%', until: '30.09.2026', who: 'Даша', answer: 'є чорна' });
    const en = render('en', key, { items: 2, percent: 10, code: 'C', minOrderUsd: 0, validDays: 7, amountLabel: '10%', until: '30.09.2026', who: 'Даша', answer: 'є чорна' });
    assert.notEqual(uk.body, ru.body, `${key}: Ukrainian and Russian are the same string`);
    assert.notEqual(uk.body, en.body, `${key}: Ukrainian and English are the same string`);
  }
});

test('a language nobody wrote falls back to Ukrainian instead of failing', () => {
  const params = { amountLabel: '10%', minOrderUsd: 0, validDays: 7 };
  assert.deepEqual(render('pl', 'birthday_available', params), render(DEFAULT_LANG, 'birthday_available', params));
  assert.deepEqual(render(null, 'birthday_available', params), render(DEFAULT_LANG, 'birthday_available', params));
});

test('an unknown key throws rather than sending an empty message', () => {
  // Silence is the worst way to report a typo: the client gets nothing and
  // nobody finds out for a month.
  assert.throws(() => render('uk', 'no_such_message', {}), /unknown message key/);
});

test('the minimum-order clause disappears entirely when there is no minimum', () => {
  for (const lang of LANGS) {
    const without = render(lang, 'birthday_granted', { amountLabel: '10%', minOrderUsd: 0, code: 'C', until: '30.09.2026' });
    const with200 = render(lang, 'birthday_granted', { amountLabel: '10%', minOrderUsd: 200, code: 'C', until: '30.09.2026' });
    assert.doesNotMatch(without.body, /\$/, `${lang}: a dollar sign with no minimum to name`);
    assert.match(with200.body, /\$200/, `${lang}: the minimum never reached the sentence`);
  }
});

test('Russian and Ukrainian count in three forms, English in two', () => {
  const at = (lang, items) => render(lang, 'abandoned_cart', { items, percent: 10, code: 'C', minOrderUsd: 0, validDays: 7 }).body;
  assert.match(at('uk', 1), /1 позицію/);
  assert.match(at('uk', 3), /3 позиції/);
  assert.match(at('uk', 8), /8 позицій/);
  assert.match(at('ru', 1), /1 позицию/);
  assert.match(at('ru', 3), /3 позиции/);
  assert.match(at('ru', 8), /8 позиций/);
  assert.match(at('en', 1), /1 item\b/);
  assert.match(at('en', 8), /8 items\b/);
});

/* ── the seam: one message, two languages ────────────────────────────────── */

test('the row stays Ukrainian while the DM goes out in the language on file', async () => {
  clearOutbox();
  const c = await customer({ lang: 'ru' });
  await notifyCustomer({
    customerId: c.id,
    kind: 'birthday_available',
    message: { key: 'birthday_available', params: { amountLabel: '15%', minOrderUsd: 0, validDays: 7 } },
    dedupeKey: `t-row-dm:${c.id}`,
  });
  await settle();

  const row = await db.prepare('SELECT title, body FROM notifications WHERE customer_id=?').get(c.id);
  assert.equal(row.title, 'З днем народження! 🎂', 'the stored record is the Ukrainian one');
  assert.match(row.body, /чекає в застосунку/);

  const dm = outbox().find((m) => m.to === c.tg_user_id);
  assert.ok(dm, 'no DM was attempted');
  assert.match(dm.text, /С днём рождения/, 'the DM did not honour the stored language');
  assert.doesNotMatch(dm.text, /застосунку/, 'the DM still carries Ukrainian');
});

test('a client who never chose anything is written to in Ukrainian', async () => {
  clearOutbox();
  const c = await customer();            // lang IS NULL
  await notifyCustomer({
    customerId: c.id,
    kind: 'birthday_available',
    message: { key: 'birthday_available', params: { amountLabel: '15%', minOrderUsd: 0, validDays: 7 } },
    dedupeKey: `t-null-lang:${c.id}`,
  });
  await settle();
  const dm = outbox().find((m) => m.to === c.tg_user_id);
  assert.match(dm.text, /З днем народження/);
});

test('the language of the request outranks the one on file', async () => {
  clearOutbox();
  // She read the app in Russian last time and is reading it in English now.
  const c = await customer({ lang: 'ru' });
  await notifyCustomer({
    customerId: c.id,
    kind: 'inquiry_sent',
    message: { key: 'inquiry_sent', params: { who: 'Даша', items: 2 } },
    lang: 'en-US',
    dedupeKey: `t-req-lang:${c.id}`,
  });
  await settle();
  const dm = outbox().find((m) => m.to === c.tg_user_id);
  assert.match(dm.text, /will check availability/);
});

test('a message given as finished text is sent exactly as written', async () => {
  clearOutbox();
  const c = await customer({ lang: 'en' });
  await notifyCustomer({
    customerId: c.id,
    kind: 'near_reward',
    title: 'Лишилось трохи',
    body: 'До бонусу $30.',
    dedupeKey: `t-plain:${c.id}`,
  });
  await settle();
  const dm = outbox().find((m) => m.to === c.tg_user_id);
  // No catalogue entry, no translation, no guessing: the caller's words stand.
  assert.match(dm.text, /Лишилось трохи/);
});

/* ── learning the language from the request ──────────────────────────────── */

test('the header the app has always sent is recorded against the customer', async () => {
  const c = await customer();
  assert.equal(c.lang, null);

  await fetch(`${base}/api/me?tgid=${c.tg_user_id}`, { headers: { 'Accept-Language': 'ru-RU' } });
  let row = await db.prepare('SELECT lang FROM customers WHERE id=?').get(c.id);
  assert.equal(row.lang, 'ru', 'the choice was not recorded');

  // And it follows them when they change their mind.
  await fetch(`${base}/api/me?tgid=${c.tg_user_id}`, { headers: { 'Accept-Language': 'en-US' } });
  row = await db.prepare('SELECT lang FROM customers WHERE id=?').get(c.id);
  assert.equal(row.lang, 'en');
});

test('a language the shop does not speak leaves the last known one alone', async () => {
  const c = await customer({ lang: 'ru' });
  await fetch(`${base}/api/me?tgid=${c.tg_user_id}`, { headers: { 'Accept-Language': 'pl-PL' } });
  const row = await db.prepare('SELECT lang FROM customers WHERE id=?').get(c.id);
  assert.equal(row.lang, 'ru', 'an unsupported language overwrote a good answer');
});

test('registering carries the language in, so the first birthday is already right', async () => {
  seq += 1;
  const tgId = `lang-join-${seq}`;
  await fetch(`${base}/api/register?tgid=${tgId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Accept-Language': 'en-US' },
    body: JSON.stringify({ tgid: tgId, name: 'Нова клієнтка', consent: true }),
  });
  const row = await db.prepare('SELECT lang FROM customers WHERE tg_user_id=?').get(tgId);
  assert.equal(row.lang, 'en');
});
