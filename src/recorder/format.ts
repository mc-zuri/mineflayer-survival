// The recording's format: a header, then blocks, each compressed on its own and readable on its own.
//
//   file   = magic "MFRC", u8 format version, varint header length, header (a tagged value, its strings inline)
//            then block*
//   block  = u8 codec (none, deflate-raw, brotli, zstd), varint raw length, varint compressed length, compressed bytes
//   raw    = zigzag tick, varint ms (the times the block's deltas start from), varint heads length, head*, group*
//   head   = u8 0 (a string for the block's table: varint length, utf8; it takes the next id), or
//            u8 kind, [varint packet id: the packets'], zigzag tick delta, varint ms delta, varint payload length
//   group  = the payloads of one kind (one packet id) and one length, in the order the heads first name them, their
//            bytes transposed: the first byte of each, then the second of each ... (Blosc's shuffle)
//
// The heads say what happened when; the payloads are grouped and transposed so that like bytes sit together for the
// compressor (an entity id's bytes, a move's deltas, a flag): a fifth smaller than the records one after another
// (zstd 19, a 1.21.11 run's 6000 ticks: 44.0 kB a 1000 ticks interleaved, 34.8 grouped and transposed). A packet's
// payload is its wire bytes after its id, as the protocol has them (the deserializer's input, the serializer's output,
// after compression is undone), so it costs what it cost on the wire; the heavy ones (chunks, light) are a summary
// instead by default: the id, the byte length and the chunk's x and z.
// The decisions are laid out by their kind's fields (KINDS): strings as refs to the block's table (a task's name, an
// error code, a log line's template, once a block), numbers as varints, a log line's numbers taken out of its text
// (codec.ts splitTemplate). The state every N ticks is the change from the one before it in the block (a mask of what
// changed, the position in thousandths as deltas, the inventory as the counts that changed).
//
// Each block starts afresh (its own strings, its first state whole), so a block lost (the ring buffer's oldest dropped,
// a crash before the last one was written) leaves the others readable.
import { ByteReader, ByteWriter, joinTemplate, readValue, splitTemplate, utf8, writeValue, type StringOut } from './codec'

export const MAGIC = utf8('MFRC')
export const FORMAT_VERSION = 1

/** how a block's bytes are compressed */
export enum Codec { None = 0, DeflateRaw = 1, Brotli = 2, Zstd = 3 }
export type CodecName = 'none' | 'deflate-raw' | 'brotli' | 'zstd'
export const CODEC_NAMES: Record<Codec, CodecName> = { [Codec.None]: 'none', [Codec.DeflateRaw]: 'deflate-raw', [Codec.Brotli]: 'brotli', [Codec.Zstd]: 'zstd' }
export function codecOf (name: CodecName): Codec {
  return Number(Object.entries(CODEC_NAMES).find(([, n]) => n === name)?.[0] ?? Codec.None)
}

/** what the header says of the recording */
export interface RecordingHeader {
  format: 'mineflayer-survival recording'
  /** the Minecraft version (its packets are decoded with minecraft-protocol for it) and its protocol number */
  mcVersion: string | null
  protocol: number | null
  /** the wall time the recording started at (epoch ms): each record's ms is from it */
  start: number
  username: string | null
  /** the packets kept: 'summary' (the heavy ones summarised), 'full' or 'none' */
  packets: string
  /** the packets kept as a summary */
  summarized: string[]
  /** the ticks between states */
  stateEvery: number
  [key: string]: unknown
}

// --- the kinds ---

/**
 * A field's type: u unsigned varint, i signed (zigzag, rounded), s a string (the table's ref + 1, 0 for none),
 * t a templated string (its template's ref + 1, the count of its numbers and the numbers), S and T arrays of them,
 * p a position (0 for none, else 1 and x, y, z in thousandths, zigzag), v a tagged value
 */
export type FieldType = 'u' | 'i' | 's' | 't' | 'S' | 'T' | 'p' | 'v'

