/** Types for `headers.mjs`, which is plain ESM so `next.config.mjs` can import it too. */
export declare const ORIGINS: {
  turnstile: string
  fonts: string[]
  img: string[]
  media: string[]
  maps: string[]
}
export declare function contentSecurityPolicy(opts?: {
  nonce?: string
  apiOrigin?: string
  mediaOrigin?: string
  reportOnly?: boolean
  /** Overridable so a test can pin the shipped policy rather than the one this process is in. */
  development?: boolean
}): { header: string; value: string }
export declare function securityHeaders(opts?: { production?: boolean }): { key: string; value: string }[]
export declare function longCacheHeaders(): { key: string; value: string }[]
export declare function noStoreHeaders(): { key: string; value: string }[]
