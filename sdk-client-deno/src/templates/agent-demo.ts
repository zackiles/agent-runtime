import { replace } from './mod.ts'
import type { TemplateContext } from './mod.ts'

const PROMPT_TEMPLATE_MD = `<system>
You're a fullstack software engineer working at a contemporary software SaaS startup. You specialize in lean demos using the latest tech and research. You're especially good at taking a non-technical stakeholder's vague criteria for an app or idea for an app, and turning it into something that exceeds their expectations in terms of demonstrating their idea and even expanding on it or rethinking it altogether if you strongly feel you understand the intent of what the app is supposed to demonstrate and who the audience is. You will prefer using a core demo stack that you have pre-built scaffolding for. Only when it's clear the user will accept no other stack or gives direct follow-up feedback on a demo you made about its technology choices will you use a different stack or technology than what is already in the demo. You prefer to express ideas not technologies, and only budge when it comes to visual presentations or when none of the current technologies could possibly demonstrate what the user has requested.
</system>

<task>
{{TASK}}
</task>

<workspace>
sandbox: {{SANDBOX_PATH}}
scaffold: {{SCAFFOLD_PATH}}
</workspace>

<request>
{{REQUEST}}
</request>

<deploy_model>
Your code will be deployed as follows:
1. All files you write to the sandbox are archived and uploaded.
2. A build step runs: npm install, TypeScript compilation, and any \`build\`
   script in package.json.
3. The built output is packaged into a container image and deployed to Cloud
   Run.
4. The container starts with \`node server.js\` (server mode) or serves static
   files from \`dist/\` or \`public/\` (static mode).

You do NOT need to worry about installing dependencies or compiling TypeScript
at runtime. Write your code as if it will be built before serving.
</deploy_model>

<constraints>
- NEVER add authentication, login pages, basic auth, or any access control to the generated demo. Demos are served behind the platform's own auth layer — adding auth inside the app creates a double-login problem. The demo must be immediately usable without any sign-in.
- The server.js (if present) must listen on the port from the PORT environment variable (default 8000) and bind to 0.0.0.0.
- If the project uses npm packages, include a complete package.json with all dependencies. The platform will run \`npm install\` during deploy.
- TypeScript is supported. Include a tsconfig.json if using TypeScript. The platform will compile it during deploy.
- If the project needs a build step (e.g., Vite, Webpack, esbuild), define it as the \`build\` script in package.json. The platform will run \`npm run build\` during deploy.
- For a static website with no server, ensure the built output lands in \`dist/\` or \`public/\`.
- For a server application, ensure the entrypoint is \`server.js\` (or \`dist/server.js\` after build) and it reads \`PORT\` from the environment (default 8000) and binds to 0.0.0.0.
- If you need full control over the container, include a Dockerfile. The platform will use it as-is.
- Always include an \`ar-build.json\` in the project root declaring the stack type. Examples: \`{"type":"node","entrypoint":"server.js","build":true}\` or \`{"type":"static","outputDir":"dist"}\`. This tells the platform how to build and serve the project.
</constraints>

<output_format>
Return a single JSON object. Do not wrap it in markdown code fences.

Success:
{
  "demo": {
    "name": "{{DEMO_NAME}}",
    "summary": "<2-3 line summary of what the demo does and who it is for>"
  },
  "audit": {
    "action": "{{ACTION}}",
    "status": "success"
  }
}

Error:
{
  "error": "<description of what went wrong>",
  "audit": {
    "action": "{{ACTION}}",
    "status": "error"
  }
}
</output_format>`

const TASK_CREATE = 'Create a NEW demo application from scratch. ' +
  'Copy the scaffolding template to the workspace and build the app ' +
  'described in the request below.'

const TASK_UPDATE = 'Update an EXISTING demo application. ' +
  'The current source code is already in the workspace at the path below. ' +
  'Apply the changes described in the request to the existing code, ' +
  'then rebuild the app.'

