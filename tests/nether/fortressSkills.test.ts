import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { campSpots, levelSeed, seesFrom } from '../../src/nether/fortressSkills'
import { parseSeed } from '../../src/worldgen/random'
import { fakeBot } from '../reflexes/fakeBot'

test('levelSeed reads text as the server does', () => {
  assert.equal(levelSeed('4'), parseSeed('4'))
  assert.equal(levelSeed(4n), 4n)
})

test('campSpots: floor cells 3 or more from the spawner that see it, not through a wall', () => {
  // a floor at y 63, the spawner at (0, 64, 0), a wall at x = 4 from y 64 up
  const bot = fakeBot({ position: new Vec3(0.5, 64, 6.5), world: p => p.y < 64 ? 'stone' : (p.x === 4 && p.y < 67 ? 'stone' : 'air') })
  bot.blockAt = ((orig) => (p: Vec3) => { const b = orig(p); if (p.x === 0 && p.y === 64 && p.z === 0) return { ...b, name: 'spawner', boundingBox: 'block' }; return b })(bot.blockAt)
  bot.world = {
    raycast: (from: Vec3, dir: Vec3, range: number) => {
      for (let t = 0; t <= range; t += 0.05) {
        const p = from.plus(dir.scaled(t))
        const b = bot.blockAt(p)
        if (b.boundingBox === 'block') return { position: p.floored(), intersect: p }
      }
      return null
    }
  }
  const spots = campSpots(bot, new Vec3(0, 64, 0), 5)
  assert.ok(spots.length > 0)
  for (const s of spots) {
    assert.ok(Math.hypot(s.x, s.z) >= 3, `${s.toString()} is too near`)
    assert.ok(s.x < 4, `${s.toString()} is behind the wall`)
    assert.equal(s.y, 64)
  }
  assert.equal(seesFrom(bot, new Vec3(6.5, 65.62, 0.5), new Vec3(0.5, 64.5, 0.5), new Vec3(0, 64, 0)), false)
})

test('nextCampSpot: the first untried spot that sees a blaze, else the first untried, else none', async () => {
  const { nextCampSpot } = await import('../../src/nether/fortressSkills')
  // a wall at x = 4 from y 64 up: a blaze behind it at x 8 is seen only from spots past it
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), world: p => p.y < 64 ? 'stone' : (p.x === 4 && p.y < 70 ? 'stone' : 'air') })
  bot.world = {
    raycast: (from: Vec3, dir: Vec3, range: number) => {
      for (let t = 0; t <= range; t += 0.05) {
        const p = from.plus(dir.scaled(t))
        if (bot.blockAt(p).boundingBox === 'block') return { position: p.floored(), intersect: p }
      }
      return null
    }
  }
  const spots = [new Vec3(0, 64, 0), new Vec3(1, 64, 2), new Vec3(6, 64, 0)]
  const blaze = [new Vec3(8.5, 65, 0.5)]
  assert.deepEqual(nextCampSpot(bot, spots, blaze, new Set()), new Vec3(6, 64, 0))
  assert.deepEqual(nextCampSpot(bot, spots, blaze, new Set(['(6, 64, 0)'])), new Vec3(0, 64, 0))
  assert.equal(nextCampSpot(bot, spots, blaze, new Set(spots.map(s => s.toString()))), null)
})

test('collectBlazeRods backs off 36 blocks along the way the bot came to heal when low, then fights on', async () => {
  const gridModule = require('../../src/skills/gridWalk')
  const eatModule = require('../../src/skills/eat')
  const { collectBlazeRods } = await import('../../src/nether/fortressSkills')
  const bot = fakeBot({ position: new Vec3(40.5, 64, 0.5), world: (p: any) => p.y < 64 ? 'netherrack' : 'air' })
  bot.game.dimension = 'the_nether'
  ;(bot as any).health = 6
  ;(bot as any).food = 18
  ;(bot as any).world = { raycast: () => null }
  bot.findBlocks = () => []
  const moves: string[] = []
  const realMove = gridModule.moveNear
  const realEat = eatModule.eat
  gridModule.moveNear = async (_b: unknown, to: Vec3) => { moves.push(to.toString()) }
  eatModule.eat = async () => { (bot as any).health = 20 }
  const ticking = setInterval(() => bot.emit('physicsTick'), 1)
  try {
    await assert.rejects(collectBlazeRods(bot, { count: 8, spawner: new Vec3(0, 64, 0), maxTicks: 300, safety: false }), /TIMEOUT|blaze rods/)
  } finally {
    clearInterval(ticking)
    gridModule.moveNear = realMove
    eatModule.eat = realEat
  }
  // a move 36 off the spawner, along the way the bot came (+x)
  assert.ok(moves.some(m => { const [x, , z] = m.replace(/[()]/g, '').split(',').map(Number); return x >= 30 && Math.abs(z) <= 2 }), moves.slice(0, 4).join(' | '))
})

