// The importer that fills the catalogues from the channels' own public pages.
// Every case here is a shape a real Way2Buy channel actually serves — the
// fixtures below are trimmed from t.me/s/w2b_luxury_bags and
// t.me/s/w2b_luxury_available, not invented.
import './helpers/tmpdb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseChannelPage, htmlToText, decodeEntities, normalizeUsername, keyFor,
  fetchChannelPage, TmeError,
} from '../server/tme.js';

// An album: eight photos under one caption, which Telegram wraps in a grouped
// block and publishes under the FIRST message id of the group.
const ALBUM = `
<div class="tgme_channel_info_header_title"><span dir="auto">W2B Luxury Bags</span></div>
<section class="tgme_channel_history js-message_history">
<div class="tgme_widget_message_centered js-messages_more_wrap">
  <a href="/s/w2b_luxury_bags?before=70119" class="tme_messages_more js-messages_more" data-before="70119"></a>
</div>
<div class="tgme_widget_message_wrap js-widget_message_wrap">
  <div class="tgme_widget_message" data-post="w2b_luxury_bags/70119">
    <div class="tgme_widget_message_grouped_wrap">
      <a class="tgme_widget_message_photo_wrap grouped_media_wrap" style="background-image:url('https://cdn4.telesco.pe/file/one.jpg')"></a>
      <a class="tgme_widget_message_photo_wrap grouped_media_wrap" style="background-image:url('https://cdn4.telesco.pe/file/two.jpg')"></a>
    </div>
    <div class="tgme_widget_message_text js-message_text" dir="auto"><div class="tgme_widget_message_text js-message_text" dir="auto">Balenciaga <br/>Size 36-18-14,5cm<br/>Ціна $1&nbsp;450</div></div>
    <div class="tgme_widget_message_footer">
      <span class="tgme_widget_message_meta"><a class="tgme_widget_message_date"><time datetime="2026-08-03T20:15:31+00:00">20:15</time></a></span>
    </div>
  </div>
</div>
</section>`;

test('an album is one card, keyed on the first message id of the group', () => {
  const { title, posts, before } = parseChannelPage(ALBUM);
  assert.equal(title, 'W2B Luxury Bags');
  assert.equal(before, 70119, 'the cursor for the previous page');
  assert.equal(posts.length, 1, 'eight photos are one position, not eight');

  const [post] = posts;
  assert.equal(post.messageId, 70119);
  assert.equal(post.date, '2026-08-03T20:15:31+00:00');
  assert.deepEqual(post.photos, [
    'https://cdn4.telesco.pe/file/one.jpg',
    'https://cdn4.telesco.pe/file/two.jpg',
  ]);
  // Telegram nests two identical text divs around an album caption; reading
  // "until the first </div>" would cut the caption in half.
  assert.equal(post.text, 'Balenciaga\nSize 36-18-14,5cm\nЦіна $1 450');
});

test('the caption keeps line breaks, entities and emoji, and drops the markup', () => {
  assert.equal(htmlToText('Chanel<br/>19 Flap &amp; Bag'), 'Chanel\n19 Flap & Bag');
  assert.equal(htmlToText('<i class="emoji"><b>👜</b></i> Kelly'), '👜 Kelly');
  assert.equal(htmlToText('<a href="https://t.me/x">Написати</a> нам'), 'Написати нам');
  assert.equal(decodeEntities('&#1050;&#039;&quot;&hellip;'), 'К\'"…');
});

test('a post with neither text nor a photo is not a position', () => {
  const { posts } = parseChannelPage(`
    <section class="tgme_channel_history">
    <div class="tgme_widget_message_wrap js-widget_message_wrap">
      <div class="tgme_widget_message" data-post="w2b_luxury_bags/70140">
        <div class="tgme_widget_message_sticker_wrap"></div>
        <time datetime="2026-08-03T20:20:00+00:00">20:20</time>
      </div>
    </div></section>`);
  assert.deepEqual(posts, []);
});

test('a video post falls back to its thumbnail, a link preview only if nothing else', () => {
  const { posts } = parseChannelPage(`
    <section class="tgme_channel_history">
    <div class="tgme_widget_message_wrap js-widget_message_wrap">
      <div class="tgme_widget_message" data-post="c/1">
        <i class="tgme_widget_message_video_thumb" style="background-image:url('https://cdn4.telesco.pe/file/v.jpg')"></i>
        <div class="tgme_widget_message_text js-message_text">Hermès Birkin</div>
        <time datetime="2026-08-01T10:00:00+00:00">10:00</time>
      </div>
    </div>
    <div class="tgme_widget_message_wrap js-widget_message_wrap">
      <div class="tgme_widget_message" data-post="c/2">
        <a class="tgme_widget_message_link_preview_image" style="background-image:url('https://cdn4.telesco.pe/file/p.jpg')"></a>
        <div class="tgme_widget_message_text js-message_text">Дивіться сайт</div>
        <time datetime="2026-08-01T11:00:00+00:00">11:00</time>
      </div>
    </div></section>`);
  assert.equal(posts.length, 2);
  assert.equal(posts[0].kind, 'video');
  assert.deepEqual(posts[0].photos, ['https://cdn4.telesco.pe/file/v.jpg']);
  assert.equal(posts[1].kind, 'link');
});

test('the last page of a channel reports no cursor, so a backfill can stop', () => {
  const { before } = parseChannelPage(`
    <section class="tgme_channel_history">
    <div class="tgme_widget_message_wrap js-widget_message_wrap">
      <div class="tgme_widget_message" data-post="c/3"><div class="tgme_widget_message_text js-message_text">Chanel</div>
      <time datetime="2026-05-12T09:00:00+00:00">09:00</time></div>
    </div></section>`);
  assert.equal(before, null);
});

test('a channel is named the same way however it was written down', () => {
  assert.equal(normalizeUsername('@w2b_hermes'), 'w2b_hermes');
  assert.equal(normalizeUsername('https://t.me/w2b_luxury_bags'), 'w2b_luxury_bags');
  assert.equal(normalizeUsername('t.me/s/w2b_luxury_shoes/'), 'w2b_luxury_shoes');
  assert.throws(() => normalizeUsername('---'), TmeError);
  // The key must match what telegram.js resolveChannel() derives from a live
  // post, or the same channel would end up stored twice.
  assert.equal(keyFor('w2b_luxury_available'), 'w2b-luxury-available');
});

test('a private channel is reported as such rather than read as empty', async () => {
  const join = async () => ({ ok: true, status: 200, text: async () => '<div class="tgme_page_context">join</div>' });
  await assert.rejects(
    () => fetchChannelPage('w2b_private', { fetchImpl: join, attempts: 1 }),
    /перевірте @username/,
  );
});

test('a rate limit is retried, not surfaced as an empty channel', async () => {
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    if (calls === 1) return { ok: false, status: 429, headers: { get: () => '0' }, text: async () => '' };
    return { ok: true, status: 200, text: async () => ALBUM };
  };
  const page = await fetchChannelPage('w2b_luxury_bags', { fetchImpl: flaky, attempts: 3 });
  assert.equal(calls, 2);
  assert.equal(page.posts.length, 1);
});
