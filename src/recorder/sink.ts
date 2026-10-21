// Where a recording's blocks go. The browser's: compressed with CompressionStream (deflate-raw, the best it has) and
// kept in memory, the last maxBytes of them at most (a ring of blocks: each block reads on its own), for a Blob to
// download. The Node one (fileSink.ts) writes them to a file.
import { Codec, frameBlock } from './format'

export interface RecordingSink {
  /** the file's header, before any block */
  header: (bytes: Uint8Array) => void
  /** a block's raw records, to be compressed and kept */
  block: (raw: Uint8Array) => void
  /** resolves once every block given is compressed and kept (written, or held) and the sink is closed */
  end: () => Promise<void>
  /** compresses and writes the blocks given and `raw` now, synchronously (the process exiting), when it can */
  endSync?: (raw: Uint8Array | null) => void
  /** the compressed bytes kept so far */
  readonly bytes: number
}

export interface MemorySinkOptions {
  /** the most bytes of blocks kept: the oldest blocks are dropped past it (default 64 MiB; Infinity for all) */
  maxBytes?: number
}

/** a block's bytes compressed with the platform's CompressionStream, none when it has none */
async function deflateRaw (raw: Uint8Array): Promise<{ codec: Codec, data: Uint8Array }> {
  const CS = (globalThis as any).CompressionStream
  if (typeof CS !== 'function') return { codec: Codec.None, data: raw }
  const stream = new Blob([raw as BlobPart]).stream().pipeThrough(new CS('deflate-raw'))
  return { codec: Codec.DeflateRaw, data: new Uint8Array(await new Response(stream).arrayBuffer()) }
}

/** the recording in memory (the browser's sink): blob() for the download */
export class MemorySink implements RecordingSink {
  private head: Uint8Array = new Uint8Array(0)
  private readonly blocks: Uint8Array[] = []
  private kept = 0
  /** the blocks dropped for room */
  dropped = 0
  private chain: Promise<void> = Promise.resolve()
  private readonly maxBytes: number

  constructor (opts: MemorySinkOptions = {}) {
    this.maxBytes = opts.maxBytes ?? 64 * 1024 * 1024
  }

  get bytes (): number {
    return this.head.length + this.kept
  }

  header (bytes: Uint8Array): void {
    this.head = bytes
  }

  block (raw: Uint8Array): void {
    // (one at a time, in order)
    this.chain = this.chain.then(async () => {
      const { codec, data } = await deflateRaw(raw)
      this.keep(frameBlock(codec, raw.length, data))
    }).catch(() => {
      this.keep(frameBlock(Codec.None, raw.length, raw))
    })
  }

  private keep (framed: Uint8Array): void {
    this.blocks.push(framed)
    this.kept += framed.length
    while (this.kept > this.maxBytes && this.blocks.length > 1) {
      this.kept -= (this.blocks.shift() as Uint8Array).length
      this.dropped++
    }
  }

  /** every block given compressed and kept */
  async settled (): Promise<void> {
    await this.chain
  }

  async end (): Promise<void> {
    await this.chain
  }

  /** the recording so far, the header and the blocks kept, as one array */
  async data (): Promise<Uint8Array> {
    await this.chain
    const out = new Uint8Array(this.bytes)
    out.set(this.head, 0)
    let at = this.head.length
    for (const b of this.blocks) { out.set(b, at); at += b.length }
    return out
  }

  /** the recording so far as a Blob, for a download */
  async blob (): Promise<Blob> {
    await this.chain
    return new Blob([this.head, ...this.blocks] as BlobPart[], { type: 'application/octet-stream' })
  }
}
