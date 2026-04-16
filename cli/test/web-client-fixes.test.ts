import { assertEquals } from '@std/assert'
import { join } from '@std/path'

const ROOT = join(Deno.cwd(), '..')

Deno.test('audit middleware normalizes plural entity types to singular', async () => {
  const src = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/middleware/audit.ts'),
  )

  assertEquals(
    src.includes("tools: 'tool'"),
    true,
    'must map tools → tool',
  )
  assertEquals(
    src.includes("agents: 'agent'"),
    true,
    'must map agents → agent',
  )
  assertEquals(
    src.includes("skills: 'skill'"),
    true,
    'must map skills → skill',
  )
  assertEquals(
    src.includes("rules: 'rule'"),
    true,
    'must map rules → rule',
  )

  assertEquals(
    src.includes('c.res.clone().json()'),
    true,
    'must clone response body to extract entity ID',
  )

  assertEquals(
    src.includes('c.res.status === 201'),
    true,
    'must detect 201 as created action',
  )

  assertEquals(
    src.includes("|| 'development'"),
    false,
    'must not default tenant to development',
  )
})

Deno.test('tenant resolution requires explicit tenant everywhere', async () => {
  const tenantMiddleware = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/middleware/tenant.ts'),
  )
  assertEquals(
    tenantMiddleware.includes("'Tenant identifier required'"),
    true,
    'tenant middleware must require tenant when no fallback',
  )
  assertEquals(
    tenantMiddleware.includes('loadRuntime().tenants.bootstrapped[0]'),
    true,
    'tenant middleware must fall back to first bootstrapped tenant',
  )
  assertEquals(
    tenantMiddleware.includes("c.get('tenantId')"),
    true,
    'tenant middleware must skip if tenantId already set',
  )
  assertEquals(
    tenantMiddleware.includes("|| 'development'"),
    false,
    'tenant middleware must not default to development',
  )

  const types = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/types.ts'),
  )
  assertEquals(
    types.includes("throw new Error('Tenant not resolved')"),
    true,
    'context() must throw when tenant missing',
  )
  assertEquals(
    /\|\| 'development'/.test(types),
    false,
    'context() must not default to development',
  )

  const auth = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/middleware/auth.ts'),
  )
  assertEquals(
    /\|\| 'development'/.test(auth),
    false,
    'auth middleware must not default to development',
  )

  const dispatch = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/bots/slack/dispatch.ts'),
  )
  assertEquals(
    /\|\| 'development'/.test(dispatch),
    false,
    'slack dispatch must not default to development',
  )

  const bootstrap = await Deno.readTextFile(
    join(ROOT, 'sdk-agent-nodejs/src/bootstrap.ts'),
  )
  assertEquals(
    /\|\| "development"/.test(bootstrap),
    false,
    'SDK bootstrap must not default to development',
  )
})

Deno.test('user management has last-admin protection', async () => {
  const users = await Deno.readTextFile(
    join(ROOT, 'sdk-client-deno/src/db/users.ts'),
  )

  assertEquals(
    users.includes('function adminCount()'),
    true,
    'must export adminCount function',
  )
  assertEquals(
    users.includes("id != 'system@ar-cli'"),
    true,
    'adminCount must exclude system user',
  )
  assertEquals(
    users.includes('function remove('),
    true,
    'must export remove function',
  )

  const settings = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/api/settings.ts'),
  )
  assertEquals(
    settings.includes("'Cannot demote the last admin'"),
    true,
    'must prevent demoting last admin',
  )
  assertEquals(
    settings.includes("'Cannot remove the last admin'"),
    true,
    'must prevent removing last admin',
  )
  assertEquals(
    settings.includes("app.put('/users/:email'"),
    true,
    'must have PUT route for role changes',
  )
  assertEquals(
    settings.includes("app.delete('/users/:email'"),
    true,
    'must have DELETE route for user removal',
  )
})

Deno.test('settings tabs renamed from admins/traffic to users/activity', async () => {
  const settingsTsx = await Deno.readTextFile(
    join(ROOT, 'web/src/islands/settings.tsx'),
  )

  assertEquals(
    settingsTsx.includes("id: 'users'"),
    true,
    'must have users tab',
  )
  assertEquals(
    settingsTsx.includes("id: 'activity'"),
    true,
    'must have activity tab',
  )
  assertEquals(
    settingsTsx.includes("id: 'admins'"),
    false,
    'must not have admins tab',
  )
  assertEquals(
    settingsTsx.includes("id: 'traffic'"),
    false,
    'must not have traffic tab',
  )

  assertEquals(
    settingsTsx.includes('/api/settings/users'),
    true,
    'must call users API endpoint',
  )
  assertEquals(
    settingsTsx.includes('/api/settings/activity'),
    true,
    'must call activity API endpoint',
  )
  assertEquals(
    settingsTsx.includes('/api/settings/admins'),
    false,
    'must not call old admins endpoint',
  )
  assertEquals(
    settingsTsx.includes('/api/settings/traffic'),
    false,
    'must not call old traffic endpoint',
  )
})

