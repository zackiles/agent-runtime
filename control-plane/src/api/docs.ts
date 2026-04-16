import { Hono } from '@hono/hono'
import type { Env } from '../types.ts'
import { basename, dirname, extname, join, relative } from '@std/path'
import { walk } from '@std/fs'

type DocNode = {
  label: string
  path: string
  children?: DocNode[]
}

const REPO_ROOT = new URL('../../..', import.meta.url).pathname

function docsRoot(): string {
  return join(REPO_ROOT, 'docs')
}

function readmeRoot(): string {
  return REPO_ROOT
}

function labelFromFile(name: string): string {
  return name
    .replace(/\.md$/i, '')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

async function buildTree(): Promise<DocNode[]> {
  const root = docsRoot()
  const files: { rel: string; dir: string }[] = []

  try {
    for await (
      const entry of walk(root, {
        exts: ['.md'],
        includeDirs: false,
      })
    ) {
      const rel = relative(root, entry.path)
      const dir = dirname(rel) === '.' ? '' : dirname(rel)
      files.push({ rel, dir })
    }
  } catch {
    return []
  }

  files.sort((a, b) => a.rel.localeCompare(b.rel))

  const dirSet = new Set<string>()
  for (const f of files) {
    if (f.dir) dirSet.add(f.dir)
  }

  const topLevel: DocNode[] = [
    { label: 'README', path: 'README' },
  ]

  const dirNodes = new Map<string, DocNode>()
  for (const d of [...dirSet].sort()) {
    const node: DocNode = {
      label: labelFromFile(d),
      path: '',
      children: [],
    }
    dirNodes.set(d, node)
    topLevel.push(node)
  }

  for (const f of files) {
    const node: DocNode = {
      label: labelFromFile(basename(f.rel)),
      path: f.rel.replace(/\.md$/i, ''),
    }
    if (f.dir && dirNodes.has(f.dir)) {
      dirNodes.get(f.dir)!.children!.push(node)
    } else {
      topLevel.push(node)
    }
  }

  return topLevel
}

const app = new Hono<Env>()

app.get('/tree', async (c) => {
  const tree = await buildTree()
  return c.json(tree)
})

app.get('/render/*', async (c) => {
  const docPath = c.req.path.replace(/^\/api\/docs\/render\/?/, '')
  if (!docPath || docPath.includes('..')) {
    return c.text('Not found', 404)
  }

  let filePath: string
  if (docPath === 'README') {
    filePath = join(readmeRoot(), 'README.md')
  } else {
    filePath = join(docsRoot(), `${docPath}.md`)
  }

  let content: string
  try {
    content = await Deno.readTextFile(filePath)
  } catch {
    return c.text('Not found', 404)
  }

  const { render } = await import('@deno/gfm')
  const html = render(content)
  return c.html(html)
})

const ASSET_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
}

app.get('/assets/*', async (c) => {
  const assetPath = c.req.path.replace(/^\/api\/docs\/assets\/?/, '')
  if (!assetPath || assetPath.includes('..')) {
    return c.text('Not found', 404)
  }

  const filePath = join(docsRoot(), 'assets', assetPath)
  const ext = extname(assetPath).toLowerCase()
  const mime = ASSET_MIME[ext] || 'application/octet-stream'

  try {
    const data = await Deno.readFile(filePath)
    return new Response(data, {
      headers: {
        'Content-Type': mime,
        'Cache-Control': 'public, max-age=86400',
      },
    })
  } catch {
    return c.text('Not found', 404)
  }
})

export default app
