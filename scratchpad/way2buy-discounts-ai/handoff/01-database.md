# 01 — Database schema additions + migration + seed extension

Agent: database-engineer · Step 1 · File touched: `server/db.js` (only)

## What changed

All changes are additive to the single-file better-sqlite3 data layer (`server/db.js`).
No existing table, column, index, or seed row was altered destructively.

### New tables (all `CREATE TABLE IF NOT EXISTS`, per architecture §4)
| Table | Purpose | Key FKs |
|---|---|---|
| `holidays` | Recurring MM-DD holiday calendar (admin-editable) | — |
| `campaigns` | First-class discount campaigns (source of truth, ADR-002) | `holiday_id → holidays(id) ON DELETE SET NULL` |
| `notifications` | Dedup-keyed outbox: in-app feed + best-effort DM (ADR-005) | `customer_id → customers ON DELETE CASCADE`, `promo_code_id → promo_codes ON DELETE SET NULL`, `campaign_id → campaigns ON DELETE SET NULL` |
| `ai_conversations` | Admin AI transcript header | — |
| `ai_messages` | Transcript turns | `conversation_id → ai_conversations ON DELETE CASCADE` |
| `ai_proposals` | Propose→apply gate rows (ADR-004) | `conversation_id → ai_conversations ON DELETE CASCADE` |
| `scheduler_lock` | Single-instance advisory lock (`CHECK (id = 1)`, ADR-003) | — |

`holidays` is created before `campaigns` because `campaigns.holiday_id` references it.

### Altered table
- `promo_codes` gains `campaign_id INTEGER NULL REFERENCES campaigns(id) ON DELETE SET NULL`.
  Added via a **guarded** `ALTER TABLE ... ADD COLUMN` — a `PRAGMA table_info(promo_codes)`
  check skips the ALTER when the column already exists, so re-running `migrate()` against an
  existing `way2buy.db` never throws "duplicate column name" (R-15). The column has no default,
  so its default is NULL — which is the only form of FK-bearing ADD COLUMN SQLite permits.

### Indexes created (exact names)
| Index | Table (cols) | Serves |
|---|---|---|
| `idx_campaigns_status_dates` | `campaigns(status, starts_at, ends_at)` | scheduler `reconcileStatus(now)` window scans |
| `idx_notifications_customer` | `notifications(customer_id, created_at)` | paginated per-customer feed, recency order |
| `idx_ai_messages_conv` | `ai_messages(conversation_id)` | transcript fetch by conversation |
| `uq_notif_dedupe` (UNIQUE) | `notifications(dedupe_key)` | idempotent notification writer (R-02/R-07) |
| `uq_promo_campaign_customer_year` (UNIQUE) | `promo_codes(campaign_id, customer_id, substr(created_at,1,4))` | one promo per customer per campaign per calendar year (R-02) — expression index on the YYYY of `created_at` |
| `idx_promo_campaign` | `promo_codes(campaign_id)` | join/filter materialized promos by campaign |

The two promo indexes are created **after** the guarded ALTER, since they depend on
`campaign_id` existing.

## Seed extension (`seed()`)
- **9 holidays** (≥8 required, A-1): Новий рік (01-01), Різдво старий стиль (01-07),
  День закоханих (02-14), 8 Березня (03-08), Великдень орієнтовно (04-20),
  День Незалежності України (08-24), Чорна пʼятниця (11-28), Кіберпонеділок (12-01),
  Різдво новий стиль (12-25). Each with emoji + `default_percent`, `enabled=1`.
- **Demo holiday campaign** `Літній SALE ☀️` — `type='holiday'`, `status='active'`,
  window `2026-07-17 .. 2026-07-31`, which brackets the file's fixed demo clock
  `now = 2026-07-21T09:00:00Z` (GA-4 demonstrable).
- **Recurring birthday rule** `День народження 🎂` — `type='birthday'`, `recurring=1`,
  `window_days=3`, `promo_valid_days=14`, `status='active'`, audience = all (null).
- **Катерина Сидоренко** (seed index 3) birthday = `1992-07-24` — MM-DD `07-24` equals
  today's real date `2026-07-24`, so the birthday flow is demonstrable at runtime (GA-2).
  It was already exactly `1992-07-24` in the seed array, so no change was needed there.
- `--reseed` force-delete list extended to clear all new tables in child→parent order
  (notifications, ai_messages, ai_proposals, ai_conversations, scheduler_lock, then the
  existing set, campaigns, holidays, customers) so `--reseed` recreates a clean dataset.

