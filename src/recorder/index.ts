// bot.survival.recorder: a run recorded to one compressed binary stream (format.ts), to look at after with
// tools/rec.cjs. It records
// - the packets, in and out, as their wire bytes (the heavy ones, chunks and light, as a summary by default);
// - the decisions: the tasks' starts and ends (core's TaskRunner.onTask), the reflexes' preemptions and releases, the
//   milestones worked on, reached and failed, the plans and their steps (the diagnostics' trace), the play log's lines
//   (the runner's survivalLog), the deaths with their message, the respawns, the diagnostics' reports;
// - the bot's state every stateEvery ticks.
// Each record has the bot's tick (play's, as the log lines and the reports have it; else the task runner's) and the
// wall ms since the start. In Node it goes to a file (FileSink), in the browser to memory (MemorySink: blob()).
import type { Bot } from 'mineflayer'
import { isDeathMessage } from '../diagnostics/death'
import type { DiagnosticReport, TraceEvent } from '../diagnostics'
import type { TaskEvent } from '../core/taskRunner'
import { BlockEncoder, encodeHeader, K, type CodecName, type RecordingHeader, type StateSnapshot } from './format'
import { MemorySink, type RecordingSink } from './sink'
import { FileSink } from './fileSink'

export * from './codec'
export * from './format'
export * from './sink'

/** the packets kept as a summary (the id, the length, the chunk's x and z) unless packets is 'full': the chunks' and light's */
export const HEAVY_PACKETS: readonly string[] = ['map_chunk', 'update_light', 'chunk_biomes']

/**
 * the other entities' movement packets (the moves, looks, head turns, velocities and position syncs): three quarters
 * of a run's bytes in the overworld (26 a tick, a 1.21.11 run's first 6000 ticks, the entities up to 128 blocks off),
 * kept in 'summary' only for the entities within entityRange of the bot, and the bot's own
 */
export const ENTITY_MOVE_PACKETS: readonly string[] = ['rel_entity_move', 'entity_move_look', 'entity_look', 'entity_head_rotation', 'entity_velocity', 'sync_entity_position', 'entity_teleport', 'move_minecart']

/** the entities whose movement is kept in 'summary': within this many blocks of the bot (9% of the moves at 32) */
export const ENTITY_RANGE = 32

export interface RecorderOptions {
  /** the file it goes to (Node); without one (or a sink) it's kept in memory */
  file?: string
  /** where it goes, over file */
  sink?: RecordingSink
  /** the most bytes kept in memory (the memory sink's ring: the oldest blocks dropped; default 64 MiB) */
  maxBytes?: number
  /** the packets: 'summary' (the default: the heavy ones, `summarize`, as their summary), 'full' or 'none' */
  packets?: 'summary' | 'full' | 'none'
  /** only these packets, by name (default all) */
  include?: string[]
  /** not these */
  exclude?: string[]
  /** the packets kept as a summary in 'summary' (default HEAVY_PACKETS) */
  summarize?: readonly string[]
  /** in 'summary', the other entities' movement (ENTITY_MOVE_PACKETS) kept within this many blocks (default ENTITY_RANGE; Infinity for all) */
  entityRange?: number
  /** ticks between the states (default 20; 0 for none) */
  stateEvery?: number
  /** a block's raw bytes before it's compressed (default 1 MiB) */
  blockBytes?: number
  /** the most wall ms a block stays open (default 30000): what a crash loses */
  flushMs?: number
  /** the file's codec and level (FileSink's defaults: zstd, else brotli) */
  codec?: CodecName
  level?: number
  /** the tick records are stamped with (default: play's, bot.survival.diagnostics.now(), else the recorder's own count) */
  clock?: () => number
}

const perfNow = (): number => typeof performance !== 'undefined' ? performance.now() : Date.now()

/** an error's code for the record: a skill's reason under the task runner's FAILED, else the TaskError's code */
function errorCode (err: any): string | null {
  if (err == null) return null
  const cause = err.cause
  if (err.code === 'FAILED' && cause != null) {
    const inner = cause.reason ?? cause.code
    if (typeof inner === 'string') return inner
  }
  return typeof err.code === 'string' ? err.code : typeof err.reason === 'string' ? err.reason : null
}