export interface KindDef {
  name: string
  /** what happened, the first field's index into it (task start, end ...) */
  ev?: readonly string[]
  fields: ReadonlyArray<readonly [string, FieldType]>
}

export const K = {
  str: 0,
  pstate: 1,
  in: 2,
  out: 3,
  inSummary: 4,
  outSummary: 5,
  state: 6,
  task: 7,
  reflex: 8,
  milestone: 9,
  plan: 10,
  noPlan: 11,
  step: 12,
  log: 13,
  death: 14,
  deathMessage: 15,
  respawn: 16,
  report: 17,
  note: 18
} as const

export const TASK_EVENTS = ['start', 'end', 'fail', 'preempted', 'retry'] as const
export const REFLEX_EVENTS = ['preempt', 'release'] as const
export const MILESTONE_EVENTS = ['working', 'reached', 'failed'] as const
export const STEP_EVENTS = ['start', 'done', 'fail'] as const

/** the kinds laid out by their fields (the packets and the state have their own) */
export const KINDS: Record<number, KindDef> = {
  [K.pstate]: { name: 'pstate', fields: [['state', 's']] },
  [K.inSummary]: { name: 'in', fields: [['id', 'u'], ['bytes', 'u'], ['x', 'i'], ['z', 'i']] },
  [K.outSummary]: { name: 'out', fields: [['id', 'u'], ['bytes', 'u'], ['x', 'i'], ['z', 'i']] },
  [K.task]: { name: 'task', ev: TASK_EVENTS, fields: [['name', 's'], ['priority', 'i'], ['attempt', 'u'], ['ticks', 'u'], ['code', 's'], ['msg', 't']] },
  [K.reflex]: { name: 'reflex', ev: REFLEX_EVENTS, fields: [['name', 's'], ['detail', 't'], ['preempted', 's'], ['code', 's']] },
  [K.milestone]: { name: 'milestone', ev: MILESTONE_EVENTS, fields: [['id', 's'], ['title', 't'], ['msg', 't']] },
  [K.plan]: { name: 'plan', fields: [['n', 'u'], ['requests', 'T'], ['steps', 'T']] },
  [K.noPlan]: { name: 'no_plan', fields: [['requests', 'T'], ['msg', 't']] },
  [K.step]: { name: 'step', ev: STEP_EVENTS, fields: [['desc', 't'], ['n', 'i'], ['msg', 't']] },
  [K.log]: { name: 'log', fields: [['line', 't']] },
  [K.death]: { name: 'death', fields: [['pos', 'p'], ['dim', 's'], ['msg', 't']] },
  [K.deathMessage]: { name: 'death_msg', fields: [['msg', 't']] },
  [K.respawn]: { name: 'respawn', fields: [['pos', 'p'], ['dim', 's']] },
  [K.report]: { name: 'report', fields: [['kind', 's'], ['diagnosis', 't'], ['file', 't']] },
  [K.note]: { name: 'note', fields: [['name', 's'], ['data', 'v']] }
}

/** every kind's name, as the decoded events have it in `k` */
export const KIND_NAMES: readonly string[] = ['in', 'out', 'state', 'pstate', ...new Set(Object.values(KINDS).map(d => d.name))]

// --- the state ---

/** the bot every N ticks */
export interface StateSnapshot {
  pos: readonly [number, number, number] | null
  vel: readonly [number, number, number] | null
  onGround: boolean
  health: number
  food: number
  saturation: number
  dim: string | null
  /** the held item's name */
  held: string | null
  /** the foreground task, the reflex and the milestone being worked on */
  task: string | null
  reflex: string | null
  milestone: string | null
  yaw: number
  pitch: number
  oxygen: number
  /** the count of each item carried (worn and the off hand too) */
  inv: ReadonlyMap<string, number>
}

