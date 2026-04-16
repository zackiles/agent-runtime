import type { TemplateContext } from './mod.ts'

function compileDefault(
  context: TemplateContext,
): Record<string, string> {
  return {
    'skill.json': JSON.stringify(
      {
        name: context.name,
        slug: context.slug,
        version: context.version,
      },
      null,
      2,
    ) + '\n',
    'README.md': `---
name: ${context.slug}
description: Skill ${context.name}.
---

# ${context.name}

<!-- Describe what this skill provides -->
`,
    'SKILL.md': `---
name: ${context.slug}
description: ${context.name} skill.
---

# ${context.name}

Describe what this skill does and when the agent should use it.

## Instructions

Add step-by-step instructions for the agent here.
`,
  }
}

export { compileDefault }
