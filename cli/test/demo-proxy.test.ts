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
