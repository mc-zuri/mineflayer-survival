import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as zlib from 'node:zlib'
import { Vec3 } from 'vec3'
import { TaskRunner } from '../../src/core/taskRunner'
import { TaskError } from '../../src/core/errors'
import { Diagnostics } from '../../src/diagnostics'
import { Recorder, startRecorder, MemorySink, BlockDecoder, Codec, decodeHeader, readFrame, type RecEvent, type RecordingHeader } from '../../src/recorder'
import { FileSink } from '../../src/recorder/fileSink'
import { packetNamer, readRecording } from '../../src/recorder/read'

/* eslint-disable @typescript-eslint/no-var-requires */
const registry = require('minecraft-data')('1.21.11')
const { createSerializer } = require('minecraft-protocol/src/transforms/serializer')
const VERSION = '1.21.11'
/** the server's serializer: the packets the bot gets */
const server = createSerializer({ state: 'play', isServer: true, version: VERSION })
const CHUNK_ID = Number(Object.entries(registry.protocol.play.toClient.types.packet[1][0].type[1].mappings).find(([, n]) => n === 'map_chunk')?.[0])

/** a bot with a client whose serializer is minecraft-protocol's, a task runner, the diagnostics */
function fakeBot (): any {
  const bot: any = new EventEmitter()
  const client: any = new EventEmitter()
  client.state = 'play'
  client.serializer = createSerializer({ state: 'play', isServer: false, version: VERSION })
  bot._client = client
  bot.version = VERSION
  bot.registry = registry
  bot.username = 'rec'
  bot.health = 20
  bot.food = 17
  bot.foodSaturation = 2.5
  bot.oxygenLevel = 300
  bot.game = { dimension: 'overworld' }
  bot.entity = { id: 7, position: new Vec3(10.5, 64, -3.5), velocity: new Vec3(0, -0.0784, 0), onGround: true, yaw: 0, pitch: 0 }
  const slots: any[] = new Array(46).fill(null)
  slots[36] = { name: 'stone_pickaxe', count: 1 }
  slots[10] = { name: 'cobblestone', count: 20 }
  bot.inventory = { slots, items: () => slots.slice(9, 45).filter(s => s != null) }
  bot.heldItem = slots[36]
  bot.survival = { tasks: new TaskRunner(bot), reflexes: null }
  bot.survival.diagnostics = new Diagnostics(bot, { dir: null, log: null })
  return bot
}

const ticks = (bot: any, n: number): void => { for (let i = 0; i < n; i++) bot.emit('physicsTick') }
const incoming = (bot: any, name: string, params: any): void => {
  const buf = server.createPacketBuffer({ name, params })
  bot._client.emit('packet', params, { name, state: 'play' }, buf, buf)
}

/** the events of a recording in memory */
async function eventsOf (sink: MemorySink): Promise<{ header: RecordingHeader, events: RecEvent[] }> {
  const data = await sink.data()
  const h = decodeHeader(data)
  assert.ok(h != null)
  const events: RecEvent[] = []
  const dec = new BlockDecoder(packetNamer(h.header.mcVersion))
  let pos = h.size
  for (let f = readFrame(data, pos); f != null; f = readFrame(data, pos)) {
    assert.equal(f.codec, Codec.DeflateRaw)
    dec.decode(zlib.inflateRawSync(f.data), e => events.push(e))
    pos = f.next
  }
  assert.equal(pos, data.length)
  return { header: h.header, events }
}

