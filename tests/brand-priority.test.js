// Where a card's brand comes from, and in which order.
//
//   1. the caption           — the seller's own word, right or wrong
//   2. the catalogue's name  — «Hermès» answers a caption that is only a size
//   3. the photograph        — vision.js, over what the first two left silent
//
// The rule that matters most is the one about a WRONG caption: post 71627 in
// @w2b_luxury_bags is a Miu Miu bag captioned «Gucci», and the app must keep
// saying Gucci. Correcting the channel is the seller's business — the app only
// fills silence, and every test here is about the boundary of that silence.
import './helpers/tmpdb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { migrate, db } from '../server/db.js';
import { parsePostText } from '../server/telegram.js';
import { normalise, backfillBrands, configured } from '../server/vision.js';

await migrate();

// ── 1 & 2: the two rungs parsePostText holds ─────────────────────────────

test('the caption wins, and it wins even when it is wrong', () => {
  const real = parsePostText('Gucci\nSize 21x13x7,5cm', { channelTitle: 'Сумки жіночі' });
  assert.equal(real.brand, 'Gucci');
  assert.equal(real.brandSource, 'text');

  // The Miu Miu photograph. Nothing in this pipeline looks at photographs when
  // the caption has spoken, so «Gucci» is the answer and stays the answer.
  const wrong = parsePostText('Gucci\nSize 21x13x7,5cm', { channelTitle: 'Miu Miu' });
  assert.equal(wrong.brand, 'Gucci', 'the channel does not get to overrule the caption');
});

test('a silent caption is answered by the catalogue it was posted in', () => {
  const p = parsePostText('Size 20,5x14x5cm', { channelTitle: 'Hermès' });
  assert.equal(p.brand, 'Hermès');
  assert.equal(p.brandSource, 'channel');
  // …and the canonical spelling, not whatever the title happened to use.
  assert.equal(parsePostText('Розмір 38', { channelTitle: 'Hermes' }).brand, 'Hermès');
});

test('a catalogue named after a category answers nothing — that is the queue', () => {
  for (const title of ['Сумки жіночі', 'Взуття жіноче', 'Товари в наявності', '']) {
    const p = parsePostText('Size 28x16x4cm', { channelTitle: title });
    assert.equal(p.brand, null, title);
    assert.equal(p.brandSource, null, 'null source is what the backfill selects on');
  }
});

test('the ladder never skips a rung', () => {
  const cases = [
    ['Prada окуляри', 'Chanel', 'Prada', 'text'],
    ['окуляри', 'Chanel', 'Chanel', 'channel'],
    ['окуляри', 'Аксесуари', null, null],
  ];
  for (const [text, channelTitle, brand, source] of cases) {
    const p = parsePostText(text, { channelTitle });
    assert.equal(p.brand, brand, `${text} @ ${channelTitle}`);
    assert.equal(p.brandSource, source, `${text} @ ${channelTitle}`);
  }
});

// ── 3: the photograph ────────────────────────────────────────────────────

test('only a name the vitrine already uses survives the model', () => {
  assert.equal(normalise('Chanel'), 'Chanel');
  assert.equal(normalise('  hermès \n'), 'Hermès', 'case and whitespace are the model\'s, not ours');
  assert.equal(normalise('"Miu Miu"'), 'Miu Miu');
  assert.equal(normalise('UNKNOWN'), null);
  assert.equal(normalise(''), null);
  // The answers that would quietly corrupt the filter row: a second spelling,
  // a house nobody sells, or an explanation instead of a name.
  assert.equal(normalise('Miu Miu (Prada Group)'), null);
  assert.equal(normalise('Hermes Birkin 25'), null);
  assert.equal(normalise('Uniqlo'), null, 'a house this shop does not sell is not a valid answer');
  assert.equal(normalise('I think it is probably Gucci'), null);
});

