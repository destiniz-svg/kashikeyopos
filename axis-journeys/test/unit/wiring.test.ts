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

const SELECTION = 'src/components/site/sections/Selection.tsx'
const DRAWER = 'src/components/site/Drawer.tsx'
const APP = 'src/components/site/SiteApp.tsx'
const SITE = [
  'src/components/site/Drawer.tsx',
  'src/components/site/SiteApp.tsx',
  'src/components/site/state.tsx',
  'src/components/site/sections/DestinationPage.tsx',
  'src/components/site/sections/Destinations.tsx',
  'src/components/site/sections/Experiences.tsx',
  'src/components/site/sections/Footer.tsx',
  'src/components/site/sections/Header.tsx',
  'src/components/site/sections/Hero.tsx',
  'src/components/site/sections/MobileMenu.tsx',
  'src/components/site/sections/Offers.tsx',
  'src/components/site/sections/Overlays.tsx',
  'src/components/site/sections/Properties.tsx',
  'src/components/site/sections/RefinePanel.tsx',
  'src/components/site/sections/Selection.tsx',
  'src/components/site/sections/Story.tsx',
]

describe('every way to open a property is a control', () => {
  it('the Selection card carries a named button, not only a handler on the <article>', () => {
    // Measured before this: the card was a clickable <article> with no role and no tabindex, so
    // 70 tab stops walked the home page and not one of them could open a property — the site's
    // own primary action. The shortlist heart inside it was reachable; the card was not.
    const src = read(SELECTION)
    assert.match(src, /aria-label=\{`View \$\{c\.name\}, \$\{c\.dest\}`\}/, 'the card offers no named control')
    assert.match(src, /<button\s+type="button"\s+aria-label=\{`View /, 'the View affordance is not a button')
  })

  it('a swipe does not open the card it started on', () => {
    const src = read(SELECTION)
    assert.match(src, /dragged\.current = true/, 'a drag is not recorded')
    assert.match(src, /!dragged\.current && actions\.openDrawer/, 'the card opens even when the pointer was dragging')
  })
})

describe('a panel that calls itself a dialog behaves like one', () => {
  it('the drawer declares the role and takes the focus that goes with it', () => {
    // `aria-modal` tells a screen reader to stop announcing the page behind. Declaring it without
    // moving focus is worse than declaring nothing: measured at 25 of 25 Tab presses leaving the
    // panel while the reader had already fallen silent about the page underneath.
    const src = read(DRAWER)
    assert.match(src, /role="dialog"/, 'the drawer is not a dialog')
    assert.match(src, /aria-modal="true"/)
    assert.match(src, /useDialogFocus\(s\.drawerVisible, panel\)/, 'nothing moves or traps focus')
  })

  it('there is one definition of that behaviour, and every dialog uses it', () => {
    const hook = read('src/components/ui/dialog.ts')
    assert.match(hook, /export function useDialogFocus/)
    for (const f of SITE) {
      const src = read(f)
      if (!/role="dialog"/.test(src)) continue
      assert.match(src, /useDialogFocus\(/, `${f} claims to be a dialog and manages no focus`)
    }
  })
})

describe('motion the visitor asked not to have', () => {
  it('no scroll is smooth by assertion — every one asks', () => {
    // globals.css switches off all 12 keyframes under `prefers-reduced-motion: reduce`, measured.
    // What CSS cannot reach is a scroll this application asks for: measured animating over 11
    // distinct positions under reduce, from four call sites.
    for (const f of SITE) {
      const src = read(f)
      assert.equal(/behavior: ?'smooth'/.test(src), false, `${f} hard-codes a smooth scroll`)
    }
    assert.match(read('src/components/ui/motion.ts'), /prefers-reduced-motion: reduce/)
  })

  it('no ambient video starts itself', () => {
    // An `autoplay` attribute plays the clip before any script can read the preference, and CSS
    // cannot pause a <video> at all. Playing is the hook's decision in all three sections.
    for (const f of SITE) {
      const src = read(f)
      assert.equal(/\bautoPlay\b/.test(src), false, `${f} still carries an autoplay attribute`)
      if (/<video/.test(src)) assert.match(src, /useAmbientPlayback\(/, `${f} has a video nothing decides about`)
    }
  })
})

describe('where a guest is, and how they leave it', () => {
  it('opening the drawer takes a history entry, so Back closes it', () => {
    // It replaced the entry, so the address read /properties/<id> and Back left the site: measured
    // landing on about:blank at 390px and at 1440px. On a phone the drawer is the whole screen.
    const src = read(STATE)
    assert.match(src, /history\.pushState\(\{ axisDrawer: true \}/, 'opening still replaces the entry')
    assert.match(src, /addEventListener\('popstate'/, 'nothing closes the drawer when the entry goes')
    assert.match(src, /history\.replaceState\(history\.state, ''/, 'the scroll spy would wipe the marker')
  })

  it('the home page has a main landmark for the skip link to land in', () => {
    assert.match(read(APP), /<main>/, 'the home funnel has no main region')
  })
})
