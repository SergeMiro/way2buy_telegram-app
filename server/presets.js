// ─────────────────────────────────────────────────────────────────────────
//  presets.js — the ready-made campaigns the owner picks from.
//
//  The condition engine in campaigns.js can express a great deal. That is
//  exactly why this file exists: nobody launching a Christmas sale wants to
//  think in `{ boughtWithinDays: 30, minPurchases: 2 }`. A preset is one tap
//  that fills the whole form — dates, audience, a sensible discount — and then
//  gets edited like anything else. The preset is remembered on the campaign so
//  the cabinet can say «Різдвяна знижка» instead of re-deriving it from a set
//  of conditions afterwards.
//
//  Dates are computed FOR A GIVEN YEAR rather than stored, so «Великдень» is
//  right in 2027 without anybody editing a table. Easter is the Orthodox one:
//  this shop's clients keep the Ukrainian calendar, and the Western date is a
//  different Sunday most years.
//
//  Every preset says what it is FOR in `why`. A discount nobody can explain the
//  reason for is one nobody can decide to stop.
// ─────────────────────────────────────────────────────────────────────────

const DAY = 86400000;
const utc = (y, m, d) => Date.UTC(y, m - 1, d);
const iso = (ms) => new Date(ms).toISOString();

// ── movable feasts ─────────────────────────────────────────────────────────

/** Orthodox Easter (Meeus's Julian algorithm), returned as a Gregorian date.
 *  The +13 day shift is the Julian→Gregorian offset, correct for 1900–2099. */
export function orthodoxEaster(year) {
  const a = year % 4;
  const b = year % 7;
  const c = year % 19;
  const d = (19 * c + 15) % 30;
  const e = (2 * a + 4 * b - d + 34) % 7;
  const month = Math.floor((d + e + 114) / 31);
  const day = ((d + e + 114) % 31) + 1;
  return utc(year, month, day) + 13 * DAY;
}

/** Black Friday — the day after the fourth Thursday of November. */
export function blackFriday(year) {
  const first = new Date(utc(year, 11, 1));
  // 4 = Thursday. Days to the first Thursday, then three weeks on.
  const offset = (4 - first.getUTCDay() + 7) % 7;
  return utc(year, 11, 1 + offset + 21) + DAY;
}

// A window that may cross into the next year (Christmas), expressed as a
// function of "the year the window OPENS in".
const spanOf = (year, from, to) => {
  const start = utc(year, from[0], from[1]);
  const endYear = (to[0] < from[0] || (to[0] === from[0] && to[1] < from[1])) ? year + 1 : year;
  return { startsAt: start, endsAt: utc(endYear, to[0], to[1]) + DAY - 1 };
};

// Around a movable date: N days before, M after.
const around = (ms, before, after) => ({ startsAt: ms - before * DAY, endsAt: ms + after * DAY + DAY - 1 });

// If the window for this year has already closed, offer next year's — a preset
// picked in December must not create a campaign that ended in March.
const upcoming = (now, build) => {
  const y = new Date(now).getUTCFullYear();
  const thisYear = build(y);
  return now <= thisYear.endsAt ? thisYear : build(y + 1);
};

// ── the catalogue ──────────────────────────────────────────────────────────
//
// `type` maps onto the discount card the client sees (holiday / birthday / vip /
// generic). `suggest` is a starting point, not a rule — every field stays
// editable in the builder.

