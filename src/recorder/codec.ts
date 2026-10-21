// The recording's bytes: varints (the protocol's VarInt, 7 bits a byte, low first, for any safe integer), zigzag for
// the signed ones (protobuf's: 0, -1, 1, -2 ... as 0, 1, 2, 3), utf8 strings with their length first, and a tagged
// value for the few decisions whose data has no fixed shape (a plan's requests, a note's data). Uint8Array only, no
// Buffer: the browser bundle writes recordings too.

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** zigzag: a signed safe integer as an unsigned one, small either side of 0 small */
export function zigzag (n: number): number {
  return n >= 0 ? n * 2 : -n * 2 - 1
}

export function unzigzag (n: number): number {
  return n % 2 === 0 ? n / 2 : -(n + 1) / 2
}

/** a growing byte buffer */
export class ByteWriter {
  buf: Uint8Array
  length = 0

  constructor (size = 1024) {
    this.buf = new Uint8Array(size)
  }

  private room (n: number): void {
    if (this.length + n <= this.buf.length) return
    let size = this.buf.length * 2
    while (size < this.length + n) size *= 2
    const next = new Uint8Array(size)
    next.set(this.buf.subarray(0, this.length))
    this.buf = next
  }

  u8 (n: number): void {
    this.room(1)
    this.buf[this.length++] = n & 0xff
  }

  /** an unsigned integer up to 2^53 */
  varint (n: number): void {
    this.room(8)
    if (n < 0x80000000) {
      while (n >= 0x80) {
        this.buf[this.length++] = (n & 0x7f) | 0x80
        n >>>= 7
      }
      this.buf[this.length++] = n
      return
    }
    while (n >= 0x80) {
      this.buf[this.length++] = (n % 128) | 0x80
      n = Math.floor(n / 128)
    }
    this.buf[this.length++] = n
  }

  zigzag (n: number): void {
    this.varint(zigzag(n))
  }

  bytes (b: Uint8Array): void {
    this.room(b.length)
    this.buf.set(b, this.length)
    this.length += b.length
  }

  /** utf8 with its byte length first */
  str (s: string): void {
    // (at most 3 bytes a UTF-16 unit)
    this.room(5 + s.length * 3)
    const at = this.length
    // the length's varint takes 1 byte for short strings: written after, the bytes moved when it takes more
    const { written } = encoder.encodeInto(s, this.buf.subarray(at + 1))
    if (written < 0x80) {
      this.buf[at] = written
      this.length = at + 1 + written
      return
    }
    const copy = this.buf.slice(at + 1, at + 1 + written)
    this.length = at
    this.varint(written)
    this.bytes(copy)
  }

  f32 (n: number): void {
    this.room(4)
    new DataView(this.buf.buffer, this.buf.byteOffset).setFloat32(this.length, n, true)
    this.length += 4
  }

  f64 (n: number): void {
    this.room(8)
    new DataView(this.buf.buffer, this.buf.byteOffset).setFloat64(this.length, n, true)
    this.length += 8
  }

  /** the bytes written (a view: copy it before writing more) */
  view (): Uint8Array {
    return this.buf.subarray(0, this.length)
  }

  reset (): void {
    this.length = 0
  }
}

export class ByteReader {
  pos: number
  constructor (readonly buf: Uint8Array, pos = 0, readonly end = buf.length) {
    this.pos = pos
  }

  get left (): number {
    return this.end - this.pos
  }

  u8 (): number {
    if (this.pos >= this.end) throw new RangeError('read past the end')
    return this.buf[this.pos++]
  }

  varint (): number {
    let n = 0
    let scale = 1
    for (;;) {
      const b = this.u8()
      n += (b & 0x7f) * scale
      if (b < 0x80) return n
      scale *= 128
      if (scale > 2 ** 56) throw new RangeError('varint too long')
    }
  }

  zigzag (): number {
    return unzigzag(this.varint())
  }

  bytes (n: number): Uint8Array {
    if (this.pos + n > this.end) throw new RangeError('read past the end')
    const out = this.buf.subarray(this.pos, this.pos + n)
    this.pos += n
    return out
  }

  str (): string {
    return decoder.decode(this.bytes(this.varint()))
  }

  f32 (): number {
    const v = new DataView(this.buf.buffer, this.buf.byteOffset).getFloat32(this.bytesAt(4), true)
    return v
  }

