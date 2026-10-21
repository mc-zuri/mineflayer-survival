// tools/rec.cjs: a recording queried, streamed a block at a time.
//
//   node tools/rec.cjs <file.rec> [--summary] [--kind task,reflex.preempt,...] [--packet map_chunk,set_*]
//                      [--from <tick>] [--to <tick>] [--around death [ticks]] [--grep <regex>] [--ndjson] [--data]
//                      [--raw] [--limit <n>]
//   node tools/rec.cjs <file.rec> --recompress <out.rec> [--codec zstd|brotli|deflate-raw] [--level <n>]
//
// --kind: kinds (in, out, state, task, reflex, milestone, plan, no_plan, step, log, death, death_msg, respawn, report,
// pstate, note), or a kind and its event (task.fail). --packet: the packets by name (a trailing * a prefix), their
// fields decoded (--data, on by itself here). --around death [ticks]: the ticks before each death (default 200).
// --grep: the events whose line (or JSON line with --ndjson) matches. --summary: the counts by kind and packet, the
// deaths, the milestones, the tasks' failures by code. Lines to read by default; --ndjson for one JSON object a line
// (--raw adds the packets' wire bytes in hex). --recompress: the file written again with another codec (a browser's
// deflate-raw recording as zstd 19, default, for keeping).
import { readRecording, packetParser, recompress } from './read'
import { AroundDeaths, Summary, jsonLine, passes, summaryLines, tableLine, type EventFilter } from './query'
import type { CodecName, PacketEvent, RecEvent, RecordingHeader } from './format'

export interface CliOptions {
  file: string
  summary: boolean
  filter: EventFilter
  around: number | null
  ndjson: boolean
  data: boolean
  raw: boolean
  limit: number | null
  /** the file to write the recording to again, with codec and level */
  recompress: string | null
  codec: CodecName
  level: number | undefined
}

export const AROUND_DEATH_TICKS = 200

export function parseCliArgs (argv: readonly string[]): CliOptions {
  const opts: CliOptions = { file: '', summary: false, filter: {}, around: null, ndjson: false, data: false, raw: false, limit: null, recompress: null, codec: 'zstd', level: undefined }
  const list = (v: string): string[] => v.split(',').map(s => s.trim()).filter(s => s !== '')
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split('=', 2)
    const value = (): string => {
      const v = inline ?? argv[++i]
      if (v == null) throw new Error(`${flag} needs a value`)
      return v
    }
    switch (flag) {
      case '--summary': opts.summary = true; break
      case '--kind': opts.filter.kinds = [...(opts.filter.kinds ?? []), ...list(value())]; break
      case '--packet': opts.filter.packets = [...(opts.filter.packets ?? []), ...list(value())]; opts.data = true; break
      case '--from': opts.filter.from = Number(value()); break
      case '--to': opts.filter.to = Number(value()); break
      case '--grep': opts.filter.grep = new RegExp(value()); break
      case '--around': {
        if (value() !== 'death') throw new Error('--around takes death [ticks]')
        const n = argv[i + 1]
        if (n != null && /^\d+$/.test(n)) { opts.around = Number(n); i++ } else opts.around = AROUND_DEATH_TICKS
        break
      }
      case '--ndjson': opts.ndjson = true; break
      case '--table': opts.ndjson = false; break
      case '--data': opts.data = true; break
      case '--raw': opts.raw = true; break
      case '--limit': opts.limit = Number(value()); break
      case '--recompress': opts.recompress = value(); break
      case '--codec': {
        const v = value()
        if (v !== 'zstd' && v !== 'brotli' && v !== 'deflate-raw' && v !== 'none') throw new Error('--codec is zstd, brotli, deflate-raw or none')
        opts.codec = v
        break
      }
      case '--level': opts.level = Number(value()); break
      default:
        if (flag.startsWith('--')) throw new Error(`unknown option ${flag}`)
        if (opts.file !== '') throw new Error(`one file at a time (${opts.file}, ${flag})`)
        opts.file = argv[i]
    }
  }
  if (opts.file === '') throw new Error('usage: rec <file.rec> [--summary] [--kind k,...] [--packet name,...] [--from t] [--to t] [--around death [ticks]] [--grep re] [--ndjson] [--data] [--raw] [--limit n]')
  for (const n of [opts.filter.from, opts.filter.to, opts.limit]) if (n != null && !Number.isFinite(n)) throw new Error('--from, --to and --limit take numbers')
  return opts
}

/** runs the query, each line out through `write`; resolves with the lines written */
export async function runCli (opts: CliOptions, write: (line: string) => void): Promise<number> {
  if (opts.recompress != null) {
    const bytes = await recompress(opts.file, opts.recompress, opts.codec, opts.level)
    write(`${opts.recompress}: ${bytes} bytes (${opts.codec}${opts.level != null ? ` ${opts.level}` : ''})`)
    return 1
  }
  let header: RecordingHeader | null = null
  let parse: ((e: PacketEvent) => unknown) | null = null
  const summary = opts.summary ? new Summary() : null
  let written = 0
  let stop = false
  const out = (e: RecEvent): void => {
    if (stop) return
    if (opts.data && (e.k === 'in' || e.k === 'out') && (e as PacketEvent).raw != null && parse != null) e.data = parse(e as PacketEvent)
    const line = opts.ndjson ? jsonLine(e, opts.raw) : tableLine(e)
    if (opts.filter.grep != null && !opts.filter.grep.test(line)) return
    write(line)
    if (opts.limit != null && ++written >= opts.limit) stop = true
  }
  const around = opts.around != null ? new AroundDeaths(opts.around, out) : null
  const stats = await readRecording(opts.file, (e) => {
    const pass = passes(e, opts.filter)
    if (summary != null) {
      if (pass) summary.add(e)
      return
    }
    if (around != null) {
      if (e.k === 'death') around.trigger(e)
      else if (pass) around.push(e)
      return
    }
    if (pass) out(e)
  }, (h) => {
    header = h
    parse = packetParser(h.mcVersion)
    if (opts.ndjson && summary == null) write(JSON.stringify({ k: 'header', ...h }))
  })
  if (summary != null) {
    const h = header as RecordingHeader | null
    if (opts.ndjson) {
      write(JSON.stringify({ header: h, file: stats, ...summary.s }))
    } else {
      if (h != null) write(`${opts.file}: ${String(h.username)} on ${String(h.mcVersion)} (protocol ${String(h.protocol)}), started ${new Date(h.start).toISOString()}, packets ${h.packets}`)
      for (const line of summaryLines(summary.s, stats)) write(line)
      if (stats.truncated) write('(its last block is cut short: the run was killed while writing it)')
    }
  }
  return written
}

export async function main (argv: readonly string[]): Promise<void> {
  let opts: CliOptions
  try {
    opts = parseCliArgs(argv)
  } catch (err) {
    console.error((err as Error).message)
    process.exitCode = 2
    return
  }
  // (a pipe closed early, `| head`: done)
  process.stdout.on('error', (err: any) => { if (err?.code === 'EPIPE') process.exit(0) })
  await runCli(opts, line => process.stdout.write(`${line}\n`))
}
