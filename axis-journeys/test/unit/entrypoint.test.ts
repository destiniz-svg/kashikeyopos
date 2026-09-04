/**
 * The container entrypoint, driven as a script.
 *
 * There is no Docker daemon in CI, so the IMAGE cannot be built here — but the logic is not in the
 * image, it is in this shell script, and the script can be run against stubs on PATH. What is tested
 * is the sequence: the mount is handed over WHILE STILL ROOT, and only then are privileges dropped.
 * A chown after the drop is a chown that fails, and the failure is a site with no catalogue.
 *
 * This exists because it actually happened: the first volume-backed deploy came up with
 * `EACCES: permission denied, open '/data/.health'`, because the platform mounts the volume owned by
 * root and the image runs as `node`.
 */
import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, describe, it } from 'node:test'

const SCRIPT = resolve('docker-entrypoint.sh')
const roots: string[] = []
after(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })))

/** Run the script with stubbed `chown`, `stat` and `su-exec`, and report what each was asked to do. */
function run(opts: { storeDir?: string; owner?: string; chownFails?: boolean } = {}): { calls: string[]; status: number; stdout: string } {
  const root = mkdtempSync(join(tmpdir(), 'axis-entry-'))
  roots.push(root)
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const trace = join(root, 'trace')
  writeFileSync(trace, '')

  const stub = (name: string, body: string) => {
    const p = join(bin, name)
    writeFileSync(p, `#!/bin/sh\necho "${name} $*" >> ${trace}\n${body}\n`)
    chmodSync(p, 0o755)
  }
  stub('stat', `echo "${opts.owner ?? 'root'}"`)
  stub('chown', opts.chownFails ? 'exit 1' : 'exit 0')
  stub('su-exec', 'exit 0')

  let status = 0
  let stdout = ''
  try {
    stdout = execFileSync('/bin/sh', [SCRIPT, 'node', 'server.js'], {
      // A deliberately bare environment: the script must not depend on anything the platform did
      // not set, and PATH is what puts the stubs in front of the real tools.
      env: { PATH: `${bin}:/usr/bin:/bin`, ...(opts.storeDir === undefined ? {} : { STORE_DIR: opts.storeDir }) } as unknown as NodeJS.ProcessEnv,
      encoding: 'utf8',
    })
  } catch (e) {
    status = (e as { status: number }).status ?? 1
    stdout = String((e as { stdout?: string }).stdout ?? '')
  }
  const calls = readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean)
  return { calls, status, stdout }
}

const dirThatExists = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'axis-store-'))
  roots.push(d)
  return d
}

describe('docker-entrypoint.sh', () => {
  it('is in the repository, because the Dockerfile names it', () => {
    assert.equal(existsSync(SCRIPT), true)
    assert.match(readFileSync('Dockerfile', 'utf8'), /COPY --chmod=755 docker-entrypoint\.sh \/docker-entrypoint\.sh/)
    assert.match(readFileSync('Dockerfile', 'utf8'), /ENTRYPOINT \["\/docker-entrypoint\.sh"\]/)
  })

  it('hands the mount over BEFORE dropping privileges', () => {
    // The whole point. Reversed, the chown fails and the store is unwritable for the life of the
    // container.
    const dir = dirThatExists()
    const { calls, status } = run({ storeDir: dir })
    const chown = calls.findIndex((c) => c.startsWith('chown '))
    const drop = calls.findIndex((c) => c.startsWith('su-exec '))
    assert.ok(chown >= 0, `chown never ran: ${calls.join(' | ')}`)
    assert.ok(drop >= 0, 'privileges were never dropped')
    assert.ok(chown < drop, `chown ran after the drop: ${calls.join(' | ')}`)
    assert.equal(status, 0)
  })

  it('takes ownership of the store directory, and recursively', () => {
    const dir = dirThatExists()
    const { calls } = run({ storeDir: dir })
    assert.ok(calls.some((c) => c === `chown -R node:node ${dir}`), calls.join(' | '))
  })

  it('runs the server as node, with the command passed through unchanged', () => {
    const dir = dirThatExists()
    const { calls } = run({ storeDir: dir })
    assert.ok(calls.includes('su-exec node node server.js'), calls.join(' | '))
  })

  it('does nothing when the directory is already ours, so a restart is not a full walk', () => {
    const dir = dirThatExists()
    const { calls } = run({ storeDir: dir, owner: 'node' })
    assert.equal(calls.some((c) => c.startsWith('chown ')), false, calls.join(' | '))
    assert.ok(calls.some((c) => c.startsWith('su-exec ')), 'it must still start the server')
  })

  it('does nothing when there is no store on disk — the DynamoDB deploy', () => {
    const { calls } = run({})
    assert.equal(calls.some((c) => c.startsWith('chown ')), false, calls.join(' | '))
    assert.ok(calls.some((c) => c.startsWith('su-exec ')))
  })

  it('does nothing when STORE_DIR names something that is not there', () => {
    const { calls } = run({ storeDir: '/no/such/path' })
    assert.equal(calls.some((c) => c.startsWith('chown ')), false, calls.join(' | '))
    assert.ok(calls.some((c) => c.startsWith('su-exec ')))
  })

  it('still starts the server when the chown fails, and says so', () => {
    // Losing a restaurant's website over a directory's ownership is a worse failure than a store
    // that reports EACCES by name — which it already does, on the boot line and through /api/ready.
    const dir = dirThatExists()
    const { calls, status, stdout } = run({ storeDir: dir, chownFails: true })
    assert.equal(status, 0, 'a failed chown brought the container down')
    assert.ok(calls.some((c) => c.startsWith('su-exec ')), 'the server was never started')
    assert.match(stdout, /could not take ownership/)
  })
})
