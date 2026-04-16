import { Hono } from '@hono/hono'
import { context } from './types.ts'
import type { Env } from './types.ts'
import logger from '@ar/client/utils/logger'
import { close, open, setSyncFn } from '@ar/client/db'
import { pull, push } from '@ar/client/db/sync'
import platform from '@ar/client/platform'
import gracefulShutdown from '@ar/client/utils/graceful-shutdown'
import { load as loadRuntime } from '@ar/client/runtime'
import { apiAuth, slackBotAuth } from './middleware/auth.ts'
import { resolveTenant } from './middleware/tenant.ts'
import { auditMiddleware } from './middleware/audit.ts'
import authApi from './api/auth.ts'
import webApp from './api/web.ts'
import agentsApi from './api/agents.ts'
import configsApi from './api/configs.ts'
import teamsApi from './api/teams.ts'
import {
  rules as rulesApi,
  skills as skillsApi,
  tools as toolsApi,
} from './api/registry.ts'
import registryStatusApi from './api/registry-status.ts'
import copyApi from './api/copy.ts'
import auditApi from './api/audit.ts'
import secretsApi from './api/secrets.ts'
import runtimeApi from './api/runtime.ts'
import telemetryApi from './api/telemetry.ts'
import systemApi from './api/system/routes.ts'
import storageApi from './api/storage.ts'
import demosApi from './api/demos/routes.ts'
import accessApi from './api/access/routes.ts'
import settingsApi from './api/settings.ts'
import artifactsApi from './api/artifacts.ts'
import slackBotApi from './api/bots/slack/routes.ts'
import { handleSlackEvent, initBot } from './bots/slack/mod.ts'
import docsApi from './api/docs.ts'

const app = new Hono<Env>()

app.use('*', async (c, next) => {
  const { pathname, search } = new URL(c.req.url)
  if (pathname !== '/' && pathname.endsWith('/')) {
    return c.redirect(pathname.slice(0, -1) + search, 301)
  }
  await next()
})

app.get('/health', (c) => c.json({ status: 'ok' }))

app.get('/', (c) => {
  const accept = c.req.header('accept') || ''
  if (accept.includes('text/html')) return c.redirect('/web/')
  return c.json({ status: 'ok', docs: '/web/' })
})

app.post('/slack/events', async (c) => {
  return await handleSlackEvent(c.req.raw)
})

app.route('/web/auth', authApi)

app.get('/web/switch-tenant', (c) => {
  const tenantId = c.req.query('tenant')
  const redirect = c.req.query('redirect') || '/web/'
  if (!tenantId || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(tenantId)) {
    return c.redirect('/web/')
  }
  return new Response(null, {
    status: 302,
    headers: {
      'Location': redirect,
      'Set-Cookie': `ar_tenant=${tenantId}; Path=/; SameSite=Lax; Secure`,
    },
  })
})

app.route('/web', webApp)

app.route('/api/docs', docsApi)

app.use('/api/bots/slack/*', slackBotAuth)
app.route('/api/bots/slack', slackBotApi)

app.use('/api/*', apiAuth)
app.use('/registry/*', apiAuth)
app.use('/agents/*', apiAuth)
app.use('/configs/*', apiAuth)
app.use('/teams/*', apiAuth)
app.use('/departments/*', apiAuth)
app.use('/tools/*', apiAuth)
app.use('/skills/*', apiAuth)
app.use('/rules/*', apiAuth)
app.use('/copy/*', apiAuth)
app.use('/audit/*', apiAuth)
app.use('/secrets/*', apiAuth)
app.use('/runtime/*', apiAuth)
app.use('/telemetry/*', apiAuth)
app.use('/storage/*', apiAuth)
app.use('/demos/*', apiAuth)
app.use('/api/demos/*', apiAuth)
app.use('/access/*', apiAuth)
app.use('/api/access/*', apiAuth)
app.use('/system/*', apiAuth)
app.use('/api/artifacts/*', apiAuth)
app.use('*', resolveTenant)
app.use('*', auditMiddleware)

