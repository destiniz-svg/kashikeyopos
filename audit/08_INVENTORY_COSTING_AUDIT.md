# 08 · Inventory & costing audit

## One figure, not two
Account 1200 and the physical ledger read the same server-derived number:
`moveStock()` re-values every **sale** move at the outlet's WAC; journal sums
rounded move values; `sale.cogs` is repaired to it, till's claim kept in
`server_audit.cogs_mismatch`. Deliveries/write-offs/counts keep their told
values (facts, not estimates).

## Quantity is the server's answer too
`deriveConsumption()` re-expands each sold dish from the outlet's own
`recipe_line`, batches (`is_batch` items, migration 032) and measured yields
(`yield_pct`/`waste_pct`, migration 031; NULL = unassessed, only then the
shipped estimate) — recursive, bounded at 12 levels, partial derivations never
replace whole ones (`qty_underived` stamped). Till and server proven to agree
to six decimal places on the same bill (vm-vs-server test).

## Flag doctrine
- No recipes at all → no stock move, no 1200 credit, no flag storm; the
  percentage estimate stays the menu's margin figure.
- Oversell → recorded, shortfall named (`stock_short` + `stock_negative`).
- Purchase→GRN→invoice: `grn_priced` re-averages WAC; `acq_match` books the
  actual deduction once per batch; `vendor_upsert` converges by name (a bare
  INSERT until the setup-file work found it).
- Counts value variance by the count; transfers are movements, not edits.

## Recipe edits vs history
Historical sales keep the moves and costs they were written with — a recipe
edit changes future derivations only; the trail carries `recipe_drift` when a
stale device's claim diverges. Reports read stored rows, so history does not
restate.

Checks re-run this pass: ledger-vs-1200 tie = 0.00 difference on the traded
store; loadtest correctness (revenue ties, journals balance) green at 4 stages.
