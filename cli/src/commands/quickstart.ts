import type {
  CommandRouteDefinition,
  CommandRouteOptions,
} from '../utils/command-router.ts'
import * as terminal from '../terminal/mod.ts'
import { confirm, text } from '../terminal/mod.ts'
import loadConfig from '@ar/client/config'
import { detect } from '@ar/client/mode'
import { dataDir, load as loadRuntime } from '@ar/client/runtime'
import { load as loadSettings, save } from '../settings.ts'
import { configGet } from '../utils/gcloud.ts'

const config = await loadConfig()

async function quickstart(
  { args }: CommandRouteOptions,
): Promise<void> {
  const registry = (args.registry as string) || config.registry
  const rc = loadRuntime()

  terminal.blank()
  terminal.heading('ar quickstart')
  terminal.blank()

  const hasGcloud = await configGet('account')
  if (!hasGcloud) {
    terminal.error('gcloud CLI not authenticated.')
    terminal.hint('Run: gcloud auth login')
    return
  }
  terminal.success(`Authenticated as ${hasGcloud}`)

  let settings = await loadSettings()

  if (!settings.project) {
    const detected = await configGet('project')
    const project = await text('GCP Project ID', {
      default: detected,
      flag: 'project',
    })
    if (!project) {
      terminal.error('Project ID is required.')
      return
    }

    const defaultRegion = rc.platform.region
    const region = await text('Region', {
      default: defaultRegion,
      flag: 'region',
    })

    const defaultSa = rc.platform.runtimeAccountPattern.replace(
      '${project}',
      project,
    )
    const runtimeAccount = await text('Runtime account', {
      default: defaultSa,
      flag: 'runtime-account',
    })

    await Deno.mkdir(registry, { recursive: true })
    await Deno.mkdir(dataDir(), { recursive: true })
    await save({ project, region, runtimeAccount })
    settings = await loadSettings()
    terminal.success('Settings configured')
  } else {
    terminal.success(`Settings configured (${settings.project})`)
  }

  const modeInfo = await detect(settings.controlPlaneUrl)
  if (modeInfo.mode === 'local') {
    terminal.blank()
    terminal.print(
      '  The control plane provides the API server, web' +
        ' dashboard,',
    )
    terminal.print(
      '  and manages agent deployments on Cloud Run.',
    )
    terminal.blank()
    if (await confirm('Deploy the control plane now?')) {
      const { deploy: cpDeploy } = await import(
        './control-plane.ts'
      )
      await cpDeploy()
      terminal.success('Control plane deployed')
    } else {
      terminal.hint(
        'Skipped. You can deploy later with: ar cp deploy',
      )
    }
  } else {
    terminal.success(
      `Control plane connected (${modeInfo.controlPlaneUrl})`,
    )
  }

  terminal.blank()
  const agentName = await text('Agent name', {
    default: 'hello-world',
    flag: 'agent',
  })

  terminal.blank()
  const spin = terminal.spinner(
    `Creating and deploying '${agentName}'...`,
  )

  const { default: agentMod } = await import('./agent.ts')
  try {
    await agentMod.command({
      args: { _: ['deploy', agentName], registry },
      routes: [],
    })
    spin.succeed(`Agent '${agentName}' deployed`)
  } catch (err) {
    spin.fail(
      `Agent deploy failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    terminal.hint(
      `You can retry with: ar deploy ${agentName}`,
    )
  }

  terminal.blank()
  terminal.rule()
  terminal.print('  Next steps:')
  terminal.print(
    `    ar run ${agentName} --data '{"message":"hello"}'`,
  )
  terminal.print(`    ar logs ${agentName}`)
  terminal.print('    ar status')
  terminal.blank()
}

const commandRouteDefinition: CommandRouteDefinition = {
  name: 'quickstart',
  command: quickstart,
  description: 'Guided setup: init, deploy control plane, create first agent',
  options: {
    string: ['registry'],
    alias: { r: 'registry' },
  },
}

export { commandRouteDefinition, quickstart }
export default commandRouteDefinition
