/**
 * Wiring: a control does what it says, and the things a browser cannot cheaply prove.
 *
 * Each of these pins a defect that shipped. They are static reads of the source because what they
 * hold still is a SHAPE — one definition rather than two, a navigation rather than a state change —
 * and a drive can only ever show you the symptom on the one page it happened to visit.
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

const read = (p: string): string => readFileSync(p, 'utf8')
const HEADER = 'src/components/site/sections/Header.tsx'
const MOBILE = 'src/components/site/sections/MobileMenu.tsx'
const STATE = 'src/components/site/state.tsx'

describe('the curated quick paths are one list', () => {
  it('neither menu declares its own', () => {
    // The header held the four inline, which is how the phone came to have none at all: a second
    // component nobody copied them into. A second copy is also how two menus come to offer
    // different journeys under one name.
    for (const f of [HEADER, MOBILE]) {
      const src = read(f)
      assert.equal(/Overwater icons|Private islands|Honeymoons under|Family villas/.test(src), false, `${f} carries its own copy of the list`)
      assert.match(src, /availableQuickPaths/, `${f} does not read the shared list`)
    }
  })

  it('the phone draws them at all', () => {
    const src = read(MOBILE)
    assert.match(src, /Curated quick paths/, 'the phone menu has no quick paths section')
    assert.match(src, /actions\.apply\(q\.apply\)/, 'the phone draws them without wiring them')
  })
})

describe('the Destinations trigger', () => {
  it('does not toggle on click, because hover has already opened it', () => {
    // `onMouseEnter` fires first, so with a mouse the menu is open by the time the click lands and
    // a toggle can only ever shut it again. Measured: clicking "Destinations" showed nothing.
    const src = read(HEADER)
    assert.equal(/onClick=\{actions\.toggleMega\}/.test(src), false, 'the click still toggles')
    assert.match(src, /hover: hover/, 'the click does not distinguish a pointer that hovers')
  })
})

describe('a control that leaves the page it is on', () => {
  it('apply() looks for the Selection before pretending to have filtered it', () => {
    // On a destination page it wrote filters that page does not read, scrolled to an id that is
    // not on it, and toasted "3 journeys match" over a screen where nothing had moved.
    const src = read(STATE)
    assert.match(src, /getElementById\('selection'\)/, 'apply() does not check where it is standing')
    assert.match(src, /filtersToQuery/, 'a filter set does not survive the navigation')
  })

  it('a section label on a destination page navigates rather than swapping the page underneath', () => {
    // It set `page: null`, which rendered the home page while the address still read
    // /destinations/maldives — so a reload came back to the destination and the link was
    // unshareable.
    const src = read(STATE)
    assert.match(src, /onDestPage && !extra[\s\S]{0,400}window\.location\.assign\(`\/#\$\{id\}`\)/, 'leaving a destination page is still a state change')
  })

  it('the arriving filter set is read once, and only where the Selection is', () => {
    const src = read(STATE)
    assert.match(src, /filtersFromQuery\(new URLSearchParams\(window\.location\.search\)\)/)
    assert.match(src, /if \(arrived\.current \|\| initialPage\) return/, 'it would re-apply, or run on a destination page')
  })
})
