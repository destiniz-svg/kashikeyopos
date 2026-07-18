# Payments — decision brief (audit §3.4 / PAY-01)

A launch decision only you can make. This lays out the reality, the real options,
and a recommendation so you can just choose. It is **not** a code change — it's a
policy + (optionally) a future project.

---

## TL;DR

- **Today:** the POS records the *tender type* of every sale (`Cash`, `Card`,
  `Transfer`, `QR`, `Credit`) but does **not** authorize non-cash payments — no
  card is charged by the app, no bank confirms the money moved. It's a label.
- **This is normal and safe for a small operation** — no cardholder data touches
  the app, so PCI scope is minimal — **provided you reconcile daily.**
- **Recommendation:** **launch on Option A (manual reconciliation)** with the
  simple daily routine below. Revisit an integrated gateway (Option B) later, only
  if non-cash volume and reconciliation effort justify it. Don't let this block go-live.

---

## How payments work today (the facts)

Each sale carries a `payments: [{ method, amount }]` array. That's the whole
mechanism — a method label + an amount. On the reporting side, **`GET
/api/inv/ledger-export`** (FIN-04) already rolls these up:

- `tenders{}` — total taken per method (Cash / Card / Transfer / QR / Credit…)
- `accountsReceivable` — the credit-tender total (money owed, tracked per customer
  with the credit-limit enforcement from FIN-02)

So the app tells you **what was rung up** per tender. What it can't tell you is
whether the bank actually received the Card/QR/Transfer amounts — there's no
authorization or settlement feed. Closing that gap is the whole decision.

## The core tension: offline-first vs. online authorization

KashikeyoPOS is **offline-first** — a sale must be ringable with no internet and
sync later. A real payment gateway needs an **online authorization at the moment
of sale**. Those two models conflict: you cannot get a card authorized while the
till is offline. Any gateway integration therefore either (a) requires
connectivity for non-cash sales, or (b) keeps the actual charge on a **separate
bank card terminal** and just records the result — which is really Option A with
better discipline. Keep this in mind: "integrate payments" is not free UX.

---

## Option A — Manual reconciliation *(recommended for launch)*

Take the money the way most small Maldivian cafés/shops already do — cash, the
bank's **card terminal (PDQ)** next to the till, or a **bank-app transfer / QR**
the customer does on their phone — then record the matching tender in the POS.
Reconcile at end of day.

**The daily routine (train staff on this):**
1. At close, pull **`ledger-export`** for the day (per store):
   `GET /api/inv/ledger-export?from=<ms>&to=<ms>&storeId=<id>`.
2. Compare each tender line to its independent source:
   - **Cash** → counted drawer.
   - **Card** → the card terminal's end-of-day **batch/settlement report**.
   - **Transfer / QR** → the bank account's incoming transactions for the day.
   - **Credit** → equals `accountsReceivable`; check it against the customer
     balances in the Review tab.
3. Investigate any mismatch the same day (a mis-keyed tender, a declined card
   recorded as paid, etc.). The **audit trail** (FIN-03) shows who rang what.

**Effort:** none to build — it's operational. · **Cost:** none beyond your
existing bank terminal fees. · **PCI:** effectively out of scope (no card data in
the app). · **Risk:** a recorded non-cash payment has no in-app proof it cleared —
mitigated entirely by the daily reconciliation above.

This is a legitimate, widely-used model. Its only requirement is the discipline to
reconcile every day — which you now have the report for.

### Option A+ — optional hardening (small, do later if wanted)
Make non-cash tenders easier to reconcile by capturing a **reference** at the till
(card approval code / transfer reference) alongside the amount, and surfacing it in
`ledger-export`. This needs a change to the **baked till bundle** (a
`guest-sync-patch.js` patch + SW bump) plus a report tweak — a small, well-scoped
piece of work, not a blocker. Ask and I'll scope it.

---

## Option B — Integrated payment gateway

The POS electronically initiates the charge (integrated card terminal or
card-not-present), the provider authorizes it, and a **signed webhook** confirms
settlement so reconciliation is automatic.

**What it takes:**
- A merchant account + gateway with your **acquiring bank** (in the Maldives,
  e.g. Bank of Maldives' payment gateway, or your bank's equivalent — you must
  confirm what they offer and the fees).
- Dev work on this app: an **idempotent payment-initiation** endpoint (so a retry
  never double-charges — mirrors the existing op-log discipline), a **signed
  webhook receiver** to confirm/settle, a payment state on the sale, and a
  **settlement-reconciliation report**. Estimate: a focused multi-day project plus
  provider onboarding/testing.
- A UX answer to the **offline tension** above: non-cash sales become
  online-only, or the charge stays on a bank terminal and the webhook just
  reconciles.
- Ongoing: per-transaction fees, PCI obligations (kept low by using the provider's
  hosted fields / terminal so card data never enters the app), and provider
  maintenance.

**When it's worth it:** high non-cash volume, multiple outlets, or when daily
manual reconciliation becomes a real staff burden or error source. **Not** worth
it just to launch.

---

## Recommendation & decision

**Launch on Option A.** Adopt the daily reconciliation routine, lean on
`ledger-export` + the audit trail, and keep card/QR/transfer on your bank's
terminal/app. Record the decision and move on — this gate is then satisfied for
go-live.

Pick one and note it in your ops log:

- [ ] **A — Manual reconciliation** (recommended). Action: train staff on the
      daily routine above; no code change.
- [ ] **A+ — Manual + reference capture.** Action: schedule the small till-bundle
      change to capture card/transfer references.
- [ ] **B — Integrate a gateway.** Action: confirm provider + fees with your bank,
      then scope the initiation/webhook/reconciliation build as a project (post-launch).

Whichever you choose, **cash handling is unaffected and safe today.** The only
thing not to do is take non-cash payments and *not* reconcile them daily.