test('with no API key the backfill is a no-op that still reports the queue', async () => {
  const before = { or: process.env.OPENROUTER_API_KEY, oc: process.env.OPENCODE_API_KEY };
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENCODE_API_KEY;
  try {
    assert.equal(configured(), false);
    await db.exec(`INSERT INTO posts (channel,tg_message_id,title,body,brand,brand_source,photos_json,source,status,created_at)
      VALUES ('bags', 900001, 'Сумка', 'Size 20x10', NULL, NULL, '["file-1"]'::jsonb, 'channel', 'published', now())
      ON CONFLICT DO NOTHING;`);
    const r = await backfillBrands();
    assert.equal(r.skipped, 'no vision key');
    assert.ok(r.pending >= 1, 'the queue is still counted, so the cabinet can show it');
    // And nothing was written: the card is exactly as it was.
    const row = await db.prepare('SELECT brand, brand_source FROM posts WHERE tg_message_id=900001').get();
    assert.equal(row.brand, null);
    assert.equal(row.brand_source, null);
  } finally {
    if (before.or) process.env.OPENROUTER_API_KEY = before.or;
    if (before.oc) process.env.OPENCODE_API_KEY = before.oc;
  }
});

// ── the caption, read as written ─────────────────────────────────────────
//
// These are verbatim captions from the live catalogues. Every one of them names
// its house plainly to a human eye and named nothing at all to the matcher —
// 1522 cards' worth. Two habits cause it, and neither is carelessness: Telegram
// styling (the Mathematical Alphanumeric block) and Cyrillic letters standing in
// for identical-looking Latin ones, which is how a caption avoids spelling a
// trademark literally.
test('a caption in styled unicode still names its house', () => {
  const cases = [
    ['Шорти\n𝗟𝗢𝗨𝗜𝗦 𝗩𝗨𝗜𝗧𝗧𝗢N', 'Louis Vuitton'],
    ['Браслет\n𝐂𝐚𝐫𝐭𝐢𝐞𝐫', 'Cartier'],
    ['Сукня\n𝒁𝑰𝑴𝑴𝑬𝑹𝑴𝑨𝑵𝑵', 'Zimmermann'],
    ['Кольє\n𝘉𝘝𝘓𝘎𝘈𝘙𝘐', 'Bvlgari'],
    ['Блуза\n𝗦𝗔𝗜𝗡𝗧 𝗟𝗔𝗨𝗥𝗘𝗡T', 'Saint Laurent'],
  ];
  for (const [caption, expected] of cases) {
    assert.equal(parsePostText(caption, { channelTitle: 'Одяг жіночий' }).brand, expected, caption);
  }
});

test('a Cyrillic letter standing in for a Latin one does not hide the house', () => {
  const cases = [
    ['Сандалі\nНermes', 'Hermès'],        // Cyrillic Н
    ['Куртка\nChanеl', 'Chanel'],          // Cyrillic е
    ['Кросівки\nValentinо', 'Valentino'],  // Cyrillic о
    ['Босоніжки\nJimmy Choо', 'Jimmy Choo'],
    ['Туфлі\nBERLUTІ', 'Berluti'],         // Cyrillic І
    ['Кепка\nBrunello cucinellі', 'Brunello Cucinelli'],
  ];
  for (const [caption, expected] of cases) {
    assert.equal(parsePostText(caption, { channelTitle: 'Взуття жіноче' }).brand, expected, caption);
  }
});

test('the vocabulary covers what this shop actually sells', () => {
  const cases = [
    ['The Row', 'The Row'], ['Лофери\nZegna', 'Zegna'], ['Кросівки\nKiton', 'Kiton'],
    ['Patek Philipе', 'Patek Philippe'], ['Мюлі\n Alaïa', 'Alaïa'],
    ['Лофери\nTOD\'S', 'Tod\'s'], ['Бейсболкa\nALO', 'Alo'],
    ['Теніска\nLoro Piano', 'Loro Piana'], ['Кросівки\nMiumiu', 'Miu Miu'],
    ['Кросівки\nDolce Gabbana', 'Dolce & Gabbana'],
    ['Бейсболки\nPolo Ralph Lauren', 'Ralph Lauren'],
  ];
  for (const [caption, expected] of cases) {
    assert.equal(parsePostText(caption, { channelTitle: 'Аксесуари' }).brand, expected, caption);
  }
});

test('folding does not invent a brand out of ordinary Ukrainian', () => {
  // The homoglyph map rewrites Cyrillic wholesale, so the guard that matters is
  // that a caption with no house in it still yields none.
  for (const caption of ['Сукня, розмір 38', 'Кросівки\nSize 35-45', 'Нова колекція вже тут',
    'Сумка шкіряна, чорна', 'Прикраса срібна']) {
    assert.equal(parsePostText(caption, { channelTitle: 'Одяг жіночий' }).brand, null, caption);
  }
});
