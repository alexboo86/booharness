import type { Register } from 'claude-code'

import { startWakeHold, type WakeHold } from './wake'

let wake: WakeHold | null = null

export const register: Register = (on) => {
  on('session.start', async ($, event, next) => {
    wake = startWakeHold($)
    return next(event)
  })

  on('turn.start', async (_$, event, next) => {
    if (event.agentId === undefined) await wake?.turnStarted()
    return next(event)
  })

  on('turn.complete', async (_$, event, next) => {
    if (event.agentId === undefined) await wake?.turnEnded()
    return next(event)
  })
}
