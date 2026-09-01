// ─────────────────────────────────────────────────────────────────────────
//  deals.js — did the client who asked about an article actually buy it?
//
//  Maryna, 01.09.2026:
//    "Когда пользователь интересуется продуктом, он попадает в таблицу и имеет
//     статус в процессе покупки. После, если ничего не меняется, оповещение
//     присылаем админу, чтобы он помнил, что надо изменить статус данного
//     клиента … свайпаем вправо — купил, влево — не купил … а если админ
//     ошибся, через карандашик он должен легко поменять статус на нужный."
//
//  The whole feature is three things and no more:
//
//   1. SENDING AN INQUIRY OPENS A DEAL. The client presses «Відправити», the
//      message reaches Dasha and — silently — Maryna, and the same act files
//      the client under `in_progress`. There is no separate step anybody has to
//      remember, because a step somebody has to remember is a step that stops
//      happening in week three.
//
//   2. A DEAL LEFT ALONE ASKS FOR ITSELF. Every W2B_DEAL_REMIND_DAYS days the
//      staff get one message per open deal with a direct link to that card:
//      "this client has been in progress for 12 days — did they buy?" Doing
//      nothing is a valid answer; it stays open and asks again in five days.
//
//   3. ONE COLUMN DECIDES. `status` is the only thing written; in_progress /
//      bought / not_bought are generated from it in the database (schema.sql).
//      So "fix a mistake" is the same operation as "record the outcome", which
//      is why the pencil in the cabinet needs no special path.
//
//  IDEMPOTENCE, as everywhere else in this app: openDeal() inserts ON CONFLICT
//  DO NOTHING against a unique inquiry_id, and each reminder carries a dedupe
//  key built from the round number. A tick that runs twice, a retried send, two
//  processes racing — none of them can produce a second card or a second DM.
// ─────────────────────────────────────────────────────────────────────────
import { db } from './db.js';
import { notifyStaff } from './notify.js';
import { asJson } from './sql.js';

const DAY = 86400_000;
const iso = (ms) => new Date(ms).toISOString();

export const STATUSES = ['in_progress', 'bought', 'not_bought'];

// Ukrainian labels live here rather than in the client, so a DM and the cabinet
// never call the same state two different things.
export const STATUS_LABEL = {
  in_progress: 'В процесі',
  bought: 'Купив',
  not_bought: 'Не купив',
};

/**
 * The reminder rhythm. Maryna asked for "5 or 7 days depending on the setting",
 * so it is a setting — the same shape as abandoned.js: an environment variable
 * with a sane default, clamped so a typo cannot turn it into a per-minute
 * pager.
 */
export function config() {
  const days = Math.min(Math.max(Number(process.env.W2B_DEAL_REMIND_DAYS || 5), 1), 90);
  return {
    days,
    enabled: process.env.W2B_DEAL_REMIND_ENABLED !== '0',
    // A deal nobody ever decides must not nag forever. 0 means "never stop".
    maxReminders: Math.max(0, Number(process.env.W2B_DEAL_REMIND_MAX || 0)),
  };
}

// The link the reminder carries. A Mini App is opened from a URL, so this is
// PUBLIC_URL with one parameter the client reads on boot (app.js) — it lands on
// the «Покупки» tab with this very card highlighted. Without PUBLIC_URL there
// is nothing to link to and the message is still perfectly readable.
export function dealLink(id) {
  const base = String(process.env.PUBLIC_URL || '').replace(/\/+$/, '');
  return base ? `${base}/?w2b=deal-${id}` : null;
}

const articlesOf = (items) =>
  items.map((i) => i.article).filter(Boolean).join(', ') || null;

/**
 * Open the purchase card for an inquiry. Called from cart.sendInquiry.
 * Returns the deal id, existing or new — never throws for business reasons,
 * because failing to file a card must not fail the client's message.
 */
export async function openDeal({ customerId, inquiryId = null, items = [], now = Date.now() }) {
  const list = Array.isArray(items) ? items : [];
  const info = await db.prepare(
    `INSERT INTO deals (customer_id, inquiry_id, items_json, items_count, articles,
                        status, created_at, updated_at)
     VALUES (?,?,?,?,?, 'in_progress', ?, ?)
     ON CONFLICT (inquiry_id) DO NOTHING`
  ).run(customerId, inquiryId, JSON.stringify(list), list.length, articlesOf(list),
    iso(now), iso(now));

  if (info.changes) return Number(info.lastInsertRowid);
  // Lost the race (or a retry): the card already exists and is the right one.
  const existing = inquiryId
    ? await db.prepare('SELECT id FROM deals WHERE inquiry_id=?').get(inquiryId)
    : null;
  return existing ? Number(existing.id) : null;
}

