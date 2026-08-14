// ─────────────────────────────────────────────────────────────────────────
//  tme.js — reads a PUBLIC channel through its web preview (t.me/s/<name>).
//
//  Why this exists. The Bot API cannot read a channel's history at all: a bot
//  only receives `channel_post` updates for messages published after it became
//  an administrator. So the live bridge in telegram.js keeps the app in step
//  going forward and can never fill it in backwards — a catalogue with 8 000
//  existing cards shows up empty.
//
//  Every Way2Buy catalogue is a PUBLIC channel, and Telegram publishes public
//  channels as ordinary web pages. That page carries exactly what a catalogue
//  card needs: the message id, its date, the caption and the photos. No token,
//  no membership, no MTProto client — a GET is enough.
//
//  Two rules keep this path and the live bridge from fighting each other:
//    • an album is ONE card, keyed on the first message id of the group — the
//      same key `ingestChannelPost` uses, so re-importing a post the bot
//      already delivered updates that row instead of duplicating it;
//    • posts are identified by (channel, tg_message_id), which is a unique
//      index, so the importer is idempotent by construction.
//
//  Photos are stored as the absolute cdn.telesco.pe URLs the page hands out.
//  They are long-lived but not eternal — the tokens are Telegram's to rotate.
//  A post whose photo has expired shows the emoji placeholder; the durable fix
//  is copying the bytes into object storage, which is a bigger decision than
//  this importer should make on its own.
// ─────────────────────────────────────────────────────────────────────────

const PREVIEW = 'https://t.me/s';

// Telegram serves the preview only to something that looks like a browser.
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// ── HTML → text ───────────────────────────────────────────────────────────

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»',
  hellip: '…', mdash: '—', ndash: '–', copy: '©', reg: '®', trade: '™', deg: '°',
};

export function decodeEntities(s = '') {
  return String(s).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : all;
    }
    const named = NAMED[body.toLowerCase()];
    return named === undefined ? all : named;
  });
}

// The caption as the client wrote it: line breaks are <br>, emoji are an <i>
// wrapper around the character itself, and links keep their visible text.
export function htmlToText(fragment = '') {
  return decodeEntities(
    String(fragment)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>|<\/div>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Returns the inner HTML of the element that starts at `openIdx`, counting
// nested <div> so a caption that contains one is not cut in half. Telegram
// actually nests two identical text divs around an album caption, which is the
// case a "read until the first </div>" shortcut gets wrong.
function innerHtml(html, openIdx) {
  const start = html.indexOf('>', openIdx);
  if (start === -1) return '';
  let depth = 1;
  let i = start + 1;
  const re = /<(\/?)div\b/gi;
  re.lastIndex = i;
  let m;
  while ((m = re.exec(html))) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(start + 1, m.index);
  }
  return html.slice(start + 1);
}

// ── page → posts ──────────────────────────────────────────────────────────

const BG_URL = /background-image:\s*url\(['"]?([^'")]+)['"]?\)/gi;

function backgrounds(block, className) {
  const out = [];
  const re = new RegExp(`class="[^"]*${className}[^"]*"[^>]*`, 'gi');
  let m;
  while ((m = re.exec(block))) {
    BG_URL.lastIndex = 0;
    const url = BG_URL.exec(m[0]);
    if (url) out.push(decodeEntities(url[1]));
  }
  return out;
}

/**
 * Parses one preview page.
 * @returns {{title: string|null, posts: Array, before: number|null}}
 *   `before` is the cursor for the previous (older) page, or null on the very
 *   first page of the channel.
 */
export function parseChannelPage(html = '') {
  const titleMatch = html.match(/class="tgme_channel_info_header_title"[^>]*>\s*<span[^>]*>([^<]*)</i)
    || html.match(/<meta property="og:title" content="([^"]*)"/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]).trim() : null;

  const moreMatch = html.match(/js-messages_more[^>]*data-before="(\d+)"/i)
    || html.match(/data-before="(\d+)"[^>]*js-messages_more/i);
  const before = moreMatch ? Number(moreMatch[1]) : null;

  const posts = [];
  // Each message is one `tgme_widget_message_wrap`; splitting on it keeps the
  // blocks in page order (oldest → newest).
  const blocks = html.split(/class="tgme_widget_message_wrap[^"]*"/).slice(1);

  for (const block of blocks) {
    const idMatch = block.match(/data-post="[^/"]+\/(\d+)"/);
    if (!idMatch) continue;
    const messageId = Number(idMatch[1]);

    const dateMatch = block.match(/<time[^>]*datetime="([^"]+)"/);
    const date = dateMatch ? dateMatch[1] : null;

    const textIdx = block.search(/<div class="tgme_widget_message_text[^"]*"/);
    const text = textIdx === -1 ? '' : htmlToText(innerHtml(block, textIdx));

    // A grouped album carries several photo wraps; a single photo carries one.
    let photos = backgrounds(block, 'tgme_widget_message_photo_wrap');
    let kind = photos.length ? 'photo' : 'text';

    if (!photos.length) {
      const video = backgrounds(block, 'tgme_widget_message_video_thumb');
      if (video.length) { photos = video; kind = 'video'; }
    }
    if (!photos.length) {
      // A link preview image is the poster of someone else's page, not a
      // product shot — worth showing only when the post has nothing else.
      const preview = backgrounds(block, 'tgme_widget_message_link_preview_image');
      if (preview.length) { photos = preview; kind = 'link'; }
    }

    // Service messages, stickers, polls and voice notes all land here: nothing
    // to show and nothing to sell.
    if (!text && !photos.length) continue;

    const forwarded = /tgme_widget_message_forwarded_from/i.test(block);

    posts.push({
      messageId,
      date,
      text,
      photos: [...new Set(photos)].slice(0, 10),
      kind,
      forwarded,
      albumSize: (block.match(/grouped_media_wrap/gi) || []).length || (photos.length ? 1 : 0),
    });
  }

  return { title, posts, before };
}

