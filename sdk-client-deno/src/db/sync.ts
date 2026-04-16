import type { Database } from '@db/sqlite'
import type { Platform } from '../platform/types.ts'

async function pull(
  platform: Platform,
  bucket: string,
  tenantId: string,
  localPath: string,
): Promise<void> {
  const remotePath = `${tenantId}/registry.db`
  try {
    const exists = await platform.storageExists(bucket, remotePath)
    if (!exists) return

    const data = await platform.storageDownload(bucket, remotePath)
    if (data.byteLength <= 4096) return
    await Deno.writeFile(localPath, data)
  } catch {
    // first run or bucket doesn't exist yet
  }
}

async function push(
  platform: Platform,
  bucket: string,
  tenantId: string,
  localPath: string,
  db?: Database,
): Promise<void> {
  const remotePath = `${tenantId}/registry.db`
  try {
    if (db) {
      try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      } catch {
        // checkpoint failed — upload whatever we have
      }
    }
    const data = await Deno.readFile(localPath)
    if (data.byteLength <= 4096) return
    await platform.storageUpload(bucket, remotePath, data)
  } catch {
    // non-fatal
  }
}

export { pull, push }
