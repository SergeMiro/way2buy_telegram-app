// ─────────────────────────────────────────────────────────────────────────
//  deals.js — did the client actually buy it?
//
//  A client fills the fitting room and presses «Відправити». The message goes
//  to Dasha, and silently to Maryna as well (cart.js) — and from that second the
//  inquiry is an open deal: somebody is in the middle of buying something. What
//  happened next used to live nowhere. Now it lives in one column on the
//  inquiry, `deal_status`, with exactly three values:
//
//     in_progress → bought       Maryna or Dasha confirmed the sale
//     in_progress → not_bought   it did not happen
//
//  Both are reversible. A wrong tap must be one tap to undo, so nothing here is
//  a one-way transition and no status is final — see setStatus().
//
//  THE NUDGE. A deal nobody touches would sit in «В процесі» for ever, because
//  the person who knows the answer is not looking at the panel — she is in a
//  Telegram chat. So every N days (`deal.followup_days` in «Параметри», 5 by
//  default) the open deal writes to its owners: this client has been in progress for so many
//  days, did they buy? The message carries a button that opens the cabinet on
//  that exact deal. Doing nothing is a valid answer — the deal stays open and
//  asks again in another N days.
//
//  RECORD BEFORE SENDING, and the record is the claim. `followup_last_at` is
//  moved by an UPDATE whose WHERE clause is the very condition that made the
//  deal due; a second tick (or a cron firing twice, or a retry after a timeout)
//  finds zero rows changed and sends nothing. The trade is deliberate and it is
//  the same one abandoned.js makes: if the DM fails after the claim, the nudge
//  is late by N days. A duplicate nudge, by contrast, teaches the owner to
//  ignore the channel these messages arrive on.
// ─────────────────────────────────────────────────────────────────────────
import { db } from './db.js';
import { notifyAdmins, adminIds } from './notify.js';
import { sendToUser } from './telegram.js';
import { supportIds } from './cart.js';
import { num } from './settings.js';

const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();

/** The three tabs of the cabinet, in the order they are shown. */
export const STATUSES = ['in_progress', 'bought', 'not_bought'];

export const LABELS = {
  in_progress: 'у процесі',
  bought: 'купив',
  not_bought: 'не купив',
};

// Async because the interval is a row in `app_settings` now, edited from
// «Параметри» — no redeploy, and no restart either: every sweep reads it again.
export async function config() {
  return {
    days: await num('deal.followup_days'),
    enabled: process.env.W2B_DEAL_FOLLOWUP_ENABLED !== '0',
  };
}

export class DealError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DealError';
    this.status = 400;
  }
}

// ── the three tabs ────────────────────────────────────────────────────────

/** { in_progress, bought, not_bought } — the numbers on the tabs. */
export async function counts() {
  const rows = await db.prepare(
    'SELECT deal_status, COUNT(*) AS n FROM inquiries GROUP BY deal_status'
  ).all();
  const out = { in_progress: 0, bought: 0, not_bought: 0 };
  for (const r of rows) {
    if (out[r.deal_status] !== undefined) out[r.deal_status] = Number(r.n) || 0;
  }
  return out;
}

/**
 * Move a deal, by hand, from the cabinet. Returns false when the id is unknown.
 *
 * Every change resets the follow-up clock, including a change back to
 * 'in_progress'. Without that, correcting a mistake on a three-week-old inquiry
 * would fire a reminder within the minute — the nudge would arrive as a
 * consequence of fixing the mistake, which reads as a malfunction.
 */
export async function setStatus(id, { status, by = null, now = Date.now() }) {
  if (!STATUSES.includes(status)) {
    throw new DealError(`статус має бути ${STATUSES.join(' | ')}`);
  }
  const at = iso(now);
  const info = await db.prepare(
    `UPDATE inquiries
        SET deal_status=?, deal_status_at=?, deal_status_by=?, followup_last_at=?
      WHERE id=?`
  ).run(status, at, by ? String(by) : null, at, Number(id));
  return info.changes > 0;
}

// ── the nudge ─────────────────────────────────────────────────────────────

