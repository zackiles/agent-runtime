import CommandRouter from './utils/command-router.ts'
import type {
  CommandRouteDefinition,
  CommandRouteOptions,
} from './utils/command-router.ts'
import { detect } from '@ar/client/mode'
import { dim } from '@std/fmt/colors'

import { load as loadRuntime } from '@ar/client/runtime'
import { load as loadSettings } from './settings.ts'
import {
  CliError,
  error as printError,
  print,
  registerCleanup,
  setInteractive,
} from './terminal/mod.ts'

const authIdx = Deno.args.indexOf('--auth.method')
if (authIdx >= 0 && Deno.args[authIdx + 1]) {
  Deno.env.set('AR_AUTH_METHOD', Deno.args[authIdx + 1])
}

const agentMod = await import('./commands/agent.ts')
const registryMod = await import('./commands/registry.ts')
const runtimeMod = await import('./commands/runtime.ts')
const statusMod = await import('./commands/mode.ts')

function alias(
  def: CommandRouteDefinition,
  name: string,
): CommandRouteDefinition {
  return { ...def, name }
}

const cpMod = await import('./commands/control-plane.ts')

const COMMANDS: Record<string, CommandRouteDefinition> = {
  help: (await import('./commands/help.ts')).default,
  version: (await import('./commands/version.ts')).default,
  status: alias(statusMod.default, 'status'),
  mode: statusMod.default,
  init: registryMod.initRouteDefinition,
  connect: (await import('./commands/connect.ts')).connectDefinition,
  disconnect: (await import('./commands/connect.ts')).disconnectDefinition,
  'runtime-status': runtimeMod.statusRouteDefinition,
  deploy: agentMod.deployRouteDefinition,
  create: agentMod.createRouteDefinition,
  run: agentMod.runRouteDefinition,
  logs: agentMod.logsRouteDefinition,
  list: agentMod.listRouteDefinition,
  destroy: agentMod.destroyRouteDefinition,
  'clear-builds': agentMod.clearBuildsRouteDefinition,
  registry: registryMod.default,
  cp: alias(cpMod.default, 'cp'),
  'control-plane': cpMod.default,
  secret: (await import('./commands/secret.ts')).default,
  agent: agentMod.default,
  trigger: (await import('./commands/trigger.ts')).default,
  runtime: runtimeMod.default,
  copy: (await import('./commands/copy.ts')).default,
  team: (await import('./commands/team.ts')).default,
  department: (await import('./commands/department.ts')).default,
  tool: (await import('./commands/tool.ts')).default,
  skill: (await import('./commands/skill.ts')).default,
  rule: (await import('./commands/rule.ts')).default,
  quickstart: (await import('./commands/quickstart.ts')).default,
  bot: (await import('./commands/bot.ts')).default,
}

async function run(): Promise<void> {
  registerCleanup()

  let isTTY = false
  try {
    isTTY = Deno.stdin.isTerminal()
  } catch { /* non-TTY */ }
  const noInput = Deno.args.includes('--no-input') || !isTTY
  setInteractive(!noInput)

  const settingsIdx = Deno.args.indexOf('--settings')
  const settingsFlag = settingsIdx >= 0 ? Deno.args[settingsIdx + 1] : undefined
  await loadSettings(settingsFlag)

  const settings = await loadSettings()
  const modeInfo = await detect(settings.controlPlaneUrl)

  if (modeInfo.mode === 'server') {
    const { start } = await import('@ar/control-plane')
    const rc = loadRuntime()
    start(
      parseInt(
        Deno.env.get('PORT') || String(rc.controlPlane.port),
        10,
      ),
    )
    return
  }

  const router = new CommandRouter(COMMANDS)
  const route = router.getRoute(Deno.args)

  try {
    const routeOptions: CommandRouteOptions = router.getOptions(route)
    await route.command(routeOptions)
  } catch (err) {
    if (err instanceof CliError) {
      printError(err.message)
      if (err.hint) print(dim(`  ${err.hint}`))
      if (err.suggestion) print(dim(`  Try: ${err.suggestion}`))
    } else {
      printError(
        err instanceof Error ? err.message : String(err),
      )
    }
    Deno.exit(1)
  }
}

if (import.meta.main) {
  run()
}

export default run
