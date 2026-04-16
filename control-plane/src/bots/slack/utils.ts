function threadOpts(
  threadTs?: string,
): { thread_ts: string } | Record<string, never> {
  return threadTs ? { thread_ts: threadTs } : {}
}

function botName(): string {
  return Deno.env.get('AR_BOT_NAME') || 'ar'
}

function slash(cmd?: string): string {
  const name = botName()
  return cmd ? `/${name} ${cmd}` : `/${name}`
}

function normalizeInput(text: string): string {
  const trimmed = text.trim()
  return trimmed.startsWith('/') ? trimmed.slice(1).trimStart() : trimmed
}

export { botName, normalizeInput, slash, threadOpts }
