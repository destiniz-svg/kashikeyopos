# Guest QR portal — screen spec

Reference prototype: `design/KashikeyoGuest QR v3.dc.html`.

A phone web app reached by scanning the QR code on the table card. No install,
no account required. Warm, light, one-handed.

**The rule the whole app obeys: a phone never decides money.** It shows what the
till holds and posts intent. The guest asks to pay; the cashier takes it; the
ledger fires once, on the till, where it is attributable.

---

## 1. Frame

Body `#1b0d0a`, the phone screen `#ffffff` inside it. Max width 430px, full
height, `overflow: hidden` with the body scrolling internally
(`flex:1; min-height:0; overflow-y:auto`).

Four tabs, bottom bar, thumb reach: **Menu · Track · Bill · You**.

---

## 2. Table gate

Shown when no table is chosen. Full-screen, `qfade .2s`.

- 52×52px app mark, 17px radius, `linear-gradient(150deg,#f4553c,#c2321c)`,
  shadow `0 8px 22px rgba(244,85,60,.32)`.
- Title 22px/700/−.03em: "Welcome to {outlet}".
- Sub 14px `#8a8a8f`, line-height 1.6.
- `YOUR TABLE` label 12px/700/.08em `#b0b0b5`.
- Table grid: `repeat(auto-fill, minmax(62px,1fr))`, gap 9px. Tile 13.5px/700
  monospace on white, 1px `#e8e8ea`, 14px radius, min-height 46px.
- Foot: "Your table number is printed on the card in front of you."

Table count comes from the outlet record. A deep link `?t=4` skips this screen.

---

## 3. Header

Once a table is chosen, a persistent header shows the outlet name and, beneath
it, a 13.5px/600 `#f4553c` line with a table icon reading
**"Table {n} · Welcome — you're all set to order"**, becoming
**"Table {n} · Welcome back, {firstName}"** once the guest identifies.
The tax rate belongs on the bill, not here.

---

## 4. Menu tab

- Search + category chips + diet filters.
- **Allergen and diet filters are derived from recipes** — tag an ingredient
  once and every dish that uses it inherits. A recipe change updates the guest's
  filter the same minute.
- Dish row: name 14px/600, description, price in monospace `#f4553c`.
- Tapping a dish opens a sheet: hero, description, allergen list, add-ons with
  their own steppers, a note field, quantity (34px circular −/+ around a
  16px/700 monospace count), and "Add to round".
- **Cart bar** rises above the tab bar when the cart is non-empty: a 16px-radius
  `#f4553c` bar with a count badge, "Review this round", and the total in
  800-weight monospace.
- Cart sheet: lines with 27px steppers, promo code field, and the total labelled
  "Goods, before service and {tax}" — the phone never quotes a final figure the
  till has not computed.
- Promo codes: the phone treats an entered code as an **offer**, never a fact.
  It travels with the order and the till decides.

Sending a round posts a guest order. It appears on the floor terminal for the
cashier to accept; the guest sees "awaiting the till", not "confirmed".

---

## 5. Track tab

Stage list for each round sent: **Received → In the kitchen → Ready → Served**.

- Dot 26px: complete `#2ea44f`, current `#f4553c` with
  `box-shadow: 0 0 0 4px rgba(244,85,60,.15)`, pending `#f0f0f2`.
- The stage is the till's projection, read from the fulfilment feed — never
  inferred on the phone from ticket lines it can only half-see.
- Copy per stage is written for a guest, not an operator: "Plated and waiting to
  come over", "On your table — enjoy".

---

## 6. Bill tab

The live ticket as the till holds it.

- Lines, then subtotal, service charge {n}%, {tax} {rate}%, **Table total**
  (15px/700, top border).
- **Split modes**: "I'll get it" (whole table), "Split evenly" (with a −/+
  counter, 32px circular buttons), "What I ate" (tap your own dishes; the rest
  stays on the table's bill), "Custom amount" (MVR-prefixed input, 52px,
  1.4px `#f4553c` border).
- Overpayment warning in `#c2452f`: paying more than the bill should be a tip,
  added below, so the team actually receives it.
- **Tip** row: preset percentages plus custom. Tips post to 2120, separately
  from the sale.
- "You are paying" panel: label 14px/700 `#c2452f`, figure 23px/800 `#f4553c`
  monospace, and a plain-English breakdown of what that figure covers.
- Primary action **asks to pay** — it notifies the till with the tender
  preference, the split and the tip. It does not charge anything.

---

## 7. You tab

- Not identified: name + `+960`-prefixed mobile inputs (50px, monospace), and a
  `#f4553c` save button. Identifying is optional everywhere except loyalty.
- Identified: a gradient member card — 22px/700 name, masked number, points
  balance.
- `THIS TABLE` section: call a server, ask for water, ask for the bill. Each
  posts a request that appears on the floor terminal until acknowledged.
- After settlement: a rating prompt, once, then never again for that visit.

---

## 8. Offline and state

The portal persists table, cart, sent rounds, identity, promo and diet filters
under a versioned key, and restores on reload — a guest whose phone locks does
not lose their round.

It reads the till's **live session snapshot**: a stable published interface
(prices, open tickets, stages) that does not break at the next version bump. It
never reads costs, margins or staff records — a guest device has no business
holding those, so they are not in the projection at all.
