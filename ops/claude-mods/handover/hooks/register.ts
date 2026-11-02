import type { Register } from 'claude-code'

// Probe (decision 17488): hand a session over in place without the relay session.
// The tool keeps the successor prompt in the module; with clear it runs /clear once
// this turn ends (the engine queues a mid-turn command.run until the session goes
// idle) and the session.end hook (reason clear) submits the prompt as the fresh
// session's first turn. Task 3436: the 2026-10-30 "never runs" report was a mid-turn
// misread — the clear fired 0.4 s after the turn ended, before and after the 08:17Z
// account reset — so the tool results send the caller off to end its turn at once.
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
      if (pending !== null) {
        return {
          result: 'refused: a handover is already queued; end this turn now — no more tool calls, '
            + 'no fallback — and the clear plus the successor prompt fire the moment it ends.',
        }
      }
      pending = text
      $.clock.after(0, () => {
        $.command.run({ command: 'clear' }).then(
          r => $.ui.log(`handover: /clear ran: ${JSON.stringify(r).slice(0, 200)}`),
          err => {
            pending = null
            $.ui.toast(`handover: /clear refused: ${String(err).slice(0, 200)}`)
            $.ui.log(`handover: /clear refused: ${String(err).slice(0, 300)}`)
          },
        )
      })
      return {
        result: `queued: end this turn now — no more tool calls, no manual successor or new session; `
          + `once this turn ends the /clear runs and the successor prompt (${text.length} characters) `
          + 'starts the fresh session.',
      }
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
