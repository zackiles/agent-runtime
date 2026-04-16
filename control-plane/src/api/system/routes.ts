import { Hono } from '@hono/hono'
import { exists } from '@std/fs'
import { context } from '../../types.ts'
import type { Env } from '../../types.ts'
import {
  BUILD_AUTHOR,
  BUILD_BRANCH,
  BUILD_COMMIT,
  BUILD_DATE,
  BUILD_MODE,
  BUILD_VERSION,
} from '@ar/client/build'
import loadRuntime from '@ar/client/runtime'
import { closeTenant, open } from '@ar/client/db'
import platform from '@ar/client/platform'
import logger from '@ar/client/utils/logger'
import { incidentIoConfigured } from '@ar/client'
import { listDemos } from '@ar/client/operations/demos'
import { cloudRunDetails, gcpContext, storageSummary } from './gcp.ts'

let pkg = { name: '@ar/control-plane', version: BUILD_VERSION }
try {
  pkg = JSON.parse(
    Deno.readTextFileSync(
      new URL('../../../deno.jsonc', import.meta.url),
    ).replace(/\/\/.*$/gm, ''),
  ) as typeof pkg
} catch {
  // compiled binary — deno.jsonc not available
}

const app = new Hono<Env>()

app.get('/', async (c) => {
  const { tenantId, isAdmin } = context(c)
  if (!isAdmin) return c.json({ error: 'Admin only' }, 403)
  const project = Deno.env.get('GCP_PROJECT') ||
    Deno.env.get('GOOGLE_CLOUD_PROJECT') || ''
  const configRegion = Deno.env.get('GCP_REGION') || ''
  const runtimeAccount = Deno.env.get('AR_RUNTIME_ACCOUNT') || ''
  const workerAccount = Deno.env.get('AR_WORKER_ACCOUNT') || ''
  const slackBotAccount = Deno.env.get('AR_BOT_SLACK_SA') ||
    (project ? `ar-bot-slack@${project}.iam.gserviceaccount.com` : '')
  const vpcConnector = Deno.env.get('GCP_VPC_CONNECTOR') || ''
  const service = Deno.env.get('K_SERVICE') || ''
  const configuration = Deno.env.get('K_CONFIGURATION') || ''

  const gcp = await gcpContext()
  const effectiveProject = project || gcp.projectId
  const effectiveRegion = configRegion || gcp.region

  const [runService, storage] = await Promise.all([
    service && effectiveProject && effectiveRegion
      ? cloudRunDetails(effectiveProject, effectiveRegion, service)
      : Promise.resolve(null),
    effectiveProject
      ? storageSummary(
        `${effectiveProject}-ar-registry`,
        `${tenantId}/`,
      )
      : Promise.resolve({ files: 0, bytes: 0 }),
  ])

  const container = runService?.template?.containers?.[0]
  const scaling = runService?.template?.scaling
  const effectiveRuntimeAccount = runtimeAccount ||
    runService?.template?.serviceAccount || ''

  return c.json({
    build: {
      version: pkg.version,
      mode: BUILD_MODE,
      commit: BUILD_COMMIT,
      author: BUILD_AUTHOR,
      date: BUILD_DATE,
      branch: BUILD_BRANCH,
    },
    gcp: {
      project: effectiveProject,
      region: effectiveRegion,
      zone: gcp.zone,
      numericProjectId: gcp.numericId,
      runtimeAccount: effectiveRuntimeAccount,
      workerAccount,
      slackBotAccount,
      vpcConnector,
    },
    cloudRun: {
      service,
      revision: `${pkg.name}@${pkg.version}`,
      configuration,
      uri: runService?.uri || '',
      latestRevision: runService?.latestReadyRevision || '',
      createdAt: runService?.createTime || '',
      updatedAt: runService?.updateTime || '',
      executionEnvironment: runService?.template?.executionEnvironment ||
        '',
      timeout: runService?.template?.timeout || '',
      cpu: container?.resources?.limits?.cpu || '',
      memory: container?.resources?.limits?.memory || '',
      minInstances: scaling?.minInstanceCount ?? 0,
      maxInstances: scaling?.maxInstanceCount ?? 0,
    },
    agents: {
      deployMode: loadRuntime().agents?.deployMode || 'container',
    },
    storage: {
      bucket: effectiveProject ? `${effectiveProject}-ar-registry` : '',
      tenant: tenantId,
      files: storage.files,
      bytes: storage.bytes,
    },
    integrations: {
      incidentIo: incidentIoConfigured(),
    },
  })
})

app.post('/reset', async (c) => {
  const { tenantId, isAdmin } = context(c)
  if (!isAdmin) return c.json({ error: 'Admin only' }, 403)

  const body = await c.req.json().catch(() => ({})) as {
    confirm?: string
  }
  if (body.confirm !== `RESET-${tenantId}`) {
    return c.json({
      error: `Send {"confirm": "RESET-${tenantId}"} to confirm`,
    }, 400)
  }

  const project = Deno.env.get('GCP_PROJECT') ||
    Deno.env.get('GOOGLE_CLOUD_PROJECT') || ''
  const region = Deno.env.get('GCP_REGION') || ''
  const bucket = project ? `${project}-ar-registry` : ''

  let demosDestroyed = 0
  let storageDeleted = 0
  let databaseReset = false

  if (project && region) {
    try {
      const demos = await listDemos(project, tenantId)
      const running = demos.filter((d) => d.status === 'running')
      for (const demo of running) {
        const svc = `demo-${tenantId}-${demo.name}`.slice(0, 63)
        try {
          const token = await platform.getAccessToken()
          const url = `https://run.googleapis.com/v2/projects/${project}` +
            `/locations/${region}/services/${svc}`
          const res = await fetch(url, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` },
          })
          if (res.ok || res.status === 404) demosDestroyed++
        } catch {
          logger.warn(`Failed to destroy demo service ${svc}`)
        }
      }
    } catch {
      logger.warn('Failed to list demos for cleanup')
    }
  }

  if (bucket) {
    try {
      const prefix = `${tenantId}/`
      const paths = await platform.storageList(bucket, prefix)
      for (const p of paths) {
        await platform.storageDelete(bucket, p)
        storageDeleted++
      }
    } catch {
      logger.warn('Failed to clean tenant storage')
    }
  }

  const dbPath = closeTenant(tenantId)
  if (dbPath && await exists(dbPath)) {
    try {
      await Deno.remove(dbPath)
      const walPath = `${dbPath}-wal`
      const shmPath = `${dbPath}-shm`
      await Deno.remove(walPath).catch(() => {})
      await Deno.remove(shmPath).catch(() => {})
      databaseReset = true
    } catch {
      logger.warn(`Failed to delete database file ${dbPath}`)
    }
  }

  await open({ id: tenantId, name: tenantId }, 'server')

  return c.json({
    tenantId,
    demos: demosDestroyed,
    storage: storageDeleted,
    database: databaseReset,
  })
})

export default app
