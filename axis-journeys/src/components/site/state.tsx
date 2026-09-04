'use client'

/**
 * The site's state, ported from the prototype's `class Component`.
 *
 * Everything the prototype held on `this.state` is here, under the same names, and every handler
 * does what SPEC.md's table says it does. It is one provider rather than one component so the
 * sections can be separate files without prop-drilling twenty callbacks through five levels.
 *
 * The bundle arrives from the server (the page is rendered with it, so the first paint is complete
 * and indexable) and is refreshed in the background, which is what the prototype's
 * `api.subscribe(load)` did through a BroadcastChannel.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { DEFAULT_FILTERS, filtersFromQuery, filtersToQuery, type Filters, type PropertyFacet, type PropertyFilters } from '@/lib/content/filters'
import type { Destination, GalleryShot, Offer, Property, SiteBundle } from '@/lib/content/types'

export type Currency = 'USD' | 'EUR'
export type Lang = 'EN' | 'AR'
export type Tab = 'insp' | 'dep'
export type LegalKey = 'terms' | 'privacy' | 'cancel' | 'security'

export interface DrawerState {
  resort: Property | null
  dep: Offer | null
  view: 'saved' | null
}

export interface FormState {
  name: string
  email: string
  phone: string
  month: string
  message: string
}

export interface SiteState {
  bundle: SiteBundle
  /** Live lookups, kept beside the bundle so a section never re-derives them. */
  destinations: Destination[]
  liveDestinations: Destination[]

  currency: Currency
  lang: Lang
  theme: 'dark' | 'light'
  scrolled: boolean
  scrollY: number
  vw: number
  isMobile: boolean

  mega: boolean
  menuOpen: boolean
  sheetOpen: boolean
  openField: string | null

  /** The intent bar's working filters, and the ones actually applied to the Selection. */
  f: Filters
  applied: Filters
  tab: Tab
  slide: number
  trackKey: number

  /** The Properties grid. */
  propDest: string
  offerDest: string
  pf: PropertyFilters
  pfOpen: boolean

  /** Which destination page is open, if any. */
  page: string | null
  destTheme: string | null

  drawer: DrawerState | null
  drawerVisible: boolean
  villa: number
  transfer: number
  roomOpen: number | null
  venueOpen: number | null
  faqOpen: number | null
  lightbox: number | null
  /**
   * Which set of photographs the lightbox is walking.
   *
   * `null` means the property's own gallery, which is what it has always shown. A room or a venue
   * hands its own shots in — the alternative is a second lightbox, and two of them would drift the
   * first time either gained a caption or an arrow key.
   */
  lightboxSet: GalleryShot[] | null
  party: string
  budget: string
  form: FormState
  err: Record<string, string | undefined>
  hp: string
  sending: boolean
  submitted: boolean
  leadId: string | null
  assignedTo: string | null

  saved: string[]
  pulse: string | null
  toast: { msg: string; on: boolean }
  legal: LegalKey | null
  subscribed: boolean
  newsEmail: string
  destHover: string | null
}

export interface SiteActions {
  setTheme(theme: 'dark' | 'light'): void
  toggleTheme(): void
  setLang(lang: Lang): void
  setCurrency(c: Currency): void
  toast(msg: string): void

  setMega(open: boolean): void
  toggleMega(): void
  toggleMenu(): void
  closeMenu(): void
  openSheet(): void
  closeSheet(): void
  setOpenField(field: string | null): void

  setFilter(patch: Partial<Filters>, opts?: { keepOpen?: boolean }): void
  apply(patch: Partial<Filters>, tab?: Tab): void
  resetFilters(): void
  setTab(tab: Tab): void
  step(direction: number): void
  setSlide(n: number): void

  setPropDest(dest: string): void
  setOfferDest(dest: string): void
  setPf(key: PropertyFacet, value: string): void
  clearPf(): void
  togglePf(): void
  openTier(tier: string): void

  nav(id: string, extra?: Partial<SiteState>): (e?: { preventDefault?: () => void }) => void
  goTop(e?: { preventDefault?: () => void }): void
  goHome(e?: { preventDefault?: () => void }): void
  openDest(name: string): void
  setDestTheme(theme: string | null): void
  setDestHover(name: string | null): void

