// ─────────────────────────────────────────────────────────────────────────
//  media.js — one function that turns a stored photo reference into a URL the
//  browser can load.
//
//  A catalogue card can carry its photo in four different shapes, because it
//  can arrive by four different routes:
//
//    file_id            the bot received the post itself → served through
//                       /api/photo/:fileId, because the bot token must never
//                       reach the browser
//    https://cdn…       imported from the channel's public web preview
//                       (server/tme.js) → already a URL, pass it through
//    /uploads/…         imported from a Telegram Desktop export
//                       (scripts/import-history.mjs) → a static file
//    👜                 no photo at all: the emoji stand-in
//
//  Both the vitrine and the fitting room used to decide this for themselves,
//  and both decided it by string length — which was right for exactly the two
//  shapes that existed then and silently wrong for a URL.
// ─────────────────────────────────────────────────────────────────────────

/** True for the emoji stand-in — short, and not a path or URL. */
export function isEmojiRef(ref) {
  const s = String(ref ?? '');
  return s.length > 0 && s.length <= 8 && !/^(https?:\/\/|\/)/i.test(s);
}

/** @returns {string|null} a loadable URL, or null when there is no photo. */
export function mediaUrl(ref) {
  if (!ref) return null;
  const s = String(ref);
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('/')) return s;
  if (isEmojiRef(s)) return null;
  return `/api/photo/${encodeURIComponent(s)}`;
}