// ── reads ─────────────────────────────────────────────────────────────────

function shape(r, now = Date.now()) {
  const created = new Date(r.created_at).getTime();
  return {
    id: Number(r.id),
    customerId: Number(r.customer_id),
    customerName: r.name || null,
    tgId: r.tg_user_id || null,
    phone: r.phone || null,
    inquiryId: r.inquiry_id == null ? null : Number(r.inquiry_id),
    // The client's own words, carried from the inquiry so the card is readable
    // without opening a second tab.
    message: r.message || null,
    items: asJson(r.items_json) || [],
    itemsCount: Number(r.items_count) || 0,
    articles: r.articles || null,
    status: r.status,
    // The three columns, as they are actually stored — the client renders tabs
    // from `status`, but anything reading the API sees Maryna's shape too.
    inProgress: Boolean(r.in_progress),
    bought: Boolean(r.bought),
    notBought: Boolean(r.not_bought),
    amountUsd: r.amount_usd == null ? null : Number(r.amount_usd),
    note: r.note || null,
    decidedBy: r.decided_by || null,
    decidedAt: r.decided_at || null,
    remindedAt: r.reminded_at || null,
    reminders: Number(r.reminders) || 0,
    createdAt: r.created_at,
    // The number the whole section exists for: how long this has been open.
    days: Number.isFinite(created) ? Math.floor((now - created) / DAY) : 0,
  };
}

const JOINED = `SELECT d.*, c.name, c.tg_user_id, c.phone, i.message
                  FROM deals d
                  JOIN customers c ON c.id = d.customer_id
             LEFT JOIN inquiries i ON i.id = d.inquiry_id`;

export async function listDeals({ status = null, limit = 100, now = Date.now() } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const rows = status && status !== 'all'
    ? await db.prepare(`${JOINED} WHERE d.status=? ORDER BY d.created_at DESC LIMIT ?`).all(status, lim)
    : await db.prepare(`${JOINED} ORDER BY d.created_at DESC LIMIT ?`).all(lim);
  return rows.map((r) => shape(r, now));
}

export async function getDeal(id, now = Date.now()) {
  const row = await db.prepare(`${JOINED} WHERE d.id=?`).get(Number(id));
  return row ? shape(row, now) : null;
}

/** The badge on each of the three tabs. */
export async function counts() {
  const rows = await db.prepare('SELECT status, COUNT(*) n FROM deals GROUP BY status').all();
  const out = { in_progress: 0, bought: 0, not_bought: 0, total: 0 };
  for (const r of rows) {
    out[r.status] = Number(r.n) || 0;
    out.total += Number(r.n) || 0;
  }
  return out;
}

// ── the one write ─────────────────────────────────────────────────────────

export class DealError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DealError';
    this.status = 400;
  }
}

/**
 * Move a deal — and un-move it. Marking «купив» and correcting a mis-tap are
 * the same call, deliberately: there is no "already decided" branch to get
 * wrong, so the pencil in the cabinet is the checkmark with a different label.
 *
 * `amountUsd` and `note` are optional and only ever set when passed, so
 * correcting a status does not silently erase the sum somebody typed.
 */
export async function setStatus(id, { status, by = null, amountUsd, note, now = Date.now() } = {}) {
  if (!STATUSES.includes(status)) {
    throw new DealError(`статус має бути один із: ${STATUSES.join(', ')}`);
  }
  const sets = ['status=?', 'updated_at=?'];
  const params = [status, iso(now)];

  // Going back to «в процесі» is a correction, so the decision is cleared with
  // it — a card that reads "in progress, decided by Dasha on the 4th" is a lie.
  if (status === 'in_progress') {
    sets.push('decided_by=NULL', 'decided_at=NULL');
  } else {
    sets.push('decided_by=?', 'decided_at=?');
    params.push(by ? String(by) : null, iso(now));
  }
  if (amountUsd !== undefined) {
    const v = amountUsd === null || amountUsd === '' ? null : Number(amountUsd);
    if (v !== null && (!Number.isFinite(v) || v < 0)) throw new DealError('сума має бути числом');
    sets.push('amount_usd=?');
    params.push(v);
  }
  if (note !== undefined) {
    sets.push('note=?');
    params.push(note === null || note === '' ? null : String(note).trim().slice(0, 500));
  }

  params.push(Number(id));
  const info = await db.prepare(`UPDATE deals SET ${sets.join(', ')} WHERE id=?`).run(...params);
  if (!info.changes) return null;
  return await getDeal(id, now);
}

