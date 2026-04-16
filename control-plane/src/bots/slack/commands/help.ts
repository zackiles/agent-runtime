import type { WebClient } from 'npm:@slack/web-api@7'
import { slash, threadOpts } from '../utils.ts'
import { buildResponse } from '../views/component.ts'

async function handle(
  client: WebClient,
  channel: string,
  threadTs?: string,
): Promise<void> {
  const s = slash()
  const blocks = buildResponse({
    title: 'Available Commands',
    body: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            `*Slash command:* \`${s} {command}\``,
            '',
            `\`${s} help\` — Show this help message`,
            `\`${s} settings\` — Switch tenants and configure preferences`,
            `\`${s} run {agent} {input}\` — Run an agent`,
            `\`${s} create-agent {prompt}\` — Create a private agent`,
            `\`${s} list\` — List your accessible agents`,
            `\`${s} status\` — Show your account and bot status`,
            `\`${s} demo {prompt}\` — Create, deploy, and view a demo`,
            `\`${s} demos\` — List your demos with status and URLs`,
            '',
            `_In DMs, type commands with or without_ \`/\`_:_`,
            '`help` or `/help`, `list`, `demos`, `status`, `settings`',
            '_Or just send a message to run your default agent._',
          ].join('\n'),
        },
      },
    ],
  })

  await client.chat.postMessage({
    channel,
    ...threadOpts(threadTs),
    blocks,
    text: 'Available Commands',
  })
}

export { handle }
