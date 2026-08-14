// ─────────────────────────────────────────────────────────────────────────
//  auth.js — who the caller is, and whether Telegram will vouch for it.
//
//  Until now identity was a query parameter. `?tgid=387442030` was enough to be
//  Maryna: the client list with phones and delivery addresses, the profit
//  ledger, the discount rules. The number is not a secret — @userinfobot hands
//  anyone their own, and an admin's leaks the first time they forward a message
//  — so the cabinet was, in practice, open to anyone who thought to try it.
//
//  Telegram already signs the answer. Every Mini App launch carries `initData`:
//  a query string of the user, the chat, an `auth_date`, and an HMAC over all of
//  it keyed by a secret derived from the bot token. Only Telegram and the bot's
//  owner can produce that signature, so verifying it turns "the client says it
//  is user 387442030" into "Telegram says it is user 387442030".
//
//    secret    = HMAC_SHA256(key: "WebAppData", message: <bot token>)
//    signature = HMAC_SHA256(key: secret,       message: <data check string>)
//
//  The data check string is every field except `hash`, as `key=value`, sorted by
//  key, joined with '\n'. Values are the DECODED ones.
//
//  This module only answers "is this real, and whose is it". What the answer
//  gates — which routes demand a signature and which still accept the old
//  parameter — is decided in index.js, deliberately in one place.
// ─────────────────────────────────────────────────────────────────────────
import crypto from 'node:crypto';

// How old a launch may be. This is a REPLAY window, not a session length: a
// stolen initData string works until it expires. It is deliberately generous
// (30 days) because the alternative failure is the one thing worse than a wide
// window — logging out somebody who did nothing wrong, mid-order, because their
// Mini App had been sitting open. Set W2B_INITDATA_MAX_AGE_H=24 to tighten it,
// or 0 to accept any age.
export const DEFAULT_MAX_AGE_H = Number(process.env.W2B_INITDATA_MAX_AGE_H ?? 24 * 30);

const hmac = (key, msg) => crypto.createHmac('sha256', key).update(msg).digest();

// `aHex` is ours and always well-formed; `bHex` arrived from the network.
//
// The shape of `bHex` is checked BEFORE decoding, because Buffer.from(…,'hex')
// does not reject a bad string — it decodes as far as it can and silently drops
// the rest. So "…the correct hash…x" decodes to exactly the correct 32 bytes
// and would compare equal. That is not an exploitable forgery (you still have
// to know the real digest) but it means a malformed signature is ACCEPTED, and
// a signature check that accepts anything it does not understand is not one.
function equalHex(aHex, bHex) {
  if (typeof bHex !== 'string') return false;
  if (bHex.length !== aHex.length || !/^[0-9a-fA-F]+$/.test(bHex)) return false;
  const a = Buffer.from(aHex, 'hex');
  const b = Buffer.from(bHex, 'hex');
  // timingSafeEqual throws on a length mismatch, which would itself leak.
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

/**
 * Verify a Telegram Mini App `initData` string.
 *
 * @returns {{ok: true, id: string, user: object, authDate: number}}
 *        | {ok: false, reason: string}
 *
 * `reason` matters to the caller: 'absent' and 'no_token' mean "nothing was
 * claimed / nothing could be checked", which is a fallback; every other reason
 * means a signature was offered and did not hold, which is tampering.
 */
export function verifyInitData(initData, botToken, opts = {}) {
  const { now = Date.now(), maxAgeH = DEFAULT_MAX_AGE_H } = opts;

  if (!initData || typeof initData !== 'string') return { ok: false, reason: 'absent' };
  if (!botToken) return { ok: false, reason: 'no_token' };

  let params;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  const hash = params.get('hash');
  if (!hash) return { ok: false, reason: 'no_hash' };
  params.delete('hash');

  // `signature` is the newer Ed25519 field, meant for validating a launch
  // WITHOUT the bot token (third parties). Whether it belongs in the HMAC's
  // data check string has been read both ways by widely used clients, and
  // getting it wrong fails for exactly the users on the newest app version —
  // the least testable group there is. Both readings are the same signed
  // payload, and forging either still needs the bot token, so accept whichever
  // one holds instead of betting the login on the interpretation.
  const signature = params.get('signature');
  const build = (withSignature) => {
    const pairs = [];
    for (const [k, v] of params.entries()) {
      if (k === 'signature' && !withSignature) continue;
      pairs.push(`${k}=${v}`);
    }
    return pairs.sort().join('\n');
  };

  const secret = hmac('WebAppData', botToken);
  const candidates = signature ? [build(false), build(true)] : [build(false)];
  const signed = candidates.some((s) => equalHex(hmac(secret, s).toString('hex'), hash));
  if (!signed) return { ok: false, reason: 'bad_signature' };

  const authDate = Number(params.get('auth_date') || 0);
  if (!Number.isFinite(authDate) || authDate <= 0) return { ok: false, reason: 'no_auth_date' };
  const ageH = (now - authDate * 1000) / 3_600_000;
  // An hour of slack: a phone whose clock is a little fast is not an attacker,
  // but a launch dated next week is a forged auth_date.
  if (ageH < -1) return { ok: false, reason: 'future' };
  if (maxAgeH > 0 && ageH > maxAgeH) return { ok: false, reason: 'expired' };

  let user = null;
  try {
    user = JSON.parse(params.get('user') || 'null');
  } catch {
    return { ok: false, reason: 'bad_user' };
  }
  if (!user || user.id == null) return { ok: false, reason: 'no_user' };

  return { ok: true, id: String(user.id), user, authDate };
}

/** The header the Mini App sends it in. A header, not a query parameter, so it
 *  rides along on GET and POST alike and never lands in a server access log the
 *  way `?initData=…` would. */
export const INIT_DATA_HEADER = 'x-telegram-init-data';

/**
 * Resolve the caller of one request, once.
 *
 * Three outcomes, and the middle one is the point:
 *   verified   — Telegram signed it. Authoritative.
 *   tampered   — a signature was offered and did not hold. Refuse the request.
 *   unverified — nothing was offered; fall back to the legacy `tgid` parameter.
 *
 * The fallback exists so that a Mini App already open in somebody's hand, still
 * running the previous bundle, keeps working instead of erroring out mid-use.
 * It is what W2B_REQUIRE_SIGNED closes once the logs show no unsigned traffic
 * left; admin routes never rely on it (see index.js).
 */
export function identify(req, { botToken = process.env.TELEGRAM_BOT_TOKEN, now = Date.now() } = {}) {
  const raw =
    (req.get && req.get(INIT_DATA_HEADER)) ||
    (req.headers && req.headers[INIT_DATA_HEADER]) ||
    (req.query && req.query.initData) ||
    (req.body && req.body.initData) ||
    '';

  const legacy = String((req.query && req.query.tgid) || (req.body && req.body.tgid) || '').trim();

  if (!raw) return { id: legacy, verified: false, tampered: false, reason: 'absent' };

  const v = verifyInitData(raw, botToken, { now });
  if (v.ok) return { id: v.id, verified: true, tampered: false, user: v.user, reason: 'ok' };

  // Nothing to check WITH is a misconfiguration on our side, not a forgery on
  // theirs — it must not lock a user out of a shop that worked a minute ago.
  if (v.reason === 'no_token') return { id: legacy, verified: false, tampered: false, reason: v.reason };

  return { id: '', verified: false, tampered: true, reason: v.reason };
}
