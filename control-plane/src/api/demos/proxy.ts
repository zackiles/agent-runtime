import type { Context } from '@hono/hono'
import type { Env } from '../../types.ts'
import { context } from '../../types.ts'
import { webAuth } from '../../middleware/auth.ts'
import { listDemos, loadMeta, slugify } from '@ar/client/operations/demos'
import type { DemoMeta } from '@ar/client/operations/demos'
import platform from '@ar/client/platform'
import logger from '@ar/client/utils/logger'
import { gcpConfig } from './deploy.ts'

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

async function resolveDemo(
  project: string,
  tenantId: string,
  email: string,
  isAdmin: boolean,
  name: string,
): Promise<DemoMeta | null> {
  const own = await loadMeta(project, tenantId, email, name)
  if (own) return own
  // A private demo belongs to its creator; only admins may reach another
  // user's demo. Without this guard any tenant member could invoke a
  // private Cloud Run service just by knowing the slug.
  if (!isAdmin) return null
  const all = await listDemos(project, tenantId)
  return all.find((d) => d.name === name) ?? null
}

function rewriteLocation(
  location: string,
  origin: string,
  prefix: string,
): string {
  if (location.startsWith(origin)) {
    return prefix + location.slice(origin.length)
  }
  // Root-relative redirects (e.g. `Location: /login`) would otherwise send
  // the browser to the control-plane host, escaping the proxied demo.
  if (location.startsWith('/') && !location.startsWith('//')) {
    return prefix + location
  }
  return location
}

function rewriteHtml(html: string, prefix: string): string {
  const withBase = html.replace(
    /<head([^>]*)>/i,
    `<head$1><base href="${prefix}/">`,
  )
  return withBase.replace(
    /(\b(?:href|src|action)\s*=\s*["'])\/(?!\/)/gi,
    `$1${prefix}/`,
  )
}

function notFound(name: string): Response {
  return new Response(
    `<!DOCTYPE html><meta charset="utf-8"><title>Demo not found</title>` +
      `<p>Demo <code>${name}</code> was not found, is not running, or you ` +
      `do not have access to it.</p>`,
    { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  )
}

async function forward(
  c: Context<Env>,
  meta: DemoMeta,
  name: string,
  rest: string,
): Promise<Response> {
  const target = new URL(meta.url!)
  const reqUrl = new URL(c.req.url)
  const prefix = `/web/d/${name}`

  let token: string
  try {
    token = await platform.getIdentityToken(target.origin)
  } catch (err) {
    logger.error('Failed to mint demo identity token', err)
    return new Response('Demo auth failed', { status: 502 })
  }

  const headers = new Headers()
  for (const [k, v] of c.req.raw.headers) {
    const lk = k.toLowerCase()
    if (lk === 'cookie' || lk === 'host' || lk === 'authorization') continue
    if (HOP_BY_HOP.has(lk)) continue
    headers.set(k, v)
  }
  headers.set('Authorization', `Bearer ${token}`)

  const method = c.req.method
  const init: RequestInit = { method, headers, redirect: 'manual' }
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = await c.req.raw.arrayBuffer()
  }

  let upstream: Response
  try {
    upstream = await fetch(`${target.origin}${rest}${reqUrl.search}`, init)
  } catch (err) {
    logger.error('Demo proxy fetch failed', err)
    return new Response('Demo unreachable', { status: 502 })
  }

  const ct = upstream.headers.get('content-type') || ''
  const isHtml = ct.includes('text/html')
  const out = new Headers()
  for (const [k, v] of upstream.headers) {
    const lk = k.toLowerCase()
    if (HOP_BY_HOP.has(lk)) continue
    if (lk === 'location') {
      out.set(k, rewriteLocation(v, target.origin, prefix))
      continue
    }
    // Rewritten HTML is decoded and re-sized, so drop stale framing headers.
    if (isHtml && (lk === 'content-length' || lk === 'content-encoding')) {
      continue
    }
    out.set(k, v)
  }

  if (isHtml) {
    const text = rewriteHtml(await upstream.text(), prefix)
    return new Response(text, { status: upstream.status, headers: out })
  }
  return new Response(upstream.body, { status: upstream.status, headers: out })
}

async function handle(c: Context<Env>): Promise<Response> {
  const { tenantId, email, isAdmin } = context(c)
  const { project } = gcpConfig()
  const name = slugify(c.req.param('name') || '')

  const meta = await resolveDemo(project, tenantId, email, isAdmin, name)
  if (!meta || !meta.url || meta.status !== 'running') return notFound(name)

  // Public demos are bound to allUsers and reachable directly.
  if (meta.visibility !== 'private') return c.redirect(meta.url, 302)

  const prefix = `/web/d/${name}`
  const reqUrl = new URL(c.req.url)
  // The control plane strips trailing slashes globally, so the proxy root has
  // no trailing slash; the injected `<base href>` handles relative resolution.
  const rest = reqUrl.pathname.slice(prefix.length) || '/'
  return forward(c, meta, name, rest)
}

// A proxied demo runs under the `/web/d/<slug>` prefix, but JavaScript inside
// the demo (e.g. `fetch('/data/products.json')`) issues root-absolute requests
// that bypass the injected `<base href>` and the HTML attribute rewriting, so
// they land on the control plane root and 404. When such an unmatched request
// carries a `Referer` pointing at a proxied demo, route it back to that demo.
async function referred(c: Context<Env>): Promise<Response> {
  let name = ''
  try {
    const ref = c.req.header('referer') || ''
    name = slugify(
      new URL(ref).pathname.match(/^\/web\/d\/([^/?#]+)/)?.[1] || '',
    )
  } catch {
    name = ''
  }
  if (!name) return c.notFound()

  let proxied: Response | undefined
  const denied = await webAuth(c, async () => {
    const { tenantId, email, isAdmin } = context(c)
    const { project } = gcpConfig()
    const meta = await resolveDemo(project, tenantId, email, isAdmin, name)
    if (!meta || !meta.url || meta.status !== 'running') {
      proxied = await c.notFound()
      return
    }

    const reqUrl = new URL(c.req.url)
    if (meta.visibility !== 'private') {
      const base = meta.url.replace(/\/+$/, '')
      proxied = c.redirect(`${base}${reqUrl.pathname}${reqUrl.search}`, 302)
      return
    }
    proxied = await forward(c, meta, name, reqUrl.pathname)
  })
  return denied ?? proxied ?? c.notFound()
}

export { handle, referred }
