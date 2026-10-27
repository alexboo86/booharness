import type { Board, ChatList } from '../../types'
import { chatText, dashboardText } from './payloads'

// Synthetic element inventory: no real sessions or operator messages.
export const svgBoard: Board = JSON.parse(dashboardText)
svgBoard.instruments = ['rtk', 'codegraph', 'memoryctl']
const work = svgBoard.seats[0]!
work.queued = 2
work.tools = 27
work.parent = 'parent-sample'
work.scouts = [{ id: 'scout-sample', family: 'grok', status: 'running' }]
work.worktree = { files: 3, stat: '+12 -2' }
work.captures = 'capture-sample'
work.skills = { required: ['plan-before-code'], listed: ['impeccable'], router: { skills: 'map', lessons: 'unavailable', knowledge: 'map', skillReason: 'sample unavailable', lessonReason: 'sample offline' } }
work.extensions = ['orch-guard', 'codex-edit', 'stand-arm']
work.kinds = { rtk: 7, 'rtk-missed': 2, 'rtk-pending': 1, knowledge: 1, 'skill:impeccable': 1, codegraph: 4, memoryctl: 3, 'mcp:sample-server': 2, 'sh:node': 3, 'tool:read': 2, edit: 2, shell: 5 }
const done = svgBoard.seats[1]!
done.findings = 2
done.parent = 'parent-finished'
done.scouts = [{ id: 'finished-scout', family: 'kimi', status: 'done' }]
done.captures = 'finished-capture'
done.kinds = { rtk: 1 }
svgBoard.leads[0]!.cwd = '/synthetic/project/terminal'
svgBoard.leads[0]!.kinds = { codegraph: 2, 'tool:read': 1 }
svgBoard.limits[0]!.readings!.push({ window: 'month', used: 42, resetsAt: '2026-02-01T12:00:00.000Z' })
svgBoard.machines[0]!.memAt = '2026-01-15T11:59:00.000Z'
svgBoard.machines[0]!.diskAt = '2026-01-15T11:58:00.000Z'
export const svgChat: ChatList = JSON.parse(chatText)
svgChat.posts.push({ id: 6, at: svgBoard.at, author: 'operator', body: 'plain log <tag> & "quotes"\nsecond line', to: null, wake: false, delivered: [], confirmed: [], receipts: [] })
