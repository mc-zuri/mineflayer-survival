// A recording's events filtered and summed up, one at a time (tools/rec.cjs streams a file through them): by kind, by
// packet name, by tick, around each death, by a regex; the summary's counts. Pure: the CLI's reading is read.ts.
import type { RecEvent } from './format'

export interface EventFilter {
  /** kinds kept: a kind ('task') or a kind and its event ('task.fail') */
  kinds?: string[]
  /** packets kept, by name ('map_chunk', or a prefix: 'set_*'); the other kinds pass */
  packets?: string[]
  /** the ticks kept, from and to (both kept) */
  from?: number
  to?: number
  /** a regex the event's text (as written out) has to match */
  grep?: RegExp
}

function nameMatches (name: string | undefined, patterns: readonly string[]): boolean {
  if (name == null) return false
  return patterns.some(p => p.endsWith('*') ? name.startsWith(p.slice(0, -1)) : name === p)
}

/** whether an event passes the kind, packet and tick filters (the regex is tested on its text, by the caller) */
export function passes (e: RecEvent, f: EventFilter): boolean {
  if (f.from != null && e.t < f.from) return false
  if (f.to != null && e.t > f.to) return false
  if (f.kinds != null && f.kinds.length > 0 && !f.kinds.some(k => k === e.k || (e.ev != null && k === `${e.k}.${String(e.ev)}`))) return false
  if (f.packets != null && f.packets.length > 0) {
    if (e.k !== 'in' && e.k !== 'out') return false
    if (!nameMatches(e.name as string | undefined, f.packets)) return false
  }
  return true
}

/**
 * Keeps the events of the last `ticks` ticks and lets them out at each death (the N ticks before it, and the death):
 * `push` every event, `trigger` with each death; what's out goes to `emit`. Events after a death wait for the next one.
 */
export class AroundDeaths {
  private readonly window: RecEvent[] = []
  constructor (private readonly ticks: number, private readonly emit: (e: RecEvent) => void) {}

  /** an event that passed the filters */
  push (e: RecEvent): void {
    this.window.push(e)
    while (this.window.length > 0 && this.window[0].t < e.t - this.ticks) this.window.shift()
  }

  /** a death (from every event, filtered or not): the window before it, then the death itself */
  trigger (death: RecEvent): void {
    for (const e of this.window) if (e.t >= death.t - this.ticks && e !== death) this.emit(e)
    this.window.length = 0
    this.emit(death)
  }
}

export interface RecordingSummary {
  events: number
  ticks: { first: number | null, last: number | null }
  wallMs: number
  /** by kind, and by kind and event ('task.fail') */
  kinds: Record<string, number>
  /** the packets by name: count and wire bytes, in and out */
  packets: { in: Record<string, { count: number, bytes: number }>, out: Record<string, { count: number, bytes: number }> }
  deaths: Array<{ t: number, pos: unknown, dim: unknown, msg: string | null }>
  respawns: number
  /** each milestone: the tick it was first worked on, the tick reached, its failures */
  milestones: Record<string, { working: number | null, reached: number | null, failed: number }>
  /** the tasks' failures by code, and the tasks that failed with it most */
  taskFailures: Record<string, { count: number, tasks: Record<string, number> }>
  /** the diagnostics' reports by kind */
  reports: Record<string, number>
  /** the packets the recorder left out (the far entities' moves), by name */
  dropped: Record<string, number>
}

/** the summary, added to event by event */
export class Summary {
  readonly s: RecordingSummary = {
    events: 0,
    ticks: { first: null, last: null },
    wallMs: 0,
    kinds: {},
    packets: { in: {}, out: {} },
    deaths: [],
    respawns: 0,
    milestones: {},
    taskFailures: {},
    reports: {},
    dropped: {}
  }

