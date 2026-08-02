import './helpers/tmpdb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { migrate, db } from '../server/db.js';
import {
  parseArticle, parsePrice, parsePostText, ingestChannelPost, resolveChannel, listChannels,
} from '../server/telegram.js';

migrate();

// ── parsing what a catalogue post actually looks like ─────────────────────

test('article numbers are picked out of the caption', () => {
  assert.equal(parseArticle('Chanel Classic Flap\nАртикул: A01112'), 'A01112');
  assert.equal(parseArticle('Арт. 55212-B'), '55212-B');
  assert.equal(parseArticle('Art: LV-2024'), 'LV-2024');
  assert.equal(parseArticle('Сумка #M45515 в наявності'), 'M45515');
  assert.equal(parseArticle('просто текст без артикула'), null);
});

test('prices are read in both currencies the club uses', () => {
  assert.deepEqual(parsePrice('Ціна 1200 грн'), { price: 1200, currency: 'UAH' });
  assert.deepEqual(parsePrice('$450'), { price: 450, currency: 'USD' });
  assert.deepEqual(parsePrice('2 900 USD'), { price: 2900, currency: 'USD' });
  assert.deepEqual(parsePrice('немає ціни'), { price: null, currency: null });
});

test('the title is derived from the brand, the whole post stays as the body', () => {
  const p = parsePostText('Dior Book Tote\nОригінальна якість, 3 кольори\nАртикул: D-4455\n$780');
  // Maryna writes prose, so the card title is built (brand · category), not
  // taken verbatim from the first line.
  assert.equal(p.title, 'Dior · сумка');
  assert.equal(p.brand, 'Dior');
  assert.equal(p.category, 'сумка');
  assert.match(p.body, /Оригінальна якість/);
  assert.equal(p.article, 'D-4455');
  assert.equal(p.price, 780);
  assert.equal(p.currency, 'USD');
});

test('a post with no brand keeps a short first phrase, never a paragraph', () => {
  const long = parsePostText('В наявності в США, розмір 38, відправка в будь-яку точку світу протягом тижня');
  assert.ok(long.title.length <= 47, `title too long: ${long.title}`);
  assert.match(long.title, /^В наявності в США/);
  assert.equal(long.brand, null);

  const short = parsePostText('Нова колекція вже тут');
  assert.equal(short.title, 'Нова колекція вже тут');
});

test('the brand is matched on word boundaries, not inside another word', () => {
  assert.equal(parsePostText('Сумка Chanel 22').brand, 'Chanel');
  assert.equal(parsePostText('Chanelesque стиль').brand, null);
});

test('an empty post still produces a usable card', () => {
  const p = parsePostText('');
  assert.equal(p.title, 'Нова позиція');
  assert.equal(p.price, null);
});

// ── channel → app ─────────────────────────────────────────────────────────

const post = (over = {}) => ({
  channel_post: {
    message_id: over.message_id ?? 1,
    date: Math.floor(Date.UTC(2026, 6, 30) / 1000),
    chat: over.chat ?? { id: -1001234567890, username: 'w2b_test_catalog', title: 'Way2Buy Test' },
    ...over,
  },
});

test('a brand-new channel registers itself on its first post', () => {
  const before = listChannels({ includeDisabled: true }).length;
  const id = ingestChannelPost(post({ text: 'Prada Re-Edition\nАрт. PR-771\n$620' }));
  assert.ok(id, 'post stored');

  const after = listChannels({ includeDisabled: true });
  assert.equal(after.length, before + 1, 'the channel appeared without any config');
  const ch = after.find((c) => c.username === 'w2b_test_catalog');
  assert.equal(ch.kind, 'catalog');
  assert.equal(ch.chatId, '-1001234567890');

  const row = db.prepare('SELECT * FROM posts WHERE id=?').get(id);
  assert.equal(row.article, 'PR-771');
  assert.equal(row.price, 620);
  assert.equal(row.source, 'channel');
});

