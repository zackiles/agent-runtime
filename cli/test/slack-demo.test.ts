import { assertEquals } from '@std/assert'
import { join } from '@std/path'

const ROOT = join(Deno.cwd(), '..')

Deno.test('demo command is registered in dispatch', async () => {
  const dispatch = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/bots/slack/dispatch.ts'),
  )

  assertEquals(
    dispatch.includes("demo: 'demo'"),
    true,
    'COMMANDS map must include demo',
  )
  assertEquals(
    dispatch.includes("demos: 'demos'"),
    true,
    'COMMANDS map must include demos',
  )
  assertEquals(
    dispatch.includes("case 'demo':"),
    true,
    'dispatch switch must handle demo',
  )
  assertEquals(
    dispatch.includes("case 'demos':"),
    true,
    'dispatch switch must handle demos',
  )
  assertEquals(
    dispatch.includes('files?: SlackFile[]'),
    true,
    'dispatch must accept files parameter',
  )
  assertEquals(
    dispatch.includes('export type { SlackFile }'),
    true,
    'dispatch must export SlackFile type',
  )
})

Deno.test('event handlers forward files to routeCommand', async () => {
  const message = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/bots/slack/events/message.ts'),
  )
  assertEquals(
    message.includes('event.files'),
    true,
    'message handler must forward event.files',
  )

  const mention = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/bots/slack/events/mention.ts'),
  )
  assertEquals(
    mention.includes('files'),
    true,
    'mention handler must forward files',
  )
})

Deno.test('demo.ts handles all subcommands', async () => {
  const demo = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/bots/slack/commands/demo.ts'),
  )

  for (
    const sub of ['deploy', 'stop', 'delete', 'visibility', 'download']
  ) {
    assertEquals(
      demo.includes(`sub === '${sub}'`),
      true,
      `demo handler must route '${sub}' subcommand`,
    )
  }

  assertEquals(
    demo.includes('handleCreateOrUpdate'),
    true,
    'demo handler must have create/update disambiguation',
  )
  assertEquals(
    demo.includes('parseVisibilityFlag'),
    true,
    'demo handler must parse --public/--private flags',
  )
  assertEquals(
    demo.includes('loadMeta('),
    true,
    'demo handler must check existing demos for disambiguation',
  )
  assertEquals(
    demo.includes('invokeAgent('),
    true,
    'demo handler must invoke the demo agent',
  )
  assertEquals(
    demo.includes('uploadFiles('),
    true,
    'demo handler must support file uploads',
  )
  assertEquals(
    demo.includes('MAX_UPLOAD_BYTES'),
    true,
    'demo handler must enforce upload size limits',
  )
  const dispatch = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/bots/slack/dispatch.ts'),
  )
  assertEquals(
    dispatch.includes('logMessage('),
    true,
    'dispatch must log all messages centrally',
  )
})

Deno.test('demo.ts exports helpers for reuse by demos.ts and handlers.ts', async () => {
  const demo = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/bots/slack/commands/demo.ts'),
  )
  assertEquals(
    demo.includes('export {') &&
      demo.includes('handle') &&
      demo.includes('parseVisibilityFlag') &&
      demo.includes('statusIcon'),
    true,
    'demo.ts must export handle, parseVisibilityFlag, statusIcon',
  )

  const demosList = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/bots/slack/commands/demos.ts'),
  )
  assertEquals(
    demosList.includes("from './demo.ts'"),
    true,
    'demos.ts must import from demo.ts',
  )

  const handlers = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/bots/slack/actions/handlers.ts'),
  )
  assertEquals(
    handlers.includes("from '../commands/demo.ts'"),
    true,
    'handlers.ts must import from demo.ts',
  )
})

