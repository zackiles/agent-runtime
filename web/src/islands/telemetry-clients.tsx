import { useEffect, useState } from 'preact/hooks'
import { api } from '../api.ts'

type Client = {
  id: string
  name: string
  keyPrefix: string
  keyLastFour: string
  createdBy: string
  createdAt: string
  lastUsedAt: string | null
  revoked: boolean
}

type Reveal = { name: string; key: string }

function fingerprint(c: Client): string {
  return `${c.keyPrefix}.\u2026${c.keyLastFour}`
}

function formatDate(value: string | null): string {
  if (!value) return '\u2014'
  return new Date(value).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function TelemetryClients() {
  const [clients, setClients] = useState<Client[]>([])
  const [loading, setLoading] = useState(true)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [reveal, setReveal] = useState<Reveal | null>(null)

  function load() {
    setLoading(true)
    api('/telemetry/clients')
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setClients(d as Client[]))
      .catch(() => setClients([]))
      .finally(() => setLoading(false))
  }

  useEffect(load, [])

  async function create(e: Event) {
    e.preventDefault()
    if (!name.trim() || busy) return
    setBusy(true)
    setError('')
    try {
      const res = await api('/telemetry/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Failed to create client')
        return
      }
      setReveal({ name: data.client.name, key: data.key })
      setName('')
      load()
    } finally {
      setBusy(false)
    }
  }

  async function rotate(c: Client) {
    if (
      !confirm(`Rotate the key for "${c.name}"? The old key stops working.`)
    ) {
      return
    }
    const res = await api(`/telemetry/clients/${c.id}/rotate`, {
      method: 'POST',
    })
    if (!res.ok) return
    const data = await res.json()
    setReveal({ name: data.client.name, key: data.key })
    load()
  }

  async function remove(c: Client) {
    if (
      !confirm(`Delete client "${c.name}"? Its key is revoked immediately.`)
    ) {
      return
    }
    const res = await api(`/telemetry/clients/${c.id}`, { method: 'DELETE' })
    if (res.ok) load()
  }

  return (
    <div class='space-y-4'>
      <form onSubmit={create} class='flex items-center gap-2 flex-wrap'>
        <input
          type='text'
          placeholder='Client name (e.g. checkout-svc)'
          value={name}
          onInput={(e) => setName((e.target as HTMLInputElement).value)}
          class='px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 flex-1 min-w-[200px] max-w-md'
        />
        <button
          type='submit'
          disabled={busy || !name.trim()}
          class='px-3 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-40 transition-colors'
        >
          Create client
        </button>
        {error && <span class='text-xs text-red-600'>{error}</span>}
      </form>

      <div class='bg-white border border-gray-200 rounded-xl overflow-hidden'>
        <div class='overflow-x-auto'>
          <table class='w-full text-sm'>
            <thead>
              <tr class='border-b border-gray-200 bg-gray-50 text-left text-xs font-medium text-gray-500 uppercase tracking-wider'>
                <th class='py-2.5 px-3'>Name</th>
                <th class='py-2.5 px-3'>Key</th>
                <th class='py-2.5 px-3'>Created by</th>
                <th class='py-2.5 px-3'>Created</th>
                <th class='py-2.5 px-3'>Last used</th>
                <th class='py-2.5 px-3'>Status</th>
                <th class='py-2.5 px-3 text-right'>Actions</th>
              </tr>
            </thead>
            <tbody class='divide-y divide-gray-50'>
              {clients.map((c) => (
                <tr key={c.id} class={c.revoked ? 'opacity-50' : ''}>
                  <td class='py-2 px-3 font-medium text-gray-900'>{c.name}</td>
                  <td class='py-2 px-3 font-mono text-xs text-gray-600'>
                    {fingerprint(c)}
                  </td>
                  <td class='py-2 px-3 text-xs text-gray-600'>{c.createdBy}</td>
                  <td class='py-2 px-3 text-xs text-gray-500'>
                    {formatDate(c.createdAt)}
                  </td>
                  <td class='py-2 px-3 text-xs text-gray-500'>
                    {formatDate(c.lastUsedAt)}
                  </td>
                  <td class='py-2 px-3'>
                    <span
                      class={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
                        c.revoked
                          ? 'bg-red-50 text-red-700'
                          : 'bg-green-50 text-green-700'
                      }`}
                    >
                      {c.revoked ? 'Revoked' : 'Active'}
                    </span>
                  </td>
                  <td class='py-2 px-3 text-right whitespace-nowrap'>
                    {!c.revoked && (
                      <>
                        <button
                          type='button'
                          onClick={() => rotate(c)}
                          class='text-xs text-gray-500 hover:text-gray-900 mr-3'
                        >
                          Rotate
                        </button>
                        <button
                          type='button'
                          onClick={() =>
                            remove(c)}
                          class='text-xs text-red-500 hover:text-red-700'
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {!loading && clients.length === 0 && (
                <tr>
                  <td colSpan={7} class='py-12 text-center text-gray-400'>
                    No telemetry clients yet. Create one to mint an API key.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {reveal && <KeyModal reveal={reveal} onClose={() => setReveal(null)} />}
    </div>
  )
}

function KeyModal({
  reveal,
  onClose,
}: {
  reveal: Reveal
  onClose: () => void
}) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    await navigator.clipboard.writeText(reveal.key)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div class='fixed inset-0 bg-black/40 grid place-items-center z-50 p-4'>
      <div class='bg-white rounded-xl shadow-xl max-w-lg w-full p-5 space-y-4'>
        <div>
          <h3 class='text-lg font-semibold text-gray-900'>
            API key for "{reveal.name}"
          </h3>
          <p class='text-sm text-amber-700 mt-1'>
            Copy this key now. For security it is shown once and cannot be
            retrieved again.
          </p>
        </div>
        <div class='flex items-stretch gap-2'>
          <code class='flex-1 px-3 py-2 bg-gray-900 text-gray-100 rounded-lg text-xs font-mono break-all'>
            {reveal.key}
          </code>
          <button
            type='button'
            onClick={copy}
            class='px-3 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 transition-colors whitespace-nowrap'
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <div class='text-right'>
          <button
            type='button'
            onClick={onClose}
            class='px-3 py-2 text-sm text-gray-600 hover:text-gray-900'
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
