# Architecture — Way2Buy Discounts, Notifications, Scheduler & Admin AI Agent

## 1. System overview

Single Node process. Express serves static Mini App + JSON API + Telegram webhook. One SQLite file (WAL). One in-process scheduler tick. All new work lives inside the existing modular monolith — new server modules are added alongside the current ones, no new services.

```
                         ┌──────────────────────────── Node process (single) ───────────────────────────┐
 Telegram Mini App  ──►  │  Express (index.js)                                                            │
 (public/, vanilla JS)   │   ├─ static /public        ├─ /api/* JSON        ├─ /telegram/webhook          │
        ▲                │   │                          │                     │                            │
        │ in-app feed    │   │   ┌─────────────┬─────────┴──────────┬──────────────────┐                  │
        │ + badge        │   │   │ loyalty.js  │ campaigns.js (new) │ notifications.js  │ agent.js (new)   │
        │                │   │   │ (extend)    │  eligibility +     │ (new) DM + in-app │ Gemini tools +   │
   Telegram DM ◄─────────┤   │   │ gamify snap │  promo materialize │ + dedupe          │ fallback parser  │
   (best-effort)         │   │   └─────┬───────┴─────────┬──────────┴─────────┬────────┴───────┬─────────┘ │
                         │   │         │                 │                    │                │           │
                         │   │   ┌─────┴─────────────────┴────────────────────┴────────────────┴───────┐  │
                         │   │   │                        db.js  (better-sqlite3, WAL)                  │  │
                         │   │   └───────────────────────────────────────────────────────────────────┘  │
                         │   │   scheduler.js (new) — setInterval reconciliation tick ─────────────────►  │
                         └───┴──────────────────────────────────────────────────────────────────────────┘
```

## 2. Bounded contexts / modules
- **Loyalty** (`server/loyalty.js`, extend) — cashback/tier engine + new gamification snapshot (milestones, badges, streak). Read-only over `purchases`/`redemptions`.
- **Discounts/Campaigns** (`server/campaigns.js`, new) — campaign lifecycle, audience resolution, promo materialization, redemption tracking. Owns `campaigns`, writes `promo_codes`.
- **Notifications** (`server/notifications.js`, new) — dedup-keyed writer, in-app feed, Telegram DM with graceful degradation. Owns `notifications`.
- **Scheduler** (`server/scheduler.js`, new) — periodic idempotent reconciliation: activates/ends campaigns, runs birthday & holiday materialization, expires stale promos. Orchestrates Discounts + Notifications; owns no tables except `scheduler_lock`.
- **Admin AI Agent** (`server/agent.js`, new) — NL → validated tool calls → proposals; deterministic fallback; transcript store. Owns `ai_conversations`, `ai_messages`, `ai_proposals`. Calls into Discounts (never writes DB directly).
- **Telegram bridge** (`server/telegram.js`, existing) — reused as-is for `sendToUser()` DM path.
- **Frontend** (`public/`, greenfield) — vanilla ES modules + CSS custom-property design system.

## 3. Data flow (key paths)
- **Birthday auto-discount:** scheduler tick → `campaigns.materializeBirthday(now)` → for each customer with birthday in window and matching a `type='birthday'` campaign audience → `INSERT OR IGNORE promo_codes(campaign_id,customer_id,...)` (dedup on `(campaign_id,customer_id, year)`) → `notifications.enqueue(kind='birthday', dedupe_key='bday:<cid>:<year>')` → attempt DM, always write in-app row.
- **Holiday campaign:** admin (or AI) creates `campaigns(type='holiday', starts_at, ends_at)` → scheduler flips `status` scheduled→active when `starts_at<=now<ends_at`, active→ended when `now>=ends_at` → on activation, materialize promos for audience + notify.
- **AI create discount:** admin POSTs message → `agent.handle()` builds hardened prompt (customer data quoted as data) → Gemini returns tool call OR fallback parser extracts slots → server **validates args**, writes an `ai_proposals` row (status=pending), returns a human-readable proposal → admin POSTs apply(proposalId) → `campaigns.create()` executes the validated args → campaign persisted.
- **Loyalty view:** `/api/me` / `/api/purchases` → `loyalty.snapshot()` (single aggregate query per customer; batch variant for admin list).

