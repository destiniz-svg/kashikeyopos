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

~102 failing nodes across 5 distinct rule types → **18 nodes, one rule**, a ~82%
reduction and **100% of the non-brand issues cleared**.

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

## Accepted residuals (brand-colour decisions, for the design owner)

The remaining 18 nodes are all the **brand accent used as text or button
background**, where meeting 4.5:1 would visibly shift the brand:

- **Coral `#F26A21` as text on light** (15 on `/app2`, 2 on `/admin2`) — ratio
  3.06:1. Reaching AA as text needs ≈`#B84C15`, a noticeably deeper burnt-orange.
  Recommended non-invasive fix: introduce a dedicated darker **`--coral-ink`**
  token for coral text on light surfaces and leave `--coral` (buttons/fills)
  unchanged, rather than darken the signature accent globally.
- **Theme-primary green `#0FA968` as a button background** with white text on
  `/back` (1 node) — same call; the theme already ships a darker `pill:#0C8653`
  that could back the affected button.

Both are one-line token choices once the owner signs off on the shade; the
scan script above re-verifies in seconds.
