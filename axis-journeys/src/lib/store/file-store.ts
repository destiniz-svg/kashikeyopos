/**
 * The filesystem driver: a real store for local development, CI and a single-node deploy.
 *
 * One JSON file per partition, written through a temp file and renamed, so a crash mid-write leaves
 * the previous file rather than half of the next one. Writes are serialised per partition through a
 * promise chain — Node is single-threaded but `await` is not, and two concurrent publishes reading
 * the same partition would otherwise lose one of them.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { DocumentStore, StoredItem } from './types'

type Partition = Record<string, { body: unknown; ttl?: number }>

export class FileStore implements DocumentStore {
  private readonly dir: string
  private readonly cache = new Map<string, Partition>()
  private chain: Promise<unknown> = Promise.resolve()

  constructor(dir: string) {
    this.dir = resolve(dir)
  }

  private file(pk: string): string {
    // A partition key is app-controlled, but it reaches a path — so anything that is not a plain
    // key is encoded rather than trusted. `..` never becomes a directory here.
    return join(this.dir, encodeURIComponent(pk) + '.json')
  }

  private async read(pk: string): Promise<Partition> {
    const hit = this.cache.get(pk)
    if (hit) return hit
    let part: Partition = {}
    try {
      const raw = await readFile(this.file(pk), 'utf8')
      part = JSON.parse(raw) as Partition
    } catch {
      part = {}
    }
    this.cache.set(pk, part)
    return part
  }

  private async flush(pk: string, part: Partition): Promise<void> {
    const path = this.file(pk)
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, JSON.stringify(part), 'utf8')
    await rename(tmp, path)
  }

  /** Every mutation runs in order; a rejected write does not break the chain for the next one. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn)
    this.chain = next.catch(() => undefined)
    return next
  }

  private live(entry: { body: unknown; ttl?: number } | undefined): boolean {
    if (!entry) return false
    return !entry.ttl || entry.ttl * 1000 > Date.now()
  }

  async get<T>(pk: string, sk: string): Promise<T | null> {
    const part = await this.read(pk)
    const entry = part[sk]
    return this.live(entry) ? ((entry as { body: T }).body ?? null) : null
  }

  async list<T>(pk: string): Promise<{ sk: string; body: T }[]> {
    const part = await this.read(pk)
    return Object.keys(part)
      .filter((sk) => this.live(part[sk]))
      .sort()
      .map((sk) => ({ sk, body: (part[sk] as { body: T }).body }))
  }

  async put<T>(pk: string, sk: string, body: T, ttl?: number): Promise<void> {
    await this.putMany([{ pk, sk, body, ttl }])
  }

  async putMany(items: StoredItem[]): Promise<void> {
    await this.serial(async () => {
      const touched = new Set<string>()
      for (const it of items) {
        const part = await this.read(it.pk)
        part[it.sk] = it.ttl ? { body: it.body, ttl: it.ttl } : { body: it.body }
        touched.add(it.pk)
      }
      for (const pk of touched) await this.flush(pk, await this.read(pk))
    })
  }

  async delete(pk: string, sk: string): Promise<void> {
    await this.serial(async () => {
      const part = await this.read(pk)
      if (!(sk in part)) return
      delete part[sk]
      await this.flush(pk, part)
    })
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      await mkdir(this.dir, { recursive: true })
      const probe = join(this.dir, '.health')
      await writeFile(probe, String(Date.now()), 'utf8')
      return { ok: true, detail: `file store at ${this.dir}` }
    } catch (e) {
      return { ok: false, detail: `file store at ${this.dir} is not writable: ${(e as Error).message}` }
    }
  }

  /** Test support: forget everything read so far. Never called by the application. */
  reset(): void {
    this.cache.clear()
  }

  get directory(): string {
    return this.dir
  }

  get exists(): boolean {
    return existsSync(this.dir)
  }
}
