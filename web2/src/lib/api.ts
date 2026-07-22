// Thin client over our existing production backend. PP0 authenticates with the
// same session cookie as /back (credentials:'include'); PP1 adds the offline
// sync engine (ops/pull/events). Nothing here is new backend — we call what
// main already ships.

export type Product = {
  id: string; name: string; dv?: string; desc?: string; descDv?: string
  price: number; unit?: string; cat?: string; emoji?: string; img?: string
  tags?: string[]; bestSeller?: boolean; stock?: number | null
  recipeAvail?: number | null; soldOut?: boolean; addons?: any[]; allergens?: string
}

async function j<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
  const r = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  })
  if (r.status === 401 || r.status === 403) { location.href = '/login'; throw new Error('auth') }
  const body = await r.json().catch(() => ({} as any))
  if (!r.ok) throw new Error(body.error || 'HTTP ' + r.status)
  return body as T
}

export const api = {
  me: () => j<{ role: string; staff: any }>('/api/inv/me'),
  products: () => j<{ currency: string; products: Product[] }>('/api/inv/products'),
  settings: () => j<{ settings: any }>('/api/inv/settings'),
}

export const money = (currency: string, laari: number) =>
  currency + ' ' + (laari / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
