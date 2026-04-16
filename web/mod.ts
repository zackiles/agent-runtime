import type { Page } from './src/pages.ts'
import { pages, visible } from './src/pages.ts'

type UserContext = {
  email: string
  isAdmin: boolean
  tenantId: string
}

type RenderOptions = {
  email: string
  isAdmin: boolean
  tenantId: string
  tenants?: string[]
}

type Options = {
  distPath?: string
}

type WebModule = {
  serveStatic: (file: string) => Promise<Response>
  renderPage: (pagePath: string, options: RenderOptions) => string
}

const MIME: Record<string, string> = {
  css: 'text/css',
  js: 'application/javascript',
  mjs: 'application/javascript',
  json: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  ico: 'image/x-icon',
  html: 'text/html',
}

function pageContent(path: string, isAdmin: boolean): string {
  for (const page of pages) {
    if (path.startsWith(page.path) || path === '/' || path === '') {
      if (page.adminOnly && !isAdmin) break
      return `<div data-island="${page.island}"></div>`
    }
  }
  return '<div data-island="registry-status"></div>'
}

function navLink(page: Page, pagePath: string): string {
  if (page.id === 'me' || page.id === 'settings') return ''
  const active = pagePath.startsWith(`/${page.id}`) ||
    (page.id === 'registry' && (pagePath === '/' || pagePath === ''))
  const base = 'px-3 py-1.5 rounded-md text-sm font-medium transition-colors'
  const cls = active
    ? `${base} text-gray-900 bg-gray-100 font-semibold`
    : `${base} text-gray-500 hover:text-gray-900 hover:bg-gray-50`
  const admin = page.adminOnly ? ' data-admin-only' : ''
  return `<a href="/web${page.path}" data-nav="${page.id}" data-group="${page.group}"${admin} class="${cls}">${page.label}</a>`
}

function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function escScript(s: string): string {
  return s.replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
}

function tenantOptions(
  tenants: string[],
  active: string,
): string {
  return tenants
    .map((t) => {
      const sel = t === active ? ' selected' : ''
      const safe = escAttr(t)
      return `<option value="${safe}"${sel}>${safe}</option>`
    })
    .join('\n              ')
}

