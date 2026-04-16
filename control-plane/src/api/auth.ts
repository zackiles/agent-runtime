import { Hono } from '@hono/hono'
import type { Env } from '../types.ts'
import { clearCookie, decode, encode, setCookie } from '../session.ts'
import { errorPage, validateDomain, verifyToken } from '../middleware/auth.ts'

function origin(
  c: { req: { url: string; header: (name: string) => string | undefined } },
): string {
  const url = new URL(c.req.url)
  const proto = c.req.header('x-forwarded-proto') ||
    url.protocol.replace(':', '')
  return `${proto}://${url.host}`
}

const app = new Hono<Env>()

app.get('/login', async (c) => {
  const clientId = Deno.env.get('GOOGLE_CLIENT_ID')
  if (!clientId) return c.text('GOOGLE_CLIENT_ID not configured', 500)
  const redirect = `${origin(c)}/web/auth/callback`
  const state = await encode({ email: 'oauth-login' })
  const url =
    `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${
      encodeURIComponent(redirect)
    }&response_type=code&scope=openid%20email%20profile&access_type=offline&state=${
      encodeURIComponent(state)
    }`
  return c.redirect(url)
})

app.get('/callback', async (c) => {
  const code = c.req.query('code')
  if (!code) {
    return errorPage(
      400,
      'Authentication Failed',
      '<p>The sign-in request was missing required parameters.</p>' +
        '<div class="actions">' +
        '<a href="/web/auth/login">Try again</a>' +
        '</div>',
    )
  }

  const state = c.req.query('state')
  if (!state) {
    return errorPage(
      400,
      'Authentication Failed',
      '<p>The sign-in request was missing required parameters.</p>' +
        '<div class="actions">' +
        '<a href="/web/auth/login">Try again</a>' +
        '</div>',
    )
  }
  const statePayload = await decode(state)
  if (!statePayload || statePayload.email !== 'oauth-login') {
    return errorPage(
      403,
      'Authentication Failed',
      '<p>The sign-in session has expired or is invalid.</p>' +
        '<div class="actions">' +
        '<a href="/web/auth/login">Try again</a>' +
        '</div>',
    )
  }

  const clientId = Deno.env.get('GOOGLE_CLIENT_ID')
  const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET')
  if (!clientId || !clientSecret) {
    return errorPage(
      500,
      'Configuration Error',
      '<p>OAuth is not configured for this application. ' +
        'Please contact an administrator.</p>',
    )
  }

  const redirect = `${origin(c)}/web/auth/callback`
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirect,
      grant_type: 'authorization_code',
    }),
  })

  if (!tokenRes.ok) {
    return errorPage(
      401,
      'Authentication Failed',
      '<p>We were unable to verify your identity with Google. ' +
        'Please try signing in again.</p>' +
        '<div class="actions">' +
        '<a href="/web/auth/login">Sign in</a>' +
        '</div>',
    )
  }

  const tokens = await tokenRes.json() as { id_token?: string }
  if (!tokens.id_token) {
    return errorPage(
      401,
      'Authentication Failed',
      '<p>We were unable to verify your identity. ' +
        'Please try signing in again.</p>' +
        '<div class="actions">' +
        '<a href="/web/auth/login">Sign in</a>' +
        '</div>',
    )
  }

  let email: string
  try {
    const result = await verifyToken(tokens.id_token)
    email = result.email
  } catch {
    return errorPage(
      401,
      'Authentication Failed',
      '<p>Your identity token could not be verified. ' +
        'Please try signing in again.</p>' +
        '<div class="actions">' +
        '<a href="/web/auth/login">Sign in</a>' +
        '</div>',
    )
  }

  if (!validateDomain(email)) {
    return errorPage(
      403,
      'Domain Not Authorized',
      `<p>Your account <code>${email}</code> belongs to an ` +
        'email domain that is not authorized for this application.</p>' +
        '<p>Please contact an administrator if you believe ' +
        'this is an error.</p>' +
        '<div class="actions">' +
        '<a href="/web/auth/login">Try a different account</a>' +
        '</div>',
    )
  }

  const cookie = await setCookie(email)

  return new Response(null, {
    status: 302,
    headers: {
      'Location': '/web/system',
      'Set-Cookie': cookie,
    },
  })
})

app.post('/logout', (_c) => {
  return new Response(null, {
    status: 302,
    headers: {
      'Location': '/web/auth/login',
      'Set-Cookie': clearCookie(),
    },
  })
})

export default app
