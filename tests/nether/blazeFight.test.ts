import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import {
  BLAZE_CHARGE_TICKS, BLAZE_EYE_HEIGHT, BlazeVolleys, FIREBALL_FLIGHT_TICKS, SHIELD_LEAD_TICKS, clearLine, nookAround, spawnView,
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

test('planBlazeNook at seed 2\'s fortress spawner (59 64 -534, 26.3): on the bridge into its throne, 10 off, facing it, 5 blocks, seeing over half its spawns', () => {
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
  // (58, 61, -544) before the spawns seen were counted: 0.46 of them; 0.59 two over
  assert.deepEqual(nook.stand, new Vec3(60, 61, -544))
  assert.deepEqual(nook.facing, new Vec3(0, 0, 1))
  assert.equal(nook.build.length, 5)
  assert.ok(spawnView(lookup, spawner, nook).seen > 0.5)
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

test('fightFromNook meets a magma cube come into reach with the sword itself, the hostiles reflex leaving the cubes to it till it ends', async () => {
  const { fakeBot, entity, item } = await import('../reflexes/fakeBot')
  const { fightFromNook, nookAround } = await import('../../src/nether/blazeFight')
  const { ReflexEngine } = await import('../../src/reflexes/engine')
  const stand = new Vec3(0, 64, 10)
  const walls = new Set(['(0, 64, 11)', '(0, 65, 11)', '(1, 64, 10)', '(1, 65, 10)', '(-1, 64, 10)', '(-1, 65, 10)', '(0, 66, 10)'])
  const name = (p: Vec3): string => walls.has(p.floored().toString()) ? 'cobblestone' : p.y < 64 ? 'stone' : 'air'
  const cube = entity({ name: 'magma_cube', position: new Vec3(0.5, 64, 8.6), meta: { health: 4 } })
  const bot = fakeBot({ position: new Vec3(0.5, 64, 10.5), items: [item('diamond_sword')], offhand: item('shield'), entities: [cube], world: name })
  bot.world = { raycast: () => null }
  const engine = new ReflexEngine(bot, { reflexes: [] })
  bot.survival = { reflexes: engine }
  const swings: number[] = []
  bot.equip = async (it: any, dest: string) => { if (dest === 'hand') bot.heldItem = it }
  bot.activateItem = () => { bot.usingHeldItem = true }
  bot.deactivateItem = () => { bot.usingHeldItem = false }
  bot.lookAt = async () => {}
  bot.attack = (e: any) => { swings.push(e.id) }
  bot.game.dimension = 'the_nether'
  const nook = nookAround((p: Vec3) => bot.blockAt(p), stand, new Vec3(0, 0, -1))
  assert.ok(nook != null)
  const ac = new AbortController()
  const done = fightFromNook(bot, nook, { count: 1, spawner: new Vec3(0, 64, 0), maxTicks: 1000 }, ac.signal).catch(err => err)
  const held: string[][] = []
  for (let i = 0; i < 30; i++) { bot.emit('physicsTick'); held.push(engine.leftAloneNames); await new Promise(resolve => setImmediate(resolve)) }
  assert.ok(swings.includes(cube.id), `swings ${swings.join(' ')}`)
  assert.ok(held.some(h => h.includes('magma_cube')))
  ac.abort()
  for (let i = 0; i < 3; i++) { bot.emit('physicsTick'); await new Promise(resolve => setImmediate(resolve)) }
  await done
  assert.deepStrictEqual(engine.leftAloneNames, [])
  engine.stop()
})

test('meleeAimPoint: a blaze hovering in the nook\'s front under its roof\'s edge is looked at low, where the eyes see it', async () => {
  const { fakeBot, entity } = await import('../reflexes/fakeBot')
  const { meleeAimPoint } = await import('../../src/nether/blazeFight')
  // the roof over the stand 0 64 10 at y 66; the blaze in the front cell, its feet at 65.8
  const name = (p: Vec3): string => p.floored().equals(new Vec3(0, 66, 10)) ? 'cobblestone' : p.y < 64 ? 'stone' : 'air'
  const blaze = entity({ name: 'blaze', position: new Vec3(0.5, 65.8, 9.6) })
  const bot = fakeBot({ position: new Vec3(0.5, 64, 10.3), world: name })
  bot.world = {
    raycast: (from: Vec3, dir: Vec3, range: number) => {
      for (let t = 0; t <= range; t += 0.01) {
        const p = from.plus(dir.scaled(t))
        if (name(p) !== 'air') return { position: p.floored(), intersect: p }
      }
      return null
    }
  }
  const p = meleeAimPoint(bot, blaze)
  assert.ok(p.y < 65.8 + 0.9, `aimed at ${p.toString()}`)
  // the middle, when nothing's in the way
  const open = fakeBot({ position: new Vec3(0.5, 64, 10.3) })
  open.world = { raycast: () => null }
  assert.ok(Math.abs(meleeAimPoint(open, blaze).y - (65.8 + 0.9)) < 1e-9)
})

test('fightFromNook without a shield shuts the front when a blaze in sight is about to shoot, and keeps it shut for a volley', async () => {
  const { fakeBot, entity, item } = await import('../reflexes/fakeBot')
  const { fightFromNook, nookAround, BLAZE_CHARGE_TICKS } = await import('../../src/nether/blazeFight')
  const placeModule = require('../../src/skills/placeBlock')
  const stand = new Vec3(0, 64, 10)
  const solid = new Set(['(0, 64, 11)', '(0, 65, 11)', '(1, 64, 10)', '(1, 65, 10)', '(-1, 64, 10)', '(-1, 65, 10)', '(0, 66, 10)'])
  const name = (p: Vec3): string => solid.has(p.floored().toString()) ? 'cobblestone' : p.y < 64 ? 'stone' : 'air'
  const blaze = entity({ name: 'blaze', position: new Vec3(0.5, 65, 2.5), meta: { health: 20, flags: 0 } })
  const bot = fakeBot({ position: new Vec3(0.5, 64, 10.5), items: [item('diamond_sword'), item('cobblestone', 32)], entities: [blaze], world: name })
  bot.world = {
    raycast: (from: Vec3, dir: Vec3, range: number) => {
      for (let t = 0; t <= range; t += 0.02) {
        const p = from.plus(dir.scaled(t))
        if (name(p) !== 'air') return { position: p.floored(), intersect: p }
      }
      return null
    }
  }
  bot.equip = async (it: any) => { bot.heldItem = it }
  bot.activateItem = () => {}
  bot.deactivateItem = () => {}
  bot.lookAt = async () => {}
  bot.game.dimension = 'the_nether'
  const placed: string[] = []
  const dug: string[] = []
  const realPlace = placeModule.placeBlock
  placeModule.placeBlock = async (_b: unknown, a: any) => { solid.add(a.pos.toString()); placed.push(a.pos.toString()) }
  bot.dig = async (b: any) => { solid.delete(b.position.toString()); dug.push(b.position.toString()) }
  const nook = nookAround((p: Vec3) => bot.blockAt(p), stand, new Vec3(0, 0, -1))
  assert.ok(nook != null)
  const ac = new AbortController()
  const done = fightFromNook(bot, nook, { count: 1, spawner: new Vec3(0, 64, 0), maxTicks: 2000 }, ac.signal).catch(err => err)
  const tick = async (n: number): Promise<void> => { for (let i = 0; i < n; i++) { bot.emit('physicsTick'); await new Promise(resolve => setImmediate(resolve)) } }
  try {
    await tick(5)
    blaze.metadata[16] = 1
    await tick(BLAZE_CHARGE_TICKS)
    assert.deepStrictEqual(placed, ['(0, 64, 9)', '(0, 65, 9)'])
    // the flag off: still shut a while
    blaze.metadata[16] = 0
    await tick(20)
    assert.deepStrictEqual(dug, [])
    await tick(120)
    assert.deepStrictEqual(dug, ['(0, 65, 9)', '(0, 64, 9)'])
  } finally {
    ac.abort()
    await tick(3)
    await done
    placeModule.placeBlock = realPlace
  }
})

test('holdOffBlazes: the shield up toward a blaze in sight about to shoot, the bow at it while it rests, never a step toward it; done once none sees the bot', async () => {
  const { fakeBot, entity, item } = await import('../reflexes/fakeBot')
  const { holdOffBlazes } = await import('../../src/nether/blazeFight')
  const blaze = entity({ name: 'blaze', position: new Vec3(0.5, 66, -9.5), meta: { health: 20, flags: 0 } })
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [item('diamond_sword'), item('bow'), item('arrow', 32)], offhand: item('shield'), entities: [blaze] })
  bot.world = { raycast: () => null }
  const log: string[] = []
  bot.equip = async (it: any) => { bot.heldItem = it }
  bot.activateItem = (off = false) => { bot.usingHeldItem = true; log.push(off ? 'shield' : `use ${bot.heldItem?.name as string}`) }
  bot.deactivateItem = () => { bot.usingHeldItem = false; log.push('release') }
  bot.lookAt = async () => {}
  const ac = new AbortController()
  const done = holdOffBlazes(bot, { signal: ac.signal, quietTicks: 10 })
  const tick = async (n: number): Promise<void> => { for (let i = 0; i < n; i++) { bot.emit('physicsTick'); await new Promise(resolve => setImmediate(resolve)) } }
  await tick(25)
  assert.ok(log.includes('use bow'), log.join(' '))
  blaze.metadata[16] = 1
  log.length = 0
  await tick(70)
  assert.ok(log.includes('shield'), log.join(' '))
  assert.ok(!Object.values(bot.controls).some(v => v === true), JSON.stringify(bot.controls))
  delete bot.entities[blaze.id]
  await tick(15)
  const r = await done
  assert.ok(r.ticks < 200, String(r.ticks))
})

test('fightFromNook gives up a spawner no blaze comes from (NOOK_IDLE_TICKS with none within 48), not before', async () => {
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const { fightFromNook, nookAround, NOOK_IDLE_TICKS } = await import('../../src/nether/blazeFight')
  assert.strictEqual(NOOK_IDLE_TICKS, 3000)
  const stand = new Vec3(0, 64, 10)
  const walls = new Set(['(0, 64, 11)', '(0, 65, 11)', '(1, 64, 10)', '(1, 65, 10)', '(-1, 64, 10)', '(-1, 65, 10)', '(0, 66, 10)'])
  const name = (p: Vec3): string => walls.has(p.floored().toString()) ? 'cobblestone' : p.y < 64 ? 'stone' : 'air'
  const bot = fakeBot({ position: new Vec3(0.5, 64, 10.5), items: [item('diamond_sword'), item('bow'), item('arrow', 64)], offhand: item('shield'), world: name })
  bot.world = { raycast: () => null }
  bot.equip = async (it: any) => { bot.heldItem = it }
  bot.lookAt = async () => {}
  bot.game.dimension = 'the_nether'
  const nook = nookAround((p: Vec3) => bot.blockAt(p), stand, new Vec3(0, 0, -1))
  assert.ok(nook != null)
  let settled: unknown = 'running'
  const done = fightFromNook(bot, nook, { count: 1, spawner: new Vec3(0, 64, 0), maxTicks: 1000, idleTicks: 50 }).then(r => { settled = r }, err => { settled = err })
  for (let i = 0; i < 45; i++) { bot.emit('physicsTick'); await new Promise(resolve => setImmediate(resolve)) }
  assert.strictEqual(settled, 'running')
  for (let i = 0; i < 20; i++) { bot.emit('physicsTick'); await new Promise(resolve => setImmediate(resolve)) }
  await done
  assert.match(String((settled as Error)?.message), /no blaze came from the blaze spawner at \(0, 64, 0\) in 50 ticks/)
})

test('fightFromNook: a rod on the floor is gone for between draws while no blaze can shoot, before the bow; the walk stops for a charge with the shield up where the bot is, then goes on to the rod', async () => {
  const { fakeBot, entity, item } = await import('../reflexes/fakeBot')
  const { fightFromNook, nookAround } = await import('../../src/nether/blazeFight')
  const stand = new Vec3(0, 64, 10)
  const walls = new Set(['(0, 64, 11)', '(0, 65, 11)', '(1, 64, 10)', '(1, 65, 10)', '(-1, 64, 10)', '(-1, 65, 10)', '(0, 66, 10)'])
  const name = (p: Vec3): string => walls.has(p.floored().toString()) ? 'cobblestone' : p.y < 64 ? 'stone' : 'air'
  const blaze = entity({ name: 'blaze', position: new Vec3(0.5, 65, 2.5), meta: { health: 20, flags: 0 } })
  const bot = fakeBot({ position: new Vec3(0.5, 64, 10.5), items: [item('diamond_sword'), item('bow'), item('arrow', 64), item('cooked_beef', 16)], offhand: item('shield'), entities: [blaze], world: name })
  const rod = { id: 77, name: 'item', position: new Vec3(0.5, 64, 7.5), getDroppedItem: () => item('blaze_rod') }
  bot.entities[77] = rod
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
  bot.look = async () => {}
  bot.lookAt = async () => {}
  bot.attack = () => {}
  const setControl = bot.setControlState
  bot.setControlState = (k: string, v: boolean) => { if (k === 'forward' && v) log.push('step'); setControl(k, v) }
  // (ticks as the test gives them)
  bot.waitForTicks = async (n: number) => await new Promise<void>(resolve => { let k = 0; const f = (): void => { if (++k >= n) { bot.off('physicsTick', f); resolve() } }; bot.on('physicsTick', f) })
  bot.game.dimension = 'the_nether'
  const nook = nookAround((p: Vec3) => bot.blockAt(p), stand, new Vec3(0, 0, -1))
  assert.ok(nook != null)
  const ac = new AbortController()
  const done = fightFromNook(bot, nook, { count: 1, spawner: new Vec3(0, 64, 0), maxTicks: 2000 }, ac.signal).catch(err => err)
  const tick = async (n: number): Promise<void> => { for (let i = 0; i < n; i++) { bot.emit('physicsTick'); await new Promise(resolve => setImmediate(resolve)) } }
  await tick(20)
  // toward the rod, no draw first (the bow's turn came first: rods were left on the throne for 20000 ticks)
  assert.ok(log.includes('step'), log.join(' '))
  assert.ok(!log.includes('use bow'), log.join(' '))
  // the blaze charges and is about to shoot: the walk stops and the shield goes up where the bot is
  blaze.metadata[16] = 1
  log.length = 0
  await tick(60)
  assert.ok(log.includes('shield'), log.join(' '))
  assert.equal(bot.getControlState('forward'), false)
  // the volley over: on to the rod again, not back to the nook's fight
  blaze.metadata[16] = 0
  log.length = 0
  await tick(FETCH_WAIT)
  assert.ok(log.includes('step'), log.join(' '))
  // picked up
  delete bot.entities[77]
  bot.inventory.slots[30] = item('blaze_rod')
  await tick(10)
  const r = await done
  assert.ok(!(r instanceof Error), String(r))
})

/** ticks for a volley's last fireball's flight and the fetch's quiet to go by */
const FETCH_WAIT = 60

test('fightFromNook gives the nook up (CANNOT_PLACE) when its front won\'t shut, low, SEAL_FAILS times', async () => {
  const { fakeBot, entity, item } = await import('../reflexes/fakeBot')
  const { fightFromNook, nookAround, SEAL_FAILS } = await import('../../src/nether/blazeFight')
  const stand = new Vec3(0, 64, 10)
  const walls = new Set(['(0, 64, 11)', '(0, 65, 11)', '(1, 64, 10)', '(1, 65, 10)', '(-1, 64, 10)', '(-1, 65, 10)', '(0, 66, 10)'])
  const name = (p: Vec3): string => walls.has(p.floored().toString()) ? 'cobblestone' : p.y < 64 ? 'stone' : 'air'
  // a blaze resting off in front, the bot low, every placement turned down by the server
  const blaze = entity({ name: 'blaze', position: new Vec3(0.5, 65, 2.5), meta: { health: 20, flags: 0 } })
  const bot = fakeBot({ position: new Vec3(0.5, 64, 10.5), health: 8, items: [item('diamond_sword'), item('cobblestone', 32)], offhand: item('shield'), entities: [blaze], world: name })
  bot.world = { raycast: () => null }
  bot.placeBlock = async () => { throw new Error('No block has been placed : the block is still air') }
  bot.equip = async (it: any, dest: string) => { if (dest === 'hand') bot.heldItem = it }
  bot.activateItem = () => { bot.usingHeldItem = true }
  bot.deactivateItem = () => { bot.usingHeldItem = false }
  bot.lookAt = async () => {}
  bot.look = async () => {}
  bot.attack = () => {}
  bot.game.dimension = 'the_nether'
  const nook = nookAround((p: Vec3) => bot.blockAt(p), stand, new Vec3(0, 0, -1))
  assert.ok(nook != null)
  const done = fightFromNook(bot, nook, { count: 1, spawner: new Vec3(0, 64, 0), maxTicks: 4000 }).catch(err => err)
  let settled: any = null
  void done.then(r => { settled = r })
  for (let i = 0; i < 1500 && settled == null; i++) { bot.emit('physicsTick'); await new Promise(resolve => setImmediate(resolve)) }
  assert.ok(settled instanceof Error, String(settled))
  assert.match(settled.message, /front .* won't shut/)
  assert.ok(SEAL_FAILS > 1)
})

test('withNookKept keeps the floor under the stand and the front from the pathfinder\'s breaking, with the walls and the roof', async () => {
  const { nookAround, withNookKept } = await import('../../src/nether/blazeFight')
  const w = world()
  const nook = nookAround(w.lookup, new Vec3(0, 64, 10), new Vec3(0, 0, -1))
  assert.ok(nook != null)
  assert.deepEqual(nook.floor.map(p => p.toString()), ['(0, 63, 10)', '(0, 63, 9)'])
  const pathfinder: any = { defaultMoveSettings: { exclusionAreasBreak: [] }, setMoveOptions (s: any) { this.defaultMoveSettings = s } }
  const bot: any = { pathfinder }
  const cost = (p: Vec3): number => pathfinder.defaultMoveSettings.exclusionAreasBreak.reduce((a: number, f: any) => a + f({ position: p }), 0)
  await withNookKept(bot, nook, async () => {
    // seed 7741's bridge: the way to the nook came up through the front's floor
    for (const p of [...nook.floor, ...nook.walls]) assert.ok(cost(p) >= 1e9, p.toString())
    assert.equal(cost(new Vec3(0, 63, 8)), 0)
  })
  assert.equal(pathfinder.defaultMoveSettings.exclusionAreasBreak.length, 0)
})

test('fillNook puts a block in the front\'s floor first when it\'s dug out (nothing beside the front to go against)', async () => {
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const { fillNook } = await import('../../src/nether/blazeFight')
  const placeModule = require('../../src/skills/placeBlock')
  const solid = new Set(['(0, 64, 11)', '(0, 65, 11)', '(1, 64, 10)', '(1, 65, 10)', '(-1, 64, 10)', '(-1, 65, 10)', '(0, 66, 10)'])
  const dugOut = '(0, 63, 9)'
  const name = (p: Vec3): string => solid.has(p.floored().toString()) ? 'cobblestone' : p.y < 64 && p.floored().toString() !== dugOut ? 'stone' : 'air'
  const bot = fakeBot({ position: new Vec3(0.5, 64, 10.5), items: [item('cobblestone', 32)], world: name })
  const placed: string[] = []
  const realPlace = placeModule.placeBlock
  placeModule.placeBlock = async (b: any, a: any) => {
    const p = a.pos as Vec3
    const backed = [p.offset(0, -1, 0), p.offset(0, 1, 0), p.offset(1, 0, 0), p.offset(-1, 0, 0), p.offset(0, 0, 1), p.offset(0, 0, -1)].some(q => b.blockAt(q)?.boundingBox === 'block')
    if (!backed) throw new Error(`nothing solid to place against at ${p.toString()}`)
    solid.add(p.toString())
    placed.push(p.toString())
  }
  try {
    const missed = await fillNook(bot, [new Vec3(0, 64, 9), new Vec3(0, 65, 9)])
    assert.equal(missed, 0)
    assert.deepEqual(placed, ['(0, 63, 9)', '(0, 64, 9)', '(0, 65, 9)'])
  } finally {
    placeModule.placeBlock = realPlace
  }
})

test('meleeWindow: a swing goes with the shield down only while no other blaze that sees the bot can shoot before it is up again, and no fireball is near', async () => {
  const { fakeBot, entity } = await import('../reflexes/fakeBot')
  const { meleeWindow, SHIELD_DELAY_TICKS, SMALL_FIREBALL } = await import('../../src/nether/blazeFight')
  const close = entity({ name: 'blaze', position: new Vec3(0.5, 64.2, 8.6), meta: { health: 20, flags: 0 } })
  const other = entity({ name: 'blaze', position: new Vec3(2.5, 65, 3.5), meta: { health: 20, flags: 0 } })
  const bot = fakeBot({ position: new Vec3(0.5, 64, 10.5), entities: [close, other] })
  const v = new BlazeVolleys()
  v.update([{ id: close.id, charged: false }, { id: other.id, charged: false }], 0)
  assert.ok(meleeWindow(bot, v, 1, [close, other], close))
  // the other charging: its shot 60 ticks off, then near
  v.update([{ id: close.id, charged: false }, { id: other.id, charged: true }], 10)
  assert.ok(meleeWindow(bot, v, 10 + BLAZE_CHARGE_TICKS - SHIELD_LEAD_TICKS, [close, other], close), 'within the shield\'s lead, not yet within its delay')
  assert.ok(!meleeWindow(bot, v, 10 + BLAZE_CHARGE_TICKS - SHIELD_DELAY_TICKS, [close, other], close), 'its shot due before the shield is up')
  // the one in reach charged (within 2 it hits, not shoots): the swing goes
  const v2 = new BlazeVolleys()
  v2.update([{ id: close.id, charged: true }], 0)
  assert.ok(meleeWindow(bot, v2, 0, [close], close))
  // a small fireball coming
  bot.entities[999] = { id: 999, name: SMALL_FIREBALL, position: new Vec3(0.5, 65, 5.5), velocity: new Vec3(0, 0, 0.5) }
  assert.ok(!meleeWindow(bot, v2, 0, [close], close))
})

test('fightFromNook without a shield swings at the blaze in reach while another charges, and a front that won\'t shut is tried again only in a while', async () => {
  const { fakeBot, entity, item } = await import('../reflexes/fakeBot')
  const { fightFromNook, nookAround, SHUT_AGAIN_TICKS } = await import('../../src/nether/blazeFight')
  const placeModule = require('../../src/skills/placeBlock')
  const stand = new Vec3(0, 64, 10)
  const walls = new Set(['(0, 64, 11)', '(0, 65, 11)', '(1, 64, 10)', '(1, 65, 10)', '(-1, 64, 10)', '(-1, 65, 10)', '(0, 66, 10)'])
  const name = (p: Vec3): string => walls.has(p.floored().toString()) ? 'cobblestone' : p.y < 64 ? 'stone' : 'air'
  const close = entity({ name: 'blaze', position: new Vec3(0.5, 64.2, 8.4), meta: { health: 20, flags: 0 } })
  const far = entity({ name: 'blaze', position: new Vec3(0.5, 65, 2.5), meta: { health: 20, flags: 1 } })
  const bot = fakeBot({ position: new Vec3(0.5, 64, 10.5), items: [item('diamond_sword'), item('cobblestone', 32)], entities: [close, far], world: name })
  bot.world = { raycast: () => null }
  bot.equip = async (it: any) => { bot.heldItem = it }
  bot.activateItem = () => {}
  bot.deactivateItem = () => {}
  bot.lookAt = async () => {}
  bot.look = async () => {}
  const swings: number[] = []
  bot.attack = (e: any) => { swings.push(e.id) }
  bot.game.dimension = 'the_nether'
  const tries: string[] = []
  const realPlace = placeModule.placeBlock
  placeModule.placeBlock = async (_b: unknown, a: any) => { tries.push(a.pos.toString()); throw new Error('nothing solid to place against') }
  const nook = nookAround((p: Vec3) => bot.blockAt(p), stand, new Vec3(0, 0, -1))
  assert.ok(nook != null)
  const ac = new AbortController()
  const done = fightFromNook(bot, nook, { count: 1, spawner: new Vec3(0, 64, 0), maxTicks: 2000 }, ac.signal).catch(err => err)
  const tick = async (n: number): Promise<void> => { for (let i = 0; i < n; i++) { bot.emit('physicsTick'); await new Promise(resolve => setImmediate(resolve)) } }
  try {
    await tick(60)
    assert.ok(swings.filter(id => id === close.id).length >= 2, `swings ${swings.join(' ')}`)
    // the blaze in reach gone: the far one's charge, the front tried, and not again for SHUT_AGAIN_TICKS
    delete bot.entities[close.id]
    tries.length = 0
    await tick(SHUT_AGAIN_TICKS - 5)
    assert.ok(tries.length > 0 && tries.length <= 4, `tries ${tries.join(' ')}`)
  } finally {
    ac.abort()
    await tick(3)
    await done
    placeModule.placeBlock = realPlace
  }
})

test('fightFromNook swings at a blaze hovering in the front over the roof\'s edge, whose eyes don\'t see the bot\'s', async () => {
  const { fakeBot, entity, item } = await import('../reflexes/fakeBot')
  const { fightFromNook, nookAround, blazeSeesBot } = await import('../../src/nether/blazeFight')
  const stand = new Vec3(0, 64, 10)
  const walls = new Set(['(0, 64, 11)', '(0, 65, 11)', '(1, 64, 10)', '(1, 65, 10)', '(-1, 64, 10)', '(-1, 65, 10)', '(0, 66, 10)'])
  const name = (p: Vec3): string => walls.has(p.floored().toString()) ? 'cobblestone' : p.y < 64 ? 'stone' : 'air'
  const blaze = entity({ name: 'blaze', position: new Vec3(0.5, 65.3, 9.5), meta: { health: 20, flags: 0 } })
  const bot = fakeBot({ position: new Vec3(0.5, 64, 10.5), items: [item('diamond_sword'), item('cobblestone', 32)], offhand: item('shield'), entities: [blaze], world: name })
  bot.world = {
    raycast: (from: Vec3, dir: Vec3, range: number) => {
      for (let t = 0; t <= range; t += 0.02) {
        const p = from.plus(dir.scaled(t))
        if (name(p) !== 'air') return { position: p.floored(), intersect: p, boundingBox: 'block', name: name(p) }
      }
      return null
    }
  }
  assert.ok(!blazeSeesBot(bot, blaze))
  bot.equip = async (it: any) => { bot.heldItem = it }
  bot.activateItem = () => { bot.usingHeldItem = true }
  bot.deactivateItem = () => { bot.usingHeldItem = false }
  bot.lookAt = async () => {}
  const swings: number[] = []
  bot.attack = (e: any) => { swings.push(e.id) }
  bot.game.dimension = 'the_nether'
  const nook = nookAround((p: Vec3) => bot.blockAt(p), stand, new Vec3(0, 0, -1))
  assert.ok(nook != null)
  const ac = new AbortController()
  const done = fightFromNook(bot, nook, { count: 1, spawner: new Vec3(0, 64, 0), maxTicks: 1000 }, ac.signal).catch(err => err)
  for (let i = 0; i < 40; i++) { bot.emit('physicsTick'); await new Promise(resolve => setImmediate(resolve)) }
  assert.ok(swings.includes(blaze.id), `swings ${swings.join(' ')}`)
  ac.abort()
  for (let i = 0; i < 3; i++) { bot.emit('physicsTick'); await new Promise(resolve => setImmediate(resolve)) }
  await done
})

test('fightFromNook ends (MISSING_ITEMS) with no meal left to heal on and the bar under 18, at NOOK_LEAVE_HEALTH; not with a meal in the bag, nor at full health', async () => {
  const { fakeBot, entity, item } = await import('../reflexes/fakeBot')
  const { fightFromNook, nookAround, mealLeft, NOOK_LEAVE_HEALTH } = await import('../../src/nether/blazeFight')
  const stand = new Vec3(0, 64, 10)
  const walls = new Set(['(0, 64, 11)', '(0, 65, 11)', '(1, 64, 10)', '(1, 65, 10)', '(-1, 64, 10)', '(-1, 65, 10)', '(0, 66, 10)'])
  const name = (p: Vec3): string => walls.has(p.floored().toString()) ? 'cobblestone' : p.y < 64 ? 'stone' : 'air'
  const fight = async (health: number, items: any[]): Promise<unknown> => {
    const blaze = entity({ name: 'blaze', position: new Vec3(0.5, 65, 2.5), meta: { health: 20, flags: 0 } })
    const bot = fakeBot({ position: new Vec3(0.5, 64, 10.5), health, food: 17, saturation: 0, items: [item('diamond_sword'), item('cobblestone', 32), ...items], offhand: item('shield'), entities: [blaze], world: name })
    bot.world = { raycast: () => null }
    bot.equip = async (it: any) => { bot.heldItem = it }
    bot.activateItem = () => { bot.usingHeldItem = true }
    bot.deactivateItem = () => { bot.usingHeldItem = false }
    bot.lookAt = async () => {}
    bot.look = async () => {}
    bot.game.dimension = 'the_nether'
    const nook = nookAround((p: Vec3) => bot.blockAt(p), stand, new Vec3(0, 0, -1))
    assert.ok(nook != null)
    const ac = new AbortController()
    let settled: unknown = null
    void fightFromNook(bot, nook, { count: 1, spawner: new Vec3(0, 64, 0), maxTicks: 1000, eatAt: 0, eatFood: 0 }, ac.signal).catch(err => err).then(r => { settled = r })
    for (let i = 0; i < 20 && settled == null; i++) { bot.emit('physicsTick'); await new Promise(resolve => setImmediate(resolve)) }
    const r = settled
    ac.abort()
    for (let i = 0; i < 3; i++) { bot.emit('physicsTick'); await new Promise(resolve => setImmediate(resolve)) }
    return r
  }
  // (seed 7741's nook: the last meal eaten, 4.9 health for 15000 ticks shut in, then out among 12 blazes)
  const r = await fight(NOOK_LEAVE_HEALTH, [item('rotten_flesh', 3)])
  assert.ok(r instanceof Error && /no food left/.test(r.message), String(r))
  assert.equal(await fight(NOOK_LEAVE_HEALTH, [item('cooked_mutton', 1)]), null)
  assert.equal(await fight(20, []), null)
  const { fakeBot: fb } = await import('../reflexes/fakeBot')
  assert.ok(mealLeft(fb({ items: [item('golden_apple')] })))
  assert.ok(!mealLeft(fb({ items: [item('rotten_flesh', 5), item('spider_eye')] })))
})

/** a snapshot fixture's blocks */
function snapshotLookup (file: string): NookLookup {
  const snap = readNetherSnapshot(path.join(__dirname, '..', 'fixtures', file))
  const mc = require('minecraft-data')(snap.version)
  const [x0, y0, z0] = snap.origin
  const [sx, sy, sz] = snap.size
  return p => {
    const x = p.x - x0; const y = p.y - y0; const z = p.z - z0
    if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) return null
    const b = mc.blocksByStateId[snap.ids[(x * sz + z) * sy + y]]
    return b == null ? null : { name: b.name, boundingBox: b.boundingBox }
  }
}

test('planBlazeNooks at seed 7741\'s fortress spawner (136 77 258, 26.3): on the bridge 10 off facing its throne, seeing 0.4 of its spawns; the melee nook on the throne by it, half its spawns within the sword\'s reach', async () => {
  const { planBlazeNooks, SPAWNER_ACTIVATION } = await import('../../src/nether/blazeFight')
  const lookup = snapshotLookup('nether-seed7741-blaze.json.gz')
  const spawner = new Vec3(136, 77, 258)
  assert.equal(lookup(spawner)?.name, 'spawner')
  // where full-26.3-s7741-b came in
  const from = new Vec3(120.5, 61, 247.5)
  const far = planBlazeNooks(lookup, spawner, { from })
  assert.ok(far.length > 0)
  for (const n of far) {
    assert.equal(n.stand.y, 74, n.stand.toString())
    assert.deepEqual(n.facing, new Vec3(0, 0, -1))
    assert.ok(n.stand.offset(0.5, 0, 0.5).distanceTo(spawner.offset(0.5, 0.5, 0.5)) < SPAWNER_ACTIVATION)
    assert.ok(spawnView(lookup, spawner, n).seen >= 0.4, n.stand.toString())
  }
  const melee = planBlazeNooks(lookup, spawner, { from, melee: true })
  assert.ok(melee.length > 0)
  for (const n of melee) {
    assert.ok(n.stand.distanceTo(spawner) <= 2.3, n.stand.toString())
    assert.equal(n.stand.y, 77)
    assert.ok(spawnView(lookup, spawner, n).reach >= 0.45, n.stand.toString())
  }
})

test('spawnView: a nook facing the spawner on open ground sees most of its spawns, none with the front walled up; planBlazeNooks leaves out a nook seeing fewer than minView', async () => {
  const { planBlazeNooks } = await import('../../src/nether/blazeFight')
  const w = world()
  const nook = nookAround(w.lookup, new Vec3(0, 64, 10), new Vec3(0, 0, -1))
  assert.ok(nook != null)
  const open = spawnView(w.lookup, new Vec3(0, 64, 0), nook)
  assert.ok(open.seen > 0.6 && open.reach === 0, JSON.stringify(open))
  const walled = world(p => p.z === 9 && p.y >= 64 && p.y <= 65 && p.x === 0 ? 'cobblestone' : null)
  assert.equal(spawnView(walled.lookup, new Vec3(0, 64, 0), nook).seen, 0)
  assert.ok(planBlazeNooks(w.lookup, new Vec3(0, 64, 0)).length > 0)
  assert.equal(planBlazeNooks(w.lookup, new Vec3(0, 64, 0), { minView: 0.99 }).length, 0)
})

test('fightFromNook gives a nook up (STUCK) after NOOK_STALL_UNARMED ticks with blazes about but none killed and no arrows; a kill puts it off', async () => {
  const { fakeBot, entity, item } = await import('../reflexes/fakeBot')
  const { fightFromNook, nookAround, NOOK_STALL_UNARMED } = await import('../../src/nether/blazeFight')
  const stand = new Vec3(0, 64, 10)
  const walls = new Set(['(0, 64, 11)', '(0, 65, 11)', '(1, 64, 10)', '(1, 65, 10)', '(-1, 64, 10)', '(-1, 65, 10)', '(0, 66, 10)'])
  const name = (p: Vec3): string => walls.has(p.floored().toString()) ? 'cobblestone' : p.y < 64 ? 'stone' : 'air'
  const blaze = entity({ name: 'blaze', position: new Vec3(0.5, 65, 2.5), meta: { health: 20, flags: 0 } })
  const bot = fakeBot({ position: new Vec3(0.5, 64, 10.5), items: [item('diamond_sword'), item('bow'), item('cobblestone', 32), item('cooked_beef', 16)], offhand: item('shield'), entities: [blaze], world: name })
  bot.world = { raycast: () => null }
  bot.equip = async (it: any) => { bot.heldItem = it }
  bot.activateItem = () => { bot.usingHeldItem = true }
  bot.deactivateItem = () => { bot.usingHeldItem = false }
  bot.lookAt = async () => {}
  bot.look = async () => {}
  bot.game.dimension = 'the_nether'
  const nook = nookAround((p: Vec3) => bot.blockAt(p), stand, new Vec3(0, 0, -1))
  assert.ok(nook != null)
  let settled: any = null
  void fightFromNook(bot, nook, { count: 1, spawner: new Vec3(0, 64, 0), maxTicks: 5000 }).catch(err => err).then(r => { settled = r })
  const tick = async (n: number): Promise<void> => { for (let i = 0; i < n && settled == null; i++) { bot.emit('physicsTick'); await new Promise(resolve => setImmediate(resolve)) } }
  await tick(NOOK_STALL_UNARMED - 100)
  assert.equal(settled, null)
  // a kill: the count starts again
  const other = entity({ name: 'blaze', position: new Vec3(0.5, 65, 3.5), meta: { health: 0, flags: 0 } })
  bot.emit('entityDead', other)
  await tick(NOOK_STALL_UNARMED - 100)
  assert.equal(settled, null)
  await tick(300)
  assert.ok(settled instanceof Error && settled.message.includes('no blaze killed'), String(settled))
})

test('nookAround takes no fence for a wall (a fireball goes between its posts): a nook with one at its head is none, with a full block there it is', () => {
  const at = (name: string): NookLookup => world(p => p.x === 1 && p.y === 65 && p.z === 10 ? name : null).lookup
  assert.equal(nookAround(at('nether_brick_fence'), new Vec3(0, 64, 10), new Vec3(0, 0, -1)), null)
  assert.equal(nookAround(at('cobblestone_wall'), new Vec3(0, 64, 10), new Vec3(0, 0, -1)), null)
  const nook = nookAround(at('nether_bricks'), new Vec3(0, 64, 10), new Vec3(0, 0, -1))
  assert.ok(nook != null && !nook.build.some(p => p.equals(new Vec3(1, 65, 10))))
})

test('fillNook fights off a blaze on the bot (within 3) before the next block, and builds on (nether-26.3-q3: two deaths building the melee nook among the spawner\'s blazes)', async () => {
  const { fillNook } = await import('../../src/nether/blazeFight')
  const fightModule = require('../../src/skills/fight')
  const placeModule = require('../../src/skills/placeBlock')
  const { fakeBot: fb, item: it, entity: en } = await import('../reflexes/fakeBot')
  const blaze = en({ name: 'blaze', position: new Vec3(1.5, 64, 0.5) })
  const bot = fb({ items: [it('cobblestone', 16)], entities: [blaze] })
  ;(bot as any).world = { raycast: () => null }
  const order: string[] = []
  const realFight = fightModule.fight
  const realPlace = placeModule.placeBlock
  fightModule.fight = async (_b: unknown, t: any) => { order.push(`fight ${t.name}`); delete bot.entities[t.id] ; return { killed: true, hits: 3, ticks: 30, lastPosition: t.position } }
  placeModule.placeBlock = async (_b: unknown, a: any) => { order.push(`place ${a.pos.toString()}`); return { pos: a.pos, block: a.item, placed: true } }
  try {
    assert.equal(await fillNook(bot, [new Vec3(-1, 64, 0), new Vec3(0, 64, -1)]), 0)
  } finally {
    fightModule.fight = realFight
    placeModule.placeBlock = realPlace
  }
  assert.deepEqual(order, ['fight blaze', 'place (-1, 64, 0)', 'place (0, 64, -1)'])
})

test('fillNook with a shield: a blaze in sight about to shoot is taken on the shield, faced, before the next block goes in, and the block after its volley', async () => {
  const { fillNook } = await import('../../src/nether/blazeFight')
  const placeModule = require('../../src/skills/placeBlock')
  const { fakeBot: fb, item: it, entity: en } = await import('../reflexes/fakeBot')
  // charged (first seen so: it may shoot at once), 6 off
  const blaze = en({ name: 'blaze', position: new Vec3(0.5, 64, 6.5), meta: { health: 20, flags: 1 } })
  const bot = fb({ items: [it('cobblestone', 16), it('stone_sword')], offhand: it('shield'), entities: [blaze] })
  ;(bot as any).world = { raycast: () => null }
  bot.equip = async (i: any, dest: string) => { if (dest === 'hand') bot.heldItem = i }
  const order: string[] = []
  bot.activateItem = () => { bot.usingHeldItem = true; order.push('shield') }
  bot.deactivateItem = () => { bot.usingHeldItem = false; order.push('down') }
  let looked: Vec3 | null = null
  bot.lookAt = async (p: Vec3) => { looked = p }
  const realPlace = placeModule.placeBlock
  placeModule.placeBlock = async (_b: unknown, a: any) => { order.push(`place ${a.pos.toString()}`); return { pos: a.pos, block: a.item, placed: true } }
  const ticking = setInterval(() => bot.emit('physicsTick'), 1)
  try {
    const done = fillNook(bot, [new Vec3(-1, 64, 0)])
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.deepEqual(order, ['shield'], 'behind the shield, no block yet')
    assert.ok(looked != null && (looked as Vec3).z > 6, 'faced at it')
    // its volley over (the flag off) and its fireballs' flight gone by
    blaze.metadata[16] = 0
    assert.equal(await done, 0)
  } finally {
    clearInterval(ticking)
    placeModule.placeBlock = realPlace
  }
  assert.deepEqual(order, ['shield', 'down', 'place (-1, 64, 0)'])
})

test('openNook digs out only the blocks a nook is shut with: a spawner in its front is left be', async () => {
  const { openNook, nookAround } = await import('../../src/nether/blazeFight')
  const actions = require('../../src/core/actions')
  const { fakeBot: fb } = await import('../reflexes/fakeBot')
  // the front (0 64 9) the spawner, its head (0 65 9) cobblestone
  const bot = fb({ position: new Vec3(0.5, 64, 10.5), world: (p: Vec3) => p.y < 64 ? 'stone' : p.x === 0 && p.z === 9 ? (p.y === 64 ? 'spawner' : p.y === 65 ? 'cobblestone' : 'air') : 'air' })
  const blockAt = bot.blockAt
  bot.blockAt = (p: Vec3) => { const b = blockAt(p); return b.name === 'spawner' ? { ...b, boundingBox: 'block' } : b }
  const nook = nookAround((p: Vec3) => bot.blockAt(p), new Vec3(0, 64, 10), new Vec3(0, 0, -1))
  assert.ok(nook != null)
  const dug: string[] = []
  const realDig = actions.dig
  actions.dig = async (_b: unknown, block: any) => { dug.push(`${block.name as string} ${block.position.toString() as string}`) }
  try {
    await openNook(bot, nook)
  } finally {
    actions.dig = realDig
  }
  assert.deepEqual(dug, ['cobblestone (0, 65, 9)'])
})
