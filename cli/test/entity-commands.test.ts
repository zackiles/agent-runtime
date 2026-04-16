import { assertEquals } from '@std/assert'
import { join } from '@std/path'

const CLI_SRC = join(Deno.cwd(), 'src', 'commands')

Deno.test('tool.ts has update subcommand', async () => {
  const content = await Deno.readTextFile(join(CLI_SRC, 'tool.ts'))
  assertEquals(
    content.includes("case 'update'"),
    true,
    'tool.ts must have update case',
  )
  assertEquals(
    content.includes('updateEntity'),
    true,
    'tool.ts must import updateEntity',
  )
})

Deno.test('skill.ts has update subcommand', async () => {
  const content = await Deno.readTextFile(join(CLI_SRC, 'skill.ts'))
  assertEquals(
    content.includes("case 'update'"),
    true,
    'skill.ts must have update case',
  )
  assertEquals(
    content.includes('updateEntity'),
    true,
    'skill.ts must import updateEntity',
  )
})

Deno.test('rule.ts has update subcommand', async () => {
  const content = await Deno.readTextFile(join(CLI_SRC, 'rule.ts'))
  assertEquals(
    content.includes("case 'update'"),
    true,
    'rule.ts must have update case',
  )
  assertEquals(
    content.includes('updateEntity'),
    true,
    'rule.ts must import updateEntity',
  )
})

Deno.test('tool.ts destroy has confirmation', async () => {
  const content = await Deno.readTextFile(join(CLI_SRC, 'tool.ts'))
  assertEquals(
    content.includes('confirm('),
    true,
    'tool.ts destroy must use confirm()',
  )
  assertEquals(
    content.includes('args.force'),
    true,
    'tool.ts destroy must check --force flag',
  )
})

Deno.test('skill.ts destroy has confirmation', async () => {
  const content = await Deno.readTextFile(join(CLI_SRC, 'skill.ts'))
  assertEquals(
    content.includes('confirm('),
    true,
    'skill.ts destroy must use confirm()',
  )
  assertEquals(
    content.includes('args.force'),
    true,
    'skill.ts destroy must check --force flag',
  )
})

Deno.test('rule.ts destroy has confirmation', async () => {
  const content = await Deno.readTextFile(join(CLI_SRC, 'rule.ts'))
  assertEquals(
    content.includes('confirm('),
    true,
    'rule.ts destroy must use confirm()',
  )
  assertEquals(
    content.includes('args.force'),
    true,
    'rule.ts destroy must check --force flag',
  )
})

Deno.test('tool.ts usage includes all subcommands', async () => {
  const content = await Deno.readTextFile(join(CLI_SRC, 'tool.ts'))
  for (
    const cmd of [
      'create',
      'update',
      'deploy',
      'destroy',
      'show',
      'versions',
      'clone',
    ]
  ) {
    assertEquals(
      content.includes(`case '${cmd}'`),
      true,
      `tool.ts must have ${cmd} case`,
    )
  }
})

Deno.test('skill.ts usage includes all subcommands', async () => {
  const content = await Deno.readTextFile(join(CLI_SRC, 'skill.ts'))
  for (
    const cmd of [
      'create',
      'import',
      'update',
      'deploy',
      'destroy',
      'show',
      'versions',
      'clone',
    ]
  ) {
    assertEquals(
      content.includes(`case '${cmd}'`),
      true,
      `skill.ts must have ${cmd} case`,
    )
  }
})

Deno.test('rule.ts usage includes all subcommands', async () => {
  const content = await Deno.readTextFile(join(CLI_SRC, 'rule.ts'))
  for (
    const cmd of [
      'create',
      'update',
      'deploy',
      'destroy',
      'show',
      'versions',
      'clone',
    ]
  ) {
    assertEquals(
      content.includes(`case '${cmd}'`),
      true,
      `rule.ts must have ${cmd} case`,
    )
  }
})

Deno.test('skill-schema supports full Agent Skills spec', async () => {
  const path = join(
    Deno.cwd(),
    '..',
    'sdk-client-deno',
    'src',
    'skill-schema.ts',
  )
  const content = await Deno.readTextFile(path)
  assertEquals(
    content.includes('SKILL.md'),
    true,
    'skill-schema must support SKILL.md file',
  )
  assertEquals(
    content.includes('SkillFrontmatter'),
    true,
    'skill-schema must define SkillFrontmatter type',
  )
  assertEquals(
    content.includes('license'),
    true,
    'skill-schema must parse license field',
  )
  assertEquals(
    content.includes('compatibility'),
    true,
    'skill-schema must parse compatibility field',
  )
  assertEquals(
    content.includes('allowedTools'),
    true,
    'skill-schema must parse allowed-tools field',
  )
  assertEquals(
    content.includes('disableModelInvocation'),
    true,
    'skill-schema must parse disable-model-invocation field',
  )
  assertEquals(
    content.includes('SKILL_NAME_PATTERN'),
    true,
    'skill-schema must use spec-compliant name pattern',
  )
  assertEquals(
    content.includes('MAX_SKILL_DESCRIPTION_LENGTH'),
    true,
    'skill-schema must use 1024-char description limit',
  )
  assertEquals(
    content.includes('MAX_COMPATIBILITY_LENGTH'),
    true,
    'skill-schema must validate compatibility length',
  )
  assertEquals(
    content.includes('!await exists(manifestPath)'),
    false,
    'skill-schema must not require skill.json',
  )
})

Deno.test('rule-schema returns body content', async () => {
  const path = join(
    Deno.cwd(),
    '..',
    'sdk-client-deno',
    'src',
    'rule-schema.ts',
  )
  const content = await Deno.readTextFile(path)
  assertEquals(
    content.includes('body: string'),
    true,
    'rule ValidatedRule must include body field',
  )
  assertEquals(
    content.includes('body'),
    true,
    'rule validate must return body',
  )
})
