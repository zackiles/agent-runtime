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

async function exec(
  args: string[],
  opts?: { stdin?: string; silent?: boolean },
): Promise<string> {
  const cmdOpts: Deno.CommandOptions = {
    args,
    stdout: 'piped',
    stderr: 'piped',
  }
  if (opts?.stdin) cmdOpts.stdin = 'piped'

  const cmd = new Deno.Command('gcloud', cmdOpts)

  const proc = cmd.spawn()

  if (opts?.stdin) {
    const writer = proc.stdin!.getWriter()
    await writer.write(new TextEncoder().encode(opts.stdin))
    await writer.close()
  }

  const output = await proc.output()
  const stdout = new TextDecoder().decode(output.stdout).trim()
  const stderr = new TextDecoder().decode(output.stderr).trim()

  if (!output.success) {
    throw new Error(
      opts?.silent
        ? ''
        : (stderr || `gcloud command failed: gcloud ${args.join(' ')}`),
    )
  }

  return stdout
}

function parseJson<T>(raw: string): T {
  if (!raw) return [] as unknown as T
  try {
    return JSON.parse(raw) as T
  } catch {
    return [] as unknown as T
  }
}

function shortName(fullPath: string): string {
  return fullPath.split('/').pop() || fullPath
}

async function gsutil(args: string[]): Promise<string> {
  const cmd = new Deno.Command('gsutil', {
    args,
    stdout: 'piped',
    stderr: 'piped',
  })
  const output = await cmd.output()
  if (!output.success) {
    const stderr = new TextDecoder().decode(output.stderr).trim()
    throw new Error(stderr || `gsutil command failed: gsutil ${args.join(' ')}`)
  }
  return new TextDecoder().decode(output.stdout).trim()
}

