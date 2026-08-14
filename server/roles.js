// ─────────────────────────────────────────────────────────────────────────
//  roles.js — who may do what in the cabinet.
//
//  There were two states before this: you were an admin or you were not, and
//  being one was an environment variable. That does not describe the shop.
//  Three people work here and they do different jobs:
//
//    super  — the owner. Sets prices, discounts, campaigns and who else gets in.
//             Sergiy and Maryna.
//    admin  — the manager. Answers clients, records sales, fixes catalogue
//             cards, syncs channels. Dasha.
//    client — everybody else. Never sees the cabinet and never learns that a
//             super admin exists at all (see cart.js: the inquiry reaches the
//             owner silently, and nothing the client can read says so).
//
//  THE RULE BEHIND THE MATRIX: a manager may do anything that answers a client
//  or keeps the catalogue true, and nothing that decides what things cost or who
//  works here. Money-in (record a sale) is the manager's job; money-out (what we
//  paid, what we keep, what we give away) is the owner's.
//
//  Permissions are checked in ONE place — requirePermission() in index.js — and
//  named after the thing being done, not the route doing it. A capability that
//  is not listed for a role does not exist for that role; there is no "admin can
//  do everything except…" fallthrough, because that is the shape that leaks.
// ─────────────────────────────────────────────────────────────────────────
import { db } from './db.js';

export const ROLES = ['super', 'admin'];

// Every capability in the cabinet, and who holds it. Read this table as the
// specification — the code below only looks things up in it.
export const PERMISSIONS = {
  // ── the manager's day ──────────────────────────────────────────────────
  'inquiries.read':    ['super', 'admin'],
  'inquiries.write':   ['super', 'admin'],   // mark answered / closed
  'customers.read':    ['super', 'admin'],   // names, phones, addresses
  'customers.write':   ['super', 'admin'],   // fix a birthday on file
  'catalog.read':      ['super', 'admin'],
  'catalog.write':     ['super', 'admin'],   // correct brand / category / title
  'channels.read':     ['super', 'admin'],
  'channels.sync':     ['super', 'admin'],   // re-read a channel
  'posts.publish':     ['super', 'admin'],   // publish an item to the channel
  'purchases.write':   ['super', 'admin'],   // record a sale, enter its cost
  'popular.read':      ['super', 'admin'],   // what clients are asking for
  'reports.read':      ['super', 'admin'],

  // ── the owner's ────────────────────────────────────────────────────────
  // The owner's alert feed. It mixes client inquiries with «this sale still has
  // no cost entered», so it carries margin information and cannot be the
  // manager's copy of the inquiries list — she has her own, which is the same
  // events without the money.
  'alerts.read':       ['super'],
  // Cost price and margin: what the shop keeps. A sales manager needs the
  // price, not the markup.
  'profit.read':       ['super'],
  // Rules, holidays, campaigns, promo codes — everything that decides what a
  // client pays. This is the line the brief drew and it is drawn here.
  'discounts.manage':  ['super'],
  // Adding a catalogue or choosing which channel is the feed changes the shop
  // itself, not its contents.
  'channels.manage':   ['super'],
  // Who works here.
  'team.manage':       ['super'],
  // App-wide settings for clients, admins and super admins alike.
  'settings.manage':   ['super'],
};

export const CAPABILITIES = Object.keys(PERMISSIONS);

/** Bootstrap supers from the environment. Anyone named here outranks the table,
 *  so emptying or breaking `admins` can never lock the owner out of the shop. */
export const bootstrapSuperIds = () =>
  (process.env.ADMIN_TG_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);

let cache = null;
let cacheAt = 0;
// Serverless functions are short-lived and this is read on nearly every admin
// request; a few seconds of staleness is invisible to a person clicking, and it
// keeps a permission check from being a database round trip every time.
const TTL_MS = 5000;

export function invalidate() {
  cache = null;
  cacheAt = 0;
}

async function load(now = Date.now()) {
  if (cache && now - cacheAt < TTL_MS) return cache;
  let rows = [];
  try {
    rows = await db.prepare(
      'SELECT tg_user_id, name, role, enabled FROM admins WHERE enabled ORDER BY id'
    ).all();
  } catch {
    // A database that predates the table must not take the cabinet down; the
    // env bootstrap below still answers.
    rows = [];
  }
  const map = new Map();
  for (const r of rows) map.set(String(r.tg_user_id), { role: r.role, name: r.name || null });
  for (const id of bootstrapSuperIds()) map.set(String(id), { role: 'super', name: map.get(String(id))?.name || null });
  cache = map;
  cacheAt = now;
  return map;
}

/** 'super' | 'admin' | null. A null id is a client, not a lookup. */
export async function roleOf(tgId) {
  const id = String(tgId || '').trim();
  if (!id) return null;
  return (await load()).get(id)?.role || null;
}

export async function can(tgId, capability) {
  const allowed = PERMISSIONS[capability];
  // An unknown capability is a programming mistake, and the safe reading of a
  // mistake in an authorisation check is "no".
  if (!allowed) return false;
  const role = await roleOf(tgId);
  return Boolean(role) && allowed.includes(role);
}

