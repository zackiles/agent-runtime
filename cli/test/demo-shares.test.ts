import { assertEquals } from '@std/assert'
import { join } from '@std/path'
import { closeTenant, open } from '@ar/client/db'
import {
  forDemo,
  forMember,
  remove,
  role,
  upsert,
} from '@ar/client/db/demo-shares'
import { can, isAmbiguous } from '../../control-plane/src/api/demos/access.ts'

const ROOT = join(Deno.cwd(), '..')

Deno.test('demo-shares DB: upsert, lookup by member and demo, role, remove', async () => {
  const dir = await Deno.makeTempDir()
  const prevDbPath = Deno.env.get('AR_DB_PATH')
  Deno.env.set('AR_DB_PATH', dir)
  const tenant = 'sharetenant'

  try {
    await open({ id: tenant, name: tenant }, 'server')

    upsert(tenant, {
      ownerId: 'alice@corp.com',
      slug: 'bean-scene',
      memberId: 'bob@corp.com',
      role: 'viewer',
      grantedBy: 'alice@corp.com',
    })

    assertEquals(
      role(tenant, 'alice@corp.com', 'bean-scene', 'bob@corp.com'),
      'viewer',
      'role reads back the grant',
    )

    upsert(tenant, {
      ownerId: 'alice@corp.com',
      slug: 'bean-scene',
      memberId: 'bob@corp.com',
      role: 'editor',
      grantedBy: 'alice@corp.com',
    })
    assertEquals(
      role(tenant, 'alice@corp.com', 'bean-scene', 'bob@corp.com'),
      'editor',
      'upsert on the same key updates the role in place',
    )
    assertEquals(
      forDemo(tenant, 'alice@corp.com', 'bean-scene').length,
      1,
      'upsert does not duplicate rows for the same member',
    )

    upsert(tenant, {
      ownerId: 'carol@corp.com',
      slug: 'bean-scene',
      memberId: 'bob@corp.com',
      role: 'viewer',
      grantedBy: 'carol@corp.com',
    })

    const forBob = forMember(tenant, 'bob@corp.com')
    assertEquals(forBob.length, 2, 'member index spans multiple owners')
    assertEquals(
      forBob.filter((s) => s.slug === 'bean-scene').length,
      2,
      'same slug from two owners is the ambiguity the resolver disambiguates',
    )

    remove(tenant, 'alice@corp.com', 'bean-scene', 'bob@corp.com')
    assertEquals(
      role(tenant, 'alice@corp.com', 'bean-scene', 'bob@corp.com'),
      null,
      'remove drops a single member grant',
    )
    assertEquals(
      forMember(tenant, 'bob@corp.com').length,
      1,
      "carol's grant survives removing alice's",
    )

    upsert(tenant, {
      ownerId: 'carol@corp.com',
      slug: 'bean-scene',
      memberId: 'dan@corp.com',
      role: 'viewer',
      grantedBy: 'carol@corp.com',
    })
    remove(tenant, 'carol@corp.com', 'bean-scene')
    assertEquals(
      forDemo(tenant, 'carol@corp.com', 'bean-scene').length,
      0,
      'remove without a member wipes every grant for the demo (used on delete)',
    )
  } finally {
    closeTenant(tenant)
    if (prevDbPath === undefined) Deno.env.delete('AR_DB_PATH')
    else Deno.env.set('AR_DB_PATH', prevDbPath)
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('access: viewers may only view; everyone else has the full set', () => {
  const actions = [
    'view',
    'update',
    'deploy',
    'stop',
    'download',
    'manage-shares',
    'delete',
  ] as const

  for (const action of actions) {
    assertEquals(
      can('viewer', action),
      action === 'view',
      `viewer may ${action === 'view' ? '' : 'not '}${action}`,
    )
    for (const r of ['owner', 'editor', 'admin'] as const) {
      assertEquals(can(r, action), true, `${r} may ${action}`)
    }
  }
})

Deno.test('access: isAmbiguous narrows the resolver result', () => {
  assertEquals(isAmbiguous(null), false, 'null is not ambiguous')
  assertEquals(
    isAmbiguous({ ambiguous: true, owners: ['a@x', 'b@x'] }),
    true,
    'the ambiguous marker is detected',
  )
})

Deno.test('schema: demo_share migration at version 10', async () => {
  const src = await Deno.readTextFile(
    join(ROOT, 'sdk-client-deno/src/db/schema.ts'),
  )
  assertEquals(
    src.includes('SCHEMA_VERSION = 10'),
    true,
    'schema version is 10',
  )
  assertEquals(
    src.includes('CREATE TABLE IF NOT EXISTS demo_share'),
    true,
    'migration creates demo_share',
  )
  assertEquals(
    src.includes('demo_share_member') && src.includes('demo_share_demo'),
    true,
    'migration creates the member and demo lookup indexes',
  )
})

Deno.test('resolveAccess resolves owner first, then share, then admin', async () => {
  const access = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/api/demos/access.ts'),
  )
  const ownIdx = access.indexOf("role: 'owner'")
  const shareIdx = access.indexOf('forMember(tenantId, email)')
  const adminIdx = access.indexOf('if (isAdmin) {')
  assertEquals(
    ownIdx > -1 && shareIdx > ownIdx && adminIdx > shareIdx,
    true,
    'ownership wins, then shares, then the admin fallback',
  )
  assertEquals(
    access.includes('ambiguous: true'),
    true,
    'multiple owners for one slug returns the ambiguous marker',
  )
})

Deno.test('routes gate every mutation and expose the share endpoints', async () => {
  const routes = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/api/demos/routes.ts'),
  )
  for (
    const action of [
      "gate(c, 'view')",
      "gate(c, 'deploy')",
      "gate(c, 'stop')",
      "gate(c, 'delete')",
      "gate(c, 'download')",
      "gate(c, 'update')",
      "gate(c, 'manage-shares')",
    ]
  ) {
    assertEquals(routes.includes(action), true, `route uses ${action}`)
  }

  for (
    const route of [
      "app.get('/members'",
      "app.get('/:name/shares'",
      "app.post('/:name/shares'",
      "app.delete('/:name/shares/:member'",
    ]
  ) {
    assertEquals(routes.includes(route), true, `defines ${route}`)
  }

  assertEquals(
    routes.includes('function decorate(') && routes.includes('accessUrl'),
    true,
    'list/get responses are decorated with role and accessUrl',
  )
  assertEquals(
    routes.includes("'demo-share'"),
    true,
    'share mutations write a demo-share audit entry',
  )
  assertEquals(
    routes.includes('validateDomain(member)'),
    true,
    'share targets are validated against the allowed domains',
  )
  assertEquals(
    routes.includes('demoShares.remove(tenantId, ownerId, name)'),
    true,
    'deleting a demo wipes its shares',
  )
})

Deno.test('slack demo command adds share, unshare, and shares subcommands', async () => {
  const demo = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/bots/slack/commands/demo.ts'),
  )
  for (const sub of ['share', 'unshare', 'shares']) {
    assertEquals(
      demo.includes(`sub === '${sub}'`),
      true,
      `demo handler routes '${sub}'`,
    )
  }
  assertEquals(
    demo.includes('function parseEmail('),
    true,
    'share targets accept Slack mailto-wrapped emails',
  )
  assertEquals(
    demo.includes("can(access.role, 'manage-shares')"),
    true,
    'share subcommands enforce the manage-shares capability',
  )
})

Deno.test('shared demos surface in the demos list with a role suffix', async () => {
  const demos = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/bots/slack/commands/demos.ts'),
  )
  assertEquals(
    demos.includes('demoShares.forMember(tenantId, email)'),
    true,
    'demos list folds in demos shared with the caller',
  )
  assertEquals(
    demos.includes('shared:'),
    true,
    'shared demos carry a role suffix',
  )
  assertEquals(
    demos.includes("if (role === 'owner')"),
    true,
    'deploy/stop buttons only render for owned demos',
  )
})

Deno.test('web demos island gates actions and renders a share panel', async () => {
  const island = await Deno.readTextFile(
    join(ROOT, 'web/src/islands/demos.tsx'),
  )
  assertEquals(
    island.includes('function SharePanel('),
    true,
    'the island renders a per-demo share panel',
  )
  assertEquals(
    island.includes('canEdit'),
    true,
    'actions are gated on an edit capability rather than raw ownership',
  )
  assertEquals(
    island.includes('function ownerQuery('),
    true,
    'shared-demo API calls carry the owner hint',
  )
})
