import { test } from 'node:test'
import assert from 'node:assert'
import { CHANNEL, PROTOCOL_VERSION, decode, encode, readVarInt, writeVarInt } from '../../src/lockstep/protocol'

test('the channel is lockstep:v1, protocol version 1', () => {
  assert.strictEqual(CHANNEL, 'lockstep:v1')
  assert.strictEqual(PROTOCOL_VERSION, 1)
})

test('VarInt as FriendlyByteBuf.writeVarInt: 7 bits a byte, low first, a negative int in 5 bytes', () => {
  const cases: Array<[number, number[]]> = [
    [0, [0x00]],
    [1, [0x01]],
    [127, [0x7f]],
    [128, [0x80, 0x01]],
    [300, [0xac, 0x02]],
    [25565, [0xdd, 0xc7, 0x01]],
    [2147483647, [0xff, 0xff, 0xff, 0xff, 0x07]],
    [-1, [0xff, 0xff, 0xff, 0xff, 0x0f]],
    [-2147483648, [0x80, 0x80, 0x80, 0x80, 0x08]]
  ]
  for (const [value, bytes] of cases) {
    assert.deepStrictEqual([...writeVarInt(value)], bytes, `write ${value}`)
    assert.deepStrictEqual(readVarInt(Buffer.from(bytes)), { value, size: bytes.length }, `read ${value}`)
  }
})

test('readVarInt throws on a VarInt cut short or longer than 5 bytes', () => {
  assert.throws(() => readVarInt(Buffer.from([0x80])), /cut short/)
  assert.throws(() => readVarInt(Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x01])), /too big/)
})

test('encode: the kind byte (hello 0, tick 1, ack 2), then the VarInt', () => {
  assert.deepStrictEqual([...encode({ type: 'hello', version: 1 })], [0, 1])
  assert.deepStrictEqual([...encode({ type: 'tick', tick: 0 })], [1, 0])
  assert.deepStrictEqual([...encode({ type: 'tick', tick: 300 })], [1, 0xac, 0x02])
  assert.deepStrictEqual([...encode({ type: 'ack', tick: 2147483647 })], [2, 0xff, 0xff, 0xff, 0xff, 0x07])
})

test('decode reads back what encode wrote', () => {
  for (const message of [
    { type: 'hello', version: PROTOCOL_VERSION },
    { type: 'tick', tick: 0 },
    { type: 'tick', tick: 123456 },
    { type: 'ack', tick: 99 },
    { type: 'ack', tick: 2147483647 }
  ] as const) {
    assert.deepStrictEqual(decode(encode(message)), message)
  }
})

test('decode: an unknown kind is null, bytes after the VarInt are ignored (a newer peer\'s), a short payload throws', () => {
  assert.strictEqual(decode(Buffer.from([7, 1])), null)
  assert.deepStrictEqual(decode(Buffer.from([1, 5, 0xaa, 0xbb])), { type: 'tick', tick: 5 })
  assert.throws(() => decode(Buffer.from([1])), RangeError)
  assert.throws(() => decode(Buffer.from([])), RangeError)
  assert.throws(() => decode(Buffer.from([2, 0x80])), /cut short/)
})
