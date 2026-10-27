import type { Register } from 'claude-code'

// Probe (decision 17488): can a mod hand a session over in place without the relay session?
// The tool keeps the successor prompt in the module; with clear it queues /clear, and the
// session.end hook (reason clear) submits the prompt as the fresh session's first turn.
const TOOL = 'mcp__handover__run'

let pending: string | null = null

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'run',
      description:
        'Hand over in place. With clear false: submit `text` as a new prompt once this turn ends. '
        + 'With clear true: run /clear once this turn ends, then submit `text` as the first prompt of the fresh session.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' }, clear: { type: 'boolean' } },
        required: ['text', 'clear'],
      },
      isDeferred: false,
    })
    return next(e)
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    // An MCP-shaped call carries its arguments on the event itself.
    const input = e as unknown as { text?: unknown; clear?: unknown }
    if (typeof input.text !== 'string' || input.text.trim() === '') return { deny: 'text is empty' }
    const text = input.text
    if (input.clear === true) {
      pending = text
      $.clock.after(0, () => {
        $.command.run({ command: 'clear' }).then(
          r => $.ui.log(`handover: /clear ran: ${JSON.stringify(r).slice(0, 200)}`),
          err => { pending = null; $.ui.log(`handover: /clear refused: ${String(err).slice(0, 300)}`) },
        )
      })
      return { result: `queued: /clear once this turn ends, then the successor prompt (${text.length} characters)` }
    }
    $.clock.after(0, () => {
      $.prompt.submit({ text }).then(
        () => $.ui.log('handover: probe prompt submitted'),
        err => $.ui.log(`handover: submit refused: ${String(err).slice(0, 300)}`),
      )
    })
    return { result: `queued: the prompt (${text.length} characters) starts a new turn once this turn ends` }
  })

  on('session.end', async ($, e, next) => {
    const result = await next(e)
    if (e.reason === 'clear' && pending != null) {
      const text = pending
      pending = null
      $.clock.after(500, () => {
        $.prompt.submit({ text }).then(
          () => $.ui.log('handover: successor prompt submitted after /clear'),
          err => $.ui.log(`handover: successor submit refused: ${String(err).slice(0, 300)}`),
        )
      })
    }
    return result
  })
}
