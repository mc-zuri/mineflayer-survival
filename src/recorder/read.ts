// A recording read back in Node, a block at a time (a file of any size: only a block is held): its header, then its
// events. The packets' names are the version's (minecraft-data's protocol for the header's mcVersion), and their
// fields decoded on request with minecraft-protocol's deserializer for it, as the client parsed them.
import * as fs from 'node:fs'
import { BlockDecoder, codecOf, decodeHeader, frameBlock, readFrame, type CodecName, type PacketEvent, type PacketNamer, type RecEvent, type RecordingHeader } from './format'
import { compressSync, decompressSync } from './fileSink'

/** the packet names of a version, by protocol state and direction, from minecraft-data (null when it has none) */
export function packetNamer (version: string | null): PacketNamer | undefined {
  if (version == null) return undefined
  let data: any
  try {
    // (minecraft-data's versions loaded on demand, as minecraft-protocol has them)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    data = require('minecraft-data')(version)
  } catch {
    return undefined
  }
  if (data?.protocol == null) return undefined
  const tables = new Map<string, Map<number, string>>()
  const table = (state: string, out: boolean): Map<number, string> => {
    const key = `${state}:${String(out)}`
    let t = tables.get(key)
    if (t == null) {
      t = new Map()
      const mappings = data.protocol[state]?.[out ? 'toServer' : 'toClient']?.types?.packet?.[1]?.[0]?.type?.[1]?.mappings ?? {}
      for (const [id, name] of Object.entries(mappings)) t.set(Number(id), name as string)
      tables.set(key, t)
    }
    return t
  }
  return (state, out, id) => table(state ?? 'play', out).get(id)
}

/** decodes packets' fields: minecraft-protocol's deserializer for the version, by state and direction */
export function packetParser (version: string | null): ((e: PacketEvent) => unknown) | null {
  if (version == null) return null
  let createDeserializer: any
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    createDeserializer = require('minecraft-protocol/src/transforms/serializer').createDeserializer
  } catch {
    return null
  }
  const parsers = new Map<string, any>()
  return (e) => {
    if (e.raw == null) return undefined
    const state = e.state ?? 'play'
    const key = `${state}:${e.k}`
    let p = parsers.get(key)
    if (p == null) {
      // (the bot's packets out are the server's to read: isServer)
      p = createDeserializer({ state, isServer: e.k === 'out', version, noErrorLogging: true })
      parsers.set(key, p)
    }
    try {
      return p.parsePacketBuffer(Buffer.from(e.raw)).data.params
    } catch (err) {
      return { error: (err as Error).message }
    }
  }
}

export interface ReadStats {
  bytes: number
  blocks: number
  rawBytes: number
  /** a last block cut short (a run killed while writing it) */
  truncated: boolean
}

/**
 * Reads a recording a block at a time: `onHeader` with its header first, then `onEvent` with each event. Resolves
 * with what it read.
 */
export async function readRecording (file: string, onEvent: (e: RecEvent) => void, onHeader?: (h: RecordingHeader) => void): Promise<ReadStats> {
  const stats: ReadStats = { bytes: 0, blocks: 0, rawBytes: 0, truncated: false }
  let buf = new Uint8Array(0)
  let header: RecordingHeader | null = null
  let decoder: BlockDecoder | null = null
  const stream = fs.createReadStream(file, { highWaterMark: 1 << 20 })
  for await (const chunk of stream) {
    const c = chunk as Buffer
    stats.bytes += c.length
    const next = new Uint8Array(buf.length + c.length)
    next.set(buf, 0)
    next.set(c, buf.length)
    buf = next
    let pos = 0
    if (header == null) {
      const h = decodeHeader(buf)
      if (h == null) continue
      header = h.header
      pos = h.size
      decoder = new BlockDecoder(packetNamer(header.mcVersion))
      onHeader?.(header)
    }
    for (;;) {
      const frame = readFrame(buf, pos)
      if (frame == null) break
      const raw = decompressSync(frame.codec, frame.data)
      stats.blocks++
      stats.rawBytes += raw.length
      decoder?.decode(raw, onEvent)
      pos = frame.next
    }
    buf = buf.slice(pos)
  }
  if (header == null) throw new Error(`${file}: not a recording, or empty`)
  stats.truncated = buf.length > 0
  return stats
}

/**
 * A recording written again with another codec, block by block (the browser's deflate-raw as zstd 19 or brotli 11:
 * a fifth smaller, for keeping); resolves with the new file's bytes
 */
export async function recompress (file: string, out: string, codec: CodecName, level?: number): Promise<number> {
  const target = codecOf(codec)
  const fd = fs.openSync(out, 'w')
  let written = 0
  const write = (b: Uint8Array): void => { fs.writeSync(fd, b); written += b.length }
  try {
    let buf = new Uint8Array(0)
    let header = false
    for await (const chunk of fs.createReadStream(file, { highWaterMark: 1 << 20 })) {
      const c = chunk as Buffer
      const next = new Uint8Array(buf.length + c.length)
      next.set(buf, 0)
      next.set(c, buf.length)
      buf = next
      let pos = 0
      if (!header) {
        const h = decodeHeader(buf)
        if (h == null) continue
        write(buf.subarray(0, h.size))
        header = true
        pos = h.size
      }
      for (let f = readFrame(buf, pos); f != null; f = readFrame(buf, pos)) {
        const raw = decompressSync(f.codec, f.data)
        write(frameBlock(target, raw.length, compressSync(target, raw, level)))
        pos = f.next
      }
      buf = buf.slice(pos)
    }
    if (!header) throw new Error(`${file}: not a recording, or empty`)
  } finally {
    fs.closeSync(fd)
  }
  return written
}