  add (e: RecEvent): void {
    const s = this.s
    s.events++
    s.ticks.first ??= e.t
    s.ticks.last = e.t
    if (e.ms > s.wallMs) s.wallMs = e.ms
    s.kinds[e.k] = (s.kinds[e.k] ?? 0) + 1
    if (e.ev != null) s.kinds[`${e.k}.${String(e.ev)}`] = (s.kinds[`${e.k}.${String(e.ev)}`] ?? 0) + 1
    switch (e.k) {
      case 'in':
      case 'out': {
        const name = (e.name as string | undefined) ?? `0x${Number(e.id).toString(16)}`
        const by = s.packets[e.k]
        const p = by[name] ??= { count: 0, bytes: 0 }
        p.count++
        p.bytes += Number(e.bytes ?? 0)
        return
      }
      case 'death':
        s.deaths.push({ t: e.t, pos: e.pos ?? null, dim: e.dim ?? null, msg: (e.msg as string | null) ?? null })
        return
      case 'death_msg': {
        // (the message after its death: onto it)
        const last = s.deaths[s.deaths.length - 1]
        if (last != null && last.msg == null && e.t - last.t <= 100) last.msg = e.msg as string
        return
      }
      case 'respawn':
        s.respawns++
        return
      case 'milestone': {
        const m = s.milestones[String(e.id)] ??= { working: null, reached: null, failed: 0 }
        if (e.ev === 'working') m.working ??= e.t
        else if (e.ev === 'reached') m.reached ??= e.t
        else if (e.ev === 'failed') m.failed++
        return
      }
      case 'task': {
        if (e.ev !== 'fail') return
        const code = (e.code as string | null) ?? 'none'
        const f = s.taskFailures[code] ??= { count: 0, tasks: {} }
        f.count++
        f.tasks[String(e.name)] = (f.tasks[String(e.name)] ?? 0) + 1
        return
      }
      case 'report':
        s.reports[String(e.kind)] = (s.reports[String(e.kind)] ?? 0) + 1
        return
      case 'note':
        if (e.name === 'dropped' && e.data != null && typeof e.data === 'object') {
          for (const [name, n] of Object.entries(e.data as Record<string, number>)) s.dropped[name] = (s.dropped[name] ?? 0) + Number(n)
        }
    }
  }
}

const top = <T>(entries: Array<[string, T]>, by: (v: T) => number, n: number): Array<[string, T]> => entries.sort((a, b) => by(b[1]) - by(a[1])).slice(0, n)

/** the summary as lines to read */
export function summaryLines (s: RecordingSummary, file?: { bytes: number, blocks: number, rawBytes: number }): string[] {
  const out: string[] = []
  const span = s.ticks.first != null && s.ticks.last != null ? s.ticks.last - s.ticks.first : 0
  out.push(`${s.events} events, ticks ${String(s.ticks.first)} to ${String(s.ticks.last)} (${span}), ${(s.wallMs / 1000).toFixed(1)} s wall`)
  if (file != null) {
    out.push(`${file.bytes} bytes in ${file.blocks} blocks (${file.rawBytes} raw, ${(file.rawBytes / Math.max(1, file.bytes)).toFixed(1)}x), ${span > 0 ? Math.round(file.bytes / span * 1000) : '?'} bytes per 1000 ticks`)
  }
  out.push('kinds:')
  for (const [k, n] of Object.entries(s.kinds).sort((a, b) => a[0] < b[0] ? -1 : 1)) out.push(`  ${k.padEnd(22)} ${n}`)
  for (const dir of ['in', 'out'] as const) {
    const all = Object.entries(s.packets[dir])
    if (all.length === 0) continue
    const total = all.reduce((a, [, p]) => a + p.bytes, 0)
    out.push(`packets ${dir} (${all.length} kinds, ${total} bytes; by bytes):`)
    for (const [name, p] of top(all, p => p.bytes, 25)) out.push(`  ${name.padEnd(30)} ${String(p.count).padStart(8)}  ${String(p.bytes).padStart(11)} B`)
  }
  const dropped = Object.entries(s.dropped)
  if (dropped.length > 0) out.push(`left out (the far entities' moves): ${top(dropped, n => n, 10).map(([name, n]) => `${name} ${n}`).join(', ')}`)
  out.push(`deaths: ${s.deaths.length}${s.respawns > 0 ? ` (${s.respawns} respawns)` : ''}`)
  for (const d of s.deaths) out.push(`  t${d.t} ${Array.isArray(d.pos) ? d.pos.map((c: number) => Math.floor(c)).join(' ') : '?'} ${String(d.dim ?? '?')}: ${d.msg ?? '(no message)'}`)
  const ms = Object.entries(s.milestones)
  out.push(`milestones: ${ms.length}`)
  for (const [id, m] of ms) out.push(`  ${id.padEnd(12)} working t${String(m.working ?? '-')}  reached ${m.reached != null ? `t${m.reached}` : '-'}${m.failed > 0 ? `  failed ${m.failed}` : ''}`)
  const fails = Object.entries(s.taskFailures)
  out.push(`task failures: ${fails.reduce((a, [, f]) => a + f.count, 0)}`)
  for (const [code, f] of top(fails, f => f.count, 20)) out.push(`  ${code.padEnd(22)} ${String(f.count).padStart(6)}  ${top(Object.entries(f.tasks), n => n, 4).map(([t, n]) => `${t} ${n}`).join(', ')}`)
  const reports = Object.entries(s.reports)
  if (reports.length > 0) out.push(`reports: ${reports.map(([k, n]) => `${k} ${n}`).join(', ')}`)
  return out
}

// --- writing events out ---