test('the blaze fight is cut off when the health falls to the retreat, 12 among three blazes or more', async () => {
  const { retreatHealth, collectBlazeRods } = await import('../../src/nether/fortressSkills')
  assert.equal(retreatHealth(1), 8)
  assert.equal(retreatHealth(3), 12)
  assert.equal(retreatHealth(5, 6), 6)
  const fightModule = require('../../src/skills/fight')
  const gridModule = require('../../src/skills/gridWalk')
  const bot = fakeBot({ position: new Vec3(3.5, 64, 0.5), world: (p: any) => p.y < 64 ? 'netherrack' : 'air' })
  bot.game.dimension = 'the_nether'
  ;(bot as any).health = 20
  ;(bot as any).food = 20
  ;(bot as any).world = { raycast: () => null }
  bot.findBlocks = () => []
  bot.entities[9] = { id: 9, name: 'blaze', type: 'hostile', position: new Vec3(4.5, 64, 0.5), metadata: [] } as any
  ;(bot as any).lookAt = async () => {}
  ;(bot as any).activateItem = () => {}
  ;(bot as any).deactivateItem = () => {}
  const realFight = fightModule.fight
  const realMove = gridModule.moveNear
  let cut = false
  fightModule.fight = async (_b: unknown, _t: unknown, o: any) => await new Promise((_resolve, reject) => {
    o.signal.addEventListener('abort', () => { cut = true; reject(o.signal.reason) })
    setTimeout(() => { (bot as any).health = 7; bot.emit('health') }, 20)
  })
  const moves: string[] = []
  gridModule.moveNear = async (_b: unknown, to: Vec3) => { moves.push(to.toString()) }
  const ticking = setInterval(() => bot.emit('physicsTick'), 1)
  try {
    await assert.rejects(collectBlazeRods(bot, { count: 8, spawner: new Vec3(0, 64, 0), maxTicks: 200, safety: false }), /TIMEOUT|rods/)
  } finally {
    clearInterval(ticking)
    fightModule.fight = realFight
    gridModule.moveNear = realMove
  }
  assert.ok(cut)
})

test('the blaze fight camps 9 off the spawner by default, out of its swarm', async () => {
  const { BLAZE_STAND_OFF } = await import('../../src/nether/fortressSkills')
  assert.ok(BLAZE_STAND_OFF >= 8)
  const bot = fakeBot({ position: new Vec3(0.5, 64, 12.5), world: (p: any) => p.y < 64 ? 'stone' : 'air' })
  bot.world = { raycast: () => null }
  const spots = campSpots(bot, new Vec3(0, 64, 0), BLAZE_STAND_OFF)
  assert.ok(spots.length > 0)
  assert.ok(Math.hypot(spots[0].x, spots[0].z) >= BLAZE_STAND_OFF - 1, spots[0].toString())
})

test('collectBlazeRods leaves the blazes and the meals to itself: the hostiles reflex sees no blaze and the eat reflex waits, till it ends', async () => {
  const { collectBlazeRods } = await import('../../src/nether/fortressSkills')
  const { ReflexEngine } = await import('../../src/reflexes/engine')
  const gridModule = require('../../src/skills/gridWalk')
  const bot = fakeBot({ position: new Vec3(9.5, 64, 0.5), world: (p: any) => p.y < 64 ? 'stone' : 'air' })
  bot.game.dimension = 'the_nether'
  ;(bot as any).world = { raycast: () => null }
  bot.findBlocks = () => []
  const engine = new ReflexEngine(bot, { reflexes: [] })
  bot.survival = { reflexes: engine }
  const realMove = gridModule.moveNear
  gridModule.moveNear = async () => {}
  const held: string[][] = []
  const onTick = (): void => { held.push([...engine.leftAloneNames, ...engine.inhibitedNames]) }
  bot.on('physicsTick', onTick)
  const ticking = setInterval(() => bot.emit('physicsTick'), 1)
  try {
    await assert.rejects(collectBlazeRods(bot, { count: 2, spawner: new Vec3(0, 64, 0), maxTicks: 40, safety: false }), /TIMEOUT|rods/)
  } finally {
    clearInterval(ticking)
    bot.off('physicsTick', onTick)
    gridModule.moveNear = realMove
    engine.stop()
  }
  assert.ok(held.some(h => h.includes('blaze') && h.includes('eat')), JSON.stringify(held.slice(0, 3)))
  assert.deepStrictEqual(engine.leftAloneNames, [])
  assert.deepStrictEqual(engine.inhibitedNames, [])
})

