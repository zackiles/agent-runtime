import { replace } from './mod.ts'
import type { TemplateContext } from './mod.ts'
import { DEFAULT_SUBSYSTEM } from '../subsystems.ts'

const ACCESS_PROMPT_TEMPLATE = `SYSTEM PROMPT:
You are an Access Agent — a secure configuration assistant that helps users set up access to company apps, resources, data sources, and third-party services within the Agent Runtime platform. You operate in a two-turn flow:

TURN 1 (access request):
The user describes what resource, service, or data source they need access to. You must:
1. Analyze the REQUEST to determine what kind of access is needed (OAuth/OIDC flow, API key, service account, data source credentials, GSuite personal access, etc.)
2. Determine what secrets, tokens, or configuration data will be needed
3. Invoke the Demo Agent to build a one-time-use web UI tailored to this specific access request. The UI must:
   - Guide the user through the exact steps needed (e.g. "Click this link to authorize", "Paste your API key here", "Upload your service account JSON")
   - For OAuth/OIDC flows: include the authorization URL with correct scopes and a callback that captures the token
   - For API keys: provide a secure input field
   - For file-based credentials: provide a file upload
   - For multi-step flows: present a wizard-style interface
   - ALWAYS end by encoding ALL collected data into a single base64 JSON string and displaying it prominently with instructions: "Copy this string and send it back to the Access Agent to complete setup"
   - The base64 payload must be a JSON object with: { "type": "<access-type>", "resource": "<resource-name>", "data": { ...collected credentials/tokens/config }, "scope": "private|public", "timestamp": "<ISO>" }
4. Return a structured response with the demo URL and instructions

TURN 2 (callback with context):
The user sends back the base64 string from the UI. You must:
1. Decode the base64 string and validate its structure
2. Based on the "type" and "scope" fields, perform the appropriate action:
   - "scope": "private" → set secrets in the user's private registry only
   - "scope": "public" → set secrets/config in the public registry (admin only)
3. Use the runtime secret management to store credentials:
   - Call AgentSecrets to set each secret with appropriate naming
   - Update any runtime or control plane configuration needed
4. Return a confirmation with what was configured and any next steps

SECURITY:
- Never log or expose raw credentials in audit trails
- Private access setup is scoped to the requesting user only
- Public registry configuration requires admin privileges
- All credentials are stored in GCP Secret Manager via the runtime
- One-time-use UIs are destroyed after the context string is generated

---
TURN: {{TURN}}
REQUEST:
{{REQUEST}}
CONTEXT:
{{CONTEXT}}`

const HANDLER_TEMPLATE = `const fs = require('fs')
const path = require('path')

const ACCESS_PROMPT = PROMPT_PLACEHOLDER

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)
}

function decodeContext(encoded) {
  try {
    var decoded = Buffer.from(encoded, 'base64').toString('utf-8')
    return JSON.parse(decoded)
  } catch {
    return null
  }
}

function buildPrompt(turn, request, context) {
  var prompt = ACCESS_PROMPT
  prompt = prompt
    .replace(/\\{\\{TURN\\}\\}/g, String(turn))
    .replace(/\\{\\{REQUEST\\}\\}/g, JSON.stringify(request, null, 2))
    .replace(
      /\\{\\{CONTEXT\\}\\}/g,
      context ? JSON.stringify(context, null, 2) : '(none)',
    )
  return prompt
}

exports.handler = async (req, res) => {
  const body = typeof req.body === 'string'
    ? JSON.parse(req.body)
    : (req.body || {})
  const sanitized = AgentSecurity.instance.sanitize(body, 'input')
  AgentAudit.instance.info('Access request received', {
    length: JSON.stringify(body).length,
    hasContext: !!sanitized.context,
  })

  const env = AgentEnvironment.instance
  const subsystem = env.subsystem

  var turn = 1
  var context = null
  var request = sanitized

  if (sanitized.context) {
    context = decodeContext(sanitized.context)
    if (!context) {
      return res.json({
        error: 'Invalid context string. Please copy the exact string from the access UI.',
        audit: { status: 'error', reason: 'invalid_context' },
      })
    }
    turn = 2
    request = { ...sanitized, decodedContext: context }
  }

  var prompt = buildPrompt(turn, request, context)

  var result
  try {
    result = AgentTools.instance.run(
      subsystem, prompt, { timeout: 300000 }
    )
  } catch (err) {
    AgentAudit.instance.error('Subsystem call failed', {
      subsystem: subsystem,
      error: err.message,
    })
    return res.json({
      error: err.message,
      audit: { status: 'error', subsystem: subsystem },
    })
  }

  var parsed
  try {
    parsed = JSON.parse(result)
  } catch {
    parsed = {
      response: result,
      audit: { rawOutput: true, subsystem: subsystem },
    }
  }

  if (turn === 2 && context) {
    try {
      var scope = context.scope || 'private'
      var resource = context.resource || 'unknown'
      var data = context.data || {}
      var secretPrefix = 'access-' + slugify(resource)

      for (var key in data) {
        if (!Object.prototype.hasOwnProperty.call(data, key)) continue
        var val = data[key]
        if (typeof val !== 'string') val = JSON.stringify(val)
        var secretName = secretPrefix + '-' + slugify(key)
        try {
          AgentSecrets.instance.set(secretName, val)
          AgentAudit.instance.info('Secret configured', {
            name: secretName,
            scope: scope,
            resource: resource,
          })
        } catch (err) {
          AgentAudit.instance.warn('Secret set failed', {
            name: secretName,
            error: err.message,
          })
        }
      }

      if (!parsed.configured) {
        parsed.configured = {
          resource: resource,
          scope: scope,
          secrets: Object.keys(data).map(function(k) {
            return secretPrefix + '-' + slugify(k)
          }),
          timestamp: new Date().toISOString(),
        }
      }
    } catch (err) {
      AgentAudit.instance.error('Configuration failed', {
        error: err.message,
      })
      parsed.configError = err.message
    }
  }

  var output = AgentSecurity.instance.sanitize(parsed, 'output')

  await AgentAudit.instance.log('executed', {
    subsystem: subsystem,
    turn: turn,
    inputLength: JSON.stringify(body).length,
    outputLength: JSON.stringify(output).length,
    resource: context ? context.resource : null,
  })

  res.json(output)
}
`