/** the state's fields, by their bit in its mask */
const S_POS = 1 << 0
const S_VEL = 1 << 1
const S_GROUND = 1 << 2
const S_HEALTH = 1 << 3
const S_FOOD = 1 << 4
const S_SAT = 1 << 5
const S_DIM = 1 << 6
const S_HELD = 1 << 7
const S_TASK = 1 << 8
const S_REFLEX = 1 << 9
const S_MILESTONE = 1 << 10
const S_LOOK = 1 << 11
const S_OXYGEN = 1 << 12
const S_INV = 1 << 13

/** a state as the integers it's stored as (positions and velocities in thousandths, health in hundredths) */
interface StateInts {
  pos: [number, number, number]
  vel: [number, number, number]
  onGround: boolean
  health: number
  food: number
  sat: number
  dim: string | null
  held: string | null
  task: string | null
  reflex: string | null
  milestone: string | null
  yaw: number
  pitch: number
  oxygen: number
  inv: Map<string, number>
}

function blankState (): StateInts {
  return { pos: [0, 0, 0], vel: [0, 0, 0], onGround: false, health: 0, food: 0, sat: 0, dim: null, held: null, task: null, reflex: null, milestone: null, yaw: 0, pitch: 0, oxygen: 0, inv: new Map() }
}

const finite = (v: number): number => Number.isFinite(v) ? v : 0
const milli = (v: number): number => Number.isFinite(v) ? Math.round(v * 1000) : 0
const scaled = (v: number, by: number): number => Number.isFinite(v) ? Math.round(v * by) : 0

// --- writing ---

/**
 * Writes records into blocks of about blockBytes, handing each block's raw bytes to onBlock when it's full or
 * flushed. The strings each block refers to go in it before the first record that refers to them.
 */
/** a group's payloads: one kind (and packet id) and one length, one after another until the block is written */
interface Group {
  length: number
  count: number
  rows: ByteWriter
}

/** a group's key: the kind, the packet id (-1 for none) and the length */
const groupKey = (kind: number, id: number, length: number): number => (kind * 65536 + id + 1) * 16777216 + length

export class BlockEncoder {
  private readonly heads = new ByteWriter(65536)
  private readonly groups = new Map<number, Group>()
  private groupBytes = 0
  private blockTick = 0
  private blockMs = 0
  private readonly scratch = new ByteWriter(4096)
  private readonly strings = new Map<string, number>()
  private lastTick = 0
  private lastMs = 0
  private prev: StateInts = blankState()
  private pstate: string | null = null
  private open = false
  private records = 0
  /** the raw bytes handed over so far */
  rawBytes = 0
  private readonly out: StringOut = { ref: (s) => this.ref(s) }

  constructor (private readonly onBlock: (raw: Uint8Array) => void, readonly blockBytes = 1 << 20) {}

  /** the bytes of the block being written */
  get pending (): number {
    return this.open ? this.heads.length + this.groupBytes : 0
  }

  private begin (): void {
    this.heads.reset()
    this.groups.clear()
    this.groupBytes = 0
    this.blockTick = this.lastTick
    this.blockMs = this.lastMs
    this.strings.clear()
    this.prev = blankState()
    this.open = true
    if (this.pstate != null) this.fields(K.pstate, this.lastTick, this.lastMs, [this.pstate])
    // (a block of nothing but its protocol state isn't handed over)
    this.records = 0
  }

  private ref (s: string): number {
    let id = this.strings.get(s)
    if (id == null) {
      id = this.strings.size
      this.strings.set(s, id)
      this.heads.u8(K.str)
      this.heads.str(s)
    }
    return id
  }

  /** a record: its head, and its payload to its group (id: the packet's, -1 for the other kinds) */
  private put (kind: number, id: number, tick: number, ms: number, payload: Uint8Array): void {
    const w = this.heads
    w.u8(kind)
    if (id >= 0) w.varint(id)
    w.zigzag(tick - this.lastTick)
    w.varint(Math.max(0, ms - this.lastMs))
    w.varint(payload.length)
    this.lastTick = tick
    if (ms > this.lastMs) this.lastMs = ms
    this.records++
    const key = groupKey(kind, id, payload.length)
    let g = this.groups.get(key)
    if (g == null) {
      g = { length: payload.length, count: 0, rows: new ByteWriter(Math.max(16, payload.length * 4)) }
      this.groups.set(key, g)
    }
    g.rows.bytes(payload)
    g.count++
    this.groupBytes += payload.length
    if (this.heads.length + this.groupBytes >= this.blockBytes) this.flush()
  }

