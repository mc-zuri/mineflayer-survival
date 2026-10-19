import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import {
  BLAZE_CHARGE_TICKS, BLAZE_EYE_HEIGHT, BlazeVolleys, FIREBALL_FLIGHT_TICKS, SHIELD_LEAD_TICKS, clearLine, nookAround,
  planBlazeNook, type NookLookup
} from '../../src/nether/blazeFight'
import { readNetherSnapshot } from './netherSnapshot'
import * as path from 'node:path'

const solid = (name: string): { name: string, boundingBox: string } => ({ name, boundingBox: 'block' })
const AIR = { name: 'air', boundingBox: 'empty' }

/** a world of the given solid cells over a stone floor at y 63 (the spawner at 0 64 0) */
function world (extra: (p: Vec3) => string | null = () => null): { lookup: NookLookup, put: (p: Vec3) => void } {
  const placed = new Set<string>()
  const lookup: NookLookup = p => {
    if (placed.has(p.toString())) return solid('cobblestone')
    if (p.x === 0 && p.y === 64 && p.z === 0) return solid('spawner')
    const e = extra(p)
    if (e != null) return e === 'air' ? AIR : solid(e)
    return p.y < 64 ? solid('nether_bricks') : AIR
  }
  return { lookup, put: p => placed.add(p.toString()) }
}

test('BlazeVolleys: a blaze seen to charge is a danger SHIELD_LEAD_TICKS before its first shot, and for a fireball\'s flight after the volley', () => {
  const v = new BlazeVolleys()
  v.update([{ id: 1, charged: false }], 0)
  v.update([{ id: 1, charged: true }], 10)
  const lead = BLAZE_CHARGE_TICKS - SHIELD_LEAD_TICKS
  assert.equal(v.chargedFor(1, 10 + lead - 1), lead - 1)
  assert.equal(v.dangerous(1, 10 + lead - 1), false)
  assert.equal(v.dangerous(1, 10 + lead), true)
  // the volley's 78 ticks, then the flag off: still a danger while its last fireball flies
  v.update([{ id: 1, charged: false }], 88)
  assert.equal(v.chargedFor(1, 88), null)
  assert.equal(v.dangerous(1, 88 + FIREBALL_FLIGHT_TICKS), true)
  assert.equal(v.dangerous(1, 88 + FIREBALL_FLIGHT_TICKS + 1), false)
  // its rest: quiet for a meal unless a charge could reach its shot before the meal's end
  assert.equal(v.quietFor(1, 200, 34), true)
  v.update([{ id: 1, charged: true }], 200)
  assert.equal(v.quietFor(1, 200, 34), true)
  assert.equal(v.quietFor(1, 215, 34), false)
})

test('BlazeVolleys: a blaze first seen charged may shoot at once (out of sight it stays charged); one gone is forgotten', () => {
  const v = new BlazeVolleys()
  v.update([{ id: 2, charged: true }], 50)
  assert.equal(v.dangerous(2, 50), true)
  v.update([], 51)
  assert.equal(v.chargedFor(2, 51), null)
  assert.equal(v.dangerous(2, 51), false)
})

test('planBlazeNook on open ground: a stand off the spawner facing it, its back, sides and roof to build (and a block over a side for the roof to go against), the roof last', () => {
  const { lookup } = world()
  const nook = planBlazeNook(lookup, new Vec3(0, 64, 0), { from: new Vec3(0.5, 64, 20.5) })
  assert.ok(nook != null)
  const h = Math.hypot(nook.stand.x, nook.stand.z)
  assert.ok(h >= 7 && h <= 13, nook.stand.toString())
  // facing the spawner: toward -z from the bot's side
  assert.ok(nook.facing.dot(new Vec3(-nook.stand.x, 0, -nook.stand.z).scaled(1 / h)) > 0.86, `${nook.stand.toString()} facing ${nook.facing.toString()}`)
  assert.equal(nook.build.length, 8)
  assert.deepEqual(nook.build[nook.build.length - 1], nook.stand.offset(0, 2, 0))
  for (const w of nook.walls) assert.ok(nook.build.some(b => b.equals(w)), w.toString())
  // each block has a solid neighbour by the time it goes in (the floor, or one put before it)
  const put = new Set<string>()
  for (const p of nook.build) {
    const n = [p.offset(0, -1, 0), p.offset(0, 1, 0), p.offset(1, 0, 0), p.offset(-1, 0, 0), p.offset(0, 0, 1), p.offset(0, 0, -1)]
    assert.ok(n.some(q => put.has(q.toString()) || lookup(q)?.boundingBox === 'block'), `${p.toString()} has nothing to go against`)
    put.add(p.toString())
  }
  assert.deepEqual(nook.front, [nook.stand.plus(nook.facing), nook.stand.plus(nook.facing).offset(0, 1, 0)])
})

