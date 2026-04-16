import { parseArgs } from '@std/cli'
import { join } from '@std/path'
import { parse as parseJsonc } from '@std/jsonc'
import type {
  CommandRouteDefinition,
  CommandRouteOptions,
} from '../utils/command-router.ts'
import * as terminal from '../terminal/mod.ts'
import { confirm, spinner, text } from '../terminal/mod.ts'
import { createSession } from '../auth.ts'
import { loadGcp } from '../settings.ts'
import { configDir, load as loadRuntime } from '@ar/client/runtime'
import { exec, gcloud, gcloudWrite } from '../utils/gcloud.ts'

const rc = loadRuntime()

async function syncSecret(
  project: string,
  name: string,
  value: string,
): Promise<void> {
  const exists = await gcloud([
    'secrets',
    'describe',
    name,
    `--project=${project}`,
  ])
  if (!exists.ok) {
    await exec([
      'secrets',
      'create',
      name,
      `--project=${project}`,
      '--replication-policy=automatic',
    ])
  }
  const result = await gcloudWrite([
    'secrets',
    'versions',
    'add',
    name,
    `--project=${project}`,
    '--data-file=-',
  ], value)
  if (!result.ok) {
    throw new Error(`Failed to sync secret ${name}`)
  }
}

function buildManifest(
  cpUrl: string,
  commandName = 'ar',
  displayName = 'Agent Runtime',
): Record<string, unknown> {
  return {
    _metadata: { major_version: 1, minor_version: 1 },
    display_information: {
      name: displayName,
      description: 'AI agent interface powered by Agent Runtime',
      background_color: '#1a1a2e',
    },
    features: {
      app_home: {
        home_tab_enabled: false,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      bot_user: {
        display_name: displayName,
        always_online: false,
      },
      slash_commands: [
        {
          command: `/${commandName}`,
          url: `${cpUrl}/slack/events`,
          description: 'Interact with Agent Runtime agents',
          usage_hint:
            '[help | list | status | settings | run {agent} {input} | create-agent {prompt}]',
          should_escape: false,
        },
      ],
    },
    oauth_config: {
      redirect_urls: [
        `${cpUrl}/api/bots/slack/oauth/callback`,
      ],
      scopes: {
        user: ['identity.basic', 'identity.email'],
        bot: [
          'app_mentions:read',
          'channels:history',
          'channels:read',
          'chat:write',
          'commands',
          'files:read',
          'groups:history',
          'groups:read',
          'im:history',
          'im:read',
          'im:write',
          'reactions:write',
          'users:read',
          'users:read.email',
        ],
      },
    },
    settings: {
      event_subscriptions: {
        request_url: `${cpUrl}/slack/events`,
        bot_events: [
          'app_mention',
          'message.channels',
          'message.groups',
          'message.im',
        ],
      },
      interactivity: {
        is_enabled: true,
        request_url: `${cpUrl}/slack/events`,
      },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  }
}

async function updateSlackManifest(
  configToken: string,
  appId: string,
  manifest: Record<string, unknown>,
): Promise<boolean> {
  const res = await fetch(
    'https://slack.com/api/apps.manifest.update',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${configToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        app_id: appId,
        manifest: JSON.stringify(manifest),
      }),
    },
  )
  const data = await res.json() as {
    ok: boolean
    errors?: Array<{ message: string }>
  }
  if (!data.ok) {
    const msgs = data.errors?.map((e) => e.message).join(', ') ||
      'unknown'
    terminal.error(`Manifest update failed: ${msgs}`)
    return false
  }
  return true
}

async function promptReinstall(appId: string): Promise<void> {
  const installUrl = `https://api.slack.com/apps/${appId}/install-on-team`
  terminal.blank()
  terminal.heading('Reinstall Required')
  terminal.info(
    'Scope changes require reinstalling the app to your workspace.',
  )
  terminal.info('Open this URL to reinstall:')
  terminal.info(`  ${installUrl}`)
  terminal.blank()
  await confirm(
    'Press Enter after reinstalling the app to continue',
  )
  terminal.step('App reinstalled.')
}

