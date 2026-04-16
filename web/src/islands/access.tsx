import { useEffect, useState } from 'preact/hooks'
import { api } from '../api.ts'
import { useApp } from '../context.ts'

type AccessGrant = {
  id: string
  resource: string
  scope: string
  status: 'pending' | 'configured' | 'error'
  demoUrl?: string
  instructions?: string
  secrets?: string[]
  createdBy: string
  createdAt: string
  updatedAt: string
}

type View = 'list' | 'request' | 'callback'

type RequestForm = {
  resource: string
  description: string
  scope: 'private' | 'public'
}

type CallbackForm = {
  context: string
}

const EMPTY_REQUEST: RequestForm = {
  resource: '',
  description: '',
  scope: 'private',
}

const COMMON_RESOURCES = [
  { name: 'Google Drive', slug: 'google-drive', type: 'OAuth' },
  { name: 'GitHub', slug: 'github', type: 'OAuth' },
  { name: 'Slack', slug: 'slack', type: 'OAuth' },
  { name: 'OpenAI', slug: 'openai', type: 'API Key' },
  { name: 'Anthropic', slug: 'anthropic', type: 'API Key' },
  { name: 'AWS', slug: 'aws', type: 'Multi-Secret' },
  { name: 'Stripe', slug: 'stripe', type: 'API Key' },
  { name: 'Datadog', slug: 'datadog', type: 'API Key' },
  { name: 'Auth0', slug: 'auth0', type: 'OAuth' },
  { name: 'Custom', slug: '', type: 'Custom' },
]

async function checkedJson<T>(res: Response): Promise<T> {
  const data = await res.json()
  if (!res.ok) {
    const msg = (data as { error?: string }).error || res.statusText
    throw new Error(msg)
  }
  return data as T
}

