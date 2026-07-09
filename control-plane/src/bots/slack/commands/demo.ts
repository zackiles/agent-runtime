import type { WebClient } from 'npm:@slack/web-api@7'
import type { Action } from 'npm:@slack/types@2'
import { loadMeta, slugify, storeMeta } from '@ar/client/operations/demos'
import type { DemoMeta } from '@ar/client/operations/demos'
import {
  demoAccessUrl,
  deployContainer,
  destroyContainer,
  findDemoAgent,
  gcpConfig,
  invokeAgent,
  signFiles,
} from '../../../api/demos/deploy.ts'
import type { Visibility } from '../../../api/demos/deploy.ts'
import { can, isAmbiguous, resolveAccess } from '../../../api/demos/access.ts'
import { notifyShare } from '../../../api/demos/notify.ts'
import * as demoShares from '@ar/client/db/demo-shares'
import { ensure, isAdmin } from '@ar/client/db/users'
import { log as auditLog } from '@ar/client/db/audit'
import { validateDomain } from '../../../middleware/auth.ts'
import platform from '@ar/client/platform'
import { DEFAULT_SUBSYSTEM } from '@ar/client/subsystems'
import { slash, threadOpts } from '../utils.ts'
import { buildResponse } from '../views/component.ts'
import type { SlackFile } from '../dispatch.ts'

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024

const STATUS_ICONS: Record<string, string> = {
  running: ':large_green_circle:',
  created: ':white_circle:',
  stopped: ':octagonal_sign:',
  expired: ':hourglass:',
}

async function uploadFiles(
  files: SlackFile[],
  tenantId: string,
): Promise<{ name: string; path: string }[]> {
  const total = files.reduce((s, f) => s + f.size, 0)
  if (total > MAX_UPLOAD_BYTES) {
    throw new Error('Attachments exceed 50 MB limit')
  }

  const token = Deno.env.get('SLACK_BOT_TOKEN') || ''
  const ts = Date.now()
  const cfg = gcpConfig()
  const bucket = `${cfg.project}-ar-registry`
  const refs: { name: string; path: string }[] = []

  for (const file of files) {
    const url = file.url_private_download || file.url_private
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) {
      throw new Error(
        `Failed to download ${file.name} from Slack (${res.status})`,
      )
    }

    const ct = res.headers.get('content-type') || ''
    if (ct.includes('text/html')) {
      throw new Error(
        `Slack returned HTML instead of file data for ${file.name}. ` +
          'The bot token likely lacks the `files:read` scope — ' +
          'add it at https://api.slack.com/apps and reinstall.',
      )
    }
    const bytes = new Uint8Array(await res.arrayBuffer())

    const ext = file.name.includes('.')
      ? '.' + file.name.split('.').pop()!.toLowerCase()
      : ''
    const stem = file.name.replace(/\.[^.]+$/, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    const safeName = (stem || 'file') + ext

    const gcsPath = `${tenantId}/demos/attachments/${ts}/${safeName}`
    const signedUrl = await platform.storageSign(
      bucket,
      gcsPath,
      'PUT',
      600,
      file.mimetype,
    )
    await fetch(signedUrl, {
      method: 'PUT',
      headers: { 'Content-Type': file.mimetype },
      body: bytes,
    })
    refs.push({ name: safeName, path: gcsPath })
  }

  return refs
}

function statusIcon(status?: string): string {
  return STATUS_ICONS[status || 'created'] || ':white_circle:'
}

function cpBase(): string {
  return Deno.env.get('AR_AUDIENCE') ||
    Deno.env.get('AR_CONTROL_PLANE_URL') || ''
}

function webDemosUrl(): string {
  const base = cpBase()
  return base ? `${base}/web/demos` : ''
}

function archiveUrl(name: string): string {
  const base = cpBase()
  return base ? `${base}/api/demos/${name}/archive` : ''
}

