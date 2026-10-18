// The lockstep:v1 custom payload (server-mod/src/main/java/mineflayer/lockstep/LockstepPayload.java): a kind byte, then
// a VarInt (FriendlyByteBuf.writeVarInt).

export const CHANNEL = 'lockstep:v1'
export const PROTOCOL_VERSION = 1

export const KIND = { hello: 0, tick: 1, ack: 2 } as const

export type LockstepMessage =
  | { type: 'hello', version: number }
  | { type: 'tick', tick: number }
  | { type: 'ack', tick: number }

/** VarInt.write: 7 bits a byte, low first; a negative int takes 5 bytes (its 32-bit two's complement) */
export function writeVarInt (value: number): Buffer {
  const bytes: number[] = []
  let v = value >>> 0
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80)
    v >>>= 7
  }
  bytes.push(v)
  return Buffer.from(bytes)
}

/** VarInt.read: the value and the bytes it took; throws on a VarInt longer than 5 bytes or cut short */
export function readVarInt (buf: Buffer, offset = 0): { value: number, size: number } {
  let value = 0
  for (let i = 0; i < 5; i++) {
    if (offset + i >= buf.length) throw new RangeError('lockstep payload: VarInt cut short')
    const b = buf[offset + i]
    value |= (b & 0x7f) << (7 * i)
    if ((b & 0x80) === 0) return { value: value | 0, size: i + 1 }
  }
  throw new RangeError('lockstep payload: VarInt too big')
}

export function encode (message: LockstepMessage): Buffer {
  const value = message.type === 'hello' ? message.version : message.tick
  return Buffer.concat([Buffer.from([KIND[message.type]]), writeVarInt(value)])
}

/** The message, or null for a kind this client does not know (a newer server's); throws on a malformed payload */
export function decode (data: Buffer): LockstepMessage | null {
  if (data.length < 2) throw new RangeError(`lockstep payload: ${data.length} bytes`)
  const { value } = readVarInt(data, 1)
  switch (data[0]) {
    case KIND.hello: return { type: 'hello', version: value }
    case KIND.tick: return { type: 'tick', tick: value }
    case KIND.ack: return { type: 'ack', tick: value }
    default: return null
  }
}