export function Access() {
  const { user } = useApp()
  const [grants, setGrants] = useState<AccessGrant[]>([])
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<View>('list')
  const [form, setForm] = useState<RequestForm>({ ...EMPTY_REQUEST })
  const [callbackForm, setCallbackForm] = useState<CallbackForm>({
    context: '',
  })
  const [activeGrant, setActiveGrant] = useState<AccessGrant | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [message, setMessage] = useState<
    { text: string; type: 'ok' | 'err' } | null
  >(null)
  const [submitting, setSubmitting] = useState(false)

  function flash(text: string, type: 'ok' | 'err' = 'ok') {
    setMessage({ text, type })
    setTimeout(() => setMessage(null), 4000)
  }

  function reload() {
    setLoading(true)
    api('/api/access')
      .then((r) => checkedJson<AccessGrant[]>(r))
      .then(setGrants)
      .catch(() => setGrants([]))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    reload()
  }, [])

  function startRequest() {
    setForm({ ...EMPTY_REQUEST })
    setView('request')
  }

  function selectResource(slug: string, name: string) {
    setForm((prev) => ({
      ...prev,
      resource: slug || prev.resource,
      description: slug ? `Connect ${name} to the runtime` : prev.description,
    }))
  }

  function startCallback(grant: AccessGrant) {
    setActiveGrant(grant)
    setCallbackForm({ context: '' })
    setView('callback')
  }

  async function handleRequest() {
    if (!form.resource.trim()) return flash('Resource is required.', 'err')
    setSubmitting(true)
    try {
      const res = await api('/api/access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const grant = await checkedJson<AccessGrant>(res)
      setGrants((prev) => [...prev, grant])
      flash('Access request created. Follow the instructions to continue.')
      setView('list')
      setExpanded(grant.id)
    } catch (err) {
      flash(
        err instanceof Error ? err.message : 'Request failed.',
        'err',
      )
    } finally {
      setSubmitting(false)
    }
  }

  async function handleCallback() {
    if (!callbackForm.context.trim()) {
      return flash('Context string is required.', 'err')
    }
    setSubmitting(true)
    try {
      const res = await api('/api/access/callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context: callbackForm.context }),
      })
      const result = await checkedJson<{
        status: string
        secrets: string[]
      }>(res)
      flash(
        `Access configured. ${result.secrets.length} secret(s) stored.`,
      )
      setView('list')
      reload()
    } catch (err) {
      flash(
        err instanceof Error ? err.message : 'Callback failed.',
        'err',
      )
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete(grant: AccessGrant) {
    if (!confirm(`Delete access grant for "${grant.resource}"?`)) return
    try {
      await checkedJson(
        await api(`/api/access/${grant.id}`, { method: 'DELETE' }),
      )
      setGrants((prev) => prev.filter((g) => g.id !== grant.id))
      flash('Access grant deleted.')
    } catch (err) {
      flash(
        err instanceof Error ? err.message : 'Delete failed.',
        'err',
      )
    }
  }

  const configured = grants.filter((g) => g.status === 'configured').length
  const pending = grants.filter((g) => g.status === 'pending').length

  if (view === 'request') {
    return (
      <div class='space-y-6'>
        <div class='flex items-center justify-between'>
          <h2 class='text-lg font-semibold'>Request Access</h2>
          <button
            type='button'
            onClick={() => setView('list')}
            class='text-sm text-gray-500 hover:text-gray-700'
          >
            Cancel
          </button>
        </div>

        {message && <Flash text={message.text} type={message.type} />}

        <div>
          <label class='block text-sm font-medium text-gray-700 mb-2'>
            Common Resources
          </label>
          <div class='grid grid-cols-2 sm:grid-cols-5 gap-2'>
            {COMMON_RESOURCES.map((r) => (
              <button
                key={r.slug || 'custom'}
                type='button'
                onClick={() => selectResource(r.slug, r.name)}
                class={`px-3 py-2 text-xs rounded-lg border transition-colors text-left ${
                  form.resource === r.slug
                    ? 'border-blue-500 bg-blue-50 text-blue-700'
                    : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                }`}
              >
                <span class='font-medium block'>{r.name}</span>
                <span class='text-gray-400'>{r.type}</span>
              </button>
            ))}
          </div>
        </div>

        <div class='grid grid-cols-1 md:grid-cols-2 gap-4'>
          <div>
            <label class='block text-sm font-medium text-gray-700 mb-1'>
              Resource
            </label>
            <input
              type='text'
              value={form.resource}
              onInput={(e) =>
                setForm((p) => ({
                  ...p,
                  resource: (e.target as HTMLInputElement).value,
                }))}
              placeholder='e.g. google-drive, openai, custom-api'
              class='w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent'
            />
          </div>
          <div>
            <label class='block text-sm font-medium text-gray-700 mb-1'>
              Scope
            </label>
            <select
              value={form.scope}
              onChange={(e) =>
                setForm((p) => ({
                  ...p,
                  scope: (e.target as HTMLSelectElement).value as
                    | 'private'
                    | 'public',
                }))}
              class='w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500'
            >
              <option value='private'>Private (my registry only)</option>
              {user.isAdmin && (
                <option value='public'>
                  Public (all users, admin only)
                </option>
              )}
            </select>
          </div>
        </div>

        <div>
          <label class='block text-sm font-medium text-gray-700 mb-1'>
            Description
          </label>
          <textarea
            value={form.description}
            onInput={(e) =>
              setForm((p) => ({
                ...p,
                description: (e.target as HTMLTextAreaElement).value,
              }))}
            rows={4}
            placeholder='Describe what you need access to and how it will be used...'
            class='w-full px-4 py-3 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-y'
          />
        </div>

        <div class='flex gap-3'>
          <button
            type='button'
            onClick={handleRequest}
            disabled={submitting}
            class={`px-5 py-2 text-white text-sm rounded-lg transition-colors ${
              submitting
                ? 'bg-gray-400 cursor-not-allowed'
                : 'bg-blue-600 hover:bg-blue-700'
            }`}
          >
            {submitting ? 'Working...' : 'Request Access'}
          </button>
          <button
            type='button'
            onClick={() => setView('list')}
            class='px-5 py-2 bg-gray-100 text-gray-700 text-sm rounded-lg hover:bg-gray-200 transition-colors'
          >
            Cancel
          </button>
        </div>
      </div>
    )
  }

  if (view === 'callback') {
    return (
      <div class='space-y-6'>
        <div class='flex items-center justify-between'>
          <h2 class='text-lg font-semibold'>
            Complete Setup: {activeGrant?.resource}
          </h2>
          <button
            type='button'
            onClick={() => setView('list')}
            class='text-sm text-gray-500 hover:text-gray-700'
          >
            Cancel
          </button>
        </div>

        {message && <Flash text={message.text} type={message.type} />}

        <div class='bg-blue-50 border border-blue-200 rounded-lg p-4'>
          <p class='text-sm text-blue-800 font-medium mb-1'>
            Step 2: Paste the context string
          </p>
          <p class='text-xs text-blue-600'>
            After completing the access UI, copy the base64 context string it
            generated and paste it below. This will configure your secrets and
            finalize the access setup.
          </p>
        </div>

        <div>
          <label class='block text-sm font-medium text-gray-700 mb-1'>
            Context String
          </label>
          <textarea
            value={callbackForm.context}
            onInput={(e) =>
              setCallbackForm({
                context: (e.target as HTMLTextAreaElement).value,
              })}
            rows={6}
            placeholder='Paste the base64 context string from the access UI here...'
            class='w-full px-4 py-3 text-sm font-mono border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-y'
          />
        </div>

        <div class='flex gap-3'>
          <button
            type='button'
            onClick={handleCallback}
            disabled={submitting}
            class={`px-5 py-2 text-white text-sm rounded-lg transition-colors ${
              submitting
                ? 'bg-gray-400 cursor-not-allowed'
                : 'bg-green-600 hover:bg-green-700'
            }`}
          >
            {submitting ? 'Configuring...' : 'Complete Setup'}
          </button>
          <button
            type='button'
            onClick={() => setView('list')}
            class='px-5 py-2 bg-gray-100 text-gray-700 text-sm rounded-lg hover:bg-gray-200 transition-colors'
          >
            Cancel
          </button>
        </div>
      </div>
    )
  }

  return (
    <div class='space-y-6'>
      <div>
        <div class='flex items-center justify-between'>
          <div class='flex items-center gap-2'>
            <h2 class='text-lg font-semibold'>
              {user.isAdmin ? 'All Access Grants' : 'Access Setup'}
            </h2>
          </div>
          <button
            type='button'
            onClick={startRequest}
            class='px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 transition-colors'
          >
            Request Access
          </button>
        </div>
        {grants.length > 0 && (
          <p class='text-xs text-gray-500 mt-1 ml-4'>
            {grants.length} grants &middot; {configured} configured &middot;
            {' '}
            {pending} pending
          </p>
        )}
      </div>

      {message && <Flash text={message.text} type={message.type} />}

      {loading
        ? (
          <div class='text-center py-12 text-gray-400'>
            Loading access grants...
          </div>
        )
        : grants.length === 0
        ? (
          <div class='text-center py-12'>
            <p class='text-gray-400 mb-2'>No access grants yet.</p>
            <p class='text-sm text-gray-400'>
              Request access to apps, data sources, and services to configure
              your runtime.
            </p>
          </div>
        )
        : (
          <div class='space-y-3'>
            {grants.map((grant) => (
              <GrantCard
                key={grant.id}
                grant={grant}
                expanded={expanded === grant.id}
                onToggle={() =>
                  setExpanded(expanded === grant.id ? null : grant.id)}
                onCallback={() => startCallback(grant)}
                onDelete={() => handleDelete(grant)}
              />
            ))}
          </div>
        )}

      <div class='bg-gray-50 border border-gray-200 rounded-xl p-5'>
        <h3 class='text-sm font-semibold text-gray-700 mb-3'>
          How Access Setup Works
        </h3>
        <div class='grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs text-gray-600'>
          <div class='flex gap-2'>
            <span class='flex-shrink-0 w-6 h-6 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center font-bold text-xs'>
              1
            </span>
            <div>
              <p class='font-medium text-gray-700'>Request</p>
              <p>
                Describe what resource you need access to. The agent builds a
                custom UI for your specific setup.
              </p>
            </div>
          </div>
          <div class='flex gap-2'>
            <span class='flex-shrink-0 w-6 h-6 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center font-bold text-xs'>
              2
            </span>
            <div>
              <p class='font-medium text-gray-700'>Complete UI</p>
              <p>
                Follow the generated UI to enter credentials, authorize OAuth
                flows, or upload config files.
              </p>
            </div>
          </div>
          <div class='flex gap-2'>
            <span class='flex-shrink-0 w-6 h-6 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center font-bold text-xs'>
              3
            </span>
            <div>
              <p class='font-medium text-gray-700'>Finalize</p>
              <p>
                Paste the context string back here. Your secrets are stored and
                access is configured.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function Flash({
  text,
  type,
}: {
  text: string
  type: 'ok' | 'err'
}) {
  return (
    <div
      class={`px-4 py-2 text-sm rounded-lg border ${
        type === 'ok'
          ? 'bg-green-50 text-green-700 border-green-200'
          : 'bg-red-50 text-red-700 border-red-200'
      }`}
    >
      {text}
    </div>
  )
}

function GrantCard({
  grant,
  expanded,
  onToggle,
  onCallback,
  onDelete,
}: {
  grant: AccessGrant
  expanded: boolean
  onToggle: () => void
  onCallback: () => void
  onDelete: () => void
}) {
  const statusColor = grant.status === 'configured'
    ? 'bg-green-50 text-green-700'
    : grant.status === 'error'
    ? 'bg-red-50 text-red-600'
    : 'bg-yellow-50 text-yellow-700'

  const dotColor = grant.status === 'configured'
    ? 'bg-green-500'
    : grant.status === 'error'
    ? 'bg-red-400'
    : 'bg-yellow-400'

  return (
    <div class='bg-white border border-gray-200 rounded-xl overflow-hidden'>
      <button
        type='button'
        onClick={onToggle}
        class='w-full flex items-center justify-between px-5 py-4 text-left hover:bg-gray-50 transition-colors'
      >
        <div class='flex items-center gap-3'>
          <span
            class={`inline-block w-2 h-2 rounded-full shrink-0 ${dotColor}`}
          />
          <div>
            <span class='font-medium text-gray-900'>{grant.resource}</span>
            <span class='ml-2 text-xs text-gray-400'>
              {grant.scope}
            </span>
          </div>
        </div>
        <div class='flex items-center gap-3'>
          <span
            class={`text-xs px-2 py-0.5 rounded-full font-medium ${statusColor}`}
          >
            {grant.status}
          </span>
          <svg
            class={`w-4 h-4 text-gray-400 transition-transform ${
              expanded ? 'rotate-180' : ''
            }`}
            fill='none'
            viewBox='0 0 24 24'
            stroke='currentColor'
            stroke-width='2'
          >
            <path
              stroke-linecap='round'
              stroke-linejoin='round'
              d='M19 9l-7 7-7-7'
            />
          </svg>
        </div>
      </button>
      {expanded && (
        <div class='px-5 pb-4 pt-0 border-t border-gray-100'>
          <dl class='grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-3 text-sm mt-4 mb-4'>
            <div>
              <dt class='text-gray-500 text-xs'>Status</dt>
              <dd class='text-gray-900 mt-0.5'>{grant.status}</dd>
            </div>
            <div>
              <dt class='text-gray-500 text-xs'>Scope</dt>
              <dd class='text-gray-900 mt-0.5'>{grant.scope}</dd>
            </div>
            <div>
              <dt class='text-gray-500 text-xs'>Created</dt>
              <dd class='text-gray-900 mt-0.5'>
                {new Date(grant.createdAt).toLocaleDateString()}
              </dd>
            </div>
            <div>
              <dt class='text-gray-500 text-xs'>Updated</dt>
              <dd class='text-gray-900 mt-0.5'>
                {new Date(grant.updatedAt).toLocaleDateString()}
              </dd>
            </div>
          </dl>

          {grant.instructions && (
            <div class='mb-4 p-3 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-800'>
              {grant.instructions}
            </div>
          )}

          {grant.demoUrl && (
            <div class='mb-4'>
              <a
                href={grant.demoUrl}
                target='_blank'
                rel='noopener noreferrer'
                class='text-sm text-blue-600 hover:underline'
              >
                Open Access UI
              </a>
            </div>
          )}

          {grant.secrets && grant.secrets.length > 0 && (
            <div class='mb-4'>
              <p class='text-xs text-gray-500 mb-1'>Configured Secrets</p>
              <div class='flex flex-wrap gap-1'>
                {grant.secrets.map((s) => (
                  <span
                    key={s}
                    class='px-2 py-0.5 bg-gray-100 text-gray-600 text-xs rounded font-mono'
                  >
                    {s}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div class='flex gap-2'>
            {grant.status === 'pending' && (
              <button
                type='button'
                onClick={onCallback}
                class='px-3 py-1.5 text-xs bg-green-50 text-green-700 hover:bg-green-100 rounded-md transition-colors'
              >
                Complete Setup
              </button>
            )}
            <button
              type='button'
              onClick={onDelete}
              class='px-3 py-1.5 text-xs bg-red-50 text-red-600 hover:bg-red-100 rounded-md transition-colors'
            >
              Delete
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
