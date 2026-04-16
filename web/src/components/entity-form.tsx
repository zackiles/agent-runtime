import { useEffect, useRef, useState } from 'preact/hooks'
import { MarkdownEditor } from './editor.tsx'
import { useApp } from '../context.ts'
import { api } from '../api.ts'

type EntityType = 'tool' | 'skill' | 'rule'

type EntityData = {
  id?: string
  name: string
  slug: string
  version: string
  visibility: string
  content: string
  config: Record<string, unknown> | null
}

const SEMVER_RE = /^\d+\.\d+\.\d+$/

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0)
    if (diff !== 0) return diff
  }
  return 0
}

function bumpPatch(version: string): string {
  const parts = version.split('.')
  if (parts.length !== 3) return '0.0.2'
  const patch = parseInt(parts[2], 10)
  return `${parts[0]}.${parts[1]}.${isNaN(patch) ? 1 : patch + 1}`
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(
    /^-|-$/g,
    '',
  )
}

export function EntityForm({
  type,
  initial,
  onSave,
  onCancel,
  onDelete,
}: {
  type: EntityType
  initial?: EntityData
  onSave: (entity: EntityData) => void
  onCancel: () => void
  onDelete?: () => void
}) {
  const { user } = useApp()
  const isEdit = !!initial?.id

  const [name, setName] = useState(initial?.name ?? '')
  const [version, setVersion] = useState(initial?.version ?? '0.0.1')
  const [visibility, setVisibility] = useState(
    initial?.visibility ?? 'private',
  )
  const [content, setContent] = useState(initial?.content ?? '')
  const [globs, setGlobs] = useState(
    (initial?.config?.globs as string[] || []).join(', '),
  )
  const [description, setDescription] = useState(
    (initial?.config?.description as string) ?? '',
  )
  const [toolType, setToolType] = useState<'stdio' | 'mcp'>(
    (initial?.config?.type as 'stdio' | 'mcp') ?? 'stdio',
  )
  const [mcpTransport, setMcpTransport] = useState<'stdio' | 'http'>(
    (initial?.config?.mcp as Record<string, string>)?.transport as
      | 'stdio'
      | 'http' ?? 'stdio',
  )
  const [mcpCommand, setMcpCommand] = useState(
    (initial?.config?.mcp as Record<string, string>)?.command ?? '',
  )
  const [mcpArgs, setMcpArgs] = useState(
    ((initial?.config?.mcp as Record<string, string[]>)?.args ?? [])
      .join(' '),
  )
  const [mcpUrl, setMcpUrl] = useState(
    (initial?.config?.mcp as Record<string, string>)?.url ?? '',
  )

  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<
    { text: string; type: 'ok' | 'err' } | null
  >(null)
  const [bumpPrompt, setBumpPrompt] = useState(false)

  const flashTimer = useRef<number>(0)
  const originalVersion = initial?.version ?? '0.0.1'
  const originalContent = initial?.content ?? ''

  function fingerprint(...fields: string[]): string {
    return JSON.stringify(fields)
  }

  const initialPrint = useRef(
    fingerprint(
      initial?.name ?? '',
      initial?.version ?? '0.0.1',
      initial?.visibility ?? 'private',
      initial?.content ?? '',
      (initial?.config?.globs as string[] || []).join(', '),
      (initial?.config?.description as string) ?? '',
      (initial?.config?.type as string) ?? 'stdio',
      (initial?.config?.mcp as Record<string, string>)?.transport ?? 'stdio',
      (initial?.config?.mcp as Record<string, string>)?.command ?? '',
      ((initial?.config?.mcp as Record<string, string[]>)?.args ?? [])
        .join(' '),
      (initial?.config?.mcp as Record<string, string>)?.url ?? '',
    ),
  )

  const dirty = isEdit
    ? fingerprint(
      name,
      version,
      visibility,
      content,
      globs,
      description,
      toolType,
      mcpTransport,
      mcpCommand,
      mcpArgs,
      mcpUrl,
    ) !== initialPrint.current
    : name.trim().length > 0

  function flash(text: string, t: 'ok' | 'err' = 'ok') {
    clearTimeout(flashTimer.current)
    setMessage({ text, type: t })
    flashTimer.current = setTimeout(
      () => setMessage(null),
      4000,
    ) as unknown as number
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        handleSave()
      }
    }
    globalThis.addEventListener('keydown', onKeyDown)
    return () => globalThis.removeEventListener('keydown', onKeyDown)
  }, [name, version, content, visibility, description, globs])

  function buildData(): EntityData {
    const slug = initial?.slug || slugify(name)
    const config: Record<string, unknown> = {
      ...(initial?.config ?? {}),
    }
    if (type === 'rule') {
      config.globs = globs
        .split(',')
        .map((g) => g.trim())
        .filter(Boolean)
    }
    if (description) config.description = description
    if (type === 'tool') {
      config.type = toolType
      if (toolType === 'mcp') {
        const mcp: Record<string, unknown> = {
          transport: mcpTransport,
        }
        if (mcpTransport === 'stdio') {
          if (mcpCommand) mcp.command = mcpCommand
          const parsedArgs = mcpArgs.trim()
            .split(/\s+/)
            .filter(Boolean)
          if (parsedArgs.length) mcp.args = parsedArgs
        } else {
          if (mcpUrl) mcp.url = mcpUrl
        }
        config.mcp = mcp
      }
    }
    return {
      id: initial?.id,
      name,
      slug,
      version,
      visibility,
      content,
      config: Object.keys(config).length > 0 ? config : null,
    }
  }

  const versionRegressed = isEdit && SEMVER_RE.test(version) &&
    compareSemver(version, originalVersion) < 0

  async function handleSave() {
    if (!name.trim()) {
      flash('Name is required.', 'err')
      return
    }
    if (isEdit && !dirty) {
      flash('No changes to save.', 'err')
      return
    }
    if (!SEMVER_RE.test(version)) {
      flash('Version must be in semver format (e.g. 0.0.1).', 'err')
      return
    }
    if (versionRegressed) {
      flash(
        `Version cannot be lower than ${originalVersion}.`,
        'err',
      )
      return
    }

    const contentChanged = content !== originalContent
    const versionUnchanged = version === originalVersion
    if (isEdit && contentChanged && versionUnchanged) {
      setBumpPrompt(true)
      return
    }

    await doSave()
  }

  async function doSave(overrideVersion?: string) {
    setSaving(true)
    setBumpPrompt(false)
    const data = buildData()
    if (overrideVersion) data.version = overrideVersion

    try {
      if (isEdit) {
        const res = await api(`/${type}s/${initial!.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: data.name,
            config: data.config,
            visibility: data.visibility,
            content: data.content,
          }),
        })
        if (!res.ok) {
          const body = await res.json()
          throw new Error(body.error || 'Update failed')
        }

        if (overrideVersion && overrideVersion !== originalVersion) {
          await api(`/${type}s/${initial!.id}/versions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              version: overrideVersion,
              content: data.content,
              config: data.config,
            }),
          })
        }
      } else {
        const res = await api(`/${type}s`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: data.name,
            slug: data.slug,
            visibility: data.visibility,
            config: data.config,
          }),
        })
        if (!res.ok) {
          const body = await res.json()
          throw new Error(body.error || 'Create failed')
        }
        const created = await res.json()
        data.id = created.id

        if (data.content) {
          await api(`/${type}s/${created.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: data.content }),
          })
        }
      }
      flash(`${type} "${data.name}" saved.`)
      onSave(data)
    } catch (err) {
      flash(
        err instanceof Error ? err.message : 'Save failed.',
        'err',
      )
    } finally {
      setSaving(false)
    }
  }

  const nextPatch = bumpPatch(originalVersion)
  const title = isEdit
    ? `Edit ${type.charAt(0).toUpperCase() + type.slice(1)}`
    : `New ${type.charAt(0).toUpperCase() + type.slice(1)}`

  const hasEditor = type === 'skill' || type === 'rule'
  const placeholder = type === 'skill'
    ? 'Write your SKILL.md content...'
    : type === 'rule'
    ? 'Write your rule content...'
    : undefined

  const slug = initial?.slug || slugify(name)
  const versionValid = SEMVER_RE.test(version)
  const versionError = version && !versionValid
    ? 'Use semver format: major.minor.patch'
    : versionRegressed
    ? `Must be greater than ${originalVersion}`
    : null

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

      {bumpPrompt && (
        <div class='px-4 py-3 bg-amber-50 border border-amber-200 rounded-lg'>
          <p class='text-sm text-amber-800'>
            Content changed but version is still{' '}
            <strong>{originalVersion}</strong>. Bump to{' '}
            <strong>{nextPatch}</strong>?
          </p>
          <div class='flex gap-2 mt-2'>
            <button
              type='button'
              onClick={() => {
                setVersion(nextPatch)
                doSave(nextPatch)
              }}
              class='px-3 py-1 bg-amber-600 text-white text-sm rounded hover:bg-amber-700'
            >
              Bump to {nextPatch}
            </button>
            <button
              type='button'
              onClick={() => doSave()}
              class='px-3 py-1 bg-gray-100 text-gray-700 text-sm rounded hover:bg-gray-200'
            >
              Save without bumping
            </button>
            <button
              type='button'
              onClick={() => setBumpPrompt(false)}
              class='px-3 py-1 text-gray-500 text-sm hover:text-gray-700'
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div class='grid grid-cols-1 md:grid-cols-3 gap-4'>
        <div>
          <label class='block text-sm font-medium text-gray-700 mb-1'>
            Name
          </label>
          <input
            type='text'
            value={name}
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
            placeholder={`my-${type}`}
            class='w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent'
          />
          {!isEdit && name.trim() && (
            <p class='text-xs text-gray-400 mt-1'>
              Slug: <span class='font-mono'>{slug}</span>
            </p>
          )}
        </div>
        <div>
          <label class='block text-sm font-medium text-gray-700 mb-1'>
            Version
          </label>
          <input
            type='text'
            value={version}
            onInput={(e) => setVersion((e.target as HTMLInputElement).value)}
            placeholder='0.0.1'
            class={`w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent font-mono ${
              versionError ? 'border-red-300 bg-red-50' : 'border-gray-300'
            }`}
          />
          {versionError && (
            <p class='text-xs text-red-500 mt-1'>{versionError}</p>
          )}
        </div>
        <div>
          <label class='block text-sm font-medium text-gray-700 mb-1'>
            Visibility
          </label>
          <select
            value={visibility}
            onChange={(e) =>
              setVisibility(
                (e.target as HTMLSelectElement).value,
              )}
            class='w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500'
          >
            <option value='private'>Private</option>
            <option value='public' disabled={!user.isAdmin}>
              Public{!user.isAdmin ? ' (admin only)' : ''}
            </option>
          </select>
        </div>
      </div>

      {type === 'tool' && (
        <div class='space-y-4'>
          <div>
            <label class='block text-sm font-medium text-gray-700 mb-1'>
              Description
            </label>
            <textarea
              value={description}
              onInput={(e) =>
                setDescription(
                  (e.target as HTMLTextAreaElement).value,
                )}
              rows={3}
              placeholder='What this tool does...'
              class='w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent'
            />
          </div>
          <div>
            <label class='block text-sm font-medium text-gray-700 mb-1'>
              Type
            </label>
            <div class='flex gap-3'>
              <label class='flex items-center gap-1.5 cursor-pointer'>
                <input
                  type='radio'
                  name='toolType'
                  value='stdio'
                  checked={toolType === 'stdio'}
                  onChange={() => setToolType('stdio')}
                  class='w-4 h-4 text-blue-600'
                />
                <span class='text-sm text-gray-700'>
                  CLI / stdio
                </span>
              </label>
              <label class='flex items-center gap-1.5 cursor-pointer'>
                <input
                  type='radio'
                  name='toolType'
                  value='mcp'
                  checked={toolType === 'mcp'}
                  onChange={() => setToolType('mcp')}
                  class='w-4 h-4 text-blue-600'
                />
                <span class='text-sm text-gray-700'>
                  MCP Server
                </span>
              </label>
            </div>
          </div>
          {toolType === 'mcp' && (
            <div class='space-y-3 pl-4 border-l-2 border-blue-200'>
              <div>
                <label class='block text-sm font-medium text-gray-700 mb-1'>
                  Transport
                </label>
                <select
                  value={mcpTransport}
                  onChange={(e) =>
                    setMcpTransport(
                      (e.target as HTMLSelectElement).value as
                        | 'stdio'
                        | 'http',
                    )}
                  class='w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500'
                >
                  <option value='stdio'>
                    Local (stdio)
                  </option>
                  <option value='http'>
                    Remote (HTTP/SSE)
                  </option>
                </select>
              </div>
              {mcpTransport === 'stdio' && (
                <>
                  <div>
                    <label class='block text-sm font-medium text-gray-700 mb-1'>
                      Command
                    </label>
                    <input
                      type='text'
                      value={mcpCommand}
                      onInput={(e) =>
                        setMcpCommand(
                          (e.target as HTMLInputElement).value,
                        )}
                      placeholder='node, python, npx'
                      class='w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent'
                    />
                  </div>
                  <div>
                    <label class='block text-sm font-medium text-gray-700 mb-1'>
                      Arguments
                    </label>
                    <input
                      type='text'
                      value={mcpArgs}
                      onInput={(e) =>
                        setMcpArgs(
                          (e.target as HTMLInputElement).value,
                        )}
                      placeholder='server.js --port 3000'
                      class='w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent'
                    />
                    <p class='text-xs text-gray-400 mt-1'>
                      Space-separated arguments
                    </p>
                  </div>
                </>
              )}
              {mcpTransport === 'http' && (
                <div>
                  <label class='block text-sm font-medium text-gray-700 mb-1'>
                    Server URL
                  </label>
                  <input
                    type='text'
                    value={mcpUrl}
                    onInput={(e) =>
                      setMcpUrl(
                        (e.target as HTMLInputElement).value,
                      )}
                    placeholder='https://mcp.example.com/sse'
                    class='w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent'
                  />
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {type === 'rule' && (
        <div>
          <label class='block text-sm font-medium text-gray-700 mb-1'>
            Globs
          </label>
          <input
            type='text'
            value={globs}
            onInput={(e) => setGlobs((e.target as HTMLInputElement).value)}
            placeholder='**/*.ts, src/**'
            class='w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent font-mono'
          />
          <p class='text-xs text-gray-400 mt-1'>
            Comma-separated glob patterns this rule applies to
          </p>
        </div>
      )}

      {hasEditor && (
        <div>
          <label class='block text-sm font-medium text-gray-700 mb-2'>
            Content
          </label>
          <MarkdownEditor
            value={content}
            onChange={setContent}
            placeholder={placeholder}
          />
        </div>
      )}

      <div class='flex items-center gap-3'>
        <button
          type='button'
          onClick={handleSave}
          disabled={saving || (isEdit && !dirty)}
          class={`px-5 py-2 text-white text-sm rounded-lg transition-colors ${
            saving || (isEdit && !dirty)
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
        {isEdit && !dirty && (
          <span class='text-xs text-gray-400'>No changes</span>
        )}
        {(dirty || !isEdit) && (
          <span class='text-xs text-gray-400 hidden md:inline'>
            {navigator.platform?.includes('Mac') ? '\u2318' : 'Ctrl'}
            +S to save
          </span>
        )}
        {isEdit && onDelete && (
          <button
            type='button'
            onClick={() => {
              if (
                confirm(
                  `Delete ${type} "${name}"? This cannot be undone.`,
                )
              ) {
                onDelete()
              }
            }}
            class='ml-auto px-5 py-2 bg-red-50 text-red-600 text-sm rounded-lg hover:bg-red-100 border border-red-200 transition-colors'
          >
            Delete
          </button>
        )}
      </div>
    </div>
  )
}

export type { EntityData, EntityType }
