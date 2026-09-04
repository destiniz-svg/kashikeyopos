/**
 * One instance per PROCESS, rather than one per server bundle.
 *
 * A module-level `let instance` is the ordinary way to write a singleton in Node, and it is what
 * `getStore()`, the bundle memo and the rate limiter were all written as. It is wrong here, and the
 * reason is the framework: the pages and the route handlers are compiled into separate server
 * bundles, so each gets its OWN copy of a module and its own copy of that variable.
 *
 * MEASURED, on the shipped build. Publish a property through the API and then ask for it:
 *
 *   /api/public/site        the change, 25 times out of 25
 *   /properties/{id}        the old page, 12 times out of 12 — and still the old page after the
 *                           bundle TTL had passed, because the file store's partition cache is
 *                           held for the life of the process and the page's copy of the store had
 *                           never been the one that wrote
 *
 * So on a file-store deploy an editor publishes, the API is right, and every server-rendered page
 * serves the previous content until the container restarts. The responses even carry `no-store`, so
 * a reader reloading sees no change and has no way to tell why.
 *
 * Pinning these to `globalThis` restores what each of them already meant. It is not a cache and it
 * is not a work-around: it is where a process-wide singleton has to live when a module can be
 * instantiated more than once.
 */

const KEY = Symbol.for('axis.singletons')

interface Registry { [name: string]: unknown }

const registry = ((globalThis as Record<symbol, unknown>)[KEY] ??= {}) as Registry

/** The one instance for `name`, made on first use. */
export function singleton<T>(name: string, make: () => T): T {
  if (!(name in registry)) registry[name] = make()
  return registry[name] as T
}

/** Replace an instance, or drop it so the next caller makes a fresh one. Test support. */
export function setSingleton(name: string, value: unknown): void {
  if (value === undefined) delete registry[name]
  else registry[name] = value
}

/** A mutable slot shared the same way, for state that is not an object to construct. */
export const slot = <T>(name: string, initial: T): { current: T } => singleton(name, () => ({ current: initial }))
