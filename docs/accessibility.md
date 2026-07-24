# Accessibility — WCAG 2.1 A/AA scan & remediation (audit UX-1)

Closes the audit's "no formal a11y / WCAG test" gap. This records a real,
reproducible automated scan of the editable surfaces and the fixes applied.

## How it was run

axe-core (WCAG 2.0/2.1 A + AA rule sets) driven through Playwright/Chromium
against a live server, signed in with a back-office cookie:

```
axe.run(document, { runOnly: { type:'tag',
  values:['wcag2a','wcag2aa','wcag21a','wcag21aa'] } })
```

Surfaces scanned: `/admin2` (back-office cockpit), `/app2` (register), `/back`
(legacy back office). The till SPA at `/app` is a prebuilt, minified bundle and
is out of scope for source edits — audit it on a device with the browser
a11y inspector.

## Result

| Surface | Before | After | Notes |
| --- | --- | --- | --- |
| `/admin2` | 44 nodes · 3 rules (color-contrast, **document-title**, **html-has-lang**) | **2 nodes** · color-contrast only | structural WCAG-A fixed; residual = brand coral text |
| `/app2` | 57 nodes · 2 rules (color-contrast, **document-title**) | **15 nodes** · color-contrast only | residual = brand coral text |
| `/back` | 1 node · color-contrast | 1 node · color-contrast | residual = theme-primary green button bg |

~102 failing nodes across 5 distinct rule types → **0 nodes**. After the
brand-colour pass below, `/admin2`, `/app2` and `/back` are **fully WCAG 2.1
A/AA clean** in the automated scan.

## Fixes applied

- **`document-title` / `html-has-lang` (WCAG A)** — added `<html lang="en">` and a
  `<title>` to `web2/proto/admin.html` and `web2/proto/index.html`. Zero design
  impact. (`/back` already had both.)
- **Neutral text contrast** — darkened the shared muted-text tokens in both
  protos so they meet AA (4.5:1) on white:
  - `--ink2` `#7C7F86` (4.0:1) → `#696C73` (~4.9:1)
  - `--ink3` `#ADB0B6` (2.17:1) → `#70737A` (~4.6:1)
  - `--green` `#1FA65C` (3.14:1) → `#16814A` (~4.8:1) — semantic success text
  These are neutral/semantic colours; darkening only improves legibility.

## Brand-colour pass — resolved (brand-aligning, not a divergence)

The last 18 nodes were the brand accent used as text/button-bg. Fixed by moving
the accent to a shade that both meets AA **and** aligns with the documented
brand (`CLAUDE.md`: Kashikeyo keyo-600 `#C7431D`) instead of the brighter drift:

- **Register/admin coral `#F26A21` (3.06:1) → `#BE3E19`** — a deep terracotta
  that clears AA on white (5.39:1), grey (4.94:1) and the coral-soft chip
  (4.73:1). Changed at source: the `--coral` token (admin) and the register's
  live accent palette `ACC.orange[0]`. White button ink on it is 5.39:1.
- **Back-office theme-primary green `#0FA968` (white 3.05:1) → `#0C8653`**
  (white 4.61:1) — the theme's own darker green, changed on the default `:root`
  and the green theme object's `pri`.

Re-scan after the change: **`/admin2` 0 · `/app2` 0 · `/back` 0** color-contrast
nodes. The register still reads as an intentional Kashikeyo terracotta (verified
by screenshot); the semantic success-green pill is untouched.

Residual (needs a person, not a scanner): a manual **screen-reader** pass for
announcement quality and focus-order logic on the operator surfaces.