// ── the nudge ─────────────────────────────────────────────────────────────

/** Deals that have been open, unanswered and unnudged for longer than the
 *  configured window. Rows only — sending is the caller's job, so this is
 *  readable from a test without a bot. */
export async function stale(now = Date.now(), cfg = config()) {
  const cutoff = iso(now - cfg.days * DAY);
  const rows = await db.prepare(
    `${JOINED}
      WHERE d.status = 'in_progress'
        AND COALESCE(d.reminded_at, d.created_at) <= ?
        ${cfg.maxReminders ? 'AND d.reminders < ?' : ''}
      ORDER BY d.created_at
      LIMIT 100`
  ).all(...(cfg.maxReminders ? [cutoff, cfg.maxReminders] : [cutoff]));
  return rows.map((r) => shape(r, now));
}

const plural = (n, forms) => {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
};

/**
 * The job. Idempotent and safe to run as often as anybody likes: the round
 * number goes into the dedupe key, so re-running a tick writes nothing and
 * sends nothing, while the NEXT window is a different key and does send.
 *
 * Both Maryna and Dasha are told — this is the one decision neither of them can
 * make on the other's behalf, since only the person who spoke to the client
 * knows how it ended.
 */
export async function remindStaleDeals(now = Date.now()) {
  const cfg = config();
  if (!cfg.enabled) return { skipped: true, reason: 'disabled' };

  const rows = await stale(now, cfg);
  let sent = 0;

  for (const d of rows) {
    const round = d.reminders + 1;
    const link = dealLink(d.id);
    const who = d.customerName || `#${d.customerId}`;
    const what = d.articles
      ? `арт. ${d.articles}`
      : `${d.itemsCount} ${plural(d.itemsCount, ['позиція', 'позиції', 'позицій'])}`;

    const title = `⏳ ${who} — ${d.days} ${plural(d.days, ['день', 'дні', 'днів'])} у процесі покупки`;
    const body =
      `Клієнт ${who} (${what}) досі має статус «${STATUS_LABEL.in_progress}».\n` +
      'Купив? Позначте «Купив». Не купив? Позначте «Не купив». ' +
      'Якщо ще не відомо — нічого не робіть, нагадаємо знову через ' +
      `${cfg.days} ${plural(cfg.days, ['день', 'дні', 'днів'])}.` +
      (link ? `\n\n${link}` : '') +
      (d.phone ? `\n📞 ${d.phone}` : '');
    const bodyHtml =
      `Клієнт <b>${escapeHtml(who)}</b> (${escapeHtml(what)}) досі має статус «${STATUS_LABEL.in_progress}».\n` +
      'Купив? Позначте «Купив». Не купив? Позначте «Не купив». ' +
      'Якщо ще не відомо — нічого не робіть, нагадаємо знову через ' +
      `${cfg.days} ${plural(cfg.days, ['день', 'дні', 'днів'])}.` +
      (link ? `\n\n<a href="${escapeHtml(link)}">Відкрити картку клієнта</a>` : '') +
      (d.phone ? `\n📞 ${escapeHtml(d.phone)}` : '');

    // WRITE FIRST, then send — same order as abandoned.js and for the same
    // reason: a send that happens before the record can be repeated, a record
    // that happens before the send cannot.
    const claimed = await db.prepare(
      'UPDATE deals SET reminders=?, reminded_at=? WHERE id=? AND reminders=?'
    ).run(round, iso(now), d.id, d.reminders);
    if (!claimed.changes) continue;

    // The keyboard button is what turns "a link in a message" into one tap that
    // opens the Mini App on this card. Only inside Telegram, only when the app
    // has a public URL.
    const extra = link
      ? { reply_markup: { inline_keyboard: [[{ text: '👤 Відкрити картку', web_app: { url: link } }]] } }
      : {};
    // Maryna and Dasha both: only the person who spoke to the client knows how
    // it ended, and we do not know which of them that was.
    await notifyStaff({
      kind: 'deal_stale', title, body, bodyHtml, extra,
      dedupeKey: `deal-remind:${d.id}:${round}`,
    });
    sent += 1;
  }

  return { candidates: rows.length, reminded: sent, days: cfg.days };
}

function escapeHtml(s = '') {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
