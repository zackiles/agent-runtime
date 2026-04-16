import { useState } from 'preact/hooks'
import { api } from './api.ts'

type AppContext = {
  user: { email: string; isAdmin: boolean; tenantId: string }
  switchTenant: (tenantId: string) => Promise<void>
}

function useApp(): AppContext {
  // deno-lint-ignore no-explicit-any
  const ar = (globalThis as any).__AR__
  const [tenantId, setTenantId] = useState<string>(
    ar?.user?.tenantId ?? '',
  )

  async function switchTenant(id: string) {
    const res = await api('/api/user/tenant', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId: id }),
    })
    if (!res.ok) throw new Error('Failed to switch tenant')
    if (ar?.user) ar.user.tenantId = id
    setTenantId(id)
    globalThis.location.reload()
  }

  return {
    user: {
      ...(ar?.user ?? { email: '', isAdmin: false }),
      tenantId,
    },
    switchTenant,
  }
}

export { useApp }
export type { AppContext }