  /** a packet's wire bytes: its id in its head, the rest its payload */
  packet (out: boolean, tick: number, ms: number, bytes: Uint8Array): void {
    if (!this.open) this.begin()
    let id = 0
    let at = 0
    for (let shift = 0; at < bytes.length && at < 5; shift += 7) {
      const b = bytes[at++]
      id |= (b & 0x7f) << shift
      if (b < 0x80) break
    }
    this.put(out ? K.out : K.in, id >>> 0, tick, ms, bytes.subarray(at))
  }

  /** the protocol's state (play, configuration): each block starts with it, the packets' ids are of it */
  protocolState (tick: number, ms: number, state: string): void {
    this.pstate = state
    // (a block begun now starts with it)
    if (!this.open) this.begin()
    else this.fields(K.pstate, tick, ms, [state])
  }

  /** a record of one of KINDS, its fields in order (the trailing ones left undefined are left out) */
  fields (kind: number, tick: number, ms: number, values: readonly unknown[]): void {
    const def = KINDS[kind]
    if (def == null) throw new Error(`no kind ${kind}`)
    if (!this.open) this.begin()
    const s = this.scratch
    s.reset()
    let n = values.length
    while (n > 0 && values[n - 1] === undefined) n--
    for (let i = 0; i < n; i++) this.field(s, def.fields[i]?.[1] ?? 'v', values[i])
    this.put(kind, -1, tick, ms, s.view())
  }

  /** a record of an event kind (task, reflex ...): `ev` one of its def's ev */
  event (kind: number, ev: string, tick: number, ms: number, values: readonly unknown[]): void {
    const index = KINDS[kind]?.ev?.indexOf(ev) ?? -1
    if (index < 0) throw new Error(`no event ${ev} of kind ${kind}`)
    // (the event's index first, then the fields: the def's fields start after it)
    this.evFields(kind, tick, ms, index, values)
  }

  private evFields (kind: number, tick: number, ms: number, index: number, values: readonly unknown[]): void {
    const def = KINDS[kind]
    if (!this.open) this.begin()
    const s = this.scratch
    s.reset()
    s.varint(index)
    let n = values.length
    while (n > 0 && values[n - 1] === undefined) n--
    for (let i = 0; i < n; i++) this.field(s, def.fields[i]?.[1] ?? 'v', values[i])
    this.put(kind, -1, tick, ms, s.view())
  }

  private str (w: ByteWriter, v: unknown): void {
    w.varint(v == null ? 0 : this.ref(String(v)) + 1)
  }

  private template (w: ByteWriter, v: unknown): void {
    if (v == null) { w.varint(0); return }
    const { template, numbers } = splitTemplate(String(v))
    w.varint(this.ref(template) + 1)
    w.varint(numbers.length)
    for (const n of numbers) w.varint(n)
  }

  private field (w: ByteWriter, type: FieldType, v: unknown): void {
    switch (type) {
      case 'u': w.varint(Math.max(0, finite(Math.round(Number(v ?? 0))))); return
      case 'i': w.zigzag(finite(Math.round(Number(v ?? 0)))); return
      case 's': this.str(w, v); return
      case 't': this.template(w, v); return
      case 'S':
      case 'T': {
        const list = Array.isArray(v) ? v : []
        w.varint(list.length)
        for (const item of list) type === 'S' ? this.str(w, item) : this.template(w, item)
        return
      }
      case 'p': {
        const p = v as any
        const xyz = p == null ? null : Array.isArray(p) ? p : [p.x, p.y, p.z]
        if (xyz == null || xyz.some((c: unknown) => typeof c !== 'number')) { w.u8(0); return }
        w.u8(1)
        for (const c of xyz) w.zigzag(milli(c))
        break
      }
      case 'v': writeValue(w, v, this.out)
    }
  }

