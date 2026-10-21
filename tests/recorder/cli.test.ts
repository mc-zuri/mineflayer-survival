import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { FileSink } from '../../src/recorder/fileSink'
import { BlockEncoder, K, encodeHeader, type RecEvent } from '../../src/recorder/format'
import { parseCliArgs, runCli, AROUND_DEATH_TICKS } from '../../src/recorder/cli'
import { AroundDeaths, Summary, passes, plain, tableLine } from '../../src/recorder/query'

/* eslint-disable @typescript-eslint/no-var-requires */
const { createSerializer } = require('minecraft-protocol/src/transforms/serializer')
const VERSION = '1.21.11'
const server = createSerializer({ state: 'play', isServer: true, version: VERSION })
const client = createSerializer({ state: 'play', isServer: false, version: VERSION })
const registry = require('minecraft-data')(VERSION)
const idOf = (name: string): number => Number(Object.entries(registry.protocol.play.toClient.types.packet[1][0].type[1].mappings).find(([, n]) => n === name)?.[0])

let dir = ''
let file = ''

/** a run of 1000 ticks: keep-alives in and out every 20 ticks, chunks, tasks, two deaths, milestones, a report */
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-cli-'))
  file = path.join(dir, 'run.rec')
  const sink = new FileSink(file, { codec: 'brotli' })
  sink.header(encodeHeader({ format: 'mineflayer-survival recording', mcVersion: VERSION, protocol: 774, start: 1760000000000, username: 'player', packets: 'summary', summarized: ['map_chunk'], stateEvery: 20 }))
  const enc = new BlockEncoder(raw => sink.block(raw), 1024)
  enc.protocolState(0, 0, 'play')
  for (let t = 0; t <= 1000; t++) {
    const ms = t * 5
    if (t % 20 === 0) {
      enc.packet(false, t, ms, server.createPacketBuffer({ name: 'keep_alive', params: { keepAliveId: BigInt(t) } }))
      enc.packet(true, t, ms, client.createPacketBuffer({ name: 'keep_alive', params: { keepAliveId: BigInt(t) } }))
      enc.state(t, ms, { pos: [t / 10, 64, 0], vel: [0, 0, 0], onGround: true, health: 20, food: 20, saturation: 5, dim: 'overworld', held: null, task: 'mine', reflex: null, milestone: 'wood', yaw: 0, pitch: 0, oxygen: 300, inv: new Map([['oak_log', Math.floor(t / 100)]]) })
    }
    if (t % 100 === 0) enc.fields(K.inSummary, t, ms, [idOf('map_chunk'), 20000, t / 100, -1])
    if (t === 10) enc.event(K.milestone, 'working', t, ms, ['wood', 'a wooden pickaxe'])
    if (t === 50) enc.event(K.task, 'start', t, ms, ['mine', 0, 1])
    if (t === 300) enc.event(K.task, 'fail', t, ms, ['mine', 0, 1, 250, 'NO_PATH', 'no path to the log'])
    if (t === 310) enc.event(K.task, 'fail', t, ms, ['reflex:hostiles', 50, 1, 9, 'NO_PATH', 'no path'])
    if (t === 320) enc.event(K.task, 'fail', t, ms, ['craft', 0, 1, 1, 'MISSING_ITEMS', 'no planks'])
    if (t === 400) enc.fields(K.death, t, ms, [[40, 64, 0], 'overworld', 'player was slain by Zombie'])
    if (t === 420) enc.fields(K.respawn, t, ms, [[0, 70, 0], 'overworld'])
    if (t === 450) enc.fields(K.report, t, ms, ['death', 'killed by a zombie', null])
    if (t === 600) enc.event(K.milestone, 'reached', t, ms, ['wood', 'a wooden pickaxe'])
    if (t === 900) enc.fields(K.death, t, ms, [[90, 64, 0], 'overworld'])
    if (t === 901) enc.fields(K.deathMessage, t, ms, ['player fell from a high place'])
    if (t % 250 === 0) enc.fields(K.log, t, ms, [`status at tick ${t}`])
    if (t === 1000) enc.fields(K.note, t, ms, ['dropped', { rel_entity_move: 1234, entity_head_rotation: 99 }])
  }
  enc.flush()
  await sink.end()
})

