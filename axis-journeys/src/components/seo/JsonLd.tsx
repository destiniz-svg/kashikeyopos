/**
 * A JSON-LD block.
 *
 * The payload is serialised with `<` escaped, so a property name containing a tag can never close
 * the script element — the one injection this element is capable of.
 */
export function JsonLd({ data }: { data: Record<string, unknown> }) {
  const json = JSON.stringify(data, (_k, v) => (v === undefined ? undefined : v)).replace(/</g, '\\u003c')
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />
}