const message = (err: any): string | null => err == null ? null : String(err.message ?? err)

/** the varint packet id that starts a packet's wire bytes */
function packetId (b: Uint8Array): number {
  let n = 0
  for (let i = 0, shift = 0; i < 5 && i < b.length; i++, shift += 7) {
    n |= (b[i] & 0x7f) << shift
    if (b[i] < 0x80) return n >>> 0
  }
  return 0
}

export class Recorder {
  readonly sink: RecordingSink
  readonly header: RecordingHeader
  private readonly encoder: BlockEncoder
  private readonly t0 = perfNow()
  private ticks = 0
  private readonly offs: Array<() => void> = []
  private readonly mode: 'summary' | 'full' | 'none'
  private readonly include: Set<string> | null
  private readonly exclude: Set<string>
  private readonly summarize: Set<string>
  private readonly entityRange: number
  /** the packets left out for the entity range, by name */
  readonly dropped: Record<string, number> = {}
  private readonly stateEvery: number
  private readonly flushMs: number
  private blockSince = perfNow()
  private stopped: Promise<void> | null = null
  private exiting = false
  private exitRaw: Uint8Array | null = null
  private dead = false
  private deathLine: { tick: number, msg: string } | null = null
  private survivalAttached = false
  /** the records written, by kind name */
  readonly counts: Record<string, number> = {}
  /** the wall ms spent in the recorder's hooks (its cost to the bot's thread; the compression is zlib's threads') */
  busyMs = 0

  constructor (readonly bot: Bot, readonly options: RecorderOptions = {}) {
    this.mode = options.packets ?? 'summary'
    this.include = options.include != null && options.include.length > 0 ? new Set(options.include) : null
    this.exclude = new Set(options.exclude ?? [])
    this.summarize = new Set(this.mode === 'full' ? [] : options.summarize ?? HEAVY_PACKETS)
    this.entityRange = this.mode === 'full' ? Infinity : options.entityRange ?? ENTITY_RANGE
    this.stateEvery = options.stateEvery ?? 20
    this.flushMs = options.flushMs ?? 30000
    this.sink = options.sink ?? (options.file != null ? new FileSink(options.file, { codec: options.codec, level: options.level }) : new MemorySink({ maxBytes: options.maxBytes }))
    this.encoder = new BlockEncoder(raw => {
      this.blockSince = perfNow()
      if (this.exiting) this.exitRaw = raw
      else this.sink.block(raw)
    }, options.blockBytes ?? 1 << 20)
    const client = (bot as any)._client
    const registry = (bot as any).registry
    this.header = {
      format: 'mineflayer-survival recording',
      mcVersion: (bot as any).version ?? registry?.version?.minecraftVersion ?? null,
      protocol: registry?.version?.version ?? client?.protocolVersion ?? null,
      start: Date.now(),
      username: (bot as any).username ?? client?.username ?? null,
      packets: this.mode,
      summarized: [...this.summarize],
      // (null: every entity's)
      entityRange: Number.isFinite(this.entityRange) ? this.entityRange : null,
      stateEvery: this.stateEvery
    }
    this.sink.header(encodeHeader(this.header))
    if (typeof client?.state === 'string') this.encoder.protocolState(this.tick(), this.ms(), client.state)
    this.watchPackets(client)
    this.watchBot()
    if ((bot as any).survival != null) this.attachSurvival()
    this.watchExit()
  }

  /** the tick a record is stamped with */
  tick (): number {
    if (this.options.clock != null) return this.options.clock()
    const now = (this.bot as any).survival?.diagnostics?.now?.()
    return typeof now === 'number' ? now : this.ticks
  }

  private ms (): number {
    return Math.round(perfNow() - this.t0)
  }

  private count (k: string): void {
    this.counts[k] = (this.counts[k] ?? 0) + 1
  }

