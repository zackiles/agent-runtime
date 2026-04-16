import type {
  ContainerDeployOptions,
  CronTriggerOptions,
  DeployOptions,
  EventarcTriggerInfo,
  FunctionInfo,
  FunctionUpdateOptions,
  Platform,
  PubsubTriggerOptions,
  SchedulerJobInfo,
  SecretInfo,
} from './types.ts'

let cachedToken: { value: string; expiry: number } | null = null

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiry) return cachedToken.value

  try {
    const res = await fetch(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      { headers: { 'Metadata-Flavor': 'Google' } },
    )
    if (res.ok) {
      const data = await res.json() as {
        access_token: string
        expires_in: number
      }
      cachedToken = {
        value: data.access_token,
        expiry: Date.now() + (data.expires_in - 60) * 1000,
      }
      return cachedToken.value
    }
  } catch {
    // not on GCP compute, fall through to gcloud
  }

  const cmd = new Deno.Command('gcloud', {
    args: ['auth', 'application-default', 'print-access-token'],
    stdout: 'piped',
    stderr: 'piped',
  })
  const output = await cmd.output()
  if (!output.success) {
    throw new Error(
      'Failed to get access token. Run `gcloud auth application-default login`.',
    )
  }
  const token = new TextDecoder().decode(output.stdout).trim()
  cachedToken = { value: token, expiry: Date.now() + 50 * 60 * 1000 }
  return token
}

type FetchOptions = {
  method?: string
  body?: unknown
  raw?: boolean
}

async function gcpFetch<T>(
  url: string,
  opts?: FetchOptions,
): Promise<T> {
  const token = await getAccessToken()
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  }

  const init: RequestInit = {
    method: opts?.method || 'GET',
    headers,
  }
  if (opts?.body !== undefined) {
    init.body = JSON.stringify(opts.body)
  }

  const res = await fetch(url, init)

  if (!res.ok) {
    const text = await res.text()
    let message = `GCP API error ${res.status}: ${res.statusText}`
    try {
      const err = JSON.parse(text) as {
        error?: { message?: string }
      }
      if (err.error?.message) message = err.error.message
    } catch {
      if (text) message = text
    }
    throw new Error(message)
  }

  if (opts?.raw) return '' as unknown as T
  const text = await res.text()
  if (!text) return {} as T
  return JSON.parse(text) as T
}

// IMPORTANT: This swallows all errors (404, 403, network) into { ok: false }.
// Used for idempotent "exists before create" checks, not for security-gating
// decisions. Do not use this where 403 vs 404 distinction matters.
async function gcpFetchSilent<T>(
  url: string,
  opts?: FetchOptions,
): Promise<{ ok: boolean; data?: T | undefined }> {
  try {
    const data = await gcpFetch<T>(url, opts)
    return { ok: true, data }
  } catch {
    return { ok: false }
  }
}

function functionsUrl(project: string, region: string): string {
  return `https://cloudfunctions.googleapis.com/v2/projects/${project}/locations/${region}/functions`
}

function secretsUrl(project: string): string {
  return `https://secretmanager.googleapis.com/v1/projects/${project}/secrets`
}

function schedulerUrl(project: string, region: string): string {
  return `https://cloudscheduler.googleapis.com/v1/projects/${project}/locations/${region}/jobs`
}

function eventarcUrl(project: string, region: string): string {
  return `https://eventarc.googleapis.com/v1/projects/${project}/locations/${region}/triggers`
}

function shortName(fullPath: string): string {
  return fullPath.split('/').pop() || fullPath
}

async function waitForOperation(
  operationUrl: string,
  timeoutMs = 300000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const op = await gcpFetch<{ done?: boolean; error?: { message: string } }>(
      operationUrl,
    )
    if (op.done) {
      if (op.error) throw new Error(op.error.message)
      return
    }
    await new Promise((r) => setTimeout(r, 5000))
  }
  throw new Error('Operation timed out')
}

