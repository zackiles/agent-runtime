const DEFAULT_TIMEOUT = 15_000
const NOT_FOUND = 'gcloud CLI not found'
const decoder = new TextDecoder()

type Result = { ok: boolean; stdout: string; stderr: string }

async function gcloud(
  args: string[],
  timeout?: number,
): Promise<Result> {
  const ms = timeout ?? DEFAULT_TIMEOUT
  let child: Deno.ChildProcess
  try {
    child = new Deno.Command('gcloud', {
      args,
      stdout: 'piped',
      stderr: 'piped',
    }).spawn()
  } catch {
    return { ok: false, stdout: '', stderr: NOT_FOUND }
  }

  let killed = false
  const timer = setTimeout(() => {
    killed = true
    try {
      child.kill()
    } catch { /* already exited */ }
  }, ms)

  const output = await child.output()
  clearTimeout(timer)

  if (killed) {
    return {
      ok: false,
      stdout: '',
      stderr: `gcloud timed out after ${ms / 1000}s`,
    }
  }

  return {
    ok: output.success,
    stdout: decoder.decode(output.stdout).trim(),
    stderr: decoder.decode(output.stderr).trim(),
  }
}

async function exec(
  args: string[],
  timeout?: number,
): Promise<string> {
  const result = await gcloud(args, timeout)
  if (!result.ok) throw new Error(result.stderr || 'gcloud failed')
  return result.stdout
}

async function gcloudWrite(
  args: string[],
  stdin: string,
  timeout?: number,
): Promise<Result> {
  const ms = timeout ?? DEFAULT_TIMEOUT
  let child: Deno.ChildProcess
  try {
    child = new Deno.Command('gcloud', {
      args,
      stdout: 'piped',
      stderr: 'piped',
      stdin: 'piped',
    }).spawn()
  } catch {
    return { ok: false, stdout: '', stderr: NOT_FOUND }
  }

  let killed = false
  const timer = setTimeout(() => {
    killed = true
    try {
      child.kill()
    } catch { /* already exited */ }
  }, ms)

  const writer = child.stdin.getWriter()
  await writer.write(new TextEncoder().encode(stdin))
  await writer.close()

  const output = await child.output()
  clearTimeout(timer)

  if (killed) {
    return {
      ok: false,
      stdout: '',
      stderr: `gcloud timed out after ${ms / 1000}s`,
    }
  }

  return {
    ok: output.success,
    stdout: decoder.decode(output.stdout).trim(),
    stderr: decoder.decode(output.stderr).trim(),
  }
}

async function configGet(key: string): Promise<string> {
  const result = await gcloud(['config', 'get-value', key])
  if (!result.ok) return ''
  const val = result.stdout
  return val && val !== '(unset)' ? val : ''
}

export { configGet, exec, gcloud, gcloudWrite, NOT_FOUND }
export type { Result }