test('the recorder: packets in and out (the heavy ones a summary), the tasks, the reflexes, the milestones, the plans, the log, a death, a report, the state', async () => {
  const bot = fakeBot()
  const sink = new MemorySink()
  const rec = new Recorder(bot, { sink, stateEvery: 20 })
  const { tasks, diagnostics } = bot.survival
  incoming(bot, 'keep_alive', { keepAliveId: 5n })
  // (a chunk: its x and z and its length only)
  const chunk = new Uint8Array(5000)
  chunk[0] = CHUNK_ID
  bot._client.emit('packet', { x: 3, z: -4 }, { name: 'map_chunk', state: 'play' }, chunk, chunk)
  // (the bot's packet out, as the client's write has its serializer make it)
  bot._client.serializer.createPacketBuffer({ name: 'keep_alive', params: { keepAliveId: 5n } })
  diagnostics.milestoneStarted('stone', 'a stone pickaxe', ['stone_pickaxe x1'])
  diagnostics.planMade(2, ['stone_pickaxe x1'], [{ desc: 'mine cobblestone x3' }, { desc: 'craft stone_pickaxe x1' }])
  diagnostics.stepStarted({ kind: 'mine', item: 'cobblestone', count: 3, blocks: ['stone'] } as any, 'mine cobblestone x3', 0)
  const mine = tasks.enqueue({ name: 'mine', priority: 0 }, async (ctx: any) => await ctx.waitTicks(100))
  await new Promise(resolve => setImmediate(resolve))
  ticks(bot, 5)
  // a reflex over the mine: its task preempts it, its end lets the bot go
  bot.emit('reflex', 'hostiles', 'zombie at 2.1')
  const reflex = tasks.enqueue({ name: 'reflex:hostiles', priority: 50, onPreempt: 'fail' }, async () => { throw new TaskError('NO_PATH', 'no path to the zombie') })
  await reflex.result.catch(() => {})
  ticks(bot, 25)
  await new Promise(resolve => setImmediate(resolve))
  bot.emit('survivalLog', 'milestone wood reached at tick 30 (1.5 s)')
  bot.emit('survivalMilestone', { id: 'wood', title: 'a wooden pickaxe', tick: 30 })
  bot.emit('messagestr', 'rec was slain by Zombie')
  bot.emit('death')
  diagnostics.add({ kind: 'death', tick: 31, time: new Date().toISOString(), diagnosis: 'killed by a zombie' } as any)
  bot.entity.position = new Vec3(0.5, 70, 0.5)
  bot.emit('spawn')
  mine.cancel('done')
  await mine.result.catch(() => {})
  rec.note('checkpoint', { dir: 'cp/01-wood' })
  await rec.stop()
  const { header, events } = await eventsOf(sink)
  assert.equal(header.mcVersion, VERSION)
  assert.equal(header.username, 'rec')
  const of = (k: string, ev?: string): any[] => events.filter(e => e.k === k && (ev == null || e.ev === ev))
  assert.deepEqual(of('in').map(e => [e.name, e.summary ?? false]), [['keep_alive', false], ['map_chunk', true]])
  assert.deepEqual([of('in')[1].x, of('in')[1].z, of('in')[1].bytes], [3, -4, 5000])
  assert.equal(of('out')[0].name, 'keep_alive')
  assert.equal(of('task', 'start')[0].name, 'mine')
  assert.equal(of('task', 'preempted')[0].name, 'mine')
  const failed = of('task', 'fail').find(e => e.name === 'reflex:hostiles')
  assert.equal(failed.code, 'NO_PATH')
  assert.equal(failed.priority, 50)
  assert.equal(of('reflex', 'preempt')[0].preempted, 'mine')
  assert.equal(of('reflex', 'preempt')[0].detail, 'zombie at 2.1')
  assert.deepEqual([of('reflex', 'release')[0].name, of('reflex', 'release')[0].code], ['hostiles', 'NO_PATH'])
  assert.equal(of('task', 'fail').find(e => e.name === 'mine').code, 'ABORTED')
  assert.equal(of('milestone', 'working')[0].id, 'stone')
  assert.equal(of('milestone', 'reached')[0].id, 'wood')
  assert.deepEqual(of('plan')[0].steps, ['mine cobblestone x3', 'craft stone_pickaxe x1'])
  assert.equal(of('step', 'start')[0].desc, 'mine cobblestone x3')
  assert.equal(of('log')[0].line, 'milestone wood reached at tick 30 (1.5 s)')
  assert.equal(of('death')[0].msg, 'rec was slain by Zombie')
  assert.deepEqual(of('death')[0].pos, [10.5, 64, -3.5])
  assert.deepEqual(of('respawn')[0].pos, [0.5, 70, 0.5])
  // (the diagnostics' own death report, and the one added)
  assert.ok(of('report').some(r => r.kind === 'death' && /slain by Zombie/.test(r.diagnosis)))
  assert.ok(of('report').some(r => r.diagnosis === 'killed by a zombie'))
  assert.deepEqual(of('note')[0].data, { dir: 'cp/01-wood' })
  const states = of('state')
  assert.equal(states.length, 1)
  assert.equal(states[0].t, 20)
  assert.equal(states[0].task, 'mine')
  assert.deepEqual(states[0].inv, { cobblestone: 20, stone_pickaxe: 1 })
  assert.equal(states[0].held, 'stone_pickaxe')
  // the ticks are the task runner's, in order
  assert.ok(events.every((e, i) => i === 0 || e.t >= events[i - 1].t))
  assert.ok(rec.stats.busyMs >= 0)
  // stopped: no more records, the serializer as it was
  const before = (await sink.data()).length
  incoming(bot, 'keep_alive', { keepAliveId: 6n })
  bot._client.serializer.createPacketBuffer({ name: 'keep_alive', params: { keepAliveId: 6n } })
  ticks(bot, 40)
  assert.equal((await sink.data()).length, before)
})

