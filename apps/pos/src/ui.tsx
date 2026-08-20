import { useState } from 'react';
import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react';

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
