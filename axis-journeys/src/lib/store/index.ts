/**
 * Picks the driver named by configuration and hands back one shared instance per process.
 *
 * Per PROCESS, through `singleton()`, and that word is load-bearing — see `src/lib/singleton.ts`
 * for what a module-level variable did here instead, and what it cost.
 */
import { config } from '../config'
import { singleton } from '../singleton'
import { DynamoStore } from './dynamo-store'
import { FileStore } from './file-store'
import type { DocumentStore } from './types'

export function getStore(): DocumentStore {
  return singleton<DocumentStore>('store', () => {
    if (config.store.driver !== 'dynamodb') return new FileStore(config.store.dir)
    return new DynamoStore({
      table: config.store.table,
      region: config.store.region,
      credentials: {
        accessKeyId: config.aws.accessKeyId,
        secretAccessKey: config.aws.secretAccessKey,
        sessionToken: config.aws.sessionToken || undefined,
      },
    })
  })
}

export * from './types'