test('collectBlazeRods fights from a nook by the spawner when the bag has the blocks for one, the camp\'s fight when it hasn\'t', async () => {
  const { collectBlazeRods } = await import('../../src/nether/fortressSkills')
  const fightModule = require('../../src/nether/blazeFight')
  const gridModule = require('../../src/skills/gridWalk')
  const { item } = await import('../reflexes/fakeBot')
  const realBuild = fightModule.buildNook
  const realFight = fightModule.fightFromNook
  const realMove = gridModule.moveNear
  const built: any[] = []
  fightModule.buildNook = async (_b: unknown, nook: any) => { built.push(nook) }
  try {
    const bot = fakeBot({ position: new Vec3(0.5, 64, 12.5), items: [item('cobblestone', 64)], world: (p: any) => p.y < 64 ? 'stone' : 'air' })
    bot.game.dimension = 'the_nether'
    ;(bot as any).world = { raycast: () => null }
    bot.findBlocks = () => []
    fightModule.fightFromNook = async () => { bot.inventory.slots[20] = item('blaze_rod'); return { kills: 1, shots: 2, blocked: 0, ticks: 10 } }
    const r = await collectBlazeRods(bot, { count: 1, spawner: new Vec3(0, 64, 0), maxTicks: 100, safety: false })
    assert.equal(r.rods, 1)
    assert.equal(built.length, 1)
    const h = Math.hypot(built[0].stand.x, built[0].stand.z)
    assert.ok(h >= 7 && h <= 13, built[0].stand.toString())

    // no blocks: the camp
    const bare = fakeBot({ position: new Vec3(0.5, 64, 12.5), world: (p: any) => p.y < 64 ? 'stone' : 'air' })
    bare.game.dimension = 'the_nether'
    ;(bare as any).world = { raycast: () => null }
    bare.findBlocks = () => []
    const moves: string[] = []
    gridModule.moveNear = async (_b: unknown, to: Vec3) => { moves.push(to.toString()) }
    const ticking = setInterval(() => bare.emit('physicsTick'), 1)
    try {
      await assert.rejects(collectBlazeRods(bare, { count: 1, spawner: new Vec3(0, 64, 0), maxTicks: 30, safety: false }), /TIMEOUT|rods/)
    } finally {
      clearInterval(ticking)
    }
    assert.equal(built.length, 1)
    assert.ok(moves.length > 0)
  } finally {
    fightModule.buildNook = realBuild
    fightModule.fightFromNook = realFight
    gridModule.moveNear = realMove
  }
})

test('spareShield makes shields up to two while there are an iron ingot and wood, and none without', async () => {
  const { spareShield } = await import('../../src/nether/fortressSkills')
  const craftModule = require('../../src/skills/craft')
  const { item } = await import('../reflexes/fakeBot')
  const real = craftModule.craft
  const made: string[] = []
  try {
    const bot = fakeBot({ items: [item('oak_log', 4), item('iron_ingot', 3)], offhand: item('shield') })
    craftModule.craft = async (_b: unknown, a: any) => { made.push(a.item); bot.inventory.slots[30] = item('shield') }
    assert.equal(await spareShield(bot), 1)
    assert.deepStrictEqual(made, ['shield'])
    const poor = fakeBot({ items: [item('oak_log', 4)] })
    assert.equal(await spareShield(poor), 0)
  } finally {
    craftModule.craft = real
  }
})

