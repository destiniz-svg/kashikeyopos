# Reference-design reskin — sell screen toward the clean POS mock

A customer shared a clean restaurant-POS mock and asked to implement it. The
till's three-zone register already matched it structurally (open-bills rail,
category + photo menu grid, order rail with Dine-in/Takeaway/Delivery tabs and a
Subtotal/GST/Total block), so this was a **reskin**, not a rebuild. Kept the
kashikeyo **brand orange** (not the mock's green — decided with the user).

Because the till SPA source is uneditable, every UI change here is a
string-`.replace()` patch or an injected-CSS/helper block in `guest-sync-patch.js`.

## Shipped

1. **Card polish** — `.ksh-tile` / `.ksh-panel` now use softer layered shadows
   and a gentle hover lift (instead of a hard orange border on hover), for the
   mock's crisp floating-card feel. Injected-CSS, theme-var driven, reversible.

2. **Best-seller tags (patches #79 + backend `recomputeBestSellers`)** — the top
   movers over the trailing 30 days are flagged `data.bestSeller` onto the
   product entity (mirroring how the availability engine annotates
   `recipeAvail`), which rides the normal sync stream to the till, where the tile
   shows a brand-coloured **"★ Best seller"** badge. Ranked by net units sold
   (sales − refunds), min 2 units, top 6; only products entering/leaving the set
   are rewritten so re-running after every sale barely churns rowver. Hidden
   while an item is sold out so it never competes with the sold-out pill.

3. **Order-progress rings (patch #80 + `__ksRing`/`__ksProg` helpers)** — each
   Orders-board card leads with a circular gauge of its lifecycle progress
   (new 12% → preparing 55% → ready 88% → done ✓), coloured by the same status
   token the pill uses. This maps the mock's "Current order · %" ring onto the
   till's IA, where order progress actually lives (the sell-screen open-bills
   rail holds carts, which have no progress). Derived from status — no new data.

## Verified end-to-end (headless, SW `kashikeyo-2.9.46`)

- Drove sales → 6 products flagged `bestSeller` (top-6 cap held; ranked across
  the 30-day window). Till menu shows 5 "★ Best seller" badges — the 6th
  (Espresso) is hidden because it's sold out, exactly as guarded.
- Two guest orders → both rings read "12" (New). Accepting one advanced it to
  "55" (Preparing) live while the other stayed "12" — the ring tracks progress.
- Bake is idempotent; `index.js`/`inventory.js` syntax-checked; zero console errors.

4. **Product photos from the back office** — the till's product editor already
   had photo upload (resizes to 512px), but `/back`'s "Menu & Recipes" editor —
   where merchants do catalogue work — couldn't set a photo. Now it can:
   - `GET /api/inv/products` returns `img`; new `PUT /api/inv/products/:id/image`
     writes (or clears) `data.img` on the product entity, capped + validated as
     an image data URI, and pokes sync.
   - The recipe editor shows the item's photo (or emoji placeholder) with
     **Add / Change / Remove photo**; a `resizeImage` helper downscales the
     chosen file to a ≤512px JPEG client-side (same as the till) so a phone
     photo never bloats the sync stream. `/back`-only + server — no bake.
   - Verified end-to-end: uploaded a photo to Chocolate Cake in `/back` → stored
     as a 7.6 KB data URI → the till tile renders it photo-forward. Zero errors.

   With this, the menu grid matches the mock as merchants add photos — no more
   "needs merchant data" blocker for the visual.

## Not done (a decision, not a limitation)

- **Emerald green palette** — a one-line `--k-primary` swap if the brand ever
  moves off orange.
