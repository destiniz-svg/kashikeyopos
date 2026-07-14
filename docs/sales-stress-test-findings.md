# Sales & customer-profile stress test — findings log

Driven from an admin login against the till (`/app`) with a live store
("Stress Cafe", register-paired, PIN-gated), exercising the whole sales +
customer surface headless and reading the baked bundle to trace behaviour.
This log records what was verified, the bugs found, the fixes shipped, and a
prioritised list of the remaining convenience improvements with proposed code.

## 1. Verified working (no change needed)

| Area | What was checked | Result |
|------|------------------|--------|
| Cart math | 45 + 45 + 70 = 160, GST 8% = 12.80, total 172.80 | correct |
| Menu filter | category chips + search + "Exact" match chip | correct |
| Discounts | per-bill discount recalculates tax + total | correct |
| Customer attach | Aisha attached, 120 pts shown on the ticket | correct |
| Payment modal | Cash / Card / Transfer / QR / On-credit / FOC, quick-tender Exact/100/200/500, live "Remaining" | correct |
| Settle → receipt | store name, GST-TIN, INV number, tender lines, ≈USD, Share/Print/Done, "share as text for WhatsApp/Viber" | correct |
| Waiter calls | accept no longer leaves the call stuck on the main module (patch #75) | correct |

No page or console errors were observed in any sales flow during the test.

## 2. Flagship bug — "Sold out after one sale" (FIXED, patch #76 + server guards)

**Symptom.** A plain menu product (e.g. Espresso) showed **"Sold out · -1 pcs"**
and could no longer be tapped after a *single* sale.

**Root cause (two compounding defects).**

1. The till's product-create form defaults `stock` to `"0"` and saved
   `stock: Number(f.stock) || 0`, so **every** product a merchant added became
   *stock-tracked, starting empty*. Patch #73's sold-out gate
   (`__ksOut`: `stock != null && stock <= 0 ⇒ unavailable`, the intended §24
   feature) then fired immediately — a café selling make-to-order coffee never
   wants that.
2. The server sale-delta handler did
   `jsonb_set(data,'{stock}', COALESCE(stock,0) + d)` — for a product with **no**
   stock field it *conjured* one at `-1` on the first sale, locking it out and
   even hiding it from the guest QR menu (`(stock||0) > 0` filter).

**Fix — stock tracking is now opt-in per product.**

- **Leave stock blank ⇒ untracked**: the item sells freely and never shows
  "Sold out".
- **Enter a number ⇒ tracked**: it decrements on each sale and shows "Sold out"
  at 0 — the §24 behaviour, preserved for items that actually opt in.

Client (baked bundle, `guest-sync-patch.js` patch #76a–e):

```js
// 76a  new-product form starts blank, not "0"
'reorder:"10",stock:"0",unit:"pcs"'  →  'reorder:"10",stock:"",unit:"pcs"'
// 76b  editing an untracked item shows a blank field, not "null"
'stock:String(f.stock)'  →  'stock:f.stock==null?"":String(f.stock)'
// 76c  saving blank stores no stock (untracked), not 0
'stock:Number(f.stock)||0'  →  'stock:f.stock===""||f.stock==null?null:Number(f.stock)||0'
// 76d  settling never decrements / oversell-warns an untracked item
'if(!I)return N;const j=N.stock-I.qty;'  →  'if(!I||N.stock==null)return N;const j=N.stock-I.qty;'
// 76e  refunding never re-stocks an untracked item
'return F?{...j,stock:j.stock+F.qty}:j'  →  'return F&&j.stock!=null?{...j,stock:j.stock+F.qty}:j'
```

Server (`index.js`):

```sql
-- sale delta: only touch products that already carry a numeric stock,
-- and floor an oversell at 0 instead of going negative
UPDATE entities SET data = jsonb_set(data,'{stock}',
         to_jsonb(GREATEST(0,(data->>'stock')::numeric + $4)), true) ...
  WHERE ... AND jsonb_typeof(data->'stock') = 'number';

-- guest menu: untracked items always show; only tracked-and-empty are hidden
products.filter(p => hasRecipe.has(p.id) || p.stock == null || Number(p.stock) > 0)
```

**Verified end-to-end** (SW bumped to `kashikeyo-2.9.43`):

- Untracked "Fresh Juice" sold twice → still has **no** stock field, stays sellable.
- Tracked "Bottled Water" 3 → sell 1 → 2 → oversell 5 → **floors at 0** (not −1).
- Guest `/p/:slug/boot`: untracked item visible with `soldOut:false`; tracked-at-0 hidden.
- Bundle re-bake is a no-op (idempotent); SPA parses with zero console errors.
- **Live till render (headless):** Fresh Juice tile is not dimmed and has no pill
  (sellable); Bottled Water (tracked @ 0) and the pre-fix corrupt Espresso (−1)
  both dim and show the "Sold out" pill. The §24 gate still fires for genuinely
  tracked-and-empty items — exactly as intended.

## 3. Prioritised convenience improvements (proposed, not yet shipped)

Ranked by user value ÷ risk. Each is a self-contained bundle patch (`/back`
changes need no bake) — happy to implement on the next pass.

1. ~~**"Opening stock (optional)" label.**~~ **SHIPPED (patch #76f)** — the stock
   field placeholder now reads *"Opening stock — blank if not counted"* so the
   opt-in behaviour is discoverable at the point of entry.
2. ~~**Customer-on-ticket points preview.**~~ **SHIPPED (patch #77)** — an attached
   member's points line now reads e.g. *"120 pts · +1 this sale"* (same
   `floor(total / loyaltyBp)` the settle path uses; hidden when the earn rounds
   to zero), so the cashier can tell the guest before settling. Verified live.
3. ~~**Pre-focus "Exact" in the payment modal.**~~ **ALREADY PRESENT** — the modal
   opens with `amt = cr.total` (the exact amount) pre-filled, so the cashier only
   picks a method and confirms. No change needed.
4. ~~**One-tap restock from the sell screen.**~~ **SHIPPED (patch #78)** — a
   stock-tracked item at zero now shows *"Sold out +"*; tapping the pill prompts
   for a quantity and adds it (optimistic bump + a stock delta, the same path the
   manual adjust uses), so the item goes back on sale without a trip to `/back`.
   Recipe-driven sold-outs keep a plain "Sold out" (restocking the product can't
   fix an ingredient shortage). Verified live: "Sold out +" → prompt → +12 →
   tile un-dims to "12 pcs", sellable again.
5. ~~**Keep the numeric keypad open after "Add".**~~ **NOT APPLICABLE** — this
   build has no manual-price keypad: the manual-entry path is the search/barcode
   box, which already clears and keeps focus after each Enter-add (`id(I),ws("")`
   with no blur), and cart quantities use a +/- stepper. Both are already optimal.

## 4. Data note

The test store still has one row of pre-fix corrupt data — Espresso (`p1`) at
`stock:-1` from a sale taken before the fix. Production has never run the old
build long enough to accumulate this; no migration is required, but if desired a
one-liner clears any stray negative: `UPDATE entities SET data = data - 'stock'
WHERE kind='products' AND (data->>'stock')::numeric < 0;` (drops the field →
item becomes untracked).