test('the same message twice does not create two cards', () => {
  const first = ingestChannelPost(post({ message_id: 42, text: 'Gucci Marmont' }));
  const second = ingestChannelPost(post({ message_id: 42, text: 'Gucci Marmont' }));
  assert.equal(first, second);
});

test('editing the post in the channel updates the card in the app', () => {
  const id = ingestChannelPost(post({ message_id: 77, text: 'Chloe Woody\n$400' }));
  ingestChannelPost({
    edited_channel_post: {
      message_id: 77,
      date: Math.floor(Date.UTC(2026, 6, 30) / 1000),
      chat: { id: -1001234567890, username: 'w2b_test_catalog', title: 'Way2Buy Test' },
      text: 'Chloe Woody — РОЗПРОДАЖ\n$350',
    },
  });
  const row = db.prepare('SELECT * FROM posts WHERE id=?').get(id);
  // The edit is reflected in the body (the raw text); the title is derived, so
  // it stays the brand-based one.
  assert.match(row.body, /РОЗПРОДАЖ/);
  assert.equal(row.price, 350);
  assert.ok(row.edited_at);
});

test('an album arrives as several updates but becomes one card', () => {
  const base = {
    date: Math.floor(Date.UTC(2026, 6, 30) / 1000),
    chat: { id: -1001234567890, username: 'w2b_test_catalog', title: 'Way2Buy Test' },
    media_group_id: '99001',
  };
  const a = ingestChannelPost({ channel_post: { ...base, message_id: 501, caption: 'Hermes Birkin\n$9000', photo: [{ file_id: 'ph-1', file_size: 100 }] } });
  const b = ingestChannelPost({ channel_post: { ...base, message_id: 502, photo: [{ file_id: 'ph-2', file_size: 200 }] } });
  const c = ingestChannelPost({ channel_post: { ...base, message_id: 503, photo: [{ file_id: 'ph-3', file_size: 300 }] } });

  assert.equal(a, b);
  assert.equal(b, c);
  const row = db.prepare('SELECT * FROM posts WHERE id=?').get(a);
  assert.deepEqual(JSON.parse(row.photos_json), ['ph-1', 'ph-2', 'ph-3']);
  assert.equal(row.title, 'Hermes');
});

test('the largest photo size is the one stored', () => {
  const id = ingestChannelPost(post({
    message_id: 900,
    caption: 'Balenciaga Hourglass',
    photo: [
      { file_id: 'small', file_size: 1000 },
      { file_id: 'large', file_size: 90000 },
      { file_id: 'medium', file_size: 20000 },
    ],
  }));
  assert.deepEqual(JSON.parse(db.prepare('SELECT * FROM posts WHERE id=?').get(id).photos_json), ['large']);
});

test('posts from a disabled channel are dropped', () => {
  const ch = resolveChannel({ id: -100999, username: 'w2b_off', title: 'Вимкнений' });
  db.prepare('UPDATE channels SET enabled=0 WHERE key=?').run(ch.key);
  const id = ingestChannelPost(post({ message_id: 1, chat: { id: -100999, username: 'w2b_off', title: 'Вимкнений' }, text: 'ігнор' }));
  assert.equal(id, null);
});

test('a channel first known by @username gets its numeric id bound on first post', () => {
  db.prepare("INSERT INTO channels (key,username,title,kind,enabled,created_at) VALUES ('preconf','w2b_preconf','Заздалегідь','catalog',1,?)")
    .run(new Date().toISOString());
  ingestChannelPost(post({ message_id: 1, chat: { id: -100555, username: 'w2b_preconf', title: 'Заздалегідь' }, text: 'перший пост' }));
  assert.equal(db.prepare("SELECT chat_id FROM channels WHERE key='preconf'").get().chat_id, '-100555');
});

test('a non-post update is ignored rather than crashing the webhook', () => {
  assert.equal(ingestChannelPost({ message: { text: 'привіт' } }), null);
  assert.equal(ingestChannelPost({}), null);
  assert.equal(ingestChannelPost(null), null);
});
