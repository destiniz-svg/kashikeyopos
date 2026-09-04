/**
 * Regenerate `src/data/seed.ts` from the design handoff package.
 *
 *   node scripts/build-seed.mjs ../design_handoff_axis_journeys
 *
 * The handoff's `buildSeed()` is executed rather than transcribed: the catalogue is real business
 * content and retyping it is how a price, a transfer time or a cancellation clause quietly changes.
 */
import { writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const pkg = process.argv[2]
if (!pkg) {
  console.error('usage: node scripts/build-seed.mjs <path to design_handoff_axis_journeys>')
  process.exit(1)
}

const seedModule = pathToFileURL(resolve(pkg, 'prototype/admin/seed.js')).href
const { buildSeed } = await import(seedModule)
const data = buildSeed()

const counts = {
  properties: data.properties.length,
  offers: data.offers.length,
  destinations: data.destinations.length,
}
console.log('[build-seed]', JSON.stringify(counts))

const header = `/**
 * The canonical Axis Journeys catalogue.
 *
 * Generated from \`design_handoff_axis_journeys/prototype/admin/seed.js\` (\`buildSeed()\`), which
 * composes the live content in \`admin/content-axis.js\`. This is production content — the real
 * properties, offers, destinations, company details and legal documents — not sample data.
 *
 * Regenerate with \`node scripts/build-seed.mjs <path to the handoff package>\`.
 * A TypeScript module rather than a JSON import so the Next build and the plain-node seeding CLI
 * read the same file through the same resolver.
 */
export const SEED = `

await writeFile(
  resolve(process.cwd(), 'src/data/seed.ts'),
  header + JSON.stringify(data, null, 1) + '\n\nexport default SEED\n',
  'utf8',
)
console.log('[build-seed] wrote src/data/seed.ts')
