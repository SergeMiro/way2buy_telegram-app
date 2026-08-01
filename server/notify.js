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

const now = () => new Date().toISOString();

export const adminIds = () =>
  (process.env.ADMIN_TG_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);

// Returns the notification id when a NEW row was written, null when the
// dedupe key had already been used (i.e. nothing to deliver).
function writeRow({ customerId = null, kind, title, body = '', promoCodeId = null, campaignId = null, dedupeKey }) {
  const info = db.prepare(`INSERT OR IGNORE INTO notifications
    (customer_id,kind,title,body,promo_code_id,campaign_id,dedupe_key,in_app_status,dm_status,created_at)
    VALUES (?,?,?,?,?,?,?, 'unread','pending',?)`)
    .run(customerId, kind, title, body, promoCodeId, campaignId, dedupeKey, now());
  return info.changes > 0 ? Number(info.lastInsertRowid) : null;
}

function markDm(notificationId, status) {
  if (!notificationId) return;
  db.prepare('UPDATE notifications SET dm_status=? WHERE id=?').run(status, notificationId);
}

async function dm(tgUserId, text, notificationId) {
  if (!tgUserId) return markDm(notificationId, 'skipped');
  try {
    await sendToUser(tgUserId, text);
    markDm(notificationId, liveMode() ? 'sent' : 'simulated');
  } catch {
    // A DM failure must never fail the operation that triggered it — the
    // in-app notification is already stored and is what the client sees.
    markDm(notificationId, 'failed');
  }
}

// Notify one client. Synchronous for the DB row, fire-and-forget for the DM.
export function notifyCustomer({ customerId, kind, title, body = '', promoCodeId = null, campaignId = null, dedupeKey }) {
  const id = writeRow({ customerId, kind, title, body, promoCodeId, campaignId, dedupeKey });
  if (!id) return null;
  const c = db.prepare('SELECT tg_user_id FROM customers WHERE id=?').get(customerId);
  void dm(c?.tg_user_id, `<b>${escapeHtml(title)}</b>\n${escapeHtml(body)}`, id);
  return id;
}

// Notify the owner/admins. Stored with customer_id = NULL so it never shows in
// a client's feed; surfaced by /api/admin/alerts.
export function notifyAdmins({ kind, title, body = '', dedupeKey }) {
  const id = writeRow({ customerId: null, kind, title, body, dedupeKey });
  if (!id) return null;
  for (const tgId of adminIds()) {
    void dm(tgId, `<b>${escapeHtml(title)}</b>\n${escapeHtml(body)}`, id);
  }
  return id;
}

export function adminAlerts({ limit = 50 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 100);
  return db.prepare(
    `SELECT id, kind, title, body, in_app_status, created_at
       FROM notifications WHERE customer_id IS NULL
      ORDER BY created_at DESC LIMIT ?`
  ).all(lim);
}

function escapeHtml(s = '') {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
