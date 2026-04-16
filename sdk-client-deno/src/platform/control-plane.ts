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

function createControlPlaneClient(baseUrl: string): Platform {
  async function getToken(): Promise<string> {
    try {
      const res = await fetch(
        'http://metadata.google.internal/computeMetadata/v1/' +
          'instance/service-accounts/default/identity?audience=' +
          encodeURIComponent(baseUrl),
        { headers: { 'Metadata-Flavor': 'Google' } },
      )
      if (res.ok) return await res.text()
    } catch {
      // not on GCP
    }
    for (
      const args of [
        ['auth', 'print-identity-token', `--audiences=${baseUrl}`],
        ['auth', 'print-identity-token'],
      ]
    ) {
      const cmd = new Deno.Command('gcloud', {
        args,
        stdout: 'piped',
        stderr: 'piped',
      })
      const output = await cmd.output()
      if (output.success) {
        return new TextDecoder().decode(output.stdout).trim()
      }
    }
    throw new Error(
      "Not authenticated. Run 'gcloud auth login'.",
    )
  }

  async function cpFetch<T>(
    path: string,
    opts?: { method?: string; body?: unknown },
  ): Promise<T> {
    const token = await getToken()
    const init: RequestInit = {
      method: opts?.method || 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    }
    if (opts?.body !== undefined) {
      init.body = JSON.stringify(opts.body)
    }
    const res = await fetch(`${baseUrl}${path}`, init)
    if (!res.ok) {
      const text = await res.text()
      try {
        const parsed = JSON.parse(text) as { error?: string }
        throw new Error(parsed.error || text)
      } catch (e) {
        if (e instanceof Error && e.message !== text) throw e
        throw new Error(`Control plane error ${res.status}: ${text}`)
      }
    }
    const text = await res.text()
    if (!text) return {} as T
    return JSON.parse(text) as T
  }

  async function signUrl(
    path: string,
    method: string,
    ttl: number,
    contentType?: string,
  ): Promise<string> {
    const params = new URLSearchParams({
      path,
      method,
      ttl: String(ttl),
    })
    if (contentType) params.set('contentType', contentType)
    const data = await cpFetch<{ url: string }>(
      `/storage/sign?${params}`,
    )
    return data.url
  }

  async function cpFetchSilent(
    path: string,
  ): Promise<boolean> {
    try {
      await cpFetch(path)
      return true
    } catch {
      return false
    }
  }

  return {
    async validateProject(): Promise<void> {
      await cpFetch('/health')
    },

    async secretDescribe(name: string): Promise<boolean> {
      return await cpFetchSilent(`/secrets/${name}`)
    },

    async secretCreate(name: string): Promise<void> {
      await cpFetch('/secrets', {
        method: 'POST',
        body: { name, value: '' },
      })
    },

    async secretAddVersion(
      name: string,
      _project: string,
      value: string,
    ): Promise<void> {
      await cpFetch('/secrets', {
        method: 'POST',
        body: { name, value },
      })
    },

    async secretGrantAccess(): Promise<void> {
      // handled server-side
    },

    async secretDelete(name: string): Promise<void> {
      await cpFetch(`/secrets/${name}`, { method: 'DELETE' })
    },

    async secretList(): Promise<SecretInfo[]> {
      return await cpFetch<SecretInfo[]>('/secrets')
    },

    async containerDeploy(opts: ContainerDeployOptions): Promise<void> {
      await cpFetch(`/agents/${opts.agentId}/deploy`, {
        method: 'POST',
        body: { mode: 'container' },
      })
    },

    async containerDelete(agentId: string): Promise<void> {
      await cpFetch(`/agents/${agentId}`, { method: 'DELETE' })
    },

    async functionDeploy(opts: DeployOptions): Promise<void> {
      await cpFetch(`/agents/${opts.agentId}/deploy`, { method: 'POST' })
    },

    async functionDescribeUri(agentId: string): Promise<string> {
      const data = await cpFetch<{ uri?: string; slug?: string }>(
        `/agents/${agentId}`,
      )
      return data.uri || `${baseUrl}/agents/${data.slug || agentId}/invoke`
    },

    async functionDescribeState(agentId: string): Promise<string> {
      const data = await cpFetch<{ id?: string }>(
        `/agents/${agentId}`,
      )
      return data.id ? 'ACTIVE' : ''
    },

    async functionDelete(agentId: string): Promise<void> {
      await cpFetch(`/agents/${agentId}`, { method: 'DELETE' })
    },

    async functionList(): Promise<FunctionInfo[]> {
      return await cpFetch<FunctionInfo[]>('/agents')
    },

    async functionListDetailed(): Promise<FunctionInfo[]> {
      return await cpFetch<FunctionInfo[]>('/agents')
    },

    async functionLogs(
      agentId: string,
      _region: string,
      _project: string,
      limit: number,
    ): Promise<string> {
      const data = await cpFetch<{ logs: string }>(
        `/agents/${agentId}/logs?tail=${limit}`,
      )
      return data.logs || ''
    },

    async functionUpdate(opts: FunctionUpdateOptions): Promise<void> {
      await cpFetch('/runtime/settings', {
        method: 'PUT',
        body: { option: opts.option, value: opts.value },
      })
    },

    functionSecretConsumers(): Promise<string[]> {
      return Promise.resolve([])
    },

    async functionRefreshSecret(): Promise<void> {
      // handled server-side
    },

    async grantRunInvoker(): Promise<void> {
      // handled server-side
    },

    async schedulerCreate(opts: CronTriggerOptions): Promise<void> {
      await cpFetch(`/agents/${opts.name.split('-cron')[0]}/triggers`, {
        method: 'POST',
        body: {
          type: 'cron',
          schedule: opts.schedule,
          timezone: opts.timezone,
          name: opts.name,
        },
      })
    },

    async schedulerDelete(name: string): Promise<void> {
      await cpFetch(`/agents/_/triggers/${name}`, { method: 'DELETE' })
    },

    schedulerList(): Promise<SchedulerJobInfo[]> {
      return Promise.resolve([])
    },

    schedulerDescribe(): Promise<boolean> {
      return Promise.resolve(false)
    },

    async eventarcCreate(opts: PubsubTriggerOptions): Promise<void> {
      await cpFetch(`/agents/${opts.agentId}/triggers`, {
        method: 'POST',
        body: {
          type: 'pubsub',
          topic: opts.topic,
          name: opts.name,
        },
      })
    },

    async eventarcDelete(name: string): Promise<void> {
      await cpFetch(`/agents/_/triggers/${name}`, { method: 'DELETE' })
    },

    eventarcList(): Promise<EventarcTriggerInfo[]> {
      return Promise.resolve([])
    },

    eventarcDescribe(): Promise<boolean> {
      return Promise.resolve(false)
    },

    getAccessToken(): Promise<string> {
      throw new Error(
        'getAccessToken is not available via the control plane client.',
      )
    },

    async getIdentityToken(): Promise<string> {
      return await getToken()
    },

    async serviceAccountCreate(
      _project: string,
      accountId: string,
    ): Promise<string> {
      const data = await cpFetch<{ email: string }>('/service-accounts', {
        method: 'POST',
        body: { accountId },
      })
      return data.email
    },

    async serviceAccountExists(
      _project: string,
      email: string,
    ): Promise<boolean> {
      return await cpFetchSilent(`/service-accounts/${email}`)
    },

    async storageSign(
      _bucket: string,
      path: string,
      method: string,
      ttl: number,
      contentType?: string,
    ): Promise<string> {
      return await signUrl(path, method, ttl, contentType)
    },

    async storageUpload(
      _bucket: string,
      path: string,
      data: Uint8Array | string,
    ): Promise<void> {
      const url = await signUrl(
        path,
        'PUT',
        300,
        'application/octet-stream',
      )
      const body = typeof data === 'string'
        ? new TextEncoder().encode(data)
        : data
      const res = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: body as BodyInit,
      })
      if (!res.ok) {
        throw new Error(`GCS upload failed: ${res.status}`)
      }
    },

    async storageDownload(
      _bucket: string,
      path: string,
    ): Promise<Uint8Array> {
      const url = await signUrl(path, 'GET', 300)
      const res = await fetch(url)
      if (!res.ok) {
        throw new Error(`GCS download failed: ${res.status}`)
      }
      return new Uint8Array(await res.arrayBuffer())
    },

    async storageDelete(_bucket: string, path: string): Promise<void> {
      await cpFetch(
        `/storage?path=${encodeURIComponent(path)}`,
        { method: 'DELETE' },
      )
    },

    async storageList(
      _bucket: string,
      prefix: string,
    ): Promise<string[]> {
      return await cpFetch<string[]>(
        `/storage/list?prefix=${encodeURIComponent(prefix)}`,
      )
    },

    async storageExists(
      _bucket: string,
      path: string,
    ): Promise<boolean> {
      return await cpFetchSilent(
        `/storage/exists?path=${encodeURIComponent(path)}`,
      )
    },

    cloudBuildSubmit(): Promise<string> {
      throw new Error('Cloud Build not supported in remote mode')
    },

    waitForBuild(): Promise<{ status: string; logUrl?: string }> {
      throw new Error('Cloud Build not supported in remote mode')
    },
  }
}

export { createControlPlaneClient }
