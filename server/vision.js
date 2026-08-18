// ─────────────────────────────────────────────────────────────────────────
//  vision.js — the third and last place a brand can come from: the photograph.
//
//  THE LADDER (parsePostText holds the first two rungs):
//    1. the caption           — the seller's own word, and it wins outright.
//    2. the catalogue's name  — «Hermès» answers a caption that is only a size.
//    3. THIS FILE             — neither said anything, so read the logo.
//
//  Never an argument with rungs 1 and 2. The backfill selects on
//  `brand_source is null`, which is precisely the set the first two left
//  unanswered, and it writes a source of its own so the question is never asked
//  about that card again — including when the answer was "I cannot tell".
//  A wrong caption stays wrong here, deliberately: correcting the channel is the
//  seller's business, not the app's.
//
//  WHY IT DOES NOT RUN AT INGEST. A channel post arrives on the webhook, and
//  that handler does its work BEFORE acknowledging Telegram (see telegram.js) —
//  a model call and a photo download inside it would risk the invocation timing
//  out and the post being lost. So the queue is drained by the scheduler in
//  small batches, where being slow costs nothing.
//
//  WITHOUT A KEY THIS FILE DOES NOTHING. `configured()` is false, the backfill
//  returns `{ skipped: 'no GEMINI_API_KEY' }`, and the vitrine behaves exactly
//  as it does today. Adding the key is the whole activation. See docs/TODO.md.
// ─────────────────────────────────────────────────────────────────────────
import { db } from './db.js';
import { fetchPhoto, BRAND_NAMES } from './telegram.js';

const KEY = () => process.env.GEMINI_API_KEY || '';
// Flash: this is logo recognition, not reasoning, and there are ~1900 cards in
// the queue. The model is an env var because it is the thing most likely to be
// re-pointed later without touching code.
const MODEL = () => process.env.W2B_VISION_MODEL || 'gemini-2.0-flash';
const ENDPOINT = (model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

// How many cards one scheduler tick is allowed to buy. Small on purpose: the
// tick has a serverless time limit, and a queue that drains over a few hours
// costs the same as one that drains in ten minutes.
const BATCH = Number(process.env.W2B_VISION_BATCH || 8);
const TIMEOUT_MS = Number(process.env.W2B_VISION_TIMEOUT_MS || 20_000);

export const configured = () => Boolean(KEY());

const PROMPT = `You are looking at one product photograph from a fashion boutique.

Name the FASHION HOUSE whose product is shown. Decide from what is visible —
the logo, the monogram canvas, the hardware, the lock, the tag, an unmistakable
silhouette.

Answer with EXACTLY ONE LINE and nothing else:
- one name copied verbatim from this list, if you are confident:
${BRAND_NAMES.join(', ')}
- or the single word UNKNOWN.

Answer UNKNOWN when the photograph shows no house you can identify, when it is
not a product photograph at all, or when you are merely guessing. UNKNOWN is a
better answer than a plausible one: this label goes on a shop's price card.`;

/**
 * The house visible in one photograph, or null.
 *
 * Returns null both for "the model saw nothing" and for "the call failed" —
 * the caller distinguishes them by whether this threw. Anything outside
 * BRAND_NAMES is discarded rather than trusted: the model does occasionally
 * answer «Miu Miu (Prada Group)», and half a name in a filter chip is worse
 * than no chip.
 */
export async function brandFromPhoto(fileId, { fetch: fetchImpl = fetch } = {}) {
  if (!configured()) return null;
  const photo = await fetchPhoto(fileId);
  if (!photo?.buffer?.length) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let json;
  try {
    const res = await fetchImpl(`${ENDPOINT(MODEL())}?key=${KEY()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: PROMPT },
            { inline_data: { mime_type: photo.contentType || 'image/jpeg', data: photo.buffer.toString('base64') } },
          ],
        }],
        // Deterministic: the same photograph must not name two different houses
        // on two runs, and there is a single right answer to look for.
        generationConfig: { temperature: 0, maxOutputTokens: 16 },
      }),
    });
    if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
    json = await res.json();
  } finally {
    clearTimeout(timer);
  }

  const raw = String(json?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
  return normalise(raw);
}

/** The model's line → a name the vitrine already uses, or null. */
export function normalise(raw) {
  const answer = String(raw || '').trim().replace(/^["'`]+|["'`.]+$/g, '');
  if (!answer || /^unknown$/i.test(answer)) return null;
  const hit = BRAND_NAMES.find((name) => name.toLowerCase() === answer.toLowerCase());
  return hit || null;
}

/**
 * Works a batch off the queue.
 *
 * One card at a time rather than in parallel — the free Gemini tier is rate
 * limited per minute, and a burst of eight would spend the batch on 429s.
 *
 * Every outcome is recorded, including failure to identify: a photograph with no
 * legible logo must be paid for once, not on every tick forever. Only a call
 * that ERRORED leaves the row untouched, so a rate limit or an outage is retried
 * on the next tick instead of being mistaken for "nothing there".
 */
export async function backfillBrands({ limit = BATCH } = {}) {
  if (!configured()) return { skipped: 'no GEMINI_API_KEY', pending: await pendingCount() };

  const rows = await db.prepare(`
    SELECT id, photos_json FROM posts
     WHERE brand_source IS NULL AND status = 'published' AND photos_json IS NOT NULL
     ORDER BY created_at DESC LIMIT ?`).all(limit);

  const out = { looked: 0, named: 0, unknown: 0, failed: 0, brands: [] };
  for (const row of rows) {
    const photos = Array.isArray(row.photos_json) ? row.photos_json : [];
    // The first photo is the cover — the one the client sees on the card, so it
    // is the one the label has to agree with.
    const cover = photos[0];
    if (!cover) continue;
    out.looked += 1;
    try {
      const brand = await brandFromPhoto(cover);
      await db.prepare('UPDATE posts SET brand = COALESCE(?, brand), brand_source = ?, edited_at = now() WHERE id = ?')
        .run(brand, brand ? 'vision' : 'vision-none', row.id);
      if (brand) { out.named += 1; out.brands.push({ id: row.id, brand }); }
      else out.unknown += 1;
    } catch (e) {
      // Left for the next tick on purpose — see the note above.
      out.failed += 1;
      out.error = String(e.message || e).slice(0, 160);
    }
  }
  out.pending = await pendingCount();
  return out;
}

/** Cards still waiting on an answer — what the cabinet shows as the queue. */
export async function pendingCount() {
  const r = await db.prepare(`SELECT count(*) c FROM posts
     WHERE brand_source IS NULL AND status = 'published' AND photos_json IS NOT NULL`).get();
  return Number(r.c);
}
