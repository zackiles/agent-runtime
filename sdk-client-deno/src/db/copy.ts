import { getDb, scheduleSync, transaction } from './mod.ts'
import { get as getAgent, getEdges, isLead } from './agents.ts'
import { log as auditLog } from './audit.ts'
import { assertValidTable } from './access.ts'

type CopyItem = {
  type:
    | 'agent'
    | 'webhook'
    | 'cron'
    | 'event'
    | 'file'
    | 'tool'
    | 'skill'
    | 'rule'
  id: string
  label: string
  isConflict: boolean
}

type CopyPlan = {
  slug: string
  fromTenant: string
  toTenant: string
  items: CopyItem[]
  warnings: string[]
}

type CopyReport = {
  copied: number
  overwritten: number
  failures: number
  warnings: string[]
}

function collectAgentChain(agentId: string): string[] {
  const ids: string[] = [agentId]
  const edges = getEdges(agentId)

  for (const edge of edges) {
    if (edge.direction === 'publishes' && edge.refType === 'agent') {
      const subIds = collectAgentChain(edge.refId)
      for (const sid of subIds) {
        if (!ids.includes(sid)) ids.push(sid)
      }
    }
  }
  return ids
}

function plan(
  slug: string,
  fromTenant: string,
  toTenant: string,
): CopyPlan {
  const db = getDb()
  const agent = db.prepare(
    `SELECT * FROM agent WHERE tenant_id = ? AND slug = ?
     ORDER BY version DESC LIMIT 1`,
  ).get(fromTenant, slug) as Record<string, unknown> | undefined

  if (!agent) throw new Error(`Agent '${slug}' not found in ${fromTenant}`)

  const agentId = agent.id as string
  const edges = getEdges(agentId)

  if (!isLead(edges)) {
    throw new Error('Only lead agents can be copied')
  }

  const agentIds = collectAgentChain(agentId)
  const items: CopyItem[] = []
  const warnings: string[] = []
  const seenTools = new Set<string>()
  const seenSkills = new Set<string>()
  const seenRules = new Set<string>()

  for (const id of agentIds) {
    const a = getAgent(id, fromTenant)
    if (!a) continue

    const exists = db.prepare(
      'SELECT id FROM agent WHERE tenant_id = ? AND slug = ? AND version = ?',
    ).get(toTenant, a.slug, a.version)

    const lead = isLead(getEdges(id))
    items.push({
      type: 'agent',
      id,
      label: `${a.slug}@${a.version} (${lead ? 'lead' : 'sub'})`,
      isConflict: !!exists,
    })

    const agentEdges = getEdges(id)
    for (const edge of agentEdges) {
      if (edge.refType === 'agent') continue

      if (edge.refType === 'tool' && !seenTools.has(edge.refId)) {
        seenTools.add(edge.refId)
        const tool = db.prepare(
          'SELECT * FROM tool WHERE id = ? AND tenant_id = ?',
        ).get(edge.refId, fromTenant) as
          | Record<string, unknown>
          | undefined

        if (tool) {
          const toolSlug = tool.slug as string
          const toolVersion = tool.version as string
          const destExists = db.prepare(
            'SELECT id FROM tool WHERE tenant_id = ? AND slug = ? AND version = ?',
          ).get(toTenant, toolSlug, toolVersion)

          items.push({
            type: 'tool',
            id: edge.refId,
            label: `tool:${toolSlug}@${toolVersion}`,
            isConflict: !!destExists,
          })
        } else {
          warnings.push(
            `Tool '${edge.refId}' referenced by agent '${a.slug}' not found in source tenant.`,
          )
        }
      }

      if (
        (edge.refType === 'skill' || edge.refType === 'rule') &&
        !(edge.refType === 'skill' ? seenSkills : seenRules).has(
          edge.refId,
        )
      ) {
        const seen = edge.refType === 'skill' ? seenSkills : seenRules
        seen.add(edge.refId)
        assertValidTable(edge.refType)
        const entity = db.prepare(
          `SELECT * FROM ${edge.refType} WHERE id = ? AND tenant_id = ?`,
        ).get(edge.refId, fromTenant) as
          | Record<string, unknown>
          | undefined

        if (entity) {
          const entitySlug = entity.slug as string
          const destExists = db.prepare(
            `SELECT id FROM ${edge.refType} WHERE tenant_id = ? AND slug = ?`,
          ).get(toTenant, entitySlug)

          items.push({
            type: edge.refType as 'skill' | 'rule',
            id: edge.refId,
            label: `${edge.refType}:${entitySlug}`,
            isConflict: !!destExists,
          })
        } else {
          warnings.push(
            `${edge.refType} '${edge.refId}' referenced by agent '${a.slug}' not found.`,
          )
        }
      }

      if (
        edge.refType !== 'tool' && edge.refType !== 'skill' &&
        edge.refType !== 'rule' && edge.refType !== 'agent'
      ) {
        items.push({
          type: edge.refType as CopyItem['type'],
          id: edge.refId,
          label: `${edge.refType}:${edge.refId}`,
          isConflict: false,
        })
      }
    }
  }

  return { slug, fromTenant, toTenant, items, warnings }
}