export const PRESETS = [
  // ── the shop's calendar ────────────────────────────────────────────────
  {
    key: 'christmas', group: 'Свята', emoji: '🎄', name: 'Різдвяна знижка',
    why: 'Найдовший подарунковий сезон у році — вікно ширше за сам день.',
    type: 'holiday', suggest: { mode: 'percent', value: 15, promoValidDays: 21 },
    window: (now) => upcoming(now, (y) => spanOf(y, [12, 20], [1, 8])),
  },
  {
    key: 'new_year', group: 'Свята', emoji: '🎆', name: 'Новорічна знижка',
    why: 'Коротке вікно навколо 31 грудня, коли купують собі, а не в подарунок.',
    type: 'holiday', suggest: { mode: 'percent', value: 20, promoValidDays: 14 },
    window: (now) => upcoming(now, (y) => spanOf(y, [12, 26], [1, 5])),
  },
  {
    key: 'easter', group: 'Свята', emoji: '🥚', name: 'Великодня знижка',
    why: 'Дата рухома — рахується щороку сама, за православною пасхалією.',
    type: 'holiday', suggest: { mode: 'percent', value: 12, promoValidDays: 14 },
    window: (now) => upcoming(now, (y) => around(orthodoxEaster(y), 7, 3)),
  },
  {
    key: 'women_day', group: 'Свята', emoji: '💐', name: '8 Березня',
    why: 'Найсильніший день року для подарунків у цій категорії.',
    type: 'holiday', suggest: { mode: 'percent', value: 15, promoValidDays: 10 },
    window: (now) => upcoming(now, (y) => spanOf(y, [3, 1], [3, 10])),
  },
  {
    key: 'valentine', group: 'Свята', emoji: '❤️', name: 'День закоханих',
    why: 'Купують чоловіки і купують швидко — вікно коротке, знижка помітна.',
    type: 'holiday', suggest: { mode: 'percent', value: 12, promoValidDays: 7 },
    window: (now) => upcoming(now, (y) => spanOf(y, [2, 7], [2, 15])),
  },
  {
    key: 'black_friday', group: 'Свята', emoji: '🖤', name: 'Чорна пʼятниця',
    why: 'Дата рухома (четверта пʼятниця листопада) — рахується сама.',
    type: 'holiday', suggest: { mode: 'percent', value: 25, promoValidDays: 5 },
    window: (now) => upcoming(now, (y) => around(blackFriday(y), 1, 3)),
  },

  // ── seasons ────────────────────────────────────────────────────────────
  {
    key: 'summer_sale', group: 'Сезони', emoji: '☀️', name: 'Літній розпродаж',
    why: 'Червень–серпень: розвантажити колекцію до осіннього завозу.',
    type: 'generic', suggest: { mode: 'percent', value: 20, promoValidDays: 30 },
    window: (now) => upcoming(now, (y) => spanOf(y, [6, 1], [8, 31])),
  },
  {
    key: 'winter_sale', group: 'Сезони', emoji: '❄️', name: 'Зимовий розпродаж',
    why: 'Грудень–лютий, найдовший сезон верхнього одягу.',
    type: 'generic', suggest: { mode: 'percent', value: 20, promoValidDays: 30 },
    window: (now) => upcoming(now, (y) => spanOf(y, [12, 1], [2, 28])),
  },
  {
    key: 'spring_sale', group: 'Сезони', emoji: '🌷', name: 'Весняне оновлення',
    why: 'Березень–травень, коли гардероб міняють на легший.',
    type: 'generic', suggest: { mode: 'percent', value: 15, promoValidDays: 30 },
    window: (now) => upcoming(now, (y) => spanOf(y, [3, 1], [5, 31])),
  },
  {
    key: 'autumn_sale', group: 'Сезони', emoji: '🍂', name: 'Осіння колекція',
    why: 'Вересень–листопад, під завіз нового сезону.',
    type: 'generic', suggest: { mode: 'percent', value: 15, promoValidDays: 30 },
    window: (now) => upcoming(now, (y) => spanOf(y, [9, 1], [11, 30])),
  },

  // ── who the client is, rather than what day it is ──────────────────────
  {
    key: 'first_order', group: 'Клієнти', emoji: '🌱', name: 'Перше замовлення',
    why: 'Тим, хто в клубі, але ще нічого не купив — найдорожчий крок у воронці.',
    type: 'generic', suggest: { mode: 'percent', value: 10, promoValidDays: 30 },
    audience: { firstOrder: true },
    window: (now) => ({ startsAt: now, endsAt: null }),
  },
  {
    key: 'birthday', group: 'Клієнти', emoji: '🎂', name: 'День народження',
    why: 'Персональна знижка тим, у кого ДН найближчими двома тижнями.',
    type: 'birthday', suggest: { mode: 'fixed', value: 50, minOrderUsd: 500, promoValidDays: 30 },
    audience: { birthdayWithinDays: 14 },
    window: (now) => ({ startsAt: now, endsAt: null }),
  },
  {
    key: 'repeat_buyer', group: 'Клієнти', emoji: '🔁', name: 'Постійний клієнт',
    why: 'Від трьох покупок — тим, кого варто утримати, а не залучити.',
    type: 'vip', suggest: { mode: 'percent', value: 10, promoValidDays: 60 },
    audience: { minPurchases: 3 },
    window: (now) => ({ startsAt: now, endsAt: null }),
  },
  {
    key: 'big_spender', group: 'Клієнти', emoji: '💎', name: 'VIP за сумою покупок',
    why: 'Від $5000 сукупно. Ця знижка окупається однією покупкою.',
    type: 'vip', suggest: { mode: 'percent', value: 15, promoValidDays: 90 },
    audience: { minSpentUsd: 5000 },
    window: (now) => ({ startsAt: now, endsAt: null }),
  },
  {
    key: 'winback', group: 'Клієнти', emoji: '👋', name: 'Повернути сплячих',
    why: 'Купував, але не за останні 90 днів. Тим, хто вже знає товар.',
    type: 'generic', suggest: { mode: 'percent', value: 15, promoValidDays: 21 },
    audience: { dormantDays: 90, minPurchases: 1 },
    window: (now) => ({ startsAt: now, endsAt: null }),
  },
  {
    key: 'newcomer', group: 'Клієнти', emoji: '🆕', name: 'Новачок клубу',
    why: 'У клубі не довше двох тижнів — поки цікавість ще свіжа.',
    type: 'generic', suggest: { mode: 'percent', value: 10, promoValidDays: 14 },
    audience: { joinedWithinDays: 14 },
    window: (now) => ({ startsAt: now, endsAt: null }),
  },
  {
    key: 'active_month', group: 'Клієнти', emoji: '🔥', name: 'Купував цього місяця',
    why: 'Ще тепла аудиторія — допродаж, поки замовлення в дорозі.',
    type: 'generic', suggest: { mode: 'percent', value: 10, promoValidDays: 14 },
    audience: { boughtWithinDays: 30 },
    window: (now) => ({ startsAt: now, endsAt: null }),
  },
  {
    key: 'two_this_month', group: 'Клієнти', emoji: '📈', name: 'Дві покупки за місяць',
    why: 'Приклад складнішої умови: період І кількість покупок у ньому.',
    type: 'vip', suggest: { mode: 'percent', value: 12, promoValidDays: 30 },
    audience: { boughtWithinDays: 30, minPurchasesInWindow: 2 },
    window: (now) => ({ startsAt: now, endsAt: null }),
  },

  // ── the empty one ──────────────────────────────────────────────────────
  {
    key: 'custom', group: 'Своя', emoji: '✍️', name: 'Своя акція',
    why: 'Порожня форма: дати й умови задаються з нуля.',
    type: 'generic', suggest: { mode: 'percent', value: 10, promoValidDays: 14 },
    window: (now) => ({ startsAt: now, endsAt: null }),
  },
];

