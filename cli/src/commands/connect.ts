import { parseArgs } from '@std/cli'
import type {
  CommandRouteDefinition,
  CommandRouteOptions,
} from '../utils/command-router.ts'
import * as terminal from '../terminal/mod.ts'
import {
  discoverControlPlaneUrl,
  load as loadSettings,
  save,
} from '../settings.ts'

const connectDefinition: CommandRouteDefinition = {
  name: 'connect',
  command: connectCommand,
  description: 'Connect to a control plane',
  options: {},
}

const disconnectDefinition: CommandRouteDefinition = {
  name: 'disconnect',
  command: disconnectCommand,
  description: 'Disconnect and switch to local mode',
  options: {},
}

async function probe(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/health`, {
      signal: AbortSignal.timeout(5000),
    })
    return res.ok
  } catch {
    return false
  }
}

async function connectCommand({ args }: CommandRouteOptions): Promise<void> {
  const explicit = args._[0] as string | undefined

  if (explicit) {
    await finalize(explicit)
    return
  }

  if (!terminal.isInteractive()) {
    const url = await discoverControlPlaneUrl()
    if (!url) {
      throw new terminal.CliError('No control plane URL available.', {
        suggestion: 'ar connect <control-plane-url>',
      })
    }
    await finalize(url)
    return
  }

  const spin = terminal.spinner(
    'Scanning for deployed control plane...',
  )
  const detected = await discoverControlPlaneUrl()

  if (detected) {
    const reachable = await probe(detected)
    if (reachable) {
      spin.succeed(`Found control plane: ${detected}`)
    } else {
      spin.fail(`Found ${detected} but it did not respond`)
    }
  } else {
    spin.fail('No deployed control plane found')
  }

  const url = await terminal.text('Control plane URL', {
    ...(detected ? { default: detected } : {}),
    flag: 'url',
    quiet: true,
    validate: (v) => {
      try {
        new URL(v)
        return true
      } catch {
        return 'Must be a valid URL'
      }
    },
  })

  if (!url) {
    throw new terminal.CliError('No URL provided.', {
      suggestion: 'ar connect <control-plane-url>',
    })
  }

  if (url !== detected) {
    const check = terminal.spinner('Checking control plane...')
    const reachable = await probe(url)
    if (reachable) {
      check.succeed('Control plane is reachable')
    } else {
      check.fail('Control plane did not respond')
      const proceed = await terminal.confirm(
        'Connect anyway?',
        { default: false },
      )
      if (!proceed) return
    }
  }

  await finalize(url)
}

async function finalize(url: string): Promise<void> {
  await save({ controlPlaneUrl: url })
  terminal.success(`Connected to ${url}`)
  terminal.info('All commands will now route through the control plane.')
}

async function disconnectCommand(
  { args: _args }: CommandRouteOptions,
): Promise<void> {
  const settings = await loadSettings()

  if (!settings.controlPlaneUrl) {
    terminal.info('Already in local mode.')
    return
  }

  await save({ controlPlaneUrl: null })
  terminal.success('Disconnected. Switched to local mode.')
}

if (import.meta.main) {
  const args = parseArgs(Deno.args, connectDefinition.options)
  await connectDefinition.command({
    args,
    routes: [connectDefinition],
  })
}

export {
  connectCommand,
  connectDefinition,
  disconnectCommand,
  disconnectDefinition,
}