async function getServiceAccountEmail(): Promise<string> {
  try {
    const res = await fetch(
      'http://metadata.google.internal/computeMetadata/v1/' +
        'instance/service-accounts/default/email',
      { headers: { 'Metadata-Flavor': 'Google' } },
    )
    if (res.ok) return (await res.text()).trim()
  } catch {
    // not on GCP compute
  }
  const cmd = new Deno.Command('gcloud', {
    args: ['config', 'get-value', 'account'],
    stdout: 'piped',
    stderr: 'piped',
  })
  const out = await cmd.output()
  if (!out.success) {
    throw new Error('Could not determine service account email')
  }
  return new TextDecoder().decode(out.stdout).trim()
}

async function compressToZip(dir: string): Promise<Uint8Array> {
  const tmpDir = await Deno.makeTempDir()
  const tmpZip = `${tmpDir}/source.zip`
  try {
    const cmd = new Deno.Command('zip', {
      args: ['-r', tmpZip, '.'],
      cwd: dir,
      stdout: 'piped',
      stderr: 'piped',
    })
    const out = await cmd.output()
    if (!out.success) {
      throw new Error(
        `zip failed: ${new TextDecoder().decode(out.stderr)}`,
      )
    }
    return await Deno.readFile(tmpZip)
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {})
  }
}

