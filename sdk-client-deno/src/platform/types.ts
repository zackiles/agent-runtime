type SecretInfo = {
  name: string
  createTime: string
  versionCount?: number
  latestVersionTime?: string
}

type FunctionInfo = {
  name: string
  state: string
  uri?: string | undefined
  memory?: string | undefined
  cpu?: string | undefined
  timeout?: string | undefined
}

type SchedulerJobInfo = {
  name: string
  schedule?: string | undefined
  timezone?: string | undefined
  uri?: string | undefined
}

type EventarcTriggerInfo = {
  name: string
  topic?: string | undefined
  service?: string | undefined
}

type DeployOptions = {
  agentId: string
  region: string
  project: string
  runtime: string
  entryPoint: string
  runtimeAccount: string
  workerAccount?: string | undefined
  vpcConnector?: string | undefined
  source: string
  secrets?: Record<string, string>
  env?: Record<string, string>
  memory?: string | undefined
  timeout?: string | undefined
  cpu?: string | undefined
}

type ContainerDeployOptions = {
  agentId: string
  region: string
  project: string
  image: string
  runtimeAccount: string
  workerAccount?: string | undefined
  port?: number | undefined
  secrets?: Record<string, string>
  env?: Record<string, string>
  memory?: string | undefined
  cpu?: string | undefined
  timeout?: string | undefined
  fuseBucket?: string | undefined
}

type FunctionUpdateOptions = {
  agentId: string
  region: string
  project: string
  option: string
  value: string
}

type CronTriggerOptions = {
  name: string
  region: string
  project: string
  schedule: string
  timezone: string
  uri: string
  runtimeAccount: string
}

type PubsubTriggerOptions = {
  name: string
  region: string
  project: string
  agentId: string
  topic: string
  runtimeAccount: string
}

interface Platform {
  validateProject(project: string): Promise<void>

  secretDescribe(name: string, project: string): Promise<boolean>
  secretCreate(name: string, project: string, region: string): Promise<void>
  secretAddVersion(
    name: string,
    project: string,
    value: string,
  ): Promise<void>
  secretGrantAccess(
    name: string,
    project: string,
    runtimeAccount: string,
  ): Promise<void>
  secretDelete(name: string, project: string): Promise<void>
  secretList(project: string): Promise<SecretInfo[]>

  containerDeploy(opts: ContainerDeployOptions): Promise<void>
  containerDelete(
    agentId: string,
    region: string,
    project: string,
  ): Promise<void>

  functionDeploy(opts: DeployOptions): Promise<void>
  functionDescribeUri(
    agentId: string,
    region: string,
    project: string,
  ): Promise<string>
  functionDescribeState(
    agentId: string,
    region: string,
    project: string,
  ): Promise<string>
  functionDelete(
    agentId: string,
    region: string,
    project: string,
  ): Promise<void>
  functionList(
    project: string,
    region: string,
  ): Promise<FunctionInfo[]>
  functionListDetailed(
    project: string,
    region: string,
  ): Promise<FunctionInfo[]>
  functionLogs(
    agentId: string,
    region: string,
    project: string,
    limit: number,
  ): Promise<string>
  functionUpdate(opts: FunctionUpdateOptions): Promise<void>
  functionSecretConsumers(
    secretName: string,
    project: string,
    region: string,
  ): Promise<string[]>
  functionRefreshSecret(
    agentId: string,
    region: string,
    project: string,
  ): Promise<void>

  grantRunInvoker(
    agentId: string,
    region: string,
    project: string,
    runtimeAccount: string,
  ): Promise<void>

  schedulerCreate(opts: CronTriggerOptions): Promise<void>
  schedulerDelete(
    name: string,
    region: string,
    project: string,
  ): Promise<void>
  schedulerList(
    project: string,
    region: string,
    filter?: string,
  ): Promise<SchedulerJobInfo[]>
  schedulerDescribe(
    name: string,
    region: string,
    project: string,
  ): Promise<boolean>

  eventarcCreate(opts: PubsubTriggerOptions): Promise<void>
  eventarcDelete(
    name: string,
    region: string,
    project: string,
  ): Promise<void>
  eventarcList(
    project: string,
    region: string,
    filter?: string,
  ): Promise<EventarcTriggerInfo[]>
  eventarcDescribe(
    name: string,
    region: string,
    project: string,
  ): Promise<boolean>

  getAccessToken(): Promise<string>
  getIdentityToken(audience?: string): Promise<string>

  serviceAccountCreate(
    project: string,
    accountId: string,
    displayName: string,
  ): Promise<string>
  serviceAccountExists(
    project: string,
    email: string,
  ): Promise<boolean>

  storageSign(
    bucket: string,
    path: string,
    method: string,
    ttl: number,
    contentType?: string,
  ): Promise<string>

  storageUpload(
    bucket: string,
    path: string,
    data: Uint8Array | string,
  ): Promise<void>
  storageDownload(bucket: string, path: string): Promise<Uint8Array>
  storageDelete(bucket: string, path: string): Promise<void>
  storageList(bucket: string, prefix: string): Promise<string[]>
  storageExists(bucket: string, path: string): Promise<boolean>

  cloudBuildSubmit(opts: {
    project: string
    source: { bucket: string; object: string }
    steps: Array<{
      name: string
      entrypoint?: string
      args: string[]
    }>
    images: string[]
    timeout?: string
  }): Promise<string>

  waitForBuild(
    project: string,
    buildId: string,
    timeoutMs?: number,
  ): Promise<{ status: string; logUrl?: string }>
}

export type {
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
}