  private on (emitter: any, event: string, fn: (...args: any[]) => void): void {
    if (typeof emitter?.on !== 'function') return
    const safe = (...args: any[]): void => {
      if (this.stopped != null) return
      this.timed(() => fn(...args))
    }
    emitter.on(event, safe)
    this.offs.push(() => emitter.removeListener?.(event, safe))
  }

  /** runs a hook, its time counted in busyMs, its errors kept from the bot */
  private timed (fn: () => void): void {
    const at = perfNow()
    try { fn() } catch {}
    this.busyMs += perfNow() - at
  }

  private wanted (name: string): boolean {
    return this.mode !== 'none' && (this.include == null || this.include.has(name)) && !this.exclude.has(name)
  }

  /** an entity's movement packet left out: an entity other than the bot farther than entityRange (one not known kept) */
  private farEntity (name: string, data: any): boolean {
    if (!Number.isFinite(this.entityRange) || !ENTITY_MOVE_PACKETS.includes(name)) return false
    const bot = this.bot as any
    const id = data?.entityId
    const me = bot.entity
    if (id == null || me?.position == null || id === me.id) return false
    const at = bot.entities?.[id]?.position
    if (at == null) return false
    const dx = at.x - me.position.x
    const dy = at.y - me.position.y
    const dz = at.z - me.position.z
    return dx * dx + dy * dy + dz * dz > this.entityRange * this.entityRange
  }

  private packet (out: boolean, name: string, data: any, bytes: Uint8Array | undefined): void {
    if (bytes == null || !this.wanted(name)) return
    if (!out && this.farEntity(name, data)) {
      this.dropped[name] = (this.dropped[name] ?? 0) + 1
      return
    }
    const tick = this.tick()
    const ms = this.ms()
    if (this.summarize.has(name)) {
      const x = data?.x ?? data?.chunkX
      const z = data?.z ?? data?.chunkZ
      this.encoder.fields(out ? K.outSummary : K.inSummary, tick, ms, [packetId(bytes), bytes.length, typeof x === 'number' ? x : undefined, typeof z === 'number' ? z : undefined])
    } else {
      this.encoder.packet(out, tick, ms, bytes)
    }
    this.count(out ? 'out' : 'in')
  }

  /**
   * the packets in from the client's packet event (the deserializer's input: the wire bytes after decompression), and
   * out from its serializer's createPacketBuffer (what goes to the compressor and the wire; a serializer of each
   * protocol state, hooked as the state changes)
   */
  private watchPackets (client: any): void {
    if (client == null) return
    this.on(client, 'packet', (data: any, meta: any, buffer: Uint8Array) => this.packet(false, meta?.name, data, buffer))
    const hooked: Array<{ ser: any, create: any }> = []
    const hook = (): void => {
      const ser = client.serializer
      if (ser == null || typeof ser.createPacketBuffer !== 'function' || hooked.some(h => h.ser === ser)) return
      const create = ser.createPacketBuffer
      hooked.push({ ser, create })
      ser.createPacketBuffer = (packet: any) => {
        const buf = create.call(ser, packet)
        if (this.stopped == null) this.timed(() => this.packet(true, packet?.name, packet?.params, buf))
        return buf
      }
    }
    hook()
    this.on(client, 'state', (state: string) => {
      this.encoder.protocolState(this.tick(), this.ms(), state)
      hook()
    })
    this.offs.push(() => { for (const h of hooked) h.ser.createPacketBuffer = h.create })
  }