  f64 (): number {
    return new DataView(this.buf.buffer, this.buf.byteOffset).getFloat64(this.bytesAt(8), true)
  }

  private bytesAt (n: number): number {
    if (this.pos + n > this.end) throw new RangeError('read past the end')
    const at = this.pos
    this.pos += n
    return at
  }
}

export function utf8 (s: string): Uint8Array {
  return encoder.encode(s)
}

export function fromUtf8 (b: Uint8Array): string {
  return decoder.decode(b)
}

// --- strings with numbers in them (the play log's lines, the errors' messages) ---

/** a number in a templated string: the placeholder that stands for it */
export const NUMBER_MARK = '\u0000'

/** the most digits a number in a string is taken out with (a seed's 19 are left in the text) */
const MAX_DIGITS = 14

/**
 * A line as its template and its numbers: "milestone wood reached at tick 1234 (5.2 s)" as "milestone wood reached at
 * tick \0 (\0 s)" and [1234, 5.2], so the template is the same for every line of its kind (interned once a block) and
 * each number takes a varint. Each number is packed with its decimals (value * 8 + decimals, zigzagged), so the line
 * comes back as it was, "5.20" with its 0. A number with a leading 0 ("007"), "-0" or too many digits stays in the
 * template; a line with the placeholder in it has none taken out.
 */
export function splitTemplate (line: string): { template: string, numbers: number[] } {
  const numbers: number[] = []
  if (line.includes(NUMBER_MARK)) return { template: line, numbers }
  const template = line.replace(/-?\d+(?:\.\d+)?/g, (token) => {
    const negative = token.startsWith('-')
    const body = negative ? token.slice(1) : token
    const dot = body.indexOf('.')
    const int = dot < 0 ? body : body.slice(0, dot)
    const frac = dot < 0 ? '' : body.slice(dot + 1)
    if ((int.length > 1 && int.startsWith('0')) || int.length + frac.length > MAX_DIGITS || frac.length > 7) return token
    const digits = Number(int + frac)
    if (negative && digits === 0) return token
    numbers.push(zigzag(negative ? -digits : digits) * 8 + frac.length)
    return NUMBER_MARK
  })
  return { template, numbers }
}

/** the line back from its template and numbers */
export function joinTemplate (template: string, numbers: readonly number[]): string {
  if (numbers.length === 0) return template
  const parts = template.split(NUMBER_MARK)
  let out = parts[0]
  for (let i = 1; i < parts.length; i++) {
    const packed = numbers[i - 1]
    if (packed == null) {
      out += NUMBER_MARK + parts[i]
      continue
    }
    const decimals = packed % 8
    const value = unzigzag((packed - decimals) / 8)
    const digits = String(Math.abs(value)).padStart(decimals + 1, '0')
    const text = decimals === 0 ? digits : `${digits.slice(0, digits.length - decimals)}.${digits.slice(digits.length - decimals)}`
    out += (value < 0 ? `-${text}` : text) + parts[i]
  }
  return out
}

// --- values of no fixed shape ---

/** the tags of a tagged value */
export enum Tag { Null = 0, False = 1, True = 2, Int = 3, F32 = 4, F64 = 5, Str = 6, Arr = 7, Obj = 8, Bytes = 9, Elided = 10, Big = 11, Inline = 12 }

/** how strings go: interned (a ref, the block's table) or inline (the header's) */
export interface StringOut {
  /** writes the string's ref, or null to write it inline */
  ref: (s: string) => number | null
}

export interface ValueOptions {
  /** byte arrays longer than this are kept as their length only (default 64) */
  maxBytes?: number
  /** the deepest nesting kept (default 6) */
  maxDepth?: number
  /** the most items of an array or keys of an object kept (default 256) */
  maxItems?: number
}

/**
 * A value of no fixed shape: null, booleans, safe integers as zigzag varints, other numbers as f32 when exact, else
 * f64, strings (interned when `out` interns), arrays, plain objects (and any object by its own enumerable keys: a Vec3
 * is {x, y, z}), byte arrays up to maxBytes (longer ones their length), bigints as their digits, a Map as an object, a
 * Set as an array, an Error as {name, message, code}. Functions and symbols are null; deeper than maxDepth, '…'.
 */
