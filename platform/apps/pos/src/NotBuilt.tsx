import type { NavGroup } from './nav';

/* An honest placeholder.
 *
 * The rail carries all 31 modules because the rail is the design. Only the POS
 * Floor is built in this deployment. §65 of the brief: do not fake completion —
 * no buttons that only toast, no screens that look finished and do nothing. So
 * an unbuilt module says exactly that, names what it will hold when it lands,
 * and does not pretend to be an empty state of real data.
 *
 * This is the one screen in the app that is NOT in the prototype, because the
 * prototype had every module. It uses only existing tokens.
 */
export function NotBuilt({ id, groups }: { id: string; groups: NavGroup[] }) {
  const item = groups.flatMap((g) => g.items).find((i) => i.id === id);
  return (
    <div style={{ height: '100%', display: 'grid', placeItems: 'center', padding: 24 }}>
      <div style={{ maxWidth: 460, textAlign: 'center' }}>
        <div style={{
          width: 44, height: 44, margin: '0 auto', borderRadius: 11,
          background: 'var(--bg-2)', color: 'var(--text-faint)',
          display: 'grid', placeItems: 'center',
        }}>
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d={item?.icon ?? 'M12 8v4M12 16h.01M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z'} />
          </svg>
        </div>
        <div style={{ marginTop: 14, fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>
          {item?.label ?? id}
        </div>
        <div style={{ marginTop: 8, fontSize: 12.5, lineHeight: 1.65, color: 'var(--text-muted)' }}>
          This module is not built in this deployment yet. It is in the rail because
          the rail is the finished design — but nothing behind it is real, and a screen
          that looked finished would be worse than this sentence.
        </div>
        <div style={{ marginTop: 12, fontSize: 11.5, lineHeight: 1.6, color: 'var(--text-faint)' }}>
          Built so far: POS Floor, payment, and the offline outbox behind them.
        </div>
      </div>
    </div>
  );
}
