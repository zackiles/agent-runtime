import { useEffect, useRef, useState } from 'preact/hooks'
import { api } from '../api.ts'
import { useApp } from '../context.ts'

type DemoMeta = {
  name: string
  url: string
  path: string
  prompt: string
  summary: string
  createdAt: string
  updatedAt: string
  createdBy?: string
  status?: string
  visibility?: 'public' | 'private'
}

type View = 'list' | 'create' | 'feedback'

type Attachment = { name: string; path: string; size: number }

const SUBSYSTEMS = ['cursor', 'claude', 'gemini'] as const
const DEFAULT_SUBSYSTEM = 'cursor'

type Form = {
  prompt: string
  name: string
  subsystem: string
  files: Attachment[]
}

const EMPTY_FORM: Form = {
  prompt: '',
  name: '',
  subsystem: DEFAULT_SUBSYSTEM,
  files: [],
}

const MAX_TOTAL_BYTES = 50 * 1024 * 1024

async function checkedJson<T>(res: Response): Promise<T> {
  const data = await res.json()
  if (!res.ok) {
    const msg = (data as { error?: string }).error || res.statusText
    throw new Error(msg)
  }
  return data as T
}

function buildZip(
  files: { name: string; bytes: Uint8Array }[],
): Uint8Array {
  const enc = new TextEncoder()
  const parts: Uint8Array[] = []
  const directory: Uint8Array[] = []
  let offset = 0

  for (const file of files) {
    const nameBytes = enc.encode(file.name)
    const crc = crc32(file.bytes)

    const local = new Uint8Array(30 + nameBytes.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(8, 0, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, file.bytes.length, true)
    lv.setUint32(22, file.bytes.length, true)
    lv.setUint16(26, nameBytes.length, true)
    local.set(nameBytes, 30)

    const central = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(12, 0, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, file.bytes.length, true)
    cv.setUint32(24, file.bytes.length, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint32(42, offset, true)
    central.set(nameBytes, 46)

    parts.push(local, file.bytes)
    directory.push(central)
    offset += local.length + file.bytes.length
  }

  const dirStart = offset
  let dirSize = 0
  for (const d of directory) dirSize += d.length

  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, files.length, true)
  ev.setUint16(10, files.length, true)
  ev.setUint32(12, dirSize, true)
  ev.setUint32(16, dirStart, true)

  const total = offset + dirSize + 22
  const result = new Uint8Array(total)
  let pos = 0
  for (const p of parts) {
    result.set(p, pos)
    pos += p.length
  }
  for (const d of directory) {
    result.set(d, pos)
    pos += d.length
  }
  result.set(eocd, pos)
  return result
}

function crc32(data: Uint8Array): number {
  let crc = 0xFFFFFFFF
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i]
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0)
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0
}

