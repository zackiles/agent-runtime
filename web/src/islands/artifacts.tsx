import { useEffect, useState } from 'preact/hooks'
import { api } from '../api.ts'

type ImageVersion = {
  digest: string
  tags: string[]
  size: number
  uploadTime: string
  buildTime: string
  updateTime: string
  mediaType: string
}

type Package = {
  name: string
  tags: string[]
  versions: ImageVersion[]
  totalSize: number
  latestUpload: string
}

type ArtifactsData = {
  project: string
  region: string
  repo: string
  totalImages: number
  totalPackages: number
  totalSize: number
  packages: Package[]
}

type BuildStep = {
  name: string
  args: string[]
  timing?: { startTime: string; endTime: string }
}

type Build = {
  id: string
  status: string
  createTime: string
  startTime: string
  finishTime: string
  images: string[]
  logUrl: string
  duration: number | null
  steps?: BuildStep[]
  results?: {
    images?: { name: string; digest: string }[]
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}

function timeAgo(iso: string): string {
  if (!iso) return '\u2014'
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d ago`
  return new Date(iso).toLocaleDateString()
}

function statusColor(status: string): string {
  switch (status) {
    case 'SUCCESS':
      return 'bg-green-100 text-green-700'
    case 'FAILURE':
    case 'TIMEOUT':
    case 'CANCELLED':
      return 'bg-red-100 text-red-700'
    case 'WORKING':
    case 'QUEUED':
      return 'bg-yellow-100 text-yellow-700'
    default:
      return 'bg-gray-100 text-gray-600'
  }
}

function Badge({ text, cls }: { text: string; cls: string }) {
  return (
    <span
      class={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}
    >
      {text}
    </span>
  )
}

function Stat(
  { label, value }: { label: string; value: string | number },
) {
  return (
    <div class='bg-white border border-gray-200 rounded-xl p-4 text-center'>
      <p class='text-2xl font-bold text-gray-900'>{value}</p>
      <p class='text-xs text-gray-500 mt-1'>{label}</p>
    </div>
  )
}

function Confirm(
  { message, onConfirm, onCancel, label, busy }: {
    message: string
    onConfirm: () => void
    onCancel: () => void
    label?: string
    busy?: boolean
  },
) {
  return (
    <div class='fixed inset-0 z-50 flex items-center justify-center bg-black/30'>
      <div class='bg-white rounded-xl border border-gray-200 shadow-lg p-6 max-w-sm w-full mx-4'>
        <p class='text-sm text-gray-700 mb-4'>{message}</p>
        <div class='flex gap-2 justify-end'>
          <button
            type='button'
            onClick={onCancel}
            disabled={busy}
            class='px-3 py-1.5 text-sm rounded-md border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-50'
          >
            Cancel
          </button>
          <button
            type='button'
            onClick={onConfirm}
            disabled={busy}
            class='px-3 py-1.5 text-sm rounded-md bg-red-600 text-white hover:bg-red-700 disabled:opacity-50'
          >
            {label || 'Delete'}
          </button>
        </div>
      </div>
    </div>
  )
}

type ClearProgress = {
  status: string
  current: number
  total: number
  deleted: number
  failed: number
  errors: string[]
  done: boolean
  result?: { message: string; deleted: number; failed: number }
}

function ClearBuildsModal(
  { name, onClose, onDone }: {
    name: string
    onClose: () => void
    onDone: () => void
  },
) {
  const [confirmed, setConfirmed] = useState(false)
  const [progress, setProgress] = useState<ClearProgress>({
    status: '',
    current: 0,
    total: 0,
    deleted: 0,
    failed: 0,
    errors: [],
    done: false,
  })

  useEffect(() => {
    if (!confirmed) return
    const ctrl = new AbortController()
    const base = import.meta.env.VITE_API_URL || ''
    const path = `/api/artifacts/packages/${encodeURIComponent(name)}/builds`

    fetch(`${base}${path}`, {
      method: 'DELETE',
      credentials: 'include',
      headers: { 'Accept': 'text/event-stream' },
      signal: ctrl.signal,
    }).then(async (res) => {
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({})) as {
          error?: string
        }
        setProgress((p) => ({
          ...p,
          done: true,
          status: body.error || `HTTP ${res.status}`,
          errors: [...p.errors, body.error || 'Request failed'],
        }))
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() || ''

        let event = ''
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            event = line.slice(7)
          } else if (line.startsWith('data: ')) {
            const raw = line.slice(6)
            try {
              const d = JSON.parse(raw)
              if (event === 'status') {
                setProgress((p) => ({
                  ...p,
                  status: d.message || p.status,
                  total: d.total ?? p.total,
                }))
              } else if (event === 'progress') {
                setProgress((p) => ({
                  ...p,
                  current: d.current ?? p.current,
                  total: d.total ?? p.total,
                  deleted: d.deleted ? p.deleted + 1 : p.deleted,
                  failed: d.error ? p.failed + 1 : p.failed,
                  errors: d.error
                    ? [...p.errors.slice(-4), d.message || d.error]
                    : p.errors,
                  status: d.error
                    ? `Failed: ${d.error.slice(0, 20)}...`
                    : `Deleted ${d.deleted?.digest?.slice(0, 16) || ''}...`,
                }))
              } else if (event === 'done') {
                setProgress((p) => ({
                  ...p,
                  done: true,
                  status: d.message || 'Done',
                  result: {
                    message: d.message,
                    deleted: d.deleted?.length ?? p.deleted,
                    failed: d.failed ?? p.failed,
                  },
                }))
              } else if (event === 'error') {
                setProgress((p) => ({
                  ...p,
                  done: true,
                  status: d.error || 'Failed',
                  errors: [...p.errors, d.error || 'Unknown error'],
                }))
              }
            } catch {
              // ignore malformed SSE data
            }
            event = ''
          }
        }
      }

      setProgress((p) => p.done ? p : { ...p, done: true })
    }).catch((err) => {
      if (ctrl.signal.aborted) return
      setProgress((p) => ({
        ...p,
        done: true,
        status: err.message || 'Connection failed',
        errors: [...p.errors, err.message || 'Connection failed'],
      }))
    })

    return () => ctrl.abort()
  }, [confirmed, name])

  const pct = progress.total > 0
    ? Math.round((progress.current / progress.total) * 100)
    : 0

  return (
    <div class='fixed inset-0 z-50 flex items-center justify-center bg-black/30'>
      <div class='bg-white rounded-xl border border-gray-200 shadow-lg p-6 max-w-md w-full mx-4'>
        {!confirmed
          ? (
            <>
              <p class='text-sm text-gray-700 mb-4'>
                Clear all old builds for "{name}"? Only the latest deployed
                version will be kept. This frees up GCP resources.
              </p>
              <div class='flex gap-2 justify-end'>
                <button
                  type='button'
                  onClick={onClose}
                  class='px-3 py-1.5 text-sm rounded-md border border-gray-200 text-gray-600 hover:bg-gray-50'
                >
                  Cancel
                </button>
                <button
                  type='button'
                  onClick={() => setConfirmed(true)}
                  class='px-3 py-1.5 text-sm rounded-md bg-red-600 text-white hover:bg-red-700'
                >
                  Clear Builds
                </button>
              </div>
            </>
          )
          : (
            <>
              <div class='mb-3'>
                <div class='flex items-center justify-between mb-1.5'>
                  <span class='text-sm font-medium text-gray-800'>
                    {progress.done ? 'Complete' : 'Clearing builds...'}
                  </span>
                  {progress.total > 0 && (
                    <span class='text-xs text-gray-500'>
                      {progress.current}/{progress.total}
                    </span>
                  )}
                </div>
                {progress.total > 0 && (
                  <div class='w-full bg-gray-100 rounded-full h-2 overflow-hidden'>
                    <div
                      class={`h-full rounded-full transition-all duration-300 ${
                        progress.done
                          ? progress.failed > 0
                            ? 'bg-amber-500'
                            : 'bg-green-500'
                          : 'bg-blue-500'
                      }`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                )}
              </div>

              <p class='text-xs text-gray-500 mb-2 truncate'>
                {progress.status || 'Starting...'}
              </p>

              {progress.done && progress.result && (
                <div class='mb-3 p-3 rounded-lg bg-gray-50 border border-gray-100'>
                  <p class='text-sm text-gray-700'>
                    {progress.result.message}
                  </p>
                  <div class='flex gap-4 mt-2'>
                    {progress.result.deleted > 0 && (
                      <span class='text-xs text-green-600'>
                        {progress.result.deleted} deleted
                      </span>
                    )}
                    {progress.result.failed > 0 && (
                      <span class='text-xs text-red-600'>
                        {progress.result.failed} failed
                      </span>
                    )}
                  </div>
                </div>
              )}

              {progress.errors.length > 0 && (
                <div class='mb-3 max-h-20 overflow-y-auto'>
                  {progress.errors.map((e, i) => (
                    <p
                      key={i}
                      class='text-xs text-red-500 truncate'
                      title={e}
                    >
                      {e}
                    </p>
                  ))}
                </div>
              )}

              <div class='flex justify-end'>
                <button
                  type='button'
                  onClick={() => {
                    onClose()
                    if (progress.done) onDone()
                  }}
                  disabled={!progress.done}
                  class='px-3 py-1.5 text-sm rounded-md border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-50'
                >
                  {progress.done ? 'Close' : 'Working...'}
                </button>
              </div>
            </>
          )}
      </div>
    </div>
  )
}

function VersionRow(
  { v, onDelete }: {
    v: ImageVersion
    onDelete: () => void
  },
) {
  const shortDigest = v.digest
    ? v.digest.replace('sha256:', '').slice(0, 12)
    : '\u2014'

  return (
    <div class='flex items-center justify-between py-2.5 px-3 border-b border-gray-50 last:border-b-0 hover:bg-gray-25 group'>
      <div class='flex items-center gap-3 min-w-0 flex-1'>
        <code class='text-xs text-gray-500 font-mono shrink-0'>
          {shortDigest}
        </code>
        <div class='flex gap-1 flex-wrap'>
          {v.tags.map((t) => (
            <Badge
              key={t}
              text={t}
              cls='bg-blue-50 text-blue-700 border border-blue-200'
            />
          ))}
          {v.tags.length === 0 && (
            <span class='text-xs text-gray-400 italic'>untagged</span>
          )}
        </div>
      </div>
      <div class='flex items-center gap-4 shrink-0'>
        <span class='text-xs text-gray-500'>{formatBytes(v.size)}</span>
        <span class='text-xs text-gray-400'>{timeAgo(v.uploadTime)}</span>
        {v.buildTime && (
          <span class='text-xs text-gray-400' title='Build time'>
            built {timeAgo(v.buildTime)}
          </span>
        )}
        <button
          type='button'
          onClick={onDelete}
          class='opacity-0 group-hover:opacity-100 text-xs text-red-500 hover:text-red-700 transition-opacity'
          title='Delete version'
        >
          Delete
        </button>
      </div>
    </div>
  )
}

function PackageCard(
  { pkg, onDeletePackage, onDeleteVersion, onClearBuilds }: {
    pkg: Package
    onDeletePackage: () => void
    onDeleteVersion: (digest: string) => void
    onClearBuilds: () => void
  },
) {
  const [expanded, setExpanded] = useState(false)
  const shown = expanded ? pkg.versions : pkg.versions.slice(0, 3)

  return (
    <div class='bg-white border border-gray-200 rounded-xl overflow-hidden'>
      <div class='px-5 py-4 flex items-center justify-between'>
        <div class='flex items-center gap-3 min-w-0'>
          <button
            type='button'
            onClick={() => setExpanded(!expanded)}
            class='text-gray-400 hover:text-gray-600 shrink-0'
          >
            <svg
              class={`w-4 h-4 transition-transform ${
                expanded ? 'rotate-90' : ''
              }`}
              fill='none'
              stroke='currentColor'
              viewBox='0 0 24 24'
            >
              <path
                stroke-linecap='round'
                stroke-linejoin='round'
                stroke-width='2'
                d='M9 5l7 7-7 7'
              />
            </svg>
          </button>
          <div class='min-w-0'>
            <h3 class='text-sm font-semibold text-gray-900 truncate'>
              {pkg.name}
            </h3>
            <div class='flex items-center gap-3 mt-0.5'>
              <span class='text-xs text-gray-500'>
                {pkg.versions.length}{' '}
                version{pkg.versions.length !== 1 ? 's' : ''}
              </span>
              <span class='text-xs text-gray-400'>
                {formatBytes(pkg.totalSize)}
              </span>
              <span class='text-xs text-gray-400'>
                {timeAgo(pkg.latestUpload)}
              </span>
            </div>
          </div>
        </div>
        <div class='flex items-center gap-2'>
          <div class='flex gap-1 flex-wrap'>
            {pkg.tags.slice(0, 5).map((t) => (
              <Badge
                key={t}
                text={t}
                cls='bg-indigo-50 text-indigo-700'
              />
            ))}
            {pkg.tags.length > 5 && (
              <Badge
                text={`+${pkg.tags.length - 5}`}
                cls='bg-gray-100 text-gray-500'
              />
            )}
          </div>
          {pkg.versions.length > 1 && (
            <button
              type='button'
              onClick={onClearBuilds}
              class='ml-2 text-xs text-amber-600 hover:text-amber-700 px-2 py-1 rounded hover:bg-amber-50'
              title='Remove old builds, keep latest'
            >
              Clear Builds
            </button>
          )}
          <button
            type='button'
            onClick={onDeletePackage}
            class='ml-2 text-xs text-red-500 hover:text-red-700 px-2 py-1 rounded hover:bg-red-50'
          >
            Delete
          </button>
        </div>
      </div>

      <div class='border-t border-gray-100 bg-gray-50/50'>
        {shown.map((v) => (
          <VersionRow
            key={v.digest}
            v={v}
            onDelete={() => onDeleteVersion(v.digest)}
          />
        ))}
        {!expanded && pkg.versions.length > 3 && (
          <button
            type='button'
            onClick={() => setExpanded(true)}
            class='w-full py-2 text-xs text-blue-600 hover:text-blue-700 hover:bg-blue-50/50'
          >
            Show {pkg.versions.length - 3} more versions
          </button>
        )}
      </div>
    </div>
  )
}

function BuildRow(
  { build, onViewLogs }: {
    build: Build
    onViewLogs: () => void
  },
) {
  const shortId = build.id.slice(0, 8)
  const images = build.images.map((i) => {
    const parts = i.split('/')
    return parts[parts.length - 1] || i
  })

  return (
    <div class='flex items-center justify-between py-3 px-4 border-b border-gray-100 last:border-b-0 hover:bg-gray-50'>
      <div class='flex items-center gap-3 min-w-0 flex-1'>
        <code class='text-xs font-mono text-gray-500 shrink-0'>
          {shortId}
        </code>
        <Badge text={build.status} cls={statusColor(build.status)} />
        <div class='flex gap-1 flex-wrap min-w-0'>
          {images.map((img) => (
            <span
              key={img}
              class='text-xs text-gray-600 bg-gray-100 px-1.5 py-0.5 rounded truncate max-w-48'
              title={img}
            >
              {img}
            </span>
          ))}
        </div>
      </div>
      <div class='flex items-center gap-4 shrink-0'>
        {build.duration !== null && (
          <span class='text-xs text-gray-500'>
            {formatDuration(build.duration)}
          </span>
        )}
        <span class='text-xs text-gray-400'>
          {timeAgo(build.createTime)}
        </span>
        {build.results?.images?.[0]?.digest && (
          <code
            class='text-xs text-gray-400 font-mono'
            title={build.results.images[0].digest}
          >
            {build.results.images[0].digest.replace('sha256:', '').slice(
              0,
              8,
            )}
          </code>
        )}
        <button
          type='button'
          onClick={onViewLogs}
          class='text-xs text-blue-600 hover:text-blue-700 px-2 py-1 rounded hover:bg-blue-50'
        >
          Logs
        </button>
      </div>
    </div>
  )
}

function LogViewer(
  { buildId, onClose }: { buildId: string; onClose: () => void },
) {
  const [logs, setLogs] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    setLoading(true)
    api(`/api/artifacts/builds/${buildId}/logs`)
      .then((r) => {
        if (!r.ok) throw new Error('Failed to fetch logs')
        return r.json()
      })
      .then((d: { logs: string }) => setLogs(d.logs || 'No logs available'))
      .catch((e) =>
        setError(e instanceof Error ? e.message : 'Failed to load logs')
      )
      .finally(() => setLoading(false))
  }, [buildId])

  return (
    <div class='fixed inset-0 z-50 flex items-center justify-center bg-black/40'>
      <div class='bg-white rounded-xl border border-gray-200 shadow-xl w-full max-w-4xl mx-4 max-h-[80vh] flex flex-col'>
        <div class='flex items-center justify-between px-5 py-3 border-b border-gray-200'>
          <h3 class='text-sm font-semibold text-gray-800'>
            Build Logs
            <code class='ml-2 text-xs text-gray-500 font-mono'>
              {buildId.slice(0, 12)}
            </code>
          </h3>
          <button
            type='button'
            onClick={onClose}
            class='text-gray-400 hover:text-gray-600 p-1'
          >
            <svg
              class='w-5 h-5'
              fill='none'
              stroke='currentColor'
              viewBox='0 0 24 24'
            >
              <path
                stroke-linecap='round'
                stroke-linejoin='round'
                stroke-width='2'
                d='M6 18L18 6M6 6l12 12'
              />
            </svg>
          </button>
        </div>
        <div class='flex-1 overflow-auto p-4'>
          {loading && (
            <p class='text-sm text-gray-400 text-center py-8'>
              Loading logs...
            </p>
          )}
          {error && <p class='text-sm text-red-600 text-center py-8'>{error}
          </p>}
          {!loading && !error && (
            <pre class='text-xs font-mono text-gray-700 whitespace-pre-wrap leading-relaxed'>
              {logs}
            </pre>
          )}
        </div>
      </div>
    </div>
  )
}

export function Artifacts() {
  const [data, setData] = useState<ArtifactsData | null>(null)
  const [builds, setBuilds] = useState<Build[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<'images' | 'builds'>('images')
  const [search, setSearch] = useState('')
  const [deleting, setDeleting] = useState<
    {
      type: 'package' | 'version'
      name: string
      version?: string
    } | null
  >(null)
  const [clearTarget, setClearTarget] = useState<string | null>(null)
  const [logBuildId, setLogBuildId] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setError('')
    try {
      const [imgRes, buildRes] = await Promise.all([
        api('/api/artifacts'),
        api('/api/artifacts/builds?limit=50'),
      ])
      if (!imgRes.ok) throw new Error('Failed to load artifacts')
      setData(await imgRes.json() as ArtifactsData)
      if (buildRes.ok) setBuilds(await buildRes.json() as Build[])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Load failed')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  async function handleDelete() {
    if (!deleting) return
    try {
      const path = deleting.type === 'package'
        ? `/api/artifacts/packages/${encodeURIComponent(deleting.name)}`
        : `/api/artifacts/packages/${
          encodeURIComponent(deleting.name)
        }/versions/${encodeURIComponent(deleting.version!)}`
      const res = await api(path, { method: 'DELETE' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as {
          error?: string
        }
        throw new Error(body.error || 'Delete failed')
      }
      setDeleting(null)
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed')
      setDeleting(null)
    }
  }

  const filtered = data?.packages.filter((p) =>
    !search ||
    p.name.toLowerCase().includes(search.toLowerCase()) ||
    p.tags.some((t) => t.toLowerCase().includes(search.toLowerCase()))
  ) || []

  if (loading) {
    return (
      <div class='text-center py-12 text-gray-400'>
        Loading artifact registry...
      </div>
    )
  }

  if (error && !data) {
    return (
      <div class='p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700'>
        {error}
      </div>
    )
  }

  return (
    <div class='space-y-6'>
      {deleting && (
        <Confirm
          message={deleting.type === 'package'
            ? `Delete package "${deleting.name}" and all its versions? This cannot be undone.`
            : `Delete version ${
              deleting.version?.slice(0, 16)
            }... from "${deleting.name}"? This cannot be undone.`}
          onConfirm={handleDelete}
          onCancel={() => setDeleting(null)}
        />
      )}

      {clearTarget && (
        <ClearBuildsModal
          name={clearTarget}
          onClose={() => setClearTarget(null)}
          onDone={load}
        />
      )}

      {logBuildId && (
        <LogViewer
          buildId={logBuildId}
          onClose={() => setLogBuildId(null)}
        />
      )}

      <div class='flex items-center justify-between'>
        <div>
          <h2 class='text-lg font-semibold text-gray-900'>Artifacts</h2>
          {data && (
            <p class='text-xs text-gray-500 mt-0.5'>
              {data.repo} &middot; {data.region} &middot; {data.project}
            </p>
          )}
        </div>
        <button
          type='button'
          onClick={load}
          class='text-xs text-gray-500 hover:text-gray-700 px-3 py-1.5 rounded-md border border-gray-200 hover:bg-gray-50'
        >
          Refresh
        </button>
      </div>

      {error && (
        <div class='p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700'>
          {error}
        </div>
      )}

      {data && (
        <div class='grid grid-cols-2 sm:grid-cols-4 gap-4'>
          <Stat label='Packages' value={data.totalPackages} />
          <Stat label='Total Images' value={data.totalImages} />
          <Stat label='Total Size' value={formatBytes(data.totalSize)} />
          <Stat label='Builds' value={builds.length} />
        </div>
      )}

      <div class='flex items-center gap-4 border-b border-gray-200'>
        {(['images', 'builds'] as const).map((t) => (
          <button
            type='button'
            key={t}
            onClick={() => setTab(t)}
            class={`pb-2 text-sm font-medium border-b-2 transition-colors ${
              tab === t
                ? 'border-gray-900 text-gray-900'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {t === 'images' ? 'Images' : 'Builds'}
          </button>
        ))}
      </div>

      {tab === 'images' && (
        <div class='space-y-4'>
          <input
            type='text'
            placeholder='Filter packages by name or tag...'
            value={search}
            onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
            class='w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white'
          />

          {filtered.length === 0 && (
            <p class='text-center py-8 text-sm text-gray-400'>
              {search ? 'No packages match your filter' : 'No images found'}
            </p>
          )}

          {filtered.map((pkg) => (
            <PackageCard
              key={pkg.name}
              pkg={pkg}
              onDeletePackage={() =>
                setDeleting({ type: 'package', name: pkg.name })}
              onDeleteVersion={(digest) =>
                setDeleting({
                  type: 'version',
                  name: pkg.name,
                  version: digest,
                })}
              onClearBuilds={() => setClearTarget(pkg.name)}
            />
          ))}
        </div>
      )}

      {tab === 'builds' && (
        <div class='bg-white border border-gray-200 rounded-xl overflow-hidden'>
          {builds.length === 0 && (
            <p class='text-center py-8 text-sm text-gray-400'>
              No builds found
            </p>
          )}
          {builds.map((b) => (
            <BuildRow
              key={b.id}
              build={b}
              onViewLogs={() => setLogBuildId(b.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