/** Open deals whose next reminder is due. */
export async function pending(now = Date.now(), cfg = null) {
  const { days } = cfg || (await config());
  const cutoff = iso(now - days * DAY);
  return await db.prepare(
    `SELECT i.id, i.customer_id, i.items_count, i.created_at, i.followup_count,
            i.followup_last_at, c.name, c.phone
       FROM inquiries i
       JOIN customers c ON c.id = i.customer_id
      WHERE i.deal_status = 'in_progress'
        AND COALESCE(i.followup_last_at, i.created_at) <= ?
      ORDER BY i.created_at`
  ).all(cutoff);
}

/** Whole days between the inquiry and now — what the message counts out loud. */
export const daysOpen = (createdAt, now = Date.now()) =>
  Math.max(0, Math.floor((now - new Date(createdAt).getTime()) / DAY));

// The deep link. A `?deal=` query parameter and not a #fragment: Telegram
// appends its own fragment (tgWebAppData=…) when it opens a Mini App, and a
// fragment of ours would be competing for the same place in the URL. The query
// string is untouched by the client and works in a plain browser too.
export function dealUrl(id) {
  const base = String(process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (!base) return null;
  return `${base}${base.includes('?') ? '&' : '?'}deal=${id}`;
}

/**
 * The job, called from the scheduler tick. Idempotent — see the header.
 * Returns { candidates, reminded, skipped } (skipped = lost the claim race).
 */
export async function remindStaleDeals(now = Date.now()) {
  const cfg = await config();
  if (!cfg.enabled) return { skipped: true, reason: 'disabled' };

  const cutoff = iso(now - cfg.days * DAY);
  const rows = await pending(now, cfg);
  let reminded = 0;
  let lostRace = 0;

  for (const row of rows) {
    // THE CLAIM. Its WHERE is the same condition that selected the row, so two
    // ticks racing cannot both win it, and a tick that runs twice in a row
    // changes nothing the second time.
    const claim = await db.prepare(
      `UPDATE inquiries
          SET followup_last_at=?, followup_count = followup_count + 1
        WHERE id=?
          AND deal_status = 'in_progress'
          AND COALESCE(followup_last_at, created_at) <= ?`
    ).run(iso(now), row.id, cutoff);
    if (!claim.changes) { lostRace += 1; continue; }

    const n = (Number(row.followup_count) || 0) + 1;
    const d = daysOpen(row.created_at, now);
    const who = row.name || `Клієнт #${row.customer_id}`;
    const items = Number(row.items_count) || 0;

    const title = `🕔 ${who} у процесі покупки ${d} ${plural(d, ['день', 'дні', 'днів'])}`;
    const ask = `Купив? Відкрийте заявку і поставте ✓ (купив) або ✕ (не купив). ` +
                `Якщо ще не вирішилось — не робіть нічого, нагадаємо через ${cfg.days} ` +
                `${plural(cfg.days, ['день', 'дні', 'днів'])}.`;
    const body = `Заявка #${row.id} · ${items} ${plural(items, ['позиція', 'позиції', 'позицій'])}` +
                 (row.phone ? ` · 📞 ${row.phone}` : '') + `\n${ask}`;

    const url = dealUrl(row.id);
    const bodyHtml = escapeHtml(body);
    // A web_app button opens the cabinet on this one deal. Only in private
    // chats, which is where these DMs go, and only over https — so without a
    // PUBLIC_URL the message is still sent, just without the shortcut.
    const replyMarkup = url
      ? { inline_keyboard: [[{ text: '📋 Відкрити заявку', web_app: { url } }]] }
      : undefined;

    // Maryna (owners) through the alert feed, which also keeps the record;
    // Dasha by DM, exactly as the inquiry itself is delivered in cart.js.
    // dedupe_key carries the nudge number, so nudge #2 is not swallowed as a
    // repeat of #1 — and a re-run of the same nudge is.
    await notifyAdmins({
      kind: 'deal_followup',
      title,
      body,
      bodyHtml,
      replyMarkup,
      dedupeKey: `deal-followup:${row.id}:${n}`,
    });

    const alerted = await adminIds();
    for (const tgId of supportIds().filter((s) => !alerted.includes(s))) {
      try {
        await sendToUser(tgId, `<b>${escapeHtml(title)}</b>\n${bodyHtml}`,
          replyMarkup ? { reply_markup: replyMarkup } : {});
      } catch { /* a DM failure must not stop the sweep */ }
    }
    reminded += 1;
  }

  return { candidates: rows.length, reminded, skipped: lostRace, days: cfg.days };
}

function escapeHtml(s = '') {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function plural(n, forms) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}
