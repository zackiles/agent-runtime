import { Hono } from '@hono/hono'
import { context } from '../types.ts'
import type { Env } from '../types.ts'
import {
  createDepartment,
  createTeam,
  editDepartment,
  editTeam,
  listDepartments,
  listTeams,
} from '@ar/client/db/teams'

const app = new Hono<Env>()

app.post('/teams', async (c) => {
  const { tenantId, email } = context(c)
  const body = await c.req.json() as {
    name: string
    departmentId?: string
  }
  const team = createTeam(tenantId, body.name, email, body.departmentId)
  return c.json(team, 201)
})

app.get('/teams', (c) => {
  const { tenantId } = context(c)
  return c.json(listTeams(tenantId))
})

app.put('/teams/:id', async (c) => {
  const { tenantId } = context(c)
  const body = await c.req.json() as { ownerId?: string }
  editTeam(c.req.param('id'), tenantId, body)
  return c.json({ message: 'Updated' })
})

app.post('/departments', async (c) => {
  const { tenantId, email } = context(c)
  const body = await c.req.json() as { name: string }
  const dept = createDepartment(tenantId, body.name, email)
  return c.json(dept, 201)
})

app.get('/departments', (c) => {
  const { tenantId } = context(c)
  return c.json(listDepartments(tenantId))
})

app.put('/departments/:id', async (c) => {
  const { tenantId } = context(c)
  const body = await c.req.json() as { ownerId?: string }
  editDepartment(c.req.param('id'), tenantId, body)
  return c.json({ message: 'Updated' })
})

export default app
