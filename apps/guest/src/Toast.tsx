import { useEffect } from 'react';

/* The prototype's toast, verbatim from its `toastStyle`:
   position:absolute;left:18px;right:18px;bottom:112px;z-index:60;padding:13px 16px;
   border-radius:15px;background:rgba(20,20,22,.94);color:#fff;font-size:13.5px;
   font-weight:600;line-height:1.45;text-align:center;animation:qfade .16s;
   box-shadow:0 10px 30px rgba(0,0,0,.3)

   role="status" so a screen reader announces it without stealing focus — the
   guest may be mid-tap when it appears. 58 §Accessibility: improve the
   semantics, do not redesign the thing. */
export function Toast({ message, onDone }: { message: string; onDone: () => void }) {
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(onDone, 2600);
    return () => clearTimeout(t);
  }, [message, onDone]);

  if (!message) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'absolute', left: 18, right: 18, bottom: 112, zIndex: 60,
        padding: '13px 16px', borderRadius: 15, background: 'rgba(20,20,22,.94)',
        color: '#fff', fontSize: 13.5, fontWeight: 600, lineHeight: 1.45,
        textAlign: 'center', animation: 'qfade .16s', boxShadow: '0 10px 30px rgba(0,0,0,.3)',
      }}
    >
      {message}
    </div>
  );
}
