# 02 — Visual Design System (Step 2 handoff → frontend-engineer, Steps 8–10)

Aesthetic direction: **"boutique jewel-box."** Deep indigo-black velvet canvas
(`#14122b`); discount cards are tactile gem-like objects, each variant a distinct
*material*. Warm gold is the house accent. Motion is restrained and jewel-like —
light catching a facet (shimmer), a slow breath (pulse), a burst on reveal
(confetti). Display type is **Unbounded** (distinctive, full Cyrillic); body is
the native system stack for a fast Telegram feel.

Files delivered:
- `public/css/tokens.css` — all design tokens (CSS custom properties).
- `public/css/app.css` — `@import`s tokens; base reset, shell, every component + animation.

---

## 0. Setup the frontend-engineer must do

**Load the display font** in `index.html` `<head>` (degrades gracefully to the
system stack if omitted — nothing breaks, it just looks less distinctive):

```html
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Unbounded:wght@500;700;800&display=swap" rel="stylesheet">
```

`app.css` already `@import`s `tokens.css`, so linking only `app.css` (as
index.html already does) is enough. Never hard-code a hex — always reference a
`--w2b-*` token.

---

## 1. Token vocabulary (what each group means)

All tokens are prefixed `--w2b-`. Groups:

| Group | Tokens | Meaning |
|---|---|---|
| Canvas/surface | `--w2b-bg`, `--w2b-bg-deep`, `--w2b-surface-1/2/3`, `--w2b-line`, `--w2b-line-strong`, `--w2b-scrim` | Elevation by lightness. `surface-1` = resting card/row, `-2` = sheet/input, `-3` = hover raise. `line*` = hairline borders. |
| Text | `--w2b-text`, `--w2b-text-muted`, `--w2b-text-subtle`, `--w2b-ink` | `text` = primary body (light). `ink` = **dark** text, used ONLY on gold/metallic fills. |
| Brand hues | `--w2b-gold(/-strong/-soft)`, `--w2b-violet(/-soft)`, `--w2b-rose`, `--w2b-emerald`, `--w2b-platinum` | Raw accent hues. |
| Status | `--w2b-ok(/-text)`, `--w2b-warn`, `--w2b-danger`, `--w2b-danger-text`, `--w2b-danger-solid` | `danger-text` for urgent countdown text; `danger-solid` for the filled count badge. |
| Semantic | `--w2b-primary`, `--w2b-primary-strong`, `--w2b-on-primary`, `--w2b-focus-ring` | Prefer these in components. `on-primary` = ink to place on gold. |
| Card gradients | `--w2b-{birthday,holiday,vip,generic}-{base,rim,glow}` | `base` = dark body gradient (light text sits here → AA safe). `rim` = bright metallic band (only 3px top strip; no text on it). `glow` = ambient outer glow color. |
| Shimmer | `--w2b-shimmer` | The diagonal glint gradient used by the traveling-highlight layer. |
| Tier fills | `--w2b-{silver,gold,platinum}-fill` | Metallic chip fills; **ink** text sits on them. |
| Spacing | `--w2b-space-0…16` | 4px base scale. |
| Radius | `--w2b-radius-{xs,sm,md,lg,xl,card,pill}` | `card` = 22px, `pill` = fully round. |
| Shadow/elev | `--w2b-shadow-1/2/3`, `--w2b-shadow-sheet`, `--w2b-glow-gold`, `--w2b-inset-hairline` | Soft, violet-tinted depth. |
| Type | `--w2b-font-{display,body,mono}`, `--w2b-fs-2xs…display`, `--w2b-lh-*`, `--w2b-fw-*`, `--w2b-ls-*` | Display = Unbounded, body = system, mono = code chips. |
| Motion | `--w2b-dur-{fast,base,slow,shimmer,pulse,confetti}`, `--w2b-ease-{out,standard,in-out}` | Entrances use `ease-out` at 150–320ms; loops use `in-out`. |
| Layout | `--w2b-nav-h`, `--w2b-maxw`, `--w2b-safe-bottom` | Bottom-nav height, content column cap (520px), iOS safe-area. |

**Telegram theme bridge** (`--w2b-tg-*`): opt-in accent tokens
(`link/button/button-text/hint/destructive/secondary-bg`) that adopt Telegram's
`--tg-theme-*` when present and fall back to our palette otherwise. **The canvas
and body text are deliberately NOT bridged** — the app is an immersive dark
surface (index.html ships `theme-color #14122b`), and bridging bg to a Telegram
*light* theme would break our near-white text contrast. Cards are self-contained
dark gradients, so they stay legible on any host theme. Use `--w2b-tg-*` only for
chrome accents if you want the client's button/link color to show through.

---

## 2. Component inventory + required markup

