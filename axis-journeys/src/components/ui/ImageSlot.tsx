'use client'

/**
 * The photograph in a card, a tile or a hero.
 *
 * It replaces the prototype's `<image-slot>` web component, which is a design-tool affordance
 * (drop-to-fill, reframe handles) that has no place in a production site. What it keeps is what a
 * guest sees: the photograph cropped to the slot, the credit overlay in the bottom-left corner
 * where Unsplash's licence requires it, and — where there is no photograph yet — the slot's own
 * caption rather than an empty grey rectangle.
 *
 * `pos` is the focal point the CMS records, applied as `object-position`, so a wide crop keeps the
 * subject rather than the middle of the frame.
 */
import { css } from './css'

export interface ImageSlotProps {
  src?: string
  alt: string
  /** "Photo by … on Unsplash" — shown over the image, and linked when a href is known. */
  credit?: string
  creditHref?: string
  /** The caption for a slot with no photograph yet. */
  placeholder?: string
  /** `"50% 50%"` — the focal point from the media record. */
  pos?: string
  /** Loading strategy. Above-the-fold slots pass `eager`. */
  loading?: 'lazy' | 'eager'
  sizes?: string
  className?: string
}

export function ImageSlot({ src, alt, credit, creditHref, placeholder, pos, loading = 'lazy', sizes, className }: ImageSlotProps) {
  if (!src) {
    return (
      <div
        className={className}
        style={css('position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:18px;text-align:center;background:var(--panel);color:var(--muted);font-size:12px;letter-spacing:.08em;line-height:1.5;')}
      >
        {placeholder || 'Photography to follow'}
      </div>
    )
  }

  return (
    <div className={className} style={css('position:absolute;inset:0;')}>
      {/* A plain <img> rather than next/image: these are full-bleed slots inside transformed,
          hover-scaled wrappers, and the optimiser's own wrapper breaks that composition. The
          remote hosts are pinned in the CSP and the sizes are already right for the layout. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        loading={loading}
        decoding="async"
        sizes={sizes}
        style={{ ...css('width:100%;height:100%;object-fit:cover;display:block;'), objectPosition: pos || '50% 50%' }}
      />
      {credit && (
        <span style={css('position:absolute;left:6px;bottom:6px;max-width:calc(100% - 12px);padding:3px 7px;border-radius:5px;background:rgba(0,0,0,.55);color:#fff;font-size:10px;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;backdrop-filter:blur(6px);')}>
          {creditHref ? (
            <a href={creditHref} target="_blank" rel="noopener nofollow" style={css('color:inherit;text-decoration:none;')}>
              {credit}
            </a>
          ) : (
            credit
          )}
        </span>
      )}
    </div>
  )
}