/** Everything one role may do — the client uses this to draw only the sections
 *  that person can actually open, so nothing appears and then refuses. */
export function capabilitiesOf(role) {
  if (!ROLES.includes(role)) return [];
  return CAPABILITIES.filter((c) => PERMISSIONS[c].includes(role));
}

// ── the team ───────────────────────────────────────────────────────────────

export async function listTeam() {
  let rows = [];
  try {
    rows = await db.prepare('SELECT * FROM admins ORDER BY role, id').all();
  } catch {
    rows = [];
  }
  const boot = new Set(bootstrapSuperIds().map(String));
  const seen = new Set(rows.map((r) => String(r.tg_user_id)));
  const shaped = rows.map((r) => ({
    id: r.id,
    tgId: String(r.tg_user_id),
    name: r.name || null,
    role: r.role,
    enabled: Boolean(r.enabled),
    note: r.note || null,
    // A bootstrap super cannot be demoted or switched off from the cabinet —
    // the environment would out-vote the change on the next request, and a
    // control that silently does nothing is worse than no control.
    locked: boot.has(String(r.tg_user_id)),
  }));
  // Somebody named only in the environment still works here and must be visible.
  for (const id of boot) {
    if (!seen.has(id)) {
      shaped.push({ id: null, tgId: id, name: null, role: 'super', enabled: true, note: 'з налаштувань сервера', locked: true });
    }
  }
  return shaped;
}

export class RoleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RoleError';
    this.status = 400;
  }
}

const validId = (v) => {
  const s = String(v == null ? '' : v).trim();
  if (!/^\d{4,20}$/.test(s)) throw new RoleError('Telegram id — це число (дізнатись можна через @userinfobot)');
  return s;
};

export async function addMember({ tgId, name = null, role = 'admin', note = null, by = null }) {
  const id = validId(tgId);
  if (!ROLES.includes(role)) throw new RoleError(`роль має бути ${ROLES.join(' або ')}`);
  await db.prepare(
    `INSERT INTO admins (tg_user_id,name,role,enabled,note,created_at,created_by)
     VALUES (?,?,?,true,?,?,?)
     ON CONFLICT (tg_user_id) DO UPDATE SET role=excluded.role, name=excluded.name,
       note=excluded.note, enabled=true`
  ).run(id, name ? String(name).trim() : null, role, note, new Date().toISOString(), by ? String(by) : null);
  invalidate();
  return await listTeam();
}

export async function setMember({ tgId, role, enabled, name, by = null }) {
  const id = validId(tgId);
  if (bootstrapSuperIds().map(String).includes(id) && (role === 'admin' || enabled === false)) {
    throw new RoleError('цього супер-адміна задано в налаштуваннях сервера — змінити можна лише там');
  }
  const sets = [];
  const params = [];
  if (role !== undefined) {
    if (!ROLES.includes(role)) throw new RoleError(`роль має бути ${ROLES.join(' або ')}`);
    sets.push('role=?'); params.push(role);
  }
  if (enabled !== undefined) { sets.push('enabled=?'); params.push(Boolean(enabled)); }
  if (name !== undefined) { sets.push('name=?'); params.push(name ? String(name).trim() : null); }
  if (!sets.length) return await listTeam();

  // The shop must never end up with nobody who can set a price. Checked against
  // what the change WOULD leave, not against what is there now.
  if (role === 'admin' || enabled === false) {
    const supers = (await listTeam()).filter((m) => m.role === 'super' && m.enabled);
    if (supers.length <= 1 && supers.some((m) => m.tgId === id)) {
      throw new RoleError('це останній супер-адмін — спершу призначте іншого');
    }
  }

  params.push(id);
  await db.prepare(`UPDATE admins SET ${sets.join(', ')} WHERE tg_user_id=?`).run(...params);
  invalidate();
  void by;
  return await listTeam();
}

export async function removeMember(tgId) {
  const id = validId(tgId);
  if (bootstrapSuperIds().map(String).includes(id)) {
    throw new RoleError('цього супер-адміна задано в налаштуваннях сервера — прибрати можна лише там');
  }
  const supers = (await listTeam()).filter((m) => m.role === 'super' && m.enabled);
  if (supers.length <= 1 && supers.some((m) => m.tgId === id)) {
    throw new RoleError('це останній супер-адмін — спершу призначте іншого');
  }
  // Disabled, not deleted: `created_by` on other rows and the audit of who did
  // what stay readable, and re-hiring is one toggle.
  await db.prepare('UPDATE admins SET enabled=false WHERE tg_user_id=?').run(id);
  invalidate();
  return await listTeam();
}

/** Who receives an owner-level alert — supers only, and that is deliberate.
 *  These messages carry cost prices, margins and "this sale has no cost entered
 *  yet"; the manager gets the client-facing half of the same events through the
 *  support path in cart.js, which is a different message on purpose. */
export async function alertIds() {
  const map = await load();
  return [...map.entries()].filter(([, v]) => v.role === 'super').map(([id]) => id);
}
