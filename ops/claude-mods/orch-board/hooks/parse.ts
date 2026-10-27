import type { Board, ChatList, PollSnapshot } from '../types'

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(error: string): ParseResult<never> {
  return { ok: false, error }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isNullableRecord(value: unknown): boolean {
  return value === null || isRecord(value)
}

function errorOf(text: string): string | null {
  try {
    const body = JSON.parse(text) as unknown
    if (isRecord(body) && typeof body.error === 'string') return body.error.slice(0, 200)
  } catch {
    return null
  }
  return null
}

/** The daemon's error text when the body carries one, else the status. */
export function httpError(status: number, text: string): string {
  return errorOf(text) ?? `HTTP ${status}`
}

function boardEnvelope(value: Record<string, unknown>): string | null {
  if (value.draining !== null && !isRecord(value.draining)) return 'draining is not an object or null'
  if (typeof value.version !== 'string') return 'version is not a string'
  if (typeof value.at !== 'string' || !Number.isFinite(Date.parse(value.at))) return 'at is not a time'
  if (!isStringArray(value.instruments)) return 'instruments is not a string array'
  if (!Array.isArray(value.seats)) return 'seats is not an array'
  if (!Array.isArray(value.limits)) return 'limits is not an array'
  if (!isStringArray(value.paused)) return 'paused is not a string array'
  if (value.pausedError !== null && typeof value.pausedError !== 'string') return 'pausedError is not a string or null'
  if (!Array.isArray(value.leads)) return 'leads is not an array'
  if (!isNullableRecord(value.rtk)) return 'rtk is not an object or null'
  if (!isNullableRecord(value.jev)) return 'jev is not an object or null'
  if (!isNullableRecord(value.brightdata)) return 'brightdata is not an object or null'
  if (!Array.isArray(value.machines)) return 'machines is not an array'
  return null
}

function chatEnvelope(value: Record<string, unknown>): string | null {
  if (!Array.isArray(value.posts)) return 'posts is not an array'
  if (!Array.isArray(value.handles)) return 'handles is not an array'
  if (typeof value.watchers !== 'number') return 'watchers is not a number'
  if (value.readOnly !== undefined && typeof value.readOnly !== 'boolean') return 'readOnly is not a boolean'
  return null
}

export function parseDashboard(text: string): ParseResult<Board> {
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
  if (!isRecord(value)) return fail('dashboard body is not an object')
  const problem = boardEnvelope(value)
  if (problem) return fail(problem)
  return { ok: true, value: value as Board }
}

export function parseChat(text: string): ParseResult<ChatList> {
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
  if (!isRecord(value)) return fail('chat body is not an object')
  const problem = chatEnvelope(value)
  if (problem) return fail(problem)
  return { ok: true, value: value as ChatList }
}

function count(value: unknown[] | undefined): string {
  return value ? String(value.length) : '-'
}

function ageSeconds(at: string, now: number): string {
  const parsed = Date.parse(at)
  if (!Number.isFinite(parsed)) return '-'
  return `${Math.max(0, Math.round((now - parsed) / 1000))}s`
}

/** One line: data age and the counts. A missing read is "-", never 0. */
export function summaryLine(snap: PollSnapshot | null, now: number): string {
  if (!snap?.board && !snap?.chat) return snap?.boardError ?? snap?.chatError ?? 'Reading orch...'
  const age = snap.board ? ageSeconds(snap.board.at, now) : '-'
  const posts = snap.chat ? String(snap.chat.posts.length) : '-'
  return `age ${age} · leads ${count(snap.board?.leads)} · seats ${count(snap.board?.seats)} · posts ${posts}`
}