export function writeValue (w: ByteWriter, v: unknown, out: StringOut, opts: ValueOptions = {}, depth = 0): void {
  const str = (s: string): void => {
    const ref = out.ref(s)
    if (ref == null) {
      w.u8(Tag.Inline)
      w.str(s)
    } else {
      w.u8(Tag.Str)
      w.varint(ref)
    }
  }
  if (v == null || typeof v === 'function' || typeof v === 'symbol') { w.u8(Tag.Null); return }
  if (v === false) { w.u8(Tag.False); return }
  if (v === true) { w.u8(Tag.True); return }
  if (typeof v === 'number') {
    if (Number.isSafeInteger(v) && !Object.is(v, -0)) {
      w.u8(Tag.Int)
      w.zigzag(v)
    } else if (Math.fround(v) === v || Number.isNaN(v)) {
      w.u8(Tag.F32)
      w.f32(v)
    } else {
      w.u8(Tag.F64)
      w.f64(v)
    }
    return
  }
  if (typeof v === 'string') { str(v); return }
  if (typeof v === 'bigint') {
    w.u8(Tag.Big)
    w.str(v.toString())
    return
  }
  const maxDepth = opts.maxDepth ?? 6
  const maxItems = opts.maxItems ?? 256
  if (v instanceof Uint8Array || v instanceof ArrayBuffer) {
    const b = v instanceof ArrayBuffer ? new Uint8Array(v) : v
    if (b.length > (opts.maxBytes ?? 64)) {
      w.u8(Tag.Elided)
      w.varint(b.length)
    } else {
      w.u8(Tag.Bytes)
      w.varint(b.length)
      w.bytes(b)
    }
    return
  }
  if (depth >= maxDepth) { str('…'); return }
  if (Array.isArray(v) || v instanceof Set) {
    const items = [...v].slice(0, maxItems)
    w.u8(Tag.Arr)
    w.varint(items.length)
    for (const item of items) writeValue(w, item, out, opts, depth + 1)
    return
  }
  if (v instanceof Date) { str(v.toISOString()); return }
  let entries: Array<[string, unknown]>
  if (v instanceof Map) entries = [...v].map(([k, x]) => [String(k), x])
  else if (v instanceof Error) entries = [['name', v.name], ['message', v.message], ...((v as any).code != null ? [['code', (v as any).code]] as Array<[string, unknown]> : [])]
  else entries = Object.entries(v as object)
  entries = entries.filter(([, x]) => x !== undefined && typeof x !== 'function').slice(0, maxItems)
  w.u8(Tag.Obj)
  w.varint(entries.length)
  for (const [k, x] of entries) {
    // (a key: its ref + 1, or 0 and the string inline)
    const ref = out.ref(k)
    if (ref == null) {
      w.u8(0)
      w.str(k)
    } else {
      w.varint(ref + 1)
    }
    writeValue(w, x, out, opts, depth + 1)
  }
}

/** a byte array kept as its length only */
export interface ElidedBytes { bytes: number }

export function readValue (r: ByteReader, strings: readonly string[]): unknown {
  const tag = r.u8()
  switch (tag) {
    case Tag.Null: return null
    case Tag.False: return false
    case Tag.True: return true
    case Tag.Int: return r.zigzag()
    case Tag.F32: return r.f32()
    case Tag.F64: return r.f64()
    case Tag.Str: return strings[r.varint()]
    case Tag.Inline: return r.str()
    case Tag.Big: return BigInt(r.str())
    case Tag.Bytes: return r.bytes(r.varint()).slice()
    case Tag.Elided: return { bytes: r.varint() } satisfies ElidedBytes
    case Tag.Arr: {
      const n = r.varint()
      const out: unknown[] = []
      for (let i = 0; i < n; i++) out.push(readValue(r, strings))
      return out
    }
    case Tag.Obj: {
      const n = r.varint()
      const out: Record<string, unknown> = {}
      for (let i = 0; i < n; i++) {
        const k = readKey(r, strings)
        out[k] = readValue(r, strings)
      }
      return out
    }
    default: throw new RangeError(`unknown value tag ${tag}`)
  }
}

function readKey (r: ByteReader, strings: readonly string[]): string {
  const k = r.varint()
  return k === 0 ? r.str() : strings[k - 1]
}
