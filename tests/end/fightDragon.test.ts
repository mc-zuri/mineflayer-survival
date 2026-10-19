import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { exitPortal } from '../../src/end/spikes'
import { breathZone, DragonPhaseTracker, DRAGON_PHASES, headPosition } from '../../src/end/dragon'
import { chooseMeleeSpot, dragonPartId, fightDragon } from '../../src/end/skills/fightDragon'
import { fakeBot } from '../reflexes/fakeBot'
import { endIsland, world } from './endWorld'

test('dragonPartId: the head is the id after the dragon\'s (EnderDragon.setId)', () => {
  assert.strictEqual(dragonPartId({ id: 40 }), 41)
  assert.strictEqual(dragonPartId({ id: 40 }, 'body'), 43)
})

test('chooseMeleeSpot: a standing spot within reach of the perched dragon\'s head, out of the breath it is about to breathe', () => {
  const blocks = endIsland([], 40)
  const get = world(blocks)
  const perch = exitPortal(62).perch
  // facing +x: vanilla yaw 90 (the head along (sin, -cos) = (1, 0))
  const view = { position: new Vec3(perch.x, perch.y, perch.z), yaw: 90 }
  const tracker = new DragonPhaseTracker(perch)
  tracker.update({ tick: 0, phase: DRAGON_PHASES.indexOf('sitting_scanning'), position: view.position, yaw: 90 })
  const scanning = chooseMeleeSpot(get, view, 62, tracker.window(5), [], null)
  assert.ok(scanning != null)
  assert.strictEqual(scanning.target, 'head')
  const head = headPosition(view)
  assert.ok(Math.hypot(scanning.spot.x - head.x, scanning.spot.z - head.z) < 3.5)
  // flaming: the cloud past the head; the spot left is by the body, outside it
  tracker.update({ tick: 10, phase: DRAGON_PHASES.indexOf('sitting_flaming'), position: view.position, yaw: 90 })
  const window = tracker.window(12)
  const flaming = chooseMeleeSpot(get, view, 62, window, [], null)
  assert.ok(flaming != null)
  const breath = breathZone(view)
  assert.ok(Math.hypot(flaming.spot.x - breath.center.x, flaming.spot.z - breath.center.z) > breath.radius)
})

test('fightDragon waits for the podium\'s chunk to find the exit portal, and is done at once when the portal is open and no dragon is left', async () => {
  const blocks = endIsland([], 30)
  for (const p of exitPortal(62).portal) blocks.set(`${p.x},${p.y},${p.z}`, 'end_portal')
  const get = world(blocks)
  let ticks = 0
  const bot = fakeBot({ position: new Vec3(10.5, 62, 0.5) })
  bot.game.dimension = 'the_end'
  bot.game.minY = 0
  // the column at 0, 0 unloaded for the first 30 ticks
  bot.blockAt = (pos: Vec3) => {
    const p = pos.floored()
    if (ticks < 30 && Math.abs(p.x) < 16 && Math.abs(p.z) < 16) return null
    const b = get(p)
    return b == null ? null : { ...b, position: p }
  }
  bot.waitForTicks = async () => { ticks++; bot.emit('physicsTick') }
  const result = await fightDragon(bot, { destroyCrystals: false, maxTicks: 50 })
  assert.ok(result.killed)
  assert.ok(ticks >= 30)
})

test('the end milestone gets a bow and arrows before the End, not optional: no bow is no way in', async () => {
  const { endHandler, END_ARROWS } = await import('../../src/milestones')
  const { WorldMemory } = await import('../../src/core/memory')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const bot = fakeBot({ items: [item('arrow', 64)] })
  bot.game.dimension = 'overworld'
  const calls: string[] = []
  const executor: any = {
    memory: new WorldMemory(),
    tasks: { tick: 0 },
    obtain: async (reqs: any[]) => {
      calls.push(reqs.map(r => `${r.item}${r.optional === true ? '?' : ''}`).join(','))
      if (reqs.some(r => r.item === 'bow' && r.optional !== true)) throw new Error('NOT_FOUND: no string')
    },
    task: async (name: string) => { calls.push(name) }
  }
  await assert.rejects(endHandler({ bot, executor, signal: new AbortController().signal, log: () => {}, milestone: { goals: () => [{ item: 'bow', count: 1 }] } as any, state: null as any }), /no string/)
  assert.deepStrictEqual(calls, ['bow?', 'bow,arrow'])
  assert.ok(END_ARROWS > 0)
})

test('in the End with few blocks and a full bag, room is made before the end stone is dug', async () => {
  const { endHandler } = await import('../../src/milestones')
  const { WorldMemory } = await import('../../src/core/memory')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const bot = fakeBot({ items: [item('bow', 1), item('arrow', 64), item('cobblestone', 15)] })
  bot.game.dimension = 'the_end'
  ;(bot.inventory as any).emptySlotCount = () => 0
  const calls: string[] = []
  const executor: any = {
    memory: new WorldMemory(),
    tasks: { tick: 0 },
    makeRoom: async (_n: unknown, _s: unknown, force: boolean) => { calls.push(`room ${String(force)}`) },
    obtain: async () => {},
    task: async (name: string) => { calls.push(name); if (name === 'fight the dragon') throw new Error('stop here') }
  }
  await assert.rejects(endHandler({ bot, executor, signal: new AbortController().signal, log: () => {}, milestone: { goals: () => [] } as any, state: null as any }), /stop here/)
  assert.ok(calls.indexOf('room true') >= 0 && calls.indexOf('room true') < calls.indexOf('end stone'), calls.join(', '))
})

test('endStoneTopLayer: the island\'s top layer round the bot, not under it nor below it', async () => {
  const { endStoneTopLayer } = await import('../../src/milestones')
  const { fakeBot } = await import('../reflexes/fakeBot')
  const { Vec3 } = await import('vec3')
  const bot = fakeBot({ position: new Vec3(0.5, 60, 0.5), world: (p: any) => p.y < 60 ? 'end_stone' : 'air' })
  const id = bot.registry.blocksByName.end_stone.id
  bot.findBlocks = () => { const out: any[] = []; for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) for (const y of [59, 58]) out.push(new Vec3(x, y, z)); return out } 
  const top = endStoneTopLayer(bot, 10)
  assert.equal(top.length, 10)
  for (const p of top) {
    assert.equal(p.y, 59)
    assert.ok(Math.hypot(p.x, p.z) >= 2, p.toString())
  }
  assert.ok(id != null)
})
