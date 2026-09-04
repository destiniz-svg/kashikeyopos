/**
 * The DynamoDB driver — the deployed one, single-table per ARCHITECTURE.md.
 *
 * Keys are `pk` (partition) and `sk` (sort), so one table holds every collection, the users, the
 * activity feed and the denormalised public bundle. Documents are stored as one JSON attribute
 * rather than mapped attribute-by-attribute: the content model is deeply nested tuples, and a
 * marshaller that has to be kept in step with the schema is a second place for it to drift.
 */
import { signRequest, type Credentials } from '../aws/sigv4'
import type { DocumentStore, StoredItem } from './types'

export interface DynamoOptions {
  table: string
  region: string
  credentials: Credentials
  /** Overridable so the suite can point the driver at a local stub speaking the same protocol. */
  endpoint?: string
  fetchImpl?: typeof fetch
}

interface AttrMap { [k: string]: { S?: string; N?: string; BOOL?: boolean } }

export class DynamoStore implements DocumentStore {
  private readonly opts: DynamoOptions

  constructor(opts: DynamoOptions) {
    this.opts = opts
  }

  private get endpoint(): string {
    return this.opts.endpoint || `https://dynamodb.${this.opts.region}.amazonaws.com`
  }

  private async call<T>(target: string, payload: unknown): Promise<T> {
    const body = JSON.stringify(payload)
    const signed = signRequest({
      method: 'POST',
      url: this.endpoint + '/',
      region: this.opts.region,
      service: 'dynamodb',
      headers: { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': `DynamoDB_20120810.${target}` },
      body,
      credentials: this.opts.credentials,
    })
    const doFetch = this.opts.fetchImpl ?? fetch
    const res = await doFetch(signed.url, { method: signed.method, headers: signed.headers, body: signed.body as BodyInit })
    const text = await res.text()
    if (!res.ok) {
      // The service's own words go to the log; the caller gets a class and a status. A DynamoDB
      // error body names the table and the account, and neither belongs in an HTTP response.
      const err = new Error(`DynamoDB ${target} failed (HTTP ${res.status})`) as Error & { detail?: string; status?: number }
      err.detail = text.replace(/\s+/g, ' ').slice(0, 400)
      err.status = res.status
      throw err
    }
    return text ? (JSON.parse(text) as T) : ({} as T)
  }

  private item(pk: string, sk: string, body: unknown, ttl?: number): AttrMap {
    const out: AttrMap = { pk: { S: pk }, sk: { S: sk }, body: { S: JSON.stringify(body) } }
    if (ttl) out.ttl = { N: String(Math.floor(ttl)) }
    return out
  }

  async get<T>(pk: string, sk: string): Promise<T | null> {
    const res = await this.call<{ Item?: AttrMap }>('GetItem', {
      TableName: this.opts.table,
      Key: { pk: { S: pk }, sk: { S: sk } },
      ConsistentRead: true,
    })
    const raw = res.Item?.body?.S
    return raw ? (JSON.parse(raw) as T) : null
  }

  async list<T>(pk: string): Promise<{ sk: string; body: T }[]> {
    const out: { sk: string; body: T }[] = []
    let start: AttrMap | undefined
    // A collection is bounded (properties, offers, destinations, users, media) but "bounded" is not
    // "one page" — a store with 500 media rows pages, and dropping the rest silently would be a
    // library that quietly stops at 100.
    do {
      const res = await this.call<{ Items?: AttrMap[]; LastEvaluatedKey?: AttrMap }>('Query', {
        TableName: this.opts.table,
        KeyConditionExpression: '#pk = :pk',
        ExpressionAttributeNames: { '#pk': 'pk' },
        ExpressionAttributeValues: { ':pk': { S: pk } },
        ...(start ? { ExclusiveStartKey: start } : {}),
      })
      for (const it of res.Items ?? []) {
        const ttl = it.ttl?.N ? Number(it.ttl.N) : 0
        if (ttl && ttl * 1000 <= Date.now()) continue // TTL deletion is eventual; do not serve a corpse
        if (it.sk?.S && it.body?.S) out.push({ sk: it.sk.S, body: JSON.parse(it.body.S) as T })
      }
      start = res.LastEvaluatedKey
    } while (start)
    return out.sort((a, b) => (a.sk < b.sk ? -1 : a.sk > b.sk ? 1 : 0))
  }

  async put<T>(pk: string, sk: string, body: T, ttl?: number): Promise<void> {
    await this.call('PutItem', { TableName: this.opts.table, Item: this.item(pk, sk, body, ttl) })
  }

  async putMany(items: StoredItem[]): Promise<void> {
    if (!items.length) return
    // TransactWriteItems is all-or-nothing and caps at 100 — which is what publish needs (the
    // document and the rewritten bundle land together, or neither does).
    for (let i = 0; i < items.length; i += 100) {
      const chunk = items.slice(i, i + 100)
      await this.call('TransactWriteItems', {
        TransactItems: chunk.map((it) => ({
          Put: { TableName: this.opts.table, Item: this.item(it.pk, it.sk, it.body, it.ttl) },
        })),
      })
    }
  }

  async delete(pk: string, sk: string): Promise<void> {
    await this.call('DeleteItem', { TableName: this.opts.table, Key: { pk: { S: pk }, sk: { S: sk } } })
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.call('DescribeTable', { TableName: this.opts.table })
      return { ok: true, detail: `dynamodb table ${this.opts.table} in ${this.opts.region}` }
    } catch (e) {
      const err = e as Error & { detail?: string }
      return { ok: false, detail: `${err.message}${err.detail ? ` — ${err.detail}` : ''}` }
    }
  }
}
