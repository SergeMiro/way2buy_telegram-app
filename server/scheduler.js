// ─────────────────────────────────────────────────────────────────────────
//  scheduler.js — the in-process tick.
//
//  Six jobs, all idempotent (they reconcile state rather than fire once, so
//  a restart can never miss or double a notification):
//   1. birthday window opens today  → tell the client their discount is ready
//   2. sale older than a day with no cost entered → remind the admin
//   3. a purchase still «в процесі» after N days → ask the staff how it ended
//   4. campaign statuses            → activate/expire on schedule
//   5. a fitting room filled hours ago and never sent → one discount, once
//   6. cards whose brand nothing has named yet → read the logo off the photo
//
//  (6) is the only job that costs money per item, so it is also the only one
//  that works in a small batch and leaves the rest for the next tick. Without a
//  GEMINI_API_KEY it reports itself skipped and nothing else changes.
//
//  Not a real cron: a single Node process with setInterval, which is right for
//  a boutique with thousands of customers. On a serverless host (Vercel) there
//  is no long-lived process, so the same work is exposed as
//  POST /api/admin/tick for an external cron to call.
// ─────────────────────────────────────────────────────────────────────────
import { db } from './db.js';
import { birthdaysOpeningToday, birthdayStatus } from './birthday.js';
import { remindPendingCosts } from './profit.js';
import { notifyCustomer } from './notify.js';
import * as campaigns from './campaigns.js';
import { remindAbandoned } from './abandoned.js';
import { remindStaleDeals } from './deals.js';
import { backfillBrands } from './vision.js';

const MINUTE = 60000;
const INTERVAL_MS = Number(process.env.SCHEDULER_INTERVAL_MIN || 15) * MINUTE;

let timer = null;
let lastRun = null;

// Announce to clients whose birthday window opens today that they can claim.
// The claim itself still goes through birthday.js — this is only the nudge.
async function announceBirthdays(now) {
  const people = await birthdaysOpeningToday(now);
  const year = new Date(now).getUTCFullYear();
  let sent = 0;

  for (const customer of people) {
    const status = await birthdayStatus(customer, now);
    if (!status.enabled || status.claimedThisYear || status.state !== 'available') continue;
    const label = status.mode === 'percent' ? `${status.value}%` : `$${status.value}`;
    const min = status.minOrderUsd ? ` від замовлення $${status.minOrderUsd}` : '';
    const id = await notifyCustomer({
      customerId: customer.id,
      kind: 'birthday_available',
      title: 'З днем народження! 🎂',
      body: `Ваша знижка ${label}${min} чекає в застосунку — натисніть «Отримати знижку». Діє ${status.validDays} днів.`,
      dedupeKey: `bday-open:${customer.id}:${year}`,
    });
    if (id) sent += 1;
  }
  return { candidates: people.length, notified: sent };
}

export async function tick(now = Date.now()) {
  const result = { at: new Date(now).toISOString() };
  try {
    result.birthdays = await announceBirthdays(now);
  } catch (e) {
    result.birthdays = { error: String(e.message || e) };
  }
  try {
    result.costs = await remindPendingCosts(now);
  } catch (e) {
    result.costs = { error: String(e.message || e) };
  }
  try {
    result.abandoned = await remindAbandoned(now);
  } catch (e) {
    result.abandoned = { error: String(e.message || e) };
  }
  try {
    result.deals = await remindStaleDeals(now);
  } catch (e) {
    result.deals = { error: String(e.message || e) };
  }
  try {
    result.campaigns = campaigns.reconcileStatus ? await campaigns.reconcileStatus(now) : { skipped: true };
  } catch (e) {
    result.campaigns = { error: String(e.message || e) };
  }
  try {
    result.brands = await backfillBrands();
  } catch (e) {
    result.brands = { error: String(e.message || e) };
  }
  lastRun = result;
  await db.prepare(`INSERT INTO scheduler_lock (id, holder, heartbeat_at) VALUES (1, ?, ?)
              ON CONFLICT(id) DO UPDATE SET holder=excluded.holder, heartbeat_at=excluded.heartbeat_at`)
    .run(String(process.pid), result.at);
  return result;
}

export function start() {
  if (timer || process.env.VERCEL || process.env.W2B_DISABLE_SCHEDULER) return null;
  // A first pass shortly after boot, then on the interval. Deferred so it never
  // slows the server's startup path.
  setTimeout(async () => { try { await tick(); } catch { /* logged inside */ } }, 10_000).unref?.();
  timer = setInterval(async () => { try { await tick(); } catch { /* logged inside */ } }, INTERVAL_MS);
  timer.unref?.();
  return timer;
}

export function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

export const status = () => ({
  running: Boolean(timer),
  intervalMinutes: INTERVAL_MS / MINUTE,
  lastRun,
});