/** a value as JSON can have it: bigints as strings, byte arrays as hex (long ones as their length), no cycles */
export function plain (v: unknown, depth = 0): unknown {
  if (v == null || typeof v === 'boolean' || typeof v === 'string') return v
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v)
  if (typeof v === 'bigint') return v.toString()
  if (typeof v === 'function' || typeof v === 'symbol') return undefined
  if (v instanceof Uint8Array) return v.length > 64 ? { bytes: v.length } : Array.from(v, b => b.toString(16).padStart(2, '0')).join('')
  if (depth > 12) return '…'
  if (Array.isArray(v)) return v.map(x => plain(x, depth + 1))
  if (v instanceof Map) return Object.fromEntries([...v].map(([k, x]) => [String(k), plain(x, depth + 1)]))
  if (v instanceof Set) return [...v].map(x => plain(x, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v as object)) {
    const p = plain(x, depth + 1)
    if (p !== undefined) out[k] = p
  }
  return out
}

/** an event as one JSON line (its raw bytes left out unless asked) */
export function jsonLine (e: RecEvent, raw = false): string {
  const { raw: bytes, ...rest } = e as RecEvent & { raw?: Uint8Array }
  const out: Record<string, unknown> = plain(rest) as Record<string, unknown>
  if (raw && bytes != null) out.raw = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
  return JSON.stringify(out)
}

const num = (v: unknown, digits = 1): string => typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(digits)) : '-'
const xyz = (p: unknown, digits = 1): string => Array.isArray(p) ? p.map(c => num(c, digits)).join(' ') : '-'

/** an event as a line to read: the tick, the wall time, the kind and what it says */
export function tableLine (e: RecEvent): string {
  const head = `${String(e.t).padStart(9)} ${(e.ms / 1000).toFixed(1).padStart(8)}s ${e.k.padEnd(9)}`
  const ev = e.ev != null ? `${String(e.ev)} ` : ''
  let body: string
  switch (e.k) {
    case 'in':
    case 'out': {
      const name = (e.name as string | undefined) ?? `0x${Number(e.id).toString(16)}`
      const where = e.x != null ? ` x=${String(e.x)} z=${String(e.z)}` : ''
      body = `${name} ${String(e.bytes)} B${where}${e.summary === true ? ' (summary)' : ''}${e.data !== undefined ? ` ${JSON.stringify(plain(e.data))}` : ''}`
      break
    }
    case 'state': {
      const dinv = e.dinv != null ? ` inv ${Object.entries(e.dinv as Record<string, number>).map(([n, d]) => `${d > 0 ? '+' : ''}${d} ${n}`).join(', ')}` : ''
      body = `${xyz(e.pos)} ${String(e.dim ?? '')}${e.onGround === true ? ' ground' : ''} hp ${num(e.health)} food ${num(e.food)} held ${String(e.held ?? '-')} task ${String(e.task ?? '-')}${e.reflex != null ? ` reflex ${String(e.reflex)}` : ''}${dinv}`
      break
    }
    case 'task': body = `${ev}${String(e.name)} p${String(e.priority)} #${String(e.attempt)}${e.ticks != null ? ` ${String(e.ticks)} ticks` : ''}${e.code != null ? ` ${String(e.code)}` : ''}${e.msg != null ? `: ${String(e.msg)}` : ''}`; break
    case 'reflex': body = `${ev}${String(e.name)}${e.detail != null ? ` (${String(e.detail)})` : ''}${e.preempted != null ? ` over ${String(e.preempted)}` : ''}${e.code != null ? ` ${String(e.code)}` : ''}`; break
    case 'milestone': body = `${ev}${String(e.id)}${e.title != null ? `: ${String(e.title)}` : ''}${e.msg != null ? `: ${String(e.msg)}` : ''}`; break
    case 'plan': body = `#${String(e.n)} for ${(e.requests as string[] ?? []).join(', ')}: ${(e.steps as string[] ?? []).join(' > ')}`; break
    case 'no_plan': body = `for ${(e.requests as string[] ?? []).join(', ')}: ${String(e.msg)}`; break
    case 'step': body = `${ev}${String(e.desc)}${e.n != null ? ` ${String(e.n)}` : ''}${e.msg != null ? `: ${String(e.msg)}` : ''}`; break
    case 'log': body = String(e.line); break
    case 'death': body = `${xyz(e.pos)} ${String(e.dim ?? '')}${e.msg != null ? `: ${String(e.msg)}` : ''}`; break
    case 'death_msg': body = String(e.msg); break
    case 'respawn': body = `${xyz(e.pos)} ${String(e.dim ?? '')}`; break
    case 'report': body = `${String(e.kind)}: ${String(e.diagnosis)}${e.file != null ? ` (${String(e.file)})` : ''}`; break
    case 'pstate': body = String(e.state); break
    case 'note': body = `${String(e.name)}${e.data != null ? ` ${JSON.stringify(plain(e.data))}` : ''}`; break
    default: {
      const { t: _t, ms: _ms, k: _k, ...rest } = e
      body = JSON.stringify(plain(rest))
    }
  }
  return `${head} ${body}`
}
