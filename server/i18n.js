// ─────────────────────────────────────────────────────────────────────────
//  i18n.js — what the BOT says, in the language the client reads.
//
//  The interface has spoken three languages since the first week; everything
//  the server SENT spoke one. A client who opened the app in Russian still got
//  her birthday greeting, her fitting-room reminder and her promo code in
//  Ukrainian — a language she had not chosen, from a shop that had already
//  asked her which one she wanted.
//
//  Two channels, two rules, and the difference is deliberate:
//
//    the notification ROW  stays Ukrainian. It is the authoritative record
//                          (ADR-005), the cabinet reads it, and the client's own
//                          feed is re-written in the browser by public/js/i18n.js.
//    the Telegram DM       is rendered here, in the client's language. Telegram
//                          has no DOM to re-translate, so this is the only place
//                          where the choice can still be honoured.
//
//  Hence a message is a KEY and its parameters, never a finished string. The
//  cabinet's translator has to take assembled Ukrainian sentences apart with
//  regular expressions because by then that is all it has; here the sentence has
//  not been assembled yet, and building it three times is cheaper and truer than
//  building it once and parsing it back.
//
//  Adding a language is adding a column of entries below — nothing else in the
//  server knows how many there are.
// ─────────────────────────────────────────────────────────────────────────

export const LANGS = ['uk', 'ru', 'en'];

// Ukrainian is the authoring language: it is what the rows are stored in and
// what answers for anyone who has not told us otherwise.
export const DEFAULT_LANG = 'uk';

/**
 * 'ru-RU' → 'ru'. Also accepts a full Accept-Language header — the client sends
 * a single tag (public/js/api.js), but a plain browser sends a weighted list
 * like `en-US,en;q=0.9,ru;q=0.8`, and the first entry is the one that counts.
 *
 * Returns null for anything unsupported, so a caller can tell "they asked for
 * something we do not have" from "they asked for Ukrainian".
 */
export function normalizeLang(code) {
  const first = String(code || '').split(',')[0].split(';')[0].trim().toLowerCase();
  if (!first) return null;
  const base = first.split('-')[0];
  return LANGS.includes(base) ? base : null;
}

// Ukrainian and Russian both take three forms and agree on the rule; English
// takes two. Same shape as plural() in public/js/app.js on purpose — if one of
// them is ever wrong, it should be wrong in a way the other makes obvious.
function plural(lang, n, forms) {
  if (lang === 'en') return forms[Math.abs(n) === 1 ? 0 : 1];
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}

// «від замовлення $200» is a clause, not a sentence, and it disappears entirely
// when there is no minimum — so it is built per language rather than glued on.
const minClause = {
  uk: (usd) => (usd ? ` від замовлення $${usd}` : ''),
  ru: (usd) => (usd ? ` при заказе от $${usd}` : ''),
  en: (usd) => (usd ? ` on orders of $${usd}` : ''),
};