function resultButtons(meta: DemoMeta): Action[] {
  const buttons: Action[] = []
  if (meta.url && meta.status === 'running') {
    buttons.push({
      type: 'button',
      text: { type: 'plain_text', text: 'View' },
      url: demoAccessUrl(meta, cpBase()),
      style: 'primary',
    } as unknown as Action)
  }
  const dl = archiveUrl(meta.name)
  if (dl) {
    buttons.push({
      type: 'button',
      text: { type: 'plain_text', text: 'Download Source' },
      url: dl,
    } as unknown as Action)
  }
  const val = JSON.stringify({ name: meta.name })
  buttons.push({
    type: 'button',
    text: { type: 'plain_text', text: 'Stop' },
    action_id: 'demo_stop',
    value: val,
  } as unknown as Action)
  return buttons
}

function managementButtons(name: string, status?: string): Action[] {
  const val = JSON.stringify({ name })
  const buttons: Action[] = []
  if (status === 'running') {
    buttons.push({
      type: 'button',
      text: { type: 'plain_text', text: 'Stop' },
      action_id: 'demo_stop',
      value: val,
    } as unknown as Action)
  } else {
    buttons.push({
      type: 'button',
      text: { type: 'plain_text', text: 'Deploy' },
      action_id: 'demo_deploy',
      style: 'primary',
      value: val,
    } as unknown as Action)
  }
  buttons.push({
    type: 'button',
    text: { type: 'plain_text', text: 'Delete' },
    action_id: 'demo_delete',
    style: 'danger',
    value: val,
  } as unknown as Action)
  return buttons
}

function demoResultCard(title: string, meta: DemoMeta) {
  const icon = statusIcon(meta.status)
  const vis = meta.visibility || 'private'
  const lines = [
    `*Name:* \`${meta.name}\``,
    `*Status:* ${icon} ${meta.status || 'created'}`,
    `*Visibility:* ${vis}`,
  ]
  if (meta.url && meta.status === 'running') {
    lines.push(`*URL:* <${demoAccessUrl(meta, cpBase())}>`)
  }
  if (meta.summary) lines.push(`*Summary:* ${meta.summary}`)
  const web = webDemosUrl()
  if (web) lines.push(`<${web}|View more details on web>`)
  return buildResponse({
    title,
    body: lines.join('\n'),
    actions: resultButtons(meta),
  })
}

function demoCard(title: string, meta: DemoMeta) {
  const icon = statusIcon(meta.status)
  const vis = meta.visibility || 'private'
  const lines = [
    `*Name:* \`${meta.name}\``,
    `*Status:* ${icon} ${meta.status || 'created'}`,
    `*Visibility:* ${vis}`,
  ]
  if (meta.url && meta.status === 'running') {
    lines.push(`*URL:* <${demoAccessUrl(meta, cpBase())}>`)
  }
  if (meta.summary) lines.push(`*Summary:* ${meta.summary}`)
  const web = webDemosUrl()
  if (web) lines.push(`<${web}|View on web>`)
  return buildResponse({
    title,
    body: lines.join('\n'),
    actions: managementButtons(meta.name, meta.status),
  })
}

async function updateStatus(
  client: WebClient,
  channel: string,
  ts: string,
  title: string,
  status: string,
) {
  await client.chat.update({
    channel,
    ts,
    blocks: buildResponse({ title, status }),
    text: status,
  })
}

function parseVisibilityFlag(
  text: string,
): { visibility: Visibility; prompt: string } {
  const match = text.match(/^--?(public|private)\s+/)
  if (match) {
    return {
      visibility: match[1] as Visibility,
      prompt: text.slice(match[0].length),
    }
  }
  return { visibility: 'private', prompt: text }
}

