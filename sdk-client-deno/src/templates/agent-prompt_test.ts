import { assertEquals, assertStringIncludes } from '@std/assert'
import {
  compileDefault,
  compileForDeploy,
  compileHandler,
  compilePrompt,
} from './agent-prompt.ts'

Deno.test('compileDefault scaffolds prompt.md and README.md', () => {
  const files = compileDefault({
    name: 'my-agent',
    slug: 'my-agent',
    version: '0.0.1',
    subsystem: 'claude',
  })

  assertEquals(Object.keys(files).sort(), [
    'README.md',
    'prompt.md',
  ])

  assertStringIncludes(files['prompt.md'], '# my-agent')
  assertStringIncludes(files['prompt.md'], '{{request.body.action}}')
  assertStringIncludes(files['prompt.md'], '{{request.headers.x-caller-id}}')
  assertStringIncludes(files['README.md'], 'claude')
  assertStringIncludes(files['README.md'], 'Dot Notation')
})

Deno.test('compileDefault does not include index.js', () => {
  const files = compileDefault({
    name: 'test',
    slug: 'test',
    version: '1.0.0',
    subsystem: 'cursor',
  })

  assertEquals('index.js' in files, false)
})

Deno.test('compilePrompt wraps user prompt in system prompt', () => {
  const userPrompt = '# My Agent\n\nDo something with {{request.body.data}}'
  const compiled = compilePrompt(userPrompt, 'claude')

  assertStringIncludes(compiled, 'SYSTEM PROMPT:')
  assertStringIncludes(compiled, 'agentic gateway')
  assertStringIncludes(compiled, 'tool named claude')
  assertStringIncludes(compiled, 'REQUEST PROMPT:')
  assertStringIncludes(compiled, userPrompt)
  assertStringIncludes(compiled, '{{REQUEST}}')
  assertStringIncludes(compiled, 'END SYSTEM PROMPT')
})

Deno.test('compilePrompt uses specified subsystem', () => {
  const compiled = compilePrompt('test', 'cursor')
  assertStringIncludes(compiled, 'tool named cursor')
})

Deno.test('compileHandler generates valid JS with embedded prompt', () => {
  const compiledPrompt = 'SYSTEM PROMPT:\nTest\n---\n{{REQUEST}}'
  const handler = compileHandler(compiledPrompt)

  assertStringIncludes(handler, 'const COMPILED_PROMPT =')
  assertStringIncludes(handler, 'exports.handler')
  assertStringIncludes(handler, 'resolveDotNotation')
  assertStringIncludes(handler, 'AgentTools.instance.run')
  assertStringIncludes(handler, 'AgentSecurity.instance.sanitize')
  assertStringIncludes(handler, 'AgentAudit.instance')
  assertStringIncludes(handler, 'AgentEnvironment.instance.subsystem')
})

Deno.test('compileHandler embeds prompt as JSON string', () => {
  const prompt = 'Line1\nLine2\n"quoted"'
  const handler = compileHandler(prompt)

  assertStringIncludes(handler, JSON.stringify(prompt))
})

Deno.test('compileForDeploy produces prompt.compiled.md and index.js', () => {
  const userPrompt = '# Test\n\nProcess {{request.body.action}}'
  const files = compileForDeploy(userPrompt, 'claude')

  assertEquals(Object.keys(files).sort(), [
    'index.js',
    'prompt.compiled.md',
  ])

  assertStringIncludes(files['prompt.compiled.md'], 'SYSTEM PROMPT:')
  assertStringIncludes(files['prompt.compiled.md'], userPrompt)
  assertStringIncludes(files['prompt.compiled.md'], '{{REQUEST}}')

  assertStringIncludes(files['index.js'], 'exports.handler')
  assertStringIncludes(files['index.js'], 'const COMPILED_PROMPT =')
})

Deno.test('dot notation regex in handler matches expected patterns', () => {
  const userPrompt =
    'Hello {{request.body.name}}, id={{request.headers.x-request-id}}'
  const files = compileForDeploy(userPrompt, 'claude')

  assertStringIncludes(files['index.js'], 'resolveDotNotation')
  assertStringIncludes(files['index.js'], 'function(match, path)')
})

Deno.test('compiled handler contains request variable construction', () => {
  const files = compileForDeploy('test', 'claude')
  const js = files['index.js']

  assertStringIncludes(
    js,
    'const request = { headers: headers, body: sanitized }',
  )
  assertStringIncludes(js, 'prompt.replace(')
  assertStringIncludes(js, '{{REQUEST}}')
})

Deno.test('end-to-end: user prompt with dot notation compiles correctly', () => {
  const userPrompt = `# Invoice Agent

Process invoice from {{request.body.vendor}}.
Items: {{request.body.items[0].name}}
Auth: {{request.headers.authorization}}
Full payload: {{request.body}}`

  const compiled = compilePrompt(userPrompt, 'claude')
  assertStringIncludes(compiled, 'tool named claude')
  assertStringIncludes(compiled, '{{request.body.vendor}}')
  assertStringIncludes(compiled, '{{request.body.items[0].name}}')
  assertStringIncludes(compiled, '{{request.headers.authorization}}')
  assertStringIncludes(compiled, '{{request.body}}')

  const handler = compileHandler(compiled)
  assertStringIncludes(handler, 'exports.handler')

  const escapedPrompt = JSON.stringify(compiled)
  assertStringIncludes(handler, escapedPrompt.slice(1, 50))
})