after(() => { fs.rmSync(dir, { recursive: true, force: true }) })

async function query (...args: string[]): Promise<string[]> {
  const lines: string[] = []
  await runCli(parseCliArgs([file, ...args]), line => lines.push(line))
  return lines
}

test('the options: kinds, packets (their fields decoded), ticks, around a death, a regex, the summary, NDJSON', () => {
  const o = parseCliArgs(['x.rec', '--kind', 'task.fail,death', '--packet=keep_alive', '--from', '10', '--to', '20', '--grep', 'NO_.*', '--ndjson', '--limit', '5'])
  assert.deepEqual(o.filter.kinds, ['task.fail', 'death'])
  assert.deepEqual(o.filter.packets, ['keep_alive'])
  assert.equal(o.data, true)
  assert.deepEqual([o.filter.from, o.filter.to, o.limit, o.ndjson], [10, 20, 5, true])
  assert.ok(o.filter.grep?.test('NO_PATH'))
  assert.equal(parseCliArgs(['x.rec', '--around', 'death']).around, AROUND_DEATH_TICKS)
  assert.equal(parseCliArgs(['x.rec', '--around', 'death', '50', '--summary']).around, 50)
  assert.equal(parseCliArgs(['x.rec', '--summary']).summary, true)
  assert.throws(() => parseCliArgs([]), /usage/)
  assert.throws(() => parseCliArgs(['x.rec', '--around', 'milestone']), /death/)
  assert.throws(() => parseCliArgs(['x.rec', '--from', 'soon']), /numbers/)
  assert.throws(() => parseCliArgs(['x.rec', '--frobnicate']), /unknown option/)
})

test('by kind and event, by tick, by packet name with the fields decoded, by regex; NDJSON with a header', async () => {
  const fails = await query('--kind', 'task.fail', '--ndjson')
  assert.equal(JSON.parse(fails[0]).k, 'header')
  assert.deepEqual(fails.slice(1).map(l => JSON.parse(l).name), ['mine', 'reflex:hostiles', 'craft'])
  const deaths = await query('--kind', 'death,respawn')
  assert.equal(deaths.length, 3)
  assert.match(deaths[0], /death\s+40 64 0 overworld: player was slain by Zombie/)
  const window = await query('--from', '95', '--to', '105', '--kind', 'state,in')
  assert.deepEqual(window.map(l => l.trim().split(/\s+/)[0]), ['100', '100', '100'])
  const keep = await query('--packet', 'keep_alive', '--ndjson', '--to', '40')
  const ins = keep.slice(1).map(l => JSON.parse(l))
  // (an i64 as minecraft-protocol reads it: [high, low])
  assert.deepEqual(ins.map(e => [e.k, e.name, e.data.keepAliveId[1]]), [['in', 'keep_alive', 0], ['out', 'keep_alive', 0], ['in', 'keep_alive', 20], ['out', 'keep_alive', 20], ['in', 'keep_alive', 40], ['out', 'keep_alive', 40]])
  const chunks = await query('--packet', 'map_*', '--limit', '2')
  assert.equal(chunks.length, 2)
  assert.match(chunks[0], /map_chunk 20000 B x=0 z=-1 \(summary\)/)
  const grep = await query('--grep', 'NO_PATH')
  assert.equal(grep.length, 2)
  const raw = await query('--packet', 'keep_alive', '--ndjson', '--raw', '--limit', '1')
  assert.match(JSON.parse(raw[1]).raw, /^[0-9a-f]+$/)
})

test('around death: the ticks before each death and the death, nothing after', async () => {
  const lines = await query('--around', 'death', '60', '--kind', 'state,death,task,report')
  const ticks = lines.map(l => Number(l.trim().split(/\s+/)[0]))
  assert.deepEqual(ticks, [340, 360, 380, 400, 400, 840, 860, 880, 900, 900])
  assert.match(lines[4], /death/)
  // the window lets nothing older than the ticks out
  const out: RecEvent[] = []
  const around = new AroundDeaths(10, e => out.push(e))
  for (const t of [1, 5, 12, 15]) around.push({ t, ms: 0, k: 'log' })
  around.trigger({ t: 20, ms: 0, k: 'death' })
  assert.deepEqual(out.map(e => e.t), [12, 15, 20])
})