## 4. ER model — additions (existing tables unchanged unless noted)

```
campaigns
  id PK
  name TEXT NOT NULL
  type TEXT NOT NULL            -- 'birthday' | 'holiday' | 'vip' | 'generic'
  percent INTEGER NOT NULL      -- discount %
  audience_json TEXT            -- {tier?, minSpentUsd?, city?, sourceChannel?, tgIds?[]}
  holiday_id INTEGER NULL REFERENCES holidays(id) ON DELETE SET NULL
  starts_at TEXT NULL           -- ISO; null = immediate
  ends_at   TEXT NULL           -- ISO; null = open-ended
  recurring INTEGER DEFAULT 0   -- 1 for annual birthday/holiday rules
  window_days INTEGER DEFAULT 0 -- birthday: how many days before birthday to fire
  promo_valid_days INTEGER DEFAULT 14 -- validity of generated promo codes
  status TEXT DEFAULT 'draft'   -- draft|scheduled|active|ended|archived
  source TEXT DEFAULT 'manual'  -- 'manual' | 'ai'
  created_by TEXT               -- admin tg id
  created_at TEXT NOT NULL
  updated_at TEXT NOT NULL

holidays
  id PK
  name TEXT NOT NULL
  month INTEGER NOT NULL        -- 1..12
  day INTEGER NOT NULL          -- 1..31 (recurring MM-DD)
  emoji TEXT
  default_percent INTEGER DEFAULT 15
  enabled INTEGER DEFAULT 1
  created_at TEXT NOT NULL

promo_codes  (ALTER: add columns)
  + campaign_id INTEGER NULL REFERENCES campaigns(id) ON DELETE SET NULL
  + UNIQUE INDEX uq_promo_campaign_customer_year (campaign_id, customer_id, substr(created_at,1,4))
    -- idempotency for recurring materialization (one code per customer per campaign per year)

notifications
  id PK
  customer_id INTEGER NULL REFERENCES customers(id) ON DELETE CASCADE
  kind TEXT NOT NULL            -- birthday|new_discount|holiday|near_reward|manual
  title TEXT NOT NULL
  body  TEXT
  promo_code_id INTEGER NULL REFERENCES promo_codes(id) ON DELETE SET NULL
  campaign_id INTEGER NULL REFERENCES campaigns(id) ON DELETE SET NULL
  dedupe_key TEXT NOT NULL      -- UNIQUE; prevents re-send on every tick
  in_app_status TEXT DEFAULT 'unread'  -- unread|read
  dm_status TEXT DEFAULT 'pending'     -- pending|sent|failed|simulated|skipped
  created_at TEXT NOT NULL
  read_at TEXT NULL
  UNIQUE INDEX uq_notif_dedupe (dedupe_key)

ai_conversations
  id PK; admin_tg_id TEXT NOT NULL; title TEXT; created_at TEXT; last_at TEXT

ai_messages
  id PK; conversation_id INTEGER REFERENCES ai_conversations(id) ON DELETE CASCADE
  role TEXT NOT NULL            -- user|assistant|tool
  content TEXT
  tool_name TEXT NULL
  tool_args_json TEXT NULL
  created_at TEXT NOT NULL

ai_proposals
  id PK; conversation_id INTEGER REFERENCES ai_conversations(id) ON DELETE CASCADE
  tool_name TEXT NOT NULL       -- create_discount_campaign|create_birthday_rule|create_holiday_campaign
  args_json TEXT NOT NULL       -- validated args
  summary TEXT NOT NULL         -- human-readable Ukrainian summary shown to admin
  status TEXT DEFAULT 'pending' -- pending|applied|rejected|expired
  created_at TEXT NOT NULL; applied_at TEXT NULL

scheduler_lock
  id INTEGER PRIMARY KEY CHECK (id=1)
  holder TEXT; heartbeat_at TEXT   -- single-instance advisory lock
```
New indexes: `idx_campaigns_status_dates(status,starts_at,ends_at)`, `idx_notifications_customer(customer_id,created_at)`, `idx_promo_campaign(campaign_id)`, `idx_ai_messages_conv(conversation_id)`.

