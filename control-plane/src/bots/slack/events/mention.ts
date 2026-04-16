import type { App } from 'npm:@slack/bolt@4'
import { routeCommand } from '../dispatch.ts'

function register(app: App): void {
  app.event('app_mention', async ({ event, client }) => {
    await client.reactions.add({
      channel: event.channel,
      timestamp: event.ts,
      name: 'eyes',
    })
    const text = event.text.replace(/<@[A-Z0-9]+>/g, '').trim()
    if (!event.user) return
    // deno-lint-ignore no-explicit-any
    const files = (event as any).files
    await routeCommand(
      text,
      event.channel,
      event.user,
      event.ts,
      client,
      files,
    )
  })
}

export { register }
