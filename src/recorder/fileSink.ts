// The Node sink: the blocks compressed on zlib's thread pool (zstd where Node has it, 22.15 and up, else brotli) and
// written to the file in order; on the process's exit, what's left is compressed and written synchronously. node:zlib
// and node:fs are only touched when a FileSink is made, so the browser bundle (whose zlib has neither brotli nor zstd)
// takes this module in unused.
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as zlib from 'node:zlib'
import { Codec, codecOf, frameBlock, type CodecName } from './format'
import type { RecordingSink } from './sink'

export interface FileSinkOptions {
  /** the codec (default: zstd when this Node has it, else brotli) */
  codec?: CodecName
  /** its level (default: zstd 19, brotli 9, deflate 9) */
  level?: number
}

/** the best codec this Node has: zstd (Node 22.15+), else brotli */
export function nodeCodec (): CodecName {
  return typeof (zlib as any).zstdCompress === 'function' ? 'zstd' : 'brotli'
}

function zlibOptions (codec: Codec, level: number | undefined, size: number): any {
  const z = zlib.constants as any
  switch (codec) {
    case Codec.Zstd: return { params: { [z.ZSTD_c_compressionLevel]: level ?? 19 } }
    case Codec.Brotli: return { params: { [z.BROTLI_PARAM_QUALITY]: level ?? 9, [z.BROTLI_PARAM_SIZE_HINT]: size, [z.BROTLI_PARAM_LGWIN]: 22 } }
    default: return { level: level ?? 9 }
  }
}

export function compressSync (codec: Codec, raw: Uint8Array, level?: number): Uint8Array {
  const o = zlibOptions(codec, level, raw.length)
  switch (codec) {
    case Codec.None: return raw
    case Codec.DeflateRaw: return zlib.deflateRawSync(raw, o)
    case Codec.Brotli: return zlib.brotliCompressSync(raw, o)
    case Codec.Zstd: return (zlib as any).zstdCompressSync(raw, o)
  }
}

export async function compress (codec: Codec, raw: Uint8Array, level?: number): Promise<Uint8Array> {
  const o = zlibOptions(codec, level, raw.length)
  const run = async (fn: (buf: Uint8Array, o: any, cb: (err: Error | null, out: Buffer) => void) => void): Promise<Uint8Array> =>
    await new Promise((resolve, reject) => fn(raw, o, (err, out) => err != null ? reject(err) : resolve(out)))
  switch (codec) {
    case Codec.None: return raw
    case Codec.DeflateRaw: return await run(zlib.deflateRaw as any)
    case Codec.Brotli: return await run(zlib.brotliCompress as any)
    case Codec.Zstd: return await run((zlib as any).zstdCompress)
  }
}

export function decompressSync (codec: Codec, data: Uint8Array): Uint8Array {
  switch (codec) {
    case Codec.None: return data
    case Codec.DeflateRaw: return zlib.inflateRawSync(data)
    case Codec.Brotli: return zlib.brotliDecompressSync(data)
    case Codec.Zstd:
      if (typeof (zlib as any).zstdDecompressSync !== 'function') throw new Error('this recording is zstd: Node 22.15 or later reads it')
      return (zlib as any).zstdDecompressSync(data)
    default: throw new Error(`unknown codec ${String(codec)}`)
  }
}

interface Pending {
  raw: Uint8Array
  framed: Uint8Array | null
}

/** the recording to a file */
export class FileSink implements RecordingSink {
  readonly codec: Codec
  private readonly level: number | undefined
  private fd: number | null
  private readonly queue: Pending[] = []
  private working = false
  private written = 0
  private readonly idle: Array<() => void> = []
  /** a block's compression or write that failed (the rest are still written) */
  error: Error | null = null

  constructor (readonly file: string, opts: FileSinkOptions = {}) {
    this.codec = codecOf(opts.codec ?? nodeCodec())
    this.level = opts.level
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
    this.fd = fs.openSync(file, 'w')
  }

  get bytes (): number {
    return this.written
  }

  private write (bytes: Uint8Array): void {
    if (this.fd == null) return
    fs.writeSync(this.fd, bytes)
    this.written += bytes.length
  }

  header (bytes: Uint8Array): void {
    this.write(bytes)
  }

  block (raw: Uint8Array): void {
    this.queue.push({ raw, framed: null })
    if (!this.working) void this.work()
  }

  private async work (): Promise<void> {
    this.working = true
    while (this.queue.length > 0 && this.fd != null) {
      const p = this.queue[0]
      try {
        p.framed ??= frameBlock(this.codec, p.raw.length, await compress(this.codec, p.raw, this.level))
      } catch (err) {
        this.error = err as Error
        p.framed = frameBlock(Codec.None, p.raw.length, p.raw)
      }
      // (endSync may have written it meanwhile)
      if (this.queue[0] !== p) continue
      this.queue.shift()
      try { this.write(p.framed) } catch (err) { this.error = err as Error }
    }
    this.working = false
    for (const cb of this.idle.splice(0)) cb()
  }

  async end (): Promise<void> {
    if (this.working) await new Promise<void>(resolve => this.idle.push(resolve))
    if (this.queue.length > 0) await this.work()
    this.close()
  }

  endSync (raw: Uint8Array | null): void {
    if (raw != null) this.queue.push({ raw, framed: null })
    for (const p of this.queue.splice(0)) {
      try {
        this.write(p.framed ?? frameBlock(this.codec, p.raw.length, compressSync(this.codec, p.raw, this.level)))
      } catch (err) { this.error = err as Error }
    }
    this.close()
  }

  private close (): void {
    if (this.fd == null) return
    try { fs.closeSync(this.fd) } catch {}
    this.fd = null
  }
}
