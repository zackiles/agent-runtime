import { assertEquals, assertExists } from '@std/assert'

const AR = Deno.env.get('AR_BIN') || 'deno'
const AR_ARGS = Deno.env.get('AR_BIN') ? [] : ['task', 'ar']
const REGISTRY = Deno.env.get('AR_REGISTRY') || ''
const TENANT = Deno.env.get('AR_TENANT') || 'development'
const CURSOR_API_KEY = Deno.env.get('CURSOR_API_KEY') || ''

function ar(...args: string[]): Deno.Command {
  const flags = []
  if (REGISTRY) flags.push('--registry', REGISTRY)
  flags.push('--tenant', TENANT)
  return new Deno.Command(AR, {
    args: [...AR_ARGS, ...args, ...flags],
    stdout: 'piped',
    stderr: 'piped',
    env: { ...Deno.env.toObject(), AR_AUTH_METHOD: 'adc' },
  })
}

async function run(...args: string[]): Promise<{
  code: number
  stdout: string
  stderr: string
}> {
  const cmd = ar(...args)
  const child = cmd.spawn()
  const { code, stdout, stderr } = await child.output()
  return {
    code,
    stdout: new TextDecoder().decode(stdout).trim(),
    stderr: new TextDecoder().decode(stderr).trim(),
  }
}

Deno.test({
  name: 'smoke: demo-agent deploys and creates a hello-world demo',
  ignore: !CURSOR_API_KEY,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const secret = await run(
      'secret',
      'set',
      'cursor-api-key',
      CURSOR_API_KEY,
    )
    assertEquals(secret.code, 0, `secret set failed: ${secret.stderr}`)

    const deploy = await run('agent', 'deploy', 'demo-agent')
    assertEquals(deploy.code, 0, `deploy failed: ${deploy.stderr}`)

    const invoke = await run(
      'agent',
      'run',
      'demo-agent',
      '--data',
      JSON.stringify({
        prompt: 'Create a minimal hello world web page that shows ' +
          '"Hello from Agent Runtime" in large centered text on a white ' +
          'background. Use a single index.html file with inline CSS. ' +
          'No frameworks, no build step.',
      }),
    )
    assertEquals(invoke.code, 0, `invoke failed: ${invoke.stderr}`)

    let response: Record<string, unknown> = {}
    try {
      response = JSON.parse(invoke.stdout)
    } catch {
      throw new Error(`Failed to parse response: ${invoke.stdout}`)
    }

    const demo = response.demo as Record<string, unknown> | undefined
    assertExists(demo, 'Response missing demo property')
    assertExists(demo.name, 'Demo missing name')
    assertExists(demo.version, 'Demo missing version')
    assertEquals(
      typeof demo.name,
      'string',
      `Demo name should be a string, got ${typeof demo.name}`,
    )

    console.log('Demo created:', JSON.stringify(demo, null, 2))

    if (
      demo.url && typeof demo.url === 'string' && demo.url.startsWith('http')
    ) {
      const health = await fetch(demo.url)
      assertEquals(
        health.ok,
        true,
        `Demo URL ${demo.url} returned ${health.status}`,
      )
      const body = await health.text()
      console.log(`Demo accessible at ${demo.url} (${body.length} bytes)`)
    }

    const demoName = demo.name as string
    const cleanup = await run(
      'agent',
      'run',
      'demo-agent',
      '--data',
      JSON.stringify({ name: demoName }),
    )
    console.log('Cleanup response:', cleanup.stdout.slice(0, 200))
  },
})