async function handleCreateOrUpdate(
  client: WebClient,
  channel: string,
  email: string,
  tenantId: string,
  args: string,
  threadTs?: string,
  files?: SlackFile[],
): Promise<void> {
  const { visibility, prompt } = parseVisibilityFlag(args)
  if (!prompt.trim()) {
    throw new Error(
      `A prompt is required. Usage: \`${slash('demo {prompt}')}\``,
    )
  }

  const cfg = gcpConfig()
  const bucket = `${cfg.project}-ar-registry`
  const tokens = prompt.split(/\s+/)
  const candidateSlug = slugify(tokens[0])
  const existing = tokens.length > 1
    ? await loadMeta(cfg.project, tenantId, email, candidateSlug)
    : null

  const isUpdate = !!existing
  const slug = isUpdate ? candidateSlug : slugify(prompt.slice(0, 24))
  const actualPrompt = isUpdate ? tokens.slice(1).join(' ') : prompt
  const title = isUpdate ? 'Updating Demo' : 'Creating Demo'

  const statusMsg = await client.chat.postMessage({
    channel,
    ...threadOpts(threadTs),
    blocks: buildResponse({
      title,
      status: ':hourglass_flowing_sand: Validating...',
    }),
    text: `${title}...`,
  })
  const msgTs = statusMsg.ts!

  await updateStatus(
    client,
    channel,
    msgTs,
    title,
    ':mag: Looking for demo-agent...',
  )
  const found = await findDemoAgent(bucket, tenantId)
  if (!found) throw new Error('demo-agent not deployed. Deploy it first.')

  let fileRefs: { name: string; path: string }[] = []
  if (files?.length) {
    await updateStatus(
      client,
      channel,
      msgTs,
      title,
      ':arrow_up: Uploading attachments...',
    )
    fileRefs = await uploadFiles(files, tenantId)
  }

  const signedFiles = fileRefs.length ? await signFiles(bucket, fileRefs) : []

  await updateStatus(
    client,
    channel,
    msgTs,
    title,
    isUpdate
      ? ':hammer: Agent is applying your feedback...'
      : ':hammer: Agent is generating the demo...',
  )

  const result = await invokeAgent(found, {
    prompt: actualPrompt,
    name: slug,
    subsystem: DEFAULT_SUBSYSTEM,
    createdBy: email,
    storagePrefix: `${tenantId}/demos/${email}`,
    files: signedFiles,
    existingDemo: existing || undefined,
  })

  if (!result.demo) {
    throw new Error('Agent did not return a demo result')
  }

  await updateStatus(
    client,
    channel,
    msgTs,
    title,
    ':floppy_disk: Storing metadata...',
  )
  result.demo.name = slugify(result.demo.name || slug)
  result.demo.createdBy = email
  result.demo.visibility = visibility
  if (isUpdate && existing) {
    result.demo.createdAt = existing.createdAt
    result.demo.updatedAt = new Date().toISOString()
  }
  result.demo.status = 'created'
  await storeMeta(cfg.project, tenantId, email, result.demo)

  await updateStatus(
    client,
    channel,
    msgTs,
    title,
    ':rocket: Deploying...',
  )
  try {
    const url = await deployContainer(
      cfg,
      tenantId,
      email,
      result.demo,
      visibility,
    )
    result.demo.url = url
    result.demo.status = 'running'
    await storeMeta(cfg.project, tenantId, email, result.demo)
  } catch (err) {
    result.demo.status = 'created'
    const msg = err instanceof Error ? err.message : 'Deploy failed'
    result.demo.summary = (result.demo.summary || '') +
      `\n:warning: Deploy failed: ${msg}. Use \`demo deploy ${result.demo.name}\` to retry.`
  }

  const doneTitle = isUpdate ? 'Demo Updated' : 'Demo Ready'
  await client.chat.update({
    channel,
    ts: msgTs,
    blocks: demoResultCard(doneTitle, result.demo),
    text: `${doneTitle}: ${result.demo.name}`,
  })
}

