import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BlockDecoder, BlockEncoder, Codec, K, decodeHeader, encodeHeader, frameBlock, readFrame, type RecEvent, type StateSnapshot } from '../../src/recorder/format'

const snap = (over: Partial<StateSnapshot> = {}): StateSnapshot => ({
  pos: [100.5, 64, -20.25],
  vel: [0, -0.0784, 0],
  onGround: true,
  health: 20,
  food: 18,
  saturation: 5,
  dim: 'overworld',
  held: 'stone_pickaxe',
  task: 'milestone:stone',
  reflex: null,
  milestone: 'stone',
  yaw: 1.57,
  pitch: -0.3,
  oxygen: 300,
  inv: new Map([['cobblestone', 12], ['stone_pickaxe', 1]]),
  ...over
})

function roundTrip (write: (enc: BlockEncoder) => void, blockBytes = 1 << 20): { blocks: Uint8Array[], events: RecEvent[][] } {
  const blocks: Uint8Array[] = []
  const enc = new BlockEncoder(raw => blocks.push(raw), blockBytes)
  write(enc)
  enc.flush()
  const dec = new BlockDecoder((state, out, id) => `${String(state)}:${out ? 'out' : 'in'}:${id}`)
  return { blocks, events: blocks.map(b => { const out: RecEvent[] = []; dec.decode(b, e => out.push(e)); return out }) }
}

test('every kind comes back with its tick, its ms and its fields', () => {
  const { events } = roundTrip(enc => {
    enc.protocolState(0, 0, 'play')
    enc.packet(false, 1, 3, new Uint8Array([0x27, 1, 2, 3]))
    enc.packet(true, 1, 3, new Uint8Array([0x1c, 9]))
    enc.fields(K.inSummary, 2, 4, [0x27, 12034, 3, -4])
    enc.event(K.task, 'start', 5, 10, ['mine', 0, 1])
    enc.event(K.task, 'fail', 25, 40, ['mine', 0, 1, 20, 'NO_PATH', 'no path to (1, 2, 3) after 4 tries'])
    enc.event(K.reflex, 'preempt', 30, 41, ['hostiles', 'zombie at 3.2', 'mine'])
    enc.event(K.reflex, 'release', 50, 60, ['hostiles', null, null, null])
    enc.event(K.milestone, 'working', 51, 61, ['stone', 'a stone pickaxe'])
    enc.fields(K.plan, 52, 62, [3, ['stone_pickaxe x1'], ['mine cobblestone x3', 'craft stone_pickaxe x1']])
    enc.fields(K.noPlan, 53, 62, [['diamond x3'], 'no source of diamond'])
    enc.event(K.step, 'start', 54, 63, ['mine cobblestone x3', 0])
    enc.fields(K.log, 55, 64, ['working on stone: a stone pickaxe'])
    enc.fields(K.death, 60, 70, [[1.5, 64, -3.25], 'overworld', 'player was slain by Zombie'])
    enc.fields(K.deathMessage, 61, 71, ['player was slain by Zombie'])
    enc.fields(K.respawn, 80, 90, [{ x: 0.5, y: 70, z: 0.5 }, 'overworld'])
    enc.fields(K.report, 81, 91, ['death', 'killed by a zombie at night', '/tmp/x.json'])
    enc.fields(K.note, 82, 92, ['checkpoint', { dir: 'cp/01-wood', n: 1 }])
    enc.state(100, 120, snap())
  })
  const e = events[0]
  const by = (k: string, ev?: string): any => e.find(x => x.k === k && (ev == null || x.ev === ev))
  assert.deepEqual(by('pstate'), { t: 0, ms: 0, k: 'pstate', state: 'play' })
  const pin = e.filter(x => x.k === 'in')
  assert.equal(pin[0].id, 0x27)
  assert.equal(pin[0].name, 'play:in:39')
  assert.deepEqual([...(pin[0].raw as Uint8Array)], [0x27, 1, 2, 3])
  assert.deepEqual({ ...pin[1], state: undefined }, { t: 2, ms: 4, k: 'in', id: 0x27, bytes: 12034, x: 3, z: -4, summary: true, name: 'play:in:39', state: undefined })
  assert.equal(by('out').name, 'play:out:28')
  assert.deepEqual(by('task', 'start'), { t: 5, ms: 10, k: 'task', ev: 'start', name: 'mine', priority: 0, attempt: 1 })
  assert.equal(by('task', 'fail').code, 'NO_PATH')
  assert.equal(by('task', 'fail').msg, 'no path to (1, 2, 3) after 4 tries')
  assert.equal(by('task', 'fail').ticks, 20)
  assert.equal(by('reflex', 'preempt').preempted, 'mine')
  assert.equal(by('reflex', 'release').code, null)
  assert.equal(by('milestone', 'working').title, 'a stone pickaxe')
  assert.deepEqual(by('plan').steps, ['mine cobblestone x3', 'craft stone_pickaxe x1'])
  assert.equal(by('no_plan').msg, 'no source of diamond')
  assert.equal(by('step', 'start').n, 0)
  assert.equal(by('log').line, 'working on stone: a stone pickaxe')
  assert.deepEqual(by('death').pos, [1.5, 64, -3.25])
  assert.equal(by('death').msg, 'player was slain by Zombie')
  assert.deepEqual(by('respawn').pos, [0.5, 70, 0.5])
  assert.equal(by('report').file, '/tmp/x.json')
  assert.deepEqual(by('note').data, { dir: 'cp/01-wood', n: 1 })
  const s = by('state')
  assert.deepEqual(s.pos, [100.5, 64, -20.25])
  assert.equal(s.health, 20)
  assert.equal(s.held, 'stone_pickaxe')
  assert.deepEqual(s.inv, { cobblestone: 12, stone_pickaxe: 1 })
  assert.equal(s.t, 100)
  assert.equal(s.ms, 120)
})

