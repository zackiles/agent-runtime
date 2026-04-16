import './tailwind.css'
import { h, render } from 'preact'
import { pages } from './pages.ts'

function hydrate(selector: string, Component: () => preact.VNode) {
  const el = document.querySelector(selector)
  if (el) render(h(Component, null), el)
}

function updateNavTabs(isAdmin: boolean) {
  document.querySelectorAll('[data-admin-only]').forEach((el) => {
    ;(el as HTMLElement).style.display = isAdmin ? '' : 'none'
  })
}

function initMobileMenu() {
  const toggle = document.getElementById('mobile-toggle')
  const menu = document.getElementById('mobile-menu')
  if (!toggle || !menu) return

  toggle.addEventListener('click', () => {
    menu.classList.toggle('open')
    const isOpen = menu.classList.contains('open')
    toggle.setAttribute('aria-expanded', String(isOpen))
  })
}

function wireTenantSelect(sel: HTMLSelectElement) {
  const initial = sel.value
  sel.addEventListener('change', async () => {
    const tenantId = sel.value
    try {
      const res = await fetch('/api/user/tenant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ tenantId }),
      })
      if (res.ok) {
        globalThis.location.reload()
        return
      }
    } catch {
      // network error
    }
    sel.value = initial
  })
}

function initTenantSelector() {
  // deno-lint-ignore no-explicit-any
  const ar = (globalThis as any).__AR__
  const isAdmin = ar?.user?.isAdmin ?? false

  updateNavTabs(isAdmin)

  document.querySelectorAll<HTMLSelectElement>(
    '#tenant-select, #tenant-select-mobile',
  ).forEach((sel) => wireTenantSelect(sel))
}

const LEGACY_REDIRECTS: Record<string, string> = {
  '/agents': '/registry',
  '/copy': '/registry',
}

async function init() {
  const path = globalThis.location.pathname.replace(/^\/web/, '')

  for (const [from, to] of Object.entries(LEGACY_REDIRECTS)) {
    if (path === from || path.startsWith(from + '/')) {
      globalThis.location.replace(`/web${to}`)
      return
    }
  }

  for (const page of pages) {
    if (path.startsWith(page.path) || path === '/' || path === '') {
      const mod = await import(`./islands/${page.island}.tsx`)
      const Component = mod[Object.keys(mod)[0]]
      hydrate(`[data-island="${page.island}"]`, Component)
      break
    }
  }

  initMobileMenu()
  initTenantSelector()
}

init()
