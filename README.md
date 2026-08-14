# Way2Buy — Telegram Mini App

**A loyalty, cashback and discount system for a Telegram-native buyers' club:** cashback
wallet, tiered membership, automated birthday and holiday discounts, a fitting-room cart, a
two-channel content feed, margin tracking, and an admin office with an AI reporting agent —
in one zero-build Node application on Postgres.

[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-4.21-000000?logo=express&logoColor=white)](https://expressjs.com/)
[![Postgres](https://img.shields.io/badge/PostgreSQL-17-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Supabase](https://img.shields.io/badge/Supabase-hosted-3FCF8E?logo=supabase&logoColor=white)](https://supabase.com/)
[![Telegram](https://img.shields.io/badge/Telegram-Mini_App_%2B_Bot_API-26A5E4?logo=telegram&logoColor=white)](https://core.telegram.org/bots/webapps)
[![Gemini](https://img.shields.io/badge/Gemini-1.5_Flash-4285F4?logo=google&logoColor=white)](https://ai.google.dev/)
[![Zero build](https://img.shields.io/badge/build_step-none-6BA81E)](#architecture)
[![Tests](https://img.shields.io/badge/tests-125_node%3Atest-brightgreen)](#testing)
[![Vercel](https://img.shields.io/badge/Vercel-demo-000000?logo=vercel&logoColor=white)](https://way2buy-miniapp.vercel.app)

🌐 **Demo:** [way2buy-miniapp.vercel.app](https://way2buy-miniapp.vercel.app) — runs with
zero configuration; Telegram publishing is simulated and a demo-profile switcher appears in
the header.

---

## Table of contents

- [The problem](#the-problem)
- [What it does](#what-it-does)
- [Complete tech stack](#complete-tech-stack)
- [Architecture](#architecture)
- [Data model](#data-model)
- [API](#api)
- [Getting started](#getting-started)
- [Configuration](#configuration)
- [Telegram wiring](#telegram-wiring)
- [Filling the catalogues](#filling-the-catalogues)
- [The scheduler](#the-scheduler)
- [Testing](#testing)
- [Deployment](#deployment)
- [Project structure](#project-structure)
- [Design constraints](#design-constraints)
- [License](#license)

## The problem

Way2Buy is a buyers' club that sells through Telegram — there is no website, and there does
not need to be one. Its customers are women aged roughly 30–50 with very low digital
literacy: they will not search a brand site for a product code, but they will scroll pictures
and message a person to say *"I want this one."*

That shapes every decision here:

- **The Telegram channel keeps working exactly as before.** The Mini App is a second, wider
  entrance to the same content — not a replacement. No existing subscriber has to change a
  habit.
- **Zero learning curve.** Every screen has to be obvious without explanation.
- **The whole UI is in Ukrainian.**
- **Staff screens are one or two buttons.** An interface more complex than that will not be
  used, so it does not exist.

The engineering problem is therefore not "build a storefront" — it is to automate loyalty,
discounts, reminders and margin bookkeeping *around* a conversation that stays human.

## What it does

### Membership club

- **Cashback wallet** — the rule is one line of configuration: every `$3000` spent returns
  `$100`. Progress is shown as a ring, not a number in a table.
- **Tiers** — Silver / Gold / Platinum, derived from spend rather than assigned by hand.
- **Milestones, badges and streaks** — computed in `loyalty.js`, with `snapshotBatch()`
  producing the whole client list without an N+1 query.
- **Purchase history** in both the order currency and USD.

### Discounts that fire themselves

- **Four discount kinds** — 🎂 birthday · 🎉 holiday · 💎 VIP · 🏷️ general
- **Birthday windows** (`birthday.js`) — a claimable window opens around the date; the client
  is nudged when it opens, and the claim is recorded in `birthday_claims` so it cannot be
  taken twice
- **Holiday calendar** (`holidays`) and **campaigns** (`campaigns.js`) that activate and
  expire on schedule, with a `materialize` step that turns a campaign into concrete
  per-customer discounts
- **Rules engine** (`rules.js`) — `discount_rules` are editable from the admin office, so
  changing the promotion does not mean changing the code
- **Promo codes** (`promo_codes`, `redemptions`) with copy-to-clipboard and redemption tracking

### Feed and fitting room

- **Two-channel feed** — posts from both Telegram channels (🇺🇦 Ukraine and 💎 Luxury) in one
  scroll, filterable by channel
- **"I want this"** turns a post into an `inquiry`, delivered as a direct message to the owner
  and to support
- **Cart / fitting room** (`cart.js`) — collect items, then send the whole selection as one
  request instead of ten separate messages; `cart_events` records what was added, removed and
  sent, which is where the popular-items view comes from
- **Photo proxying** (`/api/photo/:fileId`) so channel images render inside the Mini App

### Admin office

- Client list with tier, cashback balance and streak
- **Publish a product to a channel** straight from the panel — one composer, two channels
- Discount rules, holidays and campaigns, all editable
- Issue a promo code to a specific client
- **Margin tracking** (`profit.js`) — the sale price is known immediately, the factory cost is
  entered later, so the app chases the missing entry and only then reports real profit
- **«Синхронізувати»** — pick a catalogue, press once, and it is made to match its Telegram
  channel: new posts in, changed ones updated, retired ones out of the vitrine. The channel is
  only read, never written to (see [Filling the catalogues](#filling-the-catalogues))
- **Pending-cost and alert views**, popular-item ranking, scheduler status
- **Reports** — a built-in template narrative, or a generated one through **Gemini 1.5 Flash**
  when a key is present; reports can be sent to Telegram
- **AI proposal loop** — `ai_conversations`, `ai_messages` and `ai_proposals` back an admin
  agent that proposes an action and applies it only on confirmation

### Telegram integration, both directions

- **App → channel:** publishing from the admin office posts to the real channels
- **Channel → app:** the `channel_post` webhook fills the feed, so content posted the old way
  still appears in the Mini App
- **History:** the Bot API cannot read a channel's past — a bot only receives posts published
  after it became an admin. `scripts/import-tme.mjs` fills the catalogues backwards from the
  channels' own public web pages (see [Filling the catalogues](#filling-the-catalogues))
- **Long-polling fallback** (`polling.js`) for local development, where no public webhook URL
  exists
- **Direct messages** (`notify.js`) for birthday nudges, inquiries and reward notifications

## Complete tech stack

| Area | Technology | Why |
| --- | --- | --- |
| Runtime | **Node.js 20+**, ES modules | — |
| HTTP | **Express 4.21** | One process, one router, 53 endpoints |
| Database | **PostgreSQL 17** on **Supabase**, via `pg` | 20 tables, 79 indexes, real types: `numeric` money, `timestamptz` dates, `boolean` flags, `jsonb` documents |
| Schema | `server/sql/schema.sql`, idempotent | DDL as a reviewable data file — the same file is applied to Supabase and loaded by the tests |
| Statement layer | `server/sql.js` | Translates the original `?` / `@named` statements to `$n`, so the port added `await` instead of rewriting 200 queries |
| Frontend | **Vanilla JavaScript**, no framework, no bundler | Zero build step (ADR-001) |
| Styling | Three CSS layers — `tokens.css` (design tokens), `app.css` (components), `views.css` (screens) | Custom properties instead of a utility framework |
| Telegram | **Mini App SDK** on the client, **Bot API** on the server — publishing, `channel_post` webhook, DMs, photo proxy, long-polling fallback | — |
| AI | **Google Gemini 1.5 Flash** over REST, with a template fallback | Free tier — reports cost nothing to run |
| Scheduling | In-process `setInterval` tick, plus `POST /api/admin/tick` for an external cron | Serverless hosts have no long-lived process |
| Config | **dotenv** + a validated `env.js` | Boots fully configured, or in demo mode |
| Tests | **`node:test`** — 125 tests across 11 suites, on **PGlite** | Postgres 17 compiled to WASM, in-process: the suite exercises the real dialect with no server to start |
| Hosting | **Vercel** — static `public/`, one serverless function (`api/index.js`) | Demo stand |
| Tooling | `scripts/telegram.mjs` (bot/webhook setup) · `scripts/import-history.mjs` (purchase history import) | — |

Three runtime dependencies in total: `express`, `pg`, `dotenv`. That is the point.

## Architecture

```
                        Telegram
        ┌──────────────────┴───────────────────┐
        │                                      │
   Mini App WebView                    Channels + Bot
   public/index.html                   @Way2Buy_Ukraine
   js/{telegram,api,app}.js            @Way2Buy_Luxury
   css/{tokens,app,views}.css                 │
        │                                     │
        │  fetch /api/*         channel_post webhook · DMs · publish
        ▼                                     ▼
   ┌──────────────────────────────────────────────────────┐
   │  server/index.js — Express router (53 endpoints)     │
   │                                                      │
   │   loyalty.js     cashback · tiers · badges · streaks │
   │   birthday.js    claim windows, one claim per year   │
   │   campaigns.js   scheduled campaigns → materialise   │
   │   rules.js       editable discount rules             │
   │   cart.js        fitting room + cart_events          │
   │   profit.js      sale vs factory cost, margin        │
   │   telegram.js    Bot API: publish · webhook · DM     │
   │   notify.js      customer notifications              │
   │   scheduler.js   idempotent tick (15 min)            │
   │   ai.js          Gemini reports + proposal loop      │
   │   db.js          drivers, statements, transactions   │
   │   sql.js         ?/@named to $n, value normalisation   │
   │   env.js         validated configuration             │
   └──────────────────────┬───────────────────────────────┘
                          ▼
              PostgreSQL 17 (Supabase) — or PGlite
                 in-process when DATABASE_URL is unset
```

Decisions worth naming:

- **Zero build step.** No bundler, no transpiler, no framework runtime. The file you edit is
  the file the browser runs — which matters for a project that has to stay maintainable by
  whoever inherits it.
- **The scheduler reconciles, it does not fire.** All three jobs compare desired state to
  actual state, so a restart can never miss a notification or send it twice.
- **Demo mode is a first-class path,** not a mock. Without `TELEGRAM_BOT_TOKEN` the app runs
  fully: publishing is simulated, the admin office is open, and a profile switcher lets you
  view the app as different clients. That is what the public demo is.
- **One dialect everywhere.** Production is Postgres on Supabase; with no `DATABASE_URL` the
  app starts PGlite — Postgres 17 compiled to WASM, in-process — so the demo and the whole test
  suite run against the same SQL, with no server to install. There is no second dialect to
  keep honest.
- **The types are the schema's job.** Money is `numeric`, not float. Dates are `timestamptz`.
  Flags are `boolean`, documents are `jsonb`. Three columns stay `text` for stated reasons —
  a birthday may legitimately have no year, and the month buckets the popularity reports group
  by cannot be indexed as an expression over a timestamp.
- **The app cannot change its own schema.** It connects with a role that has full DML and no
  DDL; migrations are a separate, deliberate step (`npm run migrate`).
- **Margin is tracked in two steps** because that is how the business works: the sale is known
  now, the factory cost arrives later, so the system chases it instead of pretending it has it.

## Data model

20 tables with 79 indexes, created by `server/sql/schema.sql`:

- **Customers & loyalty** — `customers`, `purchases`, `redemptions`
- **Discounts** — `discount_rules`, `campaigns`, `holidays`, `birthday_claims`, `promo_codes`
- **Content & demand** — `channels`, `posts`, `inquiries`, `cart_items`, `cart_events`
- **Comms** — `notifications`, `events`
- **AI** — `ai_conversations`, `ai_messages`, `ai_proposals`
- **Infrastructure** — `scheduler_lock`

`npm run seed` produces a realistic demo set: 7 clients, 25 purchases, a holiday campaign, a
birthday campaign and 9 holidays. Beyond the tables there are three read-only views
(`v_customer_overview`, `v_purchase_margin`, `v_item_popularity`) for browsing the data in the
Supabase table editor — the business logic stays in the server modules, where the tests reach it.

## API

53 endpoints. The client-facing set:

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/config` | Feature flags, demo mode, cashback rule |
| `GET` | `/api/me` | Profile, cashback, tier, badges, streak |
| `POST` | `/api/register` | First-run registration from Telegram init data |
| `GET` | `/api/feed` | The vitrine: chip, search, brand, category, keyset page |
| `GET` | `/api/facets` | Which brands and categories are worth offering here |
| `POST` | `/api/interest` | "I want this" → inquiry + DM |
| `GET` `POST` | `/api/cart`, `/api/cart/{add,remove,send}` | Fitting room |
| `GET` | `/api/purchases` | History in order currency and USD |
| `GET` `POST` | `/api/discounts`, `/api/redeem` | Available discounts and redemption |
| `GET` `POST` | `/api/birthday`, `/api/birthday/claim` | Birthday window and claim |
| `GET` `POST` | `/api/notifications`, `/api/notifications/read` | In-app notifications |
| `GET` | `/api/catalogs`, `/api/photo/:fileId` | Catalogues, channel photo proxy |
| `GET` | `/api/demo/profiles` | Demo-mode profile switcher |

The admin set is mounted under `/api/admin/*`: `customers`, `posts`, `post`, `purchase`,
`purchases/:id/cost`, `pending-costs`, `profit`, `popular`, `rules`, `campaigns`,
`campaigns/:id/materialize`, `holidays`, `birthday-claims`, `promo`, `inquiries`, `channels`,
`telegram`, `alerts`, `scheduler`, `tick`, `report`, `report/send`, and
`POST channels/:key/sync` — one bounded, resumable pass of «Синхронізувати».

`POST /telegram/webhook` receives channel posts and bot updates.

## Getting started

```bash
git clone https://github.com/SergeMiro/way2buy_telegram-app.git
cd way2buy_telegram-app
npm install
cp .env.example .env      # can stay empty — with no DATABASE_URL the app runs on PGlite
npm run migrate           # apply server/sql/schema.sql (skip it when running on PGlite)
npm run seed              # demo data: 7 clients, 25 purchases, 3 discount rules
npm start                 # http://localhost:4010
```

| Command | What it does |
| --- | --- |
| `npm start` | Run the server |
| `npm run dev` | Run with `node --watch` |
| `npm run migrate` | Apply `server/sql/schema.sql` (idempotent) |
| `npm run seed` | Recreate and seed the database |
| `npm run migrate:from-sqlite` | One-off import of a pre-Postgres `way2buy.db` |
| `npm test` | Run the `node:test` suites |
| `npm run tg` | Bot and webhook setup helper |
| `npm run import` | Import existing purchase history |

## Configuration

Everything is optional — the app runs in demo mode with an empty `.env`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4010` | HTTP port |
| `TELEGRAM_BOT_TOKEN` | — | Bot that hosts the Mini App and posts to the channels. **Leaving it empty is what enables demo mode.** |
| `CHANNEL_UKRAINE` | `Way2Buy_Ukraine` | Channel username, without `@` |
| `CHANNEL_LUXURY` | `Way2Buy_Luxury` | Channel username, without `@` |
| `ADMIN_TG_IDS` | — | Comma-separated Telegram ids allowed into the admin office |
| `SUPPORT_TG_IDS` | — | Ids that receive client inquiries as DMs without admin access |
| `PUBLIC_URL` | — | Public HTTPS URL, needed for the channel-post webhook |
| `CASHBACK_STEP_USD` | `3000` | Spend step that earns a reward |
| `CASHBACK_REWARD_USD` | `100` | Reward per step |
| `GEMINI_API_KEY` | — | AI reports; empty falls back to the template narrative |
| `SCHEDULER_INTERVAL_MIN` | `15` | Tick interval, in minutes |
| `DATABASE_URL` | — | Postgres connection string. **Empty runs an in-process PGlite** — that is what makes the zero-config demo work. |
| `W2B_AUTO_MIGRATE` | — | `1` applies the schema on boot. Off by default: DDL does not belong on a request path. |
| `W2B_DB_POOL_MAX` | `10` (`1` on Vercel) | Connection pool size |

## Telegram wiring

The bot must be an **administrator in both channels** — to publish, and to receive
`channel_post` updates.

```bash
npm run tg        # registers the webhook against PUBLIC_URL and checks bot rights
```

Once `TELEGRAM_BOT_TOKEN` and `ADMIN_TG_IDS` are set, demo mode switches off: publishing
becomes real, and the admin office is visible only to the listed Telegram ids. Locally, where
there is no public URL, `polling.js` long-polls instead of using a webhook. See
[`docs/SETUP-TELEGRAM.md`](docs/SETUP-TELEGRAM.md).

## Filling the catalogues

A catalogue is a Telegram channel, and the app has to show what is already in it. The Bot API
cannot help: a bot receives `channel_post` only for messages published **after** it was made an
administrator, and there is no history call at all.

### «Синхронізувати» — the button in the admin office

Pick a channel, press it, and the catalogue is made to match the channel. Nothing is written to
Telegram; the app only reads the channel's own public page.

It **reconciles** rather than emptying the catalogue and refilling it, and that is not a
preference. `cart_items.post_id`, `cart_events.post_id` and `events.post_id` are all
`ON DELETE SET NULL`, so deleting the posts would not clear a client's fitting room — it would
silently unhook it, and the popular-items ranking (which groups by `post_id`) would lose its
history. New posts are inserted, changed ones updated, and posts the channel no longer has are
marked `gone`.

Two human decisions outrank the channel: a card **hidden** in the admin office stays hidden, and
on a **curated** card — one whose title, brand or category a person corrected — those three
fields are kept while the channel keeps supplying the text, the price and the photos.

**The catalogue keeps three months** (`W2B_CATALOG_MONTHS`, 0 for everything). Posts older
than that are never written, and any that are already stored are retired after each pass —
deleted when nothing points at them, moved out of the vitrine when a fitting room or the
demand journal still does. The reason is commercial rather than technical: a bag posted a year
ago is almost certainly sold, and a vitrine full of positions nobody can buy costs a client a
message to Dasha and an answer of "це вже продано".

A deletion can only be inferred from absence, and absence only means something inside the range
of message ids a pass actually read. Each pass therefore records that range and retires only
unseen posts inside it. Posts older than the range are not missing, merely unvisited.

One press does a few pages and reports where it stopped; the browser keeps calling while there
is more. That loop lives on the client because the app runs serverless: a full channel is
thousands of pages and a function has seconds. The cursor is stored on the channel row, so
«Уся історія» resumes after a closed browser instead of starting over.

### From the command line

The same reconcile logic, for bulk work and for cron:

```bash
npm run import:tme -- --all                      # catch up on what was published since last run
npm run import:tme -- --deepen --pages 40        # walk further back; repeat until "історію пройдено"
npm run import:tme -- --channel @w2b_luxury_bags # a new catalogue: registers it and imports it
npm run import:tme -- --reparse                  # re-label stored cards after the parser improves
```

Adding a catalogue needs **no code change**: the channel becomes a row in `channels`, and the
CATALOG tab grows its chip, its counts and its filter values from the data. A catalogue whose
name is a category («Сумки жіночі») also labels its own posts, because the captions rarely do.

**A private channel** has no such page. Export it from Telegram Desktop (JSON + photos) and use
`npm run import -- <path/to/export> --channel <key>`.

Neither importer is a substitute for making the bot an administrator: without that, nothing new
posted in the channel reaches the app on its own, and `--all` has to be run on a schedule to
keep up.

## The scheduler

Three idempotent jobs, every 15 minutes:

1. **Birthday windows opening today** → notify the client that the discount is claimable
2. **A sale older than a day with no factory cost** → remind the admin, so margin data stays
   complete
3. **Campaign statuses** → activate and expire on schedule

Because each job reconciles state rather than firing an event, a restart cannot skip or
duplicate a notification. `scheduler_lock` prevents two processes from ticking at once. On a
serverless host there is no long-lived process, so the same work is exposed as
`POST /api/admin/tick` for an external cron to call.

## Testing

```bash
npm test
```

125 tests across eleven suites, on the Node built-in test runner — no test framework dependency,
and on real Postgres rather than a stand-in:

| Suite | Covers |
| --- | --- |
| `loyalty.test.js` | Cashback maths, tiers, badges, streaks |
| `cart.test.js` | Fitting room, cart events, send flow |
| `birthday.test.js` | Claim windows, one claim per year, edge dates |
| `rules.test.js` | Discount rule resolution and precedence |
| `profit.test.js` | Sale/cost pairing and margin calculation |
| `telegram.test.js` | Publishing, webhook parsing, DM delivery |

Each file runs in its own process against a private in-memory PGlite, so the suites are
independent and there is nothing to tear down. `tests/helpers/tmpdb.js` clears `DATABASE_URL`
first: if the machine happens to export one, the tests would otherwise write to a real project.

## Deployment

**Vercel** — static files from `public/`, with all API and webhook traffic rewritten to a
single serverless function (`api/index.js`):

```json
"rewrites": [
  { "source": "/api/(.*)",      "destination": "/api/index" },
  { "source": "/telegram/(.*)", "destination": "/api/index" }
]
```

Set `DATABASE_URL` to the **Supavisor transaction pooler** (port 6543) for serverless: a
function instance is short-lived, and transaction mode is what pooling many of them requires.
The app never names its prepared statements, so nothing else needs changing — a named statement
would become a server-side prepared statement, which the transaction pooler cannot carry across
pooled connections.

With no `DATABASE_URL` the deployment falls back to an in-process PGlite that is **recreated on
every cold start** — a demo stand for browsing, not a store.

Two more things serverless does not give you: there is no long-lived process, so the scheduler
must be driven by an external cron calling `POST /api/admin/tick`; and on the Supabase Free plan
a project with no database activity for ~7 days is **paused**, so something has to touch it even
on quiet days.

## Project structure

```
server/
  index.js        Express router — 53 endpoints
  db.js           drivers (pg / PGlite), statements, transactions, seed
  sql.js          statement translation, value normalisation, jsonb helper
  sql/schema.sql  the schema: 20 tables, 79 indexes, views, RLS posture
  env.js          validated configuration
  catalog.js      the vitrine query: selection, facets, keyset paging
  sync.js         «Синхронізувати»: reconcile a catalogue with its channel,
                  and keep only the window it is meant to hold
  media.js        a stored photo reference → a URL the browser can load
  loyalty.js      cashback, tiers, milestones, badges, streaks
  birthday.js     claim windows and one-claim-per-year enforcement
  campaigns.js    scheduled campaigns and materialisation
  rules.js        editable discount rules
  cart.js         fitting room, cart events, popularity
  profit.js       sale vs factory cost, margin, pending-cost reminders
  telegram.js     Bot API — publish, channel_post webhook, DM, photo proxy
  tme.js          a public channel's own web page — the only path to its history
  polling.js      long-polling fallback for local development
  notify.js       customer notifications
  scheduler.js    idempotent 15-minute tick
  ai.js           Gemini reports and the proposal loop
public/
  index.html      the Mini App shell
  js/telegram.js  Telegram Mini App SDK integration
  js/api.js       fetch layer
  js/app.js       screens and state
  css/tokens.css  design tokens
  css/app.css     components
  css/views.css   screen-level layout
api/index.js      Vercel serverless entry point
scripts/          telegram.mjs (bot setup)
                  import-tme.mjs (catalogues ← public channel pages)
                  import-history.mjs (catalogues ← Telegram Desktop export)
                  migrate-sqlite-to-postgres.mjs (one-off data import)
                  sql/keepalive.sql (anti-pause heartbeat for the Free plan)
tests/            11 node:test suites, 125 tests
docs/             BUSINESS-LOGIC.md · SCOPE.md · SETUP-TELEGRAM.md
```

## Design constraints

These are product requirements, not preferences — they are why the code looks the way it does:

1. **The channel is untouched.** The Mini App is additive. Breaking a subscriber's habit means
   losing the subscriber.
2. **The UI is Ukrainian**, and assumes no digital literacy: pictures to choose from, and one
   person to message.
3. **Staff screens are one or two buttons.** Anything more complex will not be used in practice.
4. **The human middle stays human.** Direct factory relationships are the business's core
   value; the app automates the bookkeeping around them, never the relationship itself.

## License

Proprietary — all rights reserved. Published for portfolio and review purposes.

---

Built by **Sergiy Mirochnyk** · [smiro.dev](https://smiro.dev)
