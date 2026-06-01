import { assertEquals, assertStringIncludes } from '@std/assert'
import { join } from '@std/path'

const ROOT = join(Deno.cwd(), '..')

Deno.test('proxy routes are mounted under webAuth before the catch-all', async () => {
  const web = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/api/web.ts'),
  )
  assertStringIncludes(web, "app.all('/d/:name', webAuth, proxyDemo)")
  assertStringIncludes(web, "app.all('/d/:name/*', webAuth, proxyDemo)")

  const proxyIdx = web.indexOf("app.all('/d/:name'")
  const catchAll = web.indexOf("app.get('/*'")
  assertEquals(
    proxyIdx > -1 && catchAll > -1 && proxyIdx < catchAll,
    true,
    'proxy routes must be registered before the catch-all /* route',
  )
})

Deno.test('proxy mints an identity token and gates on the session', async () => {
  const proxy = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/api/demos/proxy.ts'),
  )
  assertStringIncludes(proxy, 'getIdentityToken(target.origin)')
  assertStringIncludes(proxy, 'context(c)')
  assertStringIncludes(proxy, 'resolveDemo(')
})

Deno.test('cross-user private demo lookup is restricted to admins', async () => {
  const proxy = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/api/demos/proxy.ts'),
  )
  // A non-admin must only resolve their own demo; the tenant-wide
  // listDemos fallback must be gated behind an admin check.
  assertStringIncludes(proxy, 'if (!isAdmin) return null')
  const guardIdx = proxy.indexOf('if (!isAdmin) return null')
  const listIdx = proxy.indexOf('listDemos(')
  assertEquals(
    guardIdx > -1 && listIdx > -1 && guardIdx < listIdx,
    true,
    'admin guard must precede the tenant-wide listDemos fallback',
  )
})

Deno.test('root-relative redirect Locations stay inside the proxy path', async () => {
  const proxy = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/api/demos/proxy.ts'),
  )
  assertStringIncludes(proxy, 'function rewriteLocation(')
  assertStringIncludes(
    proxy,
    "location.startsWith('/') && !location.startsWith('//')",
  )
})

Deno.test('proxy does not add a trailing slash (global stripper would loop)', async () => {
  const proxy = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/api/demos/proxy.ts'),
  )
  assertEquals(
    /redirect\(`\$\{prefix\}\/\$\{reqUrl\.search\}`/.test(proxy),
    false,
    'proxy must not self-redirect to a trailing-slash root',
  )
  assertStringIncludes(proxy, "reqUrl.pathname.slice(prefix.length) || '/'")
})

Deno.test('proxy never forwards the platform session cookie upstream', async () => {
  const proxy = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/api/demos/proxy.ts'),
  )
  assertStringIncludes(proxy, "lk === 'cookie'")
})

Deno.test('proxy redirects public demos to the direct URL', async () => {
  const proxy = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/api/demos/proxy.ts'),
  )
  assertStringIncludes(proxy, "meta.visibility !== 'private'")
  assertStringIncludes(proxy, 'c.redirect(meta.url')
})

Deno.test('proxy rewrites root-relative asset URLs and injects a base href', async () => {
  const proxy = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/api/demos/proxy.ts'),
  )
  assertStringIncludes(proxy, '<base href=')
  assertStringIncludes(proxy, 'rewriteHtml(')
})

Deno.test('slack and web link private demos through the proxy', async () => {
  const demo = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/bots/slack/commands/demo.ts'),
  )
  assertStringIncludes(demo, 'demoAccessUrl(meta, cpBase())')

  const island = await Deno.readTextFile(
    join(ROOT, 'web/src/islands/demos.tsx'),
  )
  assertStringIncludes(island, '`/web/d/${demo.name}`')
})
