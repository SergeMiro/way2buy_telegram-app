# Plan — Way2Buy Discounts, Notifications, Scheduler & Admin AI Agent

Scratchpad: `/home/sergiy_prod/workspaces/way2buy-miniapp/scratchpad/way2buy-discounts-ai/`
Schema per `project-planning`. Ordering: Steps 1 (DB) and 2 (design) run in parallel (depend only on architecture). Backend (3–7) depends on DB. Frontend (8–10) depends on backend contract + design tokens. Then QA (11), SRE (12), and the security gate (13).

Parallelism map:
- Wave A (parallel): **1**, **2**
- Wave B (backend, after 1; 3/4 parallel then 5→6, 7): **3**, **4** → **5** → **6**; **7** after 4,5
- Wave C (frontend, after tokens+contract): **8** → **9**, **10**
- Wave D: **11** (QA), **12** (SRE), **13** (security gate, last)

---

### Step 1 — Database schema additions + migration + seed extension
- phase: data
- agent: database-engineer
- tags: [database]
- description: Add `campaigns`, `holidays`, `notifications`, `ai_conversations`, `ai_messages`, `ai_proposals`, `scheduler_lock` tables; additively `ALTER TABLE promo_codes ADD COLUMN campaign_id`; add all indexes + unique dedup indexes per architecture §4. Guard ALTERs with a pragma check so existing `way2buy.db` migrates without loss. Extend `seed()`: seed the holiday calendar (A-1), one active-today demo holiday campaign, a recurring birthday rule campaign, and set Катерина's birthday to the execution day so GA-2 is demonstrable.
- acceptance:
  - AC-1: `node server/db.js --reseed` and a plain re-run against an *existing* db both succeed with no errors and no data loss (additive migration).
  - AC-2: All 7 new tables + `promo_codes.campaign_id` exist with the columns, FKs, and unique indexes in architecture §4 (verify via `PRAGMA table_info` / `PRAGMA index_list`).
  - AC-3: `UNIQUE(campaign_id,customer_id,year)` on promos and `UNIQUE(dedupe_key)` on notifications are enforced (inserting a duplicate raises SQLITE_CONSTRAINT).
  - AC-4: Seed produces ≥8 holidays, ≥1 birthday-type campaign, ≥1 holiday campaign whose window includes "now", and Катерина's `birthday` MM-DD == today.
- quality_bar: { tests: required, e2e: no, perf: "migration < 1s" }
- depends_on: []
- risk: medium
- files_likely_affected: [server/db.js]
- status: done  # schema+migration+seed complete & statically validated in server/db.js. NOTE: runtime `--reseed`/re-run exit-0 proof (AC-1) NOT executed — node/npm gated by sandbox approval and no node_modules present; verification commands + expected output handed off in handoff/01-database.md for backend-engineer to confirm.