test('planBlazeNook takes the walls there are: by a wall the nook costs fewer blocks', () => {
  // a wall 3 high along x = 9, from z -8 to 8: a stand at x 8 has its back in it, and its roof goes against it
  const { lookup } = world(p => p.x === 9 && p.y >= 64 && p.y <= 66 && Math.abs(p.z) <= 8 ? 'basalt' : null)
  const nook = planBlazeNook(lookup, new Vec3(0, 64, 0), { from: new Vec3(8.5, 64, 0.5) })
  assert.ok(nook != null)
  assert.deepEqual(nook.facing, new Vec3(-1, 0, 0))
  assert.equal(nook.stand.x, 8)
  assert.equal(nook.build.length, 5)
})

test('nookAround puts a block under a wall over nothing first, against the floor beside it; none at all where there is nothing to build on', () => {
  // the floor only under the stand (0 64 10) and its front: the sides hang over a drop
  const { lookup } = world(p => p.y === 63 && !(p.x === 0 && (p.z === 10 || p.z === 9)) ? 'air' : null)
  const nook = nookAround(lookup, new Vec3(0, 64, 10), new Vec3(0, 0, -1))
  assert.ok(nook != null)
  const first = nook.build.findIndex(p => p.y === 63)
  assert.ok(first >= 0, nook.build.map(String).join(' '))
  assert.equal(nookAround(lookup, new Vec3(5, 70, 10), new Vec3(0, 0, -1)), null)
})

test('a blaze sees the bot in its nook only through the front, within 45 degrees of its facing', () => {
  const w = world()
  const nook = planBlazeNook(w.lookup, new Vec3(0, 64, 0), { from: new Vec3(0.5, 64, 20.5) })
  assert.ok(nook != null)
  for (const p of nook.build) w.put(p)
  const eye = nook.stand.offset(0.5, 1.62, 0.5)
  const at = (deg: number, d = 8, up = 1): Vec3 => {
    const a = Math.atan2(nook.facing.z, nook.facing.x) + deg * Math.PI / 180
    return eye.offset(Math.cos(a) * d, up - 1.62 + BLAZE_EYE_HEIGHT, Math.sin(a) * d)
  }
  for (const deg of [0, 20, -20, 40, -40]) assert.ok(clearLine(w.lookup, at(deg), eye), `${deg} degrees off: hidden`)
  for (const deg of [55, -55, 90, -90, 130, -130, 180]) assert.ok(!clearLine(w.lookup, at(deg), eye), `${deg} degrees off: seen`)
  // from over it: the roof
  assert.ok(!clearLine(w.lookup, eye.offset(0.3, 6, 0.2), eye))
})

