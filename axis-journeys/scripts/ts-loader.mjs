/**
 * A resolver hook so plain Node can run the app's TypeScript modules the way the bundler does.
 *
 * Two things the bundler provides and Node does not: extensionless imports (`./repository`) and the
 * `@/…` alias from tsconfig. Node strips the types itself (`--experimental-strip-types`); this only
 * has to find the file. Twenty lines of resolution rather than a build step and a second toolchain
 * that can disagree with the one that ships.
 *
 * Used by `npm run seed` and by the test suite. It is never part of the deployed server.
 */
import { existsSync, statSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'

const ROOT = resolvePath(fileURLToPath(import.meta.url), '..', '..')
const EXT = ['.ts', '.tsx', '.mts', '.js', '.mjs', '.json']

const isFile = (p) => existsSync(p) && statSync(p).isFile()

function firstExisting(base) {
  // An import that already carries its extension (`@/lib/http/headers.mjs`) resolves to itself.
  if (isFile(base)) return base
  for (const e of EXT) if (existsSync(base + e)) return base + e
  for (const e of EXT) if (existsSync(resolvePath(base, 'index' + e))) return resolvePath(base, 'index' + e)
  return null
}

export async function resolve(specifier, context, next) {
  let target = null

  if (specifier.startsWith('@/')) {
    target = firstExisting(resolvePath(ROOT, 'src', specifier.slice(2)))
  } else if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const from = context.parentURL ? dirname(fileURLToPath(context.parentURL)) : ROOT
    const base = resolvePath(from, specifier)
    if (!isFile(base)) target = firstExisting(base)
  }

  if (target) return next(pathToFileURL(target).href, context)
  return next(specifier, context)
}
