import { Hono } from '@hono/hono'
import type { Env } from '../types.ts'
import {
  remove as secretRemove,
  set as secretSet,
} from '@ar/client/operations/secrets'
import platform from '@ar/client/platform'

const project = Deno.env.get('GCP_PROJECT') ||
  Deno.env.get('GOOGLE_CLOUD_PROJECT') || ''
const region = Deno.env.get('GCP_REGION') || ''
const runtimeAccount = Deno.env.get('AR_RUNTIME_ACCOUNT') || ''
const registry = Deno.env.get('AR_REGISTRY') || Deno.cwd()

const app = new Hono<Env>()

app.post('/', async (c) => {
  const body = await c.req.json() as {
    name: string
    value: string
    agent?: string
  }
  await secretSet({
    ...body,
    project,
    region,
    runtimeAccount,
    registry,
  })
  return c.json({ message: `Secret '${body.name}' set.` })
})

app.delete('/:name', async (c) => {
  const agent = c.req.query('agent') || undefined
  await secretRemove({
    name: c.req.param('name'),
    agent,
    force: true,
    project,
  })
  return c.json({
    message: `Secret '${c.req.param('name')}' deleted.`,
  })
})

app.get('/', async (c) => {
  const secrets = await platform.secretList(project)
  const agent = c.req.query('agent')
  if (agent) {
    const prefix = `${agent}--`
    return c.json(secrets.filter((s) => s.name.startsWith(prefix)))
  }
  return c.json(secrets)
})

export default app
