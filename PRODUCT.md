# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary: floor staff in the middle of service. They are cashiers and waiters on a tablet or phone with a guest in front of them, and a chef at the pass. They need speed, and they need no doubt about money. Every service screen is designed for that person first.

Secondary:
- **The owner.** Owns the business and the account. Uses the back office for reports, stock, GST, payroll and settings.
- **Managers.** Approve voids, discounts and refunds, and close the day.
- **Guests.** Order from a table QR code on their own phone.
- **Members.** Use the member card for points, receipts and ordering.

Staff sign in at the till with a face and a four-digit PIN. The owner signs in with an email account. These are two separate kinds of sign-in, and they are kept apart.

## Product Purpose

KashikeyoPOS is a point of sale and back office for cafés and restaurants in the Maldives. It covers the floor, the kitchen display, QR ordering, loyalty, stock, payroll, GST and real double-entry accounts, in one system. Success means a shop can trade through a whole service without the till getting in the way, and the books still agree at the end of the day.

## Positioning

- **Built for the Maldives.** It uses MVR with 50-laari cash rounding, knows GGST/TGST and MIRA registration, applies MRPS pension rules and the minimum-wage bands, and handles USD tendered at the counter.
- **Keeps selling offline.** Every write goes through a durable outbox and replays when the connection returns.
- **Every sale reaches the books.** Each sale posts its own balanced journal on the server, so the ledger is never a separate step.
- **Each business has its own database.**

## Operating Context

- **Devices:** tablets and phones on the floor, a counter terminal, a kitchen display, thermal receipt and KOT printers (USB, serial or LAN), and a cash drawer.
- **Several devices, one outlet:** terminals at the same outlet share one floor, and it refreshes every five seconds.
- **Guest side:** each store has its own subdomain for its QR menu and member card.
- **Operator side:** the seller runs Mission Control, a separate service.

## Capabilities and Constraints

- **Ranks:** Kitchen 1 · Till 2 · Manager 3 · Admin 4 · Owner 5. The rank is the only permission gate. A screen that's refused says so in words, rather than disappearing.
- **Money:**
  - GST is added on top of the menu price. Service charge is worked out on the net, and tax on net plus service.
  - One settlement order everywhere: subtotal, then discounts, then points, then the amount due, then the tip, then the amount paid.
  - Tips are held for staff and are not revenue.
- **Tech:** Node, Express and Postgres; the pages are hand-written HTML with no build step. Only two runtime dependencies are allowed.
- **Language:** English only for now. Dhivehi (Thaana) is an open decision. Receipts print ASCII only.
- **Honest figures:** every figure on screen is measured. A number that can't be measured is replaced by a sentence saying what's true.

## Brand Commitments

- **Name:** KashikeyoPOS™. Assets are in `site/` (logo.svg, logo-mark.svg, logo.png, logo-mark.png).
- **Store branding:** each store has its own brand on its receipts and guest portals. The powered-by line can be hidden for white label.
- **Voice:** plain and calm. Short and factual. Say what happened and what to do next.
  - No ledger codes or internal jargon on staff screens.
  - Never claim something the product doesn't do.

## Evidence on Hand

- **Site copy:** the landing, docs and privacy pages are in `site/`. The landing offers a 14-day free trial.
- **Menu data:** the pre-set Maldivian café menu is in `src/data/preset-menu.json` (301 dishes, 112 add-ons).
- **What doesn't exist yet:** customer testimonials, case studies, published customer counts or benchmark claims. Future work must not invent them.

## Product Principles

1. **The guest in front of the cashier comes first.** Service screens favour speed and one clear next step over completeness.
2. **Money is never ambiguous.** Every surface shows the same settlement and the same figure, and says exactly what was taken.
3. **A control does what it says, or it isn't there.** Nothing claims to have done what it only recorded.
4. **Absence is stated, never faked.** Empty, offline and unmeasured states say what's true.
5. **The owner decides; the till never blocks a sale.** Risks are named at the moment they matter, without stopping service.

## Accessibility & Inclusion

- **Touch targets:** at least 44px on phones and tablets.
- **Contrast:** WCAG AA contrast is measured, in both themes.
- **Keyboard:** focus is visible when using the keyboard.
- **Distance:** the till is read across a counter, so figures and states must hold up at a glance.
