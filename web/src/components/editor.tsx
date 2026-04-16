import { useRef, useState } from 'preact/hooks'

function renderMarkdown(md: string): string {
  let html = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  html = html.replace(
    /```(\w*)\n([\s\S]*?)```/g,
    (_m, lang, code) => {
      const l = lang
        ? `<span class="absolute top-1 right-2 text-[10px] text-gray-400 uppercase">${lang}</span>`
        : ''
      return `<div class="relative my-3"><pre class="bg-gray-900 text-gray-100 rounded-lg p-4 text-sm font-mono overflow-x-auto">${l}<code>${code.trimEnd()}</code></pre></div>`
    },
  )
  html = html.replace(
    /^### (.+)$/gm,
    '<h3 class="text-base font-semibold text-gray-800 mt-5 mb-1">$1</h3>',
  )
  html = html.replace(
    /^## (.+)$/gm,
    '<h2 class="text-lg font-semibold text-gray-800 mt-5 mb-2">$1</h2>',
  )
  html = html.replace(
    /^# (.+)$/gm,
    '<h1 class="text-xl font-bold text-gray-900 mt-5 mb-2">$1</h1>',
  )
  html = html.replace(
    /^---$/gm,
    '<hr class="my-4 border-gray-200" />',
  )
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  html = html.replace(
    /(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g,
    '<em>$1</em>',
  )
  html = html.replace(
    /`([^`]+)`/g,
    '<code class="px-1 py-0.5 bg-gray-100 rounded text-sm font-mono text-pink-600">$1</code>',
  )
  html = html.replace(
    /\{\{([^}]+)\}\}/g,
    '<span class="px-1.5 py-0.5 bg-blue-50 text-blue-700 border border-blue-200 rounded text-xs font-mono">{{$1}}</span>',
  )
  html = html.replace(
    /^\d+\. (.+)$/gm,
    '<li class="ml-6 list-decimal text-sm text-gray-700">$1</li>',
  )
  html = html.replace(
    /^- (.+)$/gm,
    '<li class="ml-6 list-disc text-sm text-gray-700">$1</li>',
  )
  html = html.replace(
    /\n\n/g,
    '</p><p class="text-sm text-gray-700 mb-2 leading-relaxed">',
  )
  html = `<p class="text-sm text-gray-700 mb-2 leading-relaxed">${html}</p>`
  return html
}

export function MarkdownEditor({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  const [preview, setPreview] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  function wrap(before: string, after: string) {
    const ta = textareaRef.current
    if (!ta) return
    const start = ta.selectionStart
    const end = ta.selectionEnd
    const selected = value.slice(start, end)
    const replacement = before + (selected || 'text') + after
    const next = value.slice(0, start) + replacement +
      value.slice(end)
    onChange(next)
    requestAnimationFrame(() => {
      ta.focus()
      const cs = start + before.length
      ta.setSelectionRange(
        cs,
        cs + (selected || 'text').length,
      )
    })
  }

  function prefix(linePrefix: string) {
    const ta = textareaRef.current
    if (!ta) return
    const start = ta.selectionStart
    const lineStart = value.lastIndexOf('\n', start - 1) + 1
    const next = value.slice(0, lineStart) + linePrefix +
      value.slice(lineStart)
    onChange(next)
    requestAnimationFrame(() => {
      ta.focus()
      ta.setSelectionRange(
        start + linePrefix.length,
        start + linePrefix.length,
      )
    })
  }

  function insertBlock(block: string) {
    const ta = textareaRef.current
    if (!ta) return
    const pos = ta.selectionEnd
    const pad = pos > 0 && value[pos - 1] !== '\n' ? '\n' : ''
    const next = value.slice(0, pos) + pad + block +
      value.slice(pos)
    onChange(next)
    requestAnimationFrame(() => {
      ta.focus()
      const np = pos + pad.length + block.length
      ta.setSelectionRange(np, np)
    })
  }

  function handleTab(e: KeyboardEvent) {
    if (e.key !== 'Tab') return
    e.preventDefault()
    const ta = textareaRef.current
    if (!ta) return
    const start = ta.selectionStart
    const end = ta.selectionEnd
    const next = value.slice(0, start) + '  ' + value.slice(end)
    onChange(next)
    requestAnimationFrame(() => {
      ta.focus()
      ta.setSelectionRange(start + 2, start + 2)
    })
  }

  const TB =
    'px-2 py-1.5 text-xs rounded hover:bg-gray-100 transition-colors text-gray-600 font-mono'

  return (
    <div class='border border-gray-300 rounded-lg overflow-hidden bg-white'>
      <div class='flex items-center justify-between border-b border-gray-200 bg-gray-50 px-2 py-1'>
        <div class='flex items-center gap-0.5'>
          <button
            type='button'
            class={TB}
            onClick={() => prefix('# ')}
            title='Heading 1'
          >
            H1
          </button>
          <button
            type='button'
            class={TB}
            onClick={() => prefix('## ')}
            title='Heading 2'
          >
            H2
          </button>
          <button
            type='button'
            class={TB}
            onClick={() => prefix('### ')}
            title='Heading 3'
          >
            H3
          </button>
          <span class='w-px h-4 bg-gray-300 mx-1' />
          <button
            type='button'
            class={TB}
            onClick={() => wrap('**', '**')}
            title='Bold'
          >
            <strong>B</strong>
          </button>
          <button
            type='button'
            class={TB}
            onClick={() => wrap('*', '*')}
            title='Italic'
          >
            <em>I</em>
          </button>
          <button
            type='button'
            class={TB}
            onClick={() => wrap('`', '`')}
            title='Inline code'
          >
            {'<>'}
          </button>
          <span class='w-px h-4 bg-gray-300 mx-1' />
          <button
            type='button'
            class={TB}
            onClick={() => prefix('- ')}
            title='Bullet list'
          >
            &bull;
          </button>
          <button
            type='button'
            class={TB}
            onClick={() => prefix('1. ')}
            title='Numbered list'
          >
            1.
          </button>
          <span class='w-px h-4 bg-gray-300 mx-1' />
          <button
            type='button'
            class={TB}
            onClick={() => insertBlock('```json\n\n```\n')}
            title='Code block'
          >
            {'{ }'}
          </button>
          <button
            type='button'
            class={TB}
            onClick={() => insertBlock('---\n')}
            title='Horizontal rule'
          >
            &#8213;
          </button>
        </div>
        <div class='flex gap-1'>
          <button
            type='button'
            onClick={() => setPreview(false)}
            class={`px-2.5 py-1 text-xs rounded ${
              !preview
                ? 'bg-white text-gray-800 font-medium shadow-sm border border-gray-200'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Write
          </button>
          <button
            type='button'
            onClick={() => setPreview(true)}
            class={`px-2.5 py-1 text-xs rounded ${
              preview
                ? 'bg-white text-gray-800 font-medium shadow-sm border border-gray-200'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Preview
          </button>
        </div>
      </div>
      {preview
        ? (
          <div
            class='min-h-[400px] max-h-[600px] px-5 py-4 overflow-y-auto'
            dangerouslySetInnerHTML={{
              __html: renderMarkdown(value),
            }}
          />
        )
        : (
          <textarea
            ref={textareaRef}
            value={value}
            onInput={(e) =>
              onChange(
                (e.target as HTMLTextAreaElement).value,
              )}
            onKeyDown={handleTab}
            rows={22}
            placeholder={placeholder || 'Start writing...'}
            class='w-full px-4 py-3 text-sm font-mono focus:outline-none resize-y min-h-[400px] border-0'
          />
        )}
    </div>
  )
}
