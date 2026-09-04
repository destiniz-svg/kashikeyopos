/**
 * The API tests drive the real server.
 *
 * Not a mocked handler and not an in-process import: `next start` on a production build, over HTTP,
 * against a real document store in a temporary directory. That is the only shape in which the
 * middleware, the route matching, the cookie handling, the CSP nonce and the error wrapper are all
 * the ones that deploy. A test that imports a route function proves the function; this proves the
 * server.
 *
 * The store directory is thrown away at the end of the run, so a test may write, publish and delete
 * freely without touching the developer's own workspace.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'

const NEXT_BIN = createRequire(import.meta.url).resolve('next/dist/bin/next')

/** Signal the whole group, so the server and anything it started go together. */
function endGroup(proc: ChildProcess, signal: NodeJS.Signals): void {
  if (proc.pid == null) return
  try {
    process.kill(-proc.pid, signal)
  } catch {
    try { proc.kill(signal) } catch { /* already gone */ }
  }
}

export const OWNER = { email: 'owner@axisjourneys.com', password: 'a-test-owner-password' }

export interface Harness {
  base: string
  dir: string
  stop(): Promise<void>
  /** A fetch that carries the CSRF header the write routes require. */
  api(path: string, init?: RequestInit & { cookie?: string }): Promise<Response>
  /** Sign in and return the session cookie the CMS would hold. */
  signIn(email?: string, password?: string): Promise<string>
}

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = createServer()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function until(check: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last: unknown = null
  while (Date.now() < deadline) {
    try {
      if (await check()) return
    } catch (e) {
      last = e
    }
    await wait(200)
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${(last as Error).message}` : ''}`)
}

function run(cmd: string, args: string[], env: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (out += d))
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}\n${out}`))))
  })
}

/**
 * Start a server with a store of its own.
 *
 * `RATE_LIMIT_SCALE` is raised because the whole suite arrives from one loopback address, which the
 * doorman is right to read as one caller — the limiter's own behaviour is tested against real
 * ceilings in `rate-limit.test.ts` and over HTTP in `security.test.ts`, which sets it back to 1.
 */
export async function startServer(over: Record<string, string> = {}, opts: { skipSeed?: boolean } = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'axis-test-'))
  const port = await freePort()
  const env: Record<string, string> = {
    NODE_ENV: 'production',
    APP_STAGE: 'staging',
    PORT: String(port),
    STORE_DRIVER: 'file',
    STORE_DIR: dir,
    MEDIA_DRIVER: 'local',
    SESSION_SECRET: 'a-test-session-secret-of-at-least-32-characters',
    ADMIN_OWNER_EMAIL: OWNER.email,
    ADMIN_OWNER_PASSWORD: OWNER.password,
    ADMIN_OWNER_NAME: 'Test Owner',
    SITE_URL: `http://127.0.0.1:${port}`,
    RATE_LIMIT_SCALE: '200',
    BUNDLE_TTL_MS: '1',
    TURNSTILE_SECRET_KEY: '',
    TURNSTILE_REQUIRED: '0',
    MAIL_DRIVER: 'log',
    LOG_LEVEL: 'error',
    ...over,
  }

  // `skipSeed` leaves the store empty, which is how the boot-time seed is exercised: a container
  // with a fresh volume has no seed script inside it to run.
  if (!opts.skipSeed) {
    await run('node', ['--env-file-if-exists=.env.local', '--import', './scripts/register-loader.mjs', 'scripts/seed.ts'], env)
  }

  // Spawned as its own process GROUP, and Next's binary directly rather than through `npx`.
  // Through a wrapper, a SIGTERM reaches the wrapper and the real server keeps the stdio pipes
  // open — which does not fail a test, it hangs the run until the timeout, twice per file.
  const proc: ChildProcess = spawn(process.execPath, [NEXT_BIN, 'start', '-p', String(port)], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  let log = ''
  proc.stdout?.on('data', (d) => (log += d))
  proc.stderr?.on('data', (d) => (log += d))

  const base = `http://127.0.0.1:${port}`
  try {
    await until(async () => (await fetch(`${base}/api/health`)).ok, 60_000, `the server on ${port}`)
  } catch (e) {
    endGroup(proc, 'SIGKILL')
    await rm(dir, { recursive: true, force: true })
    throw new Error(`${(e as Error).message}\n--- server output ---\n${log.slice(-3000)}`)
  }

  const api: Harness['api'] = (path, init = {}) => {
    const { cookie, headers, ...rest } = init as RequestInit & { cookie?: string }
    return fetch(base + path, {
      ...rest,
      headers: {
        // The write routes require this header: a plain cross-site form cannot set it, and a
        // cross-origin fetch that tries is stopped by the preflight.
        'x-requested-with': 'axis',
        ...(cookie ? { cookie } : {}),
        ...(headers as Record<string, string>),
      },
    })
  }

  const signIn: Harness['signIn'] = async (email = OWNER.email, password = OWNER.password) => {
    const res = await api('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })
    if (!res.ok) throw new Error(`sign-in failed: ${res.status} ${await res.text()}`)
    const set = res.headers.get('set-cookie') || ''
    const cookie = set.split(';')[0]
    if (!cookie.startsWith('axis_session=')) throw new Error(`no session cookie in: ${set}`)
    return cookie
  }

  return {
    base,
    dir,
    api,
    signIn,
    async stop() {
      const ended = new Promise((r) => proc.on('exit', r))
      endGroup(proc, 'SIGTERM')
      await Promise.race([ended, wait(5000)])
      if (proc.exitCode === null && proc.signalCode === null) endGroup(proc, 'SIGKILL')
      // The pipes are what keep Node's event loop alive after the child is gone.
      proc.stdout?.destroy()
      proc.stderr?.destroy()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

/** Read a JSON body, with the status, without throwing on a non-JSON answer. */
export async function body<T = Record<string, unknown>>(res: Response): Promise<T> {
  const text = await res.text()
  try {
    return JSON.parse(text) as T
  } catch {
    return { raw: text } as T
  }
}
