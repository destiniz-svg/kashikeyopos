import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

/* ── Kashikeyo DS 1.0 — shared primitives ────────────────────────────────────
   The single component vocabulary for the till (and the pattern reference for
   /back). Rules the primitives enforce so screens can't drift:
     · every tappable ≥ var(--tap) (44px); register-critical actions --tap-lg
     · icon-only buttons REQUIRE an aria-label (IconBtn's prop is mandatory)
     · destructive paths go through Btn danger / useToast undo, never bare ✕
     · modals always: ✕ button, Escape, scrim-tap, focus trap
     · status colors come from one Badge map (incl. "In kitchen" = info/blue)
   Type roles (from the DS scale — use these, not ad-hoc px):
     t11 overline/tags · t12 caption · t13 body · t15 input/body-lg
     t17 title · t20 screen title · t24 modal hero · t32 money hero */

export const FS = { t11: 11, t12: 12, t13: 13, t15: 15, t17: 17, t20: 20, t24: 24, t32: 32 } as const;

/* ── Button ── */
type BtnVariant = "primary" | "secondary" | "ghost" | "danger";
const BTN_BASE: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8,
  minHeight: "var(--tap)", padding: "0 var(--s5)", borderRadius: "var(--r-m)",
  fontSize: FS.t15, fontWeight: 700, whiteSpace: "nowrap",
  transition: "filter var(--dur-1) var(--ease), background var(--dur-1) var(--ease)",
};
const BTN_VARIANTS: Record<BtnVariant, React.CSSProperties> = {
  primary: { background: "var(--coral)", color: "var(--coralink)", boxShadow: "0 8px 20px -6px rgba(225,85,45,.5)" },
  secondary: { background: "var(--sur)", color: "var(--ink)", border: "1.5px solid var(--line)" },
  ghost: { background: "var(--sur2)", color: "var(--ink2)" },
  danger: { background: "var(--red)", color: "#fff" },
};
export function Btn({ variant = "primary", size = "md", disabled, style, children, ...rest }:
  { variant?: BtnVariant; size?: "md" | "lg" } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button disabled={disabled} {...rest}
      style={{ ...BTN_BASE, ...BTN_VARIANTS[variant],
        ...(size === "lg" ? { minHeight: "var(--tap-lg)", fontSize: FS.t17, borderRadius: "var(--r-l)" } : {}),
        ...(disabled ? { opacity: .45, cursor: "default" } : {}), ...style }}>
      {children}
    </button>
  );
}

/* ── IconBtn — 44px hit area, aria-label is REQUIRED (kills the ✕-span). ── */
export function IconBtn({ label, tone = "neutral", size, style, children, ...rest }:
  { label: string; tone?: "neutral" | "danger"; size?: number } & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "aria-label">) {
  const s = size || 44;
  return (
    <button aria-label={label} title={label} {...rest}
      style={{ width: s, height: s, minWidth: s, borderRadius: "var(--r-s)", display: "inline-flex",
        alignItems: "center", justifyContent: "center", background: "var(--sur2)",
        color: tone === "danger" ? "var(--red)" : "var(--ink2)", fontSize: 16, lineHeight: 1, ...style }}>
      {children}
    </button>
  );
}

/* ── Chip — filter/category pill; selected = ink-filled (register menu). ── */
export function Chip({ on, style, children, ...rest }: { on?: boolean } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...rest} aria-pressed={!!on}
      style={{ whiteSpace: "nowrap", minHeight: "var(--tap)", padding: "0 var(--s4)", borderRadius: 999,
        fontSize: FS.t13, fontWeight: 700, flex: "0 0 auto",
        color: on ? "var(--bg)" : "var(--ink2)", background: on ? "var(--ink)" : "var(--sur)",
        border: "1px solid " + (on ? "var(--ink)" : "var(--line)"), ...style }}>
      {children}
    </button>
  );
}