The fixed historical demo clock (`2026-07-21`) used elsewhere was **not** changed — only
Катерина's birthday MM-DD is aligned to today's real date, per the brief.

## Verification

> **BLOCKED in this session — see "Open questions".** `node`, `npm`, and `python3`
> invocations are all rejected by the execution-approval policy in this sandbox, and the
> repo has **no `node_modules`** (dependencies `better-sqlite3`/`express`/`dotenv` are not
> installed). I therefore could not produce the exit-0 runtime proof myself.

The schema was validated by static review against SQLite semantics:
- FK-bearing `ADD COLUMN` uses a NULL default → the only form SQLite allows. ✓
- Expression UNIQUE index `substr(created_at,1,4)` is supported (SQLite ≥ 3.9). ✓
- All FK target tables are created before their referrers. ✓
- Force-delete order respects `foreign_keys = ON`. ✓
- Prepared-statement named params match the seed row objects. ✓

**To confirm once execution is available**, run from the repo root:

```bash
npm install                        # deps are not yet installed
node server/db.js --reseed         # expect: "DB ready at .../way2buy.db", exit 0
node server/db.js                  # second run WITHOUT --reseed against the now-existing
                                   # db — proves the guarded ALTER is idempotent, exit 0
```

Then inspect the schema (inline node, no sqlite3 CLI present):

```bash
node -e "import('better-sqlite3').then(({default:D})=>{const db=new D('way2buy.db');
for(const t of ['campaigns','holidays','notifications','ai_conversations','ai_messages','ai_proposals','scheduler_lock'])
 console.log(t, db.prepare('PRAGMA table_info('+t+')').all().map(c=>c.name).join(','));
console.log('promo cols', db.prepare('PRAGMA table_info(promo_codes)').all().map(c=>c.name).join(','));
console.log('promo idx', db.prepare('PRAGMA index_list(promo_codes)').all().map(i=>i.name).join(','));
console.log('notif idx', db.prepare('PRAGMA index_list(notifications)').all().map(i=>i.name).join(','));
console.log('holidays', db.prepare('SELECT COUNT(*) c FROM holidays').get().c);
console.log('campaigns', db.prepare('SELECT type,status FROM campaigns').all());});"
```

Expected: `promo cols` includes `campaign_id`; `promo idx` includes
`uq_promo_campaign_customer_year` + `idx_promo_campaign`; `notif idx` includes
`uq_notif_dedupe`; `holidays` = 9; campaigns show one active `holiday` + one active `birthday`.

Constraint enforcement (AC-3) to assert in the Step 11 test suite: a second INSERT with the
same `(campaign_id, customer_id, YYYY)` or the same `dedupe_key` must raise
`SQLITE_CONSTRAINT_UNIQUE`.

## Deviations from architecture §4
None structural. Notes:
- The `year` component of `uq_promo_campaign_customer_year` is `substr(created_at,1,4)`
  exactly as specified — materialization code (Step 4) must set `created_at` to an ISO string
  starting `YYYY` for the per-year idempotency to bucket correctly.
- Demo holiday campaign `Літній SALE` has `holiday_id = NULL` (no July holiday in the seed
  calendar); it exists purely to satisfy the "active-today window" requirement. Fine — the
  FK is nullable by design.

## Open questions / notes for backend-engineer (Steps 3–7)
1. **Please run the verification block above** — I could not execute node in this session.
   If `npm install` fails (native `better-sqlite3` build), that is an environment issue to
   resolve before any backend step can run.
2. **Idempotency contract:** `materialize()` must use `INSERT OR IGNORE` and set an ISO
   `created_at` — the unique index dedups on `(campaign_id, customer_id, substr(created_at,1,4))`.
   A promo minted with `campaign_id = NULL` (manual `/api/admin/promo`) is **not** covered by
   that unique index (NULLs are distinct in SQLite), so manual promos are unaffected — intended.
3. **Notification dedupe:** enqueue must catch the UNIQUE violation on `dedupe_key` (or
   `INSERT OR IGNORE`) and treat "already exists" as success — do not send a second DM.
4. `scheduler_lock` starts empty; the scheduler must upsert the single `id=1` row.
5. `audience_json` is free TEXT here — enum/shape validation lives in `campaigns.resolveAudience()`
   (Step 4), not the DB.
