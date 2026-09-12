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
  // `who` is a person's name as configured (SUPPORT_NAME) and is passed through
  // untranslated in every language — it is somebody's name, not a phrase, and
  // the shop is the only one who may spell it.
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
export function render(lang, key, params = {}) {
  const entry = MESSAGES[key];
  // An unknown key is a programming error, and a silent empty DM is the worst
  // possible way to report one: the client gets nothing and nobody finds out.
  if (!entry) throw new Error(`i18n: unknown message key «${key}»`);
  const target = normalizeLang(lang) || DEFAULT_LANG;
  return (entry[target] || entry[DEFAULT_LANG])(params);
}

/** Every key in the catalogue — the tests walk it so a new one cannot ship with a language missing. */
export const messageKeys = () => Object.keys(MESSAGES);
