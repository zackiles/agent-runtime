import { useEffect, useState } from 'preact/hooks'
import { api } from '../api.ts'
import { useApp } from '../context.ts'

type SlackIdentity = {
  email: string
  slackUserId: string
  slackTeamId: string
  displayName: string
  slackEmail: string
  enabled: boolean
}

type SlackMessage = {
  id: number
  direction: string
  command: string | null
  content: string | null
  agentId: string | null
  createdAt: string
}

type MessagesResponse = {
  messages: SlackMessage[]
  total: number
}

function Row(
  { label, value }: { label: string; value: string },
) {
  const display = !value || value === 'unknown' ? '\u2014' : value
  return (
    <div class='flex justify-between py-2 border-b border-gray-100 last:border-b-0'>
      <span class='text-gray-500 text-sm'>{label}</span>
      <span class='text-sm font-medium text-gray-900'>
        {display}
      </span>
    </div>
  )
}

function AccountWidget(
  { email, isAdmin, tenantId, onSwitchTenant }: {
    email: string
    isAdmin: boolean
    tenantId: string
    onSwitchTenant: (id: string) => Promise<void>
  },
) {
  const [tenants, setTenants] = useState<string[]>([])
  const [switching, setSwitching] = useState(false)

  useEffect(() => {
    api('/api/user/tenants')
      .then((r) => r.ok ? r.json() : [])
      .then((d) => setTenants(d as string[]))
      .catch(() => {})
  }, [])

  async function handleSwitch(id: string) {
    if (id === tenantId || switching) return
    setSwitching(true)
    try {
      await onSwitchTenant(id)
    } catch {
      setSwitching(false)
    }
  }

  return (
    <div class='bg-white border border-gray-200 rounded-xl p-6'>
      <h3 class='text-sm font-semibold text-gray-700 mb-4'>
        Account
      </h3>
      <Row label='Email' value={email} />
      <Row label='Role' value={isAdmin ? 'Admin' : 'Member'} />
      {tenants.length > 1
        ? (
          <div class='flex justify-between items-center py-2 border-b border-gray-100'>
            <span class='text-gray-500 text-sm'>Tenant</span>
            <select
              value={tenantId}
              onChange={(e) =>
                handleSwitch(
                  (e.target as HTMLSelectElement).value,
                )}
              disabled={switching}
              class='text-sm font-medium text-gray-900 bg-white border border-gray-200 rounded-md px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer disabled:opacity-50'
            >
              {tenants.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
        )
        : <Row label='Tenant' value={tenantId} />}
    </div>
  )
}

function SlackWidget() {
  const [identity, setIdentity] = useState<SlackIdentity | null>(
    null,
  )
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    api('/api/bots/slack/identity/resolve', { method: 'POST' })
      .then((res) => {
        if (res.ok) return res.json()
        return null
      })
      .then((data) => {
        if (data && !data.error) setIdentity(data as SlackIdentity)
      })
      .catch(() => setError('Failed to check enrollment'))
      .finally(() => setLoading(false))
  }, [])

  async function enable() {
    try {
      const res = await api('/api/bots/slack/oauth/start', {
        method: 'POST',
      })
      const data = await res.json() as { url?: string }
      if (data.url) {
        globalThis.location.href = data.url
      }
    } catch {
      setError('Failed to start enrollment')
    }
  }

  async function disable() {
    try {
      await api('/api/bots/slack/oauth/revoke', {
        method: 'POST',
      })
      setIdentity(null)
    } catch {
      setError('Failed to disable')
    }
  }

  return (
    <div class='bg-white border border-gray-200 rounded-xl p-6'>
      <h3 class='text-sm font-semibold text-gray-700 mb-4'>
        Slack Bot
      </h3>
      <p class='text-sm text-gray-500 mb-4'>
        Connect your Slack account to interact with agents directly from Slack.
      </p>
      {loading
        ? <p class='text-sm text-gray-400'>Loading...</p>
        : identity?.enabled
        ? (
          <div>
            <Row label='Status' value='Connected' />
            {identity.displayName && (
              <Row
                label='Name'
                value={identity.displayName}
              />
            )}
            {identity.slackEmail && (
              <Row
                label='Slack Email'
                value={identity.slackEmail}
              />
            )}
            <Row
              label='Slack User ID'
              value={identity.slackUserId}
            />
            <div class='mt-4'>
              <button
                type='button'
                onClick={disable}
                class='px-4 py-2 text-sm font-medium text-red-600 border border-red-200 rounded-lg hover:bg-red-50'
              >
                Disable Slack Bot
              </button>
            </div>
          </div>
        )
        : (
          <div>
            <Row label='Status' value='Not Connected' />
            <div class='mt-4'>
              <button
                type='button'
                onClick={enable}
                class='px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700'
              >
                Enable Slack Bot
              </button>
            </div>
          </div>
        )}
      {error && <p class='mt-2 text-sm text-red-500'>{error}</p>}
    </div>
  )
}

