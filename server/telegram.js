// ─────────────────────────────────────────────────────────────────────────
//  telegram.js — the bridge between the channels and the Mini App.
//
//  Maryna, 31.07.2026: "Если админ выкладывает что-то внутри канала то оно
//  всё должно автоматом дублироваться в mini app Telegram и наоборот."
//
//   • CHANNEL → APP: the bot (an admin of the channel) receives `channel_post`
//     updates and we upsert them into `posts`. Photos, albums, article numbers
//     and later edits are all carried over, because a catalogue post is mostly
//     a photo plus an article number.
//   • APP → CHANNEL: publishing from the admin panel sends the post to the
//     channel and stores the same row, so both surfaces show one feed.
//
//  Channels are DATA, not constants: one main channel plus ~15 catalogues, and
//  a brand-new channel registers itself the first time it posts — so Maryna
//  can create the test channel, add the bot, and it just starts working.
//
//  DEMO MODE: with no TELEGRAM_BOT_TOKEN, publishing is simulated locally so
//  the whole flow is demonstrable without a real bot.
//
//  KNOWN LIMIT: the Bot API cannot read a channel's history and does not
//  report deletions. Only posts made after the bot became an admin arrive, and
//  a post deleted in the channel stays in the app until an admin hides it.
// ─────────────────────────────────────────────────────────────────────────
import { db } from './db.js';
import { asJson } from './sql.js';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const API = (m) => `https://api.telegram.org/bot${TOKEN}/${m}`;

export const liveMode = () => Boolean(TOKEN);

// ── channels ──────────────────────────────────────────────────────────────

export async function listChannels({ includeDisabled = false } = {}) {
  const rows = includeDisabled
    ? await db.prepare('SELECT * FROM channels ORDER BY kind DESC, id').all()
    : await db.prepare('SELECT * FROM channels WHERE enabled ORDER BY kind DESC, id').all();
  return rows.map(shapeChannel);
}

export function shapeChannel(c) {
  if (!c) return null;
  return {
    key: c.key, title: c.title, username: c.username, emoji: c.emoji,
    kind: c.kind, enabled: Boolean(c.enabled), chatId: c.chat_id,
    // Sync state — what the admin office needs to say "оновлено 5 хв тому" and
    // whether «вся історія» still has anything left to walk.
    syncedAt: c.synced_at || null,
    syncCursor: c.sync_cursor == null ? null : Number(c.sync_cursor),
    historyDone: Boolean(c.history_done),
  };
}

export async function getChannel(key) {
  return shapeChannel(await db.prepare('SELECT * FROM channels WHERE key=?').get(key));
}

// Back-compat for callers that still expect the old CHANNELS map.
export async function channelMap() {
  const out = {};
  for (const c of await listChannels({ includeDisabled: true })) out[c.key] = c;
  return out;
}

const slugify = (s, fallback) =>
  String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || fallback;

// Find the channel a Telegram post came from; register it if it is new.
// This is what lets Maryna spin up a test channel without touching config.
export async function resolveChannel(chat) {
  if (!chat) return null;
  const chatId = chat.id != null ? String(chat.id) : null;
  const uname = chat.username ? chat.username.toLowerCase() : null;

  if (chatId) {
    const byId = await db.prepare('SELECT * FROM channels WHERE chat_id=?').get(chatId);
    if (byId) return shapeChannel(byId);
  }
  if (uname) {
    const byName = await db.prepare('SELECT * FROM channels WHERE lower(username)=?').get(uname);
    if (byName) {
      // First post from a channel we only knew by @username — bind the numeric
      // id so private channels and username changes keep working.
      if (chatId && !byName.chat_id) {
        await db.prepare('UPDATE channels SET chat_id=? WHERE id=?').run(chatId, byName.id);
        byName.chat_id = chatId;
      }
      return shapeChannel(byName);
    }
  }

  const key = slugify(chat.username || chat.title, `ch${chatId || Date.now()}`);
  const unique = await db.prepare('SELECT 1 FROM channels WHERE key=?').get(key) ? `${key}-${Math.random().toString(36).slice(2, 5)}` : key;
  await db.prepare(`INSERT INTO channels (key,chat_id,username,title,emoji,kind,enabled,created_at)
    VALUES (?,?,?,?,?, 'catalog',true,?)`)
    .run(unique, chatId, chat.username || null, chat.title || unique, '🛍️', new Date().toISOString());
  return await getChannel(unique);
}

