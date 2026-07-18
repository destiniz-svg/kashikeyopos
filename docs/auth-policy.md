# Authentication policy — decision brief (audit §3.5 / SEC-03)

The last owner-only gate. Most of this is **policy you set now (free)**; a couple
are **small builds** you can opt into. It closes with a checklist to fill in.

---

## What's already solid (don't change)

- **Store & platform-admin logins are real security boundaries** — email +
  **bcrypt**-hashed password, server-verified, and now **rate-limited** (SEC-02:
  8 failures → 429). Cookies are `httpOnly`, `sameSite=lax`, `secure` in prod.
- **Tenant isolation** is enforced in Postgres (FORCE RLS + restricted role), not
  in app logic — a compromised session still can't reach another store's data.
- **`JWT_SECRET`** (which signs sessions *and* derives the DB-role password) is set
  and backed up.

## The three auth tiers — know which are boundaries

| Tier | Protects | Mechanism | A real security boundary? |
| --- | --- | --- | --- |
| **Store account** (owner → `/back`, till provisioning) | All of a store's data | email + **bcrypt** password → JWT | **Yes** — treat as the boundary |
| **Platform admin** (`/dev`) | *Every* store (cross-tenant) | email + **bcrypt** password → JWT | **Yes — highest value; harden most** |
| **Till PIN** (staff on the device) | *Which employee* you are on a shared till | weak DJB2 hash on-device | **No** — convenience only, by design |

The **till PIN is not security** — it's a "who's on shift" selector on a shared
device. The device is already authenticated by its Bearer token (issued at
sign-in). So **anything genuinely sensitive must sit behind the store
password/role, never behind the PIN.**

---

## Decisions to make now (policy — no code)

### 1. Minimum password policy  ·  *gap: currently unenforced*
Registration today accepts **any non-empty password** — no minimum length. For
accounts that guard real money, set a minimum. **Recommendation: require ≥ 8
characters** (block the obvious "1"/"pin"-style passwords). This is a ~5-line
backend change I can make on request — say the word and it's done on `staging`.

### 2. What counts as a "sensitive action"  ·  *refunds now server-enforced*
**Shipped (SEC-03):** refunds are now gated on the **server-verified store
password**, not the PIN. The till prompts for the password when a refund syncs
while online and exchanges it (`POST /api/elevate`, bcrypt-verified, login-
throttled, 15-min token) for a server-side `managerApproved` stamp. A refund
without approval — offline, skipped prompt, or a tampered client (client-supplied
approval is stripped; only the server's own stamp counts) — **still syncs** (money
data is never rejected) but lands **flagged in the /back Review tab**. Verified
end-to-end (approve / cached / skip / plain-sale paths) + 4 regression tests.

Still policy for the rest: price/discount overrides and reports remain PIN-gated
UI conventions — managers keep the password; don't hand the owner login to floor
staff. Extending hard server enforcement to those is a further build; ask and
I'll scope it.

### 3. Platform-admin (`/dev`) hardening
It's cross-tenant, so it's the crown jewel. **Now:** give it a **strong, unique**
password (not reused anywhere), and limit who knows it. It's seeded from
`PLATFORM_ADMIN_*` env vars — keep those in your vault. Consider **not** exposing
`/dev` publicly if you don't need it routinely.

### 4. Session length & device loss
Store sessions last **365 days**, admin **30 days** (long, for POS convenience).
There is **no server-side revocation** — a lost/stolen device's token stays valid
until expiry. Decide your posture:
- **Accept** the long session (typical for dedicated till hardware you physically
  control) — just physically secure the devices.
- **On device loss:** the blunt lever is rotating `JWT_SECRET` (logs *everyone*
  out and re-keys the DB role on next boot — effective but disruptive). A targeted
  **per-device revocation** feature is a build if you expect device churn.

---

## Optional builds (opt in later, not launch blockers)

- **MFA for high-value logins.** None today. **Recommendation: add MFA (TOTP) to
  the platform-admin `/dev`** first (cross-tenant = highest value); owner-account
  MFA is optional and adds POS friction. This is a build — flag it if you want it
  scoped.
- **Per-role server enforcement** of sensitive actions (see #2).
- **Per-device session revocation** (see #4).

---

## Set these now — checklist

- [ ] **Password minimum** decided (recommend ≥ 8 chars). If yes → ask me to add
      the check.
- [ ] **Sensitive-action policy** written down (voids/refunds/price edits/reports
      require the manager password; PIN is not a gate for these).
- [ ] **Platform-admin** password is strong, unique, vaulted; `/dev` exposure
      reviewed.
- [ ] **Session posture** accepted (365-day) **or** flagged for a revocation build;
      staff know the device-loss procedure.
- [ ] **MFA** decision recorded (recommend: yes for `/dev`, optional for owners).

Filling these in — plus the ≥8-char check if you want it — satisfies §3.5. The
foundations (bcrypt, RLS, throttling, backed-up secret) are already in place; this
gate is about **policy and a couple of optional hardening builds**, not fixing a
hole.