  openDrawer(resort: Property | null, dep?: Offer | null, view?: 'saved' | null): void
  closeDrawer(): void
  setVilla(i: number): void
  setTransfer(i: number): void
  setRoomOpen(i: number | null): void
  setVenueOpen(i: number | null): void
  setFaqOpen(i: number | null): void
  setLightbox(i: number | null, shots?: GalleryShot[] | null): void
  setParty(p: string): void
  setBudget(b: string): void
  setFormField(key: keyof FormState, value: string): void
  setHp(v: string): void
  submitEnquiry(): Promise<void>
  jump(id: string): void

  toggleSave(id: string, e?: { stopPropagation?: () => void }): void
  clearSaved(): void

  setLegal(key: LegalKey | null): void
  subscribe(email: string): Promise<void>
  setNewsEmail(v: string): void
}

interface SiteContextValue {
  state: SiteState
  actions: SiteActions
  /** The carousel reports its length so the arrow keys, which live here, can wrap correctly. */
  setTotal(n: number): void
}

const SiteContext = createContext<SiteContextValue | null>(null)

export function useSite() {
  const ctx = useContext(SiteContext)
  if (!ctx) throw new Error('useSite must be used inside <SiteProvider>')
  return ctx
}

const SHORTLIST_KEY = 'axis.shortlist'
const THEME_KEY = 'axis.theme'

export interface SiteProviderProps {
  bundle: SiteBundle
  /** A destination page rendered directly, rather than reached from the home page. */
  initialPage?: string | null
  /** A property profile rendered directly: the drawer opens over the home page beneath it. */
  initialPropertyId?: string | null
  initialOfferId?: string | null
  children: ReactNode
}

