import type { App } from 'npm:@slack/bolt@4'
import { resolveEmail } from '../auth.ts'
import { open } from '@ar/client/db'
import { ensure } from '@ar/client/db/users'
import { switchTenant } from '../commands/settings.ts'
import { getIdentity } from '@ar/client/db/slack'
import { resolveTenant } from '../dispatch.ts'
import { submit as submitCreateAgent } from '../commands/create-agent.ts'
import {
  deleteDemoStorage,
  loadMeta,
  storeMeta,
} from '@ar/client/operations/demos'
import {
  deleteImage,
  deployContainer,
  destroyContainer,
  gcpConfig,
} from '../../../api/demos/deploy.ts'
import { buildResponse } from '../views/component.ts'
import { demoResultCard, statusIcon } from '../commands/demo.ts'

async function resolveTenantAndUser(
  email: string,
): Promise<string | undefined> {
  try {
    return await resolveTenant(email)
  } catch {
    return undefined
  }
}

function parseActionValue(raw: string): { name: string } | null {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

// deno-lint-ignore no-explicit-any
function threadTs(body: any): Record<string, string> {
  const ts = body.message?.thread_ts || body.message?.ts
  return ts ? { thread_ts: ts } : {}
}

function register(app: App): void {
  app.action('edit_settings', async ({ ack }) => {
    await ack()
  })

  app.action(
    /^set_tenant__/,
    // deno-lint-ignore no-explicit-any
    async ({ ack, body, client, action }: any) => {
      await ack()
      const email = await resolveEmail(client, body.user.id)
      if (!email) return
      const newTenant = action.value
      const channel = body.channel?.id || body.container?.channel_id
      const thread = threadTs(body)

      try {
        await switchTenant(email, newTenant)
        await open({ id: newTenant, name: newTenant }, 'server')
        ensure(email)
        const identity = getIdentity(newTenant, email)
        const enabled = !!identity?.enabled
        const messageTs = body.message?.ts
        const cpUrl = Deno.env.get('AR_AUDIENCE') || ''
        const dashLink = cpUrl
          ? `<${cpUrl}/web/switch-tenant?tenant=${newTenant}&redirect=/web/|Open ${newTenant} dashboard>`
          : ''
        const enableLink = cpUrl
          ? `<${cpUrl}/web/switch-tenant?tenant=${newTenant}&redirect=/web/me|enable>`
          : ''
        const statusLine = enabled
          ? ':white_check_mark: *Slack Bot:* Enabled'
          : `:warning: *Slack Bot:* Not enabled for \`${newTenant}\` — ${
            enableLink || 'visit /web/me to enable'
          }`
        const msg = `:house: *Active Tenant:* \`${newTenant}\`\n` +
          `${statusLine}\n\n` +
          '_All commands now run against this tenant._\n' +
          (dashLink ? `${dashLink}\n` : '') +
          'Type `settings` to see full preferences.'
        if (messageTs) {
          await client.chat.update({
            channel,
            ts: messageTs,
            blocks: buildResponse({ title: 'Settings', body: msg }),
            text: `Switched to ${newTenant}`,
          })
        } else {
          await client.chat.postMessage({
            channel,
            ...thread,
            blocks: buildResponse({ title: 'Tenant Switched', body: msg }),
            text: `Switched to ${newTenant}`,
          })
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Switch failed'
        await client.chat.postMessage({
          channel,
          ...thread,
          text: `:exclamation: ${msg}`,
        })
      }
    },
  )

  app.action(
    'create_agent_submit',
    // deno-lint-ignore no-explicit-any
    async ({ ack, body, client, action }: any) => {
      await ack()
      const userId = body.user.id
      const email = await resolveEmail(client, userId)
      if (!email) return

      let parsed: { prompt?: string; name?: string } = {}
      try {
        parsed = JSON.parse(action.value)
      } catch {
        return
      }

      const channel = body.channel?.id || body.container?.channel_id
      const tenantId = await resolveTenantAndUser(email)
      if (!tenantId) return
      await submitCreateAgent(
        client,
        channel,
        email,
        userId,
        tenantId,
        parsed.name || 'unnamed',
        parsed.prompt || '',
        '0.0.1',
      )
    },
  )

  app.action(
    'demo_deploy',
    // deno-lint-ignore no-explicit-any
    async ({ ack, body, client, action }: any) => {
      await ack()
      const email = await resolveEmail(client, body.user.id)
      if (!email) return
      const tenantId = await resolveTenantAndUser(email)
      if (!tenantId) return

      const parsed = parseActionValue(action.value)
      if (!parsed) return
      const channel = body.channel?.id || body.container?.channel_id
      const thread = threadTs(body)

      const cfg = gcpConfig()
      const meta = await loadMeta(
        cfg.project,
        tenantId,
        email,
        parsed.name,
      )
      if (!meta) {
        await client.chat.postMessage({
          channel,
          ...thread,
          text: `:exclamation: Demo \`${parsed.name}\` not found.`,
        })
        return
      }

      const statusMsg = await client.chat.postMessage({
        channel,
        ...thread,
        blocks: buildResponse({
          title: 'Deploying Demo',
          status: `:rocket: Deploying ${parsed.name}...`,
        }),
        text: `Deploying ${parsed.name}...`,
      })

      try {
        const url = await deployContainer(
          cfg,
          tenantId,
          email,
          meta,
          meta.visibility || 'private',
        )
        meta.url = url
        meta.status = 'running'
        meta.updatedAt = new Date().toISOString()
        await storeMeta(cfg.project, tenantId, email, meta)

        await client.chat.update({
          channel,
          ts: statusMsg.ts,
          blocks: demoResultCard('Demo Deployed', meta),
          text: `Deployed: ${url}`,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Deploy failed'
        await client.chat.update({
          channel,
          ts: statusMsg.ts,
          blocks: buildResponse({
            title: 'Deploy Failed',
            body: `:exclamation: ${msg}`,
          }),
          text: msg,
        })
      }
    },
  )

  app.action(
    'demo_stop',
    // deno-lint-ignore no-explicit-any
    async ({ ack, body, client, action }: any) => {
      await ack()
      const email = await resolveEmail(client, body.user.id)
      if (!email) return
      const tenantId = await resolveTenantAndUser(email)
      if (!tenantId) return

      const parsed = parseActionValue(action.value)
      if (!parsed) return
      const channel = body.channel?.id || body.container?.channel_id
      const thread = threadTs(body)

      const cfg = gcpConfig()
      try {
        await destroyContainer(cfg, tenantId, email, parsed.name)
        const meta = await loadMeta(
          cfg.project,
          tenantId,
          email,
          parsed.name,
        )
        if (meta) {
          meta.status = 'stopped'
          meta.updatedAt = new Date().toISOString()
          await storeMeta(cfg.project, tenantId, email, meta)
        }
        const icon = statusIcon('stopped')
        await client.chat.postMessage({
          channel,
          ...thread,
          text: `${icon} \`${parsed.name}\` stopped.`,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Stop failed'
        await client.chat.postMessage({
          channel,
          ...thread,
          text: `:exclamation: Failed to stop \`${parsed.name}\`: ${msg}`,
        })
      }
    },
  )

  app.action(
    'demo_delete',
    // deno-lint-ignore no-explicit-any
    async ({ ack, body, client, action }: any) => {
      await ack()
      const email = await resolveEmail(client, body.user.id)
      if (!email) return
      const tenantId = await resolveTenantAndUser(email)
      if (!tenantId) return

      const parsed = parseActionValue(action.value)
      if (!parsed) return
      const channel = body.channel?.id || body.container?.channel_id
      const thread = threadTs(body)
      const messageTs = body.message?.ts

      const cfg = gcpConfig()
      const meta = await loadMeta(
        cfg.project,
        tenantId,
        email,
        parsed.name,
      )

      try {
        if (meta?.status === 'running') {
          await destroyContainer(cfg, tenantId, email, parsed.name)
        }
        try {
          await deleteImage(cfg, tenantId, email, parsed.name)
        } catch { /* best-effort */ }
        await deleteDemoStorage(
          cfg.project,
          tenantId,
          email,
          parsed.name,
        )

        if (messageTs) {
          await client.chat.update({
            channel,
            ts: messageTs,
            blocks: buildResponse({
              title: 'Demo Deleted',
              body: `:wastebasket: \`${parsed.name}\` has been deleted.`,
            }),
            text: `Deleted: ${parsed.name}`,
          })
        } else {
          await client.chat.postMessage({
            channel,
            ...thread,
            text: `:wastebasket: \`${parsed.name}\` deleted.`,
          })
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Delete failed'
        await client.chat.postMessage({
          channel,
          ...thread,
          text: `:exclamation: Failed to delete \`${parsed.name}\`: ${msg}`,
        })
      }
    },
  )

  app.action(
    'demo_delete_cancel',
    // deno-lint-ignore no-explicit-any
    async ({ ack, body, client }: any) => {
      await ack()
      const channel = body.channel?.id || body.container?.channel_id
      const messageTs = body.message?.ts

      if (messageTs && channel) {
        await client.chat.update({
          channel,
          ts: messageTs,
          blocks: buildResponse({
            title: 'Delete Cancelled',
            body: 'No changes were made.',
          }),
          text: 'Cancelled.',
        })
      } else if (channel) {
        await client.chat.postMessage({
          channel,
          ...threadTs(body),
          text: 'Cancelled.',
        })
      }
    },
  )
}

export { register }