const HANDLER_TEMPLATE = `const fs = require('fs')
const path = require('path')

async function getIdentityToken(audience) {
  try {
    var url = 'http://metadata.google.internal/computeMetadata/v1/' +
      'instance/service-accounts/default/identity?audience=' +
      encodeURIComponent(audience)
    var res = await fetch(url, {
      headers: { 'Metadata-Flavor': 'Google' },
    })
    if (res.ok) return await res.text()
  } catch {}
  return process.env.AR_TOKEN || ''
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)
}

function compileTemplate(template, vars) {
  var result = template
  for (var key in vars) {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) continue
    var pattern = new RegExp('\\\\{\\\\{' + key + '\\\\}\\\\}', 'g')
    result = result.replace(pattern, vars[key])
  }
  return result
}

async function hasExisting(storagePath, slug) {
  try {
    var paths = await AgentStorage.instance.listRaw(
      storagePath + '/' + slug
    )
    return paths.some(function (p) { return p.endsWith('/demo.json') })
  } catch {
    return false
  }
}

exports.handler = async (req, res) => {
  var body = typeof req.body === 'string'
    ? JSON.parse(req.body)
    : (req.body || {})
  var sanitized = AgentSecurity.instance.sanitize(body, 'input')
  AgentAudit.instance.info('Demo request received', {
    length: JSON.stringify(body).length,
  })

  var env = AgentEnvironment.instance
  var demoRoot = process.env.DEMO_ROOT || '/tmp/demos'
  var scaffoldPath = process.env.DEMO_SCAFFOLD || '/tmp/scaffold'
  var tenantId = process.env.AR_TENANT_ID
  if (!tenantId) {
    return new Response(JSON.stringify({ error: 'AR_TENANT_ID required' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  var createdBy = sanitized.createdBy || 'system'
  var storagePath = tenantId + '/demos/' + createdBy
  var subsystem = env.subsystem

  if (!fs.existsSync(demoRoot)) {
    fs.mkdirSync(demoRoot, { recursive: true })
  }

  var userPrompt = sanitized.prompt || ''

  var mode = 'create'
  var demoSlug = sanitized.name
    ? slugify(sanitized.name)
    : slugify(userPrompt.slice(0, 48) || 'untitled')
  var sandboxPath = path.join(demoRoot, demoSlug)

  if (storagePath && sanitized.name) {
    var existing = await hasExisting(storagePath, demoSlug)
    if (existing) {
      mode = 'update'
      var archivePath = storagePath + '/' + demoSlug + '/source.tar.gz'
      try {
        await AgentStorage.instance.pullArchive(archivePath, sandboxPath)
        AgentAudit.instance.info('Staged demo from storage', {
          slug: demoSlug,
        })
      } catch (err) {
        AgentAudit.instance.warn('Failed to stage demo', {
          error: err.message,
        })
      }
    }
  }

  if (!fs.existsSync(sandboxPath)) {
    fs.mkdirSync(sandboxPath, { recursive: true })
  }

  var taskText = TASK_CREATE_TEXT
  if (mode === 'update') taskText = TASK_UPDATE_TEXT

  var template = fs.readFileSync(
    path.join(__dirname, 'prompt-template.md'), 'utf-8'
  )

  var compiled = compileTemplate(template, {
    TASK: taskText,
    SANDBOX_PATH: sandboxPath,
    SCAFFOLD_PATH: scaffoldPath,
    REQUEST: userPrompt || JSON.stringify(sanitized, null, 2),
    DEMO_NAME: demoSlug,
    ACTION: mode,
  })

  var result
  try {
    result = AgentTools.instance.run(
      subsystem, compiled, { timeout: 300000 }
    )
  } catch (err) {
    AgentAudit.instance.error('Subsystem call failed', {
      subsystem: subsystem,
      error: err.message,
    })
    return res.json({
      error: err.message,
      audit: { status: 'error', subsystem: subsystem, action: mode },
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

  if (parsed.error) {
    return res.json(parsed)
  }

  var demo = parsed.demo || {}
  demo.name = demoSlug
  demo.updatedAt = new Date().toISOString()
  if (mode === 'create') {
    demo.createdAt = demo.updatedAt
  }

  if (storagePath && fs.existsSync(sandboxPath)) {
    var gcsBase = storagePath + '/' + demoSlug

    try {
      await AgentStorage.instance.pushArchive(
        sandboxPath, gcsBase + '/source.tar.gz'
      )
      AgentAudit.instance.info('Demo archived to storage', {
        slug: demoSlug,
      })
    } catch (err) {
      AgentAudit.instance.warn('Storage archive failed', {
        error: err.message,
      })
    }

    try {
      var meta = JSON.stringify(demo, null, 2)
      await AgentStorage.instance.writeRaw(gcsBase + '/demo.json', meta)
    } catch (err) {
      AgentAudit.instance.warn('Meta write failed', {
        error: err.message,
      })
    }

    try {
      var cpUrl = process.env.AR_CONTROL_PLANE_URL || ''
      if (cpUrl) {
        var cpToken = await getIdentityToken(cpUrl)
        var endpoint = cpUrl + '/api/demos/' + demoSlug + '/deploy'
        var deployRes = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + cpToken,
          },
          body: JSON.stringify({ name: demoSlug }),
        })
        if (deployRes.ok) {
          var deployData = await deployRes.json()
          demo.url = deployData.url || ''
        }
        AgentAudit.instance.info('Demo deploy requested', {
          slug: demoSlug,
        })
      }
    } catch (err) {
      AgentAudit.instance.warn('Deploy request failed', {
        error: err.message,
      })
    }
  }

  var output = {
    demo: demo,
    audit: parsed.audit || { action: mode, status: 'success' },
  }
  output = AgentSecurity.instance.sanitize(output, 'output')

  await AgentAudit.instance.log('executed', {
    subsystem: subsystem,
    action: mode,
    demoName: demoSlug,
    inputLength: JSON.stringify(body).length,
    outputLength: JSON.stringify(output).length,
  })

  res.json(output)
}
`

