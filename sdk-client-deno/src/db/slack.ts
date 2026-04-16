import { getDb } from './mod.ts'

type SlackIdentity = {
  id: string
  tenantId: string
  userId: string
  workspaceSub: string
  slackUserId: string
  slackTeamId: string
  enabled: boolean
  createdAt: string
  updatedAt: string
}

type SlackSettings = {
  tenant?: string
  defaultAgent?: string
  notifications?: boolean
  streamingMode?: boolean
}

type SlackMessage = {
  id: number
  tenantId: string
  userId: string
  slackChannelId: string
  slackThreadTs: string | null
  direction: string
  command: string | null
  content: string | null
  agentId: string | null
  metadata: string | null
  createdAt: string
}

type SlackIdentityRow = {
  id: string
  tenant_id: string
  user_id: string
  workspace_sub: string
  slack_user_id: string
  slack_team_id: string
  enabled: number
  created_at: string
  updated_at: string
}

type SlackMessageRow = {
  id: number
  tenant_id: string
  user_id: string
  slack_channel_id: string
  slack_thread_ts: string | null
  direction: string
  command: string | null
  content: string | null
  agent_id: string | null
  metadata: string | null
  created_at: string
}

function mapIdentity(row: SlackIdentityRow): SlackIdentity {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    workspaceSub: row.workspace_sub,
    slackUserId: row.slack_user_id,
    slackTeamId: row.slack_team_id,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapMessage(row: SlackMessageRow): SlackMessage {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    slackChannelId: row.slack_channel_id,
    slackThreadTs: row.slack_thread_ts,
    direction: row.direction,
    command: row.command,
    content: row.content,
    agentId: row.agent_id,
    metadata: row.metadata,
    createdAt: row.created_at,
  }
}

function getIdentity(
  tenantId: string,
  userEmail: string,
): SlackIdentity | null {
  const db = getDb()
  const row = db.prepare(
    `SELECT * FROM slack_identity
     WHERE tenant_id = ? AND user_id = ?`,
  ).get(tenantId, userEmail) as SlackIdentityRow | undefined
  return row ? mapIdentity(row) : null
}

function getIdentityBySlackId(
  tenantId: string,
  slackUserId: string,
): SlackIdentity | null {
  const db = getDb()
  const row = db.prepare(
    `SELECT * FROM slack_identity
     WHERE tenant_id = ? AND slack_user_id = ?`,
  ).get(tenantId, slackUserId) as SlackIdentityRow | undefined
  return row ? mapIdentity(row) : null
}

