import { useEffect, useRef, useState } from 'preact/hooks'
import { api } from '../api.ts'
import { Agents } from './agents.tsx'
import { EntityForm } from '../components/entity-form.tsx'
import type { EntityData, EntityType } from '../components/entity-form.tsx'

type RegistryItem = {
  id: string
  name: string
  slug: string
  visibility: string
  ownerId?: string
  createdBy?: string
  version?: string
  content?: string
  config?: Record<string, unknown>
}

type Promotable = {
  type: string
  slug: string
  name: string
}

type StatusData = {
  tenantId: string
  email: string
  isAdmin: boolean
  public: {
    agents: RegistryItem[]
    tools: RegistryItem[]
    skills: RegistryItem[]
    rules: RegistryItem[]
  }
  private?: {
    agents: RegistryItem[]
    tools: RegistryItem[]
    skills: RegistryItem[]
    rules: RegistryItem[]
  }
  promotable: Promotable[]
}

type EntityTab =
  | 'all'
  | 'agents'
  | 'tools'
  | 'skills'
  | 'rules'
  | 'promotable'

type TaggedItem = RegistryItem & { entityType: string }

type EditState = {
  type: EntityType
  item?: RegistryItem
}

function Section({
  items,
  type,
  expanded,
  onToggle,
  onEdit,
  onDelete,
  loadingId,
}: {
  items: RegistryItem[]
  type: string
  expanded: string | null
  onToggle: (id: string) => void
  onEdit?: (item: RegistryItem, entityType: string) => void
  onDelete?: (item: RegistryItem, entityType: string) => void
  loadingId?: string | null
}) {
  if (items.length === 0) {
    const label = type === 'mixed' ? 'items' : `${type}s`
    return (
      <div class='py-8 text-center'>
        <p class='text-sm text-gray-400'>No {label} yet</p>
        {type !== 'mixed' && (
          <p class='text-xs text-gray-300 mt-1'>
            Create one using the button above or{' '}
            <span class='font-mono'>ar {type} create</span>
          </p>
        )}
      </div>
    )
  }

  return (
    <div class='border border-gray-200 rounded-lg divide-y divide-gray-100'>
      {items.map((item) => {
        const itemType = (item as TaggedItem).entityType || type
        return (
          <div key={item.id}>
            <button
              type='button'
              onClick={() => onToggle(item.id)}
              class='w-full flex items-center justify-between px-4 py-2 text-sm text-left hover:bg-gray-50 transition-colors'
            >
              <div class='flex items-center gap-2'>
                <span class='font-mono text-xs bg-gray-100 px-1.5 py-0.5 rounded'>
                  {itemType}
                </span>
                <span class='font-medium text-gray-900'>
                  {item.name}
                </span>
                <span class='text-gray-400 text-xs'>{item.slug}</span>
              </div>
              <div class='flex items-center gap-3 text-xs'>
                {item.version && (
                  <span class='text-gray-400'>v{item.version}</span>
                )}
                <span class='text-gray-500'>
                  {item.ownerId || item.createdBy}
                </span>
                <svg
                  class={`w-3 h-3 text-gray-400 transition-transform ${
                    expanded === item.id ? 'rotate-180' : ''
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
            {expanded === item.id && (
              <div class='px-4 pb-3 border-t border-gray-100'>
                <dl class='grid grid-cols-3 gap-x-6 gap-y-2 text-sm mt-3'>
                  <div>
                    <dt class='text-gray-500 text-xs'>Version</dt>
                    <dd class='text-gray-900 mt-0.5'>
                      {item.version || '\u2014'}
                    </dd>
                  </div>
                  <div>
                    <dt class='text-gray-500 text-xs'>Owner</dt>
                    <dd class='text-gray-900 mt-0.5'>
                      {item.ownerId || item.createdBy || '\u2014'}
                    </dd>
                  </div>
                  <div>
                    <dt class='text-gray-500 text-xs'>Visibility</dt>
                    <dd class='text-gray-900 mt-0.5'>
                      {item.visibility}
                    </dd>
                  </div>
                </dl>
                {(onEdit || onDelete) && (
                  <div class='flex gap-2 mt-3 pt-3 border-t border-gray-100'>
                    {onEdit && (
                      <button
                        type='button'
                        onClick={() => onEdit(item, itemType)}
                        disabled={loadingId === item.id}
                        class={`px-3 py-1 text-xs rounded border transition-colors ${
                          loadingId === item.id
                            ? 'bg-blue-100 text-blue-400 border-blue-200 cursor-wait'
                            : 'bg-blue-50 text-blue-600 border-blue-200 hover:bg-blue-100'
                        }`}
                      >
                        {loadingId === item.id ? 'Loading...' : 'Edit'}
                      </button>
                    )}
                    {onDelete && (
                      <button
                        type='button'
                        onClick={() => onDelete(item, itemType)}
                        class='px-3 py-1 text-xs bg-red-50 text-red-600 rounded hover:bg-red-100 border border-red-200 transition-colors'
                      >
                        Delete
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export function RegistryStatus() {
  const [data, setData] = useState<StatusData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<EntityTab>('agents')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [scope, setScope] = useState<'public' | 'private'>('public')
  const [editing, setEditing] = useState<EditState | null>(null)
  const [editLoading, setEditLoading] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [importUrl, setImportUrl] = useState('')
  const [importLoading, setImportLoading] = useState(false)
  const [message, setMessage] = useState<
    { text: string; type: 'ok' | 'err' } | null
  >(null)

  const flashTimer = useRef<number>(0)
  function flash(text: string, type: 'ok' | 'err' = 'ok') {
    clearTimeout(flashTimer.current)
    setMessage({ text, type })
    flashTimer.current = setTimeout(
      () => setMessage(null),
      4000,
    ) as unknown as number
  }

  async function load() {
    setLoading(true)
    setError('')
    try {
      const res = await api('/api/registry/status')
      if (!res.ok) {
        setError('Failed to load registry status')
        return
      }
      setData(await res.json())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Load failed')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  function toggleExpand(id: string) {
    setExpanded(expanded === id ? null : id)
  }

  async function handleEdit(item: RegistryItem, entityType: string) {
    setEditLoading(item.id)
    try {
      const res = await api(`/${entityType}s/${item.id}`)
      if (res.ok) {
        const detail = await res.json()
        setEditing({
          type: entityType as EntityType,
          item: { ...item, ...detail },
        })
      } else {
        setEditing({
          type: entityType as EntityType,
          item,
        })
      }
    } catch {
      setEditing({
        type: entityType as EntityType,
        item,
      })
    } finally {
      setEditLoading(null)
    }
  }

  async function handleDelete(item: RegistryItem, entityType: string) {
    if (
      !confirm(`Delete ${entityType} "${item.name}"? This cannot be undone.`)
    ) {
      return
    }
    try {
      const res = await api(`/${entityType}s/${item.id}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        const body = await res.json()
        flash(body.error || 'Delete failed.', 'err')
        return
      }
      flash(`${entityType} "${item.name}" deleted.`)
      load()
    } catch (err) {
      flash(
        err instanceof Error ? err.message : 'Delete failed.',
        'err',
      )
    }
  }

  function startCreate(type: EntityType) {
    setEditing({ type })
  }

  function handleSaved(_entity: EntityData) {
    setEditing(null)
    load()
  }

  async function handleImport() {
    if (!importUrl.trim()) return
    setImportLoading(true)
    try {
      const res = await api('/skills/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: importUrl.trim() }),
      })
      if (!res.ok) {
        const body = await res.json()
        throw new Error(body.error || 'Import failed')
      }
      const result = await res.json()
      flash(`Skill "${result.name || result.slug}" imported.`)
      setImporting(false)
      setImportUrl('')
      load()
    } catch (err) {
      flash(
        err instanceof Error ? err.message : 'Import failed.',
        'err',
      )
    } finally {
      setImportLoading(false)
    }
  }

  function handleDeleteFromForm() {
    if (!editing?.item) return
    handleDelete(editing.item, editing.type)
    setEditing(null)
  }

  if (editing) {
    const initial: EntityData | undefined = editing.item
      ? {
        id: editing.item.id,
        name: editing.item.name,
        slug: editing.item.slug,
        version: editing.item.version || '0.0.1',
        visibility: editing.item.visibility,
        content: editing.item.content || '',
        config: editing.item.config || null,
      }
      : undefined

    return (
      <EntityForm
        type={editing.type}
        initial={initial}
        onSave={handleSaved}
        onCancel={() => setEditing(null)}
        onDelete={editing.item ? handleDeleteFromForm : undefined}
      />
    )
  }

  const canWrite = !!data

  const header = (
    <div class='flex items-center justify-between'>
      <div class='flex items-center gap-3'>
        <h2 class='text-lg font-semibold'>Registry</h2>
        <select
          value={scope}
          onChange={(e) => {
            setScope(
              (e.target as HTMLSelectElement).value as
                | 'public'
                | 'private',
            )
            setExpanded(null)
          }}
          class='text-xs border border-gray-200 rounded-md px-2 py-1 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer'
        >
          <option value='public'>Public</option>
          <option value='private'>Private</option>
        </select>
      </div>
      {canWrite && (tab === 'skills' || tab === 'rules' || tab === 'tools') && (
        <div class='flex gap-2'>
          {tab === 'skills' && (
            <button
              type='button'
              onClick={() => setImporting(!importing)}
              class={`px-4 py-2 text-sm rounded-lg transition-colors ${
                importing
                  ? 'bg-gray-200 text-gray-700'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              Import
            </button>
          )}
          <button
            type='button'
            onClick={() => startCreate(tab.slice(0, -1) as EntityType)}
            class='px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 transition-colors'
          >
            New {tab.charAt(0).toUpperCase() + tab.slice(1, -1)}
          </button>
        </div>
      )}
    </div>
  )

  const tabBar = (
    <RegistryTabs
      tab={tab}
      setTab={(t) => {
        setTab(t)
        setExpanded(null)
      }}
      data={data}
      scope={scope}
    />
  )

  if (tab === 'agents') {
    return (
      <div class='space-y-6'>
        {header}
        {tabBar}
        <Agents scope={scope} />
      </div>
    )
  }

  if (loading) {
    return (
      <div class='space-y-6'>
        {header}
        {tabBar}
        <div class='text-center py-12 text-gray-400'>
          Loading registry...
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div class='space-y-6'>
        {header}
        {tabBar}
        <div class='p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700'>
          {error}
        </div>
      </div>
    )
  }

  if (!data) return null

  const pub = data.public
  const priv = data.private
  const pick = (
    pubItems: RegistryItem[],
    privItems: RegistryItem[] | undefined,
  ) => scope === 'private' && privItems ? privItems : pubItems

  const tools = pick(pub.tools, priv?.tools)
  const skills = pick(pub.skills, priv?.skills)
  const rules = pick(pub.rules, priv?.rules)

  return (
    <div class='space-y-6'>
      <div>
        {header}
        {message && (
          <div
            class={`mt-2 px-4 py-2 text-sm rounded-lg border ${
              message.type === 'ok'
                ? 'bg-green-50 text-green-700 border-green-200'
                : 'bg-red-50 text-red-700 border-red-200'
            }`}
          >
            {message.text}
          </div>
        )}
        <p class='text-xs text-gray-500 mt-1'>
          {tools.length} tools &middot; {skills.length} skills &middot;{' '}
          {rules.length} rules
        </p>
      </div>

      {tabBar}

      {importing && (
        <div class='bg-white border border-gray-200 rounded-xl p-4'>
          <p class='text-sm font-medium text-gray-700 mb-2'>
            Import skill from GitHub
          </p>
          <div class='flex gap-2'>
            <input
              type='text'
              value={importUrl}
              onInput={(e) =>
                setImportUrl((e.target as HTMLInputElement).value)}
              placeholder='owner/repo or https://github.com/...'
              class='flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent'
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleImport()
              }}
            />
            <button
              type='button'
              onClick={handleImport}
              disabled={importLoading || !importUrl.trim()}
              class={`px-4 py-2 text-white text-sm rounded-lg transition-colors ${
                importLoading || !importUrl.trim()
                  ? 'bg-blue-400 cursor-not-allowed'
                  : 'bg-blue-600 hover:bg-blue-700'
              }`}
            >
              {importLoading ? 'Importing...' : 'Import'}
            </button>
          </div>
          <p class='text-xs text-gray-400 mt-1.5'>
            Imports a skill following the{' '}
            <a
              href='https://agentskills.io/specification'
              target='_blank'
              rel='noopener'
              class='text-blue-500 hover:text-blue-600'
            >
              Agent Skills spec
            </a>{' '}
            from a public GitHub repository.
          </p>
        </div>
      )}

      <div class='bg-white border border-gray-200 rounded-xl p-6'>
        {tab === 'all' && (
          <AllSection
            tools={tools}
            skills={skills}
            rules={rules}
            expanded={expanded}
            onToggle={toggleExpand}
            onEdit={handleEdit}
            onDelete={handleDelete}
            loadingId={editLoading}
          />
        )}
        {tab === 'tools' && (
          <Section
            items={tools}
            type='tool'
            expanded={expanded}
            onToggle={toggleExpand}
            onEdit={handleEdit}
            onDelete={handleDelete}
            loadingId={editLoading}
          />
        )}
        {tab === 'skills' && (
          <Section
            items={skills}
            type='skill'
            expanded={expanded}
            onToggle={toggleExpand}
            onEdit={handleEdit}
            onDelete={handleDelete}
            loadingId={editLoading}
          />
        )}
        {tab === 'rules' && (
          <Section
            items={rules}
            type='rule'
            expanded={expanded}
            onToggle={toggleExpand}
            onEdit={handleEdit}
            onDelete={handleDelete}
            loadingId={editLoading}
          />
        )}
        {tab === 'promotable' && (
          data.promotable.length === 0
            ? (
              <p class='text-xs text-gray-400 py-4 text-center'>
                No promotable items
              </p>
            )
            : (
              <div class='space-y-3'>
                <div class='px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-700'>
                  Promotions are coming soon. Items below are eligible for
                  publishing but this feature is not yet available.
                </div>
                <div class='border border-amber-200 rounded-lg divide-y divide-amber-100'>
                  {data.promotable.map((p) => (
                    <div
                      key={`${p.type}-${p.slug}`}
                      class='flex items-center justify-between px-4 py-2 text-sm'
                    >
                      <div class='flex items-center gap-2'>
                        <span class='font-mono text-xs bg-amber-100 px-1.5 py-0.5 rounded text-amber-700'>
                          {p.type}
                        </span>
                        <span class='text-amber-900'>{p.name}</span>
                        <span class='text-amber-500 text-xs'>
                          {p.slug}
                        </span>
                      </div>
                      <button
                        type='button'
                        disabled
                        class='px-3 py-1 bg-gray-300 text-gray-500 text-xs rounded cursor-not-allowed'
                      >
                        Publish
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )
        )}
      </div>
    </div>
  )
}

function RegistryTabs({
  tab,
  setTab,
  data,
  scope,
}: {
  tab: EntityTab
  setTab: (t: EntityTab) => void
  data: StatusData | null
  scope: 'public' | 'private'
}) {
  const src = data
    ? scope === 'private' && data.private ? data.private : data.public
    : null
  const counts = src
    ? {
      agents: src.agents.length,
      tools: src.tools.length,
      skills: src.skills.length,
      rules: src.rules.length,
    }
    : { agents: 0, tools: 0, skills: 0, rules: 0 }

  const total = counts.agents + counts.tools + counts.skills +
    counts.rules

  const tabs: { id: EntityTab; label: string; count: number }[] = [
    { id: 'all', label: 'All', count: total },
    { id: 'agents', label: 'Agents', count: counts.agents },
    { id: 'tools', label: 'Tools', count: counts.tools },
    { id: 'skills', label: 'Skills', count: counts.skills },
    { id: 'rules', label: 'Rules', count: counts.rules },
  ]

  if (data?.isAdmin) {
    tabs.push({
      id: 'promotable',
      label: 'Promotable',
      count: data.promotable.length,
    })
  }

  return (
    <div class='flex gap-1 border-b border-gray-200'>
      {tabs.map((t) => (
        <button
          key={t.id}
          type='button'
          onClick={() => setTab(t.id)}
          class={`px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
            tab === t.id
              ? 'border-blue-500 text-blue-600'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          {t.id === 'promotable' && data &&
            data.promotable.length > 0 && (
            <span class='inline-block w-1.5 h-1.5 rounded-full bg-amber-500 mr-1.5' />
          )}
          {t.label} ({t.count})
        </button>
      ))}
    </div>
  )
}

function AllSection({
  tools,
  skills,
  rules,
  expanded,
  onToggle,
  onEdit,
  onDelete,
  loadingId,
}: {
  tools: RegistryItem[]
  skills: RegistryItem[]
  rules: RegistryItem[]
  expanded: string | null
  onToggle: (id: string) => void
  onEdit?: (item: RegistryItem, entityType: string) => void
  onDelete?: (item: RegistryItem, entityType: string) => void
  loadingId?: string | null
}) {
  const items: TaggedItem[] = [
    ...tools.map((i) => ({ ...i, entityType: 'tool' })),
    ...skills.map((i) => ({ ...i, entityType: 'skill' })),
    ...rules.map((i) => ({ ...i, entityType: 'rule' })),
  ].sort((a, b) => a.name.localeCompare(b.name))

  return (
    <Section
      items={items}
      type='mixed'
      expanded={expanded}
      onToggle={onToggle}
      onEdit={onEdit}
      onDelete={onDelete}
      loadingId={loadingId}
    />
  )
}
