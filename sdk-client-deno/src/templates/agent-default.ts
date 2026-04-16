import { replace } from './mod.ts'
import type { TemplateContext } from './mod.ts'

const AGENT_TS = `const { execSync } = require('child_process')

exports.handler = async (req, res) => {
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {})
  const input = JSON.stringify(body, null, 2)

  const sanitized = AgentSecurity.instance.sanitize(body, 'input')
  AgentAudit.instance.info('Input received', { length: input.length })

  const prompt = require('fs').readFileSync(
    require('path').join(__dirname, 'prompt.md'),
    'utf-8',
  )
  const content = prompt + '\\n\\n---\\n\\nInput:\\n' + JSON.stringify(sanitized, null, 2)

  let result = content
  const subsystem = AgentEnvironment.instance.subsystem
  if (subsystem) {
    try {
      result = AgentTools.instance.run(subsystem, content, { timeout: 120000 })
    } catch (err) {
      AgentAudit.instance.error('Subsystem call failed', { subsystem, error: err.message })
      result = 'Error: ' + err.message
    }
  }

  const output = AgentSecurity.instance.sanitize({ result }, 'output')

  await AgentAudit.instance.log('executed', {
    subsystem,
    inputLength: input.length,
    outputLength: JSON.stringify(output).length,
  })

  res.json({ received: true, output })
}
`

const PROMPT_MD = `# {{name}}

You are an agent named {{name}}.

## Instructions

<!-- Add your agent instructions here -->

## Credentials

<!-- If using a subsystem (cursor/claude), configure the API key as a secret:
     ar secret set --name {{slug}}-api-key --value <your-key> --agent {{slug}}
     The key will be available as: await AgentSecrets.instance.get('{{slug}}-api-key') -->

## Available Tools

The following CLI tools are installed and available via AgentTools:

- **cursor** - AI coding assistant (subsystem)
- **claude** - AI reasoning assistant (subsystem)
- **gemini** - Gemini on Vertex AI (subsystem, no API key needed)
- **gh** (github) - GitHub CLI for repos, PRs, issues, Actions
- **auth0** - Auth0 CLI for identity and access management
- **datadog-ci** (datadog) - Datadog CLI for observability and CI/CD

Call utility tools with:
  AgentTools.instance.exec('<tool>', ['<subcommand>', ...args])
`

const README_MD = `---
name: {{slug}}
description: Agent {{name}}.
---

# {{name}}

<!-- Describe what this agent does -->
`

function compileDefault(
  context: TemplateContext,
): Record<string, string> {
  return {
    'index.js': replace(AGENT_TS, context),
    'prompt.md': replace(PROMPT_MD, context),
    'README.md': replace(README_MD, context),
  }
}

export { compileDefault }