### 2.1 App shell (already referenced in index.html — now styled)
`.app` `.loader` `.nav` `.nav__btn` (add `.is-active`; admin btn uses existing
`.nav__btn--admin`) `.demobar` `.demobar__dot/__label/__select` `.sheet`
`.sheet__backdrop` `.sheet__panel` `.toast` (+ `.toast--ok` / `.toast--error`).
Active nav tab: add class `.is-active` (gold + underglow dot). Toasts animate in;
add `[hidden]` to hide.

### 2.2 Discount card — the anchor component
Variants: `.card--birthday` 🎂 · `.card--holiday` 🎉 · `.card--vip` 💎 ·
`.card--generic` 🏷️. Base class `.card` + one variant. Required child shape:

```html
<article class="card card--birthday" data-variant="birthday">
  <span class="card__glow"    aria-hidden="true"></span>
  <span class="card__shimmer" aria-hidden="true"></span>
  <span class="card__rim"     aria-hidden="true"></span>
  <div  class="confetti" aria-hidden="true">
    <!-- birthday only: render exactly 12 pieces -->
    <span class="confetti__bit"></span> <!-- ×12 -->
  </div>
  <header class="card__head">
    <span class="card__emoji" aria-hidden="true">🎂</span>
    <span class="card__label">День народження</span>
  </header>
  <div class="card__percent">
    <span class="card__percent-num">20</span><span class="card__percent-sign">%</span>
  </div>
  <p class="card__title">Знижка на день народження</p>
  <p class="card__desc">Дійсна на всі товари клубу</p>
  <div class="card__code">
    <code class="card__code-value">BDAY-7Q2K</code>
    <button class="card__copy" type="button">Копіювати</button>
  </div>
  <footer class="card__foot">
    <span class="card__countdown" data-expires-at="2026-08-01T12:00:00Z">2 дні 4 год</span>
  </footer>
</article>
```

Behavior contract:
- **Countdown**: your shared 1 Hz ticker writes the human string into
  `.card__countdown`. When `< 24h` remain, add class `.card__countdown--urgent`
  (turns `--w2b-danger-text`, pulsing dot). The text itself is JS-driven, so it
  keeps updating even under reduced-motion.
- **Confetti**: render the 12 `.confetti__bit` spans up front (birthday variant).
  Fire once by adding `.is-revealed` to the `<article>` (e.g. on first paint into
  view, or on copy). Do not re-add it every render — it's a one-shot.
- **Expired**: add `.card--expired` → dims, grayscales, disables copy, hides
  shimmer/glow. Do not render a copy affordance as active.
- Shimmer runs on holiday + VIP automatically (CSS). Birthday's motion is the
  confetti; generic's is only the hover lift. VIP also has a slow glow pulse.
- States: default / hover (lift, `@media (hover:hover)`) / focus-visible (gold
  ring, global) / expired (above). Copy button has `:active` press-scale.

### 2.3 Loyalty ring + tiers + milestones
```html
<div class="loyalty-ring" style="--w2b-ring-pct: 64%">
  <div class="loyalty-ring__hole">
    <span class="loyalty-ring__value">64%</span>
    <span class="loyalty-ring__caption">до Gold</span>
  </div>
</div>
```
Set progress via the inline custom prop `--w2b-ring-pct` (a `<percentage>`, e.g.
`64%`). It animates smoothly where `@property` is supported, static otherwise.
Tier badges: `<span class="badge badge--gold">Gold</span>` (variants
`--silver/--gold/--platinum`, dark ink on metallic). Milestones:
`<div class="milestone-row"> <span class="milestone milestone--reached">…</span>
<span class="milestone">…</span> </div>` (reached = gold check + tint).

### 2.4 Notifications
Count badge: `<span class="notif-badge" data-count="3">3</span>` — position it on
the bell/tab trigger; add `[hidden]` when count is 0. List item:
```html
<div class="notif notif--unread">
  <span class="notif__icon">🎂</span>
  <div class="notif__body">
    <p class="notif__title">Вітаємо з днем народження!</p>
    <p class="notif__text">Ваша персональна знижка 20% вже у Покупках.</p>
    <span class="notif__time">щойно</span>
  </div>
  <span class="notif__dot"></span>
</div>
```
Drop `.notif--unread` for read items (dot auto-hides, tint removed).

