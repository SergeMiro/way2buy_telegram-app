// ─────────────────────────────────────────────────────────────────────────
//  phone.js — one number, in a form somebody can dial.
//
//  The phone is the field that matters most on the join form: it is how Maryna
//  reaches a client when Telegram is not enough. It was stored exactly as typed,
//  and a device that autofills the national form ("07 54 38 67 68") wrote a
//  number nobody outside that country can call.
//
//  The country is NOT inferred. 0X XXXXXXXX is Ukraine and France both, and this
//  club has clients in Ukraine, France and the United States — so a guess here
//  does not produce a slightly-wrong number, it produces a stranger's. The join
//  form asks for the country code instead, and refuses politely without it.
//
//  Everyone already on file complied with that by hand: +380…, +1…. This only
//  makes the rule the form was already implying.
// ─────────────────────────────────────────────────────────────────────────

// E.164: a plus, then 7–15 digits. The upper bound is the standard's; the lower
// is generous, because national numbering plans are shorter than people expect
// and refusing a real number is worse than accepting an odd one.
const E164 = /^\+\d{7,15}$/;

/**
 * @returns {{ok: true, value: string|null}} — `value` is null for an empty
 *          input, because an absent phone is a different thing from a bad one
 *          and the column is nullable.
 *        | {ok: false, reason: 'no_country_code'|'malformed'}
 */
export function normalizePhone(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { ok: true, value: null };

  // Spaces, dashes, brackets and non-breaking spaces are how people write a
  // number, not part of it.
  const compact = s.replace(/[^\d+]/g, '');
  // 00 is the international prefix spelled the way a landline taught it.
  const e164 = compact.startsWith('00') ? `+${compact.slice(2)}` : compact;

  if (!e164.startsWith('+')) return { ok: false, reason: 'no_country_code' };
  if (!E164.test(e164)) return { ok: false, reason: 'malformed' };
  return { ok: true, value: e164 };
}

// What the client is told, in the language the form is written in. One sentence
// and an example: «неправильний формат» tells somebody who already believes
// their number is right precisely nothing.
export const PHONE_ERRORS = {
  no_country_code: 'Вкажіть номер з кодом країни, наприклад +380 67 123 45 67.',
  malformed: 'Перевірте номер: має бути код країни і 7–15 цифр, наприклад +380 67 123 45 67.',
};

/**
 * For display in a message somebody will tap to call.
 *
 * Rows written before the form required a country code are still out there, and
 * they are handed over as typed and MARKED, so whoever reads the inquiry asks
 * instead of dialling something that reaches the wrong country.
 */
export function formatPhone(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const parsed = normalizePhone(s);
  return parsed.ok && parsed.value ? parsed.value : `${s} (без коду країни)`;
}