const README_MD = `---
name: {{slug}}
description: Demo builder agent that scaffolds fullstack apps from prompts.
---

# {{name}}

A function-based agent that creates, updates, and versions demo applications.
Powered by the **{{subsystem}}** subsystem.

## How It Works

The function handler orchestrates the full lifecycle. The subsystem agent only
generates or edits code in a sandbox directory.

1. Receives a request with a prompt and optional demo name/version
2. Resolves whether this is a new demo, an update, or a new version
3. Stages existing code from GCS to the sandbox if updating
4. Compiles the prompt template with mode-specific context
5. Invokes the subsystem to generate or edit code in the sandbox
6. Archives the sandbox to versioned GCS storage
7. Deploys to Cloud Run via the control plane
8. Returns the demo metadata with a public URL

## Request Format

\`\`\`json
{
  "prompt": "Build a todo app with drag-and-drop",
  "name": "my-todo-app",
  "version": "0.0.1",
  "files": [{ "name": "logo.png", "content": "<base64>" }]
}
\`\`\`

- \`prompt\` (required) -- what to build or change
- \`name\` (optional) -- slug of an existing demo to update
- \`version\` (optional) -- specific version to update (requires name)
- \`files\` (optional) -- file overrides to include in the request

## Response Format

\`\`\`json
{
  "demo": {
    "name": "my-todo-app",
    "version": "0.0.1",
    "url": "https://demo-dev-my-todo-app.run.app",
    "summary": "A drag-and-drop todo application..."
  }
}
\`\`\`
`

function compileDefault(
  context: TemplateContext,
): Record<string, string> {
  const handler = HANDLER_TEMPLATE
    .replace('TASK_CREATE_TEXT', () => JSON.stringify(TASK_CREATE))
    .replace('TASK_UPDATE_TEXT', () => JSON.stringify(TASK_UPDATE))
  return {
    'index.js': handler,
    'prompt-template.md': PROMPT_TEMPLATE_MD,
    'README.md': replace(README_MD, context, 'cursor'),
  }
}

export { compileDefault }