// ─────────────────────────────────────────────────────────────────────────
//  The catalogue.
//
//  Every Ukrainian entry is byte-identical to the string the server sent before
//  this file existed. That is not sentiment: the row is stored in Ukrainian, the
//  cabinet shows it, the browser translator matches it by exact phrase, and the
//  tests read it. Ukrainian changing its wording is a separate decision from
//  Russian and English gaining one.
// ─────────────────────────────────────────────────────────────────────────
const MESSAGES = {
  // Someone filled the fitting room and never pressed «Відправити».
  abandoned_cart: {
    uk: ({ items, percent, code, minOrderUsd, validDays }) => ({
      title: 'Ваші речі чекають у примірочній 👜',
      body: `Ви обрали ${items} ${plural('uk', items, ['позицію', 'позиції', 'позицій'])}, але ще не написали ` +
            `менеджеру. Тримайте −${percent}% на це замовлення: промокод ${code}` +
            (minOrderUsd ? ` (від замовлення $${minOrderUsd})` : '') +
            `. Діє ${validDays} ${plural('uk', validDays, ['день', 'дні', 'днів'])} — ` +
            `відкрийте «Примірочну» і натисніть «Відправити».`,
    }),
    ru: ({ items, percent, code, minOrderUsd, validDays }) => ({
      title: 'Ваши вещи ждут в примерочной 👜',
      body: `Вы выбрали ${items} ${plural('ru', items, ['позицию', 'позиции', 'позиций'])}, но ещё не написали ` +
            `менеджеру. Держите −${percent}% на этот заказ: промокод ${code}` +
            (minOrderUsd ? ` (от заказа $${minOrderUsd})` : '') +
            `. Действует ${validDays} ${plural('ru', validDays, ['день', 'дня', 'дней'])} — ` +
            `откройте «Примерочную» и нажмите «Отправить».`,
    }),
    en: ({ items, percent, code, minOrderUsd, validDays }) => ({
      title: 'Your picks are waiting in the fitting room 👜',
      body: `You chose ${items} ${plural('en', items, ['item', 'items'])} but never messaged the ` +
            `manager. Here is −${percent}% on this order: promo code ${code}` +
            (minOrderUsd ? ` (on orders of $${minOrderUsd})` : '') +
            `. Valid for ${validDays} ${plural('en', validDays, ['day', 'days'])} — ` +
            `open “Fitting room” and tap “Send”.`,
    }),
  },

  // The birthday window opened today; the discount is there to be claimed.
  birthday_available: {
    uk: ({ amountLabel, minOrderUsd, validDays }) => ({
      title: 'З днем народження! 🎂',
      body: `Ваша знижка ${amountLabel}${minClause.uk(minOrderUsd)} чекає в застосунку — ` +
            `натисніть «Отримати знижку». Діє ${validDays} днів.`,
    }),
    ru: ({ amountLabel, minOrderUsd, validDays }) => ({
      title: 'С днём рождения! 🎂',
      body: `Ваша скидка ${amountLabel}${minClause.ru(minOrderUsd)} ждёт в приложении — ` +
            `нажмите «Получить скидку». Действует ${validDays} ` +
            `${plural('ru', validDays, ['день', 'дня', 'дней'])}.`,
    }),
    en: ({ amountLabel, minOrderUsd, validDays }) => ({
      title: 'Happy birthday! 🎂',
      body: `Your ${amountLabel} discount${minClause.en(minOrderUsd)} is waiting in the app — ` +
            `tap “Claim discount”. Valid for ${validDays} ${plural('en', validDays, ['day', 'days'])}.`,
    }),
  },

  // They tapped it, and the code is theirs.
  birthday_granted: {
    uk: ({ amountLabel, minOrderUsd, code, until }) => ({
      title: 'Вітаємо з днем народження! 🎂',
      body: `Ваша знижка ${amountLabel}${minClause.uk(minOrderUsd)}. Промокод ${code}, діє до ${until}.`,
    }),
    ru: ({ amountLabel, minOrderUsd, code, until }) => ({
      title: 'Поздравляем с днём рождения! 🎂',
      body: `Ваша скидка ${amountLabel}${minClause.ru(minOrderUsd)}. Промокод ${code}, действует до ${until}.`,
    }),
    en: ({ amountLabel, minOrderUsd, code, until }) => ({
      title: 'Happy birthday! 🎂',
      body: `Your ${amountLabel} discount${minClause.en(minOrderUsd)}. Promo code ${code}, valid through ${until}.`,
    }),
  },

  // The fitting room was sent.
  //
  // What the client actually asked is «is this in stock, and what does it
  // cost» — they are not writing a letter, they are asking a shop a question.
  // The confirmation says so: a promise to be contacted answers "did it
  // arrive", not "what happens next".
  //
  // `who` is a person's name as configured (SUPPORT_NAME). It is not translated
  // — a name is not a phrase — but it IS transliterated for English, because
  // «Даша will check availability» is a sentence in two alphabets. See
  // personName() below; Russian keeps the Cyrillic spelling it already has.
  // Dasha's own answer, carried to the client.
  //
  // The ANSWER is never translated: it is what a person wrote about one bag,
  // and running it through a dictionary would turn a price into a guess. Only
  // the line that frames it is in three languages — the client has to know what
  // this message is about before she reads it.
  inquiry_answered: {
    uk: ({ who, answer }) => ({
      title: `${who} відповіла 💬`,
      body: `Відповідь щодо вашого запиту:\n«${answer}»`,
    }),
    ru: ({ who, answer }) => ({
      title: `${who} ответила 💬`,
      body: `Ответ по вашему запросу:\n«${answer}»`,
    }),
    en: ({ who, answer }) => ({
      title: `${who} replied 💬`,
      body: `An answer to your request:\n«${answer}»`,
    }),
  },

  inquiry_sent: {
    uk: ({ who, items }) => ({
      title: 'Запит надіслано ✅',
      body: `${who} перевірить наявність і напише вам ціну щодо ${items === 1 ? 'позиції' : `${items} позицій`}.`,
    }),
    ru: ({ who, items }) => ({
      title: 'Запрос отправлен ✅',
      body: `${who} проверит наличие и напишет вам цену по ${items === 1 ? 'позиции' : `${items} позициям`}.`,
    }),
    en: ({ who, items }) => ({
      title: 'Request sent ✅',
      body: `${who} will check availability and send you the price for ${items === 1 ? 'your item' : `${items} items`}.`,
    }),
  },
};