async function handleDeploy(
  client: WebClient,
  channel: string,
  email: string,
  tenantId: string,
  name: string,
  visibility: Visibility,
  threadTs?: string,
): Promise<void> {
  const cfg = gcpConfig()
  const slug = slugify(name)
  const meta = await loadMeta(cfg.project, tenantId, email, slug)
  if (!meta) throw new Error(`Demo \`${slug}\` not found.`)

  const statusMsg = await client.chat.postMessage({
    channel,
    ...threadOpts(threadTs),
    blocks: buildResponse({
      title: 'Deploying Demo',
      status: `:rocket: Deploying ${slug}...`,
    }),
    text: `Deploying ${slug}...`,
  })

  const url = await deployContainer(cfg, tenantId, email, meta, visibility)
  meta.url = url
  meta.status = 'running'
  meta.visibility = visibility
  meta.updatedAt = new Date().toISOString()
  await storeMeta(cfg.project, tenantId, email, meta)

  await client.chat.update({
    channel,
    ts: statusMsg.ts!,
    blocks: demoResultCard('Demo Deployed', meta),
    text: `Deployed: ${url}`,
  })
}

async function handleStop(
  client: WebClient,
  channel: string,
  email: string,
  tenantId: string,
  name: string,
  threadTs?: string,
): Promise<void> {
  const cfg = gcpConfig()
  const slug = slugify(name)
  const meta = await loadMeta(cfg.project, tenantId, email, slug)
  if (!meta) throw new Error(`Demo \`${slug}\` not found.`)

  await destroyContainer(cfg, tenantId, email, slug)
  meta.status = 'stopped'
  meta.updatedAt = new Date().toISOString()
  await storeMeta(cfg.project, tenantId, email, meta)

  await client.chat.postMessage({
    channel,
    ...threadOpts(threadTs),
    blocks: demoCard('Demo Stopped', meta),
    text: `Stopped: ${slug}`,
  })
}

async function handleDelete(
  client: WebClient,
  channel: string,
  email: string,
  tenantId: string,
  name: string,
  threadTs?: string,
): Promise<void> {
  const cfg = gcpConfig()
  const slug = slugify(name)
  const meta = await loadMeta(cfg.project, tenantId, email, slug)
  if (!meta) throw new Error(`Demo \`${slug}\` not found.`)

  const val = JSON.stringify({ name: slug })
  await client.chat.postMessage({
    channel,
    ...threadOpts(threadTs),
    blocks: buildResponse({
      title: 'Confirm Delete',
      body: `Are you sure you want to delete *${slug}*? This cannot be undone.`,
      actions: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Delete' },
          action_id: 'demo_delete',
          style: 'danger',
          value: val,
        } as unknown as Action,
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Cancel' },
          action_id: 'demo_delete_cancel',
          value: val,
        } as unknown as Action,
      ],
    }),
    text: `Delete ${slug}?`,
  })
}

async function handleVisibility(
  client: WebClient,
  channel: string,
  email: string,
  tenantId: string,
  name: string,
  value: string,
  threadTs?: string,
): Promise<void> {
  if (value !== 'public' && value !== 'private') {
    throw new Error('Visibility must be `public` or `private`.')
  }
  const cfg = gcpConfig()
  const slug = slugify(name)
  const meta = await loadMeta(cfg.project, tenantId, email, slug)
  if (!meta) throw new Error(`Demo \`${slug}\` not found.`)

  if (meta.visibility === value && meta.status === 'running') {
    await client.chat.postMessage({
      channel,
      ...threadOpts(threadTs),
      text: `\`${slug}\` is already ${value}.`,
    })
    return
  }

  await handleDeploy(client, channel, email, tenantId, name, value, threadTs)
}

async function handleDownload(
  client: WebClient,
  channel: string,
  name: string,
  threadTs?: string,
): Promise<void> {
  const slug = slugify(name)
  const url = webDemosUrl() || '/web/demos'
  await client.chat.postMessage({
    channel,
    ...threadOpts(threadTs),
    text: `To download the source for \`${slug}\`, visit:\n${url}`,
  })
}

// Slack auto-links emails as `<mailto:bob@corp.com|bob@corp.com>`; recover the
// bare address so share targets can be typed naturally.
function parseEmail(token: string): string {
  const mailto = token.match(/^<mailto:([^|>]+)/)
  return (mailto ? mailto[1] : token).trim().toLowerCase()
}

