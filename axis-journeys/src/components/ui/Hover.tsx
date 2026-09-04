'use client'

/**
 * The prototype's `style-hover` attribute, as a component.
 *
 * Eighty-one controls change border, colour or lift on hover, and those declarations are part of
 * the design contract exactly as the resting ones are. Rather than inventing eighty-one class
 * names, this keeps the pair together where the markup already puts it.
 *
 * The hover style is applied on keyboard focus too: a control that only reacts to a pointer is a
 * control a keyboard user cannot see themselves on. The focus ring in globals.css is the other half.
 */
import { useState, type CSSProperties, type ElementType, type ReactNode } from 'react'
import { css } from './css'

type Props = {
  as?: ElementType
  /** A declaration string, exactly as the prototype writes it. */
  style: string | CSSProperties
  /** Applied on hover and on keyboard focus. */
  hover?: string | CSSProperties
  children?: ReactNode
} & Record<string, unknown>

const resolve = (v: string | CSSProperties | undefined): CSSProperties =>
  v == null ? {} : typeof v === 'string' ? css(v) : v

export function Hover({ as, style, hover, children, ...rest }: Props) {
  const Tag = (as ?? 'div') as ElementType
  const [on, setOn] = useState(false)
  const base = resolve(style)
  const extra = on ? resolve(hover) : undefined

  return (
    <Tag
      {...rest}
      style={extra ? { ...base, ...extra } : base}
      onMouseEnter={(e: React.MouseEvent) => {
        setOn(true)
        ;(rest.onMouseEnter as ((e: React.MouseEvent) => void) | undefined)?.(e)
      }}
      onMouseLeave={(e: React.MouseEvent) => {
        setOn(false)
        ;(rest.onMouseLeave as ((e: React.MouseEvent) => void) | undefined)?.(e)
      }}
      onFocus={(e: React.FocusEvent) => {
        setOn(true)
        ;(rest.onFocus as ((e: React.FocusEvent) => void) | undefined)?.(e)
      }}
      onBlur={(e: React.FocusEvent) => {
        setOn(false)
        ;(rest.onBlur as ((e: React.FocusEvent) => void) | undefined)?.(e)
      }}
    >
      {children}
    </Tag>
  )
}
