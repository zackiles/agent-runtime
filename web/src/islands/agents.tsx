import { useEffect, useRef, useState } from 'preact/hooks'
import { api } from '../api.ts'
import { useApp } from '../context.ts'
import { CopyAgent } from './copy-agent.tsx'
import { MarkdownEditor } from '../components/editor.tsx'

type EdgeConfig = Record<string, unknown>

type Edge = {
  id?: number
  direction: 'consumes' | 'publishes'
  type: string
  config?: EdgeConfig
}

type Version = {
  version: string
  prompt: string | null
  createdAt: string
  active: boolean
}

type Agent = {
  id: string
  name: string
  slug: string
  status: string
  team?: string
  department?: string
  isLead?: boolean
  subsystem?: string
  sourceType?: string
  version?: string
  updatedAt?: string
  owner?: string
  createdBy?: string
  edges?: Edge[]
  versions?: Version[]
  prompt?: string
}

type Team = { id: string; name: string }
type Department = { id: string; name: string }

type View = 'list' | 'create' | 'edit'

type Form = {
  name: string
  subsystem: string
  version: string
  prompt: string
  team: string
  department: string
  isLead: boolean
  edges: Edge[]
}

type EdgeType = {
  value: string
  label: string
  icon: string
  hint: string
  defaults?: EdgeConfig
}

const INGRESS_TYPES: EdgeType[] = [
  {
    value: 'webhook',
    label: 'Webhook',
    icon: '\u{1F310}',
    hint: 'HTTP endpoint with a secure random URL',
  },
  {
    value: 'pubsub',
    label: 'Pub/Sub',
    icon: '\u{1F4E8}',
    hint: 'Subscribe to a GCP Pub/Sub topic',
    defaults: { topic: '' },
  },
  {
    value: 'cron',
    label: 'Cron',
    icon: '\u{23F0}',
    hint: 'Run on a recurring schedule',
    defaults: { schedule: '0 * * * *', timezone: 'UTC' },
  },
]

const EGRESS_TYPES: EdgeType[] = [
  {
    value: 'webhook',
    label: 'Webhook',
    icon: '\u{1F310}',
    hint: 'Call an external HTTP endpoint',
  },
  {
    value: 'pubsub',
    label: 'Pub/Sub',
    icon: '\u{1F4E8}',
    hint: 'Publish output to a GCP Pub/Sub topic',
    defaults: { topic: '' },
  },
  {
    value: 'gcs',
    label: 'Cloud Storage',
    icon: '\u{1F4BE}',
    hint: 'Write agent output to Cloud Storage',
    defaults: { prefix: '' },
  },
  {
    value: 'slack',
    label: 'Slack',
    icon: '\u{1F4AC}',
    hint: 'Send a message to Slack',
    defaults: { channel: '#' },
  },
]

const SCAFFOLD_PROMPT = `# {{name}}

You are **{{name}}**, an intelligent request processing agent.

## Role

Analyze incoming requests and provide structured, actionable responses.
Adapt your behavior based on the action specified in each request.

## Request Context

- **Caller**: {{request.headers.x-caller-id}}
- **Request ID**: {{request.headers.x-request-id}}
- **Action**: {{request.body.action}}

## Instructions

Based on the request action, handle the following:

### action: "query"
Search for and return relevant information about the topic
in \`{{request.body.topic}}\`.
Consider any filters provided in \`{{request.body.filters}}\`.

### action: "transform"
Apply the transformation described in \`{{request.body.operation}}\`
to the data provided in \`{{request.body.data}}\`.
Return the transformed result.

### action: "summarize"
Provide a concise summary of the content in \`{{request.body.content}}\`.
Target length: \`{{request.body.maxLength}}\` characters if specified.

### Default
For unrecognized actions, describe what was received and suggest
valid actions the caller can use.

## Response Format

Always return a JSON object:

\`\`\`json
{
  "result": { "...your response data..." },
  "action": "the action that was processed",
  "status": "success or error"
}
\`\`\`
`

const DOT_NOTATION_HELP = [
  ['{{request.body.fieldName}}', 'Top-level body field'],
  ['{{request.body.nested.deep.value}}', 'Deeply nested property'],
  ['{{request.body.items[0]}}', 'Array element by index'],
  ['{{request.headers.x-request-id}}', 'Request header value'],
]

function freshForm(): Form {
  return {
    name: '',
    subsystem: 'claude',
    version: '0.0.1',
    prompt: '',
    team: '',
    department: '',
    isLead: true,
    edges: [
      {
        direction: 'consumes',
        type: 'webhook',
        config: { id: crypto.randomUUID() },
      },
      {
        direction: 'publishes',
        type: 'webhook',
        config: { id: crypto.randomUUID() },
      },
    ],
  }
}

function scaffoldPrompt(name: string): string {
  return SCAFFOLD_PROMPT.replace(/\{\{name\}\}/g, name || 'My Agent')
}

function edgeLabel(edge: Edge): string {
  const cfg = edge.config || {}
  switch (edge.type) {
    case 'webhook':
      return cfg.id ? `webhook:${(cfg.id as string).slice(0, 8)}` : 'webhook'
    case 'pubsub':
      return cfg.topic ? `pubsub:${cfg.topic}` : 'pubsub'
    case 'cron':
      return cfg.schedule ? `cron:${cfg.schedule}` : 'cron'
    case 'gcs':
      return cfg.prefix ? `gcs:output/${cfg.prefix}` : 'gcs:output/'
    case 'slack':
      return cfg.channel ? `slack:${cfg.channel}` : 'slack'
    default:
      return edge.type
  }
}

