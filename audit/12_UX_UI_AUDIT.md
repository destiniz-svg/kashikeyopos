# 12 · UX / UI audit

Grounded in the design-audit round (task #29), the copy-vs-behaviour sweep
(#51), and this week's driven sessions. The existing visual language was
preserved throughout; changes were correctness/accessibility only.

Measured green, all three services (a11y suite, 6/6 this pass, zero skips):
- Contrast: every visible text run vs the surface it actually paints on
  (gradient-aware walk) clears WCAG AA; the muted ramps were re-inked to
  clear AA on white (3.44→1.89:1 offenders now ≥4.5:1); both themes measured
  (e.g. 9.1:1 light / 8.5:1 dark on the account page's messages).
- Keyboard: focus visible on every control (`:focus-visible` + outline —
  decorative shadows don't count), no traps; pinned statically too.
- Touch: no target under 44px short-axis on phone layouts (responsive suite
  measures 390/924/1440; in-table controls raised; 60px rail targets 51×44).
- States: loading, empty ("Nothing counted on this outlet yet" — never an
  invented figure), error (server's own sentence), destructive confirms
  (two-tap arm with 4 s expiry for cooking voids; typed RESTORE removed with
  the fake restore).
- Speed of workflow: settle is one screen with keypad + quick notes; +1 on
  the card face; mis-tap is a step-down correction, not a void; rails scroll
  and never wrap; long lists page.
- Errors name themselves: gated actions refuse with wording ("this needs a
  manager"), refusals carry the server's sentence (parked lane, lock screen).

Open (stated): modal-by-modal browser sweep and screen-reader pass (see 15).
