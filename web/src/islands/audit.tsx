import { useEffect, useState } from 'preact/hooks'
import { api } from '../api.ts'

type AuditEntry = {
  id: number
  entityType: string
  entityId: string
  action: string
  actorId: string | null
  metadata: Record<string, unknown> | null
  createdAt: string
}

export function Audit() {
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<number | null>(null)
  const [entityType, setEntityType] = useState('')
  const [action, setAction] = useState('')

  useEffect(() => {
    api('/audit')
      .then((r) => r.json())
      .then((d) => setEntries(d as AuditEntry[]))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const filtered = entries.filter((e) => {
    if (entityType && e.entityType !== entityType) return false
    if (action && e.action !== action) return false
    return true
  })

  const today = new Date().toDateString()
  const todayCount = entries.filter(
    (e) => new Date(e.createdAt).toDateString() === today,
  ).length

  function formatTime(iso: string): string {
    try {
      return new Date(iso).toLocaleString()
    } catch {
      return iso
    }
  }

  return (
    <div class='space-y-6'>
      <div>
        <div class='flex items-center gap-2'>
          <h2 class='text-lg font-semibold'>Audit Log</h2>
        </div>
        {entries.length > 0 && (
          <p class='text-xs text-gray-500 mt-1 ml-4'>
            {entries.length} events &middot; {todayCount} today
          </p>
        )}
      </div>

      <div class='flex flex-wrap gap-3'>
        <select
          value={entityType}
          onChange={(e) => setEntityType((e.target as HTMLSelectElement).value)}
          class='px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500'
        >
          <option value=''>All Types</option>
          <option value='agent'>Agent</option>
          <option value='tool'>Tool</option>
          <option value='skill'>Skill</option>
          <option value='rule'>Rule</option>
          <option value='team'>Team</option>
        </select>
        <select
          value={action}
          onChange={(e) => setAction((e.target as HTMLSelectElement).value)}
          class='px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500'
        >
          <option value=''>All Actions</option>
          <option value='created'>Created</option>
          <option value='updated'>Updated</option>
          <option value='deleted'>Deleted</option>
          <option value='deployed'>Deployed</option>
          <option value='copied'>Copied</option>
        </select>
      </div>

      {loading
        ? (
          <div class='text-center py-12 text-gray-400'>
            Loading audit log...
          </div>
        )
        : (
          <div class='bg-white border border-gray-200 rounded-xl overflow-hidden'>
            <table class='w-full text-sm'>
              <thead>
                <tr class='border-b border-gray-200 bg-gray-50'>
                  <th class='text-left py-3 px-4 text-xs font-medium text-gray-500 uppercase tracking-wider'>
                    Time
                  </th>
                  <th class='text-left py-3 px-4 text-xs font-medium text-gray-500 uppercase tracking-wider'>
                    Type
                  </th>
                  <th class='text-left py-3 px-4 text-xs font-medium text-gray-500 uppercase tracking-wider'>
                    Entity
                  </th>
                  <th class='text-left py-3 px-4 text-xs font-medium text-gray-500 uppercase tracking-wider'>
                    Action
                  </th>
                  <th class='text-left py-3 px-4 text-xs font-medium text-gray-500 uppercase tracking-wider'>
                    Actor
                  </th>
                </tr>
              </thead>
              <tbody class='divide-y divide-gray-100'>
                {filtered.map((e) => [
                  <tr
                    key={e.id}
                    class={`hover:bg-gray-50 cursor-pointer transition-colors ${
                      expanded === e.id ? 'bg-gray-50' : ''
                    }`}
                    onClick={() => setExpanded(expanded === e.id ? null : e.id)}
                  >
                    <td class='py-3 px-4 text-gray-600 whitespace-nowrap'>
                      {formatTime(e.createdAt)}
                    </td>
                    <td class='py-3 px-4'>
                      <span class='px-2 py-0.5 bg-gray-100 rounded text-xs font-medium'>
                        {e.entityType}
                      </span>
                    </td>
                    <td class='py-3 px-4 text-gray-900 font-mono text-xs'>
                      {e.entityId}
                    </td>
                    <td class='py-3 px-4'>
                      <span
                        class={`text-xs font-medium ${
                          e.action === 'deployed'
                            ? 'text-green-600'
                            : e.action === 'deleted'
                            ? 'text-red-600'
                            : e.action === 'created'
                            ? 'text-blue-600'
                            : 'text-gray-600'
                        }`}
                      >
                        {e.action}
                      </span>
                    </td>
                    <td class='py-3 px-4 text-gray-600'>
                      {e.actorId || '\u2014'}
                    </td>
                  </tr>,
                  expanded === e.id && e.metadata && (
                    <tr key={`${e.id}-meta`}>
                      <td
                        colSpan={5}
                        class='px-4 py-3 bg-gray-50 border-t border-gray-100'
                      >
                        <pre class='text-xs text-gray-600 font-mono whitespace-pre-wrap'>
                        {JSON.stringify(e.metadata, null, 2)}
                        </pre>
                      </td>
                    </tr>
                  ),
                ])}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={5} class='py-8 text-center text-gray-400'>
                      No audit entries found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
    </div>
  )
}
