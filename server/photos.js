// ─────────────────────────────────────────────────────────────────────────
//  photos.js — copies a catalogue photo into object storage, so the vitrine
//  keeps its pictures.
//
//  WHY THIS EXISTS. The importer reads a channel's public page and stores the
//  cdn.telesco.pe URLs it finds there. Those URLs are signed and Telegram
//  rotates the tokens: measured 18.08.2026, a link fetched seconds ago answers
//  200 and every link already in the database answers 404 — twenty out of twenty
//  in a random sample, 6349 of 6730 published cards. The shop was showing the 🛍️
//  placeholder for 94% of its stock and nothing looked broken, because there is
//  a fallback for a photo that fails to load.
//
//  So the bytes are ours now. tme.js said as much in its own header and left the
//  decision to a human; the decision was made.
//
//  THE COVER, AND ONLY THE COVER — by arithmetic, not by taste. There are 55848
//  photos across the catalogue, 8.3 to a card, averaging 156 KB: 8.7 GB against
//  a 1 GB plan. One photo per card is ~990 MB unresized and ~470 MB resized, and
//  the card in the vitrine shows exactly one. W2B_PHOTO_KEEP raises it when the
//  plan does.
//
//  RESIZING IS OPTIONAL ON PURPOSE. sharp is a native module and this server has
//  three dependencies; loading it is attempted and its absence is not an error.
//  The bulk import runs from a machine that has it, so the 6349 covers land
//  resized; production adds a handful of cards a day and stores them as they
//  come. Both are correct, one is merely smaller.
// ─────────────────────────────────────────────────────────────────────────

import { num } from './settings.js';

const BUCKET = process.env.W2B_PHOTO_BUCKET || 'photos';
// How many photos of a post are copied, how big a source file may be, and the
// size/quality of what is stored — all four are rows in `app_settings`
// («Параметри» → Фото), read per photo rather than at import, so a change
// applies to the next sync without a restart.
// 720px at q76 ≈ 77 KB, so the whole vitrine is ~0.46 GB against a 1 GB plan —
// half the budget, which leaves room for the shop to grow. The source is 800×800
// (Telegram's own preview cap), and a card is two-to-a-row on a 390px phone, so
// 720 is still more pixels than the vitrine can show; the product sheet is the
// only place a sharper eye might notice.


const projectUrl = () => {
  const explicit = process.env.SUPABASE_URL;
  if (explicit) return explicit.replace(/\/$/, '');
  const ref = process.env.SUPABASE_PROJECT_REF;
  return ref ? `https://${ref}.supabase.co` : '';
};
const serviceKey = () => process.env.SUPABASE_SERVICE_ROLE_KEY || '';

/** Storage is configured, so a photo copied in will still be there tomorrow. */
export const configured = () => Boolean(projectUrl() && serviceKey());

/** The permanent, public URL of a stored object. */
export const publicUrl = (key) =>
  `${projectUrl()}/storage/v1/object/public/${BUCKET}/${key}`;

/** True for a URL this module produced — i.e. one that will not expire. */
export const isStored = (ref) =>
  typeof ref === 'string' && ref.includes(`/storage/v1/object/public/${BUCKET}/`);

// One stable key per photo, so re-running the import overwrites rather than
// accumulating a second copy of every card.
export const keyFor = (channel, messageId, index = 0) =>
  `${String(channel).replace(/[^a-z0-9_-]/gi, '_')}/${messageId}-${index}.jpg`;

let sharpModule; // undefined = not tried yet, null = not available
async function shrink(buffer) {
  if (sharpModule === undefined) {
    try { sharpModule = (await import('sharp')).default; }
    catch { sharpModule = null; }
  }
  if (!sharpModule) return { buffer, contentType: 'image/jpeg', resized: false };
  try {
    const out = await sharpModule(buffer)
      .rotate()                                   // honour EXIF, or bags lie on their side
      .resize({ width: await num('photo.width'), withoutEnlargement: true })
      .jpeg({ quality: await num('photo.quality'), mozjpeg: true })
      .toBuffer();
    // A "smaller" image that came out bigger is not an improvement.
    return out.length < buffer.length
      ? { buffer: out, contentType: 'image/jpeg', resized: true }
      : { buffer, contentType: 'image/jpeg', resized: false };
  } catch {
    return { buffer, contentType: 'image/jpeg', resized: false };
  }
}

/** Uploads bytes under `key`, overwriting whatever was there. */
export async function put(key, buffer, contentType = 'image/jpeg', { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${projectUrl()}/storage/v1/object/${BUCKET}/${key}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${serviceKey()}`,
      apikey: serviceKey(),
      'content-type': contentType,
      'x-upsert': 'true',
    },
    body: buffer,
  });
  if (!res.ok) throw new Error(`storage ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return publicUrl(key);
}

export async function remove(keys, { fetchImpl = fetch } = {}) {
  const list = (Array.isArray(keys) ? keys : [keys]).filter(Boolean);
  if (!list.length || !configured()) return 0;
  const res = await fetchImpl(`${projectUrl()}/storage/v1/object/${BUCKET}`, {
    method: 'DELETE',
    headers: {
      authorization: `Bearer ${serviceKey()}`,
      apikey: serviceKey(),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ prefixes: list }),
  });
  return res.ok ? list.length : 0;
}

/**
 * Copies the cover of one post into storage and returns the photo list to save.
 *
 * NEVER THROWS, and that is deliberate: a sync that fails because a photo could
 * not be copied is worse than a sync that keeps the old expiring URL. The card
 * still arrives, with the same picture it would have had before this file
 * existed, and the next pass tries again.
 *
 * Already-stored URLs are left alone, so re-running the import is cheap.
 */
export async function persist(channel, messageId, photos, { fetchImpl = fetch, keep = null } = {}) {
  const list = Array.isArray(photos) ? [...photos] : [];
  if (!configured() || !list.length) return { photos: list, stored: 0, skipped: 'not configured' };
  if (keep == null) keep = await num('photo.keep');
  // Stored in megabytes because that is the unit a person types; compared in
  // bytes because that is what a response gives us.
  const maxBytes = (await num('photo.max_mb')) * 1024 * 1024;

  let stored = 0;
  for (let i = 0; i < Math.min(keep, list.length); i += 1) {
    const ref = list[i];
    // A file_id belongs to Telegram and never expires — leave it be. An already
    // stored URL is already permanent.
    if (!/^https?:/i.test(String(ref)) || isStored(ref)) continue;
    try {
      const res = await fetchImpl(ref);
      if (!res.ok) continue;                       // an expired link: nothing to copy
      const raw = Buffer.from(await res.arrayBuffer());
      if (!raw.length || raw.length > maxBytes) continue;
      const { buffer, contentType } = await shrink(raw);
      list[i] = await put(keyFor(channel, messageId, i), buffer, contentType, { fetchImpl });
      stored += 1;
    } catch {
      // Keep the original reference and move on — see the note above.
    }
  }
  return { photos: list, stored };
}
