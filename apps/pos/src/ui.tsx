import { useState } from 'react';
import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react';
import { useBreakpoint, useShortViewport } from './useBreakpoint';

/* The hover layer — design/KashikeyoPOS Guest Theme v3.dc.html, `style-hover`.
 *
 * The prototype puts a hover state on very nearly every control, and its own
 * note on why is worth keeping: "It only ever deepens what the rest state
 * already said." A hover never introduces a colour, never changes a border
 * radius and never moves anything — it takes the surface one step up the ramp
 * and, on a card, brings the border in from --line to --text. That is the whole
 * vocabulary, and it is why a till never flickers under a moving mouse.
 *
 * WHY THIS IS A COMPONENT AND NOT A CLASS. Every style in this build is inline,
 * transcribed literally from the prototype (docs/01-DESIGN-TOKENS.md). An
 * inline `background` beats any stylesheet rule, so a `.hover:hover{...}` class
 * could only win with `!important` — which would then also override the hover
 * a caller wanted somewhere else. Merging the two objects in JS is the version
 * with no precedence surprises.
 *
 * FOCUS GETS THE SAME TREATMENT. A till is driven by touch, but the back office
 * is driven by a keyboard, and a keyboard user tabbing through a menu grid
 * needs the same "you are on this one" the mouse gets. The focus RING is
 * separate and lives in pos.css under :focus-visible.
 */

interface Props extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'style'> {
  style?: CSSProperties;
  /** What to deepen to. Merged over `style`, so it only needs the differences. */
  hover?: CSSProperties;
  children?: ReactNode;
}

export function HButton({ style, hover, disabled, ...rest }: Props) {
  const [on, setOn] = useState(false);
  /* A disabled control does not answer. pos.css already dims it; lighting it up
     under the cursor as well would say "press me" about something that will
     refuse — the one message a till must never send. */
  const lit = on && !disabled;
  return (
    <button
      {...rest}
      disabled={disabled}
      style={lit && hover ? { ...style, ...hover } : style}
      onMouseEnter={(e) => { setOn(true); rest.onMouseEnter?.(e); }}
      onMouseLeave={(e) => { setOn(false); rest.onMouseLeave?.(e); }}
      onFocus={(e) => { setOn(true); rest.onFocus?.(e); }}
      onBlur={(e) => { setOn(false); rest.onBlur?.(e); }}
    />
  );
}

/* ── the two hovers this build actually uses ───────────────────────────────
   Named rather than repeated inline, so "deepen one step" is one decision in
   one place and every surface in the app agrees on what it means. */

/** A row, a chip, a rail button: one step up the surface ramp. */
export const LIFT: CSSProperties = { background: 'var(--bg-2)', color: 'var(--text)' };
/** A card that can be opened: the surface lifts AND the border comes in, which
 *  is what says "this whole tile is the target" rather than the text in it. */
export const LIFT_CARD: CSSProperties = { background: 'var(--bg-2)', borderColor: 'var(--text)' };
/** The one filled action on a surface. Its family darkens rather than lightens
 *  — a solid button that got paler under the cursor read as going away. */
export const LIFT_SOLID: CSSProperties = { background: 'var(--amber-deep)' };

/* ── the loading shape ─────────────────────────────────────────────────────
   The prototype draws skeletons rather than a spinner wherever the shape of
   the answer is known in advance, and says why: "the operator sees the shape
   of the answer and can aim their hand at it before it lands." A spinner in
   the middle of an empty grid tells them only that something is missing. */
export const shimmer: CSSProperties = {
  background: 'linear-gradient(90deg, var(--bg-1) 0%, var(--bg-2) 42%, var(--bg-1) 84%)',
  backgroundSize: '260% 100%',
  animation: 'kshimmer 1.05s linear infinite',
};

/* ── the dish photograph ───────────────────────────────────────────────────
   A PHOTOGRAPH THAT DOES NOT LOAD MUST NOT LEAVE A HOLE. The whole point of
   the artifact — the section's hue and the dish's initials — is that a dish
   ALWAYS has a shape in the position a photo would occupy, and drawing the
   photo as a CSS background quietly broke that: a URL that 404s, or a host the
   till cannot reach behind a restaurant's wifi, paints nothing at all and the
   tile goes blank. A merchant who pasted a bad address is told nothing.

   An <img> is used precisely because it can fail out loud. On error the
   artifact takes over, and that is also what happens for a dish with no
   photograph at all — one code path, one appearance, whether the address is
   absent or unreachable. */