export function SiteProvider({ bundle: initialBundle, initialPage = null, initialPropertyId = null, initialOfferId = null, children }: SiteProviderProps) {
  const [bundle, setBundle] = useState<SiteBundle>(initialBundle)
  const [state, setState] = useState<Omit<SiteState, 'bundle' | 'destinations' | 'liveDestinations' | 'isMobile'>>(() => ({
    currency: 'USD',
    lang: 'EN',
    theme: 'dark',
    scrolled: false,
    scrollY: 0,
    vw: 1280,
    mega: false,
    menuOpen: false,
    sheetOpen: false,
    openField: null,
    f: { ...DEFAULT_FILTERS },
    applied: { ...DEFAULT_FILTERS },
    tab: 'insp',
    slide: 0,
    trackKey: 0,
    propDest: 'All',
    offerDest: 'All',
    pf: {},
    pfOpen: false,
    page: initialPage,
    destTheme: null,
    drawer: null,
    drawerVisible: false,
    villa: 0,
    transfer: 0,
    roomOpen: 0,
    venueOpen: null,
    faqOpen: null,
    lightbox: null,
    lightboxSet: null,
    party: 'Couple',
    budget: 'Premium',
    form: { name: '', email: '', phone: '', month: '', message: '' },
    err: {},
    hp: '',
    sending: false,
    submitted: false,
    leadId: null,
    assignedTo: null,
    saved: [],
    pulse: null,
    toast: { msg: '', on: false },
    legal: null,
    subscribed: false,
    newsEmail: '',
    destHover: null,
  }))

  const patch = useCallback((p: Partial<typeof state> | ((s: typeof state) => Partial<typeof state>)) => {
    setState((s) => ({ ...s, ...(typeof p === 'function' ? p(s) : p) }))
  }, [])

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const total = useRef(0)

  // ---------------------------------------------------------------- basics

  const lock = useCallback((on: boolean) => {
    document.body.style.overflow = on ? 'hidden' : ''
  }, [])

  const toast = useCallback(
    (msg: string) => {
      if (toastTimer.current) clearTimeout(toastTimer.current)
      patch({ toast: { msg, on: true } })
      toastTimer.current = setTimeout(() => patch((s) => ({ toast: { ...s.toast, on: false } })), 2600)
    },
    [patch],
  )

  // ---------------------------------------------------------------- mount effects

  useEffect(() => {
    const saved = (() => {
      try {
        return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'
      } catch {
        return 'dark'
      }
    })()
    let shortlist: string[] = []
    try {
      const raw = JSON.parse(localStorage.getItem(SHORTLIST_KEY) || '[]') as unknown
      // A shortlist may name a property that has since come off the site; those entries go rather
      // than rendering a card with no destination.
      if (Array.isArray(raw)) shortlist = raw.filter((id): id is string => typeof id === 'string')
    } catch {
      shortlist = []
    }
    patch({
      theme: saved as 'dark' | 'light',
      vw: window.innerWidth,
      saved: shortlist.filter((id) => initialBundle.properties.some((p) => p.id === id)),
    })
  }, [patch, initialBundle])

  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY
      patch((s) => (y > 40 !== s.scrolled || Math.abs(y - s.scrollY) > 4 ? { scrolled: y > 40, scrollY: y } : {}))
    }
    const onResize = () => {
      const vw = window.innerWidth
      patch((s) => (vw === s.vw ? {} : { vw, ...(vw > 820 ? { menuOpen: false, sheetOpen: false } : {}) }))
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onResize)
    onScroll()
    onResize()
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onResize)
    }
  }, [patch])

  /**
   * The reveal-on-scroll observer. Elements carry `data-reveal`; the stylesheet does the rest.
   * A tall block is revealed as soon as it intersects at all, because it may never reach 12%.
   */
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return
    const seen = new WeakSet<Element>()
    const io = new IntersectionObserver(
      (entries) =>
        entries.forEach((en) => {
          const tall = en.boundingClientRect.height > window.innerHeight * 0.6
          if (en.isIntersecting && (tall || en.intersectionRatio >= 0.12)) {
            en.target.setAttribute('data-reveal', 'in')
            io.unobserve(en.target)
          }
        }),
      { threshold: [0, 0.12] },
    )
    const sweep = () => {
      document.querySelectorAll('[data-reveal]').forEach((el) => {
        if (seen.has(el) || el.getAttribute('data-reveal') === 'in') return
        seen.add(el)
        io.observe(el)
      })
    }
    sweep()
    const timer = setInterval(sweep, 400)
    return () => {
      clearInterval(timer)
      io.disconnect()
    }
  }, [])

  /** Keep the bundle fresh without a reload — the production form of the prototype's subscribe. */
  useEffect(() => {
    let cancelled = false
    const refresh = async () => {
      try {
        const res = await fetch('/api/public/site', { headers: { accept: 'application/json' } })
        if (!res.ok) return
        const next = (await res.json()) as SiteBundle
        if (!cancelled && next?.properties) setBundle(next)
      } catch {
        // A refresh that cannot reach the outlet leaves the page exactly as it is. The content on
        // screen is the last true answer, which is better than an empty one.
      }
    }
    const timer = setInterval(refresh, 120_000)
    const onVisible = () => document.visibilityState === 'visible' && refresh()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  // ---------------------------------------------------------------- derived collections

  const properties = bundle.properties
  const destinations = bundle.destinations
  const liveDestinations = useMemo(() => destinations.filter((d) => d.live !== false), [destinations])

  // ---------------------------------------------------------------- navigation

  const scrollToId = useCallback((id: string) => {
    const el = document.getElementById(id)
    if (!el) return
    window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 100, behavior: 'smooth' })
  }, [])

  const closeDrawer = useCallback(() => {
    patch((s) => (s.drawerVisible ? { drawerVisible: false } : {}))
    lock(false)
    setTimeout(() => patch((s) => (s.drawerVisible ? {} : { drawer: null })), 600)
  }, [patch, lock])

  const nav = useCallback(
    (id: string, extra?: Partial<SiteState>) =>
      (e?: { preventDefault?: () => void }) => {
        e?.preventDefault?.()
        // On a destination page the same nav labels mean that page's own sections.
        const local: Record<string, string> = { properties: 'dp-props', offers: 'dp-offers', experiences: 'dp-exp' }
        const onDestPage = !!state.page
        if (onDestPage && local[id] && !extra && document.getElementById(local[id])) {
          patch({ mega: false, menuOpen: false })
          lock(false)
          setTimeout(() => scrollToId(local[id]), 20)
          return
        }
        /**
         * Leaving a destination page is a NAVIGATION, not a state change.
         *
         * It used to set `page: null`, which swaps the home page in underneath the destination's
         * own address: measured, "Our Story" from `/destinations/maldives` rendered the home page
         * with the URL still reading `/destinations/maldives#story`, so a reload came back to the
         * destination and the link was unshareable. `goHome()` has always navigated for exactly
         * this reason; the section labels now do the same, and the hash lands on the section
         * because `globals.css` gives every section id its own scroll margin.
         */
        if (onDestPage && !extra) {
          patch({ mega: false, menuOpen: false })
          lock(false)
          if (typeof window !== 'undefined') window.location.assign(`/#${id}`)
          return
        }
        if (typeof history !== 'undefined' && location.hash !== '#' + id) history.replaceState(null, '', '#' + id)
        patch({ page: null, mega: false, menuOpen: false, ...(extra as object) })
        lock(false)
        setTimeout(() => scrollToId(id), onDestPage ? 80 : 20)
      },
    [patch, lock, scrollToId, state.page],
  )

  const goHome = useCallback(
    (e?: { preventDefault?: () => void }) => {
      e?.preventDefault?.()
      patch({ page: null, mega: false, menuOpen: false })
      lock(false)
      // A destination has its own URL, so leaving it is a navigation rather than a state change.
      if (typeof window !== 'undefined' && window.location.pathname !== '/') window.location.assign('/')
      else window.scrollTo({ top: 0, behavior: 'auto' })
    },
    [patch, lock],
  )

  const goTop = useCallback(
    (e?: { preventDefault?: () => void }) => {
      if (state.page) {
        goHome(e)
        return
      }
      e?.preventDefault?.()
      window.scrollTo({ top: 0, behavior: 'smooth' })
    },
    [state.page, goHome],
  )

  const openDest = useCallback(
    (name: string) => {
      const dest = destinations.find((d) => d.name === name)
      if (!dest) return
      patch({ page: name, mega: false, menuOpen: false, propDest: name, destTheme: null, drawerVisible: false, lightbox: null, lightboxSet: null })
      lock(false)
      window.location.assign(`/destinations/${dest.slug}`)
    },
    [destinations, patch, lock],
  )

  // ---------------------------------------------------------------- filters

  const countMatches = useCallback(
    (f: Filters, tab: Tab): number => {
      if (tab === 'dep') {
        return bundle.offers.filter((d) => {
          const r = properties.find((x) => x.id === d.resort)
          return !!r && matchLocal(r, f, d.month)
        }).length
      }
      return properties.filter((r) => matchLocal(r, f)).length
    },
    [bundle.offers, properties],
  )

  /**
   * Apply a filter set and take the guest to the results.
   *
   * The Selection is on the home page and nowhere else, so this has to know where it is standing.
   * On a destination page it wrote the filters into state that page does not read and scrolled to
   * an id that is not on it — and then toasted "3 journeys match" over a screen where nothing had
   * moved. Measured before this: scrollY 0 to 0, no cards, and that sentence on the screen.
   *
   * A filter that has to survive a navigation is a filter worth putting in the address, which is
   * also what makes a curated path something a specialist can send to somebody.
   */
  const apply = useCallback(
    (p: Partial<Filters>, tab?: Tab) => {
      const here = typeof document !== 'undefined' && !!document.getElementById('selection')
      if (!here) {
        patch({ mega: false, menuOpen: false, sheetOpen: false })
        lock(false)
        if (typeof window !== 'undefined') {
          const q = filtersToQuery({ ...DEFAULT_FILTERS, ...p })
          window.location.assign(q ? `/?${q}` : '/')
        }
        return
      }
      patch((s) => {
        const f = { ...s.f, ...p }
        const t = tab || s.tab
        const n = countMatches(f, t)
        setTimeout(() => toast(n ? `${n} ${t === 'dep' ? 'departures' : 'journeys'} match` : 'No exact match — try widening'), 350)
        return { f, applied: f, openField: null, mega: false, menuOpen: false, sheetOpen: false, slide: 0, tab: t, trackKey: s.trackKey + 1 }
      })
      lock(false)
      setTimeout(() => scrollToId('selection'), 30)
    },
    [patch, countMatches, toast, lock, scrollToId],
  )
  // Read by the arrival effect, which must run once and must not re-run when this is rebuilt.
  const applyRef = useRef(apply)
  applyRef.current = apply

  // ---------------------------------------------------------------- shortlist

  const persistSaved = (list: string[]) => {
    try {
      localStorage.setItem(SHORTLIST_KEY, JSON.stringify(list))
    } catch {
      // A browser with storage blocked keeps the shortlist for the session only. Nothing is lost
      // that the guest can see, and refusing to shortlist at all would be worse.
    }
  }

  const toggleSave = useCallback(
    (id: string, e?: { stopPropagation?: () => void }) => {
      e?.stopPropagation?.()
      patch((s) => {
        const on = s.saved.includes(id)
        setTimeout(() => toast(on ? 'Removed from shortlist' : 'Saved to your shortlist'), 0)
        const next = on ? s.saved.filter((x) => x !== id) : [...s.saved, id]
        persistSaved(next)
        return { saved: next, pulse: on ? null : id }
      })
      setTimeout(() => patch({ pulse: null }), 600)
    },
    [patch, toast],
  )

  // ---------------------------------------------------------------- drawer

  const openDrawer = useCallback(
    (resort: Property | null, dep: Offer | null = null, view: 'saved' | null = null) => {
      patch({
        drawer: { resort, dep, view },
        drawerVisible: true,
        villa: 0,
        transfer: 0,
        faqOpen: null,
        lightbox: null,
        lightboxSet: null,
        roomOpen: 0,
        venueOpen: null,
        err: {},
        submitted: false,
        sending: false,
        openField: null,
        mega: false,
        menuOpen: false,
        sheetOpen: false,
      })
      lock(true)
      if (resort && typeof history !== 'undefined') history.replaceState(null, '', `/properties/${resort.id}`)
    },
    [patch, lock],
  )

  /**
   * A filter set carried in the address, applied once on arrival.
   *
   * The other half of `apply()` leaving a page that has no Selection. It is also what makes a
   * curated path shareable — `/?pkg=Private+Island` is a link a specialist can send — so this runs
   * for any visitor arriving with those parameters, not only for one who came from a menu.
   *
   * Only on the home page, and only once: the Selection is here, and re-applying on every render
   * would fight a guest who has since changed a filter themselves.
   */
  const arrived = useRef(false)
  useEffect(() => {
    if (arrived.current || initialPage) return
    arrived.current = true
    const p = filtersFromQuery(new URLSearchParams(window.location.search))
    if (!Object.keys(p).length) return
    // After paint, so the Selection is on the page to be filtered and scrolled to.
    const t = window.setTimeout(() => applyRef.current(p), 60)
    return () => window.clearTimeout(t)
  }, [initialPage])

  // The drawer owns the URL while it is open, and hands it back when it closes: a guest who opened
  // a property from the home page must be able to share what they are looking at.
  const closeDrawerAndUrl = useCallback(() => {
    closeDrawer()
    if (typeof history !== 'undefined' && location.pathname.startsWith('/properties/')) {
      history.replaceState(null, '', '/#properties')
    }
  }, [closeDrawer])

  const jump = useCallback((id: string) => {
    const el = document.getElementById(id)
    const drawer = document.getElementById('drawer')
    if (el && drawer) drawer.scrollTo({ top: el.offsetTop - 70, behavior: 'smooth' })
  }, [])

  const validate = useCallback((form: FormState): Record<string, string> => {
    const e: Record<string, string> = {}
    if (form.name.trim().length < 2) e.name = 'Please tell us your name.'
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) e.email = 'A valid email is needed for your quote.'
    if (form.phone.replace(/\D/g, '').length < 8) e.phone = 'We reply on WhatsApp — a number is needed.'
    if (!form.month) e.month = 'Pick a month (flexible is fine).'
    return e
  }, [])

  const submitEnquiry = useCallback(async () => {
    const faults = validate(state.form)
    if (Object.keys(faults).length) {
      patch({ err: faults })
      toast('A couple of details are missing')
      return
    }
    patch({ sending: true, err: {} })
    const r = state.drawer?.resort ?? null
    const payload = {
      ...state.form,
      website: state.hp,
      turnstile: readTurnstileToken(),
      party: state.party,
      budget: state.budget,
      property: r?.name ?? '',
      propertyId: r?.id ?? '',
      offer: state.drawer?.dep?.date ?? '',
      shortlist: state.saved.map((id) => properties.find((p) => p.id === id)?.name ?? id),
      source: state.drawer?.view === 'saved' ? 'shortlist' : r ? 'property' : 'journey-designer',
    }
    try {
      const res = await fetch('/api/public/enquiries', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'axis' },
        body: JSON.stringify(payload),
      })
      const data = (await res.json()) as { id?: string; ref?: string; assignedTo?: string; error?: string }
      if (!res.ok) throw new Error(data?.error || 'refused')
      patch({ sending: false, submitted: true, leadId: data.ref ?? data.id ?? null, assignedTo: data.assignedTo ?? null })
      toast('Enquiry sent — we reply within the hour')
    } catch {
      patch({ sending: false })
      toast('Could not send — please try again or WhatsApp us')
    }
  }, [state, patch, toast, validate, properties])

  // ---------------------------------------------------------------- keyboard

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (state.lightbox != null) {
          patch({ lightbox: null, lightboxSet: null })
          return
        }
        if (state.drawerVisible) {
          closeDrawerAndUrl()
          return
        }
        patch({ openField: null, mega: false, legal: null, menuOpen: false, sheetOpen: false })
        lock(false)
        return
      }
      if (state.drawerVisible || state.lightbox != null) return
      if (e.key === 'ArrowRight') stepRef.current(1)
      if (e.key === 'ArrowLeft') stepRef.current(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state.lightbox, state.drawerVisible, patch, lock, closeDrawerAndUrl])

  /** A click outside the intent bar closes whichever field is open. */
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!state.openField) return
      const target = e.target as Element | null
      if (target && !target.closest('#intent-bar') && !target.closest('#intent-sheet')) patch({ openField: null })
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [state.openField, patch])

  const step = useCallback(
    (d: number) => {
      const n = total.current
      if (!n) return
      patch((s) => ({ slide: (Math.min(s.slide, n - 1) + d + n) % n }))
    },
    [patch],
  )
  const stepRef = useRef(step)
  stepRef.current = step

  // ---------------------------------------------------------------- open the drawer on arrival

  useEffect(() => {
    if (!initialPropertyId) return
    const r = properties.find((p) => p.id === initialPropertyId)
    if (!r) return
    const dep = initialOfferId ? bundle.offers.find((o) => o.id === initialOfferId) ?? null : null
    patch({ drawer: { resort: r, dep, view: null }, drawerVisible: true, villa: 0, transfer: 0, roomOpen: 0 })
    lock(true)
    // Nothing else runs on arrival: this is the deep-link case, and re-running it on every bundle
    // refresh would reopen a drawer the guest has since closed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPropertyId])

  // ---------------------------------------------------------------- the value

  const value = useMemo(() => {
    const isMobile = state.vw <= 820
    const full: SiteState = { ...state, bundle, destinations, liveDestinations, isMobile }

    const actions: SiteActions = {
      setTheme(theme) {
        try {
          localStorage.setItem(THEME_KEY, theme)
        } catch {
          /* a browser with storage blocked still gets the theme for this session */
        }
        document.documentElement.setAttribute('data-theme', theme)
        patch({ theme })
      },
      toggleTheme() {
        actions.setTheme(state.theme === 'light' ? 'dark' : 'light')
      },
      setLang(lang) {
        patch({ lang })
        if (lang === 'AR') toast('النسخة العربية قريباً — a specialist can help you in Arabic on WhatsApp')
      },
      setCurrency(c) {
        patch({ currency: c })
        toast(c === 'EUR' ? 'Prices now in euros' : 'Prices now in US dollars')
      },
      toast,
      setMega: (open) => patch({ mega: open }),
      toggleMega: () => patch((s) => ({ mega: !s.mega })),
      toggleMenu() {
        patch((s) => {
          const on = !s.menuOpen
          lock(on)
          return { menuOpen: on, mega: false }
        })
      },
      closeMenu() {
        patch({ menuOpen: false })
        lock(false)
      },
      openSheet() {
        patch({ sheetOpen: true })
        lock(true)
      },
      closeSheet() {
        patch({ sheetOpen: false })
        lock(false)
      },
      setOpenField: (field) => patch((s) => ({ openField: s.openField === field ? null : field })),
      setFilter: (p, opts) => patch((s) => ({ f: { ...s.f, ...p }, ...(opts?.keepOpen ? {} : { openField: null }) })),
      apply,
      resetFilters() {
        patch((s) => ({ f: { ...DEFAULT_FILTERS }, applied: { ...DEFAULT_FILTERS }, slide: 0, trackKey: s.trackKey + 1 }))
        toast('Filters cleared')
      },
      setTab: (tab) => patch((s) => ({ tab, slide: 0, trackKey: s.trackKey + 1 })),
      step,
      setSlide: (n) => patch({ slide: n }),
      setPropDest: (dest) => patch({ propDest: dest }),
      setOfferDest: (dest) => patch({ offerDest: dest }),
      setPf: (key, value) => patch((s) => ({ pf: { ...s.pf, [key]: s.pf[key] === value ? undefined : value } })),
      clearPf: () => patch({ pf: {} }),
      togglePf: () => patch((s) => ({ pfOpen: !s.pfOpen })),
      openTier(tier) {
        patch({ pf: { tier }, propDest: 'All', pfOpen: true })
        toast(`Showing the ${tier}`)
        setTimeout(() => nav('properties')(), 20)
      },
      nav,
      goTop,
      goHome,
      openDest,
      setDestTheme: (theme) => patch({ destTheme: theme }),
      setDestHover: (name) => patch({ destHover: name }),
      openDrawer,
      closeDrawer: closeDrawerAndUrl,
      setVilla: (i) => patch({ villa: i }),
      setTransfer: (i) => patch({ transfer: i }),
      setRoomOpen: (i) => patch((s) => ({ roomOpen: s.roomOpen === i ? null : i })),
      setVenueOpen: (i) => patch((s) => ({ venueOpen: s.venueOpen === i ? null : i })),
      setFaqOpen: (i) => patch((s) => ({ faqOpen: s.faqOpen === i ? null : i })),
      // A caller that names no set is asking for the property gallery, which is what every caller
      // did before rooms and venues had photographs of their own.
      setLightbox: (i, shots) => patch({ lightbox: i, ...(i == null ? { lightboxSet: null } : shots !== undefined ? { lightboxSet: shots } : {}) }),
      setParty: (p) => patch({ party: p }),
      setBudget: (b) => patch({ budget: b }),
      setFormField: (key, v) => patch((s) => ({ form: { ...s.form, [key]: v }, err: { ...s.err, [key]: undefined } })),
      setHp: (v) => patch({ hp: v }),
      submitEnquiry,
      jump,
      toggleSave,
      clearSaved() {
        patch({ saved: [] })
        persistSaved([])
        toast('Shortlist cleared')
      },
      setLegal: (key) => patch({ legal: key }),
      setNewsEmail: (v) => patch({ newsEmail: v }),
      async subscribe(email) {
        if (state.subscribed) return
        try {
          const res = await fetch('/api/public/newsletter', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-requested-with': 'axis' },
            body: JSON.stringify({ email, turnstile: readTurnstileToken() }),
          })
          if (!res.ok) throw new Error('refused')
          patch({ subscribed: true })
          toast('Welcome aboard — the next dispatch is on its way')
        } catch {
          toast('Could not subscribe — please try again')
        }
      },
    }

    return {
      state: full,
      actions,
      setTotal: (n: number) => {
        total.current = n
      },
    }
  }, [
    state, bundle, destinations, liveDestinations, patch, toast, lock, apply, step, nav, goTop, goHome,
    openDest, openDrawer, closeDrawerAndUrl, jump, toggleSave, submitEnquiry,
  ])

  return <SiteContext.Provider value={value}>{children}</SiteContext.Provider>
}

/** Local copy of the filter predicate so the provider does not import the whole module graph. */
function matchLocal(r: Property, f: Filters, monthOverride?: number | null): boolean {
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  if (f.dest !== 'Anywhere' && r.dest !== f.dest) return false
  if (f.pkg !== 'Any type' && r.pkg !== f.pkg) return false
  if (f.themes.length && !f.themes.every((t) => r.themes.includes(t))) return false
  if (r.nights > f.nights) return false
  if (f.month !== 'Any month') {
    const m = MONTHS.indexOf(f.month) + 1
    if (monthOverride != null) {
      if (monthOverride && monthOverride !== m) return false
    } else if (!r.months.includes(m)) return false
  }
  return true
}

/** Turnstile renders into `#turnstile-slot`; with no site key configured there is no token. */
function readTurnstileToken(): string {
  if (typeof document === 'undefined') return ''
  const el = document.querySelector<HTMLInputElement>('input[name="cf-turnstile-response"]')
  return el?.value ?? ''
}