  /** the bot's state: what changed since the block's last one */
  state (tick: number, ms: number, snap: StateSnapshot): void {
    if (!this.open) this.begin()
    const s = this.scratch
    s.reset()
    const prev = this.prev
    const next: StateInts = { ...prev, inv: prev.inv }
    let mask = 0
    const body = new ByteWriter(64)
    if (snap.pos != null) {
      next.pos = [milli(snap.pos[0]), milli(snap.pos[1]), milli(snap.pos[2])]
      if (next.pos.some((c, i) => c !== prev.pos[i])) mask |= S_POS
    }
    if (snap.vel != null) {
      next.vel = [milli(snap.vel[0]), milli(snap.vel[1]), milli(snap.vel[2])]
      if (next.vel.some((c, i) => c !== prev.vel[i])) mask |= S_VEL
    }
    next.onGround = snap.onGround
    if (next.onGround !== prev.onGround) mask |= S_GROUND
    next.health = scaled(snap.health, 100)
    if (next.health !== prev.health) mask |= S_HEALTH
    next.food = scaled(snap.food, 1)
    if (next.food !== prev.food) mask |= S_FOOD
    next.sat = scaled(snap.saturation, 10)
    if (next.sat !== prev.sat) mask |= S_SAT
    next.dim = snap.dim
    if (next.dim !== prev.dim) mask |= S_DIM
    next.held = snap.held
    if (next.held !== prev.held) mask |= S_HELD
    next.task = snap.task
    if (next.task !== prev.task) mask |= S_TASK
    next.reflex = snap.reflex
    if (next.reflex !== prev.reflex) mask |= S_REFLEX
    next.milestone = snap.milestone
    if (next.milestone !== prev.milestone) mask |= S_MILESTONE
    next.yaw = scaled(snap.yaw, 100)
    next.pitch = scaled(snap.pitch, 100)
    if (next.yaw !== prev.yaw || next.pitch !== prev.pitch) mask |= S_LOOK
    next.oxygen = scaled(snap.oxygen, 1)
    if (next.oxygen !== prev.oxygen) mask |= S_OXYGEN
    const changes: Array<[string, number]> = []
    for (const [name, n] of snap.inv) if (n !== (prev.inv.get(name) ?? 0)) changes.push([name, n - (prev.inv.get(name) ?? 0)])
    for (const [name, n] of prev.inv) if (!snap.inv.has(name)) changes.push([name, -n])
    if (changes.length > 0) {
      mask |= S_INV
      next.inv = new Map(snap.inv)
    }
    // (the fields in the mask's order; the strings' refs go to the block first)
    if ((mask & S_POS) !== 0) for (let i = 0; i < 3; i++) body.zigzag(next.pos[i] - prev.pos[i])
    if ((mask & S_VEL) !== 0) for (let i = 0; i < 3; i++) body.zigzag(next.vel[i] - prev.vel[i])
    if ((mask & S_HEALTH) !== 0) body.zigzag(next.health - prev.health)
    if ((mask & S_FOOD) !== 0) body.zigzag(next.food - prev.food)
    if ((mask & S_SAT) !== 0) body.zigzag(next.sat - prev.sat)
    if ((mask & S_DIM) !== 0) this.str(body, next.dim)
    if ((mask & S_HELD) !== 0) this.str(body, next.held)
    if ((mask & S_TASK) !== 0) this.str(body, next.task)
    if ((mask & S_REFLEX) !== 0) this.str(body, next.reflex)
    if ((mask & S_MILESTONE) !== 0) this.str(body, next.milestone)
    if ((mask & S_LOOK) !== 0) { body.zigzag(next.yaw - prev.yaw); body.zigzag(next.pitch - prev.pitch) }
    if ((mask & S_OXYGEN) !== 0) body.zigzag(next.oxygen - prev.oxygen)
    if ((mask & S_INV) !== 0) {
      body.varint(changes.length)
      for (const [name, d] of changes) { this.str(body, name); body.zigzag(d) }
    }
    s.varint(mask)
    s.bytes(body.view())
    this.prev = next
    this.put(K.state, -1, tick, ms, s.view())
  }