function MessagesWidget() {
  const [messages, setMessages] = useState<SlackMessage[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(true)
  const limit = 20

  useEffect(() => {
    setLoading(true)
    api(
      `/api/bots/slack/messages/list?limit=${limit}&offset=${page * limit}`,
    )
      .then((res) => res.json())
      .then((data) => {
        const d = data as MessagesResponse
        setMessages(d.messages || [])
        setTotal(d.total || 0)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [page])

  const totalPages = Math.max(1, Math.ceil(total / limit))

  function formatTime(iso: string): string {
    if (!iso) return '\u2014'
    const d = new Date(iso)
    return d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  return (
    <div class='bg-white border border-gray-200 rounded-xl p-6'>
      <h3 class='text-sm font-semibold text-gray-700 mb-4'>
        Slack Messages
      </h3>
      {loading
        ? <p class='text-sm text-gray-400'>Loading...</p>
        : messages.length === 0
        ? (
          <p class='text-sm text-gray-400 text-center py-8'>
            No messages yet.
          </p>
        )
        : (
          <div class='overflow-x-auto'>
            <table class='w-full text-sm'>
              <thead>
                <tr class='border-b border-gray-200 text-left text-gray-500'>
                  <th class='py-2 pr-4 font-medium'>Time</th>
                  <th class='py-2 pr-4 font-medium'>
                    Direction
                  </th>
                  <th class='py-2 pr-4 font-medium'>Command</th>
                  <th class='py-2 pr-4 font-medium'>Agent</th>
                  <th class='py-2 font-medium'>Content</th>
                </tr>
              </thead>
              <tbody>
                {messages.map((m) => (
                  <tr
                    key={m.id}
                    class='border-b border-gray-50'
                  >
                    <td class='py-2 pr-4 text-gray-600 whitespace-nowrap'>
                      {formatTime(m.createdAt)}
                    </td>
                    <td class='py-2 pr-4'>
                      <span
                        class={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                          m.direction === 'inbound'
                            ? 'bg-blue-50 text-blue-700'
                            : 'bg-green-50 text-green-700'
                        }`}
                      >
                        {m.direction}
                      </span>
                    </td>
                    <td class='py-2 pr-4 text-gray-600'>
                      {m.command || '\u2014'}
                    </td>
                    <td class='py-2 pr-4 text-gray-600'>
                      {m.agentId || '\u2014'}
                    </td>
                    <td class='py-2 text-gray-900 max-w-xs truncate'>
                      {m.content || '\u2014'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div class='flex items-center justify-between mt-4 text-sm text-gray-500'>
              <button
                type='button'
                onClick={() => setPage(Math.max(0, page - 1))}
                disabled={page === 0}
                class='px-3 py-1 border rounded disabled:opacity-40'
              >
                Previous
              </button>
              <span>
                Page {page + 1} of {totalPages}
              </span>
              <button
                type='button'
                onClick={() =>
                  setPage(
                    Math.min(totalPages - 1, page + 1),
                  )}
                disabled={page >= totalPages - 1}
                class='px-3 py-1 border rounded disabled:opacity-40'
              >
                Next
              </button>
            </div>
          </div>
        )}
    </div>
  )
}

const REGISTRY_PATTERNS = [
  /\/source\.tar\.gz$/,
  /\/archive\.tar\.gz$/,
  /\/grant\.json$/,
]

function isUserFile(path: string): boolean {
  if (REGISTRY_PATTERNS.some((p) => p.test(path))) return false
  if (/\/(tools|skills|rules)\//.test(path)) return false
  return true
}

function StorageWidget({ tenantId }: { tenantId: string }) {
  const [files, setFiles] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [prefix, setPrefix] = useState(`${tenantId}/`)

  useEffect(() => {
    setLoading(true)
    api(`/storage/list?prefix=${encodeURIComponent(prefix)}`)
      .then((r) => r.ok ? r.json() : [])
      .then((d) => setFiles((d as string[]).filter(isUserFile)))
      .catch(() => setFiles([]))
      .finally(() => setLoading(false))
  }, [prefix])

  const folders = new Map<string, string[]>()
  for (const f of files) {
    const rel = f.startsWith(prefix) ? f.slice(prefix.length) : f
    const slashIdx = rel.indexOf('/')
    if (slashIdx >= 0) {
      const folder = rel.slice(0, slashIdx)
      const rest = rel.slice(slashIdx + 1)
      if (!folders.has(folder)) folders.set(folder, [])
      folders.get(folder)!.push(rest)
    } else if (rel) {
      if (!folders.has('')) folders.set('', [])
      folders.get('')!.push(rel)
    }
  }

  const root = `${tenantId}/`
  const crumbs = prefix.slice(root.length).split('/').filter(Boolean)

  function navigate(folder: string) {
    setPrefix(prefix + folder + '/')
  }

  function navigateCrumb(idx: number) {
    setPrefix(root + crumbs.slice(0, idx + 1).join('/') + '/')
  }

  return (
    <div class='bg-white border border-gray-200 rounded-xl p-6'>
      <h3 class='text-sm font-semibold text-gray-700 mb-1'>
        Storage
      </h3>
      <p class='text-xs text-gray-400 mb-4'>
        Agent outputs, demo sources, and files written by your agents
      </p>

      <div class='flex items-center gap-1 text-xs mb-3 flex-wrap'>
        <button
          type='button'
          onClick={() => setPrefix(root)}
          class={`px-1.5 py-0.5 rounded hover:bg-gray-100 ${
            crumbs.length === 0 ? 'font-medium text-gray-800' : 'text-blue-600'
          }`}
        >
          {tenantId}
        </button>
        {crumbs.map((c, i) => (
          <span key={i} class='flex items-center gap-1'>
            <span class='text-gray-300'>/</span>
            <button
              type='button'
              onClick={() => navigateCrumb(i)}
              class={`px-1.5 py-0.5 rounded hover:bg-gray-100 ${
                i === crumbs.length - 1
                  ? 'font-medium text-gray-800'
                  : 'text-blue-600'
              }`}
            >
              {c}
            </button>
          </span>
        ))}
      </div>

      {loading
        ? <p class='text-xs text-gray-400 py-4'>Loading...</p>
        : files.length === 0
        ? (
          <p class='text-xs text-gray-400 py-4 text-center'>
            No files found
          </p>
        )
        : (
          <div class='border border-gray-200 rounded-lg divide-y divide-gray-100 max-h-64 overflow-y-auto'>
            {[...folders.entries()].map(([folder, items]) => {
              if (folder === '') {
                return items.map((f) => (
                  <div
                    key={f}
                    class='flex items-center gap-2 px-3 py-2 text-xs'
                  >
                    <span class='text-gray-400'>
                      <svg
                        class='w-3.5 h-3.5'
                        fill='none'
                        viewBox='0 0 24 24'
                        stroke='currentColor'
                        stroke-width='1.5'
                      >
                        <path
                          stroke-linecap='round'
                          stroke-linejoin='round'
                          d='M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z'
                        />
                      </svg>
                    </span>
                    <span class='text-gray-700 font-mono truncate'>
                      {f}
                    </span>
                  </div>
                ))
              }
              return (
                <button
                  key={folder}
                  type='button'
                  onClick={() => navigate(folder)}
                  class='flex items-center gap-2 px-3 py-2 text-xs w-full text-left hover:bg-gray-50 transition-colors'
                >
                  <span class='text-blue-500'>
                    <svg
                      class='w-3.5 h-3.5'
                      fill='none'
                      viewBox='0 0 24 24'
                      stroke='currentColor'
                      stroke-width='1.5'
                    >
                      <path
                        stroke-linecap='round'
                        stroke-linejoin='round'
                        d='M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z'
                      />
                    </svg>
                  </span>
                  <span class='text-gray-800 font-medium'>
                    {folder}/
                  </span>
                  <span class='text-gray-400 ml-auto'>
                    {items.length} items
                  </span>
                </button>
              )
            })}
          </div>
        )}
    </div>
  )
}

export function Me() {
  const { user, switchTenant } = useApp()

  return (
    <div class='space-y-6'>
      <h2 class='text-lg font-semibold'>Me</h2>
      <div class='grid grid-cols-1 md:grid-cols-2 gap-6'>
        <AccountWidget
          email={user.email}
          isAdmin={user.isAdmin}
          tenantId={user.tenantId}
          onSwitchTenant={switchTenant}
        />
        <SlackWidget />
      </div>
      <StorageWidget tenantId={user.tenantId} />
      <MessagesWidget />
      <div class='border-t border-gray-200 pt-6 mt-8'>
        <div class='flex justify-center'>
          <form method='POST' action='/web/auth/logout'>
            <button
              type='submit'
              class='px-6 py-2 text-sm text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors'
            >
              Sign out
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