/* ── Badge — the ONE status-pill map (soft bg + strong AA text). ── */
export type Tone = "ok" | "warn" | "danger" | "info" | "muted" | "brand";
const TONES: Record<Tone, [string, string]> = {
  ok: ["var(--greensoft)", "var(--green)"], warn: ["var(--ambersoft)", "var(--amber)"],
  danger: ["var(--redsoft)", "var(--red)"], info: ["var(--bluesoft)", "var(--blue)"],
  muted: ["var(--sur2)", "var(--ink2)"], brand: ["var(--coralsoft)", "var(--coral-text)"],
};
export function Badge({ tone = "muted", dot, style, children }:
  { tone?: Tone; dot?: boolean; style?: React.CSSProperties; children: React.ReactNode }) {
  const [bg, fg] = TONES[tone];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: FS.t11, fontWeight: 800,
      letterSpacing: ".02em", padding: "3px 9px", borderRadius: 999, background: bg, color: fg, ...style }}>
      {dot && <i style={{ width: 6, height: 6, borderRadius: 99, background: "currentColor", display: "inline-block" }} />}
      {children}
    </span>
  );
}

/* ── Field — label + 48px input + hint/error; the one form row. ── */
export function Field({ label, hint, error, style, inputStyle, ...rest }:
  { label: string; hint?: string; error?: string; inputStyle?: React.CSSProperties } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label style={{ display: "block", ...style }}>
      <span style={{ display: "block", fontSize: FS.t12, fontWeight: 700, color: "var(--ink2)", marginBottom: 6 }}>{label}</span>
      <input {...rest} style={{ width: "100%", height: 48, padding: "0 var(--s4)", borderRadius: "var(--r-s)",
        border: "1px solid " + (error ? "var(--red)" : "var(--line)"), background: "var(--sur)",
        color: "var(--ink)", fontSize: FS.t15, outline: "none", ...inputStyle }} />
      {(error || hint) && <span style={{ display: "block", fontSize: FS.t12, marginTop: 5, color: error ? "var(--red)" : "var(--ink3)" }}>{error || hint}</span>}
    </label>
  );
}

/* ── Modal — scrim, ✕, Escape, focus trap. Sheet = bottom-anchored variant. ── */
function useTrap(ref: React.RefObject<HTMLDivElement>, onClose: () => void) {
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const sel = "button,[href],input,select,textarea,[tabindex]:not([tabindex='-1'])";
    const first = ref.current?.querySelector<HTMLElement>(sel);
    (first || ref.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); return; }
      if (e.key !== "Tab" || !ref.current) return;
      const items = [...ref.current.querySelectorAll<HTMLElement>(sel)].filter((el) => !el.hasAttribute("disabled"));
      if (!items.length) return;
      const i = items.indexOf(document.activeElement as HTMLElement);
      if (e.shiftKey && (i <= 0)) { e.preventDefault(); items[items.length - 1].focus(); }
      else if (!e.shiftKey && (i === items.length - 1 || i < 0)) { e.preventDefault(); items[0].focus(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("keydown", onKey, true); prev?.focus?.(); };
  }, []);
}
export function Modal({ title, onClose, width = 440, sheet, children, footer }:
  { title: string; onClose: () => void; width?: number; sheet?: boolean; children: React.ReactNode; footer?: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useTrap(ref, onClose);
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(20,18,15,.42)", zIndex: 40,
      display: "flex", alignItems: sheet ? "flex-end" : "center", justifyContent: "center", animation: "fade var(--dur-2)" }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} onClick={(e) => e.stopPropagation()}
        style={{ width: sheet ? "100%" : `min(${width}px,94vw)`, maxHeight: sheet ? "88dvh" : "90dvh",
          display: "flex", flexDirection: "column", background: "var(--bg)", boxShadow: "var(--shadow-float)",
          borderRadius: sheet ? "var(--r-xl) var(--r-xl) 0 0" : "var(--r-xl)",
          paddingBottom: sheet ? "var(--sab,0px)" : 0, animation: "sheet var(--dur-2) var(--ease)", outline: "none" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "var(--s4) var(--s5) var(--s3)" }}>
          <div style={{ flex: 1, fontWeight: 800, fontSize: FS.t20 }}>{title}</div>
          <IconBtn label="Close" onClick={onClose}>✕</IconBtn>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "0 var(--s5) var(--s5)" }}>{children}</div>
        {footer && <div style={{ padding: "var(--s3) var(--s5) var(--s5)", borderTop: "1px solid var(--line)" }}>{footer}</div>}
      </div>
    </div>
  );
}

