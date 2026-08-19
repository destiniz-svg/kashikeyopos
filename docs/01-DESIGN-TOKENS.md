# Design tokens

Two palettes. The **POS** is a dense, dark-first operator tool. The **guest
portals** are a warm, light, consumer surface. They are deliberately different
products and must not be merged into one theme.

---

## 1. POS — colour

Declared as CSS custom properties on `:root`, dark by default, with a light
theme under `[data-theme="light"]`. Both must ship; a till by a window needs
light mode and a bar at midnight needs dark.

### 1.1 Dark (default)

```css
--bg:        #111214;   /* app background */
--bg-0:      #161719;   /* rail, deepest panel */
--bg-1:      #1b1c1f;   /* card / surface */
--bg-2:      #212327;   /* raised surface, input fill */
--bg-3:      #2c2e33;   /* selected tile, avatar fill */

--line-soft: #212327;
--line:      #2c2e33;
--line-2:    #3a3d43;
--line-3:    #4e525a;

--text:       #f5f6f7;
--text-dim:   #d3d5d9;
--text-muted: #bcbfc5;
--text-faint: #a6aab1;
--code-text:  #d0d3d8;
```

### 1.2 Light

```css
--bg:        #efefef;
--bg-0:      #e9e9e9;
--bg-1:      #ffffff;
--bg-2:      #f8f8f8;
--bg-3:      #e7e7e7;

--line-soft: #f2f2f2;
--line:      #e6e6e6;
--line-2:    #d6d6d6;
--line-3:    #b4b4b4;

--text:       #131313;
--text-dim:   #2b2b2b;
--text-muted: #3d3d3d;
--text-faint: #4d4d4d;
--code-text:  #2b2b2b;
```

Note the surface ramp inverts between themes (`--bg-1` is the lightest surface
in light mode and a mid surface in dark). This is intentional: `--bg-1` means
"card", not "a particular lightness". Do not make it monotonic.

### 1.3 Semantic status colours

These carry meaning and are theme-independent in role. Each has a `-bright`
variant for text on a dark fill and a base for fills.

| Token | Meaning | Where it appears |
|---|---|---|
| `--amber` / `--amber-bright` | the brand accent, and "needs attention" | primary buttons, active nav, seated tables |
| `--go` / `--go-bright` | complete, paid, in stock, on target | settled tickets, ready KDS lines |
| `--warn` / `--warn-bright` | money figures, approaching a threshold | totals, tendered, late-but-not-critical |
| `--red` / `--red-bright` | over time, out of stock, negative variance | overdue KDS, margin bleeders, voids |

Contrast rule the whole design obeys: as text gets smaller it gets **lighter in
weight, never lower in contrast**. A till is read off-axis, across a counter,
under downlights. `--text-faint` is the floor; nothing quieter ships.

### 1.4 Role identity hues

Seven roles, seven `--id-*` hues, one each, no sharing. Role colour is identity,
not status — never reuse a semantic status colour for a role chip.

---

## 2. Guest portals — colour

Flat literals, no custom properties. The portals are single-purpose and light.

```
Brand accent        #f4553c   buttons, active tabs, prices, +/− controls
Accent deep         #c2321c   pressed states, "you are paying" label
Accent gradient     linear-gradient(150deg,#f4553c,#c2321c)   app icon, hero
Accent shadow       0 8px 22px rgba(244,85,60,.32)

App background      #1b0d0a   the frame behind the phone (deep cocoa)
Surface             #ffffff   cards, sheets, the phone screen
Surface soft        #fafafb   inactive control fill
Surface tint        #f5f5f6   secondary button fill
Hairline            #e8e8ea   input and card borders
Hairline soft       #f0f0f0   internal dividers

Ink                 #1a1a1a   primary text
Ink strong          #111111   figures and headings
Ink mid             #4a4a4f   bill line items
Ink soft            #6a6a70   body copy
Ink muted           #8a8a8f   captions
Ink faint           #9c9ca1   monospace meta, placeholders
Ink ghost           #a8a8ad   empty-state copy
Label               #b0b0b5   ALL-CAPS section labels
Disabled            #c8c8cc / #dcdce0

Success             #2ea44f   order accepted, stage complete
Warning surface     #fff8f0 on #f2ddc6 border, text #8a5a12 / #96702e
Danger              #c2452f   overpayment warning
```

The **ops readiness board** adds a third, documentary palette: page `#f6f6f4`,
card `#ffffff` on `#e6e6e3`, ink `#1a1a1a`, with schema-green `#f3f9f4`/`#1d5c33`
and control-blue `#eef4ff`/`#20447e`. Do not use it in the product.

---

## 3. Typography

| Surface | Family | Weights | Loaded from |
|---|---|---|---|
| POS | `Inter` | 400 500 600 700 800 | Google Fonts |
| Guest + member portals | `Instrument Sans` | 400 500 600 700 | Google Fonts |
| All figures, everywhere | `JetBrains Mono` | 400 500 600 700 | Google Fonts |