Deno.test('UTC timestamps have Z suffix in audit and telemetry', async () => {
  const audit = await Deno.readTextFile(
    join(ROOT, 'sdk-client-deno/src/db/audit.ts'),
  )
  assertEquals(
    audit.includes("r.created_at + 'Z'"),
    true,
    'audit must append Z to created_at',
  )

  const telemetry = await Deno.readTextFile(
    join(ROOT, 'sdk-client-deno/src/db/telemetry.ts'),
  )
  assertEquals(
    telemetry.includes("(r.created_at as string) + 'Z'"),
    true,
    'telemetry must append Z to created_at',
  )
})

Deno.test('demo agent does not write redundant demo.json', async () => {
  const demoAgent = await Deno.readTextFile(
    join(ROOT, 'default-registry/agents/demo-agent/0.0.1/index.js'),
  )
  const metaWrites = demoAgent.match(/writeRaw.*demo\.json/g)
  assertEquals(
    metaWrites,
    null,
    'demo-agent must not write demo.json (control plane is source of truth)',
  )
})

Deno.test('demo listing deduplicates by name', async () => {
  const demos = await Deno.readTextFile(
    join(ROOT, 'sdk-client-deno/src/operations/demos.ts'),
  )
  assertEquals(
    demos.includes('seen.set(meta.name'),
    true,
    'listDemos must deduplicate by name',
  )
  assertEquals(
    demos.includes('seen.values()'),
    true,
    'listDemos must return unique values',
  )
})

Deno.test('demo deploy polls for URI instead of fabricating fallback', async () => {
  const deploy = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/api/demos/deploy.ts'),
  )
  assertEquals(
    deploy.includes('for (let attempt'),
    true,
    'must poll for service URI',
  )
  assertEquals(
    /https:\/\/\$\{svc\}-\$\{.*\.region\}\.run\.app/.test(deploy),
    false,
    'must not use fabricated Cloud Run URL fallback',
  )
})

Deno.test('agent/tool files use signed URLs not FUSE', async () => {
  const registry = await Deno.readTextFile(
    join(ROOT, 'sdk-agent-nodejs/src/registry.ts'),
  )
  assertEquals(
    registry.includes('downloadEntityFile'),
    true,
    'must have downloadEntityFile method',
  )
  assertEquals(
    registry.includes('listEntityFiles'),
    true,
    'must have listEntityFiles method',
  )
  assertEquals(
    registry.includes('/storage/sign'),
    true,
    'must use signed URLs for file downloads',
  )
  assertEquals(
    registry.includes('agentFilesDir'),
    false,
    'must not have FUSE-based agentFilesDir',
  )

  const tools = await Deno.readTextFile(
    join(ROOT, 'sdk-agent-nodejs/src/tools.ts'),
  )
  assertEquals(
    tools.includes('TOOL_FILES_DIR'),
    false,
    'must not set FUSE-based TOOL_FILES_DIR env var',
  )
})

Deno.test('source deploy bundles agent and tool files from GCS', async () => {
  const agents = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/api/agents.ts'),
  )
  assertEquals(
    agents.includes('agents/${agent.slug}/${ctx.version}/files/'),
    true,
    'source deploy must download agent files from GCS',
  )
  assertEquals(
    agents.includes('tools/${tool.slug}/${tool.version}/files/'),
    true,
    'source deploy must download tool files from GCS',
  )
})

Deno.test('registry scope counts match selected scope', async () => {
  const registry = await Deno.readTextFile(
    join(ROOT, 'web/src/islands/registry-status.tsx'),
  )
  assertEquals(
    registry.includes("scope: 'public' | 'private'"),
    true,
    'RegistryTabs must accept scope prop',
  )
  assertEquals(
    registry.includes('scope={scope}'),
    true,
    'RegistryTabs must receive scope from parent',
  )
  const combined = /data\.public\.agents\.length\s*\+\s*\(?data\.private/.test(
    registry,
  )
  assertEquals(
    combined,
    false,
    'tab counts must not combine public + private',
  )
})
