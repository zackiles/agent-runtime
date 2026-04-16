import { compileDefault as compileAgent } from './agent-default.ts'
import {
  compileDefault as compileAgentPrompt,
  compileForDeploy,
} from './agent-prompt.ts'
import { compileDefault as compileAgentDemo } from './agent-demo.ts'
import {
  compileDefault as compileAgentAccess,
  compileForDeploy as compileAccessForDeploy,
} from './agent-access.ts'
import { compileDefault as compileTool } from './tool-default.ts'
import { compileDefault as compileToolMcp } from './tool-mcp.ts'
import { compileDefault as compileRule } from './rule-default.ts'
import { compileDefault as compileSkill } from './skill-default.ts'

type TemplateContext = {
  name: string
  slug: string
  version: string
  subsystem?: string
}

function replace(
  template: string,
  context: TemplateContext,
  defaultSubsystem = 'default',
): string {
  return template
    .replace(/\{\{name\}\}/g, context.name)
    .replace(/\{\{slug\}\}/g, context.slug)
    .replace(/\{\{version\}\}/g, context.version)
    .replace(
      /\{\{subsystem\}\}/g,
      context.subsystem ?? defaultSubsystem,
    )
}

type CompiledTemplate = Record<string, string>

type EntityType = 'agent' | 'tool' | 'rule' | 'skill'

const BUILT_IN: Record<EntityType, (c: TemplateContext) => CompiledTemplate> = {
  'agent': compileAgent,
  'tool': compileTool,
  'rule': compileRule,
  'skill': compileSkill,
}

function compile(
  templateId: string,
  context: TemplateContext,
): CompiledTemplate {
  switch (templateId) {
    case 'agent-default':
      return compileAgent(context)
    case 'agent-prompt':
      return compileAgentPrompt(context)
    case 'agent-demo':
      return compileAgentDemo(context)
    case 'agent-access':
      return compileAgentAccess(context)
    case 'tool-default':
      return compileTool(context)
    case 'tool-mcp':
      return compileToolMcp(context)
    case 'rule-default':
      return compileRule(context)
    case 'skill-default':
      return compileSkill(context)
    default:
      return compileAgent(context)
  }
}

function compileBuiltIn(
  entityType: EntityType,
  context: TemplateContext,
): CompiledTemplate {
  return BUILT_IN[entityType](context)
}

export {
  compile,
  compileAccessForDeploy,
  compileBuiltIn,
  compileForDeploy,
  replace,
}
export type { CompiledTemplate, EntityType, TemplateContext }
