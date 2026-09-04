/** Registers the TypeScript resolver hook (see ts-loader.mjs) for the CLI and the test suite. */
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

register('./ts-loader.mjs', pathToFileURL('./scripts/'))