function edgeSummary(edges: Edge[] | undefined, direction: string): string {
  if (!edges?.length) return '\u2014'
  const matching = edges.filter((e) => e.direction === direction)
  if (!matching.length) return '\u2014'
  return matching.map(edgeLabel).join(', ')
}

async function checkedJson<T>(res: Response): Promise<T> {
  let data: unknown
  try {
    data = await res.json()
  } catch {
    if (!res.ok) throw new Error(res.statusText || `HTTP ${res.status}`)
    throw new Error('Invalid JSON response')
  }
  if (!res.ok) {
    const msg = (data as { error?: string }).error || res.statusText
    throw new Error(msg)
  }
  return data as T
}

function formatDate(iso: string | undefined): string {
  if (!iso) return '\u2014'
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  } catch {
    return iso
  }
}

export function Agents(
  { scope }: { scope?: 'public' | 'private' } = {},
) {
  const { user } = useApp()
  const [agents, setAgents] = useState<Agent[]>([])
  const [teams, setTeams] = useState<Team[]>([])
  const [departments, setDepartments] = useState<Department[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [view, setView] = useState<View>('list')
  const [showCopy, setShowCopy] = useState(false)
  const [form, setForm] = useState<Form>(freshForm())
  const [editing, setEditing] = useState<Agent | null>(null)
  const [message, setMessage] = useState<
    { text: string; type: 'ok' | 'err' } | null
  >(null)
  const [saving, setSaving] = useState(false)

  const flashTimer = useRef<number>(0)
  function flash(text: string, type: 'ok' | 'err' = 'ok') {
    clearTimeout(flashTimer.current)
    setMessage({ text, type })
    flashTimer.current = setTimeout(
      () => setMessage(null),
      3000,
    ) as unknown as number
  }

  useEffect(() => {
    setLoading(true)
    const ctrl = new AbortController()
    const params = new URLSearchParams()
    if (scope === 'private') params.set('visibility', 'private')
    if (scope === 'public') params.set('visibility', 'public')
    const qs = params.toString()
    Promise.all([
      api(`/api/agents${qs ? `?${qs}` : ''}`)
        .then((r) => {
          if (!r.ok) throw new Error('Failed to load agents')
          return r.json() as Promise<Agent[]>
        }),
      api('/api/teams').then((r) => r.json() as Promise<Team[]>)
        .catch(() => []),
      api('/api/departments')
        .then((r) => r.json() as Promise<Department[]>)
        .catch(() => []),
    ])
      .then(([a, t, d]) => {
        if (ctrl.signal.aborted) return
        setAgents(a.map((ag) => ({
          ...ag,
          status: ag.status || 'draft',
        })))
        setTeams(t)
        setDepartments(d)
      })
      .catch(() => {})
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false)
      })
    return () => ctrl.abort()
  }, [scope])

  const filtered = agents.filter((a) => {
    if (
      search &&
      !a.name.toLowerCase().includes(search.toLowerCase()) &&
      !a.slug.toLowerCase().includes(search.toLowerCase())
    ) return false
    if (statusFilter && a.status !== statusFilter) return false
    return true
  })

  const deployed = agents.filter((a) => a.status === 'deployed').length
  const draft = agents.filter((a) => a.status === 'draft').length
  const stopped = agents.filter((a) => a.status === 'stopped').length
  const canWrite = scope !== 'public' || user.isAdmin

  function startCreate() {
    setForm(freshForm())
    setEditing(null)
    setView('create')
  }

  function startEdit(agent: Agent) {
    const active = agent.versions?.find((v) => v.active) ??
      agent.versions?.[0]
    setForm({
      name: agent.name,
      subsystem: agent.subsystem || 'claude',
      version: active?.version || agent.version || '0.0.1',
      prompt: active?.prompt || agent.prompt || '',
      team: agent.team || '',
      department: agent.department || '',
      isLead: agent.isLead ?? true,
      edges: agent.edges?.length
        ? agent.edges.map((e) => ({
          ...e,
          config: {
            ...(e.config || {}),
            ...(e.type === 'webhook' && !e.config?.id
              ? { id: crypto.randomUUID() }
              : {}),
          },
        }))
        : freshForm().edges,
    })
    setEditing(agent)
    setView('edit')
  }

  async function handleSave() {
    if (saving) return
    if (!form.name.trim()) return flash('Name is required.', 'err')
    if (!form.prompt.trim()) return flash('Prompt is required.', 'err')
    if (!form.subsystem) return flash('Subsystem is required.', 'err')

    for (const edge of form.edges) {
      const err = validateEdge(edge)
      if (err) {
        const label = edge.direction === 'consumes' ? 'Ingress' : 'Egress'
        return flash(
          `${label} (${edge.type}): ${err}`,
          'err',
        )
      }
    }

    setSaving(true)
    if (view === 'create') {
      try {
        const res = await api('/api/agents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: form.name,
            subsystem: form.subsystem,
            version: form.version,
            prompt: form.prompt,
            sourceType: 'prompt',
            team: form.team || undefined,
            department: form.department || undefined,
            isLead: form.isLead,
            edges: form.edges,
          }),
        })
        const created = await checkedJson<Agent>(res)
        setAgents((prev) => [...prev, {
          id: created.id,
          name: form.name,
          slug: created.slug ||
            form.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
          subsystem: form.subsystem,
          sourceType: 'prompt',
          status: 'draft',
          team: form.team || undefined,
          department: form.department || undefined,
          isLead: created.isLead ?? form.isLead,
          version: form.version,
          updatedAt: new Date().toISOString(),
          edges: form.edges,
        }])
        if (form.team && !teams.some((t) => t.name === form.team)) {
          setTeams((prev) => [
            ...prev,
            { id: `new-${Date.now()}`, name: form.team },
          ])
        }
        flash(`Agent "${form.name}" created.`)
      } catch (err) {
        flash(
          err instanceof Error ? err.message : 'Create failed.',
          'err',
        )
        setSaving(false)
        return
      }
    } else if (editing) {
      try {
        const res = await api(`/api/agents/${editing.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: form.name,
            subsystem: form.subsystem,
            prompt: form.prompt,
            team: form.team || undefined,
            department: form.department || undefined,
            edges: form.edges,
          }),
        })
        await checkedJson(res)
        setAgents((prev) =>
          prev.map((a) =>
            a.id === editing.id
              ? {
                ...a,
                name: form.name,
                subsystem: form.subsystem,
                version: form.version,
                prompt: form.prompt,
                team: form.team || undefined,
                department: form.department || undefined,
                isLead: form.isLead,
                edges: form.edges,
                updatedAt: new Date().toISOString(),
              }
              : a
          )
        )
        flash(`Agent "${form.name}" updated.`)
      } catch (err) {
        flash(
          err instanceof Error ? err.message : 'Update failed.',
          'err',
        )
        setSaving(false)
        return
      }
    }
    setSaving(false)
    setView('list')
  }

  async function handleDeploy(agent: Agent) {
    try {
      const res = await api(`/api/agents/${agent.id}/deploy`, {
        method: 'POST',
      })
      await checkedJson(res)
      setAgents((prev) =>
        prev.map((a) => a.id === agent.id ? { ...a, status: 'deployed' } : a)
      )
      flash(`Agent "${agent.name}" deploy triggered.`)
    } catch (err) {
      flash(
        err instanceof Error ? err.message : 'Deploy failed.',
        'err',
      )
    }
  }

  async function handleDelete(agent: Agent) {
    if (!confirm(`Delete agent "${agent.name}"?`)) return
    try {
      const res = await api(`/api/agents/${agent.id}`, {
        method: 'DELETE',
      })
      await checkedJson(res)
      setAgents((prev) => prev.filter((a) => a.id !== agent.id))
      flash(`Agent "${agent.name}" deleted.`)
    } catch (err) {
      flash(
        err instanceof Error ? err.message : 'Delete failed.',
        'err',
      )
    }
  }

  if (view === 'create' || view === 'edit') {
    return (
      <AgentForm
        form={form}
        setForm={setForm}
        onSave={handleSave}
        onCancel={() => setView('list')}
        title={view === 'create' ? 'Create Agent' : `Edit ${editing?.name}`}
        message={message}
        teams={teams}
        departments={departments}
        isCreate={view === 'create'}
        saving={saving}
      />
    )
  }

  return (
    <div class='space-y-6'>
      <div>
        <div class='flex items-center justify-between'>
          <h2 class='text-lg font-semibold'>Agents</h2>
          <div class='flex gap-2'>
            <button
              type='button'
              onClick={() => setShowCopy(!showCopy)}
              class={`px-4 py-2 text-sm rounded-lg transition-colors ${
                showCopy
                  ? 'bg-gray-200 text-gray-700'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              Copy Agent
            </button>
            {canWrite && (
              <button
                type='button'
                onClick={startCreate}
                class='px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 transition-colors'
              >
                New Agent
              </button>
            )}
          </div>
        </div>
        {agents.length > 0 && (
          <p class='text-xs text-gray-500 mt-1 ml-4'>
            {deployed} deployed &middot; {draft} draft &middot; {stopped}{' '}
            stopped
          </p>
        )}
      </div>

      {message && (
        <div
          class={`px-4 py-2 text-sm rounded-lg border ${
            message.type === 'ok'
              ? 'bg-green-50 text-green-700 border-green-200'
              : 'bg-red-50 text-red-700 border-red-200'
          }`}
        >
          {message.text}
        </div>
      )}

      <div class='flex flex-wrap gap-3'>
        <input
          type='text'
          placeholder='Search agents...'
          value={search}
          onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
          class='px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent w-64'
        />
        <select
          value={statusFilter}
          onChange={(e) =>
            setStatusFilter(
              (e.target as HTMLSelectElement).value,
            )}
          class='px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500'
        >
          <option value=''>All Status</option>
          <option value='deployed'>Deployed</option>
          <option value='stopped'>Stopped</option>
          <option value='draft'>Draft</option>
        </select>
      </div>

      {loading
        ? (
          <div class='text-center py-12 text-gray-400'>
            Loading agents...
          </div>
        )
        : filtered.length === 0
        ? (
          <div class='text-center py-12 text-gray-400'>
            {agents.length === 0
              ? 'No agents yet. Click "New Agent" to create one.'
              : 'No matching agents.'}
          </div>
        )
        : (
          <div class='space-y-3'>
            {filtered.map((agent) => (
              <div
                key={agent.id}
                class='bg-white border border-gray-200 rounded-xl overflow-hidden'
              >
                <button
                  type='button'
                  onClick={() =>
                    setExpanded(
                      expanded === agent.id ? null : agent.id,
                    )}
                  class='w-full flex items-center justify-between px-5 py-4 text-left hover:bg-gray-50 transition-colors'
                >
                  <div class='flex items-center gap-3'>
                    <span
                      class={`inline-block w-2 h-2 rounded-full shrink-0 ${
                        agent.status === 'deployed'
                          ? 'bg-green-500'
                          : agent.status === 'stopped'
                          ? 'bg-red-400'
                          : 'bg-gray-300'
                      }`}
                    />
                    <div>
                      <span class='font-medium text-gray-900'>
                        {agent.name}
                      </span>
                      <span class='ml-2 text-xs text-gray-400 font-mono'>
                        {agent.slug}
                      </span>
                    </div>
                  </div>
                  <div class='flex items-center gap-3'>
                    {agent.version && (
                      <span class='text-xs text-gray-400'>
                        v{agent.version}
                      </span>
                    )}
                    {agent.subsystem && (
                      <span class='text-xs text-gray-400 font-mono'>
                        {agent.subsystem}
                      </span>
                    )}
                    <span
                      class={`text-xs px-2 py-0.5 rounded-full font-medium ${
                        agent.status === 'deployed'
                          ? 'bg-green-50 text-green-700'
                          : agent.status === 'stopped'
                          ? 'bg-red-50 text-red-600'
                          : 'bg-gray-100 text-gray-500'
                      }`}
                    >
                      {agent.status}
                    </span>
                    <svg
                      class={`w-4 h-4 text-gray-400 transition-transform ${
                        expanded === agent.id ? 'rotate-180' : ''
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
                {expanded === agent.id && (
                  <div class='px-5 pb-4 pt-0 border-t border-gray-100'>
                    <dl class='grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-3 text-sm mt-4'>
                      <div>
                        <dt class='text-gray-500 text-xs'>
                          Subsystem
                        </dt>
                        <dd class='text-gray-900 mt-0.5'>
                          {agent.subsystem || '\u2014'}
                        </dd>
                      </div>
                      <div>
                        <dt class='text-gray-500 text-xs'>Team</dt>
                        <dd class='text-gray-900 mt-0.5'>
                          {agent.team || '\u2014'}
                        </dd>
                      </div>
                      <div>
                        <dt class='text-gray-500 text-xs'>
                          Department
                        </dt>
                        <dd class='text-gray-900 mt-0.5'>
                          {agent.department || '\u2014'}
                        </dd>
                      </div>
                      <div>
                        <dt class='text-gray-500 text-xs'>
                          Consumes From
                        </dt>
                        <dd class='text-gray-900 mt-0.5 font-mono text-xs'>
                          {edgeSummary(agent.edges, 'consumes')}
                        </dd>
                      </div>
                      <div>
                        <dt class='text-gray-500 text-xs'>
                          Publishes To
                        </dt>
                        <dd class='text-gray-900 mt-0.5 font-mono text-xs'>
                          {edgeSummary(agent.edges, 'publishes')}
                        </dd>
                      </div>
                      <div>
                        <dt class='text-gray-500 text-xs'>Updated</dt>
                        <dd class='text-gray-900 mt-0.5'>
                          {formatDate(agent.updatedAt)}
                        </dd>
                      </div>
                      {user.isAdmin && (
                        <div>
                          <dt class='text-gray-500 text-xs'>Owner</dt>
                          <dd class='text-gray-900 mt-0.5'>
                            <span class='text-xs px-2 py-0.5 bg-amber-50 text-amber-700 rounded-full'>
                              {agent.owner || agent.createdBy ||
                                '\u2014'}
                            </span>
                          </dd>
                        </div>
                      )}
                    </dl>
                    {canWrite && (
                      <div class='flex gap-2 mt-4'>
                        {agent.sourceType === 'prompt' && (
                          <button
                            type='button'
                            onClick={() => startEdit(agent)}
                            class='px-3 py-1.5 text-xs bg-gray-100 hover:bg-gray-200 rounded-md transition-colors'
                          >
                            Edit
                          </button>
                        )}
                        {agent.sourceType === 'prompt' && (
                          <button
                            type='button'
                            onClick={() => handleDeploy(agent)}
                            class='px-3 py-1.5 text-xs bg-blue-50 text-blue-700 hover:bg-blue-100 rounded-md transition-colors'
                          >
                            Deploy
                          </button>
                        )}
                        <button
                          type='button'
                          onClick={() => handleDelete(agent)}
                          class='px-3 py-1.5 text-xs bg-red-50 text-red-600 hover:bg-red-100 rounded-md transition-colors'
                        >
                          Delete
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

      {showCopy && (
        <div class='border-t border-gray-200 pt-6'>
          <CopyAgent />
        </div>
      )}
    </div>
  )
}

const CRON_PRESETS = [
  { label: 'Every hour', value: '0 * * * *' },
  { label: 'Every 6 hours', value: '0 */6 * * *' },
  { label: 'Daily at midnight', value: '0 0 * * *' },
  { label: 'Weekdays at 9 AM', value: '0 9 * * 1-5' },
  { label: 'Weekly (Sunday)', value: '0 0 * * 0' },
  { label: 'Monthly (1st)', value: '0 0 1 * *' },
]

const CRON_REGEX =
  /^(\*|[0-9,/-]+)\s+(\*|[0-9,/-]+)\s+(\*|[0-9,/-]+)\s+(\*|[0-9,/-]+)\s+(\*|[0-9,/-]+)$/

function validateEdge(edge: Edge): string | null {
  const cfg = edge.config || {}
  switch (edge.type) {
    case 'pubsub':
      if (!(cfg.topic as string)?.trim()) return 'Topic is required'
      if (/[^a-zA-Z0-9._-]/.test(cfg.topic as string)) {
        return 'Only letters, numbers, hyphens, dots, underscores'
      }
      return null
    case 'cron':
      if (!(cfg.schedule as string)?.trim()) return 'Schedule is required'
      if (!CRON_REGEX.test((cfg.schedule as string).trim())) {
        return 'Invalid cron (5 fields: min hour day month weekday)'
      }
      return null
    case 'gcs':
      return null
    case 'slack': {
      const ch = (cfg.channel as string)?.trim() || ''
      if (!ch) return 'Channel or user is required'
      if (!ch.startsWith('#') && !ch.startsWith('@')) {
        return 'Must start with # (channel) or @ (user)'
      }
      if (!/^[#@][a-z0-9._-]+$/.test(ch)) {
        return 'Only lowercase letters, numbers, dots, hyphens, underscores'
      }
      return null
    }
    default:
      return null
  }
}

function EdgeEditor({
  edges,
  onChange,
  agentSlug,
  tenantId,
}: {
  edges: Edge[]
  onChange: (edges: Edge[]) => void
  agentSlug: string
  tenantId: string
}) {
  const consumes = edges.filter((e) => e.direction === 'consumes')
  const publishes = edges.filter((e) => e.direction === 'publishes')

  function addEdge(
    direction: 'consumes' | 'publishes',
    typeDef: EdgeType,
  ) {
    const config = { ...(typeDef.defaults || {}) }
    if (typeDef.value === 'webhook') {
      config.id = crypto.randomUUID()
    }
    onChange([...edges, { direction, type: typeDef.value, config }])
  }

  function removeEdge(idx: number) {
    onChange(edges.filter((_, i) => i !== idx))
  }

  function updateConfig(idx: number, config: EdgeConfig) {
    onChange(
      edges.map((e, i) => (i === idx ? { ...e, config } : e)),
    )
  }

  return (
    <div class='grid grid-cols-1 md:grid-cols-2 gap-4'>
      <EdgeColumn
        title='Ingress'
        subtitle='Consumes From'
        direction='consumes'
        items={consumes}
        types={INGRESS_TYPES}
        allEdges={edges}
        onAdd={(t) => addEdge('consumes', t)}
        onRemove={removeEdge}
        onUpdateConfig={updateConfig}
        color='blue'
        agentSlug={agentSlug}
        tenantId={tenantId}
      />
      <EdgeColumn
        title='Egress'
        subtitle='Publishes To'
        direction='publishes'
        items={publishes}
        types={EGRESS_TYPES}
        allEdges={edges}
        onAdd={(t) => addEdge('publishes', t)}
        onRemove={removeEdge}
        onUpdateConfig={updateConfig}
        color='emerald'
        agentSlug={agentSlug}
        tenantId={tenantId}
      />
    </div>
  )
}

function EdgeColumn({
  title,
  subtitle,
  direction,
  items,
  types,
  allEdges,
  onAdd,
  onRemove,
  onUpdateConfig,
  color,
  agentSlug,
  tenantId,
}: {
  title: string
  subtitle: string
  direction: string
  items: Edge[]
  types: EdgeType[]
  allEdges: Edge[]
  onAdd: (t: EdgeType) => void
  onRemove: (idx: number) => void
  onUpdateConfig: (idx: number, config: EdgeConfig) => void
  color: 'blue' | 'emerald'
  agentSlug: string
  tenantId: string
}) {
  const [adding, setAdding] = useState(false)
  const accent = color === 'blue'
    ? {
      bg: 'bg-blue-50',
      border: 'border-blue-200',
      text: 'text-blue-700',
      dot: 'bg-blue-500',
    }
    : {
      bg: 'bg-emerald-50',
      border: 'border-emerald-200',
      text: 'text-emerald-700',
      dot: 'bg-emerald-500',
    }

  return (
    <div class={`rounded-xl border ${accent.border} ${accent.bg} p-4`}>
      <div class='flex items-center justify-between mb-3'>
        <div class='flex items-center gap-2'>
          <span class={`w-1.5 h-1.5 rounded-full ${accent.dot}`} />
          <div>
            <span
              class={`text-xs font-semibold uppercase tracking-wider ${accent.text}`}
            >
              {title}
            </span>
            <span class='text-xs text-gray-400 ml-1.5'>{subtitle}</span>
          </div>
        </div>
        <span class='text-xs text-gray-400'>
          {items.length} configured
        </span>
      </div>

      <div class='space-y-2 mb-3'>
        {items.map((edge) => {
          const globalIdx = allEdges.indexOf(edge)
          const typeDef = types.find((t) => t.value === edge.type)
          return (
            <EdgeCard
              key={globalIdx}
              edge={edge}
              idx={globalIdx}
              typeDef={typeDef}
              onRemove={onRemove}
              onUpdateConfig={onUpdateConfig}
              agentSlug={agentSlug}
              tenantId={tenantId}
            />
          )
        })}
      </div>

      {adding
        ? (
          <div class='bg-white rounded-lg border border-gray-200 p-3'>
            <p class='text-xs font-medium text-gray-600 mb-2'>
              Choose type
            </p>
            <div class='grid grid-cols-2 gap-1.5'>
              {types.map((t) => (
                <button
                  key={t.value}
                  type='button'
                  onClick={() => {
                    onAdd(t)
                    setAdding(false)
                  }}
                  class='flex items-center gap-2 px-3 py-2 rounded-md border border-gray-200 hover:border-gray-400 hover:bg-gray-50 transition-colors text-left'
                >
                  <span class='text-base leading-none'>{t.icon}</span>
                  <div class='min-w-0'>
                    <span class='text-xs font-medium text-gray-800 block'>
                      {t.label}
                    </span>
                    <span class='text-[10px] text-gray-400 block truncate'>
                      {t.hint}
                    </span>
                  </div>
                </button>
              ))}
            </div>
            <button
              type='button'
              onClick={() => setAdding(false)}
              class='mt-2 text-xs text-gray-400 hover:text-gray-600'
            >
              Cancel
            </button>
          </div>
        )
        : (
          <button
            type='button'
            onClick={() => setAdding(true)}
            class={`w-full py-2 rounded-lg border border-dashed ${accent.border} text-xs ${accent.text} hover:bg-white/60 transition-colors`}
          >
            + Add {direction === 'consumes' ? 'ingress' : 'egress'}
          </button>
        )}
    </div>
  )
}

function EdgeCard({
  edge,
  idx,
  typeDef,
  onRemove,
  onUpdateConfig,
  agentSlug,
  tenantId,
}: {
  edge: Edge
  idx: number
  typeDef: EdgeType | undefined
  onRemove: (idx: number) => void
  onUpdateConfig: (idx: number, config: EdgeConfig) => void
  agentSlug: string
  tenantId: string
}) {
  const cfg = edge.config || {}
  const error = validateEdge(edge)
  const [copied, setCopied] = useState(false)

  function copyUrl(url: string) {
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  const base = globalThis.location?.origin || ''
  const tenantSuffix = tenantId && tenantId !== 'development'
    ? `?tenant=${tenantId}`
    : ''
  const webhookUrl = `${base}/webhook/${cfg.id || 'pending'}${tenantSuffix}`

  const gcsBase = `${tenantId}/agents/${agentSlug || '{slug}'}/output/`
  const gcsPath = gcsBase + ((cfg.prefix as string) || '')

  return (
    <div
      class={`bg-white rounded-lg border ${
        error ? 'border-amber-300' : 'border-gray-200'
      } overflow-hidden`}
    >
      <div class='flex items-center justify-between px-3 py-2 border-b border-gray-100'>
        <div class='flex items-center gap-2'>
          <span class='text-sm leading-none'>
            {typeDef?.icon || '\u{1F517}'}
          </span>
          <span class='text-xs font-medium text-gray-800'>
            {typeDef?.label || edge.type}
          </span>
        </div>
        <button
          type='button'
          onClick={() => onRemove(idx)}
          class='text-gray-300 hover:text-red-500 transition-colors'
          title='Remove'
        >
          <svg
            class='w-3.5 h-3.5'
            fill='none'
            viewBox='0 0 24 24'
            stroke='currentColor'
            stroke-width='2'
          >
            <path
              stroke-linecap='round'
              stroke-linejoin='round'
              d='M6 18L18 6M6 6l12 12'
            />
          </svg>
        </button>
      </div>
      <div class='px-3 py-2.5'>
        {edge.type === 'webhook' && (
          <div class='space-y-1'>
            <div class='flex items-center gap-1.5'>
              <div class='flex-1 px-2 py-1.5 bg-gray-50 rounded-md text-[11px] font-mono text-gray-700 truncate select-all'>
                {webhookUrl}
              </div>
              <button
                type='button'
                onClick={() => copyUrl(webhookUrl)}
                class={`shrink-0 text-[10px] px-2 py-1 rounded-md border transition-colors ${
                  copied
                    ? 'bg-green-50 border-green-300 text-green-600'
                    : 'border-gray-200 text-gray-500 hover:border-gray-400'
                }`}
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <div class='flex items-center gap-1.5'>
              <span class='text-[10px] px-1.5 py-0.5 bg-green-50 text-green-600 rounded font-medium'>
                secure
              </span>
              <span class='text-[10px] text-gray-400'>
                Crypto-random UUID &mdash; POST JSON to invoke
              </span>
            </div>
          </div>
        )}

        {edge.type === 'pubsub' && (
          <div>
            <label class='text-[10px] font-medium text-gray-500 uppercase tracking-wider mb-1 block'>
              Topic name
            </label>
            <input
              type='text'
              value={(cfg.topic as string) || ''}
              onInput={(e) =>
                onUpdateConfig(idx, {
                  ...cfg,
                  topic: (e.target as HTMLInputElement).value,
                })}
              placeholder='e.g. orders, github-events'
              class={`w-full text-xs border rounded-md px-2.5 py-1.5 font-mono focus:outline-none focus:ring-1 focus:ring-blue-400 ${
                error ? 'border-amber-300' : 'border-gray-200'
              }`}
            />
          </div>
        )}

        {edge.type === 'cron' && (
          <div class='space-y-2'>
            <div>
              <label class='text-[10px] font-medium text-gray-500 uppercase tracking-wider mb-1 block'>
                Schedule
              </label>
              <div class='flex gap-1.5'>
                <input
                  type='text'
                  value={(cfg.schedule as string) || ''}
                  onInput={(e) =>
                    onUpdateConfig(idx, {
                      ...cfg,
                      schedule: (e.target as HTMLInputElement).value,
                    })}
                  placeholder='0 * * * *'
                  class={`flex-1 text-xs border rounded-md px-2.5 py-1.5 font-mono focus:outline-none focus:ring-1 focus:ring-blue-400 ${
                    error ? 'border-amber-300' : 'border-gray-200'
                  }`}
                />
                <select
                  value={(cfg.timezone as string) || 'UTC'}
                  onChange={(e) =>
                    onUpdateConfig(idx, {
                      ...cfg,
                      timezone: (e.target as HTMLSelectElement).value,
                    })}
                  class='text-xs border border-gray-200 rounded-md px-2 py-1.5 bg-white'
                >
                  <option value='UTC'>UTC</option>
                  <option value='America/Toronto'>Toronto</option>
                  <option value='America/New_York'>New York</option>
                  <option value='America/Chicago'>Chicago</option>
                  <option value='America/Denver'>Denver</option>
                  <option value='America/Los_Angeles'>LA</option>
                  <option value='Europe/London'>London</option>
                  <option value='Europe/Berlin'>Berlin</option>
                  <option value='Asia/Tokyo'>Tokyo</option>
                </select>
              </div>
            </div>
            <div class='flex flex-wrap gap-1'>
              {CRON_PRESETS.map((p) => (
                <button
                  key={p.value}
                  type='button'
                  onClick={() =>
                    onUpdateConfig(idx, { ...cfg, schedule: p.value })}
                  class={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
                    (cfg.schedule as string) === p.value
                      ? 'bg-blue-50 border-blue-300 text-blue-700 font-medium'
                      : 'border-gray-200 text-gray-500 hover:border-gray-400'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {edge.type === 'gcs' && (
          <div class='space-y-2'>
            <div class='px-2 py-1.5 bg-gray-50 rounded-md text-[11px] font-mono text-gray-600 truncate'>
              gs://.../{gcsPath}
            </div>
            <div>
              <label class='text-[10px] font-medium text-gray-500 uppercase tracking-wider mb-1 block'>
                Output prefix (optional)
              </label>
              <input
                type='text'
                value={(cfg.prefix as string) || ''}
                onInput={(e) =>
                  onUpdateConfig(idx, {
                    ...cfg,
                    prefix: (e.target as HTMLInputElement).value,
                  })}
                placeholder='e.g. daily/, reports/'
                class='w-full text-xs border border-gray-200 rounded-md px-2.5 py-1.5 font-mono focus:outline-none focus:ring-1 focus:ring-blue-400'
              />
            </div>
            <p class='text-[10px] text-gray-400'>
              Output is written to the system bucket under your agent's path.
              Browse files in Me &gt; Storage.
            </p>
          </div>
        )}

        {edge.type === 'slack' && (
          <div class='space-y-1.5'>
            <div>
              <label class='text-[10px] font-medium text-gray-500 uppercase tracking-wider mb-1 block'>
                Channel or user
              </label>
              <input
                type='text'
                value={(cfg.channel as string) || ''}
                onInput={(e) =>
                  onUpdateConfig(idx, {
                    ...cfg,
                    channel: (e.target as HTMLInputElement).value,
                  })}
                placeholder='#alerts'
                class={`w-full text-xs border rounded-md px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-400 ${
                  error ? 'border-amber-300' : 'border-gray-200'
                }`}
              />
            </div>
            <p class='text-[10px] text-gray-400'>
              Use <span class='font-mono'>#channel</span> or{' '}
              <span class='font-mono'>@user</span>. The bot must be invited to
              the channel first.
            </p>
          </div>
        )}

        {error && <p class='text-[10px] text-amber-600 mt-1.5'>{error}</p>}
      </div>
    </div>
  )
}

function ComboBox({
  value,
  onChange,
  options,
  placeholder,
  label,
}: {
  value: string
  onChange: (v: string) => void
  options: string[]
  placeholder: string
  label: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (
        ref.current && !ref.current.contains(e.target as Node)
      ) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const term = (open ? query : value).toLowerCase()
  const filtered = term
    ? options.filter((o) => o.toLowerCase().includes(term))
    : options
  const showCreate = query &&
    !options.some((o) => o.toLowerCase() === query.toLowerCase())

  return (
    <div ref={ref} class='relative'>
      <label class='block text-sm font-medium text-gray-700 mb-1'>
        {label}
      </label>
      <input
        type='text'
        value={open ? query : value}
        onFocus={() => {
          setOpen(true)
          setQuery(value)
        }}
        onInput={(e) => {
          const v = (e.target as HTMLInputElement).value
          setQuery(v)
          onChange(v)
        }}
        placeholder={placeholder}
        class='w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent'
      />
      {open && (filtered.length > 0 || showCreate) && (
        <div class='absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto'>
          {filtered.map((o) => (
            <button
              key={o}
              type='button'
              onClick={() => {
                onChange(o)
                setQuery(o)
                setOpen(false)
              }}
              class={`w-full text-left px-3 py-2 text-sm hover:bg-blue-50 ${
                o === value ? 'bg-blue-50 text-blue-700 font-medium' : ''
              }`}
            >
              {o}
            </button>
          ))}
          {showCreate && (
            <button
              type='button'
              onClick={() => {
                onChange(query)
                setOpen(false)
              }}
              class='w-full text-left px-3 py-2 text-sm text-blue-600 hover:bg-blue-50 border-t border-gray-100'
            >
              Create "{query}"
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function AgentForm({
  form,
  setForm,
  onSave,
  onCancel,
  title,
  message,
  teams,
  departments,
  isCreate,
  saving,
}: {
  form: Form
  setForm: (fn: Form | ((prev: Form) => Form)) => void
  onSave: () => void
  onCancel: () => void
  title: string
  message: { text: string; type: 'ok' | 'err' } | null
  teams: Team[]
  departments: Department[]
  isCreate: boolean
  saving: boolean
}) {
  const { user } = useApp()
  const [showHelp, setShowHelp] = useState(false)
  const [scaffolded, setScaffolded] = useState(false)
  const teamNames = teams.map((t) => t.name)
  const deptNames = departments.map((d) => d.name)
  const agentSlug = form.name.trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

  function handleNameBlur() {
    if (!isCreate || scaffolded || form.prompt) return
    if (!form.name.trim()) return
    setForm((p) => ({ ...p, prompt: scaffoldPrompt(p.name) }))
    setScaffolded(true)
  }

  return (
    <div class='space-y-6'>
      <div class='flex items-center justify-between'>
        <h2 class='text-lg font-semibold'>{title}</h2>
        <button
          type='button'
          onClick={onCancel}
          class='text-sm text-gray-500 hover:text-gray-700'
        >
          Cancel
        </button>
      </div>

      {message && (
        <div
          class={`px-4 py-2 text-sm rounded-lg border ${
            message.type === 'ok'
              ? 'bg-green-50 text-green-700 border-green-200'
              : 'bg-red-50 text-red-700 border-red-200'
          }`}
        >
          {message.text}
        </div>
      )}

      <div class='grid grid-cols-1 md:grid-cols-3 gap-4'>
        <div>
          <label class='block text-sm font-medium text-gray-700 mb-1'>
            Agent Name
          </label>
          <input
            type='text'
            value={form.name}
            onInput={(e) =>
              setForm((p) => ({
                ...p,
                name: (e.target as HTMLInputElement).value,
              }))}
            onBlur={handleNameBlur}
            placeholder='my-agent'
            class='w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent'
          />
          {isCreate && !form.prompt && form.name.trim() && (
            <p class='text-xs text-gray-400 mt-1'>
              A starter prompt will be scaffolded on blur
            </p>
          )}
        </div>
        <div>
          <label class='block text-sm font-medium text-gray-700 mb-1'>
            Subsystem
          </label>
          <select
            value={form.subsystem}
            onChange={(e) =>
              setForm((p) => ({
                ...p,
                subsystem: (e.target as HTMLSelectElement).value,
              }))}
            class='w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500'
          >
            <option value='claude'>Claude</option>
            <option value='cursor'>Cursor</option>
          </select>
        </div>
        <div>
          <label class='block text-sm font-medium text-gray-700 mb-1'>
            Version
          </label>
          <input
            type='text'
            value={form.version}
            onInput={(e) =>
              setForm((p) => ({
                ...p,
                version: (e.target as HTMLInputElement).value,
              }))}
            placeholder='0.0.1'
            class='w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent'
          />
        </div>
      </div>

      <div class='grid grid-cols-1 md:grid-cols-3 gap-4'>
        <ComboBox
          value={form.team}
          onChange={(v) => setForm((p) => ({ ...p, team: v }))}
          options={teamNames}
          placeholder='Select or create a team'
          label='Team'
        />
        <ComboBox
          value={form.department}
          onChange={(v) => setForm((p) => ({ ...p, department: v }))}
          options={deptNames}
          placeholder='Select a department'
          label='Department'
        />
        <div class='flex items-end pb-2'>
          <label class='flex items-center gap-2 cursor-pointer'>
            <input
              type='checkbox'
              checked={form.isLead}
              onChange={(e) =>
                setForm((p) => ({
                  ...p,
                  isLead: (e.target as HTMLInputElement).checked,
                }))}
              class='w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500'
            />
            <span class='text-sm font-medium text-gray-700'>
              Lead Agent
            </span>
          </label>
          <span class='ml-2 text-xs text-gray-400'>
            Can invoke sub-agents
          </span>
        </div>
      </div>

      <EdgeEditor
        edges={form.edges}
        onChange={(edges) => setForm((p) => ({ ...p, edges }))}
        agentSlug={agentSlug}
        tenantId={user.tenantId}
      />

      <div>
        <div class='flex items-center justify-between mb-2'>
          <label class='block text-sm font-medium text-gray-700'>
            Prompt
          </label>
          <button
            type='button'
            onClick={() => setShowHelp(!showHelp)}
            class='text-xs text-blue-600 hover:text-blue-800'
          >
            {showHelp ? 'Hide' : 'Show'} template variables
          </button>
        </div>
        {showHelp && (
          <div class='mb-3 p-3 bg-gray-50 rounded-lg border border-gray-200 text-xs'>
            <p class='font-medium text-gray-700 mb-2'>
              Dot Notation Template Variables
            </p>
            <p class='text-gray-500 mb-2'>
              Use these in your prompt to inject request values at runtime.
            </p>
            <table class='w-full'>
              <tbody>
                {DOT_NOTATION_HELP.map(([variable, desc]) => (
                  <tr key={variable}>
                    <td class='pr-4 py-0.5 font-mono text-blue-700'>
                      {variable}
                    </td>
                    <td class='text-gray-500'>{desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <MarkdownEditor
          value={form.prompt}
          onChange={(v) => setForm((p) => ({ ...p, prompt: v }))}
          placeholder='Start writing your agent prompt...'
        />
      </div>

      <div class='flex gap-3'>
        <button
          type='button'
          onClick={onSave}
          disabled={saving}
          class={`px-5 py-2 text-white text-sm rounded-lg transition-colors ${
            saving
              ? 'bg-blue-400 cursor-not-allowed'
              : 'bg-blue-600 hover:bg-blue-700'
          }`}
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button
          type='button'
          onClick={onCancel}
          class='px-5 py-2 bg-gray-100 text-gray-700 text-sm rounded-lg hover:bg-gray-200 transition-colors'
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