export function DishPhoto({ url, tint, ink, text, dimmed, size = 19 }: {
  url: string | null | undefined;
  tint: string; ink: string; text: string;
  /** How big the initials are. A 40px avatar in a list and a 168px tile on the
   *  till want very different type, and the artifact has to stay legible in
   *  both — it is the only thing identifying the dish when there is no photo. */
  size?: number;
  /** An off-menu dish. Struck through is unreadable on a picture, so a
   *  photograph is DRAINED instead and the artifact simply recedes. */
  dimmed?: boolean;
}) {
  const [broken, setBroken] = useState(false);
  const show = url && !broken;
  return (
    <span style={{
      position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
      background: show ? 'var(--bg-2)' : tint, overflow: 'hidden',
    }}>
      {show
        ? (
          <img
            src={url}
            alt=""
            onError={() => setBroken(true)}
            style={{
              width: '100%', height: '100%', objectFit: 'cover', display: 'block',
              filter: dimmed ? 'grayscale(1) brightness(.5)' : undefined,
            }}
          />
        )
        : (
          <span style={{
            fontSize: size, fontWeight: 800, letterSpacing: '-.02em',
            color: ink, opacity: dimmed ? .45 : 1,
          }}>{text}</span>
        )}
    </span>
  );
}

/* ── the busy mark ─────────────────────────────────────────────────────────
   The prototype spins this whenever a control is waiting on the server, and
   the reason is the same one behind the press feedback in pos.css: a till is
   tapped thousands of times a shift, and a button that has changed its label
   to "Saving…" but is otherwise motionless reads as frozen. A frozen button
   gets tapped again.

   Under reduced motion pos.css redefines kspin as a fade rather than removing
   it, so "still working" survives even when the rotation does. */
export function Busy({ size = 13 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
      strokeWidth="2.6" strokeLinecap="round" aria-hidden
      style={{ flexShrink: 0, animation: 'kspin .8s linear infinite' }}>
      <path d="M12 3a9 9 0 1 0 9 9" />
    </svg>
  );
}

/* ── the toast ─────────────────────────────────────────────────────────────
   design/KashikeyoPOS Guest Theme v3.dc.html, `toastStyle`. Bottom centre,
   pill, `ktoast` in — and on a refusal, `ktoastshake` on top of it.

   WHY THE SHAKE IS THE POINT. A toast that replaces an identical toast is
   invisible: ring the same dish twice, get "added" twice, see one message that
   never appeared to change. The shake is what makes the SECOND one announce
   itself, and the prototype reserves it for errors — where "it did not work,
   again" is precisely the message a cashier misses.

   WHY NOT AN INLINE BANNER. The till's inline flash lived at the top of the
   ticket panel, which is where the operator is NOT looking: they are looking at
   the guest, or at the dish grid. Bottom centre is the one part of a POS screen
   the eye passes over between every tap.
*/
export type ToastTone = 'ok' | 'warn' | 'err';

export function Toast({ text, tone, seq }: { text: string; tone: ToastTone; seq: number }) {
  if (!text) return null;
  const skin = tone === 'err'
    ? { background: 'var(--red)', color: '#fff', border: '1px solid var(--red)' }
    : tone === 'warn'
      ? { background: 'var(--warn-dim)', color: 'var(--warn-bright)', border: '1px solid var(--warn-line)' }
      : { background: 'var(--warn)', color: 'var(--on-warn, var(--bg))', border: '1px solid var(--warn)' };
  return (
    <div
      /* KEYED ON THE SEQUENCE, so React remounts it and the animation runs
         again even when the text is identical to the last one. Without the key
         a repeated message is a silent no-op. */
      key={seq}
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed', left: '50%', bottom: 'calc(26px + env(safe-area-inset-bottom))',
        transform: 'translateX(-50%)', zIndex: 90,
        maxWidth: 'calc(100vw - 28px)', textAlign: 'center', textWrap: 'pretty',
        padding: '11px 20px', borderRadius: 24,
        fontSize: 12.5, fontWeight: 600, lineHeight: 1.4,
        boxShadow: '0 8px 30px rgba(0,0,0,.5)',
        animation: tone === 'err' ? 'ktoast .18s, ktoastshake .38s .1s' : 'ktoast .18s',
        ...skin,
      }}
    >{text}</div>
  );
}

/* ── the skeleton ──────────────────────────────────────────────────────────
   The other half of the note above `shimmer`. Wherever a module used to print
   the word "Reading…" into an empty panel, it now draws the SHAPE of the answer
   that is coming: rows of the right height, in the right place, sweeping.

   WHY THE SHAPE AND NOT THE WORD. A back-office screen is opened to look
   something up, and the operator's hand is already moving towards where they
   expect the row to be. A centred word gives them nothing to aim at and, worse,
   is indistinguishable from "there is nothing here" — the two states a manager
   most needs told apart, because one means wait and the other means act.

   ITS RAMP IS bg-2 → bg-3, not the bg-1 → bg-2 of `shimmer`. A skeleton sits ON
   a card, which is already --bg-1; sweeping between --bg-1 and --bg-2 on a
   --bg-1 surface is all but invisible in the light theme, where the whole ramp
   is compressed into the top few percent of lightness. One step further up
   reads in both.

   IT ANNOUNCES ITSELF ONCE. role="status" with a single visually-hidden word,
   rather than aria-label on every bar — a screen reader should hear "reading"
   once, not five times. */