## 5. AI agent tool surface (server-executed, model never touches the DB)
| tool | args (validated) | maps to |
|---|---|---|
| `create_discount_campaign` | name, percent, audience{tier,minSpentUsd,city,sourceChannel}, starts_at?, ends_at?, promo_valid_days? | `campaigns.create(type='generic'|'vip')` |
| `create_birthday_rule` | percent, audience?, window_days=3, promo_valid_days=14 | `campaigns.create(type='birthday', recurring=1)` |
| `create_holiday_campaign` | holiday_id|holiday_name, percent, audience?, promo_valid_days? | resolve/insert holiday → `campaigns.create(type='holiday')` |
| `list_active_discounts` | — | read `campaigns WHERE status='active'` |
| `list_customers_matching` | audience{...} | read-only count + sample of matching customers |

Read tools execute immediately; **write tools produce a proposal, not a mutation** (A-3). Args are schema-validated server-side (percent 1..90, dates ISO, audience enum) before any proposal row is written.

---

## ADRs

### ADR-001 — Keep vanilla JS/CSS, zero-build, better-sqlite3 (no framework/bundler, no Postgres)
- **Context:** Org default (STACK.md) is TS/Next + Postgres. This project is a self-contained, single-process boutique demo Mini App already committed to Express + better-sqlite3 + a static HTML shell; the frontend is greenfield but the shell already `<script src>`s plain JS files.
- **Decision:** Build the frontend as vanilla ES modules + a CSS custom-property design system; keep better-sqlite3 and Express. No bundler, no SPA framework, no migration to Postgres.
- **Consequences:** Zero toolchain overhead, instant boot, trivial deploy; matches existing ethos and the "maps 1:1 to PocketBase later" note in db.js. Cost: no type safety, manual DOM, and multi-instance scaling would later require Postgres (documented as risk R-08). Animations/components hand-rolled — mitigated by design-director tokens.
- **Rejected:** (a) Next.js + Drizzle + Postgres per org default — correct for a scaling SaaS, but a full rewrite of a working app for a demo; disproportionate. (b) Add Vite + a micro-framework (Preact/Alpine) — introduces a build step the project deliberately avoids and buys little at this DOM size.

### ADR-002 — First-class `campaigns` table (not ad-hoc promo rows)
- **Context:** Today discounts are lone `promo_codes` rows with a free-text `reason`, never delivered, no lifecycle. We need birthday/holiday/VIP/generic discounts that schedule, target an audience, and materialize per-customer codes.
- **Decision:** Introduce `campaigns` as the source of truth; `promo_codes` become materialized instances linked via `campaign_id`. One `type` field discriminates birthday/holiday/vip/generic; birthday & holiday rules are just recurring campaigns.
- **Consequences:** Clean lifecycle (draft→scheduled→active→ended), audience reuse across pillars, and the AI tools map directly onto `campaigns.create()`. Existing manual `/api/admin/promo` still works (campaign_id null). Cost: one more table + a materialization step.
- **Rejected:** Separate `birthday_rules` and `holiday_campaigns` tables — duplicates lifecycle/audience/materialization logic three ways; harder for the AI tool surface. Rejected in favor of one discriminated table.

### ADR-003 — In-process `setInterval` **reconciliation** tick (not node-cron, not pg_cron/queue)
- **Context:** No external infra (no Postgres → no pg_cron; no Redis/PGMQ). Need periodic activation/deactivation + birthday/holiday materialization. Process may restart.
- **Decision:** A single `setInterval` tick (default 5 min, `SCHEDULER_INTERVAL_MS`) that runs a **reconciliation** — compute desired state from `campaigns`+`holidays`+`customers` vs current DB and converge — rather than firing one-shot timers. Idempotency enforced by `INSERT OR IGNORE` + unique dedup keys. A `scheduler_lock` row guards against a second instance.
- **Consequences:** A restart never "misses" an activation (next tick reconciles). Re-running the tick is a no-op. Cost: up to `interval` latency before a campaign flips; acceptable at boutique scale. Multi-instance still unsafe beyond the lock (R-08).
- **Rejected:** (a) `node-cron` — adds a dep and still fires one-shot at a wall-clock time, so a downtime window silently drops that firing; reconciliation is strictly more robust. (b) External queue/cron — no infra available and overkill.