const gcp: Platform = {
  async validateProject(project: string): Promise<void> {
    await exec([
      'projects',
      'describe',
      project,
      '--format=value(projectId)',
    ])
  },

  async secretDescribe(name: string, project: string): Promise<boolean> {
    try {
      await exec([
        'secrets',
        'describe',
        name,
        `--project=${project}`,
      ], { silent: true })
      return true
    } catch {
      return false
    }
  },

  async secretCreate(
    name: string,
    project: string,
    region: string,
  ): Promise<void> {
    await exec([
      'secrets',
      'create',
      name,
      `--project=${project}`,
      '--replication-policy=user-managed',
      `--locations=${region}`,
    ])
  },

  async secretAddVersion(
    name: string,
    project: string,
    value: string,
  ): Promise<void> {
    await exec(
      [
        'secrets',
        'versions',
        'add',
        name,
        `--project=${project}`,
        '--data-file=-',
      ],
      { stdin: value },
    )
  },

  async secretGrantAccess(
    name: string,
    project: string,
    runtimeAccount: string,
  ): Promise<void> {
    await exec([
      'secrets',
      'add-iam-policy-binding',
      name,
      `--project=${project}`,
      `--member=serviceAccount:${runtimeAccount}`,
      '--role=roles/secretmanager.secretAccessor',
    ])
  },

  async secretDelete(name: string, project: string): Promise<void> {
    await exec([
      'secrets',
      'delete',
      name,
      `--project=${project}`,
      '--quiet',
    ])
  },

  async secretList(project: string): Promise<SecretInfo[]> {
    const raw = await exec([
      'secrets',
      'list',
      `--project=${project}`,
      '--format=json(name,createTime)',
    ])
    const items = parseJson<Array<{ name: string; createTime: string }>>(raw)
    return items.map((s) => ({
      name: shortName(s.name),
      createTime: s.createTime,
    }))
  },

  async containerDeploy(opts: ContainerDeployOptions): Promise<void> {
    const args = [
      'run',
      'deploy',
      opts.agentId,
      `--image=${opts.image}`,
      `--region=${opts.region}`,
      `--project=${opts.project}`,
      `--port=${opts.port || 8080}`,
      '--no-allow-unauthenticated',
      `--service-account=${opts.workerAccount || opts.runtimeAccount}`,
      `--memory=${opts.memory || '1Gi'}`,
      `--cpu=${opts.cpu || '1'}`,
      `--timeout=${opts.timeout || '540s'}`,
    ]

    if (opts.secrets && Object.keys(opts.secrets).length > 0) {
      const secretsArg = Object.entries(opts.secrets)
        .map(([envVar, secretName]) => `${envVar}=${secretName}:latest`)
        .join(',')
      args.push(`--set-secrets=${secretsArg}`)
    }

    if (opts.env && Object.keys(opts.env).length > 0) {
      const envArg = Object.entries(opts.env)
        .map(([k, v]) => `${k}=${v}`)
        .join(',')
      args.push(`--set-env-vars=${envArg}`)
    }

    if (opts.fuseBucket) {
      args.push(
        '--execution-environment=gen2',
        `--add-volume=name=registry,type=cloud-storage,bucket=${opts.fuseBucket},readonly=true`,
        '--add-volume-mount=volume=registry,mount-path=/registry',
      )
    }

    await exec(args)
  },

  async containerDelete(
    agentId: string,
    region: string,
    project: string,
  ): Promise<void> {
    await exec([
      'run',
      'services',
      'delete',
      agentId,
      `--region=${region}`,
      `--project=${project}`,
      '--quiet',
    ])
  },

  async functionDeploy(opts: DeployOptions): Promise<void> {
    const args = [
      'functions',
      'deploy',
      opts.agentId,
      '--gen2',
      `--region=${opts.region}`,
      `--project=${opts.project}`,
      `--runtime=${opts.runtime}`,
      `--entry-point=${opts.entryPoint}`,
      '--trigger-http',
      '--no-allow-unauthenticated',
      `--run-service-account=${opts.workerAccount || opts.runtimeAccount}`,
      `--source=${opts.source}`,
      `--memory=${opts.memory || '1Gi'}`,
      `--timeout=${opts.timeout || '540s'}`,
      `--cpu=${opts.cpu || '1'}`,
    ]

    if (opts.vpcConnector) {
      args.push(`--vpc-connector=${opts.vpcConnector}`)
    }

    if (opts.secrets && Object.keys(opts.secrets).length > 0) {
      const secretsArg = Object.entries(opts.secrets)
        .map(([envVar, secretName]) => `${envVar}=${secretName}:latest`)
        .join(',')
      args.push(`--set-secrets=${secretsArg}`)
    }

    if (opts.env && Object.keys(opts.env).length > 0) {
      const envArg = Object.entries(opts.env)
        .map(([k, v]) => `${k}=${v}`)
        .join(',')
      args.push(`--set-env-vars=${envArg}`)
    }

    await exec(args)
  },

  async functionDescribeUri(
    agentId: string,
    region: string,
    project: string,
  ): Promise<string> {
    return await exec([
      'functions',
      'describe',
      agentId,
      '--v2',
      `--region=${region}`,
      `--project=${project}`,
      '--format=value(serviceConfig.uri)',
    ])
  },

  async functionDescribeState(
    agentId: string,
    region: string,
    project: string,
  ): Promise<string> {
    return await exec([
      'functions',
      'describe',
      agentId,
      '--v2',
      `--region=${region}`,
      `--project=${project}`,
      '--format=value(state)',
    ])
  },

  async functionDelete(
    agentId: string,
    region: string,
    project: string,
  ): Promise<void> {
    await exec([
      'functions',
      'delete',
      agentId,
      `--region=${region}`,
      `--project=${project}`,
      '--quiet',
    ])
  },

  async functionList(
    project: string,
    region: string,
  ): Promise<FunctionInfo[]> {
    const raw = await exec([
      'functions',
      'list',
      '--v2',
      `--project=${project}`,
      `--regions=${region}`,
      '--format=table(name,state,serviceConfig.uri)',
    ])
    const lines = raw.split('\n').filter((l) => l.trim())
    if (lines.length <= 1) return []
    return lines.slice(1).map((line) => {
      const parts = line.trim().split(/\s{2,}/)
      return {
        name: shortName(parts[0] || ''),
        state: parts[1] || '',
        uri: parts[2] || '',
      }
    })
  },

  async functionListDetailed(
    project: string,
    region: string,
  ): Promise<FunctionInfo[]> {
    const raw = await exec([
      'functions',
      'list',
      '--v2',
      `--project=${project}`,
      `--regions=${region}`,
      '--format=json(name,state,serviceConfig.uri,serviceConfig.availableMemory,serviceConfig.availableCpu,serviceConfig.timeoutSeconds)',
    ])
    const items = parseJson<
      Array<{
        name: string
        state: string
        serviceConfig?: {
          uri?: string
          availableMemory?: string
          availableCpu?: string
          timeoutSeconds?: string
        }
      }>
    >(raw)
    return items.map((f) => ({
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
    region: string,
    project: string,
    limit: number,
  ): Promise<string> {
    return await exec([
      'functions',
      'logs',
      'read',
      agentId,
      '--gen2',
      `--region=${region}`,
      `--project=${project}`,
      `--limit=${limit}`,
    ])
  },

  async functionUpdate(opts: FunctionUpdateOptions): Promise<void> {
    await exec([
      'functions',
      'deploy',
      opts.agentId,
      '--gen2',
      `--region=${opts.region}`,
      `--project=${opts.project}`,
      `--${opts.option}=${opts.value}`,
    ])
  },

  async functionSecretConsumers(
    secretName: string,
    project: string,
    region: string,
  ): Promise<string[]> {
    const raw = await exec([
      'functions',
      'list',
      '--gen2',
      `--project=${project}`,
      `--regions=${region}`,
      '--format=json(name,serviceConfig.secretEnvironmentVariables)',
    ])
    const items = parseJson<
      Array<{
        name: string
        serviceConfig?: {
          secretEnvironmentVariables?: Array<{ secret: string }>
        }
      }>
    >(raw)
    return items
      .filter((f) =>
        f.serviceConfig?.secretEnvironmentVariables?.some(
          (s) => s.secret === secretName,
        )
      )
      .map((f) => shortName(f.name))
  },

  async functionRefreshSecret(
    agentId: string,
    region: string,
    project: string,
  ): Promise<void> {
    const raw = await exec([
      'functions',
      'describe',
      agentId,
      '--gen2',
      `--region=${region}`,
      `--project=${project}`,
      '--format=json(serviceConfig.secretEnvironmentVariables)',
    ])
    const fn = parseJson<{
      serviceConfig?: {
        secretEnvironmentVariables?: Array<{
          key: string
          secret: string
          version: string
        }>
      }
    }>(raw)
    const secrets = fn.serviceConfig?.secretEnvironmentVariables
    if (!secrets?.length) return
    const arg = secrets
      .map((s) => `${s.key}=${s.secret}:latest`)
      .join(',')
    await exec([
      'functions',
      'deploy',
      agentId,
      '--gen2',
      `--region=${region}`,
      `--project=${project}`,
      `--set-secrets=${arg}`,
    ])
  },

  async grantRunInvoker(
    agentId: string,
    region: string,
    project: string,
    runtimeAccount: string,
  ): Promise<void> {
    await exec([
      'run',
      'services',
      'add-iam-policy-binding',
      agentId,
      `--region=${region}`,
      `--project=${project}`,
      `--member=serviceAccount:${runtimeAccount}`,
      '--role=roles/run.invoker',
    ])
  },

  async schedulerCreate(opts: CronTriggerOptions): Promise<void> {
    await exec([
      'scheduler',
      'jobs',
      'create',
      'http',
      opts.name,
      `--location=${opts.region}`,
      `--project=${opts.project}`,
      `--schedule=${opts.schedule}`,
      `--time-zone=${opts.timezone}`,
      `--uri=${opts.uri}`,
      `--oidc-service-account-email=${opts.runtimeAccount}`,
    ])
  },

  async schedulerDelete(
    name: string,
    region: string,
    project: string,
  ): Promise<void> {
    await exec([
      'scheduler',
      'jobs',
      'delete',
      name,
      `--project=${project}`,
      `--location=${region}`,
      '--quiet',
    ])
  },

  async schedulerList(
    project: string,
    region: string,
    filter?: string,
  ): Promise<SchedulerJobInfo[]> {
    const args = [
      'scheduler',
      'jobs',
      'list',
      `--project=${project}`,
      `--location=${region}`,
      '--format=json(name,schedule,timeZone,httpTarget.uri)',
    ]
    if (filter) args.push(`--filter=${filter}`)
    const raw = await exec(args)
    const items = parseJson<
      Array<{
        name: string
        schedule?: string
        timeZone?: string
        httpTarget?: { uri?: string }
      }>
    >(raw)
    return items.map((j) => ({
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
    try {
      await exec([
        'scheduler',
        'jobs',
        'describe',
        name,
        `--project=${project}`,
        `--location=${region}`,
      ], { silent: true })
      return true
    } catch {
      return false
    }
  },

  async eventarcCreate(opts: PubsubTriggerOptions): Promise<void> {
    await exec([
      'eventarc',
      'triggers',
      'create',
      opts.name,
      `--location=${opts.region}`,
      `--project=${opts.project}`,
      `--destination-run-service=${opts.agentId}`,
      `--destination-run-region=${opts.region}`,
      '--event-filters=type=google.cloud.pubsub.topic.v1.messagePublished',
      `--transport-topic=${opts.topic}`,
      `--service-account=${opts.runtimeAccount}`,
    ])
  },

  async eventarcDelete(
    name: string,
    region: string,
    project: string,
  ): Promise<void> {
    await exec([
      'eventarc',
      'triggers',
      'delete',
      name,
      `--project=${project}`,
      `--location=${region}`,
      '--quiet',
    ])
  },

  async eventarcList(
    project: string,
    region: string,
    filter?: string,
  ): Promise<EventarcTriggerInfo[]> {
    const args = [
      'eventarc',
      'triggers',
      'list',
      `--project=${project}`,
      `--location=${region}`,
      '--format=json(name,transport.pubsub.topic,destination.cloudRun.service)',
    ]
    if (filter) args.push(`--filter=${filter}`)
    const raw = await exec(args)
    const items = parseJson<
      Array<{
        name: string
        transport?: { pubsub?: { topic?: string } }
        destination?: { cloudRun?: { service?: string } }
      }>
    >(raw)
    return items.map((t) => ({
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
    try {
      await exec([
        'eventarc',
        'triggers',
        'describe',
        name,
        `--project=${project}`,
        `--location=${region}`,
      ], { silent: true })
      return true
    } catch {
      return false
    }
  },

  async getAccessToken(): Promise<string> {
    return await exec(['auth', 'print-access-token'])
  },

  async getIdentityToken(audience?: string): Promise<string> {
    if (audience) {
      try {
        return await exec([
          'auth',
          'print-identity-token',
          `--audiences=${audience}`,
        ])
      } catch {
        // --audiences not supported for this account type
      }
    }
    return await exec(['auth', 'print-identity-token'])
  },

  async serviceAccountCreate(
    project: string,
    accountId: string,
    displayName: string,
  ): Promise<string> {
    await exec([
      'iam',
      'service-accounts',
      'create',
      accountId,
      `--project=${project}`,
      `--display-name=${displayName}`,
    ])
    return `${accountId}@${project}.iam.gserviceaccount.com`
  },

  async serviceAccountExists(
    project: string,
    email: string,
  ): Promise<boolean> {
    try {
      await exec([
        'iam',
        'service-accounts',
        'describe',
        email,
        `--project=${project}`,
      ], { silent: true })
      return true
    } catch {
      return false
    }
  },

  async storageSign(
    bucket: string,
    path: string,
    method: string,
    ttl: number,
    contentType?: string,
  ): Promise<string> {
    const args = [
      'storage',
      'sign-url',
      `gs://${bucket}/${path}`,
      `--duration=${ttl}s`,
      `--http-verb=${method}`,
    ]
    if (contentType) {
      args.push(`--headers=Content-Type=${contentType}`)
    }
    const output = await exec(args)
    const match = output.match(/https:\/\/storage\.googleapis\.com\S+/)
    if (!match) {
      throw new Error('Failed to parse signed URL from gcloud output')
    }
    return match[0]
  },

  async storageUpload(
    bucket: string,
    path: string,
    data: Uint8Array | string,
  ): Promise<void> {
    const tmpPath = await Deno.makeTempFile()
    try {
      if (typeof data === 'string') {
        await Deno.writeTextFile(tmpPath, data)
      } else {
        await Deno.writeFile(tmpPath, data)
      }
      await gsutil(['cp', tmpPath, `gs://${bucket}/${path}`])
    } finally {
      await Deno.remove(tmpPath).catch(() => {})
    }
  },

  async storageDownload(
    bucket: string,
    path: string,
  ): Promise<Uint8Array> {
    const tmpPath = await Deno.makeTempFile()
    try {
      await gsutil(['cp', `gs://${bucket}/${path}`, tmpPath])
      return await Deno.readFile(tmpPath)
    } finally {
      await Deno.remove(tmpPath).catch(() => {})
    }
  },

  async storageDelete(bucket: string, path: string): Promise<void> {
    await gsutil(['rm', `gs://${bucket}/${path}`])
  },

  async storageList(
    bucket: string,
    prefix: string,
  ): Promise<string[]> {
    const output = await gsutil(['ls', `gs://${bucket}/${prefix}`])
    return output.split('\n').filter((l) => l.trim()).map((l) =>
      l.replace(`gs://${bucket}/`, '')
    )
  },

  async storageExists(
    bucket: string,
    path: string,
  ): Promise<boolean> {
    try {
      await gsutil(['stat', `gs://${bucket}/${path}`])
      return true
    } catch {
      return false
    }
  },

  cloudBuildSubmit(): Promise<string> {
    throw new Error('Cloud Build not supported in CLI mode')
  },

  waitForBuild(): Promise<{ status: string; logUrl?: string }> {
    throw new Error('Cloud Build not supported in CLI mode')
  },
}

export default gcp
