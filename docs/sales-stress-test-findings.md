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

## 3. Prioritised convenience improvements (proposed, not yet shipped)

Ranked by user value ÷ risk. Each is a self-contained bundle patch (`/back`
changes need no bake) — happy to implement on the next pass.

1. **"Opening stock (optional)" label + track toggle.** Now that blank = untracked,
   the field placeholder should read *"Opening stock — leave blank if you don't
   count it"* so the new behaviour is discoverable. Low risk, `stock`-input string patch.
2. **Restore a mistakenly-oversold item in one tap.** When a tracked item hits 0
   from an oversell, offer a "+ restock" affordance on the sold-out tile instead of
   forcing a trip to `/back`. Medium.
3. **Quick-tender "Exact" as the default focus** in the payment modal — most cash
   sales are exact; pre-selecting it saves a tap. Low.
4. **Customer-on-ticket points preview** — show "earns +N pts" next to the total
   before settling, not only after. Low.
5. **Keep the numeric keypad open** after "Add" in the manual-price path (it closes
   and re-opening costs a tap). Low.

## 4. Data note

The test store still has one row of pre-fix corrupt data — Espresso (`p1`) at
`stock:-1` from a sale taken before the fix. Production has never run the old
build long enough to accumulate this; no migration is required, but if desired a
one-liner clears any stray negative: `UPDATE entities SET data = data - 'stock'
WHERE kind='products' AND (data->>'stock')::numeric < 0;` (drops the field →
item becomes untracked).
