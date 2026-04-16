import { useEffect, useState } from 'preact/hooks'
import { api } from '../api.ts'

type TelemetryEvent = {
  id: string
  traceId: string | null
  spanId: string | null
  parentSpanId: string | null
  timestamp: number
  client: string
  clientVersion: string | null
  actor: string | null
  session: string | null
  action: string
  level: string
  context: Record<string, unknown> | null
  payload: string | null
  environment: Record<string, unknown> | null
  tags: Record<string, string> | null
  createdAt: string
}

type Tab = 'events' | 'trace'
type TimeRange = '1h' | '6h' | '24h' | '7d' | '30d'

const TIME_RANGES: { value: TimeRange; label: string; ms: number }[] = [
  { value: '1h', label: '1 hour', ms: 3_600_000 },
  { value: '6h', label: '6 hours', ms: 21_600_000 },
  { value: '24h', label: '24 hours', ms: 86_400_000 },
  { value: '7d', label: '7 days', ms: 604_800_000 },
  { value: '30d', label: '30 days', ms: 2_592_000_000 },
]

const LEVEL_STYLES: Record<string, {
  bg: string
  text: string
  dot: string
}> = {
  info: {
    bg: 'bg-blue-50',
    text: 'text-blue-700',
    dot: 'bg-blue-500',
  },
  warn: {
    bg: 'bg-amber-50',
    text: 'text-amber-700',
    dot: 'bg-amber-500',
  },
  error: {
    bg: 'bg-red-50',
    text: 'text-red-700',
    dot: 'bg-red-500',
  },
  debug: {
    bg: 'bg-gray-100',
    text: 'text-gray-600',
    dot: 'bg-gray-400',
  },
}

