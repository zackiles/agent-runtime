/* eslint-disable */
// deno-lint-ignore-file
// @ts-nocheck

const http = require('http')
const path = require('path')
const fs = require('fs')

const runtimeDir = process.env.AR_RUNTIME_DIR || '/app/runtime'
const agentDir = process.env.AR_AGENT_DIR || '/app/agent'
const toolsDir = process.env.AR_TOOLS_DIR || '/app/tools'
const PORT = parseInt(process.env.PORT || '8080', 10)

const rt = require(path.join(runtimeDir, '_runtime.cjs'))

Object.assign(globalThis, {
  AgentStorage: rt.AgentStorage,
  AgentTools: rt.AgentTools,
  AgentSession: rt.AgentSession,
  AgentEnvironment: rt.AgentEnvironment,
  AgentSecurity: rt.AgentSecurity,
  AgentSecrets: rt.AgentSecrets,
  AgentAudit: rt.AgentAudit,
  bootstrap: rt.bootstrap,
})

let manifest = {}
try {
  manifest = JSON.parse(
    fs.readFileSync(path.join(agentDir, 'agent.json'), 'utf-8'),
  )
} catch {}

const slug = manifest.slug || process.env.AR_AGENT_SLUG || 'unknown'
const cpUrl = process.env.AR_CONTROL_PLANE_URL || ''
const token = process.env.AR_TOKEN || ''

const toolConfigs = []
try {
  for (const dir of fs.readdirSync(toolsDir)) {
    try {
      const cfg = JSON.parse(
        fs.readFileSync(path.join(toolsDir, dir, 'tool.json'), 'utf-8'),
      )
      toolConfigs.push(cfg)
    } catch {}
  }
} catch {}

rt.AgentSecurity.init()
rt.AgentSecrets.init(cpUrl, token)
rt.AgentAudit.init({
  controlPlaneUrl: cpUrl,
  token,
  agentId: slug,
  tenantId: process.env.AR_TENANT_ID || 'development',
})
rt.AgentEnvironment.init({
  tenant: process.env.AR_TENANT_ID || 'development',
  agentName: manifest.name || process.env.AR_AGENT_NAME || 'unknown',
  agentVersion: manifest.version || process.env.AR_AGENT_VERSION || '0.0.1',
  agentSlug: slug,
  department: '',
  team: '',
  owners: [],
  publishedAt: '',
  updatedAt: '',
  subsystem: manifest.subsystem || process.env.AR_SUBSYSTEM || null,
})
rt.AgentTools.init(toolsDir, toolConfigs)
rt.AgentStorage.init({
  controlPlaneUrl: cpUrl,
  token,
  bucket: process.env.AR_BUCKET || '',
  tenantId: process.env.AR_TENANT_ID || 'development',
  agentId: slug,
})

let handler

try {
  const handlerModule = require(path.join(agentDir, 'index.js'))
  handler = handlerModule.handler || handlerModule.default
} catch (err) {
  console.error('Failed to load agent handler:', err.message)
  handler = (_req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        error: 'Agent handler failed to load',
        detail: err.message,
      }),
    )
  }
}

function shimResponse(res) {
  res.status = (code) => {
    res.statusCode = code
    return res
  }
  res.json = (data) => {
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'application/json')
    }
    res.end(JSON.stringify(data))
  }
  res.send = (data) => {
    if (typeof data === 'object') return res.json(data)
    res.end(String(data))
  }
  return res
}

const server = http.createServer(async (req, res) => {
  shimResponse(res)

  if (req.method === 'GET' && req.url === '/health') {
    return res.json({ status: 'ok' })
  }

  await rt.ensureToken()

  let body = ''
  for await (const chunk of req) body += chunk
  req.body = body ? JSON.parse(body) : {}

  try {
    await handler(req, res)
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
    }
  }
})

server.listen(PORT, () => {
  console.log(`Agent server listening on port ${PORT}`)
})
