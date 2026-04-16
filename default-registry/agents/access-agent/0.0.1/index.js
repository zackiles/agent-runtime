const fs = require('fs')
const path = require('path')

const ACCESS_PROMPT = `SYSTEM PROMPT:
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

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)
}

function decodeContext(encoded) {
  try {
    const decoded = Buffer.from(encoded, 'base64').toString('utf-8')
    return JSON.parse(decoded)
  } catch {
    return null
  }
}

function buildPrompt(turn, request, context) {
  return ACCESS_PROMPT
    .replace(/\{\{TURN\}\}/g, String(turn))
    .replace(/\{\{REQUEST\}\}/g, JSON.stringify(request, null, 2))
    .replace(
      /\{\{CONTEXT\}\}/g,
      context ? JSON.stringify(context, null, 2) : '(none)',
    )
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

  let turn = 1
  let context = null
  let request = sanitized

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

  const prompt = buildPrompt(turn, request, context)

  let result
  try {
    result = AgentTools.instance.run(
      subsystem, prompt, { timeout: 300000 },
    )
  } catch (err) {
    AgentAudit.instance.error('Subsystem call failed', {
      subsystem,
      error: err.message,
    })
    return res.json({
      error: err.message,
      audit: { status: 'error', subsystem },
    })
  }

  let parsed
  try {
    parsed = JSON.parse(result)
  } catch {
    parsed = {
      response: result,
      audit: { rawOutput: true, subsystem },
    }
  }

  if (turn === 2 && context) {
    try {
      const scope = context.scope || 'private'
      const resource = context.resource || 'unknown'
      const data = context.data || {}
      const secretPrefix = 'access-' + slugify(resource)

      for (const key in data) {
        if (!Object.prototype.hasOwnProperty.call(data, key)) continue
        let val = data[key]
        if (typeof val !== 'string') val = JSON.stringify(val)
        const secretName = secretPrefix + '-' + slugify(key)
        try {
          AgentSecrets.instance.set(secretName, val)
          AgentAudit.instance.info('Secret configured', {
            name: secretName,
            scope,
            resource,
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
          resource,
          scope,
          secrets: Object.keys(data).map((k) =>
            secretPrefix + '-' + slugify(k)
          ),
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

  const output = AgentSecurity.instance.sanitize(parsed, 'output')

  await AgentAudit.instance.log('executed', {
    subsystem,
    turn,
    inputLength: JSON.stringify(body).length,
    outputLength: JSON.stringify(output).length,
    resource: context ? context.resource : null,
  })

  res.json(output)
}