// ── fetching ──────────────────────────────────────────────────────────────

export class TmeError extends Error {}

/**
 * Fetches one page of a channel. `before` walks backwards through history.
 * Retries on 429/5xx, because a full backfill is thousands of requests and a
 * single blip must not abort it.
 */
export async function fetchChannelPage(username, { before = null, attempts = 3, fetchImpl = fetch } = {}) {
  const url = `${PREVIEW}/${encodeURIComponent(username)}${before ? `?before=${before}` : ''}`;

  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let res;
    try {
      res = await fetchImpl(url, { headers: { 'user-agent': UA, 'accept-language': 'uk,ru;q=0.8,en;q=0.5' } });
    } catch (e) {
      lastError = e;
      await sleep(attempt * 1500);
      continue;
    }

    if (res.status === 404) throw new TmeError(`@${username}: немає такого каналу або він приватний`);
    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get('retry-after')) || attempt * 3;
      lastError = new TmeError(`@${username}: HTTP ${res.status}`);
      await sleep(retryAfter * 1000);
      continue;
    }
    if (!res.ok) throw new TmeError(`@${username}: HTTP ${res.status}`);

    const html = await res.text();
    // Telegram answers 200 for a channel that does not exist, for a private one,
    // and for one with preview switched off — the same "no history" page for all
    // three. So an empty result here means "not readable", never "no posts", and
    // the message has to name the likeliest cause first: a mistyped handle.
    if (!/tgme_channel_history/i.test(html)) {
      throw new TmeError(
        `@${username}: не вдалося прочитати канал — перевірте @username, ` +
        'або канал приватний чи має вимкнений веб-перегляд'
      );
    }
    return { url, ...parseChannelPage(html) };
  }

  throw lastError || new TmeError(`@${username}: не вдалося завантажити`);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** `@Name`, `https://t.me/Name`, `t.me/s/Name` → `Name`. */
export function normalizeUsername(input) {
  const s = String(input || '').trim();
  const m = s.match(/(?:t\.me\/(?:s\/)?|@)?([A-Za-z0-9_]{4,32})\/?$/);
  if (!m) throw new TmeError(`не розпізнав канал: "${input}"`);
  return m[1];
}

/** The channel key used in `posts.channel`, matching telegram.js resolveChannel. */
export const keyFor = (username) =>
  String(username).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
