type Page = {
  id: string
  label: string
  path: string
  island: string
  adminOnly?: boolean
  group: 'main' | 'utility'
}

const pages: Page[] = [
  {
    id: 'registry',
    label: 'Registry',
    path: '/registry',
    island: 'registry-status',
    group: 'main',
  },
  {
    id: 'demos',
    label: 'Demo Agent',
    path: '/demos',
    island: 'demos',
    group: 'main',
  },
  {
    id: 'access',
    label: 'Access Agent',
    path: '/access',
    island: 'access',
    group: 'main',
  },
  {
    id: 'system',
    label: 'System',
    path: '/system',
    island: 'system',
    group: 'utility',
  },
  {
    id: 'artifacts',
    label: 'Artifacts',
    path: '/artifacts',
    island: 'artifacts',
    adminOnly: true,
    group: 'utility',
  },
  {
    id: 'telemetry',
    label: 'Telemetry',
    path: '/telemetry',
    island: 'telemetry',
    adminOnly: true,
    group: 'utility',
  },
  {
    id: 'audit',
    label: 'Audit',
    path: '/audit',
    island: 'audit',
    adminOnly: true,
    group: 'utility',
  },
  {
    id: 'settings',
    label: 'Settings',
    path: '/settings',
    island: 'settings',
    adminOnly: true,
    group: 'utility',
  },
  {
    id: 'docs',
    label: 'Help',
    path: '/docs',
    island: 'docs',
    group: 'utility',
  },
  {
    id: 'me',
    label: 'Me',
    path: '/me',
    island: 'me',
    group: 'utility',
  },
]

function visible(isAdmin: boolean): Page[] {
  return pages.filter((p) => {
    if (p.adminOnly && !isAdmin) return false
    return true
  })
}

export { pages, visible }
export type { Page }
