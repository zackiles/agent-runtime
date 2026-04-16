import type { Action, Block, KnownBlock } from 'npm:@slack/types@2'

type ResponseComponent = {
  title?: string
  summary?: string
  body?: string | (KnownBlock | Block)[]
  status?: string
  actions?: Action[]
}

function buildResponse(component: ResponseComponent): KnownBlock[] {
  const blocks: KnownBlock[] = []

  if (component.title) {
    blocks.push({
      type: 'header',
      text: { type: 'plain_text', text: component.title },
    })
  }

  if (component.summary) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: component.summary },
    })
  }

  if (component.status) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: component.status }],
    })
  }

  if (component.body) {
    if (typeof component.body === 'string') {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: component.body },
      })
    } else {
      blocks.push(...(component.body as KnownBlock[]))
    }
  }

  if (component.actions?.length) {
    blocks.push({
      type: 'actions',
      elements: component.actions,
    } as KnownBlock)
  }

  return blocks
}

export { buildResponse }
export type { ResponseComponent }