test('collectBlazeRods with no way to a camp by the spawner, no blaze in sight, 3 times running: a trip and a tunnel toward it once, then given up as one there\'s no way to, remembered so', async () => {
  const { WorldMemory } = await import('../../src/core/memory')
  const { collectBlazeRods, CAMP_FAILS, UNREACHABLE_SPAWNER, unreachableSpawners } = await import('../../src/nether/fortressSkills')
  const gridModule = require('../../src/skills/gridWalk')
  const tunnelModule = require('../../src/skills/tunnel')
  const travelModule = require('../../src/skills/travel')
  const bot = fakeBot({ position: new Vec3(-8.5, 77, 3.5), world: (p: any) => p.y < 77 ? 'netherrack' : 'air' })
  bot.game.dimension = 'the_nether'
  ;(bot as any).world = { raycast: () => null }
  bot.findBlocks = () => []
  const memory = new WorldMemory()
  memory.addPoi('blaze_spawner', { x: 0, y: 64, z: 0 }, 'the_nether')
  ;(bot as any).survival = { memory }
  const moves: string[] = []
  const tunnels: string[] = []
  const realMove = gridModule.moveNear
  const realTunnel = tunnelModule.tunnelTo
  const realTravel = travelModule.travel
  travelModule.travel = async (_b: unknown, args: any) => { tunnels.push(`trip ${String(args.target)} ${String(args.range)} ${String(args.exactY)}`); throw new Error('NO_PATH: no way on') }
  gridModule.moveNear = async (_b: unknown, to: Vec3) => { moves.push(to.toString()); throw Object.assign(new Error('NO_PATH: no path'), { code: 'NO_PATH' }) }
  tunnelModule.tunnelTo = async (_b: unknown, args: any) => { tunnels.push(`tunnel ${String(args.target)}`); throw new Error('NO_PATH: lava in the way') }
  const ticking = setInterval(() => bot.emit('physicsTick'), 1)
  try {
    await assert.rejects(collectBlazeRods(bot, { count: 8, spawner: new Vec3(0, 64, 0), maxTicks: 20000, nook: false, safety: false }), /no way to the blaze spawner at \(0, 64, 0\)/)
  } finally {
    clearInterval(ticking)
    gridModule.moveNear = realMove
    tunnelModule.tunnelTo = realTunnel
    travelModule.travel = realTravel
  }
  assert.equal(CAMP_FAILS, 3)
  // a trip to its height in hops first, then a staircase dug, once each
  assert.deepEqual(tunnels, ['trip (0, 64, 0) 11 true', 'tunnel (0, 64, 0)'])
  assert.deepEqual(memory.getPois('blaze_spawner', { dimension: 'the_nether' }), [])
  assert.deepEqual(unreachableSpawners(bot).map(p => [p.x, p.y, p.z]), [[0, 64, 0]])
  assert.equal(memory.getPois(UNREACHABLE_SPAWNER, { dimension: 'the_nether' }).length, 1)
  // the camp tried each time (the spawner itself: no spot by it sees it in this rock)
  assert.equal(moves.length, CAMP_FAILS, moves.join(' | '))
})

test('a spawner the bot found no way to: one near it is the same, a fortress round it the same', async () => {
  const { excludedSpawner, excludedFortress } = await import('../../src/nether/fortressSkills')
  const out = [{ x: 870, y: 76, z: 143 }]
  assert.equal(excludedSpawner({ x: 872, y: 76, z: 145 }, out), true)
  assert.equal(excludedSpawner({ x: 870, y: 64, z: 180 }, out), false)
  assert.equal(excludedFortress({ min: { x: 840, y: 48, z: 60 }, max: { x: 900, y: 90, z: 120 } }, out), true)
  assert.equal(excludedFortress({ min: { x: 300, y: 48, z: 60 }, max: { x: 400, y: 90, z: 120 } }, out), false)
})

test('collectBlazeRods ends with the nook\'s fight when it runs out of food to heal on, no camp\'s fight after it', async () => {
  const { collectBlazeRods } = await import('../../src/nether/fortressSkills')
  const { SkillError } = await import('../../src/skills/errors')
  const fightModule = require('../../src/nether/blazeFight')
  const gridModule = require('../../src/skills/gridWalk')
  const { item } = await import('../reflexes/fakeBot')
  const realBuild = fightModule.buildNook
  const realFight = fightModule.fightFromNook
  const realMove = gridModule.moveNear
  const moves: string[] = []
  fightModule.buildNook = async () => {}
  gridModule.moveNear = async (_b: unknown, to: Vec3) => { moves.push(to.toString()) }
  try {
    const bot = fakeBot({ position: new Vec3(0.5, 64, 12.5), items: [item('cobblestone', 64)], world: (p: any) => p.y < 64 ? 'stone' : 'air' })
    bot.game.dimension = 'the_nether'
    ;(bot as any).world = { raycast: () => null }
    bot.findBlocks = () => []
    fightModule.fightFromNook = async () => { throw new SkillError('MISSING_ITEMS', 'no food left to heal on in the nook, health 12.0') }
    await assert.rejects(collectBlazeRods(bot, { count: 1, spawner: new Vec3(0, 64, 0), maxTicks: 100, safety: false }), /no food left/)
    assert.deepEqual(moves, [])
  } finally {
    fightModule.buildNook = realBuild
    fightModule.fightFromNook = realFight
    gridModule.moveNear = realMove
  }
})

