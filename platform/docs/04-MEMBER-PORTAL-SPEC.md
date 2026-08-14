# Member portal — screen spec

Reference prototype: `design/KashikeyoMember Portal.dc.html`.

The same visual language as the guest portal. Where the QR portal is anonymous
and table-bound, this is identified and chain-wide: one member, many outlets.

---

## 1. Sign in

Mobile number, `+960` prefixed, then a one-time code.

- The OTP keypad must not drop digits on fast typing — buffer input and apply
  per keystroke, not per render.
- No password. No account creation form: a member exists the first time a
  cashier attaches a phone number to a sale, with consent recorded.

## 2. Home

- Member card: gradient `linear-gradient(150deg,#f4553c,#c2321c)`, name 22px/700
  white, masked number in monospace at 80% white, points balance.
- Tier and the distance to the next tier, read from the tier ladder in
  configuration — never a hardcoded threshold.

## 3. Bill

The screen the portal originally lacked. Shows the member's open ticket at
whichever outlet they are sitting in, with the same line/total treatment as the
guest portal.

**Points settle as money.** Choosing to pay with points converts at the
configured rate, reduces the amount due, and posts against the loyalty liability
(2200) rather than income. The till still takes the payment: the portal posts
intent.

## 4. Visits

Real visit history read from settled sales — date, outlet, covers, total, points
earned. No fabricated history: a new member sees an empty state that says what
will appear here after their first visit.

## 5. Rewards

The catalogue from the loyalty module: reward, cost in points, availability.
Redeeming creates a voucher the till can accept; it does not discount anything
on the phone.

---

## 6. Rules

- Points are a **liability**, not a discount. Earning credits 2200; redeeming
  debits it. The P&L never sees a point.
- Earn rate, tier thresholds and reward costs are configuration per chain.
- A member's data crosses outlets (that is the point of a chain loyalty scheme),
  but their **visits stay in the outlet that served them** — see
  `07-SECURITY-RLS.md`.
- Consent is recorded with a timestamp. A member can be exported and deleted.