```html
<!-- POS -->
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
<!-- Portals -->
<link href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet">
```

**Tabular numerals are mandatory** on every surface:

```css
html, body, input, select, textarea, button {
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum" 1;
}
```

A column of money that changes width as digits change reads as a glitch and
pulls the operator's eye off the line being rung.

**Every monetary figure, receipt number, table label, time, quantity and code is
set in JetBrains Mono.** Prose is Inter or Instrument Sans. There is no third
case.

### 3.1 POS type scale

| Use | Size | Weight | Tracking |
|---|---|---|---|
| Table tile number | 20px | 700 | −0.03em |
| Modal figure (tendered, change) | 22px | 700 | − |
| KDS ticket table | 15px | 700 | −0.02em |
| Clock | 15px | 600 | −0.01em |
| Cart line name / amount | 13.5px | 600 / 700 | − |
| Menu tile price | 14px | 700 | − |
| Body / table cell | 12–13px | 400–600 | − |
| Section label (ALL CAPS) | 11px | 700 | 0.08em |
| Meta, counts | 9.5–10.5px | 400–700 | − |
| Keyboard hint chip | 10px | 700 | − |

### 3.2 Guest portal type scale

| Use | Size | Weight | Tracking |
|---|---|---|---|
| Welcome title | 22px | 700 | −0.03em |
| "You are paying" figure | 23px | 800 | −0.03em |
| Cart total | 19px | 800 | −0.03em |
| Split count | 17px | 700 | − |
| Dish name, cart line | 14px | 600–700 | − |
| Body copy | 13.5px | 400 | − |
| Bill line | 13–13.5px | 400–500 | − |
| Caption | 12–12.5px | 400 | − |
| ALL-CAPS label | 12px | 700 | 0.08em |
| Meta | 11.5px | 400 | − |

Line height on prose is 1.5–1.65 with `text-wrap: pretty`. Headings are 1.15–1.3.

---

## 4. Geometry

### 4.1 Radius

| Surface | Value |
|---|---|
| POS: small control, chip | 5–7px |
| POS: input, tile, card | 9–12px |
| POS: pill / segmented | 999px |
| Guest: control, chip | 9–12px |
| Guest: input, list row | 14–15px |
| Guest: card, sheet, primary button | 16–17px |
| Guest: circular qty button | 50% (26/27/32/34px squares) |
| Ops board: card | 18–20px |

### 4.2 Spacing

4px base. The scale in use: **4, 5, 6, 7, 8, 9, 11, 13, 14, 16, 20, 22, 24, 26,
30, 34**. Off-scale values in the prototypes (e.g. 13px, 11px) are deliberate
optical corrections at small sizes — keep them.

Layout gaps use flex/grid `gap`, never margins between siblings.

### 4.3 Hit targets

- POS touch controls: **44px minimum**, 26px for secondary in-row steppers where
  the row itself is the 44px target.
- Guest portal: **46px minimum** on every tappable row, 50–52px on inputs,
  primary buttons 15px padding (≈52px tall).
- Table picker tiles: 46px min-height, grid `repeat(auto-fill, minmax(62px, 1fr))`.

### 4.4 Shadow

Used sparingly; elevation is mostly borders.

```
accent button   0 8px 22px rgba(244,85,60,.32)
sheet / modal   0 -8px 40px rgba(0,0,0,.12)   (guest, rises from bottom)
focus ring      0 0 0 4px rgba(244,85,60,.15)
```

---

## 5. Motion

| Element | Transition |
|---|---|
| Button press | `transform .1s cubic-bezier(.2,.8,.3,1)`, `scale(.975)` on `:active` |
| Opacity / background | `.12s` / `.14s` linear |
| Screen fade-in | `@keyframes qfade` — `opacity 0→1`, `translateY(6px)→0`, **.2s** |
| Card entrance (ops) | same curve, **.25s** |

Nothing animates longer than 250ms. A till that makes an operator wait for a
transition is a slow till. Respect `prefers-reduced-motion` by dropping the
transform and keeping the opacity.

---

## 6. Iconography

Inline SVG, 24×24 viewBox, `fill="none"`, `stroke="currentColor"`,
`stroke-width` 1.7–2 (3–3.2 for small +/− glyphs), round caps and joins. No icon
font, no icon library — the exact path data for all 30 navigation icons is in the
POS prototype's `NAVDEF` constant and must be copied verbatim.

---

## 7. Currency and number formatting

- Currency is **MVR** and it is the book currency for every journal.
- Money renders as `MVR 1,234.56` in full and `1,234.56` in dense tables.
  Two helpers exist in the prototype: `MVR()` (with code) and `MVRc()` (compact).
- Foreign tender is captured in its own currency **and** its MVR equivalent at a
  recorded rate. The rate is stored on the payment row, never re-derived.
- Cash rounding to the nearest MVR 0.50 is displayed **and posted** to account
  6910. It is not a display rounding.
- Percentages: one decimal for margins and food cost (`39.8%`), whole numbers
  for tax and service rates unless the outlet's rate has decimals.