const BY_KEY = new Map(PRESETS.map((p) => [p.key, p]));

/** The catalogue as the cabinet shows it: dates already resolved for the coming
 *  occurrence, so a preset card can print «20 груд — 8 січ» before it is picked. */
export function listPresets(now = Date.now()) {
  return PRESETS.map((p) => {
    const w = p.window(now);
    return {
      key: p.key,
      group: p.group,
      emoji: p.emoji,
      name: p.name,
      why: p.why,
      type: p.type,
      suggest: { minOrderUsd: 0, ...p.suggest },
      audience: p.audience || null,
      startsAt: w.startsAt == null ? null : iso(w.startsAt),
      endsAt: w.endsAt == null ? null : iso(w.endsAt),
    };
  });
}

/** One preset, expanded into exactly the shape campaigns.create() takes. */
export function expandPreset(key, now = Date.now(), overrides = {}) {
  const p = BY_KEY.get(key);
  if (!p) return null;
  const w = p.window(now);
  const suggest = { minOrderUsd: 0, ...p.suggest };
  return {
    name: p.name,
    type: p.type,
    preset: p.key,
    mode: suggest.mode,
    value: suggest.value,
    minOrderUsd: suggest.minOrderUsd,
    promoValidDays: suggest.promoValidDays,
    startsAt: w.startsAt == null ? null : iso(w.startsAt),
    endsAt: w.endsAt == null ? null : iso(w.endsAt),
    audience: p.audience ? { ...p.audience } : null,
    ...overrides,
  };
}

export const PRESET_KEYS = PRESETS.map((p) => p.key);