function upsertIdentity(opts: {
  tenantId: string
  userId: string
  workspaceSub: string
  slackUserId: string
  slackTeamId: string
}): SlackIdentity {
  const db = getDb()
  const existing = db.prepare(
    `SELECT * FROM slack_identity
     WHERE tenant_id = ? AND user_id = ?`,
  ).get(opts.tenantId, opts.userId) as SlackIdentityRow | undefined

  if (existing) {
    db.exec(
      `UPDATE slack_identity
       SET workspace_sub = ?, slack_user_id = ?,
           slack_team_id = ?, enabled = 1,
           updated_at = datetime('now')
       WHERE id = ?`,
      opts.workspaceSub,
      opts.slackUserId,
      opts.slackTeamId,
      existing.id,
    )
    return mapIdentity({
      ...existing,
      workspace_sub: opts.workspaceSub,
      slack_user_id: opts.slackUserId,
      slack_team_id: opts.slackTeamId,
      enabled: 1,
    })
  }

  const id = crypto.randomUUID()
  db.exec(
    `INSERT INTO slack_identity
     (id, tenant_id, user_id, workspace_sub,
      slack_user_id, slack_team_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    id,
    opts.tenantId,
    opts.userId,
    opts.workspaceSub,
    opts.slackUserId,
    opts.slackTeamId,
  )

  const inserted = db.prepare(
    'SELECT * FROM slack_identity WHERE id = ?',
  ).get(id) as SlackIdentityRow
  return mapIdentity(inserted)
}

function disableIdentity(
  tenantId: string,
  userEmail: string,
): void {
  const db = getDb()
  db.exec(
    `UPDATE slack_identity
     SET enabled = 0, updated_at = datetime('now')
     WHERE tenant_id = ? AND user_id = ?`,
    tenantId,
    userEmail,
  )
}

function getSettings(
  tenantId: string,
  userEmail: string,
): SlackSettings {
  const db = getDb()
  const row = db.prepare(
    `SELECT settings FROM slack_settings
     WHERE tenant_id = ? AND user_id = ?`,
  ).get(tenantId, userEmail) as { settings: string } | undefined
  if (!row) return {}
  try {
    return JSON.parse(row.settings) as SlackSettings
  } catch {
    return {}
  }
}

function setSettings(
  tenantId: string,
  userEmail: string,
  settings: SlackSettings,
): void {
  const db = getDb()
  const existing = db.prepare(
    `SELECT id FROM slack_settings
     WHERE tenant_id = ? AND user_id = ?`,
  ).get(tenantId, userEmail) as { id: string } | undefined

  const json = JSON.stringify(settings)

  if (existing) {
    db.exec(
      `UPDATE slack_settings
       SET settings = ?, updated_at = datetime('now')
       WHERE id = ?`,
      json,
      existing.id,
    )
  } else {
    db.exec(
      `INSERT INTO slack_settings
       (id, tenant_id, user_id, settings)
       VALUES (?, ?, ?, ?)`,
      crypto.randomUUID(),
      tenantId,
      userEmail,
      json,
    )
  }
}

function logMessage(opts: {
  tenantId: string
  userId: string
  slackChannelId: string
  slackThreadTs?: string
  direction: string
  command?: string
  content?: string
  agentId?: string
  metadata?: string
}): void {
  const db = getDb()
  db.exec(
    `INSERT INTO slack_message
     (tenant_id, user_id, slack_channel_id,
      slack_thread_ts, direction, command,
      content, agent_id, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    opts.tenantId,
    opts.userId,
    opts.slackChannelId,
    opts.slackThreadTs ?? null,
    opts.direction,
    opts.command ?? null,
    opts.content ?? null,
    opts.agentId ?? null,
    opts.metadata ?? null,
  )
}

function listMessages(
  tenantId: string,
  userEmail: string,
  limit = 50,
  offset = 0,
): { messages: SlackMessage[]; total: number } {
  const db = getDb()

  const countRow = db.prepare(
    `SELECT COUNT(*) as total FROM slack_message
     WHERE tenant_id = ? AND user_id = ?`,
  ).get(tenantId, userEmail) as { total: number }

  const rows = db.prepare(
    `SELECT * FROM slack_message
     WHERE tenant_id = ? AND user_id = ?
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`,
  ).all(tenantId, userEmail, limit, offset) as SlackMessageRow[]

  return {
    messages: rows.map(mapMessage),
    total: countRow.total,
  }
}

function createAgentRef(opts: {
  tenantId: string
  userId: string
  agentId: string
  cleanupUnused?: boolean
}): void {
  const db = getDb()
  db.exec(
    `INSERT OR IGNORE INTO slack_agent_ref
     (id, tenant_id, user_id, agent_id, cleanup_unused)
     VALUES (?, ?, ?, ?, ?)`,
    crypto.randomUUID(),
    opts.tenantId,
    opts.userId,
    opts.agentId,
    opts.cleanupUnused !== false ? 1 : 0,
  )
}

export {
  createAgentRef,
  disableIdentity,
  getIdentity,
  getIdentityBySlackId,
  getSettings,
  listMessages,
  logMessage,
  setSettings,
  upsertIdentity,
}
export type { SlackIdentity, SlackMessage, SlackSettings }