test('the summary: counts by kind and packet, the deaths with their messages, the milestones\' ticks, the failures by code', async () => {
  const lines = await query('--summary')
  const text = lines.join('\n')
  assert.match(text, /player on 1\.21\.11 \(protocol 774\)/)
  assert.match(text, /ticks 0 to 1000 \(1000\)/)
  assert.match(text, /bytes per 1000 ticks/)
  assert.match(text, /task\.fail\s+3/)
  assert.match(text, /keep_alive\s+51\s+\d+ B/)
  assert.match(text, /map_chunk\s+11\s+220000 B/)
  assert.match(text, /deaths: 2 \(1 respawns\)/)
  assert.match(text, /t400 40 64 0 overworld: player was slain by Zombie/)
  assert.match(text, /t900 90 64 0 overworld: player fell from a high place/)
  assert.match(text, /wood\s+working t10\s+reached t600/)
  assert.match(text, /NO_PATH\s+2\s+mine 1, reflex:hostiles 1/)
  assert.match(text, /MISSING_ITEMS\s+1\s+craft 1/)
  assert.match(text, /reports: death 1/)
  assert.match(text, /left out \(the far entities' moves\): rel_entity_move 1234, entity_head_rotation 99/)
  const json = JSON.parse((await query('--summary', '--ndjson'))[0])
  assert.equal(json.deaths.length, 2)
  assert.equal(json.milestones.wood.reached, 600)
  assert.equal(json.taskFailures.NO_PATH.count, 2)
  assert.ok(json.file.blocks > 1)
  // (the summary of a filtered stream)
  const s = new Summary()
  for (const e of [{ t: 1, ms: 0, k: 'task', ev: 'fail', name: 'x', code: null }]) if (passes(e, { kinds: ['task'] })) s.add(e)
  assert.deepEqual(s.s.taskFailures, { none: { count: 1, tasks: { x: 1 } } })
})

test('events written out: JSON-safe values (bigints, bytes), a line for each kind', () => {
  assert.deepEqual(plain({ a: 1n, b: new Uint8Array([1, 255]), c: new Uint8Array(100), d: [NaN], e: new Map([['k', 1]]) }), { a: '1', b: '01ff', c: { bytes: 100 }, d: ['NaN'], e: { k: 1 } })
  assert.match(tableLine({ t: 5, ms: 1500, k: 'reflex', ev: 'preempt', name: 'hostiles', detail: 'zombie', preempted: 'mine' }), /^\s+5\s+1\.5s reflex\s+preempt hostiles \(zombie\) over mine$/)
  assert.match(tableLine({ t: 5, ms: 0, k: 'state', pos: [1, 2, 3], dim: 'overworld', onGround: true, health: 20, food: 18, held: null, task: 'mine', dinv: { oak_log: 2, stick: -1 } }), /1 2 3 overworld ground hp 20 food 18 held - task mine inv \+2 oak_log, -1 stick/)
  assert.match(tableLine({ t: 5, ms: 0, k: 'plan', n: 2, requests: ['a x1'], steps: ['s1', 's2'] }), /#2 for a x1: s1 > s2/)
})

test('--recompress: the file written again with another codec, the same events read back', async () => {
  const out = path.join(dir, 'again.rec')
  const opts = parseCliArgs([file, '--recompress', out, '--codec', 'deflate-raw', '--level', '1'])
  assert.deepEqual([opts.recompress, opts.codec, opts.level], [out, 'deflate-raw', 1])
  assert.throws(() => parseCliArgs([file, '--codec', 'lzma']), /--codec is/)
  const lines: string[] = []
  await runCli(opts, l => lines.push(l))
  assert.match(lines[0], /bytes \(deflate-raw 1\)/)
  const a = await query('--ndjson')
  const b: string[] = []
  await runCli(parseCliArgs([out, '--ndjson']), l => b.push(l))
  assert.deepEqual(b, a)
})