async function resolveForShare(
  email: string,
  tenantId: string,
  name: string,
) {
  const { project } = gcpConfig()
  const slug = slugify(name)
  const access = await resolveAccess(
    project,
    tenantId,
    email,
    isAdmin(email),
    slug,
  )
  if (isAmbiguous(access)) {
    throw new Error(
      `Multiple demos named \`${slug}\` are shared with you (owners: ` +
        `${access.owners.join(', ')}). Manage them from the web UI.`,
    )
  }
  if (!access) throw new Error(`Demo \`${slug}\` not found.`)
  return access
}

async function handleShare(
  client: WebClient,
  channel: string,
  email: string,
  tenantId: string,
  name: string,
  memberToken: string,
  roleToken: string | undefined,
  threadTs?: string,
): Promise<void> {
  const access = await resolveForShare(email, tenantId, name)
  if (!can(access.role, 'manage-shares')) {
    throw new Error(
      `You do not have permission to share \`${access.meta.name}\`.`,
    )
  }

  const member = parseEmail(memberToken)
  if (!member.includes('@')) {
    throw new Error('Provide a valid email to share with.')
  }
  const role = roleToken === 'editor' ? 'editor' : 'viewer'

  if (!validateDomain(member)) {
    throw new Error(`\`${member}\` is not in an allowed domain.`)
  }
  if (member === access.ownerId.toLowerCase()) {
    throw new Error('The owner already has full access.')
  }
  if (member === email.toLowerCase()) {
    throw new Error('You cannot change your own access.')
  }

  ensure(member)
  demoShares.upsert(tenantId, {
    ownerId: access.ownerId,
    slug: access.meta.name,
    memberId: member,
    role,
    grantedBy: email,
  })
  auditLog(
    tenantId,
    'demo-share',
    `${access.ownerId}/${access.meta.name}`,
    'created',
    email,
    { member, role },
  )
  await notifyShare({
    tenantId,
    member,
    grantedBy: email,
    ownerId: access.ownerId,
    slug: access.meta.name,
    role,
  })

  await client.chat.postMessage({
    channel,
    ...threadOpts(threadTs),
    text:
      `:white_check_mark: Shared \`${access.meta.name}\` with *${member}* as *${role}*.`,
  })
}

async function handleUnshare(
  client: WebClient,
  channel: string,
  email: string,
  tenantId: string,
  name: string,
  memberToken: string,
  threadTs?: string,
): Promise<void> {
  const access = await resolveForShare(email, tenantId, name)
  if (!can(access.role, 'manage-shares')) {
    throw new Error(
      `You do not have permission to manage \`${access.meta.name}\`.`,
    )
  }

  const member = parseEmail(memberToken)
  if (member === access.ownerId.toLowerCase()) {
    throw new Error('Cannot remove the owner.')
  }

  demoShares.remove(tenantId, access.ownerId, access.meta.name, member)
  auditLog(
    tenantId,
    'demo-share',
    `${access.ownerId}/${access.meta.name}`,
    'deleted',
    email,
    { member },
  )

  await client.chat.postMessage({
    channel,
    ...threadOpts(threadTs),
    text: `:wastebasket: Removed *${member}* from \`${access.meta.name}\`.`,
  })
}

async function handleShares(
  client: WebClient,
  channel: string,
  email: string,
  tenantId: string,
  name: string,
  threadTs?: string,
): Promise<void> {
  const access = await resolveForShare(email, tenantId, name)
  if (!can(access.role, 'manage-shares')) {
    throw new Error(
      `You do not have permission to view shares for \`${access.meta.name}\`.`,
    )
  }

  const shares = demoShares.forDemo(tenantId, access.ownerId, access.meta.name)
  const lines = [
    `*Shares for* \`${access.meta.name}\` *(owner: ${access.ownerId})*`,
  ]
  if (shares.length === 0) {
    lines.push('_Not shared with anyone yet._')
  } else {
    for (const s of shares) {
      lines.push(`• ${s.memberId} — *${s.role}*`)
    }
  }

  await client.chat.postMessage({
    channel,
    ...threadOpts(threadTs),
    blocks: buildResponse({ title: 'Demo Shares', body: lines.join('\n') }),
    text: `${shares.length} share(s)`,
  })
}