// ── Telegram API ──────────────────────────────────────────────────────────

async function tg(method, params) {
  const res = await fetch(API(method), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram ${method}: ${json.description}`);
  return json.result;
}

// The bot token must never reach the browser, so photos are proxied: the app
// stores file_ids and serves the bytes through /api/photo/:fileId.
export async function fetchPhoto(fileId) {
  if (!liveMode()) return null;
  const file = await tg('getFile', { file_id: fileId });
  const res = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`);
  if (!res.ok) throw new Error(`file download ${res.status}`);
  // Telegram answers with application/octet-stream, which some browsers refuse
  // to render in an <img>; the real type is in the file path.
  const ext = (file.file_path.match(/\.(\w+)$/) || [])[1]?.toLowerCase();
  const byExt = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }[ext];
  const served = res.headers.get('content-type');
  return {
    buffer: Buffer.from(await res.arrayBuffer()),
    contentType: byExt || (served && served !== 'application/octet-stream' ? served : 'image/jpeg'),
  };
}

// ── a person's own profile photo ───────────────────────────────────────────
//
// The face on the confirmation card. Resolved rather than stored: Telegram
// hands back a file_id for the current avatar, so when Dasha changes her
// photograph the app follows without anybody editing a setting.
//
// It only works for somebody the bot can SEE — a user who has started it, or
// who shares a chat where the bot may look. For anyone else Telegram answers
// «user not found», and that is not an error to shout about: the caller falls
// back to initials. Both answers are cached, the negative one briefly, so a
// support person who presses Start today appears within the hour instead of at
// the next deploy.
const profilePhotoCache = new Map(); // userId → { fileId, at, ttl }
const PROFILE_OK_TTL = 6 * 3600_000;
const PROFILE_MISS_TTL = 30 * 60_000;

export async function userProfilePhotoId(userId) {
  const id = String(userId || '').trim();
  if (!id || !liveMode()) return null;

  const hit = profilePhotoCache.get(id);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.fileId;

  let fileId = null;
  try {
    const r = await tg('getUserProfilePhotos', { user_id: id, limit: 1 });
    const sizes = r?.photos?.[0];
    // The last entry is the largest Telegram offers; the avatar is rendered at
    // 76px but a retina screen asks for more than 76 real pixels.
    if (Array.isArray(sizes) && sizes.length) fileId = sizes[sizes.length - 1].file_id;
  } catch {
    fileId = null;
  }
  profilePhotoCache.set(id, { fileId, at: Date.now(), ttl: fileId ? PROFILE_OK_TTL : PROFILE_MISS_TTL });
  return fileId;
}

// ── parsing a catalogue post ──────────────────────────────────────────────

