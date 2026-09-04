/**
 * One shape for every API answer, and one place that decides what a caller is told.
 *
 * The rule this file exists to keep: an internal message — a store error, a stack, a provider's
 * verbatim refusal — never reaches the browser. The class and the status do; the detail goes to the
 * log, which is where the person who can act on it looks.
 */
import { NextResponse } from 'next/server'
import { log } from './log'

export interface ApiError extends Error {
  status?: number
  /** Operator-facing. Logged, never returned. */
  detail?: string
  /** Field-level faults, safe to return: the caller wrote them. */
  fields?: Record<string, string>
}

export const httpError = (status: number, message: string, extra?: Partial<ApiError>): ApiError =>
  Object.assign(new Error(message), { status, ...extra })

export const badRequest = (m: string, fields?: Record<string, string>) => httpError(400, m, { fields })
export const unauthorized = (m = 'Sign in to continue') => httpError(401, m)
export const forbidden = (m = 'You do not have access to that') => httpError(403, m)
export const notFound = (m = 'Not found') => httpError(404, m)
export const unprocessable = (m: string, fields?: Record<string, string>) => httpError(422, m, { fields })
export const tooMany = (m: string, retryAfter: number) => httpError(429, m, { detail: `retry after ${retryAfter}s` })

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' }

export function json<T>(body: T, init?: { status?: number; headers?: Record<string, string> }): NextResponse {
  return NextResponse.json(body as object, {
    status: init?.status ?? 200,
    headers: { ...NO_STORE, ...(init?.headers ?? {}) },
  })
}

/**
 * Turn a thrown error into a response. Anything without an explicit status is a fault in this
 * build, so it is logged whole and answered with one sentence that says nothing about the inside.
 */
export function fail(e: unknown, context: string): NextResponse {
  const err = e as ApiError
  const status = typeof err?.status === 'number' && err.status >= 400 && err.status < 600 ? err.status : 500
  if (status >= 500) {
    log.error(context, err?.message || 'unknown error', { detail: err?.detail, stack: err?.stack })
    return json({ error: 'Something went wrong on our side. Please try again.' }, { status: 500 })
  }
  if (err?.detail) log.warn(context, err.message, { detail: err.detail })
  const headers: Record<string, string> = {}
  if (status === 429) {
    const m = /retry after (\d+)s/.exec(err.detail || '')
    headers['Retry-After'] = m ? m[1] : '60'
  }
  return json({ error: err?.message || 'Request refused', ...(err?.fields ? { fields: err.fields } : {}) }, { status, headers })
}

/** Wrap a handler so no route has to repeat the try/catch, and none can forget it. */
export function route<A extends unknown[]>(
  context: string,
  handler: (...args: A) => Promise<Response>,
): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    try {
      return await handler(...args)
    } catch (e) {
      return fail(e, context)
    }
  }
}
