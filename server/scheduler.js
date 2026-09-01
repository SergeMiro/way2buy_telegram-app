// ─────────────────────────────────────────────────────────────────────────
//  scheduler.js — the in-process tick.
//
//  Three jobs, all idempotent (they reconcile state rather than fire once, so
//  a restart can never miss or double a notification):
//   1. birthday window opens today  → tell the client their discount is ready
//   2. sale older than a day with no cost entered → remind the admin
//   3. campaign statuses            → activate/expire on schedule
//   4. a fitting room filled hours ago and never sent → one discount, once
//   5. cards whose brand nothing has named yet → read the logo off the photo
//   6. a deal open for N days with nobody saying whether it closed → ask the
//      owners, with a button that opens that deal (deals.js)
//
//  (5) is the only job that costs money per item, so it is also the only one
//  that works in a small batch and leaves the rest for the next tick. Without a
//  GEMINI_API_KEY it reports itself skipped and nothing else changes.
//
//  Not a real cron: a single Node process on a chain of timeouts, which is right
//  for a boutique with thousands of customers — and re-reads its own interval
//  from «Параметри» after every pass. On a serverless host (Vercel) there
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
import { num } from './settings.js';

const MINUTE = 60000;

let timer = null;
let running = false;
let lastRun = null;
// The last interval actually armed. It exists so status() can report the truth
// without a database read on a status call; the value is refreshed every cycle.
let intervalMs = 15 * MINUTE;

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

// A chain of timeouts rather than one setInterval, and that is the whole reason
// the interval can be edited in «Параметри» and take effect: the delay is read
// again after every pass, so the change applies on the next cycle instead of at
// the next restart. A setInterval fixes its period the moment it is created.
async function currentIntervalMs() {
  intervalMs = Math.max(1, await num('scheduler.interval_min')) * MINUTE;
  return intervalMs;
}

function arm(delayMs) {
  timer = setTimeout(async () => {
    timer = null;
    if (!running) return;
    try { await tick(); } catch { /* logged inside */ }
    if (!running) return;                       // stopped while the pass ran
    arm(await currentIntervalMs());
  }, delayMs);
  timer.unref?.();
}

export function start() {
  if (running || process.env.VERCEL || process.env.W2B_DISABLE_SCHEDULER) return null;
  running = true;
  // A first pass shortly after boot, then on the configured interval. Deferred
  // so it never slows the server's startup path.
  arm(10_000);
  return timer;
}

/**
 * Re-arm right now, with whatever «Параметри» currently says.
 *
 * Without this a change would only take effect after the NEXT pass, which is
 * fine going from 15 minutes to 5 and absurd going from a day to 5 — you would
 * wait a day for the new interval to start. Called by the settings route when
 * that particular number is the one that changed.
 */
export async function reschedule() {
  if (!running) return { running: false };
  if (timer) clearTimeout(timer);
  arm(await currentIntervalMs());
  return { running: true, intervalMinutes: intervalMs / MINUTE };
}

export function stop() {
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
}

export const status = () => ({
  running,
  intervalMinutes: intervalMs / MINUTE,
  lastRun,
});
