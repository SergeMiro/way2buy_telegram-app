#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
//  One-off: copies the live SQLite database into the Postgres schema.
//
//  Runs over the Supabase Management API, so it needs no database password —
//  only the personal access token in ~/.config/w2b/supabase.env.
//
//  Values are converted per the *Postgres* column type, read from
//  information_schema rather than assumed: 0/1 becomes boolean, ISO text
//  becomes timestamptz, JSON text becomes jsonb. Ids are preserved and the
//  identity sequences are moved past them afterwards, so existing links
//  (notifications → promo_codes, cart_events → posts) survive intact.
//
//  Usage: node scripts/migrate-sqlite-to-postgres.mjs [--dry-run]
// ─────────────────────────────────────────────────────────────────────────
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DRY = process.argv.includes('--dry-run');
const SQLITE_PATH = process.env.W2B_SQLITE_PATH
  || join(process.cwd(), 'way2buy.db');

// ── credentials ───────────────────────────────────────────────────────────
const envFile = process.env.W2B_SUPABASE_ENV
  || join(homedir(), '.config', 'w2b', 'supabase.env');
const env = Object.fromEntries(
  readFileSync(envFile, 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);
const REF = env.SUPABASE_PROJECT_REF;
const TOKEN = env.SUPABASE_ACCESS_TOKEN;
if (!REF || !TOKEN) throw new Error(`missing credentials in ${envFile}`);

async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

// ── FK-safe order: a table only appears after everything it references ─────
const ORDER = [
  'channels', 'discount_rules', 'customers', 'holidays', 'campaigns', 'posts',
  'purchases', 'redemptions', 'promo_codes', 'birthday_claims', 'inquiries',
  'cart_items', 'cart_events', 'events', 'notifications',
  'ai_conversations', 'ai_messages', 'ai_proposals', 'scheduler_lock',
];

const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** Renders one SQLite value as a Postgres literal for a column of `type`. */
function literal(value, type) {
  if (value === null || value === undefined) return 'NULL';
  switch (type) {
    case 'boolean':
      // SQLite stored these as 0/1.
      return value ? 'true' : 'false';
    case 'integer':
    case 'bigint':
    case 'smallint':
    case 'numeric':
    case 'double precision':
    case 'real': {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error(`not a number for ${type}: ${value}`);
      return String(n);
    }
    case 'timestamp with time zone':
    case 'timestamp without time zone':
    case 'date':
      return `${quote(value)}::timestamptz`;
    case 'jsonb':
    case 'json':
      return `${quote(value)}::jsonb`;
    default:
      return quote(value);
  }
}

const db = new Database(SQLITE_PATH, { readonly: true });

const sqliteTables = new Set(
  db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
);

console.log(`источник: ${SQLITE_PATH}`);
console.log(`цель:     ${REF}${DRY ? '  (dry-run, ничего не пишем)' : ''}\n`);

const report = [];

for (const table of ORDER) {
  if (!sqliteTables.has(table)) {
    report.push({ table, sqlite: '—', inserted: 0, note: 'нет в SQLite' });
    continue;
  }

  // Column types from Postgres — the target decides how a value is rendered.
  const pgCols = await sql(
    `select column_name, data_type from information_schema.columns
      where table_schema='public' and table_name=${quote(table)}`
  );
  const pgType = new Map(pgCols.map((c) => [c.column_name, c.data_type]));

  const rows = db.prepare(`SELECT * FROM "${table}"`).all();
  if (rows.length === 0) {
    report.push({ table, sqlite: 0, inserted: 0, note: '' });
    continue;
  }

  // Only columns present in both schemas. A column dropped in the port (or one
  // SQLite gained and Postgres did not) is reported rather than silently lost.
  const sqliteCols = Object.keys(rows[0]);
  const cols = sqliteCols.filter((c) => pgType.has(c));
  const dropped = sqliteCols.filter((c) => !pgType.has(c));

  const values = rows.map((row) => {
    const cells = cols.map((c) => {
      try {
        return literal(row[c], pgType.get(c));
      } catch (e) {
        throw new Error(`${table}.${c} (id=${row.id}): ${e.message}`);
      }
    });
    return `(${cells.join(',')})`;
  });

  const statement =
    `INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(',')}) VALUES\n` +
    `${values.join(',\n')}\nON CONFLICT DO NOTHING`;

  if (DRY) {
    report.push({ table, sqlite: rows.length, inserted: 0, note: dropped.length ? `не переносятся: ${dropped.join(',')}` : '' });
    continue;
  }

  await sql(statement);

  // Move the identity sequence past the ids just inserted, or the first
  // application insert would collide with an existing row.
  if (pgType.has('id')) {
    await sql(
      `select setval(pg_get_serial_sequence('${table}','id'),
                     greatest(coalesce((select max(id) from ${table}), 1), 1))`
    );
  }

  const [{ c: actual }] = await sql(`select count(*) c from ${table}`);
  report.push({
    table,
    sqlite: rows.length,
    inserted: Number(actual),
    note: dropped.length ? `не переносятся: ${dropped.join(',')}` : '',
  });
}

console.log('таблица'.padEnd(18), 'SQLite'.padStart(7), 'Postgres'.padStart(9), '  примечание');
console.log('─'.repeat(60));
let mismatch = 0;
for (const r of report) {
  const ok = r.sqlite === '—' || r.sqlite === r.inserted;
  if (!ok) mismatch += 1;
  console.log(
    r.table.padEnd(18),
    String(r.sqlite).padStart(7),
    String(r.inserted).padStart(9),
    ` ${ok ? '✔' : '✘ РАСХОЖДЕНИЕ'} ${r.note}`
  );
}
console.log('─'.repeat(60));
console.log(mismatch === 0 ? 'все таблицы совпали' : `РАСХОЖДЕНИЙ: ${mismatch}`);
db.close();
process.exit(mismatch === 0 ? 0 : 1);
