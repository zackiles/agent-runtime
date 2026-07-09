import { listDemos, loadMeta } from '@ar/client/operations/demos'
import type { DemoMeta } from '@ar/client/operations/demos'
import { forMember } from '@ar/client/db/demo-shares'

type AccessRole = 'owner' | 'editor' | 'viewer' | 'admin'

type Access = { meta: DemoMeta; ownerId: string; role: AccessRole }

type Ambiguous = { ambiguous: true; owners: string[] }

type Action =
  | 'view'
  | 'update'
  | 'deploy'
  | 'stop'
  | 'download'
  | 'visibility'
  | 'manage-shares'
  | 'delete'

// Viewers may only view; owner, editor, and admin share the full per-demo
// capability set (delete included — see RFC-010 §4, guarded by a UI/Slack
// confirmation rather than a capability restriction).
function can(role: AccessRole, action: Action): boolean {
  if (role === 'viewer') return action === 'view'
  return true
}

function isAmbiguous(result: Access | Ambiguous | null): result is Ambiguous {
  return result !== null && 'ambiguous' in result
}

// owner (own demo wins unless a different owner is explicitly requested) →
// editor/viewer share → admin → null. The owner scope returned always drives
// downstream storage/deploy operations, never the caller's email.
async function resolveAccess(
  project: string,
  tenantId: string,
  email: string,
  isAdmin: boolean,
  slug: string,
  ownerHint?: string,
): Promise<Access | Ambiguous | null> {
  if (!ownerHint || ownerHint === email) {
    const own = await loadMeta(project, tenantId, email, slug)
    if (own) return { meta: own, ownerId: email, role: 'owner' }
  }

  const shares = forMember(tenantId, email).filter((s) => s.slug === slug)
  const candidates = ownerHint
    ? shares.filter((s) => s.ownerId === ownerHint)
    : shares

  if (candidates.length === 1) {
    const share = candidates[0]
    const meta = await loadMeta(project, tenantId, share.ownerId, slug)
    if (meta) return { meta, ownerId: share.ownerId, role: share.role }
  } else if (candidates.length > 1) {
    return { ambiguous: true, owners: candidates.map((s) => s.ownerId) }
  }

  if (isAdmin) {
    const all = await listDemos(project, tenantId)
    const match = all.find((d) =>
      d.name === slug && (!ownerHint || d.createdBy === ownerHint)
    )
    if (match) {
      return { meta: match, ownerId: match.createdBy || email, role: 'admin' }
    }
  }

  return null
}

export { can, isAmbiguous, resolveAccess }
export type { Access, AccessRole, Action, Ambiguous }