export function Skeleton({ rows = 4, height = 34, gap = 8 }: {
  rows?: number; height?: number; gap?: number;
}) {
  return (
    <div role="status" aria-live="polite" style={{ display: 'grid', gap }}>
      <span style={{
        position: 'absolute', width: 1, height: 1, margin: -1,
        overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap',
      }}>Reading…</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} aria-hidden style={{
          height, borderRadius: 8,
          background: 'linear-gradient(90deg, var(--bg-2) 0%, var(--bg-3) 42%, var(--bg-2) 84%)',
          backgroundSize: '260% 100%',
          /* Staggered, so the sweep travels DOWN the list rather than every bar
             pulsing in lockstep — which reads as a flashing block, not motion. */
          animation: 'kshimmer 1.05s linear infinite',
          animationDelay: (i * 0.08).toFixed(2) + 's',
        }} />
      ))}
    </div>
  );
}

/* ── the overlay ───────────────────────────────────────────────────────────
   design/KashikeyoPOS Guest Theme v3.dc.html, `scrimStyle` / `modalStyle` /
   `modalPad`. One component, because the prototype has one rule and this build
   had nineteen hand-rolled copies of a fragment of it.

   ON A PHONE A DIALOG IS NOT A SMALL DIALOG — IT IS A SHEET. It is anchored to
   the bottom edge, full width, rounded only along the top, and it rises rather
   than scaling in. That is not decoration. A phone is held low and worked with
   a thumb, and a card floating in the middle of the glass puts its buttons in
   the one band the thumb cannot reach; the same card also leaves a strip of
   dead scrim down each side, which is the part of the screen a thumb CAN reach.
   Every back-office dialog here was a centred card with 20px of inset at every
   width, so on a 390px phone the useful area was 350px with the actions in the
   middle of the screen.

   HEIGHT DECIDES THE INSET. `modalPad` is 0 on a phone (the sheet owns the
   width), 12 on a short viewport and 28 otherwise — a 620px-tall laptop window
   cannot afford to give 56px of its height to scrim, and the prototype spends
   it on the dialog instead.

   dvh, NOT vh. A phone's address bar collapses as the page scrolls and `vh` is
   frozen at the tallest state, so a footer measured in vh sits under the fold
   exactly when the bar is showing — which is when the sheet first opens.

   THE PANEL IS A FLEX COLUMN THAT CLIPS. Children lay out as header / body /
   footer with the body scrolling, so the footer's actions stay on screen no
   matter how long the body is; `overflow:hidden` makes the card clip its own
   corners rather than letting a wide child square them off. Three of the
   nineteen scrolled the whole panel instead, which slid their Save button off
   the bottom of a long form — `scroll` reproduces that shape for them without
   giving up the sizing.

   THE SCRIM IS BLURRED. 3px, the prototype's figure: enough that the screen
   behind reads as "still there, not now", which a flat wash does not say. */
export function Overlay({ onClose, label, width = 520, scroll, pad, z = 80, children }: {
  onClose: () => void;
  /** Names the dialog for a screen reader. */
  label: string;
  /** How wide it may get on tablet and desktop. The phone sheet is full width. */
  width?: number;
  /** Scroll the whole panel rather than laying children out as header/body/footer. */
  scroll?: boolean;
  /** Padding inside the panel — only for `scroll`, which has no header of its own. */
  pad?: number;
  /** Above another overlay. The credit note opens ON TOP of the receipt drawer
   *  that raised it; it is a DOM descendant so it would paint above anyway, but
   *  a number that says so survives somebody moving the call site. */
  z?: number;
  children?: ReactNode;
}) {
  const isPhone = useBreakpoint() === 'm';
  const short = useShortViewport();
  const inset = isPhone ? 0 : short ? 12 : 28;

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: z,
        background: 'var(--scrim)', backdropFilter: 'blur(3px)',
        display: 'flex', animation: 'kfade .14s',
        ...(isPhone
          ? { alignItems: 'flex-end', justifyContent: 'stretch', padding: 0 }
          : { alignItems: 'center', justifyContent: 'center', padding: inset }),
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg-1)',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
          ...(isPhone
            ? {
              borderTop: '1px solid var(--line)',
              borderRadius: '16px 16px 0 0',
              boxShadow: '0 -14px 50px rgba(0,0,0,.6)',
              width: '100%', maxWidth: '100vw', maxHeight: '92dvh',
              animation: 'ksheet .2s',
            }
            : {
              border: '1px solid var(--line)',
              borderRadius: 14,
              boxShadow: 'var(--shadow-lg)',
              width: '100%',
              maxWidth: `min(${width}px, calc(100vw - ${inset * 2}px))`,
              maxHeight: `calc(100dvh - ${inset * 2}px)`,
              animation: 'kmodal .18s',
            }),
        }}
      >
        {scroll
          ? <div style={{ minHeight: 0, overflowY: 'auto', padding: pad ?? 18 }}>{children}</div>
          : children}
      </div>
    </div>
  );
}
