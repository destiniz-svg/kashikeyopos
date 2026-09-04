/** The 404. It offers the two ways back rather than a dead end. */
import Link from 'next/link'

export default function NotFound() {
  return (
    <main
      style={{
        minHeight: '70vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        padding: '120px 24px',
        gap: 18,
      }}
    >
      <div style={{ fontSize: 11, letterSpacing: '.36em', textTransform: 'uppercase', color: 'var(--gold-ink)' }}>Not found</div>
      <h1 style={{ fontFamily: "var(--font-display),'Outfit',system-ui,sans-serif", fontWeight: 300, fontSize: 48, lineHeight: 1.05, margin: 0 }}>
        That page has moved on.
      </h1>
      <p style={{ color: 'var(--muted)', fontSize: 15, margin: 0, maxWidth: 460, lineHeight: 1.6 }}>
        The property or destination you were looking for is not published here. Our specialists can point you at the right island.
      </p>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', justifyContent: 'center', marginTop: 8 }}>
        <Link href="/" style={{ background: '#E0B94F', color: '#00102F', padding: '13px 22px', fontSize: 13, fontWeight: 600, borderRadius: 2 }}>
          Back to the collection
        </Link>
        <Link href="/#offers" style={{ border: '1px solid var(--line-2)', color: 'var(--ink)', padding: '13px 22px', fontSize: 13, borderRadius: 2 }}>
          See current offers
        </Link>
      </div>
    </main>
  )
}
