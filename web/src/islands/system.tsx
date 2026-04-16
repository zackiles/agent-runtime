import { useEffect, useState } from 'preact/hooks'
import { api } from '../api.ts'

type SystemData = {
  build: {
    version: string
    mode: string
    commit: string
    author: string
    date: string
    branch: string
  }
  gcp: {
    project: string
    region: string
    zone: string
    numericProjectId: string
    runtimeAccount: string
    workerAccount?: string
    slackBotAccount?: string
    vpcConnector: string
  }
  agents?: {
    deployMode?: string
  }
  cloudRun: {
    service: string
    revision: string
    configuration: string
    uri: string
    latestRevision: string
    createdAt: string
    updatedAt: string
    executionEnvironment: string
    timeout: string
    cpu: string
    memory: string
    minInstances: number
    maxInstances: number
  }
  storage: {
    bucket: string
    tenant: string
    files: number
    bytes: number
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const value = bytes / Math.pow(1024, i)
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function Row(
  { label, value }: { label: string; value: string | number },
) {
  const display = value === '' || value === 'unknown' || value === undefined
    ? '\u2014'
    : String(value)
  return (
    <div class='flex justify-between py-2 border-b border-gray-100 last:border-b-0'>
      <span class='text-sm text-gray-500'>{label}</span>
      <span class='text-sm font-mono text-gray-900'>{display}</span>
    </div>
  )
}

function Card({
  title,
  children,
  badge,
}: {
  title: string
  children: preact.ComponentChildren
  badge?: string
}) {
  return (
    <div class='bg-white border border-gray-200 rounded-xl p-6'>
      <div class='flex items-center justify-between mb-4'>
        <h3 class='text-base font-semibold text-gray-800'>{title}</h3>
        {badge && (
          <span class='text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium'>
            {badge}
          </span>
        )}
      </div>
      {children}
    </div>
  )
}

export function System() {
  const [data, setData] = useState<SystemData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    setLoading(true)
    api('/system')
      .then((r) => {
        if (!r.ok) throw new Error('Failed to load system info')
        return r.json()
      })
      .then((d) => setData(d as SystemData))
      .catch((e) => setError(e instanceof Error ? e.message : 'Load failed'))
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div class='text-center py-12 text-gray-400'>
        Loading system information...
      </div>
    )
  }

  if (error) {
    return (
      <div class='p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700'>
        {error}
      </div>
    )
  }

  if (!data) return null

  return (
    <div class='space-y-6'>
      <div class='flex items-center gap-2'>
        <h2 class='text-lg font-semibold'>System</h2>
      </div>

      <div class='grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4'>
        <div class='bg-white border border-gray-200 rounded-xl p-4 text-center'>
          <p class='text-2xl font-bold text-gray-900'>
            v{data.build.version}
          </p>
          <p class='text-xs text-gray-500 mt-1'>Build Version</p>
        </div>
        <div class='bg-white border border-gray-200 rounded-xl p-4 text-center'>
          <p class='text-2xl font-bold text-gray-900'>
            {data.storage.files.toLocaleString()}
          </p>
          <p class='text-xs text-gray-500 mt-1'>Storage Files</p>
        </div>
        <div class='bg-white border border-gray-200 rounded-xl p-4 text-center'>
          <p class='text-2xl font-bold text-gray-900'>
            {formatBytes(data.storage.bytes)}
          </p>
          <p class='text-xs text-gray-500 mt-1'>Storage Size</p>
        </div>
        <div class='bg-white border border-gray-200 rounded-xl p-4 text-center'>
          <p class='text-2xl font-bold text-gray-900'>
            {data.gcp.region || '\u2014'}
          </p>
          <p class='text-xs text-gray-500 mt-1'>Region</p>
        </div>
      </div>

      <div class='grid grid-cols-1 lg:grid-cols-2 gap-6'>
        <Card title='Build' badge={data.build.mode}>
          <Row label='Version' value={data.build.version} />
          <Row label='Commit' value={data.build.commit} />
          <Row label='Branch' value={data.build.branch} />
          <Row label='Author' value={data.build.author} />
          <Row label='Date' value={data.build.date} />
          <Row label='Mode' value={data.build.mode} />
        </Card>

        <Card title='GCP'>
          <Row label='Project' value={data.gcp.project} />
          <Row label='Project ID' value={data.gcp.numericProjectId} />
          <Row label='Region' value={data.gcp.region} />
          <Row label='Zone' value={data.gcp.zone} />
          <Row label='VPC Connector' value={data.gcp.vpcConnector} />
        </Card>

        <Card title='Service Accounts'>
          <Row
            label='Agent Runtime'
            value={data.gcp.runtimeAccount}
          />
          <Row
            label='Agent Worker'
            value={data.gcp.workerAccount || ''}
          />
          <Row
            label='Slack Bot'
            value={data.gcp.slackBotAccount || ''}
          />
        </Card>

        <Card title='Agents'>
          <Row
            label='Deploy Mode'
            value={data.agents?.deployMode || 'container'}
          />
        </Card>

        <Card title='Cloud Run'>
          <Row label='Service' value={data.cloudRun.service} />
          <Row label='Revision' value={data.cloudRun.revision} />
          <Row label='Latest Revision' value={data.cloudRun.latestRevision} />
          <Row label='CPU' value={data.cloudRun.cpu} />
          <Row label='Memory' value={data.cloudRun.memory} />
          <Row label='Min Instances' value={data.cloudRun.minInstances} />
          <Row label='Max Instances' value={data.cloudRun.maxInstances} />
          <Row label='Timeout' value={data.cloudRun.timeout} />
          <Row
            label='Environment'
            value={data.cloudRun.executionEnvironment}
          />
          <Row label='Created' value={data.cloudRun.createdAt} />
          <Row label='Updated' value={data.cloudRun.updatedAt} />
        </Card>

        <Card title='Storage'>
          <Row label='Bucket' value={data.storage.bucket} />
          <Row label='Tenant' value={data.storage.tenant} />
          <Row label='Files' value={data.storage.files.toLocaleString()} />
          <Row label='Total Size' value={formatBytes(data.storage.bytes)} />
        </Card>
      </div>
    </div>
  )
}