function execute(copyPlan: CopyPlan, actorId?: string): CopyReport {
  let copied = 0
  let overwritten = 0
  let failures = 0
  const warnings: string[] = [...(copyPlan.warnings || [])]

  transaction(() => {
    const db = getDb()
    for (const item of copyPlan.items) {
      try {
        if (item.type === 'agent') {
          copyAgent(
            db,
            item.id,
            copyPlan.fromTenant,
            copyPlan.toTenant,
          )
          if (item.isConflict) overwritten++
          else copied++
        } else if (item.type === 'tool') {
          copyTool(
            db,
            item.id,
            copyPlan.fromTenant,
            copyPlan.toTenant,
          )
          copied++
        } else if (item.type === 'skill' || item.type === 'rule') {
          copyRegistryEntity(
            db,
            item.type,
            item.id,
            copyPlan.fromTenant,
            copyPlan.toTenant,
          )
          copied++
        } else {
          copyConfig(
            db,
            item.type,
            item.id,
            copyPlan.fromTenant,
            copyPlan.toTenant,
          )
          copied++
        }
      } catch (err) {
        failures++
        warnings.push(
          `Failed to copy ${item.type} '${item.label}': ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    }
    auditLog(copyPlan.fromTenant, 'agent', copyPlan.slug, 'copied', actorId, {
      toTenant: copyPlan.toTenant,
      copied,
      overwritten,
      failures,
    })
  })

  scheduleSync(copyPlan.toTenant)
  return { copied, overwritten, failures, warnings }
}

function copyAgent(
  db: ReturnType<typeof getDb>,
  agentId: string,
  fromTenant: string,
  toTenant: string,
): void {
  const agent = getAgent(agentId, fromTenant)
  if (!agent) return

  const destTeamId = `default-team-${toTenant}`

  const existing = db.prepare(
    'SELECT id FROM agent WHERE tenant_id = ? AND slug = ? AND version = ?',
  ).get(toTenant, agent.slug, agent.version) as { id: string } | undefined

  if (existing) {
    db.exec(
      `UPDATE agent SET name = ?, subsystem = ?, team_id = ?,
       visibility = ?, updated_at = datetime('now')
       WHERE id = ?`,
      agent.name,
      agent.subsystem,
      destTeamId,
      agent.visibility,
      existing.id,
    )
    return
  }

  const newId = crypto.randomUUID()
  db.exec(
    `INSERT INTO agent
     (id, tenant_id, team_id, name, slug, version, subsystem, visibility, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    newId,
    toTenant,
    destTeamId,
    agent.name,
    agent.slug,
    agent.version,
    agent.subsystem,
    agent.visibility,
    agent.createdBy,
  )

  db.exec(
    'INSERT INTO agent_owner (agent_id, owner_id) VALUES (?, ?)',
    newId,
    agent.createdBy,
  )

  const edges = getEdges(agentId)
  for (const edge of edges) {
    if (edge.refType === 'agent') continue
    db.exec(
      `INSERT INTO agent_edge (agent_id, direction, ref_type, ref_id)
       VALUES (?, ?, ?, ?)`,
      newId,
      edge.direction,
      edge.refType,
      edge.refId,
    )
  }
}

function copyTool(
  db: ReturnType<typeof getDb>,
  toolId: string,
  fromTenant: string,
  toTenant: string,
): void {
  const tool = db.prepare(
    'SELECT * FROM tool WHERE id = ? AND tenant_id = ?',
  ).get(toolId, fromTenant) as
    | Record<string, unknown>
    | undefined
  if (!tool) return

  const slug = tool.slug as string
  const version = tool.version as string
  const exists = db.prepare(
    'SELECT id FROM tool WHERE tenant_id = ? AND slug = ? AND version = ?',
  ).get(toTenant, slug, version)

  if (exists) return

  const newId = crypto.randomUUID()
  db.exec(
    `INSERT INTO tool (id, tenant_id, name, slug, version, visibility, owner_id, gcs_path, has_install)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    newId,
    toTenant,
    tool.name as string,
    slug,
    version,
    tool.visibility as string,
    tool.owner_id as string,
    (tool.gcs_path as string) ?? null,
    ((tool.has_install as number) ?? 0) as number,
  )
}

function copyRegistryEntity(
  db: ReturnType<typeof getDb>,
  type: 'skill' | 'rule',
  entityId: string,
  fromTenant: string,
  toTenant: string,
): void {
  assertValidTable(type)
  const entity = db.prepare(
    `SELECT * FROM ${type} WHERE id = ? AND tenant_id = ?`,
  ).get(entityId, fromTenant) as Record<string, unknown> | undefined
  if (!entity) return

  const slug = entity.slug as string
  const version = (entity.version as string) ?? '0.0.1'
  const exists = db.prepare(
    `SELECT id FROM ${type} WHERE tenant_id = ? AND slug = ? AND version = ?`,
  ).get(toTenant, slug, version)
  if (exists) return

  const newId = crypto.randomUUID()
  db.exec(
    `INSERT INTO ${type} (id, tenant_id, name, slug, version, visibility, owner_id, config, gcs_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    newId,
    toTenant,
    entity.name as string,
    slug,
    version,
    entity.visibility as string,
    entity.owner_id as string,
    (entity.config as string) ?? null,
    (entity.gcs_path as string) ?? null,
  )
}

function copyConfig(
  db: ReturnType<typeof getDb>,
  type: string,
  id: string,
  fromTenant: string,
  toTenant: string,
): void {
  const table = `${type}_config`
  assertValidTable(table)
  const row = db.prepare(
    `SELECT * FROM ${table} WHERE id = ? AND tenant_id = ?`,
  ).get(id, fromTenant) as
    | Record<string, unknown>
    | undefined
  if (!row) return

  const newId = crypto.randomUUID()
  const columns = Object.keys(row).filter((k) => k !== 'id')
  const values = columns.map((k) =>
    k === 'tenant_id' ? toTenant : row[k]
  ) as Array<string | number | null>

  db.exec(
    `INSERT INTO ${table} (id, ${columns.join(', ')})
     VALUES (?, ${columns.map(() => '?').join(', ')})`,
    newId,
    ...values,
  )
}

export { execute, plan }
export type { CopyItem, CopyPlan, CopyReport }
