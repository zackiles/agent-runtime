import { type Args, parseArgs } from '@std/cli'
import type {
  CommandRouteDefinition,
  CommandRouteOptions,
} from '../utils/command-router.ts'
import * as terminal from '../terminal/mod.ts'
import { detect, label } from '@ar/client/mode'
import { load as loadSettings } from '../settings.ts'

const commandRouteDefinition: CommandRouteDefinition = {
  name: 'help',
  command: command,
  description: 'Display help menu',
}

async function command(_opts: CommandRouteOptions): Promise<void> {
  const modeInfo = await detect((await loadSettings()).controlPlaneUrl)
  const modeLabel = label(modeInfo.mode)
  const modeDetail = modeInfo.controlPlaneUrl
    ? ` -> ${modeInfo.controlPlaneUrl}`
    : ''

  terminal.print(`ar - Agent Runtime CLI  ${modeLabel}${modeDetail}

Usage:
  ar <command> [args] [flags]

Commands:
  ${'init'.padEnd(14)} Initialize the agent registry
  ${'deploy'.padEnd(14)} Deploy an agent (creates if needed)
  ${'run'.padEnd(14)} Invoke a deployed agent
  ${'logs'.padEnd(14)} Fetch agent logs
  ${'list'.padEnd(14)} List deployed agents
  ${'destroy'.padEnd(14)} Destroy an agent
  ${'clear-builds'.padEnd(14)} Remove old builds (one agent or all)
  ${'create'.padEnd(14)} Scaffold a new agent
  ${'status'.padEnd(14)} Show status with public/private registry items
  ${'connect'.padEnd(14)} Connect to a control plane
  ${'disconnect'.padEnd(14)} Switch to local mode
  ${'copy'.padEnd(14)} Copy agent and dependencies across tenants

Groups:
  ${
    'agent'.padEnd(14)
  } Manage agents (create, deploy, destroy, run, list, logs, clear-builds, switch)
  ${'secret'.padEnd(14)} Manage secrets (set, remove, list)
  ${'trigger'.padEnd(14)} Manage triggers (create, remove, list)
  ${'runtime'.padEnd(14)} Manage runtime (status, set)
  ${'registry'.padEnd(14)} Manage registry config (init, set, get)
  ${'cp'.padEnd(14)} Control plane (deploy, destroy, sync, reset)
  ${'team'.padEnd(14)} Manage teams (create, list, edit)
  ${'department'.padEnd(14)} Manage departments (create, list, edit)
  ${
    'tool'.padEnd(14)
  } Manage tools (create, update, deploy, destroy, list, show, versions, clone)
  ${
    'skill'.padEnd(14)
  } Manage skills (create, import, update, deploy, destroy, list, show, versions, clone)
  ${
    'rule'.padEnd(14)
  } Manage rules (create, update, deploy, destroy, list, show, versions, clone)

Other:
  ${'quickstart'.padEnd(14)} Guided setup: init → control plane → first agent
  ${'help'.padEnd(14)} Display this help menu
  ${'version'.padEnd(14)} Show version

Global flags:
  --registry <path>    Override registry folder (default: ~/.ar/registry/)
  --tenant <name>      Target a specific tenant (default: development)
  --production         Shortcut for --tenant production
  --public             Target the public registry (default: private)
  --version <ver>      Target a specific agent version
  --force              Skip confirmation prompts
  --no-input           Disable interactive prompts (CI mode)
  --settings <path>    Load settings from a YAML or JSON file
  --json               Output raw JSON`)
}

if (import.meta.main) {
  const args: Args = parseArgs(Deno.args)
  await commandRouteDefinition.command({
    args,
    routes: [commandRouteDefinition],
  })
}

export { command, commandRouteDefinition }
export default commandRouteDefinition