/**
 * Render one message.
 *
 * @param {string|null} lang  'uk' | 'ru' | 'en', a BCP-47 tag, an Accept-Language
 *                            header, or nothing at all — anything unrecognised
 *                            falls back to Ukrainian rather than failing.
 * @returns {{title: string, body: string}}
 */
// A date a person reads: 13.10.2026.
//
// Dates travel through this system as ISO strings because that is what sorts,
// compares and survives a round trip through Postgres. What leaked was the
// habit of putting one straight into a sentence with `.slice(0, 10)`: «Промокод
// BDAY-045-BUI2, діє до 2026-10-13» is a machine format sitting in the middle
// of a line addressed to a client, and it is the only place in the app where
// the year came first.
//
// Read in UTC on purpose. `.slice(0, 10)` took the UTC day, the columns are
// stored in UTC, and a birthday window that opens at midnight would otherwise
// show the day before to anybody west of London.
//
// The date is the SAME in all three languages. A day and a month separated by
// dots is unambiguous everywhere the shop sells, which a slash is not: 10/13
// and 13/10 are the same date written for two different readers.
export function dmy(value) {
  // An absent value is not a date at the start of the epoch. `new Date(null)`
  // is 1 January 1970 and passes every validity check there is, so a NULL
  // column would have reached a client as «діє до 01.01.1970» — which reads
  // like a bug in the shop rather than a missing value.
  if (value === null || value === undefined || value === '') return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
}

// Cyrillic → Latin, for a name in an English sentence.
//
// Mirrors the table in public/js/i18n.js: the DM and the screen say the same
// thing to the same person, and they have no business spelling her name two
// ways. Only ever applied to a NAME — a transliterated sentence is unreadable
// in every language.
const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ie', ж: 'zh',
  з: 'z', и: 'y', і: 'i', ї: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n',
  о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts',
  ч: 'ch', ш: 'sh', щ: 'shch', ь: '', ю: 'iu', я: 'ia', ы: 'y', э: 'e',
  ё: 'e', ъ: '',
};

export function personName(value, lang) {
  const name = String(value ?? '');
  if (!name || normalizeLang(lang) !== 'en') return name;
  let out = '';
  for (const ch of name) {
    const lower = ch.toLowerCase();
    const mapped = TRANSLIT[lower];
    if (mapped === undefined) { out += ch; continue; }
    // «Жанна» must come out «Zhanna», not «ZHanna».
    out += ch === lower ? mapped : mapped.charAt(0).toUpperCase() + mapped.slice(1);
  }
  return out;
}

export function render(lang, key, params = {}) {
  const entry = MESSAGES[key];
  // An unknown key is a programming error, and a silent empty DM is the worst
  // possible way to report one: the client gets nothing and nobody finds out.
  if (!entry) throw new Error(`i18n: unknown message key «${key}»`);
  const target = normalizeLang(lang) || DEFAULT_LANG;
  // One place for the name, so no template has to remember to do it.
  const withName = params.who === undefined
    ? params
    : { ...params, who: personName(params.who, target) };
  return (entry[target] || entry[DEFAULT_LANG])(withName);
}

/** Every key in the catalogue — the tests walk it so a new one cannot ship with a language missing. */
export const messageKeys = () => Object.keys(MESSAGES);
