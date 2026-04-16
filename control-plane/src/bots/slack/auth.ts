import type { WebClient } from 'npm:@slack/web-api@7'

async function resolveEmail(
  client: WebClient,
  slackUserId: string,
): Promise<string | null> {
  try {
    const result = await client.users.info({ user: slackUserId })
    return result.user?.profile?.email ?? null
  } catch {
    return null
  }
}

export { resolveEmail }