### 2.5 Admin AI chat (admin-only view)
```html
<div class="chat">
  <div class="chat__log">
    <div class="chat-msg chat-msg--user">зроби знижку 20% на VIP на 2 тижні</div>
    <div class="chat-msg chat-msg--assistant">Готую пропозицію…</div>
    <!-- while awaiting: -->
    <div class="chat__thinking"><span></span><span></span><span></span></div>
    <!-- structured proposal (propose→apply gate, ADR-004): -->
    <div class="proposal-card">
      <div class="proposal-card__head">Пропозиція</div>
      <div class="proposal-card__body">
        Створити VIP-знижку 20% на 14 днів.
        <dl>
          <dt>Тип</dt><dd>VIP 💎</dd>
          <dt>Знижка</dt><dd>20%</dd>
          <dt>Аудиторія</dt><dd>VIP клієнти</dd>
          <dt>Дійсна</dt><dd>14 днів</dd>
        </dl>
      </div>
      <div class="proposal-card__actions">
        <button class="btn btn--confirm">Підтвердити</button>
        <button class="btn btn--reject">Відхилити</button>
      </div>
    </div>
  </div>
  <form class="chat__input">
    <input class="chat__field" placeholder="Опишіть знижку…" />
    <button class="chat__send" type="submit" aria-label="Надіслати">↑</button>
  </form>
</div>
```
On apply, add `.is-applied` to the `.proposal-card` (green rim, hides actions);
on reject add `.is-rejected` (dims, hides actions). Field error state:
`.chat__field.is-error`. Thinking dots stay visible-but-static under reduced
motion so the pending state is still readable.

Generic buttons: `.btn` + one of `.btn--primary` `.btn--ghost` `.btn--confirm`
`.btn--reject`. States built in: `:active` press, `[disabled]`/`:disabled` (0.45
opacity, no pointer), hover glow on primary.

Utilities: `.stack` (vertical flow), `.section-title`, `.eyebrow`, `.empty`
(empty-state placeholder).

---

## 3. Reduced-motion strategy (GA-5 / AC-3)

One media block at the bottom of `app.css`:
- All animations collapse to `0.01ms` / single iteration; transitions near-instant.
- Decorative layers are explicitly parked in an **invisible/neutral resting
  state** (`.card__shimmer` off-canvas at `translateX(-120%)`, every
  `.confetti__bit` at `opacity:0`, glow static), so disabling motion never leaves
  a half-played frame.
- The **countdown keeps updating** — its text is written by JS DOM updates, not
  CSS animation, so nothing in the reduced-motion block touches it. Only the
  decorative pulsing *dot* stops.
- The `.chat__thinking` dots stop bouncing but stay visible/static, so the
  "thinking" state remains legible.
- The `.loader` spinner is allowed to keep spinning (it communicates progress /
  state, which the spec permits).

All keyframes use **transform/opacity only** (no width/height/top/left/box-shadow
animation) → composited, 60fps. `will-change` is set on the shimmer and confetti
layers.

---

## 4. WCAG AA contrast — pairs verified

Method: WCAG 2.x relative-luminance ratio. Body text is always light-on-dark;
the design rule is *no body text ever sits on a bright metallic fill* — bright
gradients live only in the 3px rims and emoji halos. Ink (`#14122b`) is used for
text on gold/metallic fills.

| Foreground | Background | Ratio | Use | Pass |
|---|---|---|---|---|
| `--w2b-text` `#f4f2ff` | `--w2b-bg` `#14122b` | **16.4:1** | primary body | AAA |
| `--w2b-text` `#f4f2ff` | birthday base darkest `#201028` | **~15:1** | card body | AAA |
| `--w2b-text` `#f4f2ff` | holiday base darkest `#10203a` | **~14:1** | card body | AAA |
| `--w2b-text` `#f4f2ff` | vip base lightest `#24242f` | **~12.8:1** | card body | AAA |
| `--w2b-text` `#f4f2ff` | generic base `#17152e`–`#262347` | **12–16:1** | card body | AAA |
| `--w2b-text-muted` `#b8b3d9` | `--w2b-bg` | **9.0:1** | secondary text | AAA |
| `--w2b-text-subtle` `#9791ba` | `--w2b-bg` | **5.5:1** | hints/labels | AA |
| `--w2b-ink` `#14122b` | `--w2b-gold` `#e8c477` fill | **10.8:1** | text on gold (copy btn, chips, user bubble) | AAA |
| `--w2b-danger-text` `#ff8a9b` | dark card base | **8.1:1** | urgent countdown | AAA |
| `--w2b-danger` `#ff5c72` | `--w2b-bg` | **6.0:1** | urgent dot/ring | AA |
| `#ffffff` | `--w2b-danger-solid` `#d9243c` | **4.9:1** | notif count badge text | AA |
| `--w2b-gold-soft` `#f0cd7f` | card code chip bg (`rgba(0,0,0,.28)` over dark base) | **>9:1** | promo code value | AAA |

Telegram light/dark: because the canvas stays dark on both themes, every pair
above holds regardless of the host client theme (the bridge only recolors opt-in
chrome accents, never the surfaces text sits on).

Reminder for implementers: if you ever place text on a `*-rim` or `*-fill`
gradient, use `--w2b-ink`, never `--w2b-text`. White-on-gold is ~1.4:1 and fails.