  /** hands the block being written over now (a flush, the end) */
  flush (): void {
    if (!this.open) return
    this.open = false
    if (this.records === 0) return
    const w = new ByteWriter(this.heads.length + this.groupBytes + 32)
    w.zigzag(this.blockTick)
    w.varint(this.blockMs)
    w.varint(this.heads.length)
    w.bytes(this.heads.view())
    for (const g of this.groups.values()) {
      const rows = g.rows.view()
      const at = w.length
      w.bytes(rows)
      if (g.count > 1 && g.length > 1) transpose(rows, w.buf.subarray(at, at + rows.length), g.count, g.length)
    }
    const raw = w.view()
    this.rawBytes += raw.length
    this.groups.clear()
    this.onBlock(raw)
  }
}

/** rows of `length` bytes (count of them) as columns: byte j of row i at j * count + i */
function transpose (rows: Uint8Array, out: Uint8Array, count: number, length: number): void {
  for (let i = 0; i < count; i++) {
    const row = i * length
    for (let j = 0; j < length; j++) out[j * count + i] = rows[row + j]
  }
}

export function encodeHeader (header: RecordingHeader): Uint8Array {
  const body = new ByteWriter(256)
  writeValue(body, header, { ref: () => null })
  const w = new ByteWriter(body.length + 16)
  w.bytes(MAGIC)
  w.u8(FORMAT_VERSION)
  w.varint(body.length)
  w.bytes(body.view())
  return w.view().slice()
}

/** the header and its size, or null when `buf` doesn't hold it all yet; throws when it isn't a recording */
export function decodeHeader (buf: Uint8Array): { header: RecordingHeader, size: number } | null {
  if (buf.length < MAGIC.length + 1) return null
  for (let i = 0; i < MAGIC.length; i++) if (buf[i] !== MAGIC[i]) throw new Error('not a recording (no MFRC magic)')
  const r = new ByteReader(buf, MAGIC.length)
  const version = r.u8()
  if (version > FORMAT_VERSION) throw new Error(`recording format ${version} is newer than this reader's ${FORMAT_VERSION}`)
  try {
    const n = r.varint()
    if (r.left < n) return null
    const header = readValue(new ByteReader(buf, r.pos, r.pos + n), []) as RecordingHeader
    return { header, size: r.pos + n }
  } catch (err) {
    if (err instanceof RangeError) return null
    throw err
  }
}

/** a block as it goes in the file */
export function frameBlock (codec: Codec, rawLength: number, data: Uint8Array): Uint8Array {
  const w = new ByteWriter(data.length + 16)
  w.u8(codec)
  w.varint(rawLength)
  w.varint(data.length)
  w.bytes(data)
  return w.view().slice()
}

/** the next block in `buf` from `pos`, or null when it isn't all there yet */
export function readFrame (buf: Uint8Array, pos: number): { codec: Codec, rawLength: number, data: Uint8Array, next: number } | null {
  try {
    const r = new ByteReader(buf, pos)
    const codec = r.u8() as Codec
    const rawLength = r.varint()
    const n = r.varint()
    if (r.left < n) return null
    const data = r.bytes(n)
    return { codec, rawLength, data, next: r.pos }
  } catch (err) {
    if (err instanceof RangeError) return null
    throw err
  }
}

// --- reading ---

/** a record as read back: its tick, ms since the start, kind (`k`) and fields */
export interface RecEvent {
  t: number
  ms: number
  k: string
  [field: string]: unknown
}

