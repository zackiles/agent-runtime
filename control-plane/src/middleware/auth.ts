import type { Context, Next } from '@hono/hono'
import type { Env } from '../types.ts'
import {
  ensure,
  get as getUser,
  isAdmin as checkAdmin,
  setAdmin,
} from '@ar/client/db/users'
import { getIdentity } from '@ar/client/db/slack'
import {
  getByHash as getClientByHash,
  hash as hashKey,
  touch as touchClient,
} from '@ar/client/db/telemetry-clients'
import { open } from '@ar/client/db'
import { load as loadRuntime } from '@ar/client/runtime'
import { decode, extract } from '../session.ts'

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs'
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com']
const GCLOUD_CLIENT_ID = '32555940559.apps.googleusercontent.com'
const KEY_CACHE_MS = 3600_000

type JwkKey = {
  kid: string
  kty: string
  alg: string
  n: string
  e: string
  use: string
}

type JwtHeader = { kid?: string; alg?: string }
type JwtPayload = {
  iss?: string
  aud?: string
  email?: string
  email_verified?: boolean | string
  exp?: number
}

let cachedKeys: Map<string, CryptoKey> = new Map()
let cacheExpiry = 0

function decodeSegment(segment: string): string {
  return new TextDecoder().decode(
    Uint8Array.from(
      atob(segment.replace(/-/g, '+').replace(/_/g, '/')),
      (c) => c.charCodeAt(0),
    ),
  )
}

async function fetchKeys(): Promise<Map<string, CryptoKey>> {
  if (cachedKeys.size > 0 && Date.now() < cacheExpiry) return cachedKeys

  const res = await fetch(GOOGLE_JWKS_URL)
  if (!res.ok) throw new Error('Failed to fetch Google JWKS')
  const { keys } = await res.json() as { keys: JwkKey[] }

  const imported = new Map<string, CryptoKey>()
  for (const jwk of keys) {
    if (jwk.kty !== 'RSA' || jwk.use !== 'sig') continue
    const key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    )
    imported.set(jwk.kid, key)
  }

  cachedKeys = imported
  cacheExpiry = Date.now() + KEY_CACHE_MS
  return imported
}

async function verifyJwt(token: string): Promise<JwtPayload> {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('Not a JWT')

  const header = JSON.parse(decodeSegment(parts[0])) as JwtHeader
  if (!header.kid) throw new Error('JWT missing kid')

  const keys = await fetchKeys()
  let key = keys.get(header.kid)

  if (!key) {
    cacheExpiry = 0
    const refreshed = await fetchKeys()
    key = refreshed.get(header.kid)
    if (!key) throw new Error('Unknown signing key')
  }

  const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  const sig = Uint8Array.from(
    atob(parts[2].replace(/-/g, '+').replace(/_/g, '/')),
    (c) => c.charCodeAt(0),
  )

  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    sig,
    data,
  )
  if (!valid) throw new Error('Invalid signature')

  const payload = JSON.parse(decodeSegment(parts[1])) as JwtPayload

  if (!payload.iss || !GOOGLE_ISSUERS.includes(payload.iss)) {
    throw new Error('Invalid issuer')
  }

  const expectedAudience = Deno.env.get('AR_AUDIENCE') ||
    Deno.env.get('K_SERVICE') || ''
  if (expectedAudience) {
    if (!payload.aud) throw new Error('Token missing audience')
    const allowed = new Set([expectedAudience, GCLOUD_CLIENT_ID])
    const oauthClientId = Deno.env.get('GOOGLE_CLIENT_ID')
    if (oauthClientId) allowed.add(oauthClientId)
    if (!allowed.has(payload.aud)) {
      throw new Error('Invalid audience')
    }
  }

  if (payload.exp && payload.exp < Date.now() / 1000) {
    throw new Error('Token expired')
  }

  return payload
}

async function verifyToken(token: string): Promise<{ email: string }> {
  const payload = await verifyJwt(token)

  if (!payload.email) throw new Error('Token missing email claim')
  const verified = payload.email_verified === true ||
    payload.email_verified === 'true'
  if (!verified) throw new Error('Email not verified')

  return { email: payload.email }
}

function validateDomain(email: string): boolean {
  const allowed = Deno.env.get('AR_ALLOWED_DOMAINS')
  if (!allowed) return true
  const domains = allowed.split(',').map((d) => d.trim())
  const domain = email.split('@')[1]
  return domains.includes(domain)
}

