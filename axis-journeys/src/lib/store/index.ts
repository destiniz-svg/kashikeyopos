/** Picks the driver named by configuration and hands back one shared instance per process. */
import { config } from '../config'
import { DynamoStore } from './dynamo-store'
import { FileStore } from './file-store'
import type { DocumentStore } from './types'

let instance: DocumentStore | null = null

export function getStore(): DocumentStore {
  if (instance) return instance
  if (config.store.driver === 'dynamodb') {
    instance = new DynamoStore({
      table: config.store.table,
      region: config.store.region,
      credentials: {
        accessKeyId: config.aws.accessKeyId,
        secretAccessKey: config.aws.secretAccessKey,
        sessionToken: config.aws.sessionToken || undefined,
      },
    })
  } else {
    instance = new FileStore(config.store.dir)
  }
  return instance
}

/** Test support: swap the driver. The application never calls this. */
export function setStore(store: DocumentStore | null): void {
  instance = store
}

export * from './types'
