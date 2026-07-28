# NFRs — Way2Buy Mini App (boutique scale)

Scale envelope (A-5): dozens to low-thousands of customers, single Node process, single SQLite/WAL file, single Telegram bot. NFRs are sized to that — not enterprise. Over-engineering is itself a defect here.

## SLOs
| Concern | Target | Notes |
|---|---|---|
| API read latency (p95) | < 80 ms | `/api/me`, `/api/feed`, `/api/purchases`, `/api/notifications` on local SQLite. In-memory-fast; the risk is N+1, not IO. |
| API write latency (p95) | < 120 ms | promo materialization, campaign create, redeem. |
| AI agent response (p95) | < 6 s with key / < 100 ms fallback | Gemini flash network call dominates; fallback is local. Must show a "thinking" state and never hang the request >15 s (hard timeout → fallback). |
| Scheduler tick duration | < 500 ms typical, < 3 s worst | Full reconciliation over all campaigns × eligible customers. Batch queries mandatory (no per-customer loop). |
| Availability | best-effort single-instance | No HA target. Restart-safe via reconciliation (ADR-003). Acceptable planned downtime for deploys. |
| Discount activation latency | ≤ `SCHEDULER_INTERVAL_MS` (default 5 min) | A holiday flips active within one tick of `starts_at`. |

## Throughput
- Expected: < 5 req/s sustained, occasional bursts on a campaign launch. SQLite WAL comfortably handles this (single writer, many readers).
- Scheduler: one tick / 5 min; each tick O(campaigns × matched customers) with batched SQL — bounded < a few thousand rows.
- Telegram DM: rate-limited by Telegram (~30 msg/s); campaign fan-out must send **sequentially with a small delay** and tolerate 429 (record `dm_status='failed'`, in-app row still written). No mass blast beyond a few thousand — acceptable.

## Consistency
- Single SQLite file → strong consistency, serialized writes. No distributed consistency concerns.
- Idempotency is the real requirement (not consistency): promo materialization and notifications must be exactly-once *per logical trigger*, enforced by unique dedup keys + `INSERT OR IGNORE` (ADR-002/003/005), so repeated ticks converge.
- Money-adjacent invariants: `cashbackAvailable = earned − redeemed ≥ 0` (already held by loyalty.js); redemption cannot exceed available (existing `Math.min` clamp — keep). Campaign percent constrained 1..90 at validation.

## Capacity / storage
- `promo_codes` and `notifications` grow over time → **bounded** by: (a) expiry sweeper transitions active→expired and prunes notifications older than N days (default 180, env), (b) recurring-materialization dedup prevents per-tick growth. SQLite file expected < tens of MB at this scale.

## Observability
- Structured single-line logs (JSON-ish) for: each scheduler tick (campaigns activated/ended, promos created, notifications enqueued, DMs sent/failed), each AI call (engine used: gemini|fallback, tool chosen, latency — **never the key or raw customer PII**), each DM failure (tg id hashed/truncated, reason).
- `/api/health` (or `/api/config` extension) exposes: live mode, scheduler last-tick timestamp, counts of active campaigns / pending notifications. Enables a simple "is the tick alive" check.
- Errors in scheduler/DM/AI are caught and logged; they must never crash the process or a request handler (fallback discipline).

## Security & compliance (PII)
- **PII stored:** name, phone, email, birthday, city, tg_user_id, notes. Marketing `consent` flag already exists.
- **Consent gate:** discount DMs / marketing notifications only to `consent=1` customers. In-app feed (pull, not push) may show to all. Document this in the notification writer.
- **Data minimization to the LLM:** the AI agent receives only the fields it needs for audience matching (tier, spend, city, counts) — **not** phone/email/full notes. `list_customers_matching` returns counts + first-name samples, not contact details. Customer free-text (name/notes) that does reach the prompt is delimited as untrusted data (ADR-004).
- **Secrets:** `GEMINI_API_KEY`, `TELEGRAM_BOT_TOKEN` stay env-only; never logged, never in API responses, never in the transcript store.
- **Authz:** all campaign/notification-admin/AI endpoints behind existing `requireAdmin`. Customer endpoints only expose that customer's own promos/notifications (scope by `tgid`).
- **Right to be forgotten / retention:** `ON DELETE CASCADE` from `customers` already removes promos/purchases; extend to notifications. Note (not implemented this iteration): a delete-customer admin action would satisfy GDPR-style erasure — out of scope but schema supports it.
- **Telegram initData:** still demo `?tgid=`; production HMAC validation is the documented forward path (out of scope) — call out that until then, admin identity is spoofable in non-DEMO only if `ADMIN_TG_IDS` is guessable; keep the allowlist server-side.

## Accessibility / UX quality (frontend)
- Animated cards must honor `prefers-reduced-motion` (disable shimmer/confetti/pulse). Countdown updates ≤ 1/s, cleaned up on unmount (no leaked intervals). Contrast AA on gradient cards. Telegram theme params respected (light/dark).