test('the packets: none, only some, all but some, and full (a chunk\'s bytes kept)', async () => {
  const run = async (opts: any): Promise<RecEvent[]> => {
    const bot = fakeBot()
    const sink = new MemorySink()
    const rec = new Recorder(bot, { sink, ...opts })
    incoming(bot, 'keep_alive', { keepAliveId: 1n })
    incoming(bot, 'update_time', { age: 10n, time: 1000n, tickDayTime: true })
    const chunk = new Uint8Array(300)
    chunk[0] = CHUNK_ID
    bot._client.emit('packet', { x: 1, z: 2 }, { name: 'map_chunk', state: 'play' }, chunk, chunk)
    await rec.stop()
    return (await eventsOf(sink)).events.filter(e => e.k === 'in')
  }
  assert.equal((await run({ packets: 'none' })).length, 0)
  assert.deepEqual((await run({ include: ['keep_alive'] })).map(e => e.name), ['keep_alive'])
  assert.deepEqual((await run({ exclude: ['keep_alive'] })).map(e => e.name), ['update_time', 'map_chunk'])
  const full = await run({ packets: 'full' })
  assert.equal(full[2].summary, undefined)
  assert.equal((full[2].raw as Uint8Array).length, 300)
})

test('the entities\' moves: kept within the entity range, the bot\'s own and an unknown one\'s; the rest counted in a dropped note; all in full', async () => {
  const run = async (opts: any): Promise<RecEvent[]> => {
    const bot = fakeBot()
    bot.entities = { 7: bot.entity, 20: { id: 20, position: new Vec3(20, 64, -3.5) }, 21: { id: 21, position: new Vec3(10.5, 64, 60) } }
    const sink = new MemorySink()
    const rec = new Recorder(bot, { sink, ...opts })
    for (const entityId of [7, 20, 21, 99]) {
      incoming(bot, 'rel_entity_move', { entityId, dX: 100, dY: 0, dZ: -100, onGround: true })
      incoming(bot, 'entity_head_rotation', { entityId, headYaw: 12 })
    }
    await rec.stop()
    assert.deepEqual(rec.dropped, opts.packets === 'full' || opts.entityRange === 100 ? {} : { rel_entity_move: 1, entity_head_rotation: 1 })
    return (await eventsOf(sink)).events
  }
  const events = await run({})
  const ids = events.filter(e => e.k === 'in' && e.name === 'rel_entity_move').map(e => (e.raw as Uint8Array)[1])
  assert.deepEqual(ids, [7, 20, 99])
  assert.deepEqual(events.find(e => e.k === 'note')?.data, { rel_entity_move: 1, entity_head_rotation: 1 })
  assert.equal(events.filter(e => e.k === 'in').length, 8 - 2)
  assert.equal((await run({ packets: 'full' })).filter(e => e.k === 'in').length, 8)
  assert.equal((await run({ entityRange: 100 })).filter(e => e.k === 'in').length, 8)
})