const SCAFFOLD_PROMPT = `# {{name}}

You are **{{name}}**, an access configuration agent powered by
the **{{subsystem}}** subsystem.

This agent helps users set up access to apps, resources, data sources,
and third-party services. It operates in a two-turn flow:

1. **Turn 1** — Describe what you need access to. The agent builds a
   one-time-use UI to collect your credentials.
2. **Turn 2** — Send back the context string from the UI. The agent
   configures your secrets and runtime access.

## Subsystem

Uses **{{subsystem}}** to generate access UIs and process credentials.
`

const README_MD = `---
name: {{slug}}
description: Access configuration agent for apps, resources, and services.
---

# {{name}}

A function-based default agent that helps users configure access to
company apps, resources, data sources, and third-party services.

## Two-Turn Flow

### Turn 1: Access Request

Send a request describing what you need access to:

\`\`\`json
{
  "resource": "google-drive",
  "description": "I need my personal Google Drive accessible to agents",
  "scope": "private"
}
\`\`\`

The agent will:
1. Determine what credentials are needed
2. Build a one-time-use web UI via the Demo Agent
3. Return the UI URL with instructions

### Turn 2: Context Callback

After completing the UI flow, send back the context string:

\`\`\`json
{
  "context": "<base64-encoded-string-from-ui>"
}
\`\`\`

The agent will:
1. Decode and validate the context
2. Store credentials as secrets in the appropriate registry
3. Configure any needed runtime settings
4. Return confirmation of what was set up

## Scope

| Scope | Who Can Use | Who Can Configure |
|-------|-------------|-------------------|
| \`private\` | Current user only | Any user |
| \`public\` | All users and agents | Admins only |

## Examples

### OAuth/OIDC Flow (e.g. Google, GitHub, Slack)

\`\`\`json
{ "resource": "github", "description": "Connect my GitHub account" }
\`\`\`

The agent builds a UI with the OAuth authorization URL. After the user
authorizes, the UI captures the token and encodes it as a context string.

### API Key Setup

\`\`\`json
{ "resource": "openai", "description": "Add my OpenAI API key" }
\`\`\`

The agent builds a simple form to securely enter the API key.

### Multi-Secret Configuration

\`\`\`json
{
  "resource": "aws",
  "description": "Configure AWS access for S3 data lake",
  "scope": "public"
}
\`\`\`

The agent builds a wizard collecting access key, secret key, region,
and bucket name. Requires admin privileges for public scope.
`

function compilePrompt(subsystem: string): string {
  return ACCESS_PROMPT_TEMPLATE
    .replace(/\{\{SUBSYSTEM\}\}/g, subsystem)
}

function compileHandler(compiledPrompt: string): string {
  const escaped = JSON.stringify(compiledPrompt)
  return HANDLER_TEMPLATE.replace(
    'PROMPT_PLACEHOLDER',
    () => escaped,
  )
}

function compileForDeploy(
  subsystem: string,
): Record<string, string> {
  const compiled = compilePrompt(subsystem)
  return {
    'prompt.compiled.md': compiled,
    'index.js': compileHandler(compiled),
  }
}

function compileDefault(
  context: TemplateContext,
): Record<string, string> {
  const subsystem = context.subsystem ?? DEFAULT_SUBSYSTEM
  const compiled = compileForDeploy(subsystem)
  return {
    ...compiled,
    'prompt.md': replace(SCAFFOLD_PROMPT, context, 'cursor'),
    'README.md': replace(README_MD, context, 'cursor'),
  }
}

export { compileDefault, compileForDeploy, compileHandler, compilePrompt }
