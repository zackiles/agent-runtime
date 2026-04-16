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
        flags: [],
        env: {},
      },
      null,
      2,
    ) + '\n',
    'README.md': `---
name: ${context.slug}
description: Tool ${context.name}.
---

# ${context.name}

<!-- Describe what this tool does -->
`,
    'install.sh': `#!/bin/bash
set -euo pipefail

# Download or build the tool binary here.
# The resulting executable must be named 'tool' (any extension).
echo "Install script for ${context.name}"
`,
  }
}

export { compileDefault }