function errorPage(
  status: number,
  title: string,
  message: string,
): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title} - Agent Runtime</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif;
           display: grid; place-items: center; min-height: 100vh;
           margin: 0; background: #f4f4f5; color: #18181b; }
    .card { max-width: 28rem; padding: 2.5rem; text-align: center;
            background: #fff; border-radius: 0.75rem;
            box-shadow: 0 1px 3px rgba(0,0,0,.1); }
    h1 { font-size: 1.25rem; font-weight: 600; margin: 0 0 1rem; }
    p { color: #52525b; line-height: 1.6; margin: 0.75rem 0; }
    a { color: #2563eb; text-decoration: none; }
    a:hover { text-decoration: underline; }
    code { background: #f4f4f5; padding: 0.125rem 0.375rem;
           border-radius: 0.25rem; font-size: 0.875rem; }
    .actions { margin-top: 1.5rem; }
    .actions a { display: inline-block; padding: 0.5rem 1rem;
                 border: 1px solid #e4e4e7; border-radius: 0.375rem;
                 color: #3f3f46; font-size: 0.875rem; margin: 0 0.25rem; }
    .actions a:hover { background: #f4f4f5; text-decoration: none; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
    ${message}
  </div>
</body>
</html>`
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}

async function apiAuth(c: Context<Env>, next: Next): Promise<Response | void> {
  const path = new URL(c.req.url).pathname
  if (path === '/health') return await next()
  if (path.startsWith('/api/bots/')) return await next()

  const header = c.req.header('Authorization')
  if (header?.startsWith('Bearer ')) {
    const token = header.slice(7)
    try {
      const { email } = await verifyToken(token)
      if (!validateDomain(email)) {
        return c.json({ error: 'Domain not allowed' }, 403)
      }
      c.set('email', email)
      return await next()
    } catch {
      return c.json({ error: 'Invalid token' }, 401)
    }
  }

  const raw = extract(c.req.header('Cookie'))
  if (raw) {
    const payload = await decode(raw)
    if (!payload) return c.json({ error: 'Invalid session' }, 401)
    if (!validateDomain(payload.email)) {
      return c.json({ error: 'Domain not allowed' }, 403)
    }
    c.set('email', payload.email)
    return await next()
  }

  return c.json({ error: 'Missing Authorization header' }, 401)
}

const TELEMETRY_TENANT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/

async function telemetryKeyAuth(
  c: Context<Env>,
  next: Next,
): Promise<Response | void> {
  const header = c.req.header('X-Telemetry-Key') ||
    (c.req.header('Authorization')?.startsWith('Bearer artk.')
      ? c.req.header('Authorization')!.slice(7)
      : '')
  if (!header || !header.startsWith('artk.')) {
    return c.json({ error: 'Telemetry key required' }, 401)
  }

  const segments = header.split('.')
  if (segments.length < 4) {
    return c.json({ error: 'Malformed telemetry key' }, 401)
  }
  const tenantId = segments[2]
  if (!TELEMETRY_TENANT_PATTERN.test(tenantId)) {
    return c.json({ error: 'Malformed telemetry key' }, 401)
  }

  const pathTenant = new URL(c.req.url).pathname
    .match(/^\/telemetry\/t\/([^/]+)/)?.[1]
  if (pathTenant && pathTenant !== tenantId) {
    return c.json({ error: 'Key tenant does not match path tenant' }, 403)
  }

  // DANGER: this endpoint is unauthenticated until the key is verified. Confirm
  // the tenant is a known one BEFORE open(), which would otherwise create,
  // migrate, and seed a fresh DB for any attacker-supplied tenant segment and
  // let invalid-key probes litter the disk with arbitrary tenant databases.
  if (!loadRuntime().tenants.bootstrapped.includes(tenantId)) {
    return c.json({ error: 'Invalid telemetry key' }, 401)
  }

  try {
    await open({ id: tenantId, name: tenantId }, 'server')
  } catch {
    return c.json({ error: 'Invalid telemetry key' }, 401)
  }

  const client = getClientByHash(await hashKey(header))
  if (!client || client.tenantId !== tenantId) {
    return c.json({ error: 'Invalid telemetry key' }, 401)
  }
  if (client.revoked) {
    return c.json({ error: 'Telemetry key revoked' }, 403)
  }

  c.set('tenantId', tenantId)
  c.set('telemetryClient', { id: client.id, name: client.name })
  try {
    touchClient(tenantId, client.id)
  } catch {
    // last_used_at update is best-effort
  }
  return await next()
}

async function webAuth(c: Context<Env>, next: Next): Promise<Response | void> {
  const raw = extract(c.req.header('Cookie'))
  if (!raw) return c.redirect('/web/auth/login')

  const payload = await decode(raw)
  if (!payload) return c.redirect('/web/auth/login')

  const email = payload.email || 'unknown'
  if (!validateDomain(email)) {
    return errorPage(
      403,
      'Domain Not Authorized',
      `<p>Your account <code>${email}</code> belongs to an ` +
        'email domain that is not authorized for this application.</p>' +
        '<p>Please contact an administrator if you believe ' +
        'this is an error.</p>' +
        '<div class="actions">' +
        '<a href="/web/auth/logout">Sign out</a>' +
        '</div>',
    )
  }

  const cookieHeader = c.req.raw.headers.get('cookie') || ''
  const tenantCookie = cookieHeader.match(/ar_tenant=([^;]+)/)?.[1] || ''
  const tenantId = /^[a-z0-9][a-z0-9_-]{0,62}$/.test(tenantCookie)
    ? tenantCookie
    : loadRuntime().tenants.bootstrapped[0]
  if (!tenantId) return c.redirect('/web/auth/login')
  c.set('tenantId', tenantId)

  try {
    await open({ id: tenantId, name: tenantId }, 'server')
  } catch {
    // fall through
  }

  const user = getUser(email)
  if (!user) {
    const tenants = loadRuntime().tenants.bootstrapped
    const otherTenants = tenants
      .filter((t) => t !== tenantId)
      .map((t) =>
        `<a href="/web/switch-tenant?tenant=${t}&redirect=/web/">${t}</a>`
      )
    const switchHint = otherTenants.length > 0
      ? `<p>Try another tenant: ${otherTenants.join(', ')}</p>`
      : ''
    return errorPage(
      403,
      'Not Invited',
      `<p>Although we can authenticate you as ` +
        `<code>${email}</code>, you haven't been added to ` +
        `the tenant <code>${tenantId}</code>.</p>` +
        '<p>Please reach out to an admin to invite you ' +
        'to the tenant.</p>' +
        switchHint +
        '<div class="actions">' +
        '<a href="/web/auth/logout">Sign out</a>' +
        '</div>',
    )
  }

  if (!user.isAdmin && checkAdmin(email)) {
    setAdmin(email, true)
    user.isAdmin = true
  }
  c.set('user', user)
  c.set('email', email)
  return await next()
}

async function slackBotAuth(
  c: Context<Env>,
  next: Next,
): Promise<Response | void> {
  const path = new URL(c.req.url).pathname
  if (path.includes('/oauth/')) return await next()

  const header = c.req.header('Authorization')
  if (!header?.startsWith('Bearer ')) {
    const cookie = extract(c.req.header('Cookie'))
    if (cookie) {
      const payload = await decode(cookie)
      if (payload && validateDomain(payload.email)) {
        c.set('email', payload.email)
        const cookieHeader = c.req.raw.headers.get('cookie') || ''
        const tenantCookie = cookieHeader.match(/ar_tenant=([^;]+)/)?.[1] || ''
        const tenantId = c.req.header('X-Tenant') ||
          (/^[a-z0-9][a-z0-9_-]{0,62}$/.test(tenantCookie)
            ? tenantCookie
            : '') ||
          Deno.env.get('AR_TENANT') ||
          loadRuntime().tenants.bootstrapped[0]
        if (!tenantId) {
          return c.json({ error: 'Tenant identifier required' }, 400)
        }
        c.set('tenantId', tenantId)
        await open({ id: tenantId, name: tenantId }, 'server')
        const user = ensure(payload.email)
        if (!user.isAdmin && checkAdmin(payload.email)) {
          setAdmin(payload.email, true)
          user.isAdmin = true
        }
        c.set('user', user)
        return await next()
      }
    }
    return c.json({ error: 'Missing Authorization header' }, 401)
  }

  const token = header.slice(7)
  let serviceEmail: string
  try {
    const result = await verifyToken(token)
    serviceEmail = result.email
  } catch {
    return c.json({ error: 'Invalid token' }, 401)
  }

  const expectedSa = Deno.env.get('AR_BOT_SLACK_SA')
  if (!expectedSa || serviceEmail !== expectedSa) {
    return c.json({ error: 'Unauthorized service account' }, 403)
  }

  const userEmail = c.req.header('X-Slack-User-Email')
  const slackUserId = c.req.header('X-Slack-User-Id')
  if (!userEmail || !slackUserId) {
    return c.json(
      { error: 'Missing X-Slack-User-Email or X-Slack-User-Id' },
      400,
    )
  }

  const tenantId = c.req.header('X-Tenant') ||
    Deno.env.get('AR_TENANT')
  if (!tenantId) {
    return c.json({ error: 'Tenant identifier required' }, 400)
  }
  c.set('tenantId', tenantId)

  await open({ id: tenantId, name: tenantId }, 'server')

  const identity = getIdentity(tenantId, userEmail)
  if (!identity?.enabled) {
    return c.json(
      { error: 'Slack bot not enabled for this user' },
      403,
    )
  }
  if (identity.slackUserId !== slackUserId) {
    return c.json({ error: 'Slack user ID mismatch' }, 403)
  }

  const user = ensure(userEmail)
  if (!user.isAdmin && checkAdmin(userEmail)) {
    setAdmin(userEmail, true)
    user.isAdmin = true
  }
  c.set('user', user)
  c.set('email', userEmail)
  return await next()
}

export {
  apiAuth,
  errorPage,
  slackBotAuth,
  telemetryKeyAuth,
  validateDomain,
  verifyToken,
  webAuth,
}