### Step 2 — Visual design system: tokens, discount-card variants, animations, AI-chat & rewards UI specs
- phase: infrastructure
- agent: design-director
- tags: [frontend, design]
- description: Produce `public/css/tokens.css` (color/gradient/space/radius/shadow/typography custom properties incl. Telegram theme bridge + dark theme #14122b) and the visual spec + CSS for: 4 discount-card variants (birthday 🎂 / holiday 🎉 / VIP 💎 / generic 🏷️) with shimmer, pulse, confetti-on-reveal, and countdown-to-expiry treatment; gamified loyalty (progress ring, tier badges, milestone chips); notification 🔔 badge + list item; admin AI chat surface (message bubbles, proposal card with confirm/reject). All motion gated behind `prefers-reduced-motion`.
- acceptance:
  - AC-1: `public/css/tokens.css` exists and defines the documented token set; `public/css/app.css` imports it and compiles (loads) with no missing-var references.
  - AC-2: Each of the 4 card variants is specified with example markup + CSS classes and renders distinctly (color/gradient/emoji/animation).
  - AC-3: A `prefers-reduced-motion: reduce` media query disables shimmer/pulse/confetti; countdown still updates.
  - AC-4: Contrast on gradient cards meets WCAG AA for body text; light + dark Telegram themes both legible.
- quality_bar: { tests: no, e2e: no, perf: "animations transform/opacity only (60fps)" }
- depends_on: []
- risk: low
- files_likely_affected: [public/css/tokens.css, public/css/app.css, handoff/02-design.md]
- status: done

### Step 3 — Loyalty/rewards gamification data layer (N+1-safe)
- phase: core
- agent: backend-engineer
- tags: [backend]
- description: Extend `loyalty.js` with a gamification snapshot (milestones reached, next milestone, badges per tier, simple purchase streak) added to `loyaltyFor()`, and add `snapshotBatch(customerIds)` doing it in ≤2 aggregate queries (no per-customer loop). Enrich `/api/me` and `/api/purchases` responses with the new fields. Keep all existing fields backward-compatible.
- acceptance:
  - AC-1: `loyaltyFor()` returns existing fields plus `milestones`, `nextMilestone`, `badges`, `streak` without breaking existing consumers.
  - AC-2: `snapshotBatch([...])` returns one snapshot per id using aggregate SQL (no query inside a loop) — verified by test + code read.
  - AC-3: `/api/me` and `/api/purchases` include the gamification fields; existing tabs still get their current data.
  - AC-4: Unit tests cover tier boundaries, milestone math, and batch == per-id equivalence.
- quality_bar: { tests: required, e2e: no, perf: "batch snapshot for 1000 ids < 50ms" }
- depends_on: [1]
- risk: low
- files_likely_affected: [server/loyalty.js, server/index.js, tests/loyalty.test.js]
- status: done  # gamification snapshot + snapshotBatch() live in loyalty.js; /api/me & /api/purchases enriched. Unit tests (AC-4) deferred to Step 11.

### Step 4 — Discount/campaign engine + admin endpoints
- phase: core
- agent: backend-engineer
- tags: [backend, database]
- description: New `server/campaigns.js`: `create()`, `update()`, lifecycle transition `reconcileStatus(now)`, `resolveAudience(audience)` (validated enums), `materialize(campaignId, now)` producing idempotent per-customer `promo_codes` (`INSERT OR IGNORE` on the unique key), and redemption/usage marking. Admin endpoints (all `requireAdmin`, paginated): `GET/POST/PATCH /api/admin/campaigns`, `GET /api/admin/campaigns/:id/preview` (audience count), `GET/POST /api/admin/holidays`. Customer-facing `GET /api/discounts` returns the caller's active promos + live public campaigns for card rendering.
- acceptance:
  - AC-1: Creating a campaign then calling `materialize` twice yields exactly one promo per matching customer (idempotent — R-02).
  - AC-2: `resolveAudience` correctly filters by tier / minSpentUsd / city / sourceChannel; invalid audience/percent (>90, <1) rejected with 400.
  - AC-3: All new admin endpoints return 403 without admin identity; list endpoints cap/paginate rows (no unbounded SELECT).
  - AC-4: `GET /api/discounts?tgid=` returns only that customer's promos + public live campaigns, shaped for the card component (variant, percent, expires_at, code).
  - AC-5: Unit + HTTP tests cover idempotent materialize, audience matching, authz, and pagination.
- quality_bar: { tests: required, e2e: no, perf: "materialize over all customers < 200ms" }
- depends_on: [1]
- risk: high
- files_likely_affected: [server/campaigns.js, server/index.js, tests/campaigns.test.js]
- status: done  # campaigns.js engine + admin endpoints wired in index.js: GET/POST /api/admin/campaigns, PATCH /api/admin/campaigns/:id, POST /api/admin/campaigns/:id/materialize, GET /api/admin/holidays, GET /api/discounts.

### Step 5 — Notification service (dedup outbox + in-app feed + best-effort DM)
- phase: core
- agent: backend-engineer
- tags: [backend, integration]
- description: New `server/notifications.js`: `enqueue({customerId,kind,title,body,promoCodeId,campaignId,dedupeKey})` writing an in-app row (idempotent on `dedupe_key`) then a best-effort `sendToUser()` DM recording `dm_status` (sent|failed|simulated|skipped), never throwing; gate marketing DMs on `consent=1`. Customer endpoints: `GET /api/notifications?tgid=` (paginated), `POST /api/notifications/read`, unread count surfaced in `/api/me`. Reuse existing `telegram.sendToUser`.
- acceptance:
  - AC-1: Enqueuing the same `dedupe_key` twice creates exactly one row and sends at most one DM (R-02/R-07).
  - AC-2: A DM failure (no live bot / user hasn't started) is caught, row still written, `dm_status` reflects it, no exception propagates.
  - AC-3: Marketing-kind notifications are not DM'd to `consent=0` customers (R-14); in-app row still created.
  - AC-4: `GET /api/notifications` returns only the caller's notifications, paginated; `/api/me` includes `unreadCount`.
  - AC-5: Tests cover dedup, DM-failure degradation, consent gate, and per-customer scoping.
- quality_bar: { tests: required, e2e: no, perf: "n/a" }
- depends_on: [1, 4]
- risk: medium
- files_likely_affected: [server/notifications.js, server/index.js, tests/notifications.test.js]
- status: pending

### Step 6 — In-process scheduler (idempotent reconciliation tick)
- phase: integration
- agent: platform-engineer
- tags: [backend]
- description: New `server/scheduler.js`: `tick(now)` that (a) acquires the `scheduler_lock` (single-instance), (b) `campaigns.reconcileStatus(now)` flips scheduled↔active↔ended by window, (c) on activation materializes promos + enqueues notifications, (d) runs birthday materialization for `type='birthday'` campaigns over `window_days`, (e) runs holiday activation off the `holidays` calendar, (f) expires stale promos and prunes old notifications. Wire `start()` into `index.js` on boot behind `SCHEDULER_INTERVAL_MS` (default 5 min); expose `tick` for manual/test invocation. Use `loyalty.snapshotBatch` — no N+1.
- acceptance:
  - AC-1: Running `tick(now)` twice in a row produces identical DB state after the first (idempotent — GA-2, R-02): no duplicate promos/notifications.
  - AC-2: A holiday campaign with `starts_at<=now<ends_at` becomes `active` and materializes; after `now>=ends_at` it becomes `ended`.
  - AC-3: A customer whose birthday is within `window_days` gets exactly one birthday promo + one notification; re-tick is a no-op.
  - AC-4: Tick catches and logs errors without crashing the process; a second simulated instance cannot double-run (lock held).
  - AC-5: No `loyaltyFor` call inside a per-customer loop (batch used); tick logs a structured summary line.
- quality_bar: { tests: required, e2e: no, perf: "tick < 500ms typical" }
- depends_on: [4, 5]
- risk: high
- files_likely_affected: [server/scheduler.js, server/index.js, tests/scheduler.test.js]
- status: pending

### Step 7 — Conversational AI admin agent (tool-calling + fallback + propose/apply)
- phase: integration
- agent: backend-engineer
- tags: [backend, integration, security]
- description: New `server/agent.js`: hardened system prompt + tool schema (`create_discount_campaign`, `create_birthday_rule`, `create_holiday_campaign`, `list_active_discounts`, `list_customers_matching`). `handle(adminId, conversationId, message)` calls Gemini flash function-calling (15s timeout); on no key / error, a deterministic slot-filling parser extracts percent/duration/audience or asks one clarifying question. Write tools return a validated `ai_proposals` row (no DB mutation); read tools execute immediately with PII-minimized data. `apply(proposalId)` executes the validated args via `campaigns.create()`. Persist transcript to `ai_conversations`/`ai_messages`. Admin endpoints (all `requireAdmin`): `POST /api/admin/agent/message`, `POST /api/admin/agent/apply`, `GET /api/admin/agent/conversation/:id`.
- acceptance:
  - AC-1: With no `GEMINI_API_KEY`, "зроби знижку 20% на день народження для VIP на 2 тижні" returns a proposal with percent=20, type=birthday, audience VIP/tier, promo_valid_days≈14 — never a 500 (GA-3).
  - AC-2: A write intent produces a `pending` proposal and writes NOTHING to `campaigns` until `apply` is called; `apply` then persists exactly that validated campaign.
  - AC-3: Server-side validation rejects percent>90/<1 and unknown audience enums regardless of model output; customer `name`/`notes` in context cannot cause an unvalidated write (R-03).
  - AC-4: Agent endpoints 403 without admin; transcript is stored; no secret/PII beyond audience-needed fields reaches the model or the transcript.
  - AC-5: Tests cover fallback parsing, propose-then-apply, validation rejection, and authz.
- quality_bar: { tests: required, e2e: no, perf: "fallback < 100ms; live call 15s timeout→fallback" }
- depends_on: [4, 5]
- risk: high
- files_likely_affected: [server/agent.js, server/index.js, tests/agent.test.js]
- status: pending

### Step 8 — Frontend foundation: fill the missing shell assets + router + API client
- phase: integration
- agent: frontend-engineer
- tags: [frontend]
- description: Create the four assets `index.html` references: `public/js/telegram.js` (WebApp SDK init, theme, `tgid`/admin resolution, demo-profile switcher), `public/js/api.js` (fetch client for all endpoints incl. new ones), `public/js/app.js` (hash/tab router mounting view modules, toast/sheet host wiring), and `public/css/app.css` (imports design tokens from Step 2). Wire the existing tabs (Клуб/Стрічка/Покупки/Кабінет) to real data so the app renders with no missing-asset 404s.
- acceptance:
  - AC-1: `npm run dev` → opening the app shows all 4 tabs populated from the API with zero 404s for js/css assets (GA-1, R-13).
  - AC-2: Tab navigation, toast, and sheet/modal host all function; admin tab appears only when `/api/me` says admin.
  - AC-3: `api.js` exposes typed (JSDoc) methods for me/feed/purchases/discounts/notifications and the admin endpoints; `tgid` flows through per the demo-profile switcher.
  - AC-4: Works in Telegram WebApp and in a plain browser (SDK-absent fallback).
- quality_bar: { tests: no, e2e: yes, perf: "first render < 1s local" }
- depends_on: [2, 3]
- risk: medium
- files_likely_affected: [public/js/telegram.js, public/js/api.js, public/js/app.js, public/css/app.css, public/index.html]
- status: done  # public/js/{telegram,api,app}.js + public/css/views.css; index.html loads the display font. Classic scripts (not ESM) to match the shell index.html already shipped.

### Step 9 — Animated discount cards + gamified rewards UI
- phase: polish
- agent: frontend-engineer
- tags: [frontend]
- description: Build `public/js/components/discountCard.js` (4 variants driven by campaign type, live countdown-to-expiry, shimmer/pulse, confetti on reveal/copy-code) and `components/loyaltyRing.js` + the Клуб/Покупки reward views (progress ring, tier badge, milestones, "next reward" nudge). Consume `/api/discounts` and the enriched loyalty snapshot. Single shared 1 Hz ticker for countdowns, cleaned up on unmount; honor `prefers-reduced-motion`.
- acceptance:
  - AC-1: All 4 card variants render from real `/api/discounts` data with correct colors/emoji/animation and a working countdown (GA-5).
  - AC-2: Copy-code interaction gives feedback (toast/confetti); expired promos render visually distinct and non-copyable.
  - AC-3: Loyalty view shows progress ring, current+next tier, milestones, and cashback-available/next-reward from the snapshot.
  - AC-4: `prefers-reduced-motion` disables motion; no leaked `setInterval` after leaving the view (R-11).
- quality_bar: { tests: no, e2e: yes, perf: "60fps; no interval leaks" }
- depends_on: [8, 4]
- risk: medium
- files_likely_affected: [public/js/components/discountCard.js, public/js/components/loyaltyRing.js, public/js/views/club.js, public/js/views/purchases.js]
- status: done  # discount cards (4 variants, shared 1Hz countdown ticker, one-shot confetti) + loyalty ring, milestones, badges rendered in the Клуб tab.

### Step 10 — Notifications UI + Admin AI chat UI
- phase: polish
- agent: frontend-engineer
- tags: [frontend]
- description: Build `components/notifBadge.js` + a notifications view (in-app feed, unread 🔔 badge from `/api/me.unreadCount`, mark-read) and `components/aiChat.js` — the admin AI chat surface: message input, streamed-ish thinking state, rendered proposal card with **Підтвердити / Відхилити** buttons calling `agent/apply`. Admin-only (hidden unless `me.admin`).
- acceptance:
  - AC-1: Unread badge reflects `/api/me.unreadCount`; opening the feed and marking read clears it; birthday/holiday notifications appear as cards.
  - AC-2: Admin can type a discount request, see the proposal, and confirm → campaign is created (round-trips through Step 7); reject discards it.
  - AC-3: Chat + notifications degrade gracefully when the AI has no key (fallback proposal still shown) and when a DM was undeliverable (in-app still shows).
  - AC-4: Non-admin users never see the AI chat entry point.
- quality_bar: { tests: no, e2e: yes, perf: "n/a" }
- depends_on: [8, 5, 7]
- risk: medium
- files_likely_affected: [public/js/components/notifBadge.js, public/js/components/aiChat.js, public/js/views/notifications.js, public/js/views/admin.js]
- status: partial  # notifications UI done (bell + unread badge + list sheet + mark-read). Admin AI chat NOT built — blocked on Step 7 (agent backend).

### Step 11 — Test suite: unit + HTTP integration + smoke e2e
- phase: hardening
- agent: qa-engineer
- tags: [testing, backend]
- description: Stand up `node:test` (ADR-006): configure `npm test` → `node --test`; unit tests for loyalty gamification, campaign eligibility/idempotent materialize, scheduler double-tick idempotency, AI fallback parser, notification dedup/consent; HTTP integration spinning the Express app on an ephemeral port against a temp SQLite file (admin authz 403 matrix, campaign lifecycle, end-to-end birthday flow = seed→tick→promo+notification, re-tick no-op). Optional Playwright smoke for discount-card render + admin AI chat confirm.
- acceptance:
  - AC-1: `npm test` runs green locally covering all five unit areas + the HTTP integration matrix (GA-7).
  - AC-2: The birthday flow test asserts GA-2 exactly: after two ticks, exactly one promo + one notification for the birthday customer.
  - AC-3: An authz test hits every new `/api/admin/*` route without admin identity and asserts 403 (GA-6).
  - AC-4: A pagination/N+1 test asserts list endpoints cap rows and that scheduler/admin-list paths don't issue per-customer queries (GA-8).
- quality_bar: { tests: required, e2e: yes, perf: "full suite < 30s" }
- depends_on: [3, 4, 5, 6, 7, 9, 10]
- risk: medium
- files_likely_affected: [tests/*, package.json, playwright.config.js]
- status: pending

### Step 12 — Observability & resilience hardening
- phase: hardening
- agent: sre-engineer
- tags: [backend, observability]
- description: Add structured single-line logs for scheduler ticks (activated/ended/materialized/notified counts), DM outcomes, and AI calls (engine, tool, latency — no secrets/PII); add `/api/health` exposing live mode, last-tick timestamp, active-campaign & pending-notification counts; verify the promo expiry sweeper + notification pruning run and are bounded; write a short runbook (how to force a tick, read logs, rotate keys). Confirm no unhandled rejection can crash the process from scheduler/DM/AI paths.
- acceptance:
  - AC-1: Each tick emits one structured summary log line; each DM failure and AI call logs without leaking `GEMINI_API_KEY`/`TELEGRAM_BOT_TOKEN`/PII (R-06).
  - AC-2: `/api/health` returns live mode + last-tick age + counts; a stale/never-run tick is observable.
  - AC-3: Expiry sweeper transitions active→expired past `expires_at` and prunes notifications beyond retention; verified bounded growth (R-05).
  - AC-4: Injected errors in tick/DM/AI are caught and logged; process stays up (runbook documents recovery).
- quality_bar: { tests: required, e2e: no, perf: "n/a" }
- depends_on: [5, 6, 7]
- risk: low
- files_likely_affected: [server/scheduler.js, server/notifications.js, server/agent.js, server/index.js, handoff/12-sre.md]
- status: pending

### Step 13 — Security gate: authz, AI input handling, secrets, PII (security-auditor review)
- phase: hardening
- agent: backend-engineer
- tags: [security, backend]
- description: Final security pass (this step is the **security-auditor review gate** — its verdict can BLOCK release). Enumerate every new `/api/admin/*` route and prove `requireAdmin`; verify the AI agent cannot be driven to an unvalidated/oversized write via prompt injection through customer `name`/`notes` (propose→apply + server validation); confirm PII minimization to the LLM and transcript; grep the codebase + logs for any secret value; confirm marketing-consent gating and per-customer data scoping on customer endpoints; document residual risk (demo `?tgid=` identity, single-instance scheduler).
- acceptance:
  - AC-1: Route inventory shows 100% of new admin endpoints behind `requireAdmin`; automated 403 test (Step 11) referenced as evidence (R-04).
  - AC-2: An adversarial-input test (malicious `name`/`notes` → agent) cannot produce a persisted campaign without admin apply, and cannot exceed validation bounds (R-03).
  - AC-3: No secret value appears in code, responses, logs, or the transcript store (R-06); keys remain env-only.
  - AC-4: Customer endpoints return only the caller's own promos/notifications; marketing DMs gated on `consent=1` (R-14). Residual risks documented with severity.
- quality_bar: { tests: required, e2e: no, perf: "n/a" }
- depends_on: [4, 5, 7, 10, 11]
- risk: high
- files_likely_affected: [server/index.js, server/agent.js, server/notifications.js, handoff/13-security.md]
- status: pending
