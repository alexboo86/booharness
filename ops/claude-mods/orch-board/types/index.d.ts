// Payload types copied from ops/orchestrator/src/dashboard.ts Board (line 67)
// and the object buildBoard returns (line 231). No daemon runtime imports;
// the static family-logos registry is bundled for the pane.
// Chat is the loopback GET /api/chat body (chat.ts chatList) plus optional readOnly
// (the LAN board sets it; the loopback body omits it).

export type Family = 'claude' | 'glm' | 'codex' | 'grok' | 'kimi' | 'opencode' | 'qwen' | 'mimo'

export type MeterResolution = 'integer' | 'fractional'

export type Reading = { window: string; used: number; resetsAt: string | null; source?: string; resolution?: MeterResolution }

export type ResetInventory = { scope: '5h' | 'week' | 'both'; available: number; expiresAt: string | null }

export type FamilyLoad = {
  resets?: ResetInventory[] | null
  resetsError?: string | null
  family: Family
  worst: number | null
  windows: string | null
  readings: Reading[] | null
  readAt?: string
  ageMinutes: number | null
  unknown: string | null
  stale: string | null
  quotaError: { at: string; message: string } | null
  outageError: { at: string; message: string } | null
  authError: { at: string; message: string } | null
  warning: string | null
}

/** buildBoard maps each family load with budgetReading (dashboard.ts:231). */
export type BoardLimit = FamilyLoad & { budget: Reading | null }

export type DrainStatus = { since: string; running: { seat: string; turn: string }[]; queued: number }

export type LeadFamily = 'claude' | 'codex'

export type LeadRow = {
  family: LeadFamily
  session: string
  cwd: string | null
  model: string | null
  tokens: number
  window: number | null
  at: string | null
  origin: string | null
  interactive: boolean
  handedOver: boolean
  limit: number
  percent: number
  over: boolean
  updated: string
  kinds: Record<string, number>
}

export type RtkGain = { saved: number; pct: number; histories: number; commands: number; machines?: number; missing?: string[] }

export type JevEstimate = {
  todayUsd: number
  balance: { usd: number; at: string } | null
  remainingUsd: number | null
  days: number | null
  skippedRows: number
}

export type BrightdataBalance =
  | { at: string; balance: number; pendingCosts: number | null; error?: never }
  | { at: string; error: string; balance?: never; pendingCosts?: never }

export type Load = { cpus: number; cpuBusyPct: number; freeMemGb: number; totalMemGb: number }

export type LoadProbe = { ok: true; load: Load; instruments?: Record<string, boolean> } | { ok: false; error: string }

export type DiskProbe = { ok: true; disk: { totalGb: number; freeGb: number } } | { ok: false; error: string }

export type MachineReading = {
  name: string
  at: string | null
  load: LoadProbe | null
  memAt: string | null
  diskAt: string | null
  disk: DiskProbe | null
}

export type ScopeFeatures = { difficulty: number | null; layer_ui: number | null; layer_rust: number | null; layer_orch: number | null }

export type BypassScope = { score: number; features: ScopeFeatures; model: string | null; at: string } | { reason: string; at: string }

export type BoardScope = ({ status: 'scored'; score: number } | { status: 'bypassed' | 'unjudged'; reason: string }) & {
  features?: ScopeFeatures | null
  recommendation?: { family: string | null; effort: string | null; reason: string } | null
  model?: string | null
  bypass?: BypassScope
}

export type BoardSeat = {
  id: string
  role: string
  family: string
  title: string
  status: string
  host: string
  model: string | null
  effort: string | null
  skills: {
    required: string[]
    listed: string[]
    router: { skills: string; lessons: string; knowledge: string; skillReason?: string; lessonReason?: string; knowledgeReason?: string } | null
  } | null
  lessons: { full: number; indexed: number } | null
  extensions: string[]
  active: boolean
  turn: string | null
  turnStatus: string | null
  queued: number
  tools: number
  kinds: Record<string, number> | null
  seconds: number | null
  ended: string | null
  verdict: string | null
  findings: number | null
  flags: string[]
  worktree: { files: number; stat: string } | null
  captures: string | null
  scope?: BoardScope
  parent: string | null
  scouts: { id: string; family: string; status: string }[]
}

export type Board = {
  draining: DrainStatus | null
  version: string
  at: string
  instruments: readonly string[]
  seats: BoardSeat[]
  limits: BoardLimit[]
  paused: string[]
  pausedError: string | null
  leads: LeadRow[]
  rtk: RtkGain | null
  jev: JevEstimate | null
  brightdata: BrightdataBalance | null
  machines: MachineReading[]
}

export type ChatAddress = 'all' | string[]

export type ChatReceiptState = 'read' | 'delivered' | 'pending' | 'no watcher'

export type ChatReceipt = { handle: string; state: ChatReceiptState; delivered_at?: string; confirmed_at?: string }

export type ChatPost = {
  id: number
  at: string
  author: string
  body: string
  to: ChatAddress | null
  wake: boolean
  delivered: string[]
  confirmed: string[]
  receipts: ChatReceipt[]
}

export type ChatBinding = {
  handle: string
  session: string
  generation: number
  bound_at: string
  ended_at: string | null
  desktop: string | null
}

export type ChatList = {
  posts: ChatPost[]
  handles: ChatBinding[]
  watchers: number
  readOnly?: boolean
}

/** Last settled poll. Null fields are "not read", never a stand-in for an empty board. */
export type PollSnapshot = {
  board: Board | null
  boardError: string | null
  chat: ChatList | null
  chatError: string | null
  chatStatus: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'orch-board': {
      snapshot: PollSnapshot | null
      chatForm: {
        body: string
        to: string
        wake: boolean
        handle: string
        sending: boolean
        releasing: boolean
        sendStatus: string
        releaseStatus: string
        confirmation: { handle: string; session: string | null } | null
      } | null
    }
  }
}
