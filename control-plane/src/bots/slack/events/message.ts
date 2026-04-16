import type { App } from 'npm:@slack/bolt@4'
import { routeCommand } from '../dispatch.ts'

function register(app: App): void {
  // deno-lint-ignore no-explicit-any
  app.event('message', async ({ event, client }: any) => {
    if (event.channel_type !== 'im') return
    if (event.subtype && event.subtype !== 'file_share') return

    await client.reactions.add({
      channel: event.channel,
      timestamp: event.ts,
      name: 'eyes',
    })
    await routeCommand(
      event.text || '',
      event.channel,
      event.user,
      event.ts,
      client,
      event.files,
    )
  })
}

export { register }