/* ── Stepper — 40px keys in a 44px row; the register's most-tapped control. ── */
export function Stepper({ value, onInc, onDec, decLabel = "Remove one", incLabel = "Add one" }:
  { value: number; onInc: () => void; onDec: () => void; decLabel?: string; incLabel?: string }) {
  const key: React.CSSProperties = { width: 40, height: 40, borderRadius: 99, background: "var(--sur)",
    color: "var(--ink)", fontSize: 19, fontWeight: 700, display: "inline-flex", alignItems: "center",
    justifyContent: "center", lineHeight: 1, boxShadow: "0 1px 2px rgba(30,35,45,.10)" };
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 2, background: "var(--coralsoft)", borderRadius: 999, padding: 2, minHeight: "var(--tap)" }}>
      <button aria-label={decLabel} onClick={onDec} style={key}>−</button>
      <span className="num" aria-live="polite" style={{ minWidth: 26, textAlign: "center", fontWeight: 800, fontSize: FS.t15 }}>{value}</span>
      <button aria-label={incLabel} onClick={onInc} style={key}>+</button>
    </span>
  );
}

/* ── Toast — bottom pill with optional Undo; the recovery path for deletes. ── */
type ToastMsg = { id: number; text: string; action?: { label: string; fn: () => void } };
const ToastCtx = createContext<(text: string, action?: ToastMsg["action"]) => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  const push = useCallback((text: string, action?: ToastMsg["action"]) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, text, action }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), action ? 6000 : 3600);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div aria-live="polite" style={{ position: "fixed", left: 0, right: 0, bottom: "calc(18px + var(--sab,0px))",
        display: "flex", flexDirection: "column", alignItems: "center", gap: 8, zIndex: 70, pointerEvents: "none" }}>
        {toasts.map((t) => (
          <div key={t.id} style={{ pointerEvents: "auto", display: "flex", alignItems: "center", gap: 14,
            background: "var(--ink)", color: "var(--bg)", borderRadius: 999, padding: "12px 20px",
            fontSize: FS.t13, fontWeight: 600, boxShadow: "var(--shadow-float)", animation: "toastin var(--dur-2) var(--ease)" }}>
            {t.text}
            {t.action && (
              <button onClick={() => { t.action!.fn(); setToasts((x) => x.filter((y) => y.id !== t.id)); }}
                style={{ color: "var(--coral)", fontWeight: 800, fontSize: FS.t13, minHeight: 32, padding: "0 4px" }}>
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/* ── EmptyState — icon, headline, one-line hint, optional action. ── */
export function EmptyState({ icon, title, hint, action }:
  { icon: React.ReactNode; title: string; hint?: string; action?: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      textAlign: "center", gap: 8, padding: "40px 24px", color: "var(--ink3)" }}>
      <div style={{ fontSize: 30, lineHeight: 1 }}>{icon}</div>
      <div style={{ fontWeight: 700, fontSize: FS.t15, color: "var(--ink2)" }}>{title}</div>
      {hint && <div style={{ fontSize: FS.t13, maxWidth: 340, lineHeight: 1.5 }}>{hint}</div>}
      {action && <div style={{ marginTop: 8 }}>{action}</div>}
    </div>
  );
}
