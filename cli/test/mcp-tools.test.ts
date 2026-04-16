import { assertEquals } from '@std/assert'
import { exists } from '@std/fs'
import { join } from '@std/path'

Deno.test('tool-schema.ts supports MCP tool type', async () => {
  const path = join(
    Deno.cwd(),
    '..',
    'sdk-client-deno',
    'src',
    'tool-schema.ts',
  )
  const content = await Deno.readTextFile(path)
  assertEquals(
    content.includes("type ToolType = 'stdio' | 'mcp'"),
    true,
    'tool-schema must define ToolType',
  )
  assertEquals(
    content.includes('McpConfig'),
    true,
    'tool-schema must define McpConfig type',
  )
  assertEquals(
    content.includes('type?: ToolType'),
    true,
    'ToolManifest must have optional type field',
  )
  assertEquals(
    content.includes('mcp?: McpConfig'),
    true,
    'ToolManifest must have optional mcp field',
  )
})

Deno.test('tool-schema validates MCP tools without executable', async () => {
  const path = join(
    Deno.cwd(),
    '..',
    'sdk-client-deno',
    'src',
    'tool-schema.ts',
  )
  const content = await Deno.readTextFile(path)
  assertEquals(
    content.includes("manifest.type === 'mcp'"),
    true,
    'validation must check for mcp type',
  )
  assertEquals(
    content.includes("manifest.mcp.transport === 'stdio'"),
    true,
    'validation must check mcp stdio transport',
  )
  assertEquals(
    content.includes("manifest.mcp.transport === 'http'"),
    true,
    'validation must check mcp http transport',
  )
})

Deno.test('SDK tools.ts has McpClient class', async () => {
  const path = join(
    Deno.cwd(),
    '..',
    'sdk-agent-nodejs',
    'src',
    'tools.ts',
  )
  const content = await Deno.readTextFile(path)
  assertEquals(
    content.includes('class McpClient'),
    true,
    'tools.ts must define McpClient class',
  )
  assertEquals(
    content.includes('listTools'),
    true,
    'McpClient must have listTools method',
  )
  assertEquals(
    content.includes('callTool'),
    true,
    'McpClient must have callTool method',
  )
})

Deno.test('AgentTools has MCP methods', async () => {
  const path = join(
    Deno.cwd(),
    '..',
    'sdk-agent-nodejs',
    'src',
    'tools.ts',
  )
  const content = await Deno.readTextFile(path)
  assertEquals(
    content.includes('isMcp('),
    true,
    'AgentTools must have isMcp method',
  )
  assertEquals(
    content.includes('mcpList('),
    true,
    'AgentTools must have mcpList method',
  )
  assertEquals(
    content.includes('mcpCall('),
    true,
    'AgentTools must have mcpCall method',
  )
  assertEquals(
    content.includes('closeMcp('),
    true,
    'AgentTools must have closeMcp method',
  )
})

Deno.test('SDK tools.d.ts has MCP types', async () => {
  const path = join(
    Deno.cwd(),
    '..',
    'sdk-agent-nodejs',
    'bin',
    'tools.d.ts',
  )
  const content = await Deno.readTextFile(path)
  assertEquals(
    content.includes('McpConfig'),
    true,
    'tools.d.ts must export McpConfig',
  )
  assertEquals(
    content.includes('McpTransport'),
    true,
    'tools.d.ts must export McpTransport',
  )
  assertEquals(
    content.includes('isMcp'),
    true,
    'tools.d.ts must declare isMcp',
  )
  assertEquals(
    content.includes('mcpList'),
    true,
    'tools.d.ts must declare mcpList',
  )
  assertEquals(
    content.includes('mcpCall'),
    true,
    'tools.d.ts must declare mcpCall',
  )
})

Deno.test('MCP tool scaffold template exists', async () => {
  const path = join(
    Deno.cwd(),
    '..',
    'sdk-client-deno',
    'src',
    'templates',
    'tool-mcp.ts',
  )
  assertEquals(
    await exists(path),
    true,
    'tool-mcp.ts template must exist',
  )
  const content = await Deno.readTextFile(path)
  assertEquals(
    content.includes("type: 'mcp'"),
    true,
    'MCP template must set type to mcp',
  )
  assertEquals(
    content.includes("transport: 'stdio'"),
    true,
    'MCP template must default to stdio transport',
  )
  assertEquals(
    content.includes('server.js'),
    true,
    'MCP template must include server.js scaffold',
  )
})

Deno.test('template mod.ts registers tool-mcp', async () => {
  const path = join(
    Deno.cwd(),
    '..',
    'sdk-client-deno',
    'src',
    'templates',
    'mod.ts',
  )
  const content = await Deno.readTextFile(path)
  assertEquals(
    content.includes("'tool-mcp'"),
    true,
    'mod.ts must register tool-mcp template',
  )
})

Deno.test('CLI tool create supports --mcp flag', async () => {
  const path = join(Deno.cwd(), 'src', 'commands', 'tool.ts')
  const content = await Deno.readTextFile(path)
  assertEquals(
    content.includes("'mcp'"),
    true,
    'tool.ts must include mcp in OPTIONS',
  )
  assertEquals(
    content.includes('tool-mcp'),
    true,
    'tool.ts must use tool-mcp template when --mcp flag is set',
  )
})

Deno.test('entity-form.tsx has MCP tool type UI', async () => {
  const path = join(
    Deno.cwd(),
    '..',
    'web',
    'src',
    'components',
    'entity-form.tsx',
  )
  const content = await Deno.readTextFile(path)
  assertEquals(
    content.includes('toolType'),
    true,
    'entity-form must have toolType state',
  )
  assertEquals(
    content.includes('mcpTransport'),
    true,
    'entity-form must have mcpTransport state',
  )
  assertEquals(
    content.includes('MCP Server'),
    true,
    'entity-form must show MCP Server option',
  )
})
