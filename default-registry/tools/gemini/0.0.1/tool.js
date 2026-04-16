#!/usr/bin/env node
'use strict'

const MODEL = 'gemini-2.5-pro'
const LOCATION = 'us-central1'
const METADATA = 'http://metadata.google.internal/computeMetadata/v1'

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf-8')
}

async function resolveProject() {
  if (process.env.GOOGLE_CLOUD_PROJECT) {
    return process.env.GOOGLE_CLOUD_PROJECT
  }
  if (process.env.GCP_PROJECT) return process.env.GCP_PROJECT
  const res = await fetch(`${METADATA}/project/project-id`, {
    headers: { 'Metadata-Flavor': 'Google' },
  })
  if (res.ok) return (await res.text()).trim()
  throw new Error('Could not resolve GCP project')
}

async function resolveToken() {
  try {
    const res = await fetch(
      `${METADATA}/instance/service-accounts/default/token`,
      { headers: { 'Metadata-Flavor': 'Google' } },
    )
    if (res.ok) {
      const data = await res.json()
      return data.access_token
    }
  } catch {}
  const { execSync } = require('child_process')
  return execSync('gcloud auth print-access-token', {
    encoding: 'utf-8',
  }).trim()
}

async function main() {
  const prompt = await readStdin()
  if (!prompt.trim()) {
    process.stderr.write('No input provided\n')
    process.exit(1)
  }

  const project = await resolveProject()
  const token = await resolveToken()
  const endpoint =
    `https://${LOCATION}-aiplatform.googleapis.com/v1/` +
    `projects/${project}/locations/${LOCATION}/` +
    `publishers/google/models/${MODEL}:generateContent`

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: 65536,
        temperature: 0.2,
      },
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    process.stderr.write(`Vertex AI error (${res.status}): ${text}\n`)
    process.exit(1)
  }

  const data = await res.json()
  const parts = data.candidates?.[0]?.content?.parts || []
  const text = parts
    .filter((p) => p.text)
    .map((p) => p.text)
    .join('')
  process.stdout.write(text || JSON.stringify(data))
}

main().catch((err) => {
  process.stderr.write(`${err.message}\n`)
  process.exit(1)
})
