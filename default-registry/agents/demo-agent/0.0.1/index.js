const fs = require('fs')
const path = require('path')

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)
}

function compileTemplate(template, vars) {
  let result = template
  for (const key in vars) {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) continue
    const pattern = new RegExp('\\{\\{' + key + '\\}\\}', 'g')
    result = result.replace(pattern, vars[key])
  }
  return result
}

async function hasExisting(storagePath, slug) {
  try {
    const paths = await AgentStorage.instance.listRaw(
      storagePath + '/' + slug,
    )
    return paths.some((p) => p.endsWith('/demo.json'))
  } catch {
    return false
  }
}

exports.handler = async (req, res) => {
  const body = typeof req.body === 'string'
    ? JSON.parse(req.body)
    : (req.body || {})
  const sanitized = AgentSecurity.instance.sanitize(body, 'input')
  AgentAudit.instance.info('Demo request received', {
    length: JSON.stringify(body).length,
  })

  const env = AgentEnvironment.instance
  const demoRoot = process.env.DEMO_ROOT || '/tmp/demos'
  const scaffoldPath = process.env.DEMO_SCAFFOLD || '/tmp/scaffold'
  const storagePath = sanitized.storagePrefix ||
    process.env.DEMO_STORAGE_PREFIX || ''
  const subsystem = env.subsystem

  const payloadTenant = storagePath.split('/')[0]
  if (payloadTenant && payloadTenant !== env.tenant) {
    AgentStorage.init({
      controlPlaneUrl: process.env.AR_CONTROL_PLANE_URL || '',
      token: process.env.AR_TOKEN || '',
      bucket: process.env.AR_BUCKET || '',
      tenantId: payloadTenant,
      agentId: env.agentSlug,
    })
  }

  if (!fs.existsSync(demoRoot)) {
    fs.mkdirSync(demoRoot, { recursive: true })
  }

  const userPrompt = sanitized.prompt || ''

  let mode = 'create'
  const demoSlug = sanitized.name
    ? slugify(sanitized.name)
    : slugify(userPrompt.slice(0, 48) || 'untitled')
  const sandboxPath = path.join(demoRoot, demoSlug)

  if (storagePath && sanitized.name) {
    const existing = await hasExisting(storagePath, demoSlug)
    if (existing) {
      mode = 'update'
      const archivePath = storagePath + '/' + demoSlug + '/source.tar.gz'
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

  const attachments = sanitized.files || []
  const attachmentPaths = []
  if (attachments.length > 0) {
    const attachDir = path.join(sandboxPath, 'attachments')
    fs.mkdirSync(attachDir, { recursive: true })
    for (const file of attachments) {
      if (!file.url || !file.name) continue
      try {
        const resp = await fetch(file.url)
        if (!resp.ok) throw new Error('HTTP ' + resp.status)
        const buf = Buffer.from(await resp.arrayBuffer())
        const dest = path.join(attachDir, file.name)
        fs.writeFileSync(dest, buf)
        attachmentPaths.push(dest)
      } catch (err) {
        AgentAudit.instance.warn('Attachment download failed', {
          name: file.name,
          error: err.message,
        })
      }
    }
    if (attachmentPaths.length > 0) {
      AgentAudit.instance.info('Attachments staged', {
        count: attachmentPaths.length,
      })
    }
  }

  let taskText = 'Create a NEW demo application from scratch. Copy the scaffolding template to the workspace and build the app described in the request below.'
  if (mode === 'update') taskText = 'Update an EXISTING demo application. The current source code is already in the workspace at the path below. Apply the changes described in the request to the existing code, then rebuild the app.'

  const template = fs.readFileSync(
    path.join(__dirname, 'prompt-template.md'), 'utf-8',
  )

  let request = userPrompt || JSON.stringify(sanitized, null, 2)
  if (attachmentPaths.length > 0) {
    request += '\n\nAttached files (available in the workspace):\n' +
      attachmentPaths.map((p) => '- ' + p).join('\n')
  }

  const compiled = compileTemplate(template, {
    TASK: taskText,
    SANDBOX_PATH: sandboxPath,
    SCAFFOLD_PATH: scaffoldPath,
    REQUEST: request,
    DEMO_NAME: demoSlug,
    ACTION: mode,
  })

  if (!fs.existsSync(sandboxPath)) {
    fs.mkdirSync(sandboxPath, { recursive: true })
  }
  let result
  try {
    result = AgentTools.instance.run(
      subsystem, compiled, { timeout: 300000, cwd: sandboxPath },
    )
  } catch (err) {
    AgentAudit.instance.error('Subsystem call failed', {
      subsystem,
      error: err.message,
    })
    return res.json({
      error: err.message,
      audit: { status: 'error', subsystem, action: mode },
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

  if (parsed.error) {
    return res.json(parsed)
  }

  const demo = parsed.demo || {}
  demo.name = demoSlug
  demo.updatedAt = new Date().toISOString()
  if (mode === 'create') {
    demo.createdAt = demo.updatedAt
  }

  if (storagePath && fs.existsSync(sandboxPath)) {
    const gcsBase = storagePath + '/' + demoSlug

    try {
      await AgentStorage.instance.pushArchive(
        sandboxPath, gcsBase + '/source.tar.gz',
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
      await AgentStorage.instance.writeRaw(
        gcsBase + '/demo.json',
        JSON.stringify(demo, null, 2),
      )
    } catch (err) {
      AgentAudit.instance.warn('Meta write failed', {
        error: err.message,
      })
    }

    try {
      const cpUrl = process.env.AR_CONTROL_PLANE_URL || ''
      if (cpUrl) {
        const endpoint = cpUrl + '/api/demos/' + demoSlug + '/deploy'
        const deployHeaders = { 'Content-Type': 'application/json' }
        if (process.env.AR_TOKEN) {
          deployHeaders['Authorization'] = 'Bearer ' + process.env.AR_TOKEN
        }
        const deployRes = await fetch(endpoint, {
          method: 'POST',
          headers: deployHeaders,
          body: JSON.stringify({ name: demoSlug }),
        })
        if (deployRes.ok) {
          const deployData = await deployRes.json()
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

  let output = {
    demo,
    audit: parsed.audit || { action: mode, status: 'success' },
  }
  output = AgentSecurity.instance.sanitize(output, 'output')

  await AgentAudit.instance.log('executed', {
    subsystem,
    action: mode,
    demoName: demoSlug,
    inputLength: JSON.stringify(body).length,
    outputLength: JSON.stringify(output).length,
  })

  res.json(output)
}
