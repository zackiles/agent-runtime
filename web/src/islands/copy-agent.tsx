import { useEffect, useState } from 'preact/hooks'
import { api } from '../api.ts'

type AgentOption = {
  slug: string
  name: string
  visibility: string
  tenantId: string
}

type TenantOption = { id: string; name: string }

type CopyOptions = {
  isAdmin: boolean
  agents: AgentOption[]
  tenants: TenantOption[]
}

type CopyItem = {
  type: string
  id: string
  label: string
  isConflict: boolean
}

type CopyReport = {
  copied: number
  overwritten: number
  failures: number
  warnings: string[]
}

function registryOptions(
  isAdmin: boolean,
  slug: string,
  tenant: string,
  agents: AgentOption[],
): string[] {
  if (!isAdmin) return ['private']
  const match = agents.find(
    (a) => a.slug === slug && a.tenantId === tenant,
  )
  if (match?.visibility === 'private') return ['private']
  return ['private', 'public']
}

export function CopyAgent() {
  const [options, setOptions] = useState<CopyOptions | null>(null)
  const [slug, setSlug] = useState('')
  const [tenant, setTenant] = useState('')
  const [visibility, setVisibility] = useState('')
  const [preview, setPreview] = useState<CopyItem[] | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [report, setReport] = useState<CopyReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    api('/copy/options')
      .then((r) => r.json())
      .then((data: CopyOptions) => setOptions(data))
      .catch(() => setError('Failed to load options'))
  }, [])

  function reset(from: 'slug' | 'tenant' | 'registry') {
    if (from === 'slug') {
      setTenant('')
      setVisibility('')
    }
    if (from === 'slug' || from === 'tenant') {
      setVisibility('')
    }
    setPreview(null)
    setReport(null)
    setError('')
  }

  function selectSlug(value: string) {
    setSlug(value)
    reset('slug')
  }

  function selectTenant(value: string) {
    setTenant(value)
    reset('tenant')
    if (!options) return
    const regs = registryOptions(
      options.isAdmin,
      slug,
      value,
      options.agents,
    )
    if (regs.length === 1) setVisibility(regs[0])
  }

  function selectVisibility(value: string) {
    setVisibility(value)
    setPreview(null)
    setReport(null)
    setError('')
  }

  async function handlePreview() {
    setError('')
    setReport(null)
    setLoading(true)
    try {
      const res = await api('/copy/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug,
          targetTenant: tenant,
          visibility,
        }),
      })
      if (!res.ok) {
        const body = await res.json()
        setError(body.error || 'Preview failed')
        setPreview(null)
        return
      }
      const data = await res.json()
      setPreview(data.items || [])
      setWarnings(data.warnings || [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Preview failed')
    } finally {
      setLoading(false)
    }
  }

  async function handleCopy() {
    setError('')
    setLoading(true)
    try {
      const res = await api('/copy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug,
          targetTenant: tenant,
          visibility,
        }),
      })
      if (!res.ok) {
        const body = await res.json()
        setError(body.error || 'Copy failed')
        return
      }
      const data = await res.json()
      setReport(data)
      setPreview(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Copy failed')
    } finally {
      setLoading(false)
    }
  }

  if (!options) {
    return (
      <div class='text-sm text-gray-500'>
        {error || 'Loading options…'}
      </div>
    )
  }

  const uniqueSlugs = [
    ...new Map(options.agents.map((a) => [a.slug, a])).values(),
  ]
  const selected = slug ? options.agents.find((a) => a.slug === slug) : null
  const regs = slug && tenant
    ? registryOptions(options.isAdmin, slug, tenant, options.agents)
    : []
  const ready = slug && tenant && visibility

  return (
    <div class='space-y-6'>
      <div class='flex items-center gap-2'>
        <h2 class='text-lg font-semibold'>Copy Agent</h2>
      </div>

      <div class='space-y-4'>
        <Step number={1} label='Agent' active complete={!!slug}>
          <select
            value={slug}
            onChange={(e) => selectSlug((e.target as HTMLSelectElement).value)}
            class='w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500'
          >
            <option value=''>Select an agent…</option>
            {uniqueSlugs.map((a) => (
              <option key={a.slug} value={a.slug}>
                {a.name} ({a.slug})
              </option>
            ))}
          </select>
          {selected && (
            <p class='mt-1 text-xs text-gray-500'>
              Source: {selected.tenantId} / {selected.visibility}
            </p>
          )}
        </Step>

        <Step number={2} label='Tenant' active={!!slug} complete={!!tenant}>
          <select
            value={tenant}
            onChange={(e) =>
              selectTenant((e.target as HTMLSelectElement).value)}
            disabled={!slug}
            class='w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-40'
          >
            <option value=''>Select a tenant…</option>
            {options.tenants.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </Step>

        <Step
          number={3}
          label='Registry'
          active={!!slug && !!tenant}
          complete={!!visibility}
        >
          {regs.length <= 1
            ? (
              <p class='text-sm text-gray-600'>
                {visibility
                  ? `${visibility} registry`
                  : 'Select an agent and tenant first'}
              </p>
            )
            : (
              <select
                value={visibility}
                onChange={(e) =>
                  selectVisibility(
                    (e.target as HTMLSelectElement).value,
                  )}
                class='w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500'
              >
                <option value=''>Select a registry…</option>
                {regs.map((r) => (
                  <option key={r} value={r}>
                    {r.charAt(0).toUpperCase() + r.slice(1)}
                  </option>
                ))}
              </select>
            )}
        </Step>
      </div>

      <div class='flex gap-3'>
        <button
          type='button'
          onClick={handlePreview}
          disabled={loading || !ready}
          class='px-4 py-2 bg-gray-600 text-white text-sm rounded-lg hover:bg-gray-700 disabled:opacity-50'
        >
          Preview
        </button>
        {preview && (
          <button
            type='button'
            onClick={handleCopy}
            disabled={loading}
            class='px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50'
          >
            Execute Copy
          </button>
        )}
      </div>

      {error && (
        <div class='p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700'>
          {error}
        </div>
      )}

      {preview && (
        <div class='space-y-3'>
          <h3 class='text-sm font-medium text-gray-700'>
            Items to copy:
          </h3>
          <div class='border border-gray-200 rounded-lg divide-y divide-gray-100'>
            {preview.map((item) => (
              <div
                key={item.id}
                class='flex items-center justify-between px-4 py-2 text-sm'
              >
                <span>
                  <span class='font-mono text-xs bg-gray-100 px-1 rounded'>
                    {item.type}
                  </span>{' '}
                  {item.label}
                </span>
                {item.isConflict && (
                  <span class='text-amber-600 text-xs'>conflict</span>
                )}
              </div>
            ))}
          </div>
          {warnings.length > 0 && (
            <div class='p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-700'>
              <strong>Warnings:</strong>
              <ul class='mt-1 list-disc list-inside'>
                {warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}

      {report && (
        <div class='p-4 bg-green-50 border border-green-200 rounded-lg'>
          <h3 class='text-sm font-medium text-green-800 mb-2'>
            Copy Complete
          </h3>
          <dl class='grid grid-cols-3 gap-2 text-sm text-green-700'>
            <dt>Copied</dt>
            <dd>{report.copied}</dd>
            <dt>Overwritten</dt>
            <dd>{report.overwritten}</dd>
            <dt>Failures</dt>
            <dd>{report.failures}</dd>
          </dl>
          {report.warnings.length > 0 && (
            <div class='mt-3 text-sm text-amber-700'>
              <strong>Follow-up warnings:</strong>
              <ul class='mt-1 list-disc list-inside'>
                {report.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Step(
  { number, label, active, complete, children }: {
    number: number
    label: string
    active: boolean
    complete: boolean
    children: preact.ComponentChildren
  },
) {
  const ring = complete
    ? 'border-blue-500 bg-blue-50'
    : active
    ? 'border-gray-300 bg-white'
    : 'border-gray-200 bg-gray-50'
  const badge = complete
    ? 'bg-blue-500 text-white'
    : 'bg-gray-200 text-gray-600'

  return (
    <div class={`border rounded-lg p-4 ${ring}`}>
      <div class='flex items-center gap-2 mb-2'>
        <span
          class={`inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold ${badge}`}
        >
          {number}
        </span>
        <span class='text-sm font-medium text-gray-700'>{label}</span>
      </div>
      <div class={active ? '' : 'opacity-40 pointer-events-none'}>
        {children}
      </div>
    </div>
  )
}
