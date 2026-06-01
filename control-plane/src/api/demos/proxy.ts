import type { Context } from '@hono/hono'
import type { Env } from '../../types.ts'
import { context } from '../../types.ts'
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

async function handle(c: Context<Env>): Promise<Response> {
  const { tenantId, email, isAdmin } = context(c)
  const { project } = gcpConfig()
  const name = slugify(c.req.param('name') || '')

  const meta = await resolveDemo(project, tenantId, email, isAdmin, name)
  if (!meta || !meta.url || meta.status !== 'running') return notFound(name)

  // Public demos are bound to allUsers and reachable directly.
  if (meta.visibility !== 'private') return c.redirect(meta.url, 302)

  const target = new URL(meta.url)
  const reqUrl = new URL(c.req.url)
  const prefix = `/web/d/${name}`
  const rest = reqUrl.pathname.slice(prefix.length)

  // A trailing slash makes the demo's relative asset URLs resolve under the
  // proxy root rather than against /web/.
  if (rest === '') {
    return c.redirect(`${prefix}/${reqUrl.search}`, 302)
  }

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

export { handle }
