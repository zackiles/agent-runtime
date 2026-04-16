const ENV = 'INCIDENT_IO_API_KEY'

function incidentIoApiKey(): string | undefined {
  const v = Deno.env.get(ENV)?.trim()
  return v || undefined
}

function incidentIoConfigured(): boolean {
  return incidentIoApiKey() !== undefined
}

export {
  ENV as INCIDENT_IO_API_KEY_ENV,
  incidentIoApiKey,
  incidentIoConfigured,
}
