import { useEffect, useRef, useState } from 'preact/hooks'
import { api } from '../api.ts'

type DocTree = {
  label: string
  path: string
  children?: DocTree[]
}

function Sidebar({
  tree,
  active,
}: {
  tree: DocTree[]
  active: string
}) {
  return (
    <nav class='w-56 shrink-0 pr-4 border-r border-gray-200 overflow-y-auto text-sm'>
      {tree.map((node) => (
        <SidebarNode
          node={node}
          active={active}
          depth={0}
        />
      ))}
    </nav>
  )
}

function SidebarNode({
  node,
  active,
  depth,
}: {
  node: DocTree
  active: string
  depth: number
}) {
  const isActive = active === node.path
  const hasChildren = node.children && node.children.length > 0

  return (
    <div style={{ paddingLeft: `${depth * 12}px` }}>
      {node.path
        ? (
          <a
            href={`/web/docs/${node.path}`}
            class={`block py-1 px-2 rounded transition-colors ${
              isActive
                ? 'text-blue-700 bg-blue-50 font-medium'
                : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
            }`}
          >
            {node.label}
          </a>
        )
        : (
          <span class='block py-1 px-2 text-xs font-semibold text-gray-400 uppercase tracking-wider mt-3 first:mt-0'>
            {node.label}
          </span>
        )}
      {hasChildren &&
        node.children!.map((child) => (
          <SidebarNode node={child} active={active} depth={depth + 1} />
        ))}
    </div>
  )
}

function scrollToHash() {
  const hash = globalThis.location.hash
  if (!hash) return
  const el = document.getElementById(hash.slice(1))
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

let mermaidLoaded: Promise<void> | null = null

function loadMermaid(): Promise<void> {
  if (mermaidLoaded) return mermaidLoaded
  mermaidLoaded = new Promise((resolve) => {
    const script = document.createElement('script')
    script.src = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js'
    script.onload = () => {
      // deno-lint-ignore no-explicit-any
      ;(globalThis as any).mermaid.initialize({
        startOnLoad: false,
        theme: 'neutral',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      })
      resolve()
    }
    document.head.appendChild(script)
  })
  return mermaidLoaded
}

const MERMAID_KEYWORDS =
  /^(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|gitGraph|journey|mindmap|timeline|quadrantChart|sankey|xychart|block)\b/

async function renderMermaid(container: HTMLElement) {
  const candidates: HTMLElement[] = []

  container.querySelectorAll(
    'pre > code.language-mermaid, pre > code.highlight-source-mermaid',
  ).forEach((el) => candidates.push(el as HTMLElement))

  container.querySelectorAll('pre > code').forEach((el) => {
    if (candidates.includes(el as HTMLElement)) return
    const text = (el.textContent || '').trim()
    if (MERMAID_KEYWORDS.test(text)) candidates.push(el as HTMLElement)
  })

  if (candidates.length === 0) return

  await loadMermaid()
  // deno-lint-ignore no-explicit-any
  const mermaid = (globalThis as any).mermaid

  for (let i = 0; i < candidates.length; i++) {
    const code = candidates[i]
    const pre = code.parentElement!
    const source = code.textContent || ''
    try {
      const id = `mermaid-${Date.now()}-${i}`
      const { svg } = await mermaid.render(id, source)
      const wrapper = document.createElement('div')
      wrapper.className = 'mermaid-diagram'
      wrapper.innerHTML = svg
      pre.replaceWith(wrapper)
    } catch {
      // leave the code block as-is on render failure
    }
  }
}

function rewriteLinks(container: HTMLElement, docPath: string) {
  container.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href') || ''
    if (href.startsWith('#')) {
      a.addEventListener('click', (e) => {
        e.preventDefault()
        const el = document.getElementById(href.slice(1))
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'start' })
          history.replaceState(null, '', href)
        }
      })
      return
    }
    const mdMatch = href.match(
      /^(?:\.\/)?([a-zA-Z0-9_/-]+)\.md(#[a-zA-Z0-9_-]+)?$/,
    )
    if (mdMatch) {
      const target = mdMatch[1]
      const hash = mdMatch[2] || ''
      a.setAttribute('href', `/web/docs/${target}${hash}`)
    }
  })

  container.querySelectorAll('img[src]').forEach((img) => {
    const src = img.getAttribute('src') || ''
    if (src.startsWith('http') || src.startsWith('/api/')) return
    const resolved = resolveAssetPath(src, docPath)
    if (resolved) img.setAttribute('src', resolved)
  })
}

function resolveAssetPath(src: string, docPath: string): string | null {
  const assetsMatch = src.match(
    /^(?:\.\/)?(?:\.\.\/)*(?:docs\/)?assets\/(.+)$/,
  )
  if (assetsMatch) return `/api/docs/assets/${assetsMatch[1]}`

  if (docPath && docPath !== 'README' && !src.startsWith('/')) {
    const dir = docPath.replace(/\/[^/]+$/, '')
    const assetInDir = `${dir}/${src}`.replace(
      /^(?:\.\.\/)*(?:docs\/)?assets\//,
      '',
    )
    if (src.includes('assets/')) {
      return `/api/docs/assets/${assetInDir.replace(/^.*assets\//, '')}`
    }
  }

  return null
}

export function Docs() {
  const [tree, setTree] = useState<DocTree[]>([])
  const [html, setHtml] = useState('')
  const [loading, setLoading] = useState(true)
  const contentRef = useRef<HTMLDivElement>(null)

  const path = globalThis.location.pathname
    .replace(/^\/web\/docs\/?/, '')
    .replace(/\/$/, '')

  useEffect(() => {
    api('/api/docs/tree')
      .then((r) => r.json())
      .then((data) => setTree(data))
      .catch(() => {})
  }, [])

  useEffect(() => {
    setLoading(true)
    const docPath = path || 'README'
    api(`/api/docs/render/${docPath}`)
      .then((r) => {
        if (!r.ok) throw new Error(r.statusText)
        return r.text()
      })
      .then((h) => {
        setHtml(h)
        setLoading(false)
      })
      .catch(() => {
        setHtml('<p class="text-gray-500">Document not found.</p>')
        setLoading(false)
      })
  }, [path])

  useEffect(() => {
    if (loading || !contentRef.current) return
    const el = contentRef.current
    rewriteLinks(el, path || 'README')
    renderMermaid(el)
    requestAnimationFrame(scrollToHash)
  }, [loading, html])

  return (
    <div>
      <h1 class='text-lg font-semibold text-gray-900 mb-4'>Documentation</h1>
      <div class='flex gap-6 min-h-[60vh]'>
        <Sidebar tree={tree} active={path || 'README'} />
        <article class='flex-1 min-w-0 overflow-x-auto'>
          {loading ? <p class='text-gray-400 text-sm'>Loading...</p> : (
            <div
              ref={contentRef}
              class='markdown-body'
              dangerouslySetInnerHTML={{ __html: html }}
            />
          )}
        </article>
      </div>
    </div>
  )
}