/** a packet as read back */
export interface PacketEvent extends RecEvent {
  k: 'in' | 'out'
  id: number
  /** the packet's name (when the reader knows the version's ids) */
  name?: string
  /** its length on the wire */
  bytes: number
  /** the wire bytes (none for a summary) */
  raw?: Uint8Array
  summary?: true
  x?: number
  z?: number
  /** the protocol's state it came in (its ids are that state's) */
  state: string | null
}

/** a packet's name from its id: the version's (minecraft-data's protocol, the reader's to give) */
export type PacketNamer = (state: string | null, out: boolean, id: number) => string | undefined

/** decodes blocks' raw bytes into events */
export class BlockDecoder {
  constructor (private readonly namer?: PacketNamer) {}

  decode (raw: Uint8Array, emit: (e: RecEvent) => void): void {
    const r = new ByteReader(raw)
    let tick = r.zigzag()
    let ms = r.varint()
    const headsEnd = r.varint() + r.pos
    // the heads first: what each record is, and its place in its group
    const heads: Array<Head | string> = []
    const groups: Array<{ length: number, count: number, offset: number }> = []
    const keys = new Map<number, number>()
    const h = new ByteReader(raw, r.pos, headsEnd)
    while (h.left > 0) {
      const kind = h.u8()
      if (kind === K.str) { heads.push(h.str()); continue }
      const id = kind === K.in || kind === K.out ? h.varint() : -1
      tick += h.zigzag()
      ms += h.varint()
      const length = h.varint()
      const key = groupKey(kind, id, length)
      let group = keys.get(key)
      if (group == null) {
        group = groups.length
        keys.set(key, group)
        groups.push({ length, count: 0, offset: 0 })
      }
      heads.push({ kind, id, tick, ms, group, index: groups[group].count++ })
    }
    let offset = headsEnd
    for (const g of groups) {
      g.offset = offset
      offset += g.length * g.count
    }
    if (offset > raw.length) throw new RangeError('a block cut short')
    // (a record's payload from its group, after `before`: a packet's id)
    const payload = (head: Head, before: Uint8Array | null): Uint8Array => {
      const g = groups[head.group]
      const pre = before?.length ?? 0
      const out = new Uint8Array(pre + g.length)
      if (before != null) out.set(before, 0)
      if (g.count === 1 || g.length <= 1) out.set(raw.subarray(g.offset + head.index * g.length, g.offset + (head.index + 1) * g.length), pre)
      else for (let j = 0; j < g.length; j++) out[pre + j] = raw[g.offset + j * g.count + head.index]
      return out
    }
    const strings: string[] = []
    let pstate: string | null = null
    const prev = blankState()
    const idBytes = new ByteWriter(8)
    for (const head of heads) {
      if (typeof head === 'string') { strings.push(head); continue }
      const { kind, tick: t, ms: m } = head
      if (kind === K.in || kind === K.out) {
        // (the wire bytes again: the id's varint, then the payload)
        idBytes.reset()
        idBytes.varint(head.id)
        const bytes = payload(head, idBytes.view())
        const e: PacketEvent = { t, ms: m, k: kind === K.out ? 'out' : 'in', id: head.id, bytes: bytes.length, raw: bytes, state: pstate }
        const name = this.namer?.(pstate, kind === K.out, head.id)
        if (name != null) e.name = name
        emit(e)
        continue
      }
      const p = new ByteReader(payload(head, null))
      if (kind === K.state) { emit({ t, ms: m, k: 'state', ...readState(p, strings, prev) }); continue }
      const def = KINDS[kind]
      if (def == null) continue
      const e: RecEvent = { t, ms: m, k: def.name }
      if (def.ev != null) e.ev = def.ev[p.varint()] ?? 'unknown'
      for (const [name, type] of def.fields) {
        if (p.left <= 0) break
        e[name] = readField(p, type, strings)
      }
      if (kind === K.pstate) pstate = e.state as string
      if (kind === K.inSummary || kind === K.outSummary) {
        e.summary = true
        e.state = pstate
        const name = this.namer?.(pstate, kind === K.outSummary, e.id as number)
        if (name != null) e.name = name
      }
      emit(e)
    }
  }
}

