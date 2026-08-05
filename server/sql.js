// ─────────────────────────────────────────────────────────────────────────
//  sql.js — the bridge from better-sqlite3's statement API to Postgres.
//
//  The app was written against better-sqlite3: `?` placeholders, `@named`
//  parameters, and a statement object with .get() / .all() / .run(). Postgres
//  wants $1..$n and returns rows asynchronously. This module translates between
//  the two so that porting a call site means adding `await`, not rewriting the
//  query — which is why ~200 call sites survived the move unedited.
//
//  Kept separate from db.js so the translation is unit-testable on its own.
// ─────────────────────────────────────────────────────────────────────────

// Postgres type OIDs whose text form must come back as a JS number. `pg` and
// PGlite both hand these over as strings by default — numeric to keep decimal
// precision, int8 because it can exceed 2^53. Everything downstream treats them
// as numbers (`count > 0`, `sum + 1`, `.toFixed(2)`), so a string here surfaces
// far away as "1000" + 1 === "10001".
const NUMERIC_OID = 1700;
const INT8_OID = 20;

/**
 * Rewrites a better-sqlite3 statement into a Postgres one.
 *
 * Returns { text, names } where `names` has one entry per $n placeholder:
 * the parameter name for `@named` style, or null for a positional `?`.
 *
 * Literals, quoted identifiers, dollar-quoted blocks and comments are stepped
 * over rather than scanned, so a `?` inside a string ('Хочу цю позицію?') or an
 * `@` inside an email ('a@b.com') is left alone.
 */
export function compile(sql) {
  let text = '';
  const names = [];
  let i = 0;
  const n = sql.length;

  const isNameChar = (c) => c !== undefined && /[A-Za-z0-9_]/.test(c);

  while (i < n) {
    const ch = sql[i];

    // '...' string literal, '' being an escaped quote
    if (ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; }
        if (sql[j] === "'") { j += 1; break; }
        j += 1;
      }
      text += sql.slice(i, j);
      i = j;
      continue;
    }

    // "..." quoted identifier
    if (ch === '"') {
      let j = i + 1;
      while (j < n && sql[j] !== '"') j += 1;
      j = Math.min(j + 1, n);
      text += sql.slice(i, j);
      i = j;
      continue;
    }

    // $tag$ ... $tag$ dollar-quoted block (function bodies in schema.sql)
    if (ch === '$') {
      const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        const j = end === -1 ? n : end + tag.length;
        text += sql.slice(i, j);
        i = j;
        continue;
      }
    }

    // -- line comment
    if (ch === '-' && sql[i + 1] === '-') {
      let j = sql.indexOf('\n', i);
      if (j === -1) j = n;
      text += sql.slice(i, j);
      i = j;
      continue;
    }

    // /* block comment */
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      const j = end === -1 ? n : end + 2;
      text += sql.slice(i, j);
      i = j;
      continue;
    }

    if (ch === '?') {
      names.push(null);
      text += `$${names.length}`;
      i += 1;
      continue;
    }

    if (ch === '@' && isNameChar(sql[i + 1])) {
      let j = i + 1;
      while (j < n && isNameChar(sql[j])) j += 1;
      const name = sql.slice(i + 1, j);
      // Every occurrence gets its own placeholder, even when the same name
      // appears twice (@created_at fills two columns in the seed, and
      // @default_percent fills one integer column and one numeric one).
      //
      // Collapsing repeats into a single $n looks tidier and is what SQLite
      // effectively did, but Postgres then has to deduce ONE type for a
      // placeholder used in two differently-typed columns and fails with
      // "inconsistent types deduced for parameter". Since named values are
      // looked up by name, repeating the placeholder costs nothing.
      names.push(name);
      text += `$${names.length}`;
      i = j;
      continue;
    }

    text += ch;
    i += 1;
  }

  return { text, names };
}

/**
 * Maps call-site arguments onto the compiled placeholder list.
 *
 * Positional statements take spread arguments; named ones take a single object.
 * A missing key throws, exactly as better-sqlite3 did — that error caught typos
 * before, and silently binding null instead would turn a typo into corrupt data.
 */
export function bindArgs(names, args) {
  if (names.length === 0) return [];

  const named = names.some((x) => x !== null);
  if (!named) {
    return args.map((v) => (v === undefined ? null : v));
  }

  const source = args[0];
  if (source === null || typeof source !== 'object') {
    throw new TypeError('named parameters require a single object argument');
  }
  return names.map((name) => {
    if (name === null) {
      throw new TypeError('cannot mix ? and @named parameters in one statement');
    }
    if (!(name in source)) {
      throw new TypeError(`missing named parameter: @${name}`);
    }
    const v = source[name];
    return v === undefined ? null : v;
  });
}

const INSERT_HEAD = /^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*insert\b/i;
const HAS_RETURNING = /\breturning\b/i;

/**
 * better-sqlite3's run() reports lastInsertRowid for free; Postgres only tells
 * you if you ask. Every table in this schema has an `id`, so an INSERT that does
 * not already return something gets `RETURNING id` appended.
 *
 * This also keeps ON CONFLICT DO NOTHING behaving like INSERT OR IGNORE: a
 * conflict returns no row and rowCount 0, which is what `info.changes === 1`
 * checks at the call sites.
 */
export function withReturning(text) {
  if (!INSERT_HEAD.test(text) || HAS_RETURNING.test(text)) return text;
  return `${text.replace(/;\s*$/, '')} RETURNING id`;
}

/**
 * Converts numeric/int8 columns to JS numbers, driven by the result's field
 * metadata rather than by guessing from the value. Both drivers report
 * dataTypeID, so tests on PGlite and production on `pg` coerce identically.
 */
export function normalizeRows(rows, fields) {
  if (!rows || rows.length === 0) return rows || [];
  if (!fields || fields.length === 0) return rows;

  const toNumber = fields
    .filter((f) => f.dataTypeID === NUMERIC_OID || f.dataTypeID === INT8_OID)
    .map((f) => f.name);
  if (toNumber.length === 0) return rows;

  for (const row of rows) {
    for (const key of toNumber) {
      const v = row[key];
      if (typeof v === 'string' && v !== '') row[key] = Number(v);
    }
  }
  return rows;
}

/**
 * jsonb columns arrive already parsed — both drivers hand back an object or
 * array, not text. The old code called JSON.parse() on them, which throws on an
 * object ("[object Object]" is not JSON) and every one of those call sites had a
 * try/catch that returned null. The data would have gone missing silently, with
 * nothing in the log.
 *
 * Accepts both shapes so a text column that still holds JSON keeps working.
 */
export function asJson(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