  private watchBot (): void {
    const bot = this.bot as any
    this.on(bot, 'physicsTick', () => {
      this.ticks++
      if (this.stateEvery > 0 && this.ticks % this.stateEvery === 0) this.state()
      if (this.ticks % 20 === 0 && this.encoder.pending > 0 && perfNow() - this.blockSince >= this.flushMs) this.flush()
    })
    this.on(bot, 'messagestr', (msg: string) => {
      if (typeof msg !== 'string' || !msg.startsWith(`${String(bot.username)} `) || !isDeathMessage(msg)) return
      const tick = this.tick()
      this.deathLine = { tick, msg }
      this.encoder.fields(K.deathMessage, tick, this.ms(), [msg])
      this.count('death_msg')
    })
    this.on(bot, 'death', () => {
      this.dead = true
      const tick = this.tick()
      const line = this.deathLine != null && tick - this.deathLine.tick <= 40 ? this.deathLine.msg : undefined
      this.encoder.fields(K.death, tick, this.ms(), [bot.entity?.position ?? null, bot.game?.dimension ?? null, line])
      this.count('death')
    })
    this.on(bot, 'spawn', () => {
      if (!this.dead) return
      this.dead = false
      this.encoder.fields(K.respawn, this.tick(), this.ms(), [bot.entity?.position ?? null, bot.game?.dimension ?? null])
      this.count('respawn')
    })
    this.on(bot, 'reflex', (name: string, detail?: string) => {
      // (the task it preempts: the runner's running one until it stops)
      const preempted = bot.survival?.tasks?.current?.name ?? null
      this.encoder.event(K.reflex, 'preempt', this.tick(), this.ms(), [name, detail ?? null, preempted])
      this.count('reflex')
    })
    this.on(bot, 'survivalMilestone', (event: { id: string, title: string }) => {
      this.encoder.event(K.milestone, 'reached', this.tick(), this.ms(), [event.id, event.title])
      this.count('milestone')
    })
    this.on(bot, 'survivalLog', (line: string) => {
      this.encoder.fields(K.log, this.tick(), this.ms(), [line])
      this.count('log')
    })
    this.on(bot, 'end', () => { void this.stop() })
  }

  /** the tasks, the diagnostics' trace and reports of bot.survival (the plugin calls it once bot.survival is made) */
  attachSurvival (): this {
    const survival = (this.bot as any).survival
    if (this.survivalAttached || survival == null) return this
    this.survivalAttached = true
    if (typeof survival.tasks?.onTask === 'function') this.offs.push(survival.tasks.onTask((e: TaskEvent) => { if (this.stopped == null) this.timed(() => this.task(e)) }))
    const diagnostics = survival.diagnostics
    if (typeof diagnostics?.onTrace === 'function') this.offs.push(diagnostics.onTrace((e: TraceEvent) => { if (this.stopped == null) this.timed(() => this.trace(e)) }))
    if (typeof diagnostics?.onReport === 'function') {
      this.offs.push(diagnostics.onReport((report: DiagnosticReport, file: string | null) => {
        if (this.stopped != null) return
        this.encoder.fields(K.report, this.tick(), this.ms(), [report.kind, report.diagnosis, file])
        this.count('report')
      }))
    }
    return this
  }

  private task (e: TaskEvent): void {
    const tick = this.tick()
    const ms = this.ms()
    const values = e.type === 'start'
      ? [e.name, e.priority, e.attempt]
      : e.type === 'end' ? [e.name, e.priority, e.attempt, e.ticks] : [e.name, e.priority, e.attempt, e.ticks, errorCode(e.error), message(e.error)]
    this.encoder.event(K.task, e.type, tick, ms, values)
    this.count('task')
    // a reflex's task done: the reflex lets go of the bot
    if (e.name.startsWith('reflex:') && (e.type === 'end' || e.type === 'fail')) {
      this.encoder.event(K.reflex, 'release', tick, ms, [e.name.slice('reflex:'.length), null, null, e.type === 'fail' ? errorCode(e.error) : null])
      this.count('reflex')
    }
  }

  private trace (e: TraceEvent): void {
    const tick = this.tick()
    const ms = this.ms()
    switch (e.type) {
      case 'milestoneStarted': this.encoder.event(K.milestone, 'working', tick, ms, [e.id, e.title]); this.count('milestone'); return
      case 'milestoneFailed': this.encoder.event(K.milestone, 'failed', tick, ms, [e.id, null, message(e.error)]); this.count('milestone'); return
      case 'planMade': this.encoder.fields(K.plan, tick, ms, [e.n, e.requests, e.steps]); this.count('plan'); return
      case 'noPlan': this.encoder.fields(K.noPlan, tick, ms, [e.requests, message(e.error)]); this.count('no_plan'); return
      case 'stepStarted': this.encoder.event(K.step, 'start', tick, ms, [e.desc, e.index]); this.count('step'); return
      case 'stepDone': this.encoder.event(K.step, 'done', tick, ms, [e.key, e.gained]); this.count('step'); return
      case 'stepFailed': this.encoder.event(K.step, 'fail', tick, ms, [e.desc, e.n, message(e.error)]); this.count('step')
    }
  }