test('the protocol state: a new state recorded, its serializer hooked', async () => {
  const bot = fakeBot()
  const sink = new MemorySink()
  const rec = new Recorder(bot, { sink })
  bot._client.state = 'configuration'
  bot._client.serializer = createSerializer({ state: 'configuration', isServer: false, version: VERSION })
  bot._client.emit('state', 'configuration', 'play')
  bot._client.serializer.createPacketBuffer({ name: 'finish_configuration', params: {} })
  await rec.stop()
  const { events } = await eventsOf(sink)
  assert.deepEqual(events.filter(e => e.k === 'pstate').map(e => e.state), ['play', 'configuration'])
  assert.deepEqual(events.filter(e => e.k === 'out').map(e => [e.state, e.name]), [['configuration', 'finish_configuration']])
})

test('the memory sink keeps the last maxBytes: the oldest blocks dropped, the rest still read', async () => {
  const bot = fakeBot()
  const sink = new MemorySink({ maxBytes: 3000 })
  const rec = new Recorder(bot, { sink, blockBytes: 2000, stateEvery: 0 })
  // (lines the compression can't squeeze much)
  for (let i = 0; i < 400; i++) bot.emit('survivalLog', `line ${i} ${Math.random().toString(36)}`)
  await rec.stop()
  assert.ok(sink.dropped > 0)
  assert.ok(sink.bytes <= 3000 + 2500)
  const { events } = await eventsOf(sink)
  const lines = events.filter(e => e.k === 'log').map(e => Number(String(e.line).split(' ')[1]))
  assert.equal(lines[lines.length - 1], 399)
  assert.ok(lines[0] > 0)
  assert.deepEqual(lines, lines.map((_, i) => lines[0] + i))
  assert.ok((await sink.blob()).size === sink.bytes)
})

test('the file sink: written as it goes, read back a block at a time; startRecorder replaces bot.survival.recorder', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'))
  try {
    const file = path.join(dir, 'run.rec')
    const bot = fakeBot()
    const rec = startRecorder(bot, { file, blockBytes: 4096 })
    assert.equal(bot.survival.recorder, rec)
    for (let i = 0; i < 2000; i++) {
      incoming(bot, 'keep_alive', { keepAliveId: BigInt(i) })
      if (i % 10 === 0) ticks(bot, 1)
    }
    await rec.stop()
    assert.ok((rec.sink as FileSink).bytes > 0)
    const events: RecEvent[] = []
    let header: RecordingHeader | null = null
    const stats = await readRecording(file, e => events.push(e), h => { header = h })
    assert.equal((header as any)?.packets, 'summary')
    assert.ok(stats.blocks > 1)
    assert.equal(stats.truncated, false)
    assert.equal(events.filter(e => e.k === 'in').length, 2000)
    assert.equal(fs.statSync(file).size, stats.bytes)
    // the compression's worth it: 2000 keep-alives of 9 bytes and their heads
    assert.ok(stats.bytes < stats.rawBytes / 2, `${stats.bytes} of ${stats.rawBytes}`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the file sink on the process\'s exit: what\'s queued and the open block written synchronously', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'))
  try {
    for (const codec of ['zstd', 'brotli', 'deflate-raw'] as const) {
      if (codec === 'zstd' && typeof (zlib as any).zstdCompressSync !== 'function') continue
      const file = path.join(dir, `exit-${codec}.rec`)
      const bot = fakeBot()
      const rec = new Recorder(bot, { file, codec, blockBytes: 512, stateEvery: 0 })
      for (let i = 0; i < 300; i++) bot.emit('survivalLog', `line ${i}`)
      // (as process.on('exit') does: no await)
      ;(rec as any).exiting = true
      ;(rec as any).encoder.flush()
      ;(rec.sink as FileSink).endSync((rec as any).exitRaw)
      const events: RecEvent[] = []
      await readRecording(file, e => events.push(e))
      assert.equal(events.filter(e => e.k === 'log').length, 300, codec)
      assert.equal(events.filter(e => e.k === 'log')[299].line, 'line 299')
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