const USAGE = [
  '*Demo Commands:*',
  '`demo {prompt}` — Create and deploy a new demo',
  '`demo {name} {feedback}` — Update an existing demo',
  '`demo stop {name}` — Stop a running demo',
  '`demo delete {name}` — Delete a demo',
  '`demo visibility {name} public|private` — Change visibility',
  '`demo download {name}` — Get source download link',
  '`demo share {name} {email} [viewer|editor]` — Share a demo',
  '`demo unshare {name} {email}` — Revoke access',
  '`demo shares {name}` — List who a demo is shared with',
  '`demos` — List your demos',
].join('\n')

async function handle(
  client: WebClient,
  channel: string,
  email: string,
  _slackUserId: string,
  tenantId: string,
  args: string,
  threadTs?: string,
  files?: SlackFile[],
): Promise<void> {
  if (!args.trim()) {
    await client.chat.postMessage({
      channel,
      ...threadOpts(threadTs),
      blocks: buildResponse({ title: 'Demo', body: USAGE }),
      text: 'Demo commands',
    })
    return
  }

  const tokens = args.trim().split(/\s+/)
  const sub = tokens[0].toLowerCase()

  if (sub === 'deploy' && tokens[1]) {
    return handleDeploy(
      client,
      channel,
      email,
      tenantId,
      tokens[1],
      'private',
      threadTs,
    )
  }
  if (sub === 'stop' && tokens[1]) {
    return handleStop(
      client,
      channel,
      email,
      tenantId,
      tokens[1],
      threadTs,
    )
  }
  if (sub === 'delete' && tokens[1]) {
    return handleDelete(
      client,
      channel,
      email,
      tenantId,
      tokens[1],
      threadTs,
    )
  }
  if (sub === 'visibility' && tokens[1] && tokens[2]) {
    return handleVisibility(
      client,
      channel,
      email,
      tenantId,
      tokens[1],
      tokens[2],
      threadTs,
    )
  }
  if (sub === 'download' && tokens[1]) {
    return handleDownload(client, channel, tokens[1], threadTs)
  }
  if (sub === 'share' && tokens[1] && tokens[2]) {
    return handleShare(
      client,
      channel,
      email,
      tenantId,
      tokens[1],
      tokens[2],
      tokens[3]?.toLowerCase(),
      threadTs,
    )
  }
  if (sub === 'unshare' && tokens[1] && tokens[2]) {
    return handleUnshare(
      client,
      channel,
      email,
      tenantId,
      tokens[1],
      tokens[2],
      threadTs,
    )
  }
  if (sub === 'shares' && tokens[1]) {
    return handleShares(client, channel, email, tenantId, tokens[1], threadTs)
  }

  if (
    ['deploy', 'stop', 'delete', 'visibility', 'download'].includes(sub) &&
    !tokens[1]
  ) {
    throw new Error(`Missing demo name. Usage: \`demo ${sub} {name}\``)
  }
  if (sub === 'shares' && !tokens[1]) {
    throw new Error('Missing demo name. Usage: `demo shares {name}`')
  }
  if ((sub === 'share' || sub === 'unshare') && (!tokens[1] || !tokens[2])) {
    throw new Error(
      `Usage: \`demo ${sub} {name} {email}${
        sub === 'share' ? ' [viewer|editor]' : ''
      }\``,
    )
  }

  return handleCreateOrUpdate(
    client,
    channel,
    email,
    tenantId,
    args.trim(),
    threadTs,
    files,
  )
}

export { demoResultCard, handle, parseVisibilityFlag, statusIcon }
