import { useEffect, useState } from 'preact/hooks'
import { api } from '../api.ts'
import { useApp } from '../context.ts'

type Tab = 'users' | 'tenants' | 'storage' | 'activity' | 'secrets' | 'backup'

const TABS: { id: Tab; label: string }[] = [
  { id: 'users', label: 'Users' },
  { id: 'tenants', label: 'Tenants' },
  { id: 'storage', label: 'Storage' },
  { id: 'activity', label: 'Activity' },
  { id: 'secrets', label: 'Secrets' },
  { id: 'backup', label: 'Backup' },
]

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function Card({
  title,
  children,
}: {
  title?: string
  children: preact.ComponentChildren
}) {
  return (
    <div class='bg-white border border-gray-200 rounded-xl p-6'>
      {title && (
        <h3 class='text-sm font-semibold text-gray-800 mb-4'>{title}</h3>
      )}
      {children}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div class='bg-white border border-gray-200 rounded-xl p-4 text-center'>
      <p class='text-2xl font-bold text-gray-900'>{value}</p>
      <p class='text-xs text-gray-500 mt-1'>{label}</p>
    </div>
  )
}

type User = {
  id: string
  name: string
  isAdmin: boolean
  createdAt: string
}

type Role = 'admin' | 'member'

function UsersTab() {
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Role>('member')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [confirm, setConfirm] = useState<string | null>(null)

  function load() {
    setLoading(true)
    api('/api/settings/users')
      .then((r) => r.json())
      .then((d) => setUsers(d as User[]))
      .finally(() => setLoading(false))
  }

  useEffect(load, [])

  const isSystem = (u: User) => u.id === 'system@ar-cli'
  const realAdmins = users.filter(
    (u) => u.isAdmin && !isSystem(u),
  )
  const isLastAdmin = (u: User) =>
    u.isAdmin && !isSystem(u) && realAdmins.length <= 1
  const isProtected = (u: User) => isSystem(u) || isLastAdmin(u)

  async function addUser() {
    if (!email.trim()) return
    setSaving(true)
    setError('')
    const res = await api('/api/settings/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim(), role }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string }
      setError(body.error || 'Failed to add user')
    } else {
      setEmail('')
      setRole('member')
    }
    setSaving(false)
    load()
  }

  async function changeRole(user: User, newRole: Role) {
    setError('')
    const res = await api(
      `/api/settings/users/${encodeURIComponent(user.id)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: newRole }),
      },
    )
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string }
      setError(body.error || 'Failed to update role')
    }
    load()
  }

  async function removeUser(userId: string) {
    setError('')
    const res = await api(
      `/api/settings/users/${encodeURIComponent(userId)}`,
      { method: 'DELETE' },
    )
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string }
      setError(body.error || 'Failed to remove user')
    }
    setConfirm(null)
    load()
  }

  if (loading) {
    return <p class='text-sm text-gray-400 py-8 text-center'>Loading...</p>
  }

  return (
    <div class='space-y-4'>
      {error && (
        <div class='p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700'>
          {error}
        </div>
      )}
      <Card title='Add User'>
        <div class='flex gap-2'>
          <input
            type='email'
            value={email}
            onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
            placeholder='user@example.com'
            class='flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500'
            onKeyDown={(e) => e.key === 'Enter' && addUser()}
          />
          <select
            value={role}
            onChange={(e) =>
              setRole((e.target as HTMLSelectElement).value as Role)}
            class='px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500'
          >
            <option value='member'>Member</option>
            <option value='admin'>Admin</option>
          </select>
          <button
            type='button'
            onClick={addUser}
            disabled={saving || !email.trim()}
            class='px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50'
          >
            {saving ? 'Adding...' : 'Add'}
          </button>
        </div>
      </Card>
      <Card title={`Users (${users.length})`}>
        <div class='divide-y divide-gray-100'>
          {users.map((u) => (
            <div
              key={u.id}
              class='flex items-center justify-between py-3 first:pt-0 last:pb-0'
            >
              <div>
                <p class='text-sm font-medium text-gray-900'>{u.id}</p>
                <p class='text-xs text-gray-400'>
                  {u.createdAt || 'unknown'}
                </p>
              </div>
              <div class='flex items-center gap-2'>
                <select
                  value={u.isAdmin ? 'admin' : 'member'}
                  disabled={isProtected(u)}
                  onChange={(e) =>
                    changeRole(
                      u,
                      (e.target as HTMLSelectElement).value as Role,
                    )}
                  class={`text-xs px-2 py-1 border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                    isProtected(u) ? 'opacity-50 cursor-not-allowed' : ''
                  }`}
                >
                  <option value='admin'>Admin</option>
                  <option value='member'>Member</option>
                </select>
                {confirm === u.id
                  ? (
                    <div class='flex gap-1'>
                      <button
                        type='button'
                        onClick={() => removeUser(u.id)}
                        class='text-xs px-2 py-1 rounded-full bg-red-100 text-red-700 hover:bg-red-200 font-medium'
                      >
                        Confirm
                      </button>
                      <button
                        type='button'
                        onClick={() => setConfirm(null)}
                        class='text-xs px-2 py-1 rounded-full bg-gray-100 text-gray-500 hover:bg-gray-200'
                      >
                        Cancel
                      </button>
                    </div>
                  )
                  : (
                    <button
                      type='button'
                      disabled={isProtected(u)}
                      onClick={() => setConfirm(u.id)}
                      class={`text-xs px-2 py-1 rounded-full font-medium ${
                        isProtected(u)
                          ? 'bg-gray-50 text-gray-300 cursor-not-allowed'
                          : 'bg-red-50 text-red-600 hover:bg-red-100'
                      }`}
                    >
                      Remove
                    </button>
                  )}
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}

type TenantInfo = {
  id: string
  userCount: number
  files: number
  bytes: number
}

function TenantsTab() {
  const { user } = useApp()
  const [tenants, setTenants] = useState<TenantInfo[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    api('/api/settings/tenants')
      .then((r) => r.json())
      .then((d) => setTenants(d as TenantInfo[]))
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return <p class='text-sm text-gray-400 py-8 text-center'>Loading...</p>
  }

  return (
    <Card title='Bootstrapped Tenants'>
      <div class='divide-y divide-gray-100'>
        {tenants.map((t) => (
          <div
            key={t.id}
            class={`flex items-center justify-between py-3 first:pt-0 last:pb-0 ${
              t.id === user.tenantId ? 'bg-blue-50 -mx-6 px-6 rounded-lg' : ''
            }`}
          >
            <div>
              <p class='text-sm font-semibold text-gray-900'>
                {t.id}
                {t.id === user.tenantId && (
                  <span class='ml-2 text-xs text-blue-600 font-medium'>
                    current
                  </span>
                )}
              </p>
              <p class='text-xs text-gray-400'>
                {t.userCount} user{t.userCount !== 1 ? 's' : ''}
              </p>
            </div>
            <div class='text-right'>
              <p class='text-sm font-mono text-gray-700'>
                {t.files.toLocaleString()} files
              </p>
              <p class='text-xs text-gray-400'>{formatBytes(t.bytes)}</p>
            </div>
          </div>
        ))}
      </div>
    </Card>
  )
}

type GcsItem = { name: string; size: string; updated: string }
type StorageData = { items: GcsItem[]; totalFiles: number; totalBytes: number }

function StorageTab() {
  const [data, setData] = useState<StorageData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    api('/api/settings/storage')
      .then((r) => r.json())
      .then((d) => setData(d as StorageData))
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return <p class='text-sm text-gray-400 py-8 text-center'>Loading...</p>
  }
  if (!data) return null

  return (
    <div class='space-y-4'>
      <div class='grid grid-cols-2 gap-4'>
        <Stat label='Total Files' value={data.totalFiles.toLocaleString()} />
        <Stat label='Total Size' value={formatBytes(data.totalBytes)} />
      </div>
      <Card title='Objects'>
        <div class='max-h-96 overflow-y-auto'>
          <table class='w-full text-sm'>
            <thead class='text-xs text-gray-500 border-b border-gray-200'>
              <tr>
                <th class='text-left py-2 font-medium'>Path</th>
                <th class='text-right py-2 font-medium'>Size</th>
                <th class='text-right py-2 font-medium'>Modified</th>
              </tr>
            </thead>
            <tbody class='divide-y divide-gray-50'>
              {data.items.map((item) => (
                <tr key={item.name}>
                  <td class='py-2 font-mono text-xs text-gray-700 truncate max-w-xs'>
                    {item.name}
                  </td>
                  <td class='py-2 text-right text-xs text-gray-500'>
                    {formatBytes(parseInt(item.size || '0', 10))}
                  </td>
                  <td class='py-2 text-right text-xs text-gray-400'>
                    {item.updated
                      ? new Date(item.updated).toLocaleDateString()
                      : '\u2014'}
                  </td>
                </tr>
              ))}
              {data.items.length === 0 && (
                <tr>
                  <td
                    colspan={3}
                    class='py-8 text-center text-gray-400 text-xs'
                  >
                    No objects
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}

type ActivityData = {
  telemetry: Record<string, number>
  audit: Record<string, number>
  recentAudit: Array<{
    id: number
    action: string
    entityType: string
    entityId: string
    actorId: string | null
    createdAt: string
  }>
  recentTelemetry: Array<{
    id: string
    action: string
    client: string
    actor: string | null
    level: string
    createdAt: string
  }>
}

function ActivityTab() {
  const [data, setData] = useState<ActivityData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    api('/api/settings/activity')
      .then((r) => r.json())
      .then((d) => setData(d as ActivityData))
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return <p class='text-sm text-gray-400 py-8 text-center'>Loading...</p>
  }
  if (!data) return null

  return (
    <div class='space-y-4'>
      <div class='grid grid-cols-3 gap-4'>
        <Stat label='Audit (24h)' value={data.audit['24h'] ?? 0} />
        <Stat label='Audit (7d)' value={data.audit['7d'] ?? 0} />
        <Stat label='Audit (30d)' value={data.audit['30d'] ?? 0} />
      </div>
      <div class='grid grid-cols-3 gap-4'>
        <Stat label='Telemetry (24h)' value={data.telemetry['24h'] ?? 0} />
        <Stat label='Telemetry (7d)' value={data.telemetry['7d'] ?? 0} />
        <Stat label='Telemetry (30d)' value={data.telemetry['30d'] ?? 0} />
      </div>
      <Card title='Recent Audit Entries'>
        <div class='max-h-72 overflow-y-auto'>
          <table class='w-full text-sm'>
            <thead class='text-xs text-gray-500 border-b border-gray-200'>
              <tr>
                <th class='text-left py-2 font-medium'>Action</th>
                <th class='text-left py-2 font-medium'>Entity</th>
                <th class='text-left py-2 font-medium'>Actor</th>
                <th class='text-right py-2 font-medium'>Time</th>
              </tr>
            </thead>
            <tbody class='divide-y divide-gray-50'>
              {data.recentAudit.map((e) => (
                <tr key={e.id}>
                  <td class='py-2 text-xs font-medium text-gray-700'>
                    {e.action}
                  </td>
                  <td class='py-2 text-xs text-gray-500'>
                    {e.entityType}/{e.entityId}
                  </td>
                  <td class='py-2 text-xs text-gray-500 truncate max-w-[120px]'>
                    {e.actorId || '\u2014'}
                  </td>
                  <td class='py-2 text-right text-xs text-gray-400'>
                    {e.createdAt
                      ? new Date(e.createdAt).toLocaleString()
                      : '\u2014'}
                  </td>
                </tr>
              ))}
              {data.recentAudit.length === 0 && (
                <tr>
                  <td
                    colspan={4}
                    class='py-8 text-center text-gray-400 text-xs'
                  >
                    No audit entries
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}

type SecretInfo = { name: string; createTime: string; versionCount?: number }

function SecretsTab() {
  const [secrets, setSecrets] = useState<SecretInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [confirm, setConfirm] = useState<string | null>(null)

  function load() {
    setLoading(true)
    api('/secrets')
      .then((r) => r.json())
      .then((d) => setSecrets(d as SecretInfo[]))
      .finally(() => setLoading(false))
  }

  useEffect(load, [])

  async function addSecret() {
    if (!name.trim() || !value.trim()) return
    setSaving(true)
    await api('/secrets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), value: value.trim() }),
    })
    setName('')
    setValue('')
    setSaving(false)
    load()
  }

  async function deleteSecret(secretName: string) {
    await api(`/secrets/${encodeURIComponent(secretName)}`, {
      method: 'DELETE',
    })
    setConfirm(null)
    load()
  }

  if (loading) {
    return <p class='text-sm text-gray-400 py-8 text-center'>Loading...</p>
  }

  return (
    <div class='space-y-4'>
      <Card title='Add / Rotate Secret'>
        <div class='space-y-2'>
          <input
            type='text'
            value={name}
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
            placeholder='secret-name'
            class='w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500'
          />
          <input
            type='password'
            value={value}
            onInput={(e) => setValue((e.target as HTMLInputElement).value)}
            placeholder='secret value'
            class='w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500'
          />
          <button
            type='button'
            onClick={addSecret}
            disabled={saving || !name.trim() || !value.trim()}
            class='px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50'
          >
            {saving ? 'Saving...' : 'Set Secret'}
          </button>
        </div>
      </Card>
      <Card title={`Secrets (${secrets.length})`}>
        <div class='divide-y divide-gray-100'>
          {secrets.map((s) => (
            <div
              key={s.name}
              class='flex items-center justify-between py-3 first:pt-0 last:pb-0'
            >
              <div>
                <p class='text-sm font-mono text-gray-900'>{s.name}</p>
                <p class='text-xs text-gray-400'>
                  Created {s.createTime
                    ? new Date(s.createTime).toLocaleDateString()
                    : 'unknown'}
                </p>
              </div>
              {confirm === s.name
                ? (
                  <div class='flex gap-2'>
                    <button
                      type='button'
                      onClick={() => deleteSecret(s.name)}
                      class='text-xs px-3 py-1 rounded-full bg-red-100 text-red-700 hover:bg-red-200 font-medium'
                    >
                      Confirm
                    </button>
                    <button
                      type='button'
                      onClick={() => setConfirm(null)}
                      class='text-xs px-3 py-1 rounded-full bg-gray-100 text-gray-500 hover:bg-gray-200'
                    >
                      Cancel
                    </button>
                  </div>
                )
                : (
                  <button
                    type='button'
                    onClick={() => setConfirm(s.name)}
                    class='text-xs px-3 py-1 rounded-full bg-red-50 text-red-600 hover:bg-red-100 font-medium'
                  >
                    Delete
                  </button>
                )}
            </div>
          ))}
          {secrets.length === 0 && (
            <p class='text-sm text-gray-400 py-4 text-center'>
              No secrets found
            </p>
          )}
        </div>
      </Card>
    </div>
  )
}

function BackupTab() {
  const [downloading, setDownloading] = useState(false)

  async function download() {
    setDownloading(true)
    try {
      const res = await api('/api/settings/backup')
      if (!res.ok) throw new Error('Backup failed')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      const header = res.headers.get('Content-Disposition') || ''
      const match = header.match(/filename="?([^"]+)"?/)
      a.download = match?.[1] || 'backup.db.gz'
      a.href = url
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      alert('Failed to download backup')
    } finally {
      setDownloading(false)
    }
  }

  return (
    <Card title='Database Backup'>
      <p class='text-sm text-gray-500 mb-4'>
        Download a gzipped copy of the current tenant's SQLite database. This
        includes all agents, teams, audit logs, telemetry, and configuration
        stored locally on the control plane.
      </p>
      <button
        type='button'
        onClick={download}
        disabled={downloading}
        class='px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50'
      >
        {downloading ? 'Downloading...' : 'Download Backup'}
      </button>
    </Card>
  )
}

const TAB_COMPONENTS: Record<Tab, () => preact.VNode | null> = {
  users: UsersTab,
  tenants: TenantsTab,
  storage: StorageTab,
  activity: ActivityTab,
  secrets: SecretsTab,
  backup: BackupTab,
}

export function Settings() {
  const [tab, setTab] = useState<Tab>('users')
  const TabContent = TAB_COMPONENTS[tab]

  return (
    <div class='space-y-6'>
      <h2 class='text-lg font-semibold'>Settings</h2>

      <div class='border-b border-gray-200'>
        <nav class='flex gap-0.5 -mb-px overflow-x-auto'>
          {TABS.map((t) => (
            <button
              type='button'
              key={t.id}
              onClick={() => setTab(t.id)}
              class={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                tab === t.id
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      <TabContent />
    </div>
  )
}
