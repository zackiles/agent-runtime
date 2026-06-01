import { Hono } from '@hono/hono'
import { context } from '../types.ts'
import type { Env } from '../types.ts'
import { webAuth } from '../middleware/auth.ts'
import { handle as proxyDemo } from './demos/proxy.ts'
import { load as loadRuntime } from '@ar/client/runtime'

let web: Awaited<ReturnType<typeof loadWeb>> | null = null

async function loadWeb() {
  const { create } = await import('@ar/web')
  return create()
}

async function getWeb() {
  if (!web) web = await loadWeb()
  return web
}

const app = new Hono<Env>()

app.get('/static/*', async (c) => {
  const w = await getWeb()
  const file = c.req.path.replace('/web/static/', '')
  return w.serveStatic(file)
})

app.get('/agents', (c) => c.redirect('/web/registry'))
app.get('/agents/*', (c) => c.redirect('/web/registry'))
app.get('/copy', (c) => c.redirect('/web/registry'))
app.get('/copy/*', (c) => c.redirect('/web/registry'))

app.all('/d/:name', webAuth, proxyDemo)
app.all('/d/:name/*', webAuth, proxyDemo)

app.get('/*', webAuth, async (c) => {
  const w = await getWeb()
  const ctx = context(c)
  const pagePath = new URL(c.req.url).pathname.replace(/^\/web/, '')
  const rc = loadRuntime()
  const tenants = rc.tenants.bootstrapped
  return new Response(
    w.renderPage(pagePath, {
      email: ctx.email,
      isAdmin: ctx.isAdmin,
      tenantId: ctx.tenantId,
      tenants,
    }),
    {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'X-Frame-Options': 'DENY',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
      },
    },
  )
})

export default app