function formatTime(ts: number | string): string {
  const d = new Date(typeof ts === 'number' ? ts : ts)
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60_000).toFixed(1)}m`
}

function parsePayload(p: string | null): Record<string, unknown> {
  if (!p) return {}
  try {
    return JSON.parse(p)
  } catch {
    return { raw: p }
  }
}

function matchesSearch(e: TelemetryEvent, q: string): boolean {
  if (!q) return true
  const lower = q.toLowerCase()
  if (e.action.toLowerCase().includes(lower)) return true
  if (e.client.toLowerCase().includes(lower)) return true
  if (e.actor?.toLowerCase().includes(lower)) return true
  if (e.traceId?.toLowerCase().includes(lower)) return true
  if (e.spanId?.toLowerCase().includes(lower)) return true
  if (e.session?.toLowerCase().includes(lower)) return true
  if (e.payload?.toLowerCase().includes(lower)) return true
  if (e.tags) {
    for (const [k, v] of Object.entries(e.tags)) {
      if (k.toLowerCase().includes(lower)) return true
      if (v.toLowerCase().includes(lower)) return true
    }
  }
  return false
}

export function Telemetry() {
  const [allEvents, setAllEvents] = useState<TelemetryEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>('events')
  const [selected, setSelected] = useState<TelemetryEvent | null>(null)
  const [range, setRange] = useState<TimeRange>('24h')
  const [search, setSearch] = useState('')
  const [levelFilter, setLevelFilter] = useState('')
  const [clientFilter, setClientFilter] = useState('')
  const [traceId, setTraceId] = useState('')

  function load() {
    setLoading(true)
    const rangeDef = TIME_RANGES.find((r) => r.value === range)!
    const params = new URLSearchParams({
      limit: '500',
      from: String(Date.now() - rangeDef.ms),
    })
    if (levelFilter) params.set('level', levelFilter)
    if (clientFilter) params.set('client', clientFilter)
    if (traceId) params.set('traceId', traceId)
    api(`/telemetry?${params}`)
      .then((r) => {
        if (!r.ok) throw new Error('Failed')
        return r.json()
      })
      .then((d) => setAllEvents(d as TelemetryEvent[]))
      .catch(() => setAllEvents([]))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
  }, [range, levelFilter, clientFilter, traceId])

  const events = allEvents.filter((e) => matchesSearch(e, search))
  const clients = [...new Set(allEvents.map((e) => e.client))].sort()
  const errorCount = events.filter((e) => e.level === 'error').length
  const warnCount = events.filter((e) => e.level === 'warn').length
  const traceCount = new Set(
    events.filter((e) => e.traceId).map((e) => e.traceId),
  ).size

  function openTrace(tid: string) {
    setTraceId(tid)
    setTab('trace')
  }

  function clearTrace() {
    setTraceId('')
    setTab('events')
  }

  const traceEvents = traceId
    ? events
      .filter((e) => e.traceId === traceId)
      .sort((a, b) => a.timestamp - b.timestamp)
    : []
  const traceStart = traceEvents.length ? traceEvents[0].timestamp : 0
  const traceEnd = traceEvents.length
    ? traceEvents[traceEvents.length - 1].timestamp
    : 0
  const traceDuration = traceEnd - traceStart

  return (
    <div class='space-y-4'>
      <div class='flex items-center justify-between'>
        <div class='flex items-center gap-2'>
          <h2 class='text-lg font-semibold'>Telemetry</h2>
        </div>
        <div class='flex items-center gap-2'>
          {TIME_RANGES.map((r) => (
            <button
              key={r.value}
              type='button'
              onClick={() => setRange(r.value)}
              class={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                range === r.value
                  ? 'bg-gray-900 text-white'
                  : 'text-gray-500 hover:bg-gray-100'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div class='grid grid-cols-2 sm:grid-cols-4 gap-3'>
        <div class='bg-white border border-gray-200 rounded-lg px-4 py-3'>
          <p class='text-2xl font-bold text-gray-900'>
            {events.length}
          </p>
          <p class='text-xs text-gray-500'>Events</p>
        </div>
        <div class='bg-white border border-gray-200 rounded-lg px-4 py-3'>
          <p class='text-2xl font-bold text-gray-900'>
            {traceCount}
          </p>
          <p class='text-xs text-gray-500'>Traces</p>
        </div>
        <div class='bg-white border border-gray-200 rounded-lg px-4 py-3'>
          <p
            class={`text-2xl font-bold ${
              errorCount > 0 ? 'text-red-600' : 'text-gray-900'
            }`}
          >
            {errorCount}
          </p>
          <p class='text-xs text-gray-500'>Errors</p>
        </div>
        <div class='bg-white border border-gray-200 rounded-lg px-4 py-3'>
          <p
            class={`text-2xl font-bold ${
              warnCount > 0 ? 'text-amber-600' : 'text-gray-900'
            }`}
          >
            {warnCount}
          </p>
          <p class='text-xs text-gray-500'>Warnings</p>
        </div>
      </div>

      <div class='flex items-center gap-3 flex-wrap'>
        <input
          type='text'
          placeholder='Search actions, actors, traces, payloads, tags...'
          value={search}
          onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
          class='px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 flex-1 min-w-[200px] max-w-md'
        />
        <select
          value={levelFilter}
          onChange={(e) =>
            setLevelFilter(
              (e.target as HTMLSelectElement).value,
            )}
          class='px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500'
        >
          <option value=''>All Levels</option>
          <option value='error'>Error</option>
          <option value='warn'>Warn</option>
          <option value='info'>Info</option>
          <option value='debug'>Debug</option>
        </select>
        <select
          value={clientFilter}
          onChange={(e) =>
            setClientFilter(
              (e.target as HTMLSelectElement).value,
            )}
          class='px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500'
        >
          <option value=''>All Clients</option>
          {clients.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        {traceId && (
          <button
            type='button'
            onClick={clearTrace}
            class='px-3 py-2 text-xs bg-blue-50 text-blue-700 border border-blue-200 rounded-lg hover:bg-blue-100 transition-colors'
          >
            Trace: {traceId.slice(0, 12)}... &times;
          </button>
        )}
        <button
          type='button'
          onClick={load}
          class='px-3 py-2 text-xs text-gray-500 hover:text-gray-700 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors ml-auto'
        >
          Refresh
        </button>
      </div>

      {tab === 'trace' && traceEvents.length > 0 && (
        <TraceWaterfall
          events={traceEvents}
          start={traceStart}
          duration={traceDuration}
          onSelect={setSelected}
          selected={selected}
        />
      )}

      {tab === 'events' && (
        <div class='flex gap-4'>
          <div class={`${selected ? 'w-1/2' : 'w-full'} transition-all`}>
            {loading
              ? (
                <div class='text-center py-12 text-gray-400'>
                  Loading...
                </div>
              )
              : (
                <div class='bg-white border border-gray-200 rounded-xl overflow-hidden'>
                  <div class='overflow-x-auto max-h-[600px] overflow-y-auto'>
                    <table class='w-full text-sm'>
                      <thead class='sticky top-0'>
                        <tr class='border-b border-gray-200 bg-gray-50'>
                          <th class='text-left py-2.5 px-3 text-xs font-medium text-gray-500 uppercase tracking-wider w-8' />
                          <th class='text-left py-2.5 px-3 text-xs font-medium text-gray-500 uppercase tracking-wider'>
                            Time
                          </th>
                          <th class='text-left py-2.5 px-3 text-xs font-medium text-gray-500 uppercase tracking-wider'>
                            Action
                          </th>
                          <th class='text-left py-2.5 px-3 text-xs font-medium text-gray-500 uppercase tracking-wider'>
                            Client
                          </th>
                          <th class='text-left py-2.5 px-3 text-xs font-medium text-gray-500 uppercase tracking-wider'>
                            Actor
                          </th>
                          <th class='text-left py-2.5 px-3 text-xs font-medium text-gray-500 uppercase tracking-wider w-16'>
                            Trace
                          </th>
                        </tr>
                      </thead>
                      <tbody class='divide-y divide-gray-50'>
                        {events.map((e) => {
                          const ls = LEVEL_STYLES[e.level] ||
                            LEVEL_STYLES.debug
                          const isSelected = selected?.id === e.id
                          return (
                            <tr
                              key={e.id}
                              class={`cursor-pointer transition-colors ${
                                isSelected ? 'bg-blue-50' : 'hover:bg-gray-50'
                              }`}
                              onClick={() => setSelected(e)}
                            >
                              <td class='py-2 px-3'>
                                <span
                                  class={`inline-block w-2 h-2 rounded-full ${ls.dot}`}
                                  title={e.level}
                                />
                              </td>
                              <td class='py-2 px-3 text-gray-500 whitespace-nowrap text-xs font-mono'>
                                {formatTime(
                                  e.timestamp || e.createdAt,
                                )}
                              </td>
                              <td class='py-2 px-3 font-mono text-xs text-gray-900'>
                                {e.action}
                              </td>
                              <td class='py-2 px-3 text-xs text-gray-600'>
                                {e.client}
                                {e.clientVersion && (
                                  <span class='text-gray-400 ml-0.5'>
                                    @{e.clientVersion}
                                  </span>
                                )}
                              </td>
                              <td class='py-2 px-3 text-xs text-gray-600'>
                                {e.actor || '\u2014'}
                              </td>
                              <td class='py-2 px-3'>
                                {e.traceId && (
                                  <button
                                    type='button'
                                    onClick={(ev) => {
                                      ev.stopPropagation()
                                      openTrace(e.traceId!)
                                    }}
                                    class='text-[10px] px-1.5 py-0.5 bg-blue-50 text-blue-600 rounded hover:bg-blue-100 font-mono transition-colors'
                                  >
                                    {e.traceId.slice(0, 8)}
                                  </button>
                                )}
                              </td>
                            </tr>
                          )
                        })}
                        {events.length === 0 && (
                          <tr>
                            <td
                              colSpan={6}
                              class='py-12 text-center text-gray-400'
                            >
                              No events found for this time range.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
          </div>

          {selected && (
            <EventDetail
              event={selected}
              onClose={() => setSelected(null)}
              onTraceClick={openTrace}
            />
          )}
        </div>
      )}
    </div>
  )
}

function EventDetail({
  event,
  onClose,
  onTraceClick,
}: {
  event: TelemetryEvent
  onClose: () => void
  onTraceClick: (traceId: string) => void
}) {
  const ls = LEVEL_STYLES[event.level] || LEVEL_STYLES.debug
  const payload = parsePayload(event.payload)
  const hasPayload = Object.keys(payload).length > 0

  return (
    <div class='w-1/2 bg-white border border-gray-200 rounded-xl overflow-hidden max-h-[600px] overflow-y-auto'>
      <div class='flex items-center justify-between px-4 py-3 border-b border-gray-100 bg-gray-50 sticky top-0'>
        <div class='flex items-center gap-2'>
          <span
            class={`px-2 py-0.5 rounded text-xs font-medium ${ls.bg} ${ls.text}`}
          >
            {event.level}
          </span>
          <span class='font-mono text-sm font-medium text-gray-900'>
            {event.action}
          </span>
        </div>
        <button
          type='button'
          onClick={onClose}
          class='text-gray-400 hover:text-gray-700 transition-colors'
        >
          <svg
            class='w-4 h-4'
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

      <div class='p-4 space-y-4'>
        <dl class='grid grid-cols-2 gap-x-4 gap-y-3 text-xs'>
          <div>
            <dt class='text-gray-500 font-medium uppercase tracking-wider text-[10px]'>
              Time
            </dt>
            <dd class='text-gray-900 font-mono mt-0.5'>
              {formatTime(event.timestamp || event.createdAt)}
            </dd>
          </div>
          <div>
            <dt class='text-gray-500 font-medium uppercase tracking-wider text-[10px]'>
              Client
            </dt>
            <dd class='text-gray-900 mt-0.5'>
              {event.client}
              {event.clientVersion &&
                ` v${event.clientVersion}`}
            </dd>
          </div>
          <div>
            <dt class='text-gray-500 font-medium uppercase tracking-wider text-[10px]'>
              Actor
            </dt>
            <dd class='text-gray-900 mt-0.5'>
              {event.actor || '\u2014'}
            </dd>
          </div>
          <div>
            <dt class='text-gray-500 font-medium uppercase tracking-wider text-[10px]'>
              Session
            </dt>
            <dd class='text-gray-900 font-mono mt-0.5'>
              {event.session?.slice(0, 12) || '\u2014'}
            </dd>
          </div>
          {event.traceId && (
            <div class='col-span-2'>
              <dt class='text-gray-500 font-medium uppercase tracking-wider text-[10px]'>
                Trace
              </dt>
              <dd class='mt-0.5'>
                <button
                  type='button'
                  onClick={() => onTraceClick(event.traceId!)}
                  class='text-xs font-mono text-blue-600 hover:text-blue-800 hover:underline'
                >
                  {event.traceId}
                </button>
                {event.spanId && (
                  <span class='text-gray-400 ml-2 font-mono'>
                    span:{event.spanId}
                  </span>
                )}
                {event.parentSpanId && (
                  <span class='text-gray-400 ml-1 font-mono'>
                    parent:{event.parentSpanId}
                  </span>
                )}
              </dd>
            </div>
          )}
        </dl>

        {event.tags && Object.keys(event.tags).length > 0 && (
          <div>
            <p class='text-[10px] text-gray-500 font-medium uppercase tracking-wider mb-1.5'>
              Tags
            </p>
            <div class='flex flex-wrap gap-1'>
              {Object.entries(event.tags).map(([k, v]) => (
                <span
                  key={k}
                  class='text-[10px] px-2 py-0.5 bg-gray-100 text-gray-700 rounded-full font-mono'
                >
                  {k}={v}
                </span>
              ))}
            </div>
          </div>
        )}

        {hasPayload && (
          <div>
            <p class='text-[10px] text-gray-500 font-medium uppercase tracking-wider mb-1.5'>
              Payload
            </p>
            <pre class='text-xs font-mono bg-gray-900 text-gray-100 rounded-lg p-3 overflow-x-auto max-h-48 overflow-y-auto'>
              {JSON.stringify(payload, null, 2)}
            </pre>
          </div>
        )}

        {event.context &&
          Object.keys(event.context).length > 0 && (
          <div>
            <p class='text-[10px] text-gray-500 font-medium uppercase tracking-wider mb-1.5'>
              Context
            </p>
            <pre class='text-xs font-mono bg-gray-50 text-gray-700 rounded-lg p-3 overflow-x-auto max-h-32 overflow-y-auto border border-gray-100'>
              {JSON.stringify(event.context, null, 2)}
            </pre>
          </div>
        )}

        {event.environment &&
          Object.keys(event.environment).length > 0 && (
          <div>
            <p class='text-[10px] text-gray-500 font-medium uppercase tracking-wider mb-1.5'>
              Environment
            </p>
            <pre class='text-xs font-mono bg-gray-50 text-gray-700 rounded-lg p-3 overflow-x-auto border border-gray-100'>
              {JSON.stringify(event.environment, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  )
}

function TraceWaterfall({
  events,
  start,
  duration,
  onSelect,
  selected,
}: {
  events: TelemetryEvent[]
  start: number
  duration: number
  onSelect: (e: TelemetryEvent) => void
  selected: TelemetryEvent | null
}) {
  const effectiveDuration = Math.max(duration, 1)

  return (
    <div class='bg-white border border-gray-200 rounded-xl overflow-hidden'>
      <div class='flex items-center justify-between px-4 py-3 border-b border-gray-100 bg-gray-50'>
        <div class='flex items-center gap-2'>
          <span class='text-sm font-semibold text-gray-800'>
            Trace Waterfall
          </span>
          <span class='text-xs text-gray-400 font-mono'>
            {events[0]?.traceId?.slice(0, 16)}...
          </span>
        </div>
        <div class='flex items-center gap-3 text-xs text-gray-500'>
          <span>{events.length} spans</span>
          <span>{formatDuration(effectiveDuration)}</span>
        </div>
      </div>

      <div class='px-4 py-2 border-b border-gray-100 flex items-center text-[10px] text-gray-400 font-mono'>
        <div class='w-48 shrink-0'>Span</div>
        <div class='flex-1 flex justify-between px-2'>
          <span>0ms</span>
          <span>{formatDuration(effectiveDuration / 4)}</span>
          <span>{formatDuration(effectiveDuration / 2)}</span>
          <span>{formatDuration(effectiveDuration * 3 / 4)}</span>
          <span>{formatDuration(effectiveDuration)}</span>
        </div>
      </div>

      <div class='divide-y divide-gray-50'>
        {events.map((e) => {
          const ls = LEVEL_STYLES[e.level] || LEVEL_STYLES.debug
          const offset = ((e.timestamp - start) / effectiveDuration) *
            100
          const barWidth = Math.max(
            2,
            Math.min(40, (1 / events.length) * 100),
          )
          const depth = e.parentSpanId
            ? events.findIndex((p) => p.spanId === e.parentSpanId) >= 0 ? 1 : 0
            : 0

          return (
            <button
              key={e.id}
              type='button'
              onClick={() => onSelect(e)}
              class={`flex items-center w-full text-left px-4 py-2 transition-colors ${
                selected?.id === e.id ? 'bg-blue-50' : 'hover:bg-gray-50'
              }`}
            >
              <div
                class='w-48 shrink-0 flex items-center gap-1.5 text-xs truncate'
                style={{ paddingLeft: `${depth * 16}px` }}
              >
                <span
                  class={`w-1.5 h-1.5 rounded-full shrink-0 ${ls.dot}`}
                />
                <span class='font-mono text-gray-800 truncate'>
                  {e.action}
                </span>
              </div>
              <div class='flex-1 relative h-5'>
                <div
                  class={`absolute top-1 h-3 rounded-sm ${ls.bg} border ${
                    e.level === 'error'
                      ? 'border-red-300'
                      : e.level === 'warn'
                      ? 'border-amber-300'
                      : 'border-blue-200'
                  }`}
                  style={{
                    left: `${offset}%`,
                    width: `${barWidth}%`,
                    minWidth: '4px',
                  }}
                />
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
