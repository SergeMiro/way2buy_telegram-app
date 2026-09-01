// ─────────────────────────────────────────────────────────────────────────
//  notify.js — one way to tell someone something.
//
//  The in-app notification row is the authoritative record (ADR-005); the
//  Telegram DM is best-effort on top of it, because a bot can only DM a user
//  who has started it. Every write goes through `dedupe_key`, so a scheduler
//  tick that runs twice never produces two messages.
// ─────────────────────────────────────────────────────────────────────────
import { db } from './db.js';
import { sendToUser, liveMode } from './telegram.js';
import { alertIds } from './roles.js';

const now = () => new Date().toISOString();

// Who gets an owner-level alert. This used to read ADMIN_TG_IDS directly; roles
// are data now (see roles.js), so appointing somebody is a tap in the cabinet
// rather than a deploy — and the environment variable survives underneath as the
// bootstrap that cannot lock the owner out.
export const adminIds = () => alertIds();

// Dasha and anyone else who answers clients but does not run the shop. She is
// not on the alert list (that one carries margins), so anything she has to act
// on is sent here as well. Lives beside adminIds because "who gets told" is one
// question with two answers, not two unrelated settings.
export const supportIds = () =>
  (process.env.SUPPORT_TG_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);

// Returns the notification id when a NEW row was written, null when the
// dedupe key had already been used (i.e. nothing to deliver).
async function writeRow({ customerId = null, kind, title, body = '', promoCodeId = null, campaignId = null, dedupeKey }) {
  const info = await db.prepare(`INSERT INTO notifications
    (customer_id,kind,title,body,promo_code_id,campaign_id,dedupe_key,in_app_status,dm_status,created_at)
    VALUES (?,?,?,?,?,?,?, 'unread','pending',?)
    ON CONFLICT (dedupe_key) DO NOTHING`)
    .run(customerId, kind, title, body, promoCodeId, campaignId, dedupeKey, now());
  return info.changes > 0 ? Number(info.lastInsertRowid) : null;
}

async function markDm(notificationId, status) {
  if (!notificationId) return;
  await db.prepare('UPDATE notifications SET dm_status=? WHERE id=?').run(status, notificationId);
}

async function dm(tgUserId, text, notificationId, extra = {}) {
  if (!tgUserId) return await markDm(notificationId, 'skipped');
  try {
    await sendToUser(tgUserId, text, extra);
    await markDm(notificationId, liveMode() ? 'sent' : 'simulated');
  } catch {
    // A DM failure must never fail the operation that triggered it — the
    // in-app notification is already stored and is what the client sees.
    await markDm(notificationId, 'failed');
  }
}

// Notify one client: the row is written and awaited, the DM is fire-and-forget.
export async function notifyCustomer({ customerId, kind, title, body = '', promoCodeId = null, campaignId = null, dedupeKey }) {
  const id = await writeRow({ customerId, kind, title, body, promoCodeId, campaignId, dedupeKey });
  if (!id) return null;
  const c = await db.prepare('SELECT tg_user_id FROM customers WHERE id=?').get(customerId);
  void dm(c?.tg_user_id, `<b>${escapeHtml(title)}</b>\n${escapeHtml(body)}`, id);
  return id;
}

// Notify the owner/admins. Stored with customer_id = NULL so it never shows in
// a client's feed; surfaced by /api/admin/alerts.
//
// `bodyHtml` is optional and exists for one reason: a Telegram DM can carry
// links and the admin panel cannot. The row keeps the plain `body` — it is
// rendered as text in the cabinet, where markup would show up as markup — while
// the DM gets the same message with its item titles turned into taps. The
// caller is responsible for escaping anything it interpolates into bodyHtml.
//
// `extra` is passed straight to Telegram's sendMessage — today that is the
// inline keyboard on a reminder, whose one button opens the Mini App on the
// exact card the message is about. It never touches the stored row: the cabinet
// is already looking at the thing the button would open.
export async function notifyAdmins({ kind, title, body = '', bodyHtml = null, dedupeKey, extra = {} }) {
  const id = await writeRow({ customerId: null, kind, title, body, dedupeKey });
  if (!id) return null;
  const text = `<b>${escapeHtml(title)}</b>\n${bodyHtml || escapeHtml(body)}`;
  for (const tgId of await adminIds()) {
    void dm(tgId, text, id, extra);
  }
  return id;
}

// The owners AND the manager. Two lists, one message, nobody told twice: an
// alert is written once (so `dedupe_key` still makes a re-run a no-op) and the
// support ids that are not already admins get the same text as a plain DM.
//
// Returns the notification id, or null when the dedupe key had already been
// used — in which case nothing was sent to anybody, which is the point.
export async function notifyStaff({ kind, title, body = '', bodyHtml = null, dedupeKey, extra = {} }) {
  const id = await notifyAdmins({ kind, title, body, bodyHtml, dedupeKey, extra });
  if (!id) return null;
  const alerted = await adminIds();
  const text = `<b>${escapeHtml(title)}</b>\n${bodyHtml || escapeHtml(body)}`;
  for (const tgId of supportIds().filter((x) => !alerted.includes(x))) {
    void dm(tgId, text, null, extra);
  }
  return id;
}

export async function adminAlerts({ limit = 50 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 100);
  return await db.prepare(
    `SELECT id, kind, title, body, in_app_status, created_at
       FROM notifications WHERE customer_id IS NULL
      ORDER BY created_at DESC LIMIT ?`
  ).all(lim);
}

function escapeHtml(s = '') {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
