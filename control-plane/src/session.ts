const COOKIE_NAME = 'ar_session'
const COOKIE_FLAGS = 'Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=86400'
const CLEAR_FLAGS = 'Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0'

let signingKey: CryptoKey | null = null

async function getKey(): Promise<CryptoKey> {
  if (signingKey) return signingKey
  const secret = Deno.env.get('AR_SESSION_SECRET')
  if (!secret && Deno.env.get('K_SERVICE')) {
    throw new Error(
      'AR_SESSION_SECRET is required on Cloud Run. ' +
        'Set it via Secret Manager or env vars.',
    )
  }
  const raw = new TextEncoder().encode(secret || 'ar-default-session-key')
  signingKey = await crypto.subtle.importKey(
    'raw',
    raw,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
  return signingKey
}

function toBase64Url(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function fromBase64Url(str: string): Uint8Array {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') +
    '='.repeat((4 - (str.length % 4)) % 4)
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))
}

async function encode(payload: { email: string }): Promise<string> {
  const key = await getKey()
  const data = btoa(JSON.stringify(payload))
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(data),
  )
  return `${data}.${toBase64Url(sig)}`
}

async function decode(
  cookie: string,
): Promise<{ email: string } | null> {
  const dot = cookie.indexOf('.')
  if (dot < 0) {
    return decodeLegacy(cookie)
  }

  const data = cookie.slice(0, dot)
  const sig = cookie.slice(dot + 1)

  const key = await getKey()
  const sigBuf = new ArrayBuffer(fromBase64Url(sig).length)
  new Uint8Array(sigBuf).set(fromBase64Url(sig))
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    sigBuf,
    new TextEncoder().encode(data),
  )
  if (!valid) return null

  try {
    return JSON.parse(atob(data)) as { email: string }
  } catch {
    return null
  }
}

function decodeLegacy(cookie: string): null {
  try {
    JSON.parse(atob(cookie))
  } catch {
    // ignore
  }
  return null
}

async function setCookie(email: string): Promise<string> {
  const value = await encode({ email })
  return `${COOKIE_NAME}=${value}; ${COOKIE_FLAGS}`
}

function clearCookie(): string {
  return `${COOKIE_NAME}=; ${CLEAR_FLAGS}`
}

function extract(cookieHeader: string | undefined): string | null {
  return cookieHeader?.match(/ar_session=([^;]+)/)?.[1] ?? null
}

export { clearCookie, decode, encode, extract, setCookie }
