import type { TemplateContext } from './mod.ts'

function compileDefault(
  context: TemplateContext,
): Record<string, string> {
  return {
    'tool.json': JSON.stringify(
      {
        name: context.name,
        slug: context.slug,
        version: context.version,
        type: 'mcp',
        mcp: {
          transport: 'stdio',
          command: 'node',
          args: ['server.js'],
        },
        flags: [],
        env: {},
      },
      null,
      2,
    ) + '\n',
    'README.md': `---
name: ${context.slug}
description: MCP tool ${context.name}.
---

# ${context.name}

An MCP-compatible tool server.
`,
    'server.js':
      `const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");

const server = new Server(
  { name: "${context.slug}", version: "${context.version}" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler("tools/list", async () => ({
  tools: [
    {
      name: "hello",
      description: "Returns a greeting",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Name to greet" }
        },
        required: ["name"]
      }
    }
  ]
}));

server.setRequestHandler("tools/call", async (request) => {
  if (request.params.name === "hello") {
    const name = request.params.arguments?.name ?? "world";
    return {
      content: [{ type: "text", text: "Hello, " + name + "!" }]
    };
  }
  throw new Error("Unknown tool: " + request.params.name);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
main().catch(console.error);
`,
  }
}

export { compileDefault }
