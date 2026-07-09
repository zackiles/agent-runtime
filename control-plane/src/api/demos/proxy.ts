import type { Context } from '@hono/hono'
import type { Env } from '../../types.ts'
import { context } from '../../types.ts'
import { webAuth } from '../../middleware/auth.ts'
import { slugify } from '@ar/client/operations/demos'
import type { DemoMeta } from '@ar/client/operations/demos'
import platform from '@ar/client/platform'
import logger from '@ar/client/utils/logger'
import { gcpConfig } from './deploy.ts'
import { isAmbiguous, resolveAccess } from './access.ts'
import type { Ambiguous } from './access.ts'

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

// The proxy serves a demo under the flat `/web/d/{slug}` prefix, so a shared
// demo (which may collide with another owner's slug) must keep its `?owner=`
// hint across every follow-up request. Assets loaded via the injected
// `<base href>` carry a same-origin `Referer` of `/web/d/{slug}?owner=…`, so
// the hint is recoverable even when the asset URL itself dropped the query.
function ownerHint(c: Context<Env>): string | undefined {
  const q = c.req.query('owner')
  if (q) return q
  try {
    const ref = c.req.header('referer') || ''
    return new URL(ref).searchParams.get('owner') || undefined
  } catch {
    return undefined
  }
}

function ownerQuery(owner?: string): string {
  return owner ? `?owner=${encodeURIComponent(owner)}` : ''
}

function withOwner(url: string, owner?: string): string {
  if (!owner || url.includes('owner=')) return url
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}owner=${encodeURIComponent(owner)}`
}

function rewriteLocation(
  location: string,
  origin: string,
  prefix: string,
  owner?: string,
): string {
  if (location.startsWith(origin)) {
    return withOwner(prefix + location.slice(origin.length), owner)
  }
  // Root-relative redirects (e.g. `Location: /login`) would otherwise send
  // the browser to the control-plane host, escaping the proxied demo.
  if (location.startsWith('/') && !location.startsWith('//')) {
    return withOwner(prefix + location, owner)
  }
  return location
}

function rewriteHtml(html: string, prefix: string, owner?: string): string {
  const withBase = html.replace(
    /<head([^>]*)>/i,
    `<head$1><base href="${prefix}/${ownerQuery(owner)}">`,
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

function disambiguation(name: string, result: Ambiguous): Response {
  const links = result.owners
    .map((o) =>
      `<li><a href="/web/d/${name}?owner=${encodeURIComponent(o)}">` +
      `${o}</a></li>`
    )
    .join('')
  return new Response(
    `<!DOCTYPE html><meta charset="utf-8"><title>Which demo?</title>` +
      `<p>The demo <code>${name}</code> is shared with you by more than one ` +
      `owner. Choose which one to open:</p><ul>${links}</ul>`,
    { status: 300, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  )
}

async function forward(
  c: Context<Env>,
  meta: DemoMeta,
  name: string,
  rest: string,
  owner?: string,
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

  // The demo never needs the proxy's `?owner=` hint; strip it from the
  // upstream query so it does not leak into the demo's own routing.
  const upstreamSearch = (() => {
    const params = new URLSearchParams(reqUrl.search)
    params.delete('owner')
    const s = params.toString()
    return s ? `?${s}` : ''
  })()

  let upstream: Response
  try {
    upstream = await fetch(`${target.origin}${rest}${upstreamSearch}`, init)
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
      out.set(k, rewriteLocation(v, target.origin, prefix, owner))
      continue
    }
    // Rewritten HTML is decoded and re-sized, so drop stale framing headers.
    if (isHtml && (lk === 'content-length' || lk === 'content-encoding')) {
      continue
    }
    out.set(k, v)
  }

  if (isHtml) {
    const text = rewriteHtml(await upstream.text(), prefix, owner)
    return new Response(text, { status: upstream.status, headers: out })
  }
  return new Response(upstream.body, { status: upstream.status, headers: out })
}

async function handle(c: Context<Env>): Promise<Response> {
  const { tenantId, email, isAdmin } = context(c)
  const { project } = gcpConfig()
  const name = slugify(c.req.param('name') || '')
  const owner = ownerHint(c)

  const access = await resolveAccess(
    project,
    tenantId,
    email,
    isAdmin,
    name,
    owner,
  )
  if (isAmbiguous(access)) return disambiguation(name, access)
  const meta = access?.meta
  if (!meta || !meta.url || meta.status !== 'running') return notFound(name)

  // Public demos are bound to allUsers and reachable directly.
  if (meta.visibility !== 'private') return c.redirect(meta.url, 302)

  const prefix = `/web/d/${name}`
  const reqUrl = new URL(c.req.url)
  // The control plane strips trailing slashes globally, so the proxy root has
  // no trailing slash; the injected `<base href>` handles relative resolution.
  const rest = reqUrl.pathname.slice(prefix.length) || '/'
  return forward(c, meta, name, rest, access!.ownerId)
}

// A proxied demo runs under the `/web/d/<slug>` prefix, but JavaScript inside
// the demo (e.g. `fetch('/data/products.json')`) issues root-absolute requests
// that bypass the injected `<base href>` and the HTML attribute rewriting, so
// they land on the control plane root and 404. When such an unmatched request
// carries a `Referer` pointing at a proxied demo, route it back to that demo.
async function referred(c: Context<Env>): Promise<Response> {
  let name = ''
  let owner: string | undefined
  try {
    const ref = c.req.header('referer') || ''
    const refUrl = new URL(ref)
    name = slugify(
      refUrl.pathname.match(/^\/web\/d\/([^/?#]+)/)?.[1] || '',
    )
    owner = refUrl.searchParams.get('owner') || undefined
  } catch {
    name = ''
  }
  if (!name) return c.notFound()

  let proxied: Response | undefined
  const denied = await webAuth(c, async () => {
    const { tenantId, email, isAdmin } = context(c)
    const { project } = gcpConfig()
    const access = await resolveAccess(
      project,
      tenantId,
      email,
      isAdmin,
      name,
      owner,
    )
    const meta = isAmbiguous(access) ? null : access?.meta
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
    proxied = await forward(
      c,
      meta,
      name,
      reqUrl.pathname,
      isAmbiguous(access) ? undefined : access?.ownerId,
    )
  })
  return denied ?? proxied ?? c.notFound()
}

export { handle, referred }
