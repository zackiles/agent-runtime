import type { TemplateContext } from './mod.ts'

function compileDefault(
  context: TemplateContext,
): Record<string, string> {
  return {
    'rule.json': JSON.stringify(
      {
        name: context.name,
        slug: context.slug,
        version: context.version,
        globs: ['**/*'],
      },
      null,
      2,
    ) + '\n',
    'README.md': `---
name: ${context.slug}
description: Rule ${context.name}.
---

# ${context.name}

<!-- Describe what this rule enforces -->
`,
  }
}

export { compileDefault }
