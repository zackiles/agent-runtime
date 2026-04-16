import { Hono } from '@hono/hono'
import { context } from '../types.ts'
import type { Env } from '../types.ts'
import { listPrivateEntities, listPublicEntities } from '@ar/client/db/registry'
import type { EntityTable } from '@ar/client/db/registry'
import { listByTenant } from '@ar/client/db/agents'

const app = new Hono<Env>()

app.get('/', (c) => {
  const { tenantId, email, isAdmin } = context(c)
  const scope = c.req.query('scope')

  const entityTypes: EntityTable[] = ['tool', 'skill', 'rule']

  const publicAgents = listByTenant(tenantId, { visibility: 'public' })
  const publicItems: Record<string, unknown[]> = {}
  for (const t of entityTypes) {
    publicItems[t] = listPublicEntities(t, tenantId)
  }

  if (scope === 'public') {
    return c.json({
      tenantId,
      email,
      isAdmin,
      public: {
        agents: publicAgents,
        tools: publicItems.tool,
        skills: publicItems.skill,
        rules: publicItems.rule,
      },
      promotable: [],
    })
  }

  const privateAgents = listByTenant(tenantId, {
    visibility: 'private',
  }).filter((a) => a.createdBy === email)

  const privateItems: Record<string, unknown[]> = {}
  for (const t of entityTypes) {
    privateItems[t] = listPrivateEntities(t, tenantId, email)
  }

  const publicAgentSlugs = new Set(publicAgents.map((a) => a.slug))
  const promotable: Array<{ type: string; slug: string; name: string }> = []

  for (const a of privateAgents) {
    if (!publicAgentSlugs.has(a.slug)) {
      promotable.push({ type: 'agent', slug: a.slug, name: a.name })
    }
  }
  for (const t of entityTypes) {
    const publicSlugs = new Set(
      (publicItems[t] as Array<{ slug: string }>).map((e) => e.slug),
    )
    for (
      const e of (privateItems[t] as Array<
        { slug: string; name: string }
      >)
    ) {
      if (!publicSlugs.has(e.slug)) {
        promotable.push({ type: t, slug: e.slug, name: e.name })
      }
    }
  }

  return c.json({
    tenantId,
    email,
    isAdmin,
    public: {
      agents: publicAgents,
      tools: publicItems.tool,
      skills: publicItems.skill,
      rules: publicItems.rule,
    },
    private: {
      agents: privateAgents,
      tools: privateItems.tool,
      skills: privateItems.skill,
      rules: privateItems.rule,
    },
    promotable,
  })
})

export default app
