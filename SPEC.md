# KashikeyoPOS · Multi-device platform spec

Version 1.1 · 25 Sep 2026 · reviewed against the code on `main` (PRs up to #53)

This is the platform spec (v1.0) after review. Where the original asked for
something a web app cannot do, or that the Maldives market does not need yet,
this version says what to do instead. Each section is marked:

- **Have:** already built. Keep it and don't rebuild it.
- **Change:** the requirement is rewritten; the reason is given.
- **Build:** new work, with the phase it belongs to.

Screens for every **Build** item are on the V2 · Lagoon design canvas, in the
"From the platform spec" row.

---

## 1. What the platform is

One operating state for the whole restaurant, shown on four kinds of device:
the till (tablet or desktop), the handheld (waiter's phone), the kitchen
display, and alerts on a phone or watch. Each device keeps working when the
internet drops, and all of them agree again when it comes back.

The build is a web app (a PWA installed from app.kashikeyopos.com), and that
stays true. Every requirement below has to work in Chrome on Android and
Windows and in Safari on iPad. A requirement that needs a native app is marked
as such and parked in phase 3.

### Principles (unchanged)

Local first · optimistic · deterministic · synchronised · made for the device
it runs on · fail-safe · no waiting on the cloud.

---

## 2. Performance targets

| Metric | v1.0 | v1.1 | Why |
|---|---|---|---|
| Touch feedback | ≤ 16 ms | Pressed state painted in the **next frame**; the result of a tap painted in **≤ 100 ms** (INP p75) | 16 ms is one frame. What staff feel is the result of the tap, and INP is the metric Chrome measures. |
| Cross-device sync | ≤ 100 ms | **p95 ≤ 1 s** over the internet; **≤ 250 ms** through a store hub (§9) | The server is outside the Maldives, so a round trip alone is 150–300 ms. 100 ms can't be promised and can't be tested. |
| Rendering | 60 FPS | 60 FPS on a 2021 iPad and a mid-range Android phone; list scrolling and the waterline included | Names the test devices. |
| Offline transition | Immediate | No spinner, blocked button or modal because the internet is down. The only change is the amber pill. | Makes it testable. |
| Touch target | 48 × 48 dp | 48 × 48 minimum on touch devices; 56+ for money actions and kitchen bumps. Back office on desktop with a mouse may go to 40. | The design already uses 48–62. |
| Menu depth | ≤ 2 levels | Category → dish. Options open in a panel and don't count as a level. | Unchanged in spirit. |

**Have:** the load campaign in `LOAD.md` shows the server at 6 ms p50 for one
till and 29 ms p50 for eight. The server is not the bottleneck; the network
and the 5-second poll are.

---

## 3. Devices

### 3.1 Till: tablet or desktop

**Have:** floor plan, ticket, pay, splits (evenly, by guest), receipts, `⌘K`
palette, keyboard shortcuts, USB and serial printers, cash drawer through the
printer.

**Build (phase 1):**
- **Dish options as a side panel.** On tablet the options replace the menu grid
  beside the ticket instead of opening in a modal, so the ticket stays live.
  Board: *Dish options · side panel*.
- **Split by item.** Drag a line onto a guest, or tap the line and then the
  guest; the tap route is required for accessibility (WCAG 2.5.7). Shared lines
  divide evenly. Board: *Split by item*.

### 3.2 Handheld: waiter's phone

**Have:** waiter floor, order, ticket and pay on a phone, with the bottom tab
bar for one hand.

**Change:**
- **NFC tap-to-pay** needs the acquiring bank's SoftPOS SDK, and a web page
  cannot take card payments over NFC. Parked in phase 3, pending BML or MIB
  offering it. Until then, card payment on the floor means carrying the bank
  terminal.
- **Camera scanning** (member card, guest QR): use the browser's
  `BarcodeDetector` where it exists (Chrome on Android). Safari needs a small
  decoder fallback. **Build, phase 2.**

### 3.3 Kitchen display

**Have:** station tabs, all-day counts, bump, allergy flags, target time.

**Change:** the status colours stay, but blinking goes.

| State | v1.0 | v1.1 |
|---|---|---|
| New | Green | Green water, and the word "New" |
| Warning | Yellow | Amber from **half the target time**. The threshold is set per station. |
| Overdue | Blinking red | Coral, a thick border and "Over 12 min". It **pulses slowly, at most once a second, and never flashes.** |

Why: flashing more than three times a second can trigger seizures (WCAG
2.3.1), and a blinking wall of tickets at 8 pm tells the chef nothing new.
Colour is always paired with a word, for colour-blind cooks.

**Build (phase 1):** bump-bar support. Bump bars type keys, so bump keys 1–9
map to the tickets in screen order; the numbers are printed on the bump
buttons. Board: *Kitchen · the deep*.

### 3.4 Watch

**Change:** there will be no watch app. A web app cannot run on a watch.
Phones already mirror their notifications to Apple Watch and Wear OS, so the
watch requirement becomes:

- **Build (phase 2): Web Push** from the installed app to the waiter's phone,
  for: order ready, bill asked, a guest QR order to accept, sold out, and
  manager calls. The watch shows whatever the phone shows.
- One action per alert ("Picked up", "On my way", "OK"). Android shows action
  buttons; on iOS a tap opens the app at that table.
- **Haptic patterns** can be set on Android only (`vibrate`). iOS uses the
  system buzz, so the pattern is a nice-to-have, never the only signal.
- Alerts go to the table's waiter (or the runner, for "order ready"), never to
  everyone, apart from "sold out".

Board: *Watch alerts*. A native watch app is phase 3, and only if staff ask
for it after using push.

---

## 4. Ordering rules

**Have:** the business rules are deterministic. The bill engine
(`kashikeyo-bill.js`) computes service at 10% of net, TGST at 16% of net plus
service, and cash rounding to 0.50. It runs the same way on every device and
on the server.

**Have:** required option groups (`required`, `min`, `max`).

**Change:** a dish with an unfinished required choice cannot be sent, and the
ticket says why ("Send · 1 to finish") instead of greying the button out
silently. Orange means "choose or fix this before it can go". Coral is kept
for "past its time", so the two never mean the same thing.

AI may suggest (upsells, menu import) but never changes a price, tax, total or
line without a person tapping to accept.

---

## 5. Voice ordering (phase 3, optional)

**Change:** the v1.0 wording, "deterministic local speech-to-text", can't be
delivered in a browser:

- Chrome's speech recognition sends the audio to Google. It is not local, and
  Firefox doesn't have it.
- Dhivehi dish names (Garudhiya, Mas Huni, Fihunu Mas) are recognised badly.

What *can* be deterministic is the step after recognition. The heard text is
matched only against the store's own menu, table and guest names, plus
aliases the store adds (for example "fehi mas" → Fihunu Mas). The rule from
v1.0 stands and gets stricter:

1. Anything that doesn't match exactly, or matches two things, becomes an
   **orange line** listing the nearest dishes to pick from. Nothing is added
   silently.
2. Voice never sends to the kitchen and never takes a payment. A person taps
   Send.
3. The ticket shows what was heard, so the waiter can spot a mishearing.

Board: *Offline · voice · handoff*. Build this only after phase 2 ships, and
only if a pilot store asks for it.

---

## 6. Bill splitting

**Have:** evenly and by guest.

**Build (phase 1): by item**, as in §3.1.

**Change: the rounding rule.** v1.0 used 1,000 ÷ 4 = 250, which never happens
at a real table. The rule is:

- Every share is computed with the same bill engine. Service and TGST are
  computed on each share's own net, not by dividing the bill's tax.
- **The shares must add up to the bill exactly.** Any laari left over from
  rounding goes to the first unpaid share. Example: 269.24 split three ways is
  89.75 + 89.75 + 89.74.
- Cash rounding to 0.50 applies per share, when that share is paid in cash.

**Change: payment sessions per share.** Card terminals in the Maldives are not
connected to the till, so there is no terminal token to create. Each share is
its own **payment record** with its own tender, and a share can be paid,
refunded or voided on its own. When a terminal integration exists, the token
attaches to that record.

---

## 7. Handoff between devices

**Have:** tickets, sent lines and payments are shared state. Any till or phone
can open any table.

**Gap:** lines that are **not yet sent** exist only on the device that entered
them. Lock the phone and walk to the till, and those lines are not there.

**Build (phase 2):**
- Unsent lines are synced as **draft lines** on the ticket, with the author
  and the device. They are shown on every device as "New · not sent · Aisha's
  phone".
- Opening that ticket on another device shows "Picked up from Aisha's phone"
  with the lines, as on the *Offline · voice · handoff* board. There is no
  lock: two people can add lines at once, because lines are only ever added or
  voided, never edited in place.
- A half-finished options choice travels as an orange draft line.
- Draft lines are **never** printed, fired or charged until someone sends them.

---

## 8. Sync

**Have** (keep):
- Optimistic writes into a **durable outbox in IndexedDB**. Each op carries an
  `opId` generated before it touches the network.
- **Lamport clocks** for ordering across devices. `tick()` is persisted, and
  `seen()` raises the clock on every poll.
- The server applies ops **idempotently** (`op_log`, `ON CONFLICT DO
  NOTHING`). Each op has its own savepoint, so one bad op can't block the
  outbox, and long drains are chunked.
- Failed ops are parked where a manager can see them, retry them or discard
  them (Sync & devices).

**Change: SQLite → IndexedDB.** Browsers don't ship SQLite, and the outbox and
offline cache already live in IndexedDB. SQLite comes in only with a native
wrapper or the store hub (§9).

**Change: WebSockets → Server-Sent Events plus the existing push.** Devices
already send changes with `POST /sync/push`. What's missing is the server
telling them something changed; today they poll every 5 s. An SSE stream
(`GET /sync/stream`) that sends "outlet changed, lamport N" and wakes the
existing `pull()` meets the 1 s target:
- no new dependency (Express streams it);
- it survives proxies and Railway;
- it reconnects on its own;
- the poll stays as the fallback.

Use WebSockets only if a two-way need turns up that SSE plus POST can't serve.
**Build, phase 1.**

**Build (phase 2): per-ticket version numbers.** Two waiters changing the same
scalar field (covers, table, guest name) still resolves last-write-wins, as
the comment in `kashikeyo-api.js` records. Add a `version` to each ticket and
reject a scalar edit made against an older version. The device then re-reads
and shows "Changed on the till: covers are now 4". Lines are unaffected,
because they are only added or voided.

---

## 9. Working through an internet outage

**Have:** each device keeps selling offline and drains when the internet
comes back. USB and serial printers on the till keep printing because they
don't need the network.

**Gap:** with the internet down, devices can't reach each other. A browser
can't find or talk to the other devices on the Wi-Fi, so:
- a till's order does not reach the kitchen display;
- network printers (TCP port 9100) can't be reached at all, online or off,
  unless the server is on the same network.

**Build (phase 2): the store hub.** An optional small computer in the store (a
mini PC or the counter PC) runs the same `server.js` against a local Postgres.
Devices use it first, the cloud second, and the hub syncs up to the cloud.
With a hub:
- tablet → kitchen display and printing keep working through an outage;
- sync inside the store drops under 250 ms;
- network kitchen and bar printers work, through the `net` path the print
  module already has.

Without a hub, a store gets what it has today. Every device keeps selling on
its own, the kitchen uses the till's USB printer, and everything converges
when the internet returns. **The app says which mode the store is in** on the
Printers and Sync & devices screens, so nobody finds out during an outage.

**Print routing:** **Have** (station routing per dish or category). Routing is
cached on each device and on the hub.

**Change: receipt numbers offline.** Receipt numbers are assigned by the
server when a sale is recorded. An offline receipt needs a number the moment
it prints, and the number must stay unique across tills for MIRA. Offline
sales print a **device-prefixed provisional number** (for example
`HLC-T2-000118`), and the server keeps it, rather than issuing a second number
for the same sale. Confirm the format with the accountant before building.
**Phase 1, because it's a compliance issue.**

---

## 10. Phases

| Phase | Scope | Rough size |
|---|---|---|
| 1 · now | Lagoon redesign, screen by screen. Options side panel. Split by item with the rounding rule. Kitchen thresholds, pulse and bump keys. SSE live updates. Offline receipt numbers. | 3–4 weeks |
| 2 · next | Draft lines and handoff. Per-ticket versions. Web Push alerts (watch through the phone). Camera scanning. Store hub. | 4–6 weeks |
| 3 · on demand | Voice ordering. NFC tap-to-pay (needs a bank SDK). Native watch app. | Only once a pilot store asks |

---

## 11. Acceptance criteria

v1.0 scenarios A–F stand, with these edits and additions. Every scenario runs
in the e2e harness against a real install.

**A · Normal ordering.** The line appears on the device within one frame. The
kitchen display shows it within 1 s p95, and within 250 ms with a hub.

**B · Handoff** *(phase 2)*. Three unsent lines entered on the phone are on
the till within 1 s after the phone locks, marked as the phone's. Sending
from the till fires them once. Replaying the phone's outbox creates no
duplicates.

**C · Internet failure.**
- No spinner and no disabled Pay.
- The pill says "Offline · N waiting".
- USB printing continues.
- With a hub, the kitchen display and network printers continue too.
- The receipt carries a device-prefixed number.

**D · Internet recovery.**
- The outbox drains with zero duplicates (`op_log` replay).
- Journals balance.
- Totals match the sales.
- A 200-op drain finishes without blocking the operator.

**E · Voice ambiguity** *(phase 3)*. An unmatched word never adds a line. It
shows orange with suggestions, and Send stays blocked until it is resolved or
removed.

**F · Split by item.**
- The shares add up to the bill to the laari.
- Each share's tax is correct on its own net.
- Paying one share leaves the others open.
- Refunding one share leaves the others paid.

**New:**

**G · Concurrent edit.** Two devices change the covers on one ticket while
both are offline. When they reconnect, one change wins by Lamport order, the
other device is told, and nothing is lost silently.

**H · Printer down.** The kitchen printer is unplugged mid-service. The till
says so within 5 s, and the ticket still reaches the kitchen display. Nothing
is marked sent to a printer that did not print.

**I · Required choice.** A dish with an unmade required choice cannot be sent
from any device, voice included, and the ticket says why.

**J · Kitchen at distance.** An overdue ticket can be told apart from a new
one at 3 m, in greyscale, without relying on colour alone.

---

## 12. Out of scope

- Replacing Postgres or the op-log sync model. It works, and the load tests
  back it.
- Local-network discovery or peer-to-peer mesh between browsers. Browsers
  can't do it; the store hub is the answer.
- A conversational AI waiter.
