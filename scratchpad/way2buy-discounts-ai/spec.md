# Spec — Way2Buy Mini App: Modern Rewards, Discounts, Notifications, Holiday Scheduler & Admin AI Agent

## Problem
Way2Buy is a boutique reselling club running two Telegram channels (Ukraine 🇺🇦 / Luxury 💎) with a Telegram Mini App. The backend (Express + better-sqlite3) already implements a working cashback/tier engine, a two-way Telegram↔app post bridge, and an AI *reports* scaffold. But: (a) **the entire frontend is missing** — `public/index.html` references `/js/*.js` and `/css/app.css` that do not exist; (b) discounts are limited to manually-minted promo codes that are never delivered to the customer; (c) there is no birthday automation, no holiday campaign scheduling, no notification system, and no way for the (non-technical) owner to create discounts without an engineer.

The owner (Maryna) wants to run the club by *talking to it*: describe a discount in plain Ukrainian and have it created, scheduled, and delivered, with beautiful animated discount cards the customers actually want to open.

## Goals / Scope (the 6 pillars)
1. **Modernized loyalty/rewards UX** on top of the existing `loyaltyFor()` engine — gamified progress ring, tier badges, milestones, "next reward" nudge. Mostly a data-shape + UI layer; backend gap = milestone/badge/streak fields and an N+1-safe batch snapshot.
2. **Discount system** — first-class *campaigns* (birthday / holiday / VIP / generic), auto birthday eligibility off `customers.birthday`, promo-code materialization from campaigns, redemption tracking. Extends the existing `promo_codes` table.
3. **Notification system** — detect triggers (birthday window, new discount live, holiday campaign live, near-reward nudge) and deliver via **Telegram DM + in-app notification feed/badge**, with graceful degradation when a DM is undeliverable (bot can only DM users who started it).
4. **Holiday/occasion scheduler** — an admin-editable holiday calendar (Ukraine-focused + a few global) that auto-activates/deactivates campaigns on schedule via an **in-process reconciliation tick** (no external cron/queue infra available).
5. **Conversational AI admin agent** — admin describes a discount in natural language; a Gemini tool-calling agent (with a deterministic fallback when no key) creates campaigns / birthday rules / holiday campaigns via a small, validated tool surface. Transcript is stored. Admin-only.
6. **Beautiful animated discount cards** — a new UI surface with gradient/holiday-themed variants, shimmer/pulse/confetti micro-animations, and countdown-to-expiry.

## Out of scope (explicit)
- Real Telegram `initData` HMAC validation (kept as `?tgid=` demo stand-in; shape is forward-compatible — do **not** block on it).
- Real payment / checkout / order fulfilment. Promo codes are display + redemption-tracking artifacts, not payment coupons.
- Email / SMS / push notification channels. **Telegram DM + in-app only.**
- Long-term AI memory / multi-session agent reasoning beyond the stored transcript; RAG; multiple LLM providers. Single provider (Gemini) with deterministic fallback.
- Multi-instance / horizontal scaling of the scheduler (single-process assumption — see Assumptions & risks.md R-08).
- Migrating off SQLite / introducing a build step or SPA framework (see ADR-001).
- i18n framework — UI copy is Ukrainian (matching the existing app), no locale switching.
- Admin-facing analytics dashboards beyond the existing AI report.

## Assumptions (defaults chosen autonomously — no human gate this run)
- **A-1 Holiday scope:** seed calendar = Ukraine-focused + a few global: Новий рік (01-01), Різдво (12-25 & 01-07), 8 березня, Великдень (approx/manual), День Незалежності (08-24), Чорна пʼятниця (last Fri Nov), День закоханих (02-14), Кіберпонеділок. Admin-editable; recurring by month/day.
- **A-2 Notification channels:** Telegram DM (best-effort) + in-app feed/badge only.
- **A-3 AI agent shape:** admin-only, single logical turn per request (stateless reasoning), backed by a stored transcript. Uses a **propose → confirm/apply** gate: the agent returns a structured proposal; nothing is written to the DB until the admin explicitly applies it (prevents accidental/injected writes). Gemini `gemini-1.5-flash` function-calling; deterministic slot-filling parser fallback when `GEMINI_API_KEY` is absent — never a hard failure (mirrors `ai.js` discipline).
- **A-4 Scheduler:** in-process `setInterval` **reconciliation tick** (default every 5 min, env-configurable), idempotent, guarded by a single-instance advisory lock row. Not a real cron/queue. Reconciliation (not fire-once) so a restart cannot miss activations.
- **A-5 Scale:** boutique — dozens to low-thousands of customers, single Node process, single SQLite file. Design for that, do not over-engineer.
- **A-6 Clock:** existing modules use a *fixed demo clock* (`2026-07-21`) in report/seed code. New scheduler & eligibility logic use the **real system clock** (`Date.now()`), but every time-dependent function must accept an injectable `now` for testability. Seed marks Катерина's birthday as today at execution time per the demo brief.
- **A-7 Stack:** stay zero-build, zero-framework vanilla JS/CSS + better-sqlite3 + Express (ADR-001). Test runner = Node built-in `node:test` (ADR-006).
- **A-8 Identity:** unchanged — `?tgid=` + `ADMIN_TG_IDS` allowlist / open DEMO mode. All new admin endpoints reuse the existing `requireAdmin` guard.
- **A-9 Currency:** discounts are percent-based (matches `promo_codes.percent`); no fixed-amount coupons in this iteration.

## Global acceptance criteria
- **GA-1** `npm run dev` boots with no missing-asset 404s; the Mini App renders all tabs (Клуб / Стрічка / Покупки / Кабінет) with real data from the existing API.
- **GA-2** A birthday customer (Катерина, birthday = execution day) automatically receives a birthday discount campaign promo + a notification (in-app always; DM if deliverable) without any manual admin action, produced by the scheduler tick — and running the tick again does **not** create a duplicate promo or notification.
- **GA-3** Admin can create a discount by chatting: e.g. "зроби знижку 20% на день народження для VIP клієнтів на 2 тижні" produces a proposal that, on confirm, creates a persisted campaign; with no `GEMINI_API_KEY` the deterministic fallback still extracts percent/audience/duration or asks a clear clarifying question — never crashes.
- **GA-4** A holiday campaign scheduled for a past/other date is inactive; one whose window includes "now" is active and its cards render in-app; deactivation happens automatically after `ends_at`.
- **GA-5** Animated discount cards render 4 variants (birthday/holiday/vip/generic) with countdown-to-expiry and micro-animations; they degrade gracefully with `prefers-reduced-motion`.
- **GA-6** Every new `/api/admin/*` endpoint returns 403 without admin identity; no secret value is ever logged or returned in a response.
- **GA-7** Test suite (`npm test`) passes: unit (loyalty gamification, campaign eligibility, scheduler idempotency, AI fallback parser, notification dedupe) + HTTP integration (admin authz, campaign lifecycle, birthday flow) green.
- **GA-8** No list endpoint returns unbounded rows (all paginated / LIMIT-capped); no per-customer query runs inside a loop where a single aggregate query suffices (N+1 guard).