Deno.test('demos.ts lists demos with action buttons', async () => {
  const demos = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/bots/slack/commands/demos.ts'),
  )

  assertEquals(
    demos.includes('listDemos('),
    true,
    'demos handler must call listDemos',
  )
  assertEquals(
    demos.includes('accessory'),
    true,
    'demos listing must include accessory buttons',
  )
  assertEquals(
    demos.includes('demo_deploy'),
    true,
    'demos listing must have deploy action',
  )
  assertEquals(
    demos.includes('demo_stop'),
    true,
    'demos listing must have stop action',
  )
})

Deno.test('action handlers cover all demo actions', async () => {
  const handlers = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/bots/slack/actions/handlers.ts'),
  )

  for (
    const action of [
      'demo_deploy',
      'demo_stop',
      'demo_delete',
      'demo_delete_cancel',
    ]
  ) {
    assertEquals(
      handlers.includes(`'${action}'`),
      true,
      `handlers must register '${action}' action`,
    )
  }

  assertEquals(
    handlers.includes('deployContainer('),
    true,
    'demo_deploy handler must call deployContainer',
  )
  assertEquals(
    handlers.includes('destroyContainer('),
    true,
    'demo_stop/delete handlers must call destroyContainer',
  )
  assertEquals(
    handlers.includes('deleteDemoStorage('),
    true,
    'demo_delete handler must call deleteDemoStorage',
  )
  assertEquals(
    handlers.includes('body.message?.ts'),
    true,
    'delete handler must update original message',
  )
})

Deno.test('help text includes demo commands', async () => {
  const help = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/bots/slack/commands/help.ts'),
  )

  assertEquals(
    help.includes('${s} demo'),
    true,
    'help must list demo command',
  )
  assertEquals(
    help.includes('${s} demos'),
    true,
    'help must list demos command',
  )
  assertEquals(
    help.includes('`demos`'),
    true,
    'help DM shortcuts must include demos',
  )
})

Deno.test('deploy error is surfaced in Slack card', async () => {
  const demo = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/bots/slack/commands/demo.ts'),
  )

  assertEquals(
    demo.includes(':warning: Deploy failed:'),
    true,
    'demo.ts must surface deploy errors in the Slack card',
  )
  assertEquals(
    demo.includes('demo deploy'),
    true,
    'demo.ts must suggest retry command on deploy failure',
  )
})

Deno.test('handlers.ts passes visibility to deployContainer', async () => {
  const handlers = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/bots/slack/actions/handlers.ts'),
  )

  assertEquals(
    handlers.includes("meta.visibility || 'private'"),
    true,
    'handlers.ts must pass meta.visibility to deployContainer',
  )
})

Deno.test('handlers.ts passes userId to destroyContainer', async () => {
  const handlers = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/bots/slack/actions/handlers.ts'),
  )

  assertEquals(
    handlers.includes('destroyContainer(cfg, tenantId, email,'),
    true,
    'handlers.ts must pass email as userId to destroyContainer',
  )
})

Deno.test('handlers.ts deletes images on demo delete', async () => {
  const handlers = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/bots/slack/actions/handlers.ts'),
  )

  assertEquals(
    handlers.includes('deleteImage('),
    true,
    'handlers.ts must delete images when deleting demos',
  )
})

Deno.test('signFiles is exported from deploy.ts not routes.ts', async () => {
  const deploy = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/api/demos/deploy.ts'),
  )
  assertEquals(
    deploy.includes('export function signFiles('),
    true,
    'deploy.ts must export signFiles',
  )

  const routes = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/api/demos/routes.ts'),
  )
  assertEquals(
    routes.includes('function signFiles('),
    false,
    'routes.ts must not define signFiles locally',
  )
  assertEquals(
    routes.includes('signFiles,'),
    true,
    'routes.ts must import signFiles from deploy.ts',
  )
})

Deno.test('demo.ts shows usage when called with no args', async () => {
  const demo = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/bots/slack/commands/demo.ts'),
  )
  assertEquals(
    demo.includes('USAGE'),
    true,
    'demo handler must define USAGE text',
  )
  assertEquals(
    demo.includes('if (!args.trim())'),
    true,
    'demo handler must check for empty args',
  )
})