// Article numbers as they are actually written in the catalogues.
const ARTICLE_PATTERNS = [
  /(?:артикул|арт\.?|art\.?|code|код)\s*[:#№]?\s*([A-Za-z0-9][A-Za-z0-9\-_/]{2,24})/i,
  /#([A-Za-z0-9][A-Za-z0-9\-_]{2,24})\b/,
];

export function parseArticle(text = '') {
  for (const re of ARTICLE_PATTERNS) {
    const m = text.match(re);
    if (m) return m[1].toUpperCase();
  }
  return null;
}

const PRICE_RE = /(?:^|\s)(?:\$\s*(\d[\d\s.,]*)|(\d[\d\s.,]*)\s*(грн|uah|usd|\$|€|eur))/i;

export function parsePrice(text = '') {
  const m = text.match(PRICE_RE);
  if (!m) return { price: null, currency: null };
  const raw = m[1] || m[2];
  const num = Number(String(raw).replace(/[\s,]/g, ''));
  if (!Number.isFinite(num)) return { price: null, currency: null };
  const unit = (m[3] || '$').toLowerCase();
  const currency = unit === 'грн' || unit === 'uah' ? 'UAH' : unit === '€' || unit === 'eur' ? 'EUR' : 'USD';
  return { price: num, currency };
}

// Maryna's posts are prose, not product records: "В наявності в США, розмір 38,
// відправка в будь-яку точку…". Using the first line as a title fills the
// vitrine with paragraphs. So the title is derived — brand first (that is what
// the client scans for), then category, and only then a trimmed first phrase.
// One entry per house: [the name a card shows, ...the ways it gets written].
// The catalogues are not consistent — "Hermes" and "Hermès" in neighbouring
// posts, "YSL" one day and "Saint Laurent" the next — and detectBrand returns
// the FIRST element whichever spelling matched. Without that the brand filter
// offers two chips for one house and splits its own counts between them.
//
// Within an entry the longer spelling comes first, so "Bottega Veneta" is not
// matched as "Bottega".
export const BRANDS = [
  ['Chanel'],
  ['Dior', 'Christian Dior'],
  ['Hermès', 'Hermes'],
  ['Louis Vuitton', 'LV'],
  ['Gucci'],
  ['Prada'],
  ['Saint Laurent', 'Yves Saint Laurent', 'YSL'],
  ['Bottega Veneta', 'Bottega'],
  ['Balenciaga'],
  ['Céline', 'Celine'],
  ['Fendi'],
  ['Miu Miu', 'Miumiu'],
  ['Loewe'],
  ['Chloé', 'Chloe'],
  ['Valentino'],
  ['Givenchy'],
  ['Burberry'],
  ['Versace'],
  ['Dolce & Gabbana', 'Dolce&Gabbana', 'Dolce Gabbana', 'D&G'],
  ['Michael Kors'],
  ['Marc Jacobs'],
  ['Coach'],
  ['Tory Burch'],
  ['Furla'],
  ['Moncler'],
  ['Max Mara'],
  ['Brunello Cucinelli'],
  ['Loro Piana', 'Loro Piano'],
  ['Stone Island'],
  ['Canada Goose'],
  ['Cartier'],
  ['Rolex'],
  ['Tiffany', 'Tiffany & Co'],
  ['Van Cleef', 'Van Cleef & Arpels'],
  ['Bvlgari', 'Bulgari'],
  ['Swarovski'],
  ['Christian Louboutin', 'Louboutin'],
  ['Jimmy Choo'],
  ['Manolo Blahnik'],
  ['Goyard'],
  ['Delvaux'],
  ['Nike'],
  ['Adidas'],
  ['New Balance'],
  ['Golden Goose'],
  ['Zara'],
  ['Massimo Dutti'],
  // Added 2026-08-18 from the catalogues themselves. Every one of these was
  // sitting in the vitrine with its name written plainly in the caption and no
  // brand on the card, because the list had never heard of it — 1858 cards
  // between them and the two causes above. The list is the vocabulary of what
  // this shop actually sells, so it grows from the shop, not from a guess about
  // what a luxury list ought to contain.
  ['The Row'],
  ['Zegna', 'Ermenegildo Zegna'],
  ['Berluti'],
  ['Kiton'],
  ['Omega'],
  ['Patek Philippe', 'Patek Philipe', 'Patek'],
  ['Piaget'],
  ['Graff'],
  ['Messika'],
  ['Montblanc', 'Mont Blanc'],
  ['Zimmermann'],
  ['Balmain'],
  ['Schiaparelli'],
  ['Maison Margiela', 'Margiela'],
  ['Thom Browne'],
  ['Brioni'],
  ['Stefano Ricci'],
  ['Santoni'],
  ['Tod\'s', 'Tods'],
  ['Alaïa', 'Azzedine Alaïa'],
  ['Aquazzura'],
  ['Gianvito Rossi'],
  ['Paris Texas'],
  ['Emilio Pucci', 'Pucci'],
  ['Ralph Lauren', 'Polo Ralph Lauren'],
  ['On Running'],
  ['Alo', 'Alo Yoga'],
  ['Agua by Agua Bendita', 'Agua Bendita'],
  ['Most Romas'],
];

// Ukrainian/Russian category words as they appear in the catalogues.
// Both alphabets: the descriptions are Ukrainian, the model names are not
// ("Book Tote", "Neverfull", "Speedy").
const CATEGORIES = [
  [/(сумк|клатч|тоут|шопер|рюкзак)|\b(bag|tote|clutch|backpack|shopper|hobo|baguette)\b/i, 'сумка'],
  [/(гаманц|гаманец|кошель|портмоне)|\b(wallet|cardholder|card holder)\b/i, 'гаманець'],
  [/(взутт|кросівк|кросовк|туфл|черевик|босоніжк|чобот|сандал|лофер|мюл|балетк)|\b(sneakers|boots|sandals|mules|loafers|pumps|slingback|ballerinas)\b/i, 'взуття'],
  [/(куртк|пуховик|пальт|шуб|дублянк|тренч|плащ)|\b(coat|jacket|puffer|parka|trench|fur)\b/i, 'верхній одяг'],
  [/(сукн|плать|спідниц|блуз|сорочк|футболк|худі|светр|костюм|штан|джинс|шорт)|\b(dress|skirt|shirt|hoodie|sweater|pants|jeans|shorts|t-shirt)\b/i, 'одяг'],
  [/(годинник|часы)|\b(watch)\b/i, 'годинник'],
  [/(окуляр|очки)|\b(sunglasses|glasses)\b/i, 'окуляри'],
  [/(прикрас|браслет|каблучк|кільц|сереж|ланцюж|кулон|намист)|\b(bracelet|ring|earrings|necklace|pendant)\b/i, 'прикраси'],
  [/(ремін|ремень|пояс)|\b(belt)\b/i, 'ремінь'],
  [/(хустк|шарф|платок|палантин)|\b(scarf|shawl)\b/i, 'аксесуар'],
  [/(косметичк|несесер)|\b(pouch|cosmetic)\b/i, 'косметичка'],
  [/(парфум|аромат|духи)|\b(perfume|fragrance)\b/i, 'парфуми'],
];

// Cyrillic letters that are drawn exactly like Latin ones. The catalogues are
// full of them — «Нermes» with a Cyrillic Н, «Chanеl» with a Cyrillic е,
// «Valentinо», «BERLUTІ», «Jimmy Choо» — and it is not carelessness: a caption
// that does not literally spell a trademark is a caption that keyword filters do
// not flag. Whatever the reason, the shop means Hermès, so the app has to read
// it as Hermès. 76 cards in one channel hung on this single letter.
const HOMOGLYPHS = {
  А: 'A', В: 'B', Е: 'E', З: '3', І: 'I', К: 'K', М: 'M', Н: 'H', О: 'O',
  Р: 'P', С: 'C', Т: 'T', У: 'Y', Х: 'X', Ѕ: 'S', Ј: 'J',
  а: 'a', в: 'b', е: 'e', і: 'i', к: 'k', м: 'm', о: 'o', р: 'p', с: 'c',
  у: 'y', х: 'x', ѕ: 's', ј: 'j',
};

/**
 * The form a caption is MATCHED in — never the form anything is displayed in.
 *
 * Three passes, and each one exists because of captions actually in the
 * catalogues:
 *   NFKC       «𝗟𝗢𝗨𝗜𝗦 𝗩𝗨𝗜𝗧𝗧𝗢N», «𝐂𝐚𝐫𝐭𝐢𝐞𝐫», «𝒁𝑰𝑴𝑴𝑬𝑹𝑴𝑨𝑵𝑵» — Telegram's
 *              styled text is the Mathematical Alphanumeric block, and NFKC
 *              folds every one of those variants back to plain letters.
 *   homoglyphs the Cyrillic lookalikes above.
 *   NFD + drop the accents, so a single «Hermès» entry answers for «Hermes»,
 *   combining «HERMÈS» and «hermes» alike, and «Alaïa» needs no second spelling.
 */
export function foldForMatch(text = '') {
  return String(text)
    .normalize('NFKC')
    .replace(/[\u0400-\u04FF]/g, (ch) => HOMOGLYPHS[ch] ?? ch)
    .normalize('NFD')
    .replace(/\p{M}+/gu, '');
}

// Compiled once. The list is long enough now that rebuilding ~90 regexes for
// every post of every sync is real work for no reason.
const BRAND_MATCHERS = BRANDS.map((spellings) => [
  spellings[0],
  spellings.map((spelling) => new RegExp(
    // Word-boundary match so "Dior" does not fire inside another word, and "LV"
    // does not fire inside "LVMH".
    `(^|[^\\p{L}])${foldForMatch(spelling).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\p{L}]|$)`,
    'iu')),
]);

export function detectBrand(text = '') {
  const folded = foldForMatch(text);
  for (const [canonical, matchers] of BRAND_MATCHERS) {
    // The canonical name, not the spelling that matched.
    for (const re of matchers) if (re.test(folded)) return canonical;
  }
  return null;
}

/** Every house the vitrine knows, canonical spelling only. vision.js offers this
 *  list to the model and refuses anything outside it — a free-text answer would
 *  grow a second «Hermes» chip beside «Hermès» and split the counts. */
export const BRAND_NAMES = BRANDS.map((spellings) => spellings[0]);

export function detectCategory(text = '') {
  for (const [re, label] of CATEGORIES) if (re.test(text)) return label;
  return null;
}

// A short, scannable name. Never a paragraph.
//
// `hints` lets the caller supply a brand or category it has already worked out —
// including a category that came from the CHANNEL rather than from the text, so
// a bag posted with nothing but "Balenciaga" still reads «Balenciaga · сумка».
export function buildTitle(text = '', hints = {}) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  const brand = 'brand' in hints ? hints.brand : detectBrand(clean);
  const category = 'category' in hints ? hints.category : detectCategory(clean);

  if (brand && category) return `${brand} · ${category}`;
  if (brand) return brand;

  if (!clean) return category ? capitalise(category) : 'Нова позиція';

  // No brand: the first phrase, cut on a sentence break. A phrase that would
  // have to be truncated is a paragraph, not a name — in that case the category
  // ("Сумка") reads better on a card than half a sentence with an ellipsis.
  const phrase = clean.split(/[.!?•\n]/)[0].trim();
  if (phrase.length <= 46) return phrase || (category ? capitalise(category) : 'Нова позиція');
  if (category) return capitalise(category);
  const cut = phrase.slice(0, 46);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 20 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

const capitalise = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * @param text  the post's caption, as written
 * @param channelTitle  the catalogue's own name — see below
 */
export function parsePostText(text = '', { channelTitle = '' } = {}) {
  const clean = String(text || '').trim();
  const { price, currency } = parsePrice(clean);
  // BRAND, in priority order. The caption is the seller's own word and it wins
  // outright — including when it is wrong, which happens (a Miu Miu bag captioned
  // «Gucci»). Correcting the channel is not ours to do, so the app repeats what
  // the channel says and only fills SILENCE.
  //
  //   1. the caption            — «Gucci | Size 21x13x7,5cm»
  //   2. the catalogue's name   — @w2b_hermes is titled «Hermès», so a caption
  //                               that is nothing but a size still lands on a
  //                               brand. 126 posts in two channels today.
  //   3. the photograph         — vision.js, and only where 1 and 2 are silent.
  //                               Not here: it costs a model call and a network
  //                               round trip, so it runs in the scheduler over
  //                               what this function left null. See docs/TODO.md.
  //
  // `brandSource` records WHICH of the three answered, and it is what stops the
  // later steps from arguing with the earlier ones — the backfill only looks at
  // rows nobody has answered for, and a re-sync knows a stored vision verdict
  // from a caption it should refresh.
  const fromText = detectBrand(clean);
  const brand = fromText || detectBrand(channelTitle);
  const brandSource = fromText ? 'text' : (brand ? 'channel' : null);
  // A catalogue whose NAME is the category answers what the caption left out.
  // Most cards read "Balenciaga / Size 33-12-12cm" and nothing else, so category
  // was known for one post in four — while «Сумки жіночі» knew the answer all
  // along. The channel's own title is the source, which means a catalogue added
  // later and called «Гаманці» starts labelling wallets with no configuration:
  // the same rule that makes the filter row grow by itself.
  const category = detectCategory(clean) || detectCategory(channelTitle);
  return {
    title: buildTitle(clean, { brand, category }),
    // The whole post stays as the body — nothing the client wrote is lost.
    body: clean.slice(0, 1000),
    price,
    currency,
    article: parseArticle(clean),
    brand,
    brandSource,
    category,
  };
}

// Largest available size of each photo in the message.
function photoIds(post) {
  const out = [];
  if (Array.isArray(post.photo) && post.photo.length) {
    const largest = post.photo.reduce((a, b) => ((a.file_size || 0) >= (b.file_size || 0) ? a : b));
    out.push(largest.file_id);
  }
  if (post.document && String(post.document.mime_type || '').startsWith('image/')) {
    out.push(post.document.file_id);
  }
  return out;
}

// ── CHANNEL → APP ─────────────────────────────────────────────────────────

export async function ingestChannelPost(update) {
  const post = update?.channel_post || update?.edited_channel_post;
  if (!post) return null;
  const edited = Boolean(update.edited_channel_post);

  const channel = await resolveChannel(post.chat);
  if (!channel || !channel.enabled) return null;

  const parsed = parsePostText(post.text || post.caption || '', { channelTitle: channel.title });
  const photos = photoIds(post);
  const createdAt = new Date((post.date || Math.floor(Date.now() / 1000)) * 1000).toISOString();

  const existing = await db.prepare('SELECT * FROM posts WHERE tg_message_id=? AND channel=?')
    .get(post.message_id, channel.key);

  if (existing) {
    // An edit in the channel must show up in the app — that is the whole point
    // of "и наоборот".
    if (edited) {
      // BRAND AND CATEGORY MUST MOVE WITH THE CAPTION. This update used to
      // refresh the title and leave them behind, and the result was on the
      // shelf: cards reading «Gucci · сумка» filed under Saint Laurent, because
      // the seller had edited a Saint Laurent post into a Gucci one and only
      // half the card followed. Same ladder as the sync upsert — a human's
      // correction is untouchable, and a brand read off the photograph survives
      // a caption that still says nothing.
      const keepVision = !parsed.brand && ['vision', 'vision-none'].includes(existing.brand_source);
      const brand = existing.curated || keepVision ? existing.brand : parsed.brand;
      const brandSource = existing.curated || keepVision ? existing.brand_source : parsed.brandSource;
      await db.prepare(`UPDATE posts SET title=?, body=?, price=COALESCE(?, price), currency=COALESCE(?, currency),
                  article=COALESCE(?, article), photos_json=COALESCE(?, photos_json),
                  brand=?, brand_source=?, category=?, edited_at=? WHERE id=?`)
        // …and the title obeys `curated` here too. The sync has always respected
        // it; this path did not, so a channel edit quietly undid a correction
        // somebody had made in the cabinet.
        .run(existing.curated ? existing.title : parsed.title,
          parsed.body, parsed.price, parsed.currency, parsed.article,
          photos.length ? JSON.stringify(photos) : null,
          brand, brandSource, existing.curated ? existing.category : parsed.category,
          new Date().toISOString(), existing.id);
    }
    return existing.id;
  }

  // Albums arrive as several updates sharing one media_group_id. The first one
  // creates the post; the rest only add their photo, so an album is one card.
  if (post.media_group_id) {
    const groupRow = await db.prepare('SELECT * FROM posts WHERE media_group_id=? AND channel=?')
      .get(String(post.media_group_id), channel.key);
    if (groupRow) {
      const current = safeParse(groupRow.photos_json) || [];
      const merged = [...new Set([...current, ...photos])].slice(0, 10);
      await db.prepare(`UPDATE posts SET photos_json=?,
                  title = CASE WHEN ? <> '' AND (title IS NULL OR title = 'Нова позиція') THEN ? ELSE title END,
                  body  = CASE WHEN ? <> '' AND (body IS NULL OR body = '') THEN ? ELSE body END,
                  price = COALESCE(price, ?), article = COALESCE(article, ?)
                  WHERE id=?`)
        .run(JSON.stringify(merged), parsed.title, parsed.title, parsed.body, parsed.body,
          parsed.price, parsed.article, groupRow.id);
      return groupRow.id;
    }
  }

  const info = await db.prepare(`INSERT INTO posts
    (channel,tg_message_id,title,body,price,currency,image_url,article,brand,brand_source,category,photos_json,media_group_id,source,status,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'channel','published',?)`)
    .run(
      channel.key, post.message_id, parsed.title, parsed.body,
      parsed.price, parsed.currency || 'USD',
      photos.length ? null : '🛍️',
      parsed.article, parsed.brand, parsed.brandSource, parsed.category,
      photos.length ? JSON.stringify(photos) : null,
      post.media_group_id ? String(post.media_group_id) : null,
      createdAt,
    );
  return Number(info.lastInsertRowid);
}

function safeParse(s) {
  return asJson(s);
}

// ── APP → CHANNEL ─────────────────────────────────────────────────────────

function renderPost({ title, body, price, currency, article }) {
  const money = price ? `\n\n💰 <b>${price} ${currency || ''}</b>` : '';
  const art = article ? `\n<code>${escapeHtml(article)}</code>` : '';
  return `<b>${escapeHtml(title)}</b>\n${escapeHtml(body || '')}${art}${money}`.trim();
}

export async function publishPost({ channel, title, body, price, currency, article, photoUrl }) {
  const ch = await getChannel(channel);
  if (!ch) throw new Error('unknown channel');
  const created_at = new Date().toISOString();
  const text = renderPost({ title, body, price, currency, article });

  let tg_message_id = null;
  if (liveMode()) {
    const target = ch.chatId || `@${ch.username}`;
    const msg = photoUrl
      ? await tg('sendPhoto', { chat_id: target, photo: photoUrl, caption: text, parse_mode: 'HTML' })
      : await tg('sendMessage', { chat_id: target, text, parse_mode: 'HTML' });
    tg_message_id = msg.message_id;
  } else {
    tg_message_id = Math.floor(90000 + Math.abs(hash(title + created_at)) % 9999);
  }

  const info = await db.prepare(`INSERT INTO posts
    (channel,tg_message_id,title,body,price,currency,image_url,article,source,status,created_at)
    VALUES (?,?,?,?,?,?,?,?, 'app','published',?)`)
    .run(ch.key, tg_message_id, title, body || '', price || null, currency || 'USD',
      photoUrl || '🛍️', article || null, created_at);

  return { id: Number(info.lastInsertRowid), tg_message_id, live: liveMode() };
}

export async function sendToUser(tgUserId, text, extra = {}) {
  if (!liveMode()) return { simulated: true, text };
  return await tg('sendMessage', { chat_id: tgUserId, text, parse_mode: 'HTML', ...extra });
}

// ── private chat: /start → the button that opens the Mini App ─────────────
//
// A client who writes to the bot must land in the catalogue in one tap. This
// is also the moment Telegram lets the bot DM them later: a bot may only
// message a user who has started it, so every birthday/inquiry notification
// depends on this handshake having happened.
export async function handleMessage(update) {
  const msg = update?.message;
  if (!msg || msg.chat?.type !== 'private') return null;
  const text = String(msg.text || '').trim();
  if (!text.startsWith('/start')) return null;

  const appUrl = process.env.PUBLIC_URL || '';
  const name = msg.from?.first_name ? `, ${msg.from.first_name}` : '';
  const body =
    `<b>Way2Buy</b>\n\nВітаємо${escapeHtml(name)}! Тут усі наші каталоги в одному місці: ` +
    `обираєте позицію, додаєте в примірочну — і ${process.env.SUPPORT_NAME || 'Даша'} відповість щодо ціни та наявності.\n\n` +
    'Бонуси клубу теж тут: знижка на день народження та бонус за покупку.';

  if (!liveMode()) return { simulated: true, body };
  return await tg('sendMessage', {
    chat_id: msg.chat.id,
    text: body,
    parse_mode: 'HTML',
    reply_markup: appUrl
      ? { inline_keyboard: [[{ text: '🛍️ Відкрити каталог', web_app: { url: appUrl } }]] }
      : undefined,
  });
}

// The persistent "Open app" button next to the message field, and the command
// list — both are one-time account settings, applied by scripts/telegram.mjs.
export async function configureBot(publicUrl) {
  if (!liveMode()) return { skipped: 'no token' };
  const url = String(publicUrl || '').replace(/\/$/, '');
  const out = {};
  out.commands = await tg('setMyCommands', {
    commands: [{ command: 'start', description: 'Відкрити каталог Way2Buy' }],
  });
  if (url) {
    out.menuButton = await tg('setChatMenuButton', {
      menu_button: { type: 'web_app', text: 'Каталог', web_app: { url } },
    });
  }
  out.description = await tg('setMyShortDescription', {
    short_description: 'Каталоги Way2Buy, примірочна та бонуси клубу',
  });
  return out;
}

export async function webhookInfo() {
  if (!liveMode()) return { skipped: 'no token' };
  return await tg('getWebhookInfo', {});
}

export async function botInfo() {
  if (!liveMode()) return { skipped: 'no token' };
  return await tg('getMe', {});
}

// Is the bot able to RECEIVE this channel's posts?
//
// getChat succeeds for any public channel, member or not — so it proves the
// channel exists, nothing more. Only an 'administrator' membership makes
// Telegram deliver `channel_post` updates, which is the whole bridge. Both
// facts are reported separately so the setup screen can say which one is
// missing.
export async function checkChannelAccess(usernameOrId) {
  if (!liveMode()) return { skipped: 'no token' };
  const chat = String(usernameOrId).startsWith('@') || /^-?\d+$/.test(String(usernameOrId))
    ? usernameOrId
    : `@${usernameOrId}`;
  const info = await tg('getChat', { chat_id: chat });

  let status = 'unknown';
  let canPost = false;
  try {
    const me = await tg('getMe', {});
    const member = await tg('getChatMember', { chat_id: info.id, user_id: me.id });
    status = member.status;
    canPost = Boolean(member.can_post_messages);
  } catch {
    // 'member not found' → the bot is not in the channel at all.
    status = 'left';
  }

  return {
    id: info.id,
    title: info.title,
    username: info.username,
    type: info.type,
    status,
    isAdmin: status === 'administrator' || status === 'creator',
    canPost,
  };
}

export async function setWebhook(publicUrl) {
  if (!liveMode() || !publicUrl) return { skipped: true };
  return await tg('setWebhook', {
    url: `${publicUrl.replace(/\/$/, '')}/telegram/webhook`,
    allowed_updates: ['channel_post', 'edited_channel_post', 'message'],
    secret_token: process.env.TELEGRAM_WEBHOOK_SECRET || undefined,
  });
}

function escapeHtml(s = '') {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i) | 0;
  return h;
}

// Legacy export kept so older imports keep resolving; prefer (await listChannels()).
export const CHANNELS = new Proxy({}, {
  get: async (_t, prop) => (typeof prop === 'string' ? await getChannel(prop) : undefined),
  // Proxy traps cannot be async, and ownKeys must return a real array — the
  // channel list is not reachable synchronously any more. Anything that needs the
  // keys should call listChannels() itself.
  ownKeys: () => [],
  getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
});