function shell(options: RenderOptions, pagePath: string): string {
  const safeEmail = escAttr(options.email)
  const user: UserContext = {
    email: options.email,
    isAdmin: options.isAdmin,
    tenantId: options.tenantId,
  }
  const tenants = options.tenants ?? [options.tenantId]
  const allPages = visible(options.isAdmin)
  const mainPages = allPages.filter((p) => p.group === 'main')
  const utilPages = allPages.filter((p) => p.group === 'utility')

  const mainHtml = mainPages
    .map((p) => navLink(p, pagePath))
    .join('\n            ')
  const utilHtml = utilPages
    .map((p) => navLink(p, pagePath))
    .join('\n            ')

  const singleTenant = tenants.length <= 1

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agent Runtime</title>
  <link rel="stylesheet" href="/web/static/index.css">
  <style>
    [data-island]:empty { display: none; }
    #mobile-menu { display: none; }
    #mobile-menu.open { display: block; }
  </style>
</head>
<body class="bg-gray-50 text-gray-900 min-h-screen">
  <nav class="bg-white border-b border-gray-200 sticky top-0 z-50">
    <div class="max-w-7xl mx-auto px-4 sm:px-6">
      <div class="flex items-center justify-between h-14">
        <div class="flex items-center gap-3 md:hidden">
          <a href="/web/me" class="shrink-0" title="${safeEmail}">
            <img
              data-avatar
              data-email="${safeEmail}"
              alt=""
              class="h-8 w-8 rounded-full ring-2 ring-gray-200 hover:ring-blue-400 transition-all object-cover"
            >
          </a>
          <a href="/web/" class="flex items-center gap-2 shrink-0">
            <img src="/web/static/logo.png" alt="" class="h-7 w-auto">
          </a>
        </div>

        <a href="/web/" class="hidden md:flex items-center gap-2 shrink-0">
          <img src="/web/static/logo.png" alt="" class="h-7 w-auto">
          <span class="text-sm font-semibold text-gray-800">Agent Runtime</span>
        </a>

        <div class="hidden md:flex items-center gap-0.5" id="nav-links">
          ${mainHtml}
          ${
    utilPages.length
      ? `<span class="mx-1.5 h-4 w-px bg-gray-200"></span>\n            ${utilHtml}`
      : ''
  }
        </div>

        <div class="flex items-center gap-3">
          <div class="hidden md:flex flex-col items-end">
            <select id="tenant-select"
              ${singleTenant ? 'disabled' : ''}
              class="text-xs border border-gray-200 rounded-md px-2 py-1 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer disabled:opacity-60 disabled:cursor-default">
              ${tenantOptions(tenants, options.tenantId)}
            </select>
            <div class="flex items-center gap-1 mt-0.5">
              ${
    options.isAdmin
      ? '<a href="/web/settings" data-nav="settings" data-admin-only class="text-[10px] text-gray-400 hover:text-gray-600 transition-colors">settings</a><span class="text-[10px] text-gray-300">/</span>'
      : ''
  }<a href="/web/docs" data-nav="docs" class="text-[10px] text-gray-400 hover:text-gray-600 transition-colors">help</a>
            </div>
          </div>
          <select id="tenant-select-mobile"
            ${singleTenant ? 'disabled' : ''}
            class="md:hidden text-xs border border-gray-200 rounded-md px-2 py-1 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer disabled:opacity-60 disabled:cursor-default">
            ${tenantOptions(tenants, options.tenantId)}
          </select>
          <a href="/web/me" data-nav="me" class="hidden md:block shrink-0" title="${safeEmail}">
            <img
              data-avatar
              data-email="${safeEmail}"
              alt=""
              class="h-8 w-8 rounded-full ring-2 ring-gray-200 hover:ring-blue-400 transition-all object-cover"
            >
          </a>
          <button id="mobile-toggle" class="md:hidden p-1 rounded-md text-gray-500 hover:text-gray-700 hover:bg-gray-100" aria-label="Menu">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"/>
            </svg>
          </button>
        </div>
      </div>
    </div>

    <div id="mobile-menu" class="md:hidden border-t border-gray-100 bg-white">
      <div class="px-4 py-3 space-y-1" id="mobile-nav-links">
        ${
    mainPages.map((p) => {
      const active = pagePath.startsWith(`/${p.id}`)
      const cls = active
        ? 'block px-3 py-2 rounded-md text-sm font-semibold text-gray-900 bg-gray-100'
        : 'block px-3 py-2 rounded-md text-sm text-gray-600 hover:bg-gray-50'
      const admin = p.adminOnly ? ' data-admin-only' : ''
      return `<a href="/web${p.path}" data-nav="${p.id}" data-group="${p.group}"${admin} class="${cls}">${p.label}</a>`
    }).join('\n        ')
  }
        ${
    utilPages.length
      ? `<div class="border-t border-gray-100 mt-2 pt-2">
          ${
        utilPages.map((p) => {
          const active = pagePath.startsWith(`/${p.id}`)
          const cls = active
            ? 'block px-3 py-2 rounded-md text-sm font-semibold text-gray-900 bg-gray-100'
            : 'block px-3 py-2 rounded-md text-sm text-gray-600 hover:bg-gray-50'
          const admin = p.adminOnly ? ' data-admin-only' : ''
          return `<a href="/web${p.path}" data-nav="${p.id}" data-group="${p.group}"${admin} class="${cls}">${p.label}</a>`
        }).join('\n          ')
      }
        </div>`
      : ''
  }
      </div>
    </div>
  </nav>
  <main class="max-w-7xl mx-auto px-4 sm:px-6 py-6" id="app">
    ${pageContent(pagePath, options.isAdmin)}
  </main>
  <script>
    window.__AR__ = ${escScript(JSON.stringify({ user, tenants }))};
    (function(){
      var SIZE = 64;
      var email = (window.__AR__.user.email || '').trim().toLowerCase();
      var key = 'ar_avatar_' + email;
      var cached = localStorage.getItem(key);
      function apply(url) {
        document.querySelectorAll('[data-avatar]').forEach(function(el) {
          el.src = url;
        });
      }
      if (cached) { apply(cached); }
      if (email) {
        crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(email)
        ).then(function(buf) {
          var hex = Array.from(new Uint8Array(buf))
            .map(function(b) { return b.toString(16).padStart(2, '0'); })
            .join('');
          var url = 'https://www.gravatar.com/avatar/' + hex + '?s=' + SIZE + '&d=mp';
          localStorage.setItem(key, url);
          apply(url);
        });
      }
    })();
  </script>
  <script type="module" src="/web/static/entry.js"></script>
</body>
</html>`
}

export function create(options: Options = {}): WebModule {
  const dist = options.distPath ||
    new URL('./dist/', import.meta.url).pathname

  return {
    async serveStatic(file: string): Promise<Response> {
      try {
        const resolved = new URL(file, `file://${dist}`).pathname
        if (!resolved.startsWith(dist)) {
          return new Response('Forbidden', { status: 403 })
        }
        const data = await Deno.readFile(resolved)
        const ext = file.split('.').pop() || ''
        return new Response(data, {
          headers: {
            'Content-Type': MIME[ext] || 'application/octet-stream',
          },
        })
      } catch {
        return new Response('Not found', { status: 404 })
      }
    },

    renderPage(pagePath: string, options: RenderOptions): string {
      return shell(options, pagePath)
    },
  }
}

export type { Options, RenderOptions, UserContext, WebModule }