export function Demos() {
  const { user } = useApp()
  const [demos, setDemos] = useState<DemoMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<View>('list')
  const [form, setForm] = useState<Form>({ ...EMPTY_FORM })
  const [editing, setEditing] = useState<DemoMeta | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [message, setMessage] = useState<
    { text: string; type: 'ok' | 'err' } | null
  >(null)
  const [submitting, setSubmitting] = useState(false)
  const [progress, setProgress] = useState<
    { phase: string; detail?: string } | null
  >(null)

  function flash(text: string, type: 'ok' | 'err' = 'ok') {
    setMessage({ text, type })
    setTimeout(() => setMessage(null), 4000)
  }

  async function streamAgent<T>(
    url: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    setProgress({ phase: 'connecting', detail: 'Starting...' })
    const res = await api(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const data = await res.json() as { error?: string }
      throw new Error(data.error || res.statusText)
    }
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let result: T | undefined

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n\n')
      buffer = lines.pop() || ''
      for (const chunk of lines) {
        const line = chunk.replace(/^data: /, '')
        if (!line) continue
        try {
          const event = JSON.parse(line) as {
            phase: string
            detail?: string
            result?: T
          }
          if (event.phase === 'done') {
            result = event.result as T
          } else if (event.phase === 'error') {
            throw new Error(event.detail || 'Agent failed')
          } else {
            setProgress({ phase: event.phase, detail: event.detail })
          }
        } catch (e) {
          if (e instanceof Error && e.message !== 'Agent failed') continue
          throw e
        }
      }
    }
    setProgress(null)
    if (!result) throw new Error('No result received')
    return result
  }

  function reload() {
    setLoading(true)
    api('/api/demos')
      .then((r) => checkedJson<DemoMeta[]>(r))
      .then(setDemos)
      .catch(() => setDemos([]))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    reload()
  }, [])

  function startCreate() {
    setForm({ ...EMPTY_FORM })
    setEditing(null)
    setView('create')
  }

  function startFeedback(demo: DemoMeta) {
    setForm({
      prompt: '',
      name: demo.name,
      subsystem: DEFAULT_SUBSYSTEM,
      files: [],
    })
    setEditing(demo)
    setView('feedback')
  }

  async function handleCreate() {
    if (!form.prompt.trim()) return flash('Prompt is required.', 'err')
    setSubmitting(true)
    try {
      const fileMeta = form.files.length > 0
        ? form.files.map((f) => ({ name: f.name, path: f.path }))
        : undefined
      const result = await streamAgent<{ demo?: DemoMeta }>(
        '/api/demos',
        {
          prompt: form.prompt,
          name: form.name || undefined,
          subsystem: form.subsystem,
          files: fileMeta,
        },
      )
      if (result.demo) {
        setDemos((prev) => [...prev, result.demo!])
      }
      flash('Demo created successfully.')
      setView('list')
      reload()
    } catch (err) {
      flash(
        err instanceof Error ? err.message : 'Failed to create demo.',
        'err',
      )
    } finally {
      setSubmitting(false)
      setProgress(null)
    }
  }

  async function handleUpdate() {
    if (!form.prompt.trim()) return flash('Feedback is required.', 'err')
    if (!editing) return
    setSubmitting(true)
    try {
      const fileMeta = form.files.length > 0
        ? form.files.map((f) => ({ name: f.name, path: f.path }))
        : undefined
      await streamAgent(`/api/demos/${editing.name}/update`, {
        prompt: form.prompt,
        files: fileMeta,
      })
      flash(`Demo "${editing.name}" updated.`)
      setView('list')
      reload()
    } catch (err) {
      flash(
        err instanceof Error ? err.message : 'Failed to update demo.',
        'err',
      )
    } finally {
      setSubmitting(false)
      setProgress(null)
    }
  }

  async function handleDeploy(
    demo: DemoMeta,
    visibility: 'public' | 'private' = 'private',
  ) {
    try {
      const res = await api(`/api/demos/${demo.name}/deploy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visibility }),
      })
      const result = await checkedJson<{
        url: string
        visibility?: string
      }>(res)
      const url = result.url || demo.url
      setDemos((prev) =>
        prev.map((d) =>
          d.name === demo.name
            ? {
              ...d,
              url,
              status: 'running',
              visibility: (result.visibility || visibility) as
                | 'public'
                | 'private',
            }
            : d
        )
      )
      flash(`Demo "${demo.name}" deployed (${visibility}).`)
    } catch (err) {
      flash(
        err instanceof Error ? err.message : 'Deploy failed.',
        'err',
      )
    }
  }

  async function handleStop(demo: DemoMeta) {
    try {
      const res = await api(`/api/demos/${demo.name}/stop`, {
        method: 'POST',
      })
      await checkedJson(res)
      setDemos((prev) =>
        prev.map((d) => d.name === demo.name ? { ...d, status: 'stopped' } : d)
      )
      flash(`Demo "${demo.name}" stopped.`)
    } catch (err) {
      flash(
        err instanceof Error ? err.message : 'Stop failed.',
        'err',
      )
    }
  }

  async function handleDelete(demo: DemoMeta) {
    if (!confirm(`Delete demo "${demo.name}" and all its data?`)) return
    setSubmitting(true)
    flash(`Deleting "${demo.name}"...`)
    try {
      const res = await api(`/api/demos/${demo.name}`, {
        method: 'DELETE',
      })
      await checkedJson(res)
      setDemos((prev) => prev.filter((d) => d.name !== demo.name))
      flash(`Demo "${demo.name}" deleted.`)
    } catch (err) {
      flash(
        err instanceof Error ? err.message : 'Delete failed.',
        'err',
      )
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDownload(demo: DemoMeta) {
    try {
      const res = await api(`/api/demos/${demo.name}/download`)
      const data = await checkedJson<{
        files: Record<string, string>
      }>(res)

      const entries = Object.entries(data.files)
      if (entries.length === 0) {
        throw new Error('No source files found for this demo.')
      }
      const decoded = entries.map(([name, b64]) => ({
        name,
        bytes: Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)),
      }))

      const zip = buildZip(decoded)
      const blob = new Blob([zip.buffer as ArrayBuffer], {
        type: 'application/zip',
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${demo.name}-source.zip`
      a.style.display = 'none'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      flash('Download started.')
    } catch (err) {
      flash(
        err instanceof Error ? err.message : 'Download failed.',
        'err',
      )
    }
  }

  const running = demos.filter((d) => d.status === 'running').length

  if (view === 'create' || view === 'feedback') {
    return (
      <DemoForm
        form={form}
        setForm={setForm}
        onSubmit={view === 'create' ? handleCreate : handleUpdate}
        onCancel={() => setView('list')}
        title={view === 'create' ? 'New Demo' : `Update: ${editing?.name}`}
        submitLabel={view === 'create' ? 'Create Demo' : 'Send Feedback'}
        message={message}
        submitting={submitting}
        isUpdate={view === 'feedback'}
        progress={progress}
      />
    )
  }

  return (
    <div class='space-y-6'>
      <div>
        <div class='flex items-center justify-between'>
          <div class='flex items-center gap-2'>
            <h2 class='text-lg font-semibold'>Demo Builder</h2>
          </div>
          <button
            type='button'
            onClick={startCreate}
            class='px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 transition-colors'
          >
            New Demo
          </button>
        </div>
        {demos.length > 0 && (
          <p class='text-xs text-gray-500 mt-1 ml-4'>
            {demos.length} demos &middot; {running} running
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

      {loading
        ? (
          <div class='text-center py-12 text-gray-400'>
            Loading demos...
          </div>
        )
        : demos.length === 0
        ? (
          <div class='text-center py-12'>
            <p class='text-gray-400 mb-2'>No demos yet.</p>
            <p class='text-sm text-gray-400'>
              Describe an app idea and the demo agent will build it for you.
            </p>
          </div>
        )
        : (
          <div class='space-y-3'>
            {demos.map((demo) => (
              <DemoCard
                key={demo.name}
                demo={demo}
                expanded={expanded === demo.name}
                onToggle={() =>
                  setExpanded(expanded === demo.name ? null : demo.name)}
                onDeploy={(v) => handleDeploy(demo, v)}
                onStop={() => handleStop(demo)}
                onDelete={() => handleDelete(demo)}
                onDownload={() => handleDownload(demo)}
                onFeedback={() => startFeedback(demo)}
                isOwner={!demo.createdBy || demo.createdBy === user.email}
              />
            ))}
          </div>
        )}
    </div>
  )
}

function DemoCard({
  demo,
  expanded,
  onToggle,
  onDeploy,
  onStop,
  onDelete,
  onDownload,
  onFeedback,
  isOwner,
}: {
  demo: DemoMeta
  expanded: boolean
  onToggle: () => void
  onDeploy: (visibility: 'public' | 'private') => void
  onStop: () => void
  onDelete: () => void
  onDownload: () => void
  onFeedback: () => void
  isOwner: boolean
}) {
  const status = demo.status || 'created'
  const vis = demo.visibility || 'private'

  const statusColor = status === 'running'
    ? 'bg-green-50 text-green-700'
    : status === 'stopped'
    ? 'bg-red-50 text-red-600'
    : status === 'expired'
    ? 'bg-yellow-50 text-yellow-600'
    : 'bg-gray-100 text-gray-500'

  const dotColor = status === 'running'
    ? 'bg-green-500'
    : status === 'stopped'
    ? 'bg-red-400'
    : status === 'expired'
    ? 'bg-yellow-400'
    : 'bg-gray-300'

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
            <span class='font-medium text-gray-900'>{demo.name}</span>
            {demo.summary && (
              <span class='ml-2 text-xs text-gray-400'>
                {demo.summary.slice(0, 60)}
                {demo.summary.length > 60 ? '...' : ''}
              </span>
            )}
          </div>
        </div>
        <div class='flex items-center gap-2'>
          {status === 'running' && (
            <span
              class={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                vis === 'public'
                  ? 'bg-amber-50 text-amber-700 border border-amber-200'
                  : 'bg-gray-50 text-gray-500 border border-gray-200'
              }`}
            >
              {vis === 'public' ? 'public' : 'auth required'}
            </span>
          )}
          <span
            class={`text-xs px-2 py-0.5 rounded-full font-medium ${statusColor}`}
          >
            {status}
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
              <dd class='text-gray-900 mt-0.5'>{status}</dd>
            </div>
            <div>
              <dt class='text-gray-500 text-xs'>Access</dt>
              <dd class='mt-0.5'>
                <span
                  class={`text-xs px-2 py-0.5 rounded-full font-medium ${
                    vis === 'public'
                      ? 'bg-amber-50 text-amber-700'
                      : 'bg-blue-50 text-blue-700'
                  }`}
                >
                  {vis === 'public'
                    ? 'Public (no auth)'
                    : 'Private (auth required)'}
                </span>
              </dd>
            </div>
            <div>
              <dt class='text-gray-500 text-xs'>Created</dt>
              <dd class='text-gray-900 mt-0.5'>
                {new Date(demo.createdAt).toLocaleDateString()}
              </dd>
            </div>
            <div>
              <dt class='text-gray-500 text-xs'>Updated</dt>
              <dd class='text-gray-900 mt-0.5'>
                {new Date(demo.updatedAt).toLocaleDateString()}
              </dd>
            </div>
            {demo.url && (
              <div class='col-span-2 sm:col-span-4'>
                <dt class='text-gray-500 text-xs'>URL</dt>
                <dd class='text-gray-900 mt-0.5'>
                  <a
                    href={demo.url}
                    target='_blank'
                    rel='noopener noreferrer'
                    class='text-blue-600 hover:underline text-xs break-all'
                  >
                    {demo.url}
                  </a>
                </dd>
              </div>
            )}
          </dl>

          {demo.summary && (
            <p class='text-sm text-gray-600 mb-4'>{demo.summary}</p>
          )}

          {demo.prompt && (
            <details class='mb-4'>
              <summary class='text-xs text-gray-500 cursor-pointer hover:text-gray-700'>
                Original prompt
              </summary>
              <pre class='mt-2 p-3 bg-gray-50 rounded-lg text-xs text-gray-700 whitespace-pre-wrap max-h-40 overflow-y-auto'>
                {demo.prompt}
              </pre>
            </details>
          )}

          <div class='flex gap-2 flex-wrap'>
            {isOwner && status !== 'running' && (
              <div class='flex items-center gap-1'>
                <button
                  type='button'
                  onClick={() => onDeploy('private')}
                  class='px-3 py-1.5 text-xs bg-blue-50 text-blue-700 hover:bg-blue-100 rounded-l-md transition-colors border border-blue-200'
                >
                  Deploy Private
                </button>
                <button
                  type='button'
                  onClick={() => onDeploy('public')}
                  class='px-3 py-1.5 text-xs bg-amber-50 text-amber-700 hover:bg-amber-100 rounded-r-md transition-colors border border-amber-200'
                >
                  Deploy Public
                </button>
              </div>
            )}
            {isOwner && status === 'running' && (
              <button
                type='button'
                onClick={onStop}
                class='px-3 py-1.5 text-xs bg-red-50 text-red-600 hover:bg-red-100 rounded-md transition-colors'
              >
                Stop
              </button>
            )}
            {status === 'running' && demo.url && (
              <a
                href={demo.url}
                target='_blank'
                rel='noopener noreferrer'
                onClick={(e) => {
                  try {
                    new URL(demo.url)
                  } catch {
                    e.preventDefault()
                  }
                }}
                class='px-3 py-1.5 text-xs bg-green-50 text-green-700 hover:bg-green-100 rounded-md transition-colors inline-block'
              >
                Open App
              </a>
            )}
            {isOwner && (
              <button
                type='button'
                onClick={onFeedback}
                class='px-3 py-1.5 text-xs bg-gray-100 hover:bg-gray-200 rounded-md transition-colors'
              >
                Send Feedback
              </button>
            )}
            {isOwner && (
              <button
                type='button'
                onClick={onDownload}
                class='px-3 py-1.5 text-xs bg-gray-100 hover:bg-gray-200 rounded-md transition-colors'
              >
                Download Source
              </button>
            )}
            {isOwner && (
              <button
                type='button'
                onClick={onDelete}
                class='px-3 py-1.5 text-xs bg-red-50 text-red-600 hover:bg-red-100 rounded-md transition-colors'
              >
                Delete
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

const PHASE_LABELS: Record<string, string> = {
  connecting: 'Connecting...',
  validating: 'Validating request...',
  resolving: 'Locating agent...',
  building: 'Building demo...',
  saving: 'Saving results...',
  deploying: 'Deploying...',
}

const PHASE_ORDER = [
  'connecting',
  'validating',
  'resolving',
  'building',
  'saving',
]

function ProgressPanel({
  progress,
}: {
  progress: { phase: string; detail?: string }
}) {
  const idx = PHASE_ORDER.indexOf(progress.phase)

  return (
    <div class='space-y-4 py-6'>
      <div class='flex items-center gap-3'>
        <div class='h-5 w-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin' />
        <span class='text-sm font-medium text-gray-700'>
          {PHASE_LABELS[progress.phase] || progress.phase}
        </span>
      </div>
      {progress.detail && (
        <p class='text-xs text-gray-500 ml-8'>{progress.detail}</p>
      )}
      <div class='flex gap-1 ml-8'>
        {PHASE_ORDER.map((p, i) => (
          <div
            key={p}
            class={`h-1.5 flex-1 rounded-full transition-colors ${
              i <= idx ? 'bg-blue-600' : 'bg-gray-200'
            }`}
          />
        ))}
      </div>
    </div>
  )
}

function DemoForm({
  form,
  setForm,
  onSubmit,
  onCancel,
  title,
  submitLabel,
  message,
  submitting,
  isUpdate,
  progress,
}: {
  form: Form
  setForm: (fn: Form | ((prev: Form) => Form)) => void
  onSubmit: () => void
  onCancel: () => void
  title: string
  submitLabel: string
  message: { text: string; type: 'ok' | 'err' } | null
  submitting: boolean
  isUpdate: boolean
  progress: { phase: string; detail?: string } | null
}) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)

  function handleFileAdd() {
    fileInputRef.current?.click()
  }

  async function handleFileChange(e: Event) {
    const input = e.target as HTMLInputElement
    if (!input.files) return
    const selected = Array.from(input.files)
    input.value = ''

    const currentTotal = form.files.reduce((s, f) => s + f.size, 0)
    const newTotal = selected.reduce((s, f) => s + f.size, currentTotal)
    if (newTotal > MAX_TOTAL_BYTES) {
      alert('Total attachments exceed 50 MB limit.')
      return
    }

    setUploading(true)
    const uploaded: Attachment[] = []
    // deno-lint-ignore no-explicit-any
    const tenantId = (globalThis as any).__AR__?.user?.tenantId || 'dev'
    const ts = Date.now()
    for (const file of selected) {
      const gcsPath = `${tenantId}/demos/attachments/${ts}/${file.name}`
      try {
        const params = new URLSearchParams({
          path: gcsPath,
          method: 'PUT',
          contentType: file.type || 'application/octet-stream',
          ttl: '600',
        })
        const signRes = await api(`/storage/sign?${params}`)
        if (!signRes.ok) throw new Error('Failed to get upload URL')
        const { url } = await signRes.json() as { url: string }

        const putRes = await fetch(url, {
          method: 'PUT',
          headers: {
            'Content-Type': file.type || 'application/octet-stream',
          },
          body: file,
        })
        if (!putRes.ok) throw new Error(`Upload failed: ${putRes.status}`)

        uploaded.push({ name: file.name, path: gcsPath, size: file.size })
      } catch (err) {
        alert(
          `Failed to upload ${file.name}: ${
            err instanceof Error ? err.message : 'unknown error'
          }`,
        )
        setUploading(false)
        return
      }
    }
    setUploading(false)

    setForm((prev) => ({
      ...prev,
      files: [...prev.files, ...uploaded],
    }))
  }

  function removeFile(index: number) {
    setForm((prev) => ({
      ...prev,
      files: prev.files.filter((_, i) => i !== index),
    }))
  }

  return (
    <div class='space-y-6'>
      <h2 class='text-lg font-semibold'>{title}</h2>

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

      {progress && <ProgressPanel progress={progress} />}

      {!progress && !isUpdate && (
        <div class='grid grid-cols-1 md:grid-cols-2 gap-4'>
          <div>
            <label class='block text-sm font-medium text-gray-700 mb-1'>
              Demo Name (optional)
            </label>
            <input
              type='text'
              value={form.name}
              onInput={(e) =>
                setForm((p) => ({
                  ...p,
                  name: (e.target as HTMLInputElement).value,
                }))}
              placeholder='auto-generated from prompt'
              class='w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent'
            />
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
              {SUBSYSTEMS.map((s) => (
                <option key={s} value={s}>
                  {s.charAt(0).toUpperCase() + s.slice(1)}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {!progress && (
        <>
          <div>
            <label class='block text-sm font-medium text-gray-700 mb-1'>
              {isUpdate ? 'Feedback / Changes' : 'Prompt'}
            </label>
            <p class='text-xs text-gray-400 mb-2'>
              {isUpdate
                ? 'Describe the changes you want made to this demo.'
                : 'Describe the demo app you want to build. Be as detailed or as vague as you like.'}
            </p>
            <textarea
              value={form.prompt}
              onInput={(e) =>
                setForm((p) => ({
                  ...p,
                  prompt: (e.target as HTMLTextAreaElement).value,
                }))}
              rows={12}
              placeholder={isUpdate
                ? 'Change the color scheme to dark mode and add a search bar...'
                : 'Build a real-time dashboard that shows live stock prices with interactive charts...'}
              class='w-full px-4 py-3 text-sm font-mono border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-y min-h-[200px]'
            />
          </div>

          <div>
            <div class='flex items-center justify-between mb-2'>
              <label class='block text-sm font-medium text-gray-700'>
                Attachments
                {form.files.length > 0 && (
                  <span class='text-xs text-gray-400 ml-2 font-normal'>
                    {(form.files.reduce((s, f) => s + f.size, 0) /
                      (1024 * 1024)).toFixed(1)} / 50 MB
                  </span>
                )}
              </label>
              <button
                type='button'
                onClick={handleFileAdd}
                disabled={uploading}
                class='text-xs text-blue-600 hover:text-blue-800 disabled:text-gray-400'
              >
                {uploading ? 'Uploading...' : 'Add files'}
              </button>
            </div>
            <input
              ref={fileInputRef}
              type='file'
              multiple
              onChange={handleFileChange}
              class='hidden'
            />
            {form.files.length > 0
              ? (
                <div class='space-y-1'>
                  {form.files.map((f, i) => (
                    <div
                      key={i}
                      class='flex items-center justify-between px-3 py-2 bg-gray-50 rounded-lg text-sm'
                    >
                      <span class='text-gray-700 font-mono text-xs'>
                        {f.name}
                        <span class='text-gray-400 ml-2'>
                          {(f.size / 1024).toFixed(0)} KB
                        </span>
                      </span>
                      <button
                        type='button'
                        onClick={() => removeFile(i)}
                        class='text-xs text-red-400 hover:text-red-600'
                      >
                        remove
                      </button>
                    </div>
                  ))}
                </div>
              )
              : (
                <p class='text-xs text-gray-400'>
                  Optionally attach images or text files to include in the
                  request.
                </p>
              )}
          </div>

          <div class='flex gap-3'>
            <button
              type='button'
              onClick={onSubmit}
              disabled={submitting}
              class={`px-5 py-2 text-white text-sm rounded-lg transition-colors ${
                submitting
                  ? 'bg-gray-400 cursor-not-allowed'
                  : 'bg-blue-600 hover:bg-blue-700'
              }`}
            >
              {submitting ? 'Working...' : submitLabel}
            </button>
            <button
              type='button'
              onClick={onCancel}
              class='px-5 py-2 bg-gray-100 text-gray-700 text-sm rounded-lg hover:bg-gray-200 transition-colors'
            >
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  )
}