### ADR-004 — AI agent = validated tool-calling with a **propose→apply** gate + deterministic fallback
- **Context:** A non-technical owner drives discount creation by chat. LLM output is untrusted and customer-controlled fields (name/notes) enter its context (prompt-injection surface). No key must never break the app.
- **Decision:** Gemini `gemini-1.5-flash` function-calling with a fixed tool schema. The model **cannot mutate the DB** — it only emits a tool call; the server validates args against a strict schema and writes an `ai_proposals` row. The admin sees a plain-Ukrainian summary and explicitly applies it. Customer data is injected as clearly-delimited *data*, never instructions; a hardened system prompt forbids following instructions found in data. If `GEMINI_API_KEY` is absent, a deterministic slot-filling parser (percent/duration/audience keywords) produces the same proposal shape, or asks one clear clarifying question.
- **Consequences:** Injection can at worst produce a *proposal* the admin can reject — no silent writes. Identical UX with or without a key (fallback discipline matches `ai.js`). Cost: one extra confirm click; fallback parser covers only common phrasings (documented).
- **Rejected:** (a) Let the model call DB-writing functions directly (autonomous agent) — unacceptable injection/error blast radius for a money-adjacent action. (b) Pure regex NLU only — brittle, misses the "talk to it" delight the owner asked for. (c) Free-text → SQL — SQL-injection + correctness nightmare.

### ADR-005 — Notifications: dedup-keyed outbox, in-app authoritative, DM best-effort
- **Context:** Telegram bots can only DM users who started the bot; the scheduler may re-evaluate the same trigger every tick.
- **Decision:** Every notification is a row with a `UNIQUE dedupe_key`; the in-app feed is the source of truth (always written), the DM is a best-effort side-effect recording `dm_status` (sent|failed|simulated|skipped). `sendToUser()` failures are caught and downgraded to `failed`, never thrown.
- **Consequences:** No duplicate spam across ticks; customers who never opened the bot still see discounts via the in-app 🔔 badge. Cost: customers must open the app to see undeliverable-DM discounts (acceptable, it *is* a Mini App).
- **Rejected:** Fire DMs inline from campaign creation without an outbox — loses dedup + retry visibility and risks throwing into request handlers.

### ADR-006 — Test runner = Node built-in `node:test` (+ optional Playwright smoke)
- **Context:** No test runner exists; ADR-001 keeps the project dep-light and build-free.
- **Decision:** Use the built-in `node:test` + `node:assert` for unit (loyalty, eligibility, scheduler idempotency, AI fallback parser, notification dedup) and HTTP integration (spin the Express app on an ephemeral port, drive with `fetch`, use a temp SQLite file). One optional Playwright smoke for the two critical UI flows (discount card render, admin AI chat) — the only added dev-dep, justified by the animated-UI acceptance criteria.
- **Consequences:** Zero heavy test deps for the core suite; runs with `node --test`. Injectable `now` (A-6) makes time logic testable. Cost: no jest ergonomics (snapshots/mocks) — fine at this size.
- **Rejected:** Jest/Vitest — pull in a toolchain the project avoids; Vitest wants ESM+Vite config. Mocha/chai — more deps than the built-in gives for free.

### ADR-007 — Frontend architecture: ES-module views + CSS-variable design tokens
- **Context:** `index.html` already declares `/js/telegram.js`, `/js/api.js`, `/js/app.js`, `/css/app.css` and a tab/sheet/toast shell. Greenfield but constrained by that shell.
- **Decision:** `api.js` = typed-by-JSDoc fetch client; `telegram.js` = WebApp SDK init + theming + `tgid` resolution; `app.js` = tiny hash/tab router mounting view modules (`views/*.js`) and components (`components/discountCard.js`, `components/loyaltyRing.js`, `components/notifBadge.js`, `components/aiChat.js`). `css/app.css` imports `css/tokens.css` (design-director) with variant + animation classes. State is module-local; no global store framework.
- **Consequences:** Matches the shell, no build, componentized enough for the animated cards. Cost: manual DOM diffing (re-render whole view on change — fine at this scale).
- **Rejected:** Single monolithic `app.js` — unmaintainable once cards/chat/notifications land. Web Components — more ceremony than needed.