test('planBlazeNook at seed 2\'s fortress spawner (59 64 -534, 26.3): on the bridge into its throne, 10 off, facing it, 5 blocks', () => {
  const snap = readNetherSnapshot(path.join(__dirname, '..', 'fixtures', 'nether-seed2-blaze.json.gz'))
  const mc = require('minecraft-data')(snap.version)
  const [x0, y0, z0] = snap.origin
  const [sx, sy, sz] = snap.size
  const lookup: NookLookup = p => {
    const x = p.x - x0; const y = p.y - y0; const z = p.z - z0
    if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) return null
    const b = mc.blocksByStateId[snap.ids[(x * sz + z) * sy + y]]
    return b == null ? null : { name: b.name, boundingBox: b.boundingBox }
  }
  const spawner = new Vec3(59, 64, -534)
  assert.equal(lookup(spawner)?.name, 'spawner')
  const nook = planBlazeNook(lookup, spawner, { from: new Vec3(43.5, 89, -515.5) })
  assert.ok(nook != null)
  assert.deepEqual(nook.stand, new Vec3(58, 61, -544))
  assert.deepEqual(nook.facing, new Vec3(0, 0, 1))
  assert.equal(nook.build.length, 5)
  for (const w of nook.walls) assert.ok(lookup(w)?.boundingBox === 'block' || nook.build.some(b => b.equals(w)), w.toString())
  assert.ok(clearLine(lookup, nook.stand.offset(0.5, 1.62, 0.5), spawner.offset(0.5, 1.5, 0.5), p => p.equals(spawner)))
})

test('fightFromNook: the bow drawn at a blaze in front while it rests, the shield up and the sword in hand once its charge is near its shot, toward it', async () => {
  const { fakeBot, entity, item } = await import('../reflexes/fakeBot')
  const { fightFromNook, nookAround } = await import('../../src/nether/blazeFight')
  // the nook at 0 64 10 facing -z, built of cobblestone over a stone floor
  const stand = new Vec3(0, 64, 10)
  const walls = new Set(['(0, 64, 11)', '(0, 65, 11)', '(1, 64, 10)', '(1, 65, 10)', '(-1, 64, 10)', '(-1, 65, 10)', '(0, 66, 10)'])
  const name = (p: Vec3): string => walls.has(p.floored().toString()) ? 'cobblestone' : p.y < 64 ? 'stone' : 'air'
  const blaze = entity({ name: 'blaze', position: new Vec3(0.5, 65, 2.5), meta: { health: 20, flags: 0 } })
  const sword = item('diamond_sword')
  const bow = item('bow')
  const bot = fakeBot({ position: new Vec3(0.5, 64, 10.5), items: [sword, bow, item('arrow', 64), item('cooked_beef', 16)], offhand: item('shield'), entities: [blaze], world: name })
  bot.world = {
    raycast: (from: Vec3, dir: Vec3, range: number) => {
      for (let t = 0; t <= range; t += 0.02) {
        const p = from.plus(dir.scaled(t))
        if (name(p) !== 'air') return { position: p.floored(), intersect: p, boundingBox: 'block', name: name(p) }
      }
      return null
    }
  }
  const log: string[] = []
  bot.equip = async (it: any, dest: string) => { if (dest === 'hand') bot.heldItem = it }
  bot.activateItem = (off = false) => { bot.usingHeldItem = true; log.push(off ? 'shield' : `use ${bot.heldItem?.name as string}`) }
  bot.deactivateItem = () => { bot.usingHeldItem = false; log.push('release') }
  let yaw = 0
  bot.look = async (y: number) => { yaw = y }
  bot.lookAt = async (p: Vec3) => { yaw = Math.atan2(-(p.x - 0.5), -(p.z - 10.5)) }
  bot.attack = () => {}
  bot.game.dimension = 'the_nether'
  const nook = nookAround((p: Vec3) => bot.blockAt(p), stand, new Vec3(0, 0, -1))
  assert.ok(nook != null && nook.build.length === 0)
  const ac = new AbortController()
  const done = fightFromNook(bot, nook, { count: 1, spawner: new Vec3(0, 64, 0), maxTicks: 1000 }, ac.signal).catch(err => err)
  const tick = async (n: number): Promise<void> => { for (let i = 0; i < n; i++) { bot.emit('physicsTick'); await new Promise(resolve => setImmediate(resolve)) } }
  await tick(30)
  assert.ok(log.includes('use bow'), log.join(' '))
  assert.ok(log.includes('release'), `a full draw loosed: ${log.join(' ')}`)
  // charged now: the shield goes up before its first shot (60 ticks), not long before
  log.length = 0
  blaze.metadata[16] = 1
  await tick(30)
  assert.ok(!log.includes('shield'), `no shield 30 ticks into the charge: ${log.join(' ')}`)
  await tick(30)
  assert.ok(log.includes('shield'), `the shield up by the shot: ${log.join(' ')}`)
  assert.strictEqual(bot.heldItem?.name, 'diamond_sword')
  assert.strictEqual(bot.usingHeldItem, true)
  assert.ok(Math.abs(yaw) < 0.2, `facing the blaze: yaw ${yaw}`)
  // the volley over and the flight's ticks gone: the bow again
  blaze.metadata[16] = 0
  log.length = 0
  await tick(60)
  assert.ok(log.includes('use bow'), log.join(' '))
  // a rod in the bag: done
  bot.inventory.slots[30] = item('blaze_rod')
  await tick(5)
  const r = await done
  assert.ok(!(r instanceof Error), String(r))
  assert.ok(r.shots >= 1 && r.blocked > 0, JSON.stringify(r))
})