app.post('/webhook/:id', async (c) => {
  const webhookId = c.req.param('id')
  const db = (await import('@ar/client/db')).getDb()

  const whRow = db.prepare(
    'SELECT * FROM webhook_config WHERE id = ?',
  ).get(webhookId) as { id: string; tenant_id: string } | undefined
  if (!whRow) return c.json({ error: 'Webhook not found' }, 404)

  const edgeRow = db.prepare(
    `SELECT agent_id FROM agent_edge
     WHERE ref_type = 'webhook' AND ref_id = ? AND direction = 'consumes'
     LIMIT 1`,
  ).get(webhookId) as { agent_id: string } | undefined
  if (!edgeRow) return c.json({ error: 'No agent bound' }, 404)

  const body = await c.req.json().catch(() => ({}))
  logger.print(
    `Webhook ${webhookId.slice(0, 8)} -> agent ${edgeRow.agent_id}`,
  )

  return c.json({
    accepted: true,
    webhookId,
    receivedAt: new Date().toISOString(),
    bodyKeys: Object.keys(body as Record<string, unknown>),
  })
})

app.route('/agents', agentsApi)
app.route('/api/agents', agentsApi)
app.route('/configs', configsApi)
app.route('/', teamsApi)
app.route('/api', teamsApi)
app.route('/tools', toolsApi)
app.route('/skills', skillsApi)
app.route('/rules', rulesApi)
app.route('/api/registry/status', registryStatusApi)
app.route('/copy', copyApi)
app.route('/audit', auditApi)
app.route('/secrets', secretsApi)
app.route('/runtime', runtimeApi)
app.route('/telemetry', telemetryApi)
app.route('/storage', storageApi)
app.route('/demos', demosApi)
app.route('/api/demos', demosApi)
app.route('/access', accessApi)
app.route('/api/access', accessApi)
app.route('/system', systemApi)
app.route('/api/artifacts', artifactsApi)
app.route('/api/settings', settingsApi)

app.get('/api/user/permissions', (c) => {
  const { tenantId, email, isAdmin } = context(c)
  return c.json({
    email,
    tenantId,
    isAdmin,
    canPublish: isAdmin,
  })
})

app.get('/api/user/tenants', (c) => {
  const rc = loadRuntime()
  return c.json(rc.tenants.bootstrapped)
})

app.post('/api/user/tenant', async (c) => {
  const body = await c.req.json() as { tenantId?: string }
  const tenantId = body.tenantId
  if (!tenantId || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(tenantId)) {
    return c.json({ error: 'Invalid tenant' }, 400)
  }
  return new Response(JSON.stringify({ ok: true, tenantId }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': `ar_tenant=${tenantId}; Path=/; SameSite=Lax; Secure`,
    },
  })
})

async function start(
  port = loadRuntime().controlPlane.port,
): Promise<void> {
  const rc = loadRuntime()
  const project = Deno.env.get('GCP_PROJECT') ||
    Deno.env.get('GOOGLE_CLOUD_PROJECT') || ''
  const bucket = project ? `${project}-ar-registry` : ''
  const dbBase = Deno.env.get('AR_DB_PATH') || '/data'
  const tenants = rc.tenants.bootstrapped

  for (const tenantId of tenants) {
    if (bucket) {
      const path = `${dbBase}/${tenantId}.db`
      await pull(platform, bucket, tenantId, path).catch(() => {})
    }
    await open({ id: tenantId, name: tenantId }, 'server')
  }

  if (bucket) {
    setSyncFn(async (tenantId: string, path: string, db) => {
      await push(platform, bucket, tenantId, path, db)
    })
    for (const tenantId of tenants) {
      const path = `${dbBase}/${tenantId}.db`
      const db = await open({ id: tenantId, name: tenantId }, 'server')
      await push(platform, bucket, tenantId, path, db).catch(() => {})
    }
  }

  if (Deno.env.get('SLACK_BOT_TOKEN')) {
    initBot()
  }

  gracefulShutdown.addShutdownHandler(async () => {
    await close()
  })
  gracefulShutdown.start()

  logger.print(`Control plane listening on :${port}`)
  Deno.serve({ port }, app.fetch)
}

if (import.meta.main) {
  const rc = loadRuntime()
  const port = parseInt(
    Deno.env.get('PORT') || String(rc.controlPlane.port),
    10,
  )
  await start(port)
}

export { app, start }