  /** the bot as it is now: a state record */
  state (): void {
    const bot = this.bot as any
    const e = bot.entity
    const inv = new Map<string, number>()
    const slots = bot.inventory?.slots
    if (slots != null) {
      for (let i = 5; i <= 45 && i < slots.length; i++) {
        const it = slots[i]
        if (it != null) inv.set(it.name, (inv.get(it.name) ?? 0) + Number(it.count))
      }
    }
    const xyz = (v: any): [number, number, number] | null => v != null && typeof v.x === 'number' ? [v.x, v.y, v.z] : null
    const snap: StateSnapshot = {
      pos: xyz(e?.position),
      vel: xyz(e?.velocity),
      onGround: e?.onGround === true,
      health: Number(bot.health ?? 0),
      food: Number(bot.food ?? 0),
      saturation: Number(bot.foodSaturation ?? 0),
      dim: bot.game?.dimension ?? null,
      held: bot.heldItem?.name ?? null,
      task: bot.survival?.tasks?.current?.name ?? null,
      reflex: bot.survival?.reflexes?.current?.name ?? null,
      milestone: bot.survival?.diagnostics?.milestone?.id ?? null,
      yaw: Number(e?.yaw ?? 0),
      pitch: Number(e?.pitch ?? 0),
      oxygen: Number(bot.oxygenLevel ?? 0),
      inv
    }
    this.encoder.state(this.tick(), this.ms(), snap)
    this.count('state')
  }

  /** a note of the caller's (a checkpoint, a marker): `name` and any data */
  note (name: string, data?: unknown): void {
    if (this.stopped != null) return
    this.encoder.fields(K.note, this.tick(), this.ms(), [name, data])
    this.count('note')
  }

  /** hands the block being written to the sink now (it's compressed and kept, or written) */
  flush (): void {
    this.encoder.flush()
  }

  /** the raw bytes recorded so far, and the compressed bytes the sink holds */
  get stats (): { rawBytes: number, pendingBytes: number, bytes: number, ticks: number, busyMs: number } {
    return { rawBytes: this.encoder.rawBytes, pendingBytes: this.encoder.pending, bytes: this.sink.bytes, ticks: this.ticks, busyMs: Math.round(this.busyMs) }
  }

  get recording (): boolean {
    return this.stopped == null
  }

  /** stops recording: the hooks off, the last block written, the sink closed */
  async stop (): Promise<void> {
    if (this.stopped != null) return await this.stopped
    this.stopped = (async () => {
      for (const off of this.offs.splice(0)) {
        try { off() } catch {}
      }
      // (what the entity range left out, for the summary)
      if (Object.keys(this.dropped).length > 0) this.encoder.fields(K.note, this.tick(), this.ms(), ['dropped', this.dropped])
      this.encoder.flush()
      await this.sink.end()
    })()
    return await this.stopped
  }

  /** on the process's exit (Node), the last block written synchronously: a run killed keeps what it recorded */
  private watchExit (): void {
    const proc: any = typeof process !== 'undefined' ? process : null
    if (typeof proc?.on !== 'function' || typeof this.sink.endSync !== 'function') return
    const onExit = (): void => {
      if (this.stopped != null) return
      this.exiting = true
      this.encoder.flush()
      try { this.sink.endSync?.(this.exitRaw) } catch {}
    }
    proc.on('exit', onExit)
    this.offs.push(() => proc.removeListener?.('exit', onExit))
  }
}

/** starts a recorder on the bot (bot.survival.recorder, the one there stopped) */
export function startRecorder (bot: Bot, options: RecorderOptions = {}): Recorder {
  const survival = (bot as any).survival
  const old: Recorder | null | undefined = survival?.recorder
  if (old != null) void old.stop()
  const recorder = new Recorder(bot, options)
  if (survival != null) survival.recorder = recorder
  return recorder
}
