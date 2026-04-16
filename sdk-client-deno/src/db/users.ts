import { getDb } from './mod.ts'

type User = {
  id: string
  name: string
  isAdmin: boolean
  createdAt: string
}

function ensure(email: string): User {
  const db = getDb()
  const row = db.prepare('SELECT * FROM user WHERE id = ?').get(email) as
    | { id: string; name: string; is_admin: number; created_at: string }
    | undefined

  if (row) {
    return {
      id: row.id,
      name: row.name,
      isAdmin: row.is_admin === 1,
      createdAt: row.created_at,
    }
  }

  const count = db.prepare('SELECT COUNT(*) as cnt FROM user').get() as
    | { cnt: number }
    | undefined
  const firstUser = (count?.cnt ?? 0) === 0
  const admin = firstUser ? 1 : 0

  db.exec(
    'INSERT INTO user (id, name, is_admin) VALUES (?, ?, ?)',
    email,
    email,
    admin,
  )
  return { id: email, name: email, isAdmin: firstUser, createdAt: '' }
}

function get(email: string): User | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM user WHERE id = ?').get(email) as
    | { id: string; name: string; is_admin: number; created_at: string }
    | undefined
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    isAdmin: row.is_admin === 1,
    createdAt: row.created_at,
  }
}

function isAdmin(email: string): boolean {
  const user = get(email)
  if (user?.isAdmin === true) return true
  const adminGroup = Deno.env.get('AR_ADMIN_GROUP')
  if (adminGroup) {
    const members = adminGroup.split(',').map((m) => m.trim())
    if (members.includes(email)) return true
  }
  return false
}

function setAdmin(email: string, value: boolean): void {
  const db = getDb()
  db.exec(
    'UPDATE user SET is_admin = ? WHERE id = ?',
    value ? 1 : 0,
    email,
  )
}

function remove(email: string): boolean {
  const db = getDb()
  const result = db.exec('DELETE FROM user WHERE id = ?', email)
  return result > 0
}

function adminCount(): number {
  const db = getDb()
  const row = db.prepare(
    "SELECT COUNT(*) as cnt FROM user WHERE is_admin = 1 AND id != 'system@ar-cli'",
  ).get() as { cnt: number } | undefined
  return row?.cnt ?? 0
}

function list(): User[] {
  const db = getDb()
  const rows = db.prepare('SELECT * FROM user ORDER BY created_at')
    .all() as Array<
      { id: string; name: string; is_admin: number; created_at: string }
    >
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    isAdmin: r.is_admin === 1,
    createdAt: r.created_at,
  }))
}

export { adminCount, ensure, get, isAdmin, list, remove, setAdmin }
export type { User }