/** a record's head as the decoder reads it: its kind, packet id, times, and its group and place in it */
interface Head { kind: number, id: number, tick: number, ms: number, group: number, index: number }

function readStr (r: ByteReader, strings: readonly string[]): string | null {
  const ref = r.varint()
  return ref === 0 ? null : strings[ref - 1] ?? null
}

function readTemplate (r: ByteReader, strings: readonly string[]): string | null {
  const ref = r.varint()
  if (ref === 0) return null
  const count = r.varint()
  const numbers: number[] = []
  for (let i = 0; i < count; i++) numbers.push(r.varint())
  return joinTemplate(strings[ref - 1] ?? '', numbers)
}

function readField (r: ByteReader, type: FieldType, strings: readonly string[]): unknown {
  switch (type) {
    case 'u': return r.varint()
    case 'i': return r.zigzag()
    case 's': return readStr(r, strings)
    case 't': return readTemplate(r, strings)
    case 'S':
    case 'T': {
      const n = r.varint()
      const out: Array<string | null> = []
      for (let i = 0; i < n; i++) out.push(type === 'S' ? readStr(r, strings) : readTemplate(r, strings))
      return out
    }
    case 'p': {
      if (r.u8() === 0) return null
      return [r.zigzag() / 1000, r.zigzag() / 1000, r.zigzag() / 1000]
    }
    case 'v': return readValue(r, strings)
  }
}

function readState (r: ByteReader, strings: readonly string[], prev: StateInts): Record<string, unknown> {
  const mask = r.varint()
  if ((mask & S_POS) !== 0) for (let i = 0; i < 3; i++) prev.pos[i] += r.zigzag()
  if ((mask & S_VEL) !== 0) for (let i = 0; i < 3; i++) prev.vel[i] += r.zigzag()
  if ((mask & S_GROUND) !== 0) prev.onGround = !prev.onGround
  if ((mask & S_HEALTH) !== 0) prev.health += r.zigzag()
  if ((mask & S_FOOD) !== 0) prev.food += r.zigzag()
  if ((mask & S_SAT) !== 0) prev.sat += r.zigzag()
  if ((mask & S_DIM) !== 0) prev.dim = readStr(r, strings)
  if ((mask & S_HELD) !== 0) prev.held = readStr(r, strings)
  if ((mask & S_TASK) !== 0) prev.task = readStr(r, strings)
  if ((mask & S_REFLEX) !== 0) prev.reflex = readStr(r, strings)
  if ((mask & S_MILESTONE) !== 0) prev.milestone = readStr(r, strings)
  if ((mask & S_LOOK) !== 0) { prev.yaw += r.zigzag(); prev.pitch += r.zigzag() }
  if ((mask & S_OXYGEN) !== 0) prev.oxygen += r.zigzag()
  const dinv: Record<string, number> = {}
  if ((mask & S_INV) !== 0) {
    const n = r.varint()
    for (let i = 0; i < n; i++) {
      const name = readStr(r, strings) ?? '?'
      const d = r.zigzag()
      dinv[name] = d
      const count = (prev.inv.get(name) ?? 0) + d
      if (count === 0) prev.inv.delete(name)
      else prev.inv.set(name, count)
    }
  }
  return {
    pos: prev.pos.map(c => c / 1000),
    vel: prev.vel.map(c => c / 1000),
    onGround: prev.onGround,
    health: prev.health / 100,
    food: prev.food,
    saturation: prev.sat / 10,
    dim: prev.dim,
    held: prev.held,
    task: prev.task,
    reflex: prev.reflex,
    milestone: prev.milestone,
    yaw: prev.yaw / 100,
    pitch: prev.pitch / 100,
    oxygen: prev.oxygen,
    inv: Object.fromEntries(prev.inv),
    ...(Object.keys(dinv).length > 0 ? { dinv } : {})
  }
}