async function enable(): Promise<void> {
  const session = await createSession()
  terminal.info(`Authenticated as ${session.account}`)

  const reg = await loadGcp()
  if (!reg.project || !reg.region) {
    throw new terminal.CliError(
      'GCP settings not configured.',
      { suggestion: 'Run `ar cp deploy` first.' },
    )
  }

  const settings = await import('../settings.ts')
  const cliSettings = await settings.load()
  if (!cliSettings.controlPlaneUrl) {
    throw new terminal.CliError(
      'Control plane not deployed.',
      { suggestion: 'Run `ar cp deploy` first.' },
    )
  }

  const cp = cliSettings.controlPlaneUrl

  const defaultName = rc.bot?.name || 'ar'
  const botName = await text(
    'Bot name (lowercase, alphanumeric, used as the slash command)',
    { default: defaultName, flag: 'bot-name' },
  )
  if (!/^[a-z][a-z0-9-]*$/.test(botName)) {
    throw new terminal.CliError(
      'Bot name must be lowercase alphanumeric (hyphens allowed, must start with a letter).',
    )
  }
  const defaultDisplayName = rc.bot?.displayName || 'Agent Runtime'
  const displayName = await text(
    'Bot display name (shown in Slack)',
    { default: defaultDisplayName, flag: 'bot-display-name' },
  )
  const botToken = await text('Slack Bot Token (xoxb-...)', {
    flag: 'slack-bot-token',
    default: Deno.env.get('SLACK_BOT_TOKEN') || '',
  })
  const signingSecret = await text('Slack Signing Secret', {
    flag: 'slack-signing-secret',
    default: Deno.env.get('SLACK_SIGNING_SECRET') || '',
  })
  const clientId = await text('Slack Client ID', {
    flag: 'slack-client-id',
    default: Deno.env.get('SLACK_CLIENT_ID') || '',
  })
  const clientSecret = await text('Slack Client Secret', {
    flag: 'slack-client-secret',
    default: Deno.env.get('SLACK_CLIENT_SECRET') || '',
  })

  const spin = spinner(
    'Updating control plane with Slack bot configuration...',
  )

  try {
    const secrets: Record<string, string> = {
      'slack-bot-token': botToken,
      'slack-signing-secret': signingSecret,
      'slack-client-id': clientId,
      'slack-client-secret': clientSecret,
    }
    for (const [name, value] of Object.entries(secrets)) {
      await syncSecret(reg.project, name, value)
    }

    const secretRefs = [
      `SLACK_BOT_TOKEN=slack-bot-token:latest`,
      `SLACK_SIGNING_SECRET=slack-signing-secret:latest`,
      `SLACK_CLIENT_ID=slack-client-id:latest`,
      `SLACK_CLIENT_SECRET=slack-client-secret:latest`,
      `AR_BOT_SLACK_CLIENT_ID=slack-client-id:latest`,
      `AR_BOT_SLACK_CLIENT_SECRET=slack-client-secret:latest`,
    ].join(',')

    await exec([
      'run',
      'services',
      'update',
      rc.controlPlane.serviceName,
      `--project=${reg.project}`,
      `--region=${reg.region}`,
      `--set-secrets=${secretRefs}`,
      `--update-env-vars=AR_BOT_NAME=${botName}`,
    ])
    spin.succeed('Control plane updated with Slack bot credentials.')
    await settings.save({ botName, botDisplayName: displayName })
  } catch (err) {
    spin.fail('Failed to update control plane.')
    throw err
  }

  await configureSlackApp(cp, botName, displayName)

  terminal.blank()
  terminal.heading('User Enrollment')
  terminal.info(
    'Users must enroll via the web dashboard to link their ' +
      'Google identity to Slack.',
  )
  terminal.info(`  ${cp}/web/me → Enable Slack Bot`)
  terminal.blank()
  terminal.success('Slack bot enabled.')
}