test('a state is the change from the one before it: a still bot\'s takes a few bytes; the inventory as its changes', () => {
  let sizes: number[] = []
  const blocks: Uint8Array[] = []
  const enc = new BlockEncoder(raw => blocks.push(raw))
  const at = (): number => enc.pending
  enc.state(0, 0, snap())
  let last = at()
  for (let i = 1; i <= 3; i++) {
    enc.state(i * 20, i * 20, snap({ pos: [100.5 + i * 0.2, 64, -20.25], inv: new Map([['cobblestone', 12 + i], ['stone_pickaxe', 1]]) }))
    sizes.push(at() - last)
    last = at()
  }
  enc.state(80, 80, snap({ pos: [101.1, 64, -20.25], inv: new Map([['cobblestone', 15]]) }))
  enc.flush()
  const events: RecEvent[] = []
  new BlockDecoder().decode(blocks[0], e => events.push(e))
  // (the record's head 4, the mask 2, the moved x 2 and the still y and z 1 each, a count's change 3)
  assert.ok(sizes.every(n => n <= 13), String(sizes))
  assert.deepEqual(events.map(e => (e.pos as number[])[0]), [100.5, 100.7, 100.9, 101.1, 101.1])
  assert.deepEqual(events[1].dinv, { cobblestone: 1 })
  assert.deepEqual(events[4].dinv, { stone_pickaxe: -1 })
  assert.deepEqual(events[4].inv, { cobblestone: 15 })
  assert.equal(events[4].task, 'milestone:stone')
  sizes = []
})

test('a block reads on its own: its strings, its protocol state and its first state whole', () => {
  const { blocks, events } = roundTrip(enc => {
    enc.protocolState(0, 0, 'play')
    for (let i = 0; i < 400; i++) {
      enc.fields(K.log, i, i, [`working on wood: tick ${i}`])
      if (i % 20 === 0) enc.state(i, i, snap({ pos: [i, 64, 0] }))
    }
  }, 500)
  assert.ok(blocks.length > 2)
  // (the second block alone)
  const second = events[1]
  assert.equal(second[0].k, 'pstate')
  const log = second.find(e => e.k === 'log') as RecEvent
  assert.match(String(log.line), /^working on wood: tick \d+$/)
  const st = second.find(e => e.k === 'state') as RecEvent
  assert.equal((st.pos as number[])[0], st.t)
  assert.deepEqual(st.inv, { cobblestone: 12, stone_pickaxe: 1 })
  // every tick in order over the blocks
  const ticks = events.flat().filter(e => e.k === 'log').map(e => e.t)
  assert.deepEqual(ticks, Array.from({ length: 400 }, (_, i) => i))
})

test('the header and the blocks\' frames; a frame cut short is not read', () => {
  const header = encodeHeader({ format: 'mineflayer-survival recording', mcVersion: '1.21.11', protocol: 774, start: 1760000000000, username: 'player', packets: 'summary', summarized: ['map_chunk'], stateEvery: 20 })
  const back = decodeHeader(header)
  assert.equal(back?.header.mcVersion, '1.21.11')
  assert.equal(back?.size, header.length)
  assert.equal(decodeHeader(header.subarray(0, 8)), null)
  assert.throws(() => decodeHeader(new Uint8Array([1, 2, 3, 4, 5, 6])), /not a recording/)
  const frame = frameBlock(Codec.DeflateRaw, 100, new Uint8Array([9, 8, 7]))
  assert.deepEqual(readFrame(frame, 0), { codec: Codec.DeflateRaw, rawLength: 100, data: new Uint8Array([9, 8, 7]), next: frame.length })
  assert.equal(readFrame(frame.subarray(0, frame.length - 1), 0), null)
})

test('the payloads grouped by kind, packet id and length and transposed come back in order, byte for byte', () => {
  // (a seeded generator: the same packets every run)
  let seed = 12345
  const rand = (n: number): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n }
  const sent: Array<{ out: boolean, bytes: number[] }> = []
  const { blocks, events } = roundTrip(enc => {
    for (let i = 0; i < 3000; i++) {
      // (ids over 127 take two bytes of varint)
      const id = [3, 40, 41, 200][rand(4)]
      const head = id >= 128 ? [(id & 0x7f) | 0x80, id >> 7] : [id]
      const bytes = [...head, ...Array.from({ length: [0, 1, 8, 9, 30][rand(5)] }, () => rand(256))]
      const out = rand(3) === 0
      sent.push({ out, bytes })
      enc.packet(out, i >> 3, i, new Uint8Array(bytes))
      if (i % 50 === 0) enc.fields(K.log, i >> 3, i, [`line ${i}`])
    }
  }, 8192)
  assert.ok(blocks.length > 2)
  const packets = events.flat().filter(e => e.k === 'in' || e.k === 'out')
  assert.equal(packets.length, sent.length)
  packets.forEach((e, i) => {
    assert.equal(e.k, sent[i].out ? 'out' : 'in')
    assert.deepEqual([...(e.raw as Uint8Array)], sent[i].bytes)
    assert.equal(e.bytes, sent[i].bytes.length)
  })
  assert.deepEqual(events.flat().filter(e => e.k === 'log').map(e => e.line), Array.from({ length: 60 }, (_, i) => `line ${i * 50}`))
})
