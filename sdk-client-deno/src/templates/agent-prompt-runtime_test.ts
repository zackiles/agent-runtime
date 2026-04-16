import { assertEquals, assertStringIncludes } from '@std/assert'
import { compileForDeploy } from './agent-prompt.ts'

Deno.test('generated resolveDotNotation resolves body fields', () => {
  const files = compileForDeploy('test {{request.body.name}}', 'claude')
  const js = files['index.js']

  const fnMatch = js.match(
    /function resolveDotNotation[\s\S]+?^}/m,
  )
  if (!fnMatch) throw new Error('resolveDotNotation not found in output')

  const fn = new Function(
    'return ' + fnMatch[0].replace(
      /function resolveDotNotation/,
      'function',
    ),
  )()

  const result = fn(
    'Hello {{request.body.name}}, age={{request.body.age}}',
    { headers: {}, body: { name: 'Alice', age: 30 } },
  )

  assertEquals(result, 'Hello Alice, age=30')
})

Deno.test('generated resolveDotNotation resolves nested properties', () => {
  const files = compileForDeploy('test', 'claude')
  const js = files['index.js']

  const fnMatch = js.match(
    /function resolveDotNotation[\s\S]+?^}/m,
  )
  if (!fnMatch) throw new Error('resolveDotNotation not found')

  const fn = new Function(
    'return ' + fnMatch[0].replace(
      /function resolveDotNotation/,
      'function',
    ),
  )()

  const result = fn(
    'User: {{request.body.user.profile.name}}',
    { headers: {}, body: { user: { profile: { name: 'Bob' } } } },
  )

  assertEquals(result, 'User: Bob')
})

Deno.test('generated resolveDotNotation resolves array indices', () => {
  const files = compileForDeploy('test', 'claude')
  const js = files['index.js']

  const fnMatch = js.match(
    /function resolveDotNotation[\s\S]+?^}/m,
  )
  if (!fnMatch) throw new Error('resolveDotNotation not found')

  const fn = new Function(
    'return ' + fnMatch[0].replace(
      /function resolveDotNotation/,
      'function',
    ),
  )()

  const result = fn(
    'First: {{request.body.items[0].name}}',
    { headers: {}, body: { items: [{ name: 'Widget' }] } },
  )

  assertEquals(result, 'First: Widget')
})

Deno.test('generated resolveDotNotation resolves headers', () => {
  const files = compileForDeploy('test', 'claude')
  const js = files['index.js']

  const fnMatch = js.match(
    /function resolveDotNotation[\s\S]+?^}/m,
  )
  if (!fnMatch) throw new Error('resolveDotNotation not found')

  const fn = new Function(
    'return ' + fnMatch[0].replace(
      /function resolveDotNotation/,
      'function',
    ),
  )()

  const result = fn(
    'ID: {{request.headers.x-request-id}}',
    { headers: { 'x-request-id': 'abc-123' }, body: {} },
  )

  assertEquals(result, 'ID: abc-123')
})

Deno.test('generated resolveDotNotation serializes objects as JSON', () => {
  const files = compileForDeploy('test', 'claude')
  const js = files['index.js']

  const fnMatch = js.match(
    /function resolveDotNotation[\s\S]+?^}/m,
  )
  if (!fnMatch) throw new Error('resolveDotNotation not found')

  const fn = new Function(
    'return ' + fnMatch[0].replace(
      /function resolveDotNotation/,
      'function',
    ),
  )()

  const result = fn(
    'Data: {{request.body.data}}',
    { headers: {}, body: { data: { key: 'val' } } },
  )

  assertStringIncludes(result, '"key"')
  assertStringIncludes(result, '"val"')
})

Deno.test('generated resolveDotNotation leaves unmatched variables', () => {
  const files = compileForDeploy('test', 'claude')
  const js = files['index.js']

  const fnMatch = js.match(
    /function resolveDotNotation[\s\S]+?^}/m,
  )
  if (!fnMatch) throw new Error('resolveDotNotation not found')

  const fn = new Function(
    'return ' + fnMatch[0].replace(
      /function resolveDotNotation/,
      'function',
    ),
  )()

  const result = fn(
    'Missing: {{request.body.nonexistent}}',
    { headers: {}, body: {} },
  )

  assertEquals(result, 'Missing: {{request.body.nonexistent}}')
})

Deno.test('full compilation pipeline produces correct prompt structure', () => {
  const userPrompt = `# Test Agent
Process: {{request.body.action}}
Data: {{request.body.payload}}`

  const files = compileForDeploy(userPrompt, 'claude')

  const compiled = files['prompt.compiled.md']
  assertStringIncludes(compiled, 'SYSTEM PROMPT:')
  assertStringIncludes(compiled, 'tool named claude')
  assertStringIncludes(compiled, 'REQUEST PROMPT:')
  assertStringIncludes(compiled, '# Test Agent')
  assertStringIncludes(compiled, '{{request.body.action}}')
  assertStringIncludes(compiled, '{{REQUEST}}')

  const handler = files['index.js']
  assertStringIncludes(handler, 'exports.handler')
  assertStringIncludes(handler, JSON.stringify(compiled).slice(1, 30))
})