test('fightFromNook: low with a blaze in the front, the sword at it (the shield up between the swings) before any try to shut the front', async () => {
  const { fakeBot, entity, item } = await import('../reflexes/fakeBot')
  const { fightFromNook, nookAround } = await import('../../src/nether/blazeFight')
  const stand = new Vec3(0, 64, 10)
  const walls = new Set(['(0, 64, 11)', '(0, 65, 11)', '(1, 64, 10)', '(1, 65, 10)', '(-1, 64, 10)', '(-1, 65, 10)', '(0, 66, 10)'])
  const name = (p: Vec3): string => walls.has(p.floored().toString()) ? 'cobblestone' : p.y < 64 ? 'stone' : 'air'
  // in the front cell, hitting the bot
  const blaze = entity({ name: 'blaze', position: new Vec3(0.5, 64.2, 9.3), meta: { health: 20, flags: 0 } })
  const bot = fakeBot({ position: new Vec3(0.5, 64, 10.5), health: 8, items: [item('diamond_sword'), item('cobblestone', 32), item('cooked_beef', 16)], offhand: item('shield'), entities: [blaze], world: name })
  bot.world = {
    raycast: (from: Vec3, dir: Vec3, range: number) => {
      for (let t = 0; t <= range; t += 0.02) {
        const p = from.plus(dir.scaled(t))
        if (name(p) !== 'air') return { position: p.floored(), intersect: p, boundingBox: 'block', name: name(p) }
      }
      return null
    }
  }
  const log: string[] = []
  bot.equip = async (it: any, dest: string) => { if (dest === 'hand') { bot.heldItem = it; log.push(`hold ${it.name as string}`) } }
  bot.activateItem = (off = false) => { bot.usingHeldItem = true; log.push(off ? 'shield' : 'use') }
  bot.deactivateItem = () => { bot.usingHeldItem = false; log.push('release') }
  bot.lookAt = async () => {}
  bot.attack = () => { log.push('swing') }
  bot.game.dimension = 'the_nether'
  const nook = nookAround((p: Vec3) => bot.blockAt(p), stand, new Vec3(0, 0, -1))
  assert.ok(nook != null)
  const ac = new AbortController()
  const done = fightFromNook(bot, nook, { count: 1, spawner: new Vec3(0, 64, 0), maxTicks: 1000 }, ac.signal).catch(err => err)
  for (let i = 0; i < 40; i++) { bot.emit('physicsTick'); await new Promise(resolve => setImmediate(resolve)) }
  assert.ok(log.includes('swing'), log.join(' '))
  assert.ok(log.includes('shield'), `the shield between the swings: ${log.join(' ')}`)
  assert.ok(!log.includes('hold cobblestone'), `no try to shut the front: ${log.join(' ')}`)
  ac.abort()
  for (let i = 0; i < 3; i++) { bot.emit('physicsTick'); await new Promise(resolve => setImmediate(resolve)) }
  await done
})