const gcpRest: Platform = {
  async validateProject(project: string): Promise<void> {
    await gcpFetch(
      `https://cloudresourcemanager.googleapis.com/v1/projects/${project}`,
    )
  },

  async secretDescribe(name: string, project: string): Promise<boolean> {
    const result = await gcpFetchSilent(`${secretsUrl(project)}/${name}`)
    return result.ok
  },

  async secretCreate(
    name: string,
    project: string,
    region: string,
  ): Promise<void> {
    await gcpFetch(`${secretsUrl(project)}?secretId=${name}`, {
      method: 'POST',
      body: {
        replication: {
          userManaged: {
            replicas: [{ location: region }],
          },
        },
      },
    })
  },

  async secretAddVersion(
    name: string,
    project: string,
    value: string,
  ): Promise<void> {
    const encoded = btoa(value)
    await gcpFetch(
      `${secretsUrl(project)}/${name}:addVersion`,
      {
        method: 'POST',
        body: { payload: { data: encoded } },
      },
    )
  },

  async secretGrantAccess(
    name: string,
    project: string,
    runtimeAccount: string,
  ): Promise<void> {
    const resourceUrl = `${secretsUrl(project)}/${name}:getIamPolicy`
    const policy = await gcpFetch<{
      bindings?: Array<{ role: string; members: string[] }>
      etag?: string
    }>(resourceUrl)

    const role = 'roles/secretmanager.secretAccessor'
    const member = `serviceAccount:${runtimeAccount}`
    const bindings = policy.bindings || []

    const existing = bindings.find((b) => b.role === role)
    if (existing) {
      if (!existing.members.includes(member)) {
        existing.members.push(member)
      }
    } else {
      bindings.push({ role, members: [member] })
    }

    await gcpFetch(
      `${secretsUrl(project)}/${name}:setIamPolicy`,
      {
        method: 'POST',
        body: { policy: { bindings, etag: policy.etag } },
      },
    )
  },

  async secretDelete(name: string, project: string): Promise<void> {
    await gcpFetch(`${secretsUrl(project)}/${name}`, {
      method: 'DELETE',
      raw: true,
    })
  },

  async secretList(project: string): Promise<SecretInfo[]> {
    const data = await gcpFetch<{
      secrets?: Array<{ name: string; createTime: string }>
    }>(secretsUrl(project))
    return (data.secrets || []).map((s) => ({
      name: shortName(s.name),
      createTime: s.createTime,
    }))
  },

  async containerDeploy(opts: ContainerDeployOptions): Promise<void> {
    const runBase =
      `https://run.googleapis.com/v2/projects/${opts.project}/locations/${opts.region}`

    const secretEnvVars = opts.secrets
      ? Object.entries(opts.secrets).map(([key, secretName]) => ({
        name: key,
        valueSource: {
          secretKeyRef: {
            secret: `projects/${opts.project}/secrets/${secretName}`,
            version: 'latest',
          },
        },
      }))
      : []

    const envVars = [
      ...(opts.env
        ? Object.entries(opts.env).map(([name, value]) => ({ name, value }))
        : []),
      ...secretEnvVars,
    ]

    const volumes: Record<string, unknown>[] = []
    const volumeMounts: Record<string, unknown>[] = []
    if (opts.fuseBucket) {
      volumes.push({
        name: 'registry',
        gcs: { bucket: opts.fuseBucket, readOnly: true },
      })
      volumeMounts.push({
        name: 'registry',
        mountPath: '/registry',
      })
    }

    const serviceBody = {
      template: {
        ...(volumes.length > 0 ? { volumes } : {}),
        containers: [{
          image: opts.image,
          ports: [{ containerPort: opts.port || 8080 }],
          ...(envVars.length > 0 ? { env: envVars } : {}),
          ...(volumeMounts.length > 0 ? { volumeMounts } : {}),
          resources: {
            limits: {
              memory: opts.memory || '1Gi',
              cpu: opts.cpu || '1',
            },
          },
        }],
        scaling: { minInstanceCount: 0, maxInstanceCount: 1 },
        serviceAccount: opts.workerAccount || opts.runtimeAccount,
      },
      ingress: 'INGRESS_TRAFFIC_ALL',
    }

    const existing = await gcpFetchSilent(
      `${runBase}/services/${opts.agentId}`,
    )

    if (existing.ok) {
      const op = await gcpFetch<{ name: string }>(
        `${runBase}/services/${opts.agentId}`,
        { method: 'PATCH', body: serviceBody },
      )
      if (op.name) {
        await waitForOperation(
          `https://run.googleapis.com/v2/${op.name}`,
        )
      }
    } else {
      const op = await gcpFetch<{ name: string }>(
        `${runBase}/services?serviceId=${opts.agentId}`,
        { method: 'POST', body: serviceBody },
      )
      if (op.name) {
        await waitForOperation(
          `https://run.googleapis.com/v2/${op.name}`,
        )
      }
    }
  },

  async containerDelete(
    agentId: string,
    region: string,
    project: string,
  ): Promise<void> {
    const url =
      `https://run.googleapis.com/v2/projects/${project}/locations/${region}/services/${agentId}`
    const op = await gcpFetch<{ name: string }>(url, {
      method: 'DELETE',
    })
    if (op.name) {
      await waitForOperation(
        `https://run.googleapis.com/v2/${op.name}`,
      )
    }
  },

  async functionDeploy(opts: DeployOptions): Promise<void> {
    const base = functionsUrl(opts.project, opts.region)
    const name =
      `projects/${opts.project}/locations/${opts.region}/functions/${opts.agentId}`

    const projData = await gcpFetch<{ projectNumber: string }>(
      `https://cloudresourcemanager.googleapis.com/v1/projects/${opts.project}`,
    )
    const projectNumber = projData.projectNumber

    const sourceBucket = `gcf-v2-sources-${projectNumber}-${opts.region}`
    const sourceObject = `${opts.agentId}-${Date.now()}.zip`

    const sourceDir = opts.source
    const zipData = await compressToZip(sourceDir)
    await gcpRest.storageUpload(sourceBucket, sourceObject, zipData)

    const objMeta = await gcpFetch<{ generation: string }>(
      `https://storage.googleapis.com/storage/v1/b/${sourceBucket}/o/${
        encodeURIComponent(sourceObject)
      }`,
    )

    const secretEnvVars = opts.secrets
      ? Object.entries(opts.secrets).map(([key, secretName]) => ({
        key,
        projectId: opts.project,
        secret: secretName,
        version: 'latest',
      }))
      : []

    const functionBody = {
      name,
      environment: 'GEN_2',
      buildConfig: {
        runtime: opts.runtime,
        entryPoint: opts.entryPoint,
        source: {
          storageSource: {
            bucket: sourceBucket,
            object: sourceObject,
            generation: objMeta.generation,
          },
        },
      },
      serviceConfig: {
        serviceAccountEmail: opts.workerAccount || opts.runtimeAccount,
        availableMemory: opts.memory || '1Gi',
        timeoutSeconds: parseInt(
          (opts.timeout || '540s').replace('s', ''),
        ),
        availableCpu: opts.cpu || '1',
        ...(opts.vpcConnector
          ? {
            vpcConnector:
              `projects/${opts.project}/locations/${opts.region}/connectors/${opts.vpcConnector}`,
          }
          : {}),
        secretEnvironmentVariables: secretEnvVars.length > 0
          ? secretEnvVars
          : undefined,
        ...(opts.env && Object.keys(opts.env).length > 0
          ? { environmentVariables: opts.env }
          : {}),
      },
    }

    const existing = await gcpFetchSilent(`${base}/${opts.agentId}`)

    let op: { name: string }
    if (existing.ok) {
      op = await gcpFetch<{ name: string }>(`${base}/${opts.agentId}`, {
        method: 'PATCH',
        body: functionBody,
      })
    } else {
      op = await gcpFetch<{ name: string }>(
        `${base}?functionId=${opts.agentId}`,
        { method: 'POST', body: functionBody },
      )
    }

    if (op.name) {
      await waitForOperation(
        `https://cloudfunctions.googleapis.com/v2/${op.name}`,
      )
    }
  },

  async functionDescribeUri(
    agentId: string,
    region: string,
    project: string,
  ): Promise<string> {
    const data = await gcpFetch<{
      serviceConfig?: { uri?: string }
    }>(`${functionsUrl(project, region)}/${agentId}`)
    return data.serviceConfig?.uri || ''
  },

  async functionDescribeState(
    agentId: string,
    region: string,
    project: string,
  ): Promise<string> {
    const data = await gcpFetch<{ state?: string }>(
      `${functionsUrl(project, region)}/${agentId}`,
    )
    return data.state || ''
  },

  async functionDelete(
    agentId: string,
    region: string,
    project: string,
  ): Promise<void> {
    const op = await gcpFetch<{ name?: string }>(
      `${functionsUrl(project, region)}/${agentId}`,
      { method: 'DELETE' },
    )
    if (op.name) {
      await waitForOperation(
        `https://cloudfunctions.googleapis.com/v2/${op.name}`,
      )
    }
  },

  async functionList(
    project: string,
    region: string,
  ): Promise<FunctionInfo[]> {
    const data = await gcpFetch<{
      functions?: Array<{
        name: string
        state: string
        serviceConfig?: { uri?: string }
      }>
    }>(`${functionsUrl(project, region)}`)
    return (data.functions || []).map((f) => ({
      name: shortName(f.name),
      state: f.state,
      uri: f.serviceConfig?.uri,
    }))
  },

  async functionListDetailed(
    project: string,
    region: string,
  ): Promise<FunctionInfo[]> {
    const data = await gcpFetch<{
      functions?: Array<{
        name: string
        state: string
        serviceConfig?: {
          uri?: string
          availableMemory?: string
          availableCpu?: string
          timeoutSeconds?: string
        }
      }>
    }>(`${functionsUrl(project, region)}`)
    return (data.functions || []).map((f) => ({
      name: shortName(f.name),
      state: f.state,
      uri: f.serviceConfig?.uri,
      memory: f.serviceConfig?.availableMemory,
      cpu: f.serviceConfig?.availableCpu,
      timeout: f.serviceConfig?.timeoutSeconds
        ? `${f.serviceConfig.timeoutSeconds}s`
        : undefined,
    }))
  },

  async functionLogs(
    agentId: string,
    _region: string,
    project: string,
    limit: number,
  ): Promise<string> {
    const data = await gcpFetch<{
      entries?: Array<{
        timestamp: string
        severity?: string
        textPayload?: string
        jsonPayload?: { message?: string }
      }>
    }>('https://logging.googleapis.com/v2/entries:list', {
      method: 'POST',
      body: {
        resourceNames: [`projects/${project}`],
        filter:
          `resource.type="cloud_function" resource.labels.function_name="${agentId}"`,
        orderBy: 'timestamp desc',
        pageSize: limit,
      },
    })
    return (data.entries || [])
      .reverse()
      .map((e) => {
        const msg = e.textPayload || e.jsonPayload?.message || ''
        return `${e.severity || 'INFO'}\t${agentId}\t${e.timestamp}\t${msg}`
      })
      .join('\n')
  },

  async functionUpdate(opts: FunctionUpdateOptions): Promise<void> {
    const base = functionsUrl(opts.project, opts.region)
    const updateField = opts.option === 'timeout'
      ? 'timeoutSeconds'
      : opts.option === 'max-instances'
      ? 'maxInstanceCount'
      : opts.option === 'min-instances'
      ? 'minInstanceCount'
      : opts.option

    const serviceConfig: Record<string, string> = {}
    if (opts.option === 'memory') serviceConfig.availableMemory = opts.value
    else if (opts.option === 'timeout') {
      serviceConfig.timeoutSeconds = opts.value.replace('s', '')
    } else if (opts.option === 'max-instances') {
      serviceConfig.maxInstanceCount = opts.value
    } else if (opts.option === 'min-instances') {
      serviceConfig.minInstanceCount = opts.value
    } else if (opts.option === 'concurrency') {
      serviceConfig.maxInstanceRequestConcurrency = opts.value
    }

    const op = await gcpFetch<{ name?: string }>(
      `${base}/${opts.agentId}?updateMask=serviceConfig.${updateField}`,
      { method: 'PATCH', body: { serviceConfig } },
    )
    if (op.name) {
      await waitForOperation(
        `https://cloudfunctions.googleapis.com/v2/${op.name}`,
      )
    }
  },

  async functionSecretConsumers(
    secretName: string,
    project: string,
    region: string,
  ): Promise<string[]> {
    const base = functionsUrl(project, region)
    const data = await gcpFetch<{
      functions?: Array<{
        name: string
        serviceConfig?: {
          secretEnvironmentVariables?: Array<{ secret: string }>
        }
      }>
    }>(base)
    return (data.functions || [])
      .filter((f) =>
        f.serviceConfig?.secretEnvironmentVariables?.some(
          (s) => s.secret === secretName,
        )
      )
      .map((f) => f.name.split('/').pop()!)
  },

  async functionRefreshSecret(
    agentId: string,
    region: string,
    project: string,
  ): Promise<void> {
    const base = functionsUrl(project, region)
    const fn = await gcpFetch<{
      serviceConfig?: {
        secretEnvironmentVariables?: Array<{
          key: string
          projectId: string
          secret: string
          version: string
        }>
      }
    }>(`${base}/${agentId}`)
    const secrets = fn.serviceConfig?.secretEnvironmentVariables
    if (!secrets?.length) return
    const refreshed = secrets.map((s) => ({
      ...s,
      version: 'latest',
    }))
    const op = await gcpFetch<{ name?: string }>(
      `${base}/${agentId}?updateMask=serviceConfig.secretEnvironmentVariables`,
      {
        method: 'PATCH',
        body: {
          serviceConfig: { secretEnvironmentVariables: refreshed },
        },
      },
    )
    if (op.name) {
      await waitForOperation(
        `https://cloudfunctions.googleapis.com/v2/${op.name}`,
      )
    }
  },

  async grantRunInvoker(
    agentId: string,
    region: string,
    project: string,
    runtimeAccount: string,
  ): Promise<void> {
    const serviceUrl =
      `https://run.googleapis.com/v1/projects/${project}/locations/${region}/services/${agentId}`

    const policy = await gcpFetch<{
      bindings?: Array<{ role: string; members: string[] }>
      etag?: string
    }>(`${serviceUrl}:getIamPolicy`)

    const role = 'roles/run.invoker'
    const member = `serviceAccount:${runtimeAccount}`
    const bindings = policy.bindings || []

    const existing = bindings.find((b) => b.role === role)
    if (existing) {
      if (!existing.members.includes(member)) {
        existing.members.push(member)
      }
    } else {
      bindings.push({ role, members: [member] })
    }

    await gcpFetch(`${serviceUrl}:setIamPolicy`, {
      method: 'POST',
      body: { policy: { bindings, etag: policy.etag } },
    })
  },

  async schedulerCreate(opts: CronTriggerOptions): Promise<void> {
    await gcpFetch(schedulerUrl(opts.project, opts.region), {
      method: 'POST',
      body: {
        name:
          `projects/${opts.project}/locations/${opts.region}/jobs/${opts.name}`,
        schedule: opts.schedule,
        timeZone: opts.timezone,
        httpTarget: {
          uri: opts.uri,
          httpMethod: 'POST',
          oidcToken: {
            serviceAccountEmail: opts.runtimeAccount,
          },
        },
      },
    })
  },

  async schedulerDelete(
    name: string,
    region: string,
    project: string,
  ): Promise<void> {
    await gcpFetch(`${schedulerUrl(project, region)}/${name}`, {
      method: 'DELETE',
      raw: true,
    })
  },

  async schedulerList(
    project: string,
    region: string,
    filter?: string,
  ): Promise<SchedulerJobInfo[]> {
    let url = schedulerUrl(project, region)
    if (filter) url += `?filter=${encodeURIComponent(filter)}`
    const data = await gcpFetch<{
      jobs?: Array<{
        name: string
        schedule?: string
        timeZone?: string
        httpTarget?: { uri?: string }
      }>
    }>(url)
    return (data.jobs || []).map((j) => ({
      name: shortName(j.name),
      schedule: j.schedule,
      timezone: j.timeZone,
      uri: j.httpTarget?.uri,
    }))
  },

  async schedulerDescribe(
    name: string,
    region: string,
    project: string,
  ): Promise<boolean> {
    const result = await gcpFetchSilent(
      `${schedulerUrl(project, region)}/${name}`,
    )
    return result.ok
  },

  async eventarcCreate(opts: PubsubTriggerOptions): Promise<void> {
    const op = await gcpFetch<{ name?: string }>(
      `${eventarcUrl(opts.project, opts.region)}?triggerId=${opts.name}`,
      {
        method: 'POST',
        body: {
          destination: {
            cloudRun: {
              service: opts.agentId,
              region: opts.region,
            },
          },
          eventFilters: [
            {
              attribute: 'type',
              value: 'google.cloud.pubsub.topic.v1.messagePublished',
            },
          ],
          transport: {
            pubsub: {
              topic: `projects/${opts.project}/topics/${opts.topic}`,
            },
          },
          serviceAccount: `${opts.runtimeAccount}`,
        },
      },
    )
    if (op.name) {
      await waitForOperation(`https://eventarc.googleapis.com/v1/${op.name}`)
    }
  },

  async eventarcDelete(
    name: string,
    region: string,
    project: string,
  ): Promise<void> {
    const op = await gcpFetch<{ name?: string }>(
      `${eventarcUrl(project, region)}/${name}`,
      { method: 'DELETE' },
    )
    if (op.name) {
      await waitForOperation(`https://eventarc.googleapis.com/v1/${op.name}`)
    }
  },

  async eventarcList(
    project: string,
    region: string,
    filter?: string,
  ): Promise<EventarcTriggerInfo[]> {
    let url = eventarcUrl(project, region)
    if (filter) url += `?filter=${encodeURIComponent(filter)}`
    const data = await gcpFetch<{
      triggers?: Array<{
        name: string
        transport?: { pubsub?: { topic?: string } }
        destination?: { cloudRun?: { service?: string } }
      }>
    }>(url)
    return (data.triggers || []).map((t) => ({
      name: shortName(t.name),
      topic: t.transport?.pubsub?.topic
        ? shortName(t.transport.pubsub.topic)
        : undefined,
      service: t.destination?.cloudRun?.service,
    }))
  },

  async eventarcDescribe(
    name: string,
    region: string,
    project: string,
  ): Promise<boolean> {
    const result = await gcpFetchSilent(
      `${eventarcUrl(project, region)}/${name}`,
    )
    return result.ok
  },

  getAccessToken,

  async getIdentityToken(audience?: string): Promise<string> {
    const aud = audience || 'https://unspecified.invalid'
    try {
      const res = await fetch(
        'http://metadata.google.internal/computeMetadata/v1/' +
          'instance/service-accounts/default/identity?audience=' +
          encodeURIComponent(aud),
        { headers: { 'Metadata-Flavor': 'Google' } },
      )
      if (res.ok) return await res.text()
    } catch {
      // not on GCP
    }
    const args = ['auth', 'print-identity-token']
    if (audience) args.push(`--audiences=${audience}`)
    const cmd = new Deno.Command('gcloud', {
      args,
      stdout: 'piped',
      stderr: 'piped',
    })
    const output = await cmd.output()
    if (!output.success) {
      throw new Error("Not authenticated. Run 'gcloud auth login'.")
    }
    return new TextDecoder().decode(output.stdout).trim()
  },

  async serviceAccountCreate(
    project: string,
    accountId: string,
    displayName: string,
  ): Promise<string> {
    await gcpFetch(
      `https://iam.googleapis.com/v1/projects/${project}/serviceAccounts`,
      {
        method: 'POST',
        body: {
          accountId,
          serviceAccount: { displayName },
        },
      },
    )
    return `${accountId}@${project}.iam.gserviceaccount.com`
  },

  async serviceAccountExists(
    project: string,
    email: string,
  ): Promise<boolean> {
    const result = await gcpFetchSilent(
      `https://iam.googleapis.com/v1/projects/${project}/serviceAccounts/${email}`,
    )
    return result.ok
  },

  async storageSign(
    bucket: string,
    path: string,
    method: string,
    ttl: number,
    contentType?: string,
  ): Promise<string> {
    const token = await getAccessToken()
    const email = await getServiceAccountEmail()

    const now = new Date()
    const stamp = now.toISOString()
      .replace(/[-:]/g, '').replace(/\.\d+/, '')
    const datestamp = stamp.slice(0, 8)
    const scope = `${datestamp}/auto/storage/goog4_request`
    const encoded = encodeURIComponent(path)

    const hdrs: Record<string, string> = {
      host: 'storage.googleapis.com',
    }
    if (contentType) hdrs['content-type'] = contentType
    const signedHeaders = Object.keys(hdrs).sort().join(';')
    const headerStr = Object.keys(hdrs).sort()
      .map((k) => `${k}:${hdrs[k]}`).join('\n')

    const params = new URLSearchParams({
      'X-Goog-Algorithm': 'GOOG4-RSA-SHA256',
      'X-Goog-Credential': `${email}/${scope}`,
      'X-Goog-Date': stamp,
      'X-Goog-Expires': String(ttl),
      'X-Goog-SignedHeaders': signedHeaders,
    })

    const canonical = [
      method,
      `/${bucket}/${encoded}`,
      params.toString(),
      headerStr + '\n',
      signedHeaders,
      'UNSIGNED-PAYLOAD',
    ].join('\n')

    const hash = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(canonical),
    )
    const hexHash = [...new Uint8Array(hash)]
      .map((b) => b.toString(16).padStart(2, '0')).join('')

    const stringToSign = [
      'GOOG4-RSA-SHA256',
      stamp,
      scope,
      hexHash,
    ].join('\n')

    const signRes = await fetch(
      `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${email}:signBlob`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ payload: btoa(stringToSign) }),
      },
    )
    if (!signRes.ok) {
      throw new Error(
        `signBlob failed: ${signRes.status} ${await signRes.text()}`,
      )
    }
    const { signedBlob } = await signRes.json() as {
      signedBlob: string
    }

    const sigBytes = Uint8Array.from(
      atob(signedBlob),
      (c) => c.charCodeAt(0),
    )
    const hexSig = [...sigBytes]
      .map((b) => b.toString(16).padStart(2, '0')).join('')

    return `https://storage.googleapis.com/${bucket}/${encoded}?${params}&X-Goog-Signature=${hexSig}`
  },

  async storageUpload(
    bucket: string,
    path: string,
    data: Uint8Array | string,
  ): Promise<void> {
    const token = await getAccessToken()
    const encoded = encodeURIComponent(path)
    const bodyBytes = typeof data === 'string'
      ? new TextEncoder().encode(data)
      : data
    const res = await fetch(
      `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?name=${encoded}&uploadType=media`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/octet-stream',
        },
        body: bodyBytes as BodyInit,
      },
    )
    if (!res.ok) {
      throw new Error(`GCS upload failed: ${res.status} ${res.statusText}`)
    }
    await res.text()
  },

  async storageDownload(
    bucket: string,
    path: string,
  ): Promise<Uint8Array> {
    const token = await getAccessToken()
    const encoded = encodeURIComponent(path)
    const res = await fetch(
      `https://storage.googleapis.com/download/storage/v1/b/${bucket}/o/${encoded}?alt=media`,
      { headers: { 'Authorization': `Bearer ${token}` } },
    )
    if (!res.ok) {
      throw new Error(`GCS download failed: ${res.status} ${res.statusText}`)
    }
    return new Uint8Array(await res.arrayBuffer())
  },

  async storageDelete(bucket: string, path: string): Promise<void> {
    const token = await getAccessToken()
    const encoded = encodeURIComponent(path)
    const res = await fetch(
      `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encoded}`,
      {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      },
    )
    if (!res.ok && res.status !== 404) {
      throw new Error(`GCS delete failed: ${res.status}`)
    }
  },

  async storageList(
    bucket: string,
    prefix: string,
  ): Promise<string[]> {
    const token = await getAccessToken()
    const encoded = encodeURIComponent(prefix)
    const res = await fetch(
      `https://storage.googleapis.com/storage/v1/b/${bucket}/o?prefix=${encoded}`,
      { headers: { 'Authorization': `Bearer ${token}` } },
    )
    if (!res.ok) return []
    const data = await res.json() as {
      items?: Array<{ name: string }>
    }
    return (data.items || []).map((i) => i.name)
  },

  async storageExists(
    bucket: string,
    path: string,
  ): Promise<boolean> {
    const token = await getAccessToken()
    const encoded = encodeURIComponent(path)
    const res = await fetch(
      `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encoded}`,
      { headers: { 'Authorization': `Bearer ${token}` } },
    )
    return res.ok
  },

  async cloudBuildSubmit(opts: {
    project: string
    source: { bucket: string; object: string }
    steps: Array<{
      name: string
      entrypoint?: string
      args: string[]
    }>
    images: string[]
    timeout?: string
  }): Promise<string> {
    const token = await getAccessToken()
    const url =
      `https://cloudbuild.googleapis.com/v1/projects/${opts.project}/builds`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        source: { storageSource: opts.source },
        steps: opts.steps,
        images: opts.images,
        timeout: opts.timeout || '300s',
      }),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Cloud Build submit failed: ${text}`)
    }
    const data = await res.json() as {
      metadata?: { build?: { id?: string } }
    }
    const buildId = data.metadata?.build?.id
    if (!buildId) throw new Error('Cloud Build returned no build ID')
    return buildId
  },

  async waitForBuild(
    project: string,
    buildId: string,
    timeoutMs = 300_000,
  ): Promise<{ status: string; logUrl?: string }> {
    const url =
      `https://cloudbuild.googleapis.com/v1/projects/${project}/builds/${buildId}`
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5000))
      const token = await getAccessToken()
      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}` },
      })
      if (!res.ok) continue
      const data = await res.json() as {
        status?: string
        logUrl?: string
      }
      if (data.status === 'SUCCESS') {
        return {
          status: 'SUCCESS',
          ...(data.logUrl ? { logUrl: data.logUrl } : {}),
        }
      }
      if (['FAILURE', 'TIMEOUT', 'CANCELLED'].includes(data.status || '')) {
        throw new Error(
          `Cloud Build ${data.status?.toLowerCase()}: ${data.logUrl || ''}`,
        )
      }
    }
    throw new Error('Cloud Build timed out')
  },
}

export default gcpRest