async function refreshConfigToken(): Promise<string | null> {
  const refreshToken = Deno.env.get('SLACK_CONFIG_REFRESH_TOKEN') || ''
  if (!refreshToken) return null

  const res = await fetch('https://slack.com/api/tooling.tokens.rotate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })
  const data = await res.json() as {
    ok: boolean
    token?: string
    refresh_token?: string
  }
  if (!data.ok || !data.token || !data.refresh_token) return null

  const secretsPath = join(configDir(), 'secrets.jsonc')
  try {
    const raw = await Deno.readTextFile(secretsPath)
    const parsed = parseJsonc(raw) as Record<string, string>
    parsed.SLACK_CONFIG_TOKEN = data.token
    parsed.SLACK_CONFIG_REFRESH_TOKEN = data.refresh_token
    await Deno.writeTextFile(
      secretsPath,
      JSON.stringify(parsed, null, 2) + '\n',
    )
  } catch {
    terminal.warn(
      'Could not persist rotated config tokens to secrets.jsonc. ' +
        'Update SLACK_CONFIG_TOKEN and SLACK_CONFIG_REFRESH_TOKEN manually.',
    )
  }

  Deno.env.set('SLACK_CONFIG_TOKEN', data.token)
  Deno.env.set('SLACK_CONFIG_REFRESH_TOKEN', data.refresh_token)
  return data.token
}

async function resolveConfigToken(): Promise<string> {
  const existing = Deno.env.get('SLACK_CONFIG_TOKEN') || ''
  if (existing) {
    const refreshed = await refreshConfigToken()
    if (refreshed) return refreshed
    return existing
  }

  return await text(
    'Slack App Config Token (from api.slack.com/apps)',
    { flag: 'slack-config-token' },
  )
}

async function configureSlackApp(
  cpUrl: string,
  commandName: string,
  displayName: string,
): Promise<void> {
  terminal.blank()
  terminal.heading('Slack App Configuration')

  const manifest = buildManifest(cpUrl, commandName, displayName)
  const appId = Deno.env.get('SLACK_APP_ID') || await text(
    'Slack App ID (from Basic Information page)',
    { flag: 'slack-app-id' },
  )

  const configToken = await resolveConfigToken()

  if (configToken) {
    const spin = spinner('Updating Slack app manifest...')
    const ok = await updateSlackManifest(configToken, appId, manifest)
    if (ok) {
      spin.succeed('Slack app configured via manifest.')
      await promptReinstall(appId)
    } else {
      spin.fail('Manifest update failed.')
      printManualSteps(cpUrl)
      await promptReinstall(appId)
    }
  } else {
    printManualSteps(cpUrl)
    await promptReinstall(appId)
  }

  const manifestPath = join(configDir(), 'bot-slack', 'manifest.json')
  try {
    await Deno.mkdir(join(configDir(), 'bot-slack'), {
      recursive: true,
    })
    await Deno.writeTextFile(
      manifestPath,
      JSON.stringify(manifest, null, 2) + '\n',
    )
    terminal.step(`Manifest saved to ${manifestPath}`)
  } catch {
    // non-fatal
  }
}

function printManualSteps(cpUrl: string): void {
  terminal.blank()
  terminal.heading('Manual Slack App Setup')
  terminal.info('1. Disable Socket Mode')
  terminal.info(
    `2. Event Subscriptions Request URL:\n` +
      `   ${cpUrl}/slack/events`,
  )
  terminal.info(
    `3. Interactivity Request URL:\n` +
      `   ${cpUrl}/slack/events`,
  )
  terminal.info(
    `4. OAuth Redirect URL:\n` +
      `   ${cpUrl}/api/bots/slack/oauth/callback`,
  )
  terminal.info(
    '5. Bot Token Scopes: chat:write, reactions:write, ' +
      'users:read, users:read.email, im:history, im:read, ' +
      'im:write, channels:history, channels:read, ' +
      'groups:history, groups:read, app_mentions:read, ' +
      'commands, files:read',
  )
  terminal.info(
    '6. Bot Events: app_mention, message.im, ' +
      'message.channels, message.groups',
  )
  terminal.info(
    '7. App Home: Enable Messages Tab + ' +
      'Allow users to send messages',
  )
  terminal.info('8. Reinstall the app to your workspace')
}

async function disable(): Promise<void> {
  const session = await createSession()
  terminal.info(`Authenticated as ${session.account}`)
  const reg = await loadGcp()

  if (!reg.project) {
    throw new terminal.CliError(
      'No project configured.',
      { suggestion: 'Run `ar init` first.' },
    )
  }

  if (
    !await confirm(
      'Remove Slack bot configuration from the control plane?',
    )
  ) {
    terminal.info('Aborted.')
    return
  }

  const spin = spinner('Removing Slack bot configuration...')

  try {
    await exec([
      'run',
      'services',
      'update',
      rc.controlPlane.serviceName,
      `--project=${reg.project}`,
      `--region=${reg.region}`,
      '--remove-env-vars=SLACK_BOT_TOKEN,SLACK_SIGNING_SECRET,' +
      'SLACK_CLIENT_ID,SLACK_CLIENT_SECRET,' +
      'AR_BOT_SLACK_CLIENT_ID,AR_BOT_SLACK_CLIENT_SECRET',
    ])
    spin.succeed('Slack bot disabled.')
  } catch (err) {
    spin.fail('Failed to update control plane.')
    throw err
  }
}

async function showStatus(): Promise<void> {
  const reg = await loadGcp()
  if (!reg.project) {
    throw new terminal.CliError(
      'No project configured.',
      { suggestion: 'Run `ar init` first.' },
    )
  }

  const result = await gcloud([
    'run',
    'services',
    'describe',
    rc.controlPlane.serviceName,
    `--project=${reg.project}`,
    `--region=${reg.region}`,
    '--format=json(spec.template.spec.containers[0].env)',
  ])

  if (!result.ok) {
    terminal.info('Control plane not found.')
    return
  }

  try {
    const data = JSON.parse(result.stdout)
    const envs = data.spec?.template?.spec?.containers?.[0]?.env || []
    // deno-lint-ignore no-explicit-any
    const hasToken = envs.some((e: any) =>
      e.name === 'SLACK_BOT_TOKEN' && e.value
    )
    terminal.keyValue([
      ['Slack Bot', hasToken ? 'Enabled' : 'Not configured'],
      ['Service', rc.controlPlane.serviceName],
    ])
  } catch {
    terminal.info(result.stdout)
  }
}

const commandRouteDefinition: CommandRouteDefinition = {
  name: 'bot',
  command: command,
  description: 'Enable or manage the Slack bot',
  options: {
    boolean: ['force'],
    string: [
      'bot-name',
      'bot-display-name',
      'slack-bot-token',
      'slack-signing-secret',
      'slack-client-id',
      'slack-client-secret',
      'slack-config-token',
      'slack-app-id',
    ],
  },
}

async function command(
  { args }: CommandRouteOptions,
): Promise<void> {
  const subcommand = args._[0] as string | undefined

  switch (subcommand) {
    case 'enable':
    case 'deploy':
      return await enable()
    case 'disable':
    case 'destroy':
      return await disable()
    case 'status':
      return await showStatus()
    default:
      throw new terminal.CliError(
        'Usage: ar bot <enable|disable|status>',
        { suggestion: "Run 'ar help' for details." },
      )
  }
}

if (import.meta.main) {
  const args = parseArgs(
    Deno.args,
    commandRouteDefinition.options,
  )
  await commandRouteDefinition.command({
    args,
    routes: [commandRouteDefinition],
  })
}

export default commandRouteDefinition
