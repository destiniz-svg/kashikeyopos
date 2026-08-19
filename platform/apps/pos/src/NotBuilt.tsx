import type { NavGroup } from './nav';

/* The last resort, and it is now genuinely unreachable by the rail.
 *
 * This screen existed because most of the rail was unbuilt: §65 of the brief
 * says do not fake completion — no buttons that only toast, no screens that
 * look finished and do nothing — so an unbuilt module said exactly that rather
 * than pretending to be an empty state of real data.
 *
 * Every module in `nav.ts` is now built, and `deployable.test.js` fails if one
 * is added to the rail without being wired into `MODULES_BUILT`. So this is no
 * longer "not built yet"; it is "nothing answers to that id", which is a
 * different sentence and a real one — a `view` restored from an older release's
 * localStorage lands here rather than on a blank page.
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
          Nothing in this release answers to <code>{id}</code>. Every module in the rail
          is built, so you have most likely followed a link from an older version — pick
          one from the rail and it will open.
        </div>
      </div>
    </div>
  );
}
