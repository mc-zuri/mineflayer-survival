import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { campSpots, levelSeed, seesFrom } from '../../src/nether/fortressSkills'
import { parseSeed } from '../../src/worldgen/random'
import { fakeBot, item } from '../reflexes/fakeBot'

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

test('collectBlazeRods fights from a nook by the spawner when the bag has the blocks for one (the bow\'s 7 to 13 off with the arrows for it, the melee one by the spawner without), the camp\'s fight when it hasn\'t', async () => {
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
    const bot = fakeBot({ position: new Vec3(0.5, 64, 12.5), items: [item('cobblestone', 64), item('bow'), item('arrow', 64)], world: (p: any) => p.y < 64 ? 'stone' : 'air' })
    bot.game.dimension = 'the_nether'
    ;(bot as any).world = { raycast: () => null }
    bot.findBlocks = () => []
    fightModule.fightFromNook = async () => { bot.inventory.slots[20] = item('blaze_rod'); return { kills: 1, shots: 2, blocked: 0, ticks: 10 } }
    const r = await collectBlazeRods(bot, { count: 1, spawner: new Vec3(0, 64, 0), maxTicks: 100, safety: false, bunker: false })
    assert.equal(r.rods, 1)
    assert.equal(built.length, 1)
    const h = Math.hypot(built[0].stand.x, built[0].stand.z)
    assert.ok(h >= 7 && h <= 13, built[0].stand.toString())
    // 12 arrows: the melee nook
    const few = fakeBot({ position: new Vec3(0.5, 64, 12.5), items: [item('cobblestone', 64), item('bow'), item('arrow', 12)], world: (p: any) => p.y < 64 ? 'stone' : 'air' })
    few.game.dimension = 'the_nether'
    ;(few as any).world = { raycast: () => null }
    few.findBlocks = () => []
    fightModule.fightFromNook = async () => { few.inventory.slots[20] = item('blaze_rod'); return { kills: 1, shots: 0, blocked: 0, ticks: 10 } }
    await collectBlazeRods(few, { count: 1, spawner: new Vec3(0, 64, 0), maxTicks: 100, safety: false, bunker: false })
    assert.equal(built.length, 2)
    assert.ok(Math.hypot(built[1].stand.x, built[1].stand.z) <= 5, built[1].stand.toString())
    built.length = 1

    // no blocks: the camp
    const bare = fakeBot({ position: new Vec3(0.5, 64, 12.5), world: (p: any) => p.y < 64 ? 'stone' : 'air' })
    bare.game.dimension = 'the_nether'
    ;(bare as any).world = { raycast: () => null }
    bare.findBlocks = () => []
    const moves: string[] = []
    gridModule.moveNear = async (_b: unknown, to: Vec3) => { moves.push(to.toString()) }
    const ticking = setInterval(() => bare.emit('physicsTick'), 1)
    try {
      await assert.rejects(collectBlazeRods(bare, { count: 1, spawner: new Vec3(0, 64, 0), maxTicks: 30, safety: false, bunker: false }), /TIMEOUT|rods/)
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

test('spareShield smelts the raw iron for a shield when the bag has no ingot (a furnace carried, the fuel not the wood), then makes it; not with a shield or two in hand', async () => {
  const { spareShield, BLAZE_SHIELDS } = await import('../../src/nether/fortressSkills')
  const craftModule = require('../../src/skills/craft')
  const smeltModule = require('../../src/skills/smelt')
  const { item } = await import('../reflexes/fakeBot')
  const realCraft = craftModule.craft
  const realSmelt = smeltModule.smelt
  const log: string[] = []
  try {
    // full-26.3-s7741-b's bag at the fortress
    const bot = fakeBot({ items: [item('oak_log', 35), item('raw_iron', 3), item('coal', 16), item('furnace')] })
    smeltModule.smelt = async (_b: unknown, a: any) => {
      log.push(`smelt ${a.count as number} ${a.input as string} with ${a.fuel as string}`)
      const raw = bot.inventory.items().find((i: any) => i.name === 'raw_iron')
      raw.count -= a.count
      bot.inventory.slots[33] = item('iron_ingot', a.count)
    }
    let slot = 30
    craftModule.craft = async (_b: unknown, a: any) => {
      log.push(`craft ${a.item as string}`)
      const ingot = bot.inventory.slots[33]
      if (--ingot.count === 0) bot.inventory.slots[33] = null
      bot.inventory.slots[slot++] = item('shield')
    }
    assert.equal(await spareShield(bot), BLAZE_SHIELDS)
    assert.deepStrictEqual(log, [`smelt ${BLAZE_SHIELDS} raw_iron with coal`, 'craft shield', 'craft shield'])
    log.length = 0
    assert.equal(await spareShield(bot), 0)
    assert.deepStrictEqual(log, [])
    // no fuel but the wood, little of it: none smelted
    const poor = fakeBot({ items: [item('oak_log', 2), item('raw_iron', 3), item('furnace')] })
    assert.equal(await spareShield(poor), 0)
    assert.deepStrictEqual(log, [])
  } finally {
    craftModule.craft = realCraft
    smeltModule.smelt = realSmelt
  }
})

test('collectBlazeRods: a nook with no kill for long (STUCK) is left for another of the bow\'s nooks once, then the melee nook out of the spawn volume, that one too for the camp\'s fight', async () => {
  const { collectBlazeRods } = await import('../../src/nether/fortressSkills')
  const { SkillError } = await import('../../src/skills/errors')
  const fightModule = require('../../src/nether/blazeFight')
  const gridModule = require('../../src/skills/gridWalk')
  const { item } = await import('../reflexes/fakeBot')
  const realBuild = fightModule.buildNook
  const realFight = fightModule.fightFromNook
  const realMove = gridModule.moveNear
  const fought: string[] = []
  const moves: string[] = []
  fightModule.buildNook = async () => {}
  gridModule.moveNear = async (_b: unknown, to: Vec3) => { moves.push(to.toString()) }
  fightModule.fightFromNook = async (_b: unknown, nook: any) => {
    fought.push(nook.stand.toString())
    throw new SkillError('STUCK', 'no blaze killed from the nook in 3001 ticks')
  }
  const bot = fakeBot({ position: new Vec3(0.5, 64, 12.5), items: [item('cobblestone', 64), item('bow'), item('arrow', 64)], world: (p: any) => p.y < 64 ? 'stone' : 'air' })
  bot.game.dimension = 'the_nether'
  ;(bot as any).world = { raycast: () => null }
  bot.findBlocks = () => []
  const ticking = setInterval(() => bot.emit('physicsTick'), 1)
  try {
    await assert.rejects(collectBlazeRods(bot, { count: 1, spawner: new Vec3(0, 64, 0), maxTicks: 30, safety: false, bunker: false }), /TIMEOUT|rods/)
    assert.equal(fought.length, 3, fought.join(' '))
    const [far, far2, near] = fought.map(t => t.replace(/[()]/g, '').split(', ').map(Number))
    assert.ok(Math.hypot(far[0], far[2]) >= 7, fought[0])
    assert.ok(Math.hypot(far2[0], far2[2]) >= 7 && fought[1] !== fought[0], fought[1])
    assert.ok(Math.hypot(near[0], near[2]) <= 5.1 && Math.max(Math.abs(near[0]), Math.abs(near[2])) >= 4, fought[2])
    // then the camp
    assert.ok(moves.length > 0)
  } finally {
    clearInterval(ticking)
    fightModule.buildNook = realBuild
    fightModule.fightFromNook = realFight
    gridModule.moveNear = realMove
  }
})

test('collectBlazeRods keeps the spawner from the pathfinder breaking it through the fight, the settings put back after', async () => {
  const { collectBlazeRods } = await import('../../src/nether/fortressSkills')
  const fightModule = require('../../src/nether/blazeFight')
  const { item } = await import('../reflexes/fakeBot')
  const realBuild = fightModule.buildNook
  const realFight = fightModule.fightFromNook
  const costs: number[] = []
  const bot = fakeBot({ position: new Vec3(0.5, 64, 12.5), items: [item('cobblestone', 64), item('bow'), item('arrow', 64)], world: (p: any) => p.y < 64 ? 'stone' : 'air' })
  const pathfinder: any = { defaultMoveSettings: { exclusionAreasBreak: [] }, setMoveOptions (s: any) { this.defaultMoveSettings = s } }
  ;(bot as any).pathfinder = pathfinder
  const cost = (p: Vec3): number => pathfinder.defaultMoveSettings.exclusionAreasBreak.reduce((a: number, f: any) => a + f({ position: p }), 0)
  fightModule.buildNook = async () => {}
  fightModule.fightFromNook = async () => {
    costs.push(cost(new Vec3(0, 64, 0)), cost(new Vec3(1, 64, 0)))
    bot.inventory.slots[20] = item('blaze_rod')
    return { kills: 1, shots: 0, blocked: 0, ticks: 10 }
  }
  try {
    bot.game.dimension = 'the_nether'
    ;(bot as any).world = { raycast: () => null }
    bot.findBlocks = () => []
    await collectBlazeRods(bot, { count: 1, spawner: new Vec3(0, 64, 0), maxTicks: 100, safety: false })
    assert.ok(costs[0] >= 1e9 && costs[1] === 0, costs.join(' '))
    assert.equal(pathfinder.defaultMoveSettings.exclusionAreasBreak.length, 0)
  } finally {
    fightModule.buildNook = realBuild
    fightModule.fightFromNook = realFight
  }
})

test('the camp is out of the spawner\'s spawn volume: 2 off, a melee nook\'s stand, isn\'t one (full-26.3-fresh-d)', async () => {
  const { atCamp, BLAZE_STAND_OFF } = await import('../../src/nether/fortressSkills')
  assert.equal(atCamp(2, BLAZE_STAND_OFF), false)
  assert.equal(atCamp(5, BLAZE_STAND_OFF), false)
  assert.equal(atCamp(6, BLAZE_STAND_OFF), true)
  assert.equal(atCamp(9, BLAZE_STAND_OFF), true)
  assert.equal(atCamp(12.5, BLAZE_STAND_OFF), false)
})

test('the camp\'s meal waits while a blaze is within 6 (unless starving): it is fought first, then eaten (full-26.3-fresh-d: eating at 19 health, food 7, among two blazes)', async () => {
  const { campMealDue, collectBlazeRods } = await import('../../src/nether/fortressSkills')
  assert.equal(campMealDue(7, 19, 12, 2), false)
  assert.equal(campMealDue(7, 19, 12, 0), true)
  assert.equal(campMealDue(5, 19, 12, 1), true)
  assert.equal(campMealDue(16, 10, 12, 0), true)
  assert.equal(campMealDue(16, 10, 12, 1), false)
  assert.equal(campMealDue(20, 10, 12, 0), false)
  // a porkchop (8) that doesn't fit: at 18 and 19 only at 10 health, under 18 hurt at eatAt
  assert.equal(campMealDue(19, 12, 12, 0, 8), false)
  assert.equal(campMealDue(19, 10, 12, 0, 8), true)
  assert.equal(campMealDue(17, 12, 12, 0, 8), true)
  assert.equal(campMealDue(14, 19, 12, 0, 8), false)
  assert.equal(campMealDue(12, 19, 12, 0, 8), true)
  const fightModule = require('../../src/skills/fight')
  const eatModule = require('../../src/skills/eat')
  const gridModule = require('../../src/skills/gridWalk')
  const bot = fakeBot({ position: new Vec3(8.5, 64, 0.5), world: (p: any) => p.y < 64 ? 'netherrack' : 'air', items: [item('cooked_porkchop', 4)] })
  bot.game.dimension = 'the_nether'
  ;(bot as any).health = 19
  ;(bot as any).food = 7
  ;(bot as any).world = { raycast: () => null }
  bot.findBlocks = () => []
  ;(bot as any).lookAt = async () => {}
  const blaze: any = { id: 9, name: 'blaze', type: 'hostile', position: new Vec3(9.5, 64, 0.5), metadata: [] }
  bot.entities[9] = blaze
  const order: string[] = []
  const realFight = fightModule.fight
  const realEat = eatModule.eat
  const realMove = gridModule.moveNear
  fightModule.fight = async (_b: unknown, target: any) => {
    order.push(`fight ${target.name}`)
    delete bot.entities[9]
    bot.emit('entityDead', blaze)
    return { killed: true, hits: 3, ticks: 30, lastPosition: blaze.position }
  }
  eatModule.eat = async () => { order.push(`eat with ${Object.values(bot.entities).filter((e: any) => e.name === 'blaze').length} blazes`); (bot as any).food = 20 }
  gridModule.moveNear = async () => {}
  const ticking = setInterval(() => bot.emit('physicsTick'), 1)
  try {
    await assert.rejects(collectBlazeRods(bot, { count: 8, spawner: new Vec3(0, 64, 0), maxTicks: 200, safety: false, nook: false }), /TIMEOUT|rods/)
  } finally {
    clearInterval(ticking)
    fightModule.fight = realFight
    eatModule.eat = realEat
    gridModule.moveNear = realMove
  }
  assert.deepEqual(order.slice(0, 2), ['fight blaze', 'eat with 0 blazes'], order.join(' | '))
})

test('the camp\'s retreat with blocks in the bag: shut in where the bot stands to heal, opened toward the spawner, no walk off along the corridors (full-26.3-fresh-d: a wither skeleton on the way)', async () => {
  const { collectBlazeRods, healSealed } = await import('../../src/nether/fortressSkills')
  const fightModule = require('../../src/nether/blazeFight')
  const gridModule = require('../../src/skills/gridWalk')
  const navModule = require('../../src/skills/navigate')
  const { item } = await import('../reflexes/fakeBot')
  const bot = fakeBot({ position: new Vec3(8.5, 64, 0.5), items: [item('cobblestone', 32)], world: (p: any) => p.y < 64 ? 'stone' : 'air' })
  bot.game.dimension = 'the_nether'
  ;(bot as any).health = 6
  ;(bot as any).food = 18
  ;(bot as any).world = { raycast: () => null }
  bot.findBlocks = () => []
  const calls: string[] = []
  // (the box's own work is blazeFight's shutInWhereItStands: its building, sealing and opening tested with it)
  const real = { shut: fightModule.shutInWhereItStands, move: gridModule.moveNear, walk: navModule.walkTo }
  fightModule.shutInWhereItStands = async (_b: unknown, toward: Vec3, healTo: number) => { calls.push(`shut in at ${bot.entity.position.floored().toString()} toward ${toward.toString()} to ${healTo}`); (bot as any).health = 20; return true }
  gridModule.moveNear = async (_b: unknown, to: Vec3) => { calls.push(`move ${to.toString()}`) }
  navModule.walkTo = async () => true
  const ticking = setInterval(() => bot.emit('physicsTick'), 1)
  try {
    await assert.rejects(collectBlazeRods(bot, { count: 8, spawner: new Vec3(0, 64, 0), maxTicks: 200, safety: false, nook: false }), /TIMEOUT|rods/)
    assert.deepEqual(calls.slice(0, 1), ['shut in at (8, 64, 0) toward (0, 64, 0) to 18'], calls.join(' | '))
    assert.ok(!calls.some(c => c.startsWith('move (3')), calls.join(' | '))
    // with too few blocks for the box: false, nothing done
    fightModule.shutInWhereItStands = real.shut
    ;(bot.inventory.slots as any[]).fill(null, 9, 45)
    calls.length = 0
    assert.equal(await healSealed(bot, new Vec3(0, 64, 0)), false)
    assert.deepEqual(calls, [])
  } finally {
    clearInterval(ticking)
    fightModule.shutInWhereItStands = real.shut
    gridModule.moveNear = real.move
    navModule.walkTo = real.walk
  }
})

test('the camp\'s fight goes no further after a blaze than the spawn volume\'s edge, and back to the camp from in it (nether-26.3-q3)', async () => {
  const { collectBlazeRods } = await import('../../src/nether/fortressSkills')
  const fightModule = require('../../src/skills/fight')
  const gridModule = require('../../src/skills/gridWalk')
  const bot = fakeBot({ position: new Vec3(8.5, 64, 0.5), world: (p: any) => p.y < 64 ? 'netherrack' : 'air' })
  bot.game.dimension = 'the_nether'
  ;(bot as any).world = { raycast: () => null }
  bot.findBlocks = () => []
  ;(bot as any).lookAt = async () => {}
  bot.entities[9] = { id: 9, name: 'blaze', type: 'hostile', position: new Vec3(5.5, 64, 0.5), metadata: [] } as any
  const untils: boolean[][] = []
  const moves: string[] = []
  const realFight = fightModule.fight
  const realMove = gridModule.moveNear
  fightModule.fight = async (_b: unknown, _t: unknown, o: any) => {
    const at8 = o.until()
    bot.entity.position = new Vec3(2.5, 64, 0.5)
    untils.push([at8, o.until()])
  }
  gridModule.moveNear = async (_b: unknown, to: Vec3) => { moves.push(to.toString()); bot.entity.position = to.offset(0.5, 0, 0.5) }
  const ticking = setInterval(() => bot.emit('physicsTick'), 1)
  try {
    await assert.rejects(collectBlazeRods(bot, { count: 8, spawner: new Vec3(0, 64, 0), maxTicks: 100, safety: false, nook: false }), /TIMEOUT|rods/)
  } finally {
    clearInterval(ticking)
    fightModule.fight = realFight
    gridModule.moveNear = realMove
  }
  assert.deepEqual(untils[0], [false, true])
  assert.ok(moves.length > 0, 'not back to the camp')
})

test('the camp\'s fight from in the spawn volume (no camp out of it to be had) is fought where the bot is, not cut at once', async () => {
  const { collectBlazeRods } = await import('../../src/nether/fortressSkills')
  const fightModule = require('../../src/skills/fight')
  const gridModule = require('../../src/skills/gridWalk')
  // 2 off the spawner, walled in a throne: no camp spot (none sees it), the moves end where the bot is
  const bot = fakeBot({ position: new Vec3(2.5, 64, 0.5), world: (p: any) => p.y < 64 ? 'netherrack' : 'air' })
  bot.game.dimension = 'the_nether'
  ;(bot as any).world = { raycast: () => null }
  bot.findBlocks = () => []
  ;(bot as any).lookAt = async () => {}
  bot.entities[9] = { id: 9, name: 'blaze', type: 'hostile', position: new Vec3(0.5, 64, 2.5), metadata: [] } as any
  const untils: boolean[] = []
  const realFight = fightModule.fight
  const realMove = gridModule.moveNear
  fightModule.fight = async (_b: unknown, _t: unknown, o: any) => { untils.push(o.until()) }
  gridModule.moveNear = async () => {}
  const ticking = setInterval(() => bot.emit('physicsTick'), 1)
  try {
    await assert.rejects(collectBlazeRods(bot, { count: 8, spawner: new Vec3(0, 64, 0), maxTicks: 60, safety: false, nook: false }), /TIMEOUT|rods/)
  } finally {
    clearInterval(ticking)
    fightModule.fight = realFight
    gridModule.moveNear = realMove
  }
  assert.ok(untils.length > 0)
  assert.ok(untils.every(u => !u), `the fight cut at once: ${untils.join(' ')}`)
})

test('collectBlazeRods gives up a spawner whose only floor that sees it is in its spawn volume (a throne walled in): no camp\'s fight in there', async () => {
  const { collectBlazeRods, unreachableSpawners } = await import('../../src/nether/fortressSkills')
  const fightModule = require('../../src/skills/fight')
  // a room 7 across round the spawner at 0 64 0, walled in netherrack; the bot in it
  const bot = fakeBot({ position: new Vec3(2.5, 64, 0.5), world: (p: any) => p.y < 64 || p.y > 66 || Math.abs(p.x) > 3 || Math.abs(p.z) > 3 ? 'netherrack' : 'air' })
  bot.game.dimension = 'the_nether'
  ;(bot as any).world = { raycast: () => null }
  bot.findBlocks = () => []
  const { WorldMemory } = await import('../../src/core/memory')
  ;(bot as any).survival = { memory: new WorldMemory() }
  const fights: string[] = []
  const realFight = fightModule.fight
  fightModule.fight = async (_b: unknown, t: any) => { fights.push(t.name) }
  bot.entities[9] = { id: 9, name: 'blaze', type: 'hostile', position: new Vec3(0.5, 65, 2.5), metadata: [] } as any
  const ticking = setInterval(() => bot.emit('physicsTick'), 1)
  try {
    await assert.rejects(collectBlazeRods(bot, { count: 8, spawner: new Vec3(0, 64, 0), maxTicks: 200, safety: false, nook: false }), /no way to the blaze spawner at \(0, 64, 0\): no camp out of its spawn volume/)
  } finally {
    clearInterval(ticking)
    fightModule.fight = realFight
  }
  assert.deepEqual(fights, [])
  assert.deepEqual(unreachableSpawners(bot).map(p => [p.x, p.y, p.z]), [[0, 64, 0]])
})

test('the camp keeps a block clear of the spawn volume\'s edge (CAMP_MARGIN): a throne whose only floor that sees the spawner is 5 off is given up too', async () => {
  const { collectBlazeRods, unreachableSpawners, CAMP_MARGIN } = await import('../../src/nether/fortressSkills')
  const { inSpawnVolume } = await import('../../src/nether/blazeFight')
  assert.equal(CAMP_MARGIN, 1)
  assert.ok(inSpawnVolume(new Vec3(0, 64, 0), new Vec3(5, 64, 0), CAMP_MARGIN) && !inSpawnVolume(new Vec3(0, 64, 0), new Vec3(6, 64, 0), CAMP_MARGIN))
  const fightModule = require('../../src/skills/fight')
  // a room 11 across round the spawner at 0 64 0, walled in netherrack
  const bot = fakeBot({ position: new Vec3(5.5, 64, 0.5), world: (p: any) => p.y < 64 || p.y > 66 || Math.abs(p.x) > 5 || Math.abs(p.z) > 5 ? 'netherrack' : 'air' })
  bot.game.dimension = 'the_nether'
  ;(bot as any).world = { raycast: () => null }
  bot.findBlocks = () => []
  const { WorldMemory } = await import('../../src/core/memory')
  ;(bot as any).survival = { memory: new WorldMemory() }
  const realFight = fightModule.fight
  fightModule.fight = async () => {}
  const ticking = setInterval(() => bot.emit('physicsTick'), 1)
  try {
    await assert.rejects(collectBlazeRods(bot, { count: 8, spawner: new Vec3(0, 64, 0), maxTicks: 200, safety: false, nook: false }), /no camp out of its spawn volume/)
  } finally {
    clearInterval(ticking)
    fightModule.fight = realFight
  }
  assert.equal(unreachableSpawners(bot).length, 1)
})

test('the blaze camp backs off at 12 health when alight (fightHealth: the fire still to come counted), not at 12 unburnt (full-26.3-fresh-k: burned to death from 10 among the blazes)', async () => {
  const gridModule = require('../../src/skills/gridWalk')
  const eatModule = require('../../src/skills/eat')
  const { collectBlazeRods } = await import('../../src/nether/fortressSkills')
  const run = async (alight: boolean): Promise<string[]> => {
    const bot = fakeBot({ position: new Vec3(40.5, 64, 0.5), world: (p: any) => p.y < 64 ? 'netherrack' : 'air' })
    bot.game.dimension = 'the_nether'
    ;(bot as any).health = 12
    ;(bot as any).food = 20
    bot.entity.metadata[0] = alight ? 1 : 0
    ;(bot as any).world = { raycast: () => null }
    bot.findBlocks = () => []
    const moves: string[] = []
    const realMove = gridModule.moveNear
    const realEat = eatModule.eat
    gridModule.moveNear = async (_b: unknown, to: Vec3) => { moves.push(to.toString()) }
    eatModule.eat = async () => {}
    const ticking = setInterval(() => bot.emit('physicsTick'), 1)
    try {
      await assert.rejects(collectBlazeRods(bot, { count: 8, spawner: new Vec3(0, 64, 0), maxTicks: 150, safety: false, nook: false }), /TIMEOUT|blaze rods/)
    } finally {
      clearInterval(ticking)
      gridModule.moveNear = realMove
      eatModule.eat = realEat
    }
    return moves
  }
  const off = (moves: string[]): boolean => moves.some(m => { const [x, , z] = m.replace(/[()]/g, '').split(',').map(Number); return x >= 30 && Math.abs(z) <= 2 })
  assert.ok(off(await run(true)), 'backed off alight')
  assert.ok(!off(await run(false)), 'not unburnt')
})

test('collectBlazeRods: short of the bow nook\'s arrows with no melee nook by the spawner (a throne walled in), the bow\'s nook while there are arrows, not given up (seed 2\'s throne at (-277, 77, -159), 15 arrows left)', async () => {
  const { collectBlazeRods } = await import('../../src/nether/fortressSkills')
  const fightModule = require('../../src/nether/blazeFight')
  const { item } = await import('../reflexes/fakeBot')
  const real = { build: fightModule.buildNook, fight: fightModule.fightFromNook, plan: fightModule.planBlazeNooks }
  const built: any[] = []
  fightModule.buildNook = async (_b: unknown, nook: any) => { built.push(nook) }
  fightModule.planBlazeNooks = (lookup: any, spawner: any, opts: any, n: number) => opts?.melee === true ? [] : real.plan(lookup, spawner, opts, n)
  try {
    const bot = fakeBot({ position: new Vec3(0.5, 64, 12.5), items: [item('cobblestone', 64), item('bow'), item('arrow', 15)], world: (p: any) => p.y < 64 ? 'stone' : 'air' })
    bot.game.dimension = 'the_nether'
    ;(bot as any).world = { raycast: () => null }
    bot.findBlocks = () => []
    fightModule.fightFromNook = async () => { bot.inventory.slots[20] = item('blaze_rod'); return { kills: 1, shots: 2, blocked: 0, ticks: 10 } }
    const r = await collectBlazeRods(bot, { count: 1, spawner: new Vec3(0, 64, 0), maxTicks: 100, safety: false, bunker: false })
    assert.equal(r.rods, 1)
    assert.equal(built.length, 1)
    assert.ok(Math.hypot(built[0].stand.x, built[0].stand.z) >= 7, built[0].stand.toString())
  } finally {
    fightModule.buildNook = real.build
    fightModule.fightFromNook = real.fight
    fightModule.planBlazeNooks = real.plan
  }
})

test('collectBlazeRods: the kept nook the bot finds no way back into is followed by another of the planned ones, not the camp (no nook of 1: the spawner given up mid-fight)', async () => {
  const { collectBlazeRods } = await import('../../src/nether/fortressSkills')
  const { SkillError } = await import('../../src/skills/errors')
  const fightModule = require('../../src/nether/blazeFight')
  const { item } = await import('../reflexes/fakeBot')
  const real = { build: fightModule.buildNook, fight: fightModule.fightFromNook }
  const built: string[] = []
  let refuse: string | null = null
  fightModule.buildNook = async (_b: unknown, nook: any) => {
    if (nook.stand.toString() === refuse) throw new SkillError('NO_PATH', 'no grid path')
    built.push(nook.stand.toString())
  }
  try {
    const bot = fakeBot({ position: new Vec3(0.5, 64, 12.5), items: [item('cobblestone', 64), item('bow'), item('arrow', 64)], world: (p: any) => p.y < 64 ? 'stone' : 'air' })
    bot.game.dimension = 'the_nether'
    ;(bot as any).world = { raycast: () => null }
    bot.findBlocks = () => []
    let rods = 0
    fightModule.fightFromNook = async () => { bot.inventory.slots[20 + rods] = item('blaze_rod'); rods++; return { kills: 1, shots: 2, blocked: 0, ticks: 10 } }
    await collectBlazeRods(bot, { count: 1, spawner: new Vec3(0, 64, 0), maxTicks: 100, safety: false })
    assert.equal(built.length, 1)
    refuse = built[0]
    await collectBlazeRods(bot, { count: 2, spawner: new Vec3(0, 64, 0), maxTicks: 100, safety: false })
    assert.equal(built.length, 2)
    assert.notEqual(built[1], refuse)
  } finally {
    fightModule.buildNook = real.build
    fightModule.fightFromNook = real.fight
  }
})

test('collectBlazeRods: fire resistant (a potion of it held), the walled throne\'s floors in the spawn volume are camped on, not given up; the resistance out, given up then', async () => {
  const { collectBlazeRods, unreachableSpawners } = await import('../../src/nether/fortressSkills')
  const fightModule = require('../../src/skills/fight')
  const potionModule = require('../../src/skills/potion')
  const { item } = await import('../reflexes/fakeBot')
  const bot = fakeBot({ position: new Vec3(2.5, 64, 0.5), world: (p: any) => p.y < 64 || p.y > 66 || Math.abs(p.x) > 3 || Math.abs(p.z) > 3 ? 'netherrack' : 'air' })
  bot.game.dimension = 'the_nether'
  ;(bot as any).world = { raycast: () => null }
  bot.findBlocks = () => []
  const { WorldMemory } = await import('../../src/core/memory')
  ;(bot as any).survival = { memory: new WorldMemory() }
  const potion = item('potion')
  potion.componentMap = new Map([['potion_contents', { type: 'potion_contents', data: { potionId: potionModule.POTION_IDS.fire_resistance[0], customEffects: [] } }]])
  bot.inventory.slots[20] = potion
  const real = { fight: fightModule.fight, drink: potionModule.drinkPotion }
  const fights: string[] = []
  fightModule.fight = async (_b: unknown, t: any) => { fights.push(t.name) }
  // (the drink fails: the potion stays held, the camp goes on)
  potionModule.drinkPotion = async () => { throw new Error('no drink here') }
  bot.entities[9] = { id: 9, name: 'blaze', type: 'hostile', position: new Vec3(0.5, 65, 2.5), metadata: [] } as any
  const ticking = setInterval(() => bot.emit('physicsTick'), 1)
  try {
    const err: any = await collectBlazeRods(bot, { count: 8, spawner: new Vec3(0, 64, 0), maxTicks: 200, safety: false, nook: false }).then(() => null, e => e)
    assert.ok(!/no camp out of its spawn volume/.test(String(err?.message)), String(err?.message))
    assert.deepEqual(unreachableSpawners(bot), [])
    // the potion gone: out, given up
    bot.inventory.slots[20] = null
    const out: any = await collectBlazeRods(bot, { count: 8, spawner: new Vec3(0, 64, 0), maxTicks: 200, safety: false, nook: false }).then(() => null, e => e)
    assert.match(String(out?.message), /no camp out of its spawn volume|the fire resistance out/)
  } finally {
    clearInterval(ticking)
    fightModule.fight = real.fight
    potionModule.drinkPotion = real.drink
  }
})

test('planBlazeNooks plans no stand the nether paths may not step on (lava by it, a corner\'s too, or under it; netherStepForbidden): ls3-1.21.11\'s bow nook by a basalt delta\'s lava, 21000 ticks of goal inside excluded area', async () => {
  const { planBlazeNooks, netherStepForbidden } = await import('../../src/nether/blazeFight')
  const spawner = new Vec3(0, 64, 0)
  let lava: Vec3[] = []
  const lookup = (p: Vec3): any => {
    if (p.equals(spawner)) return { name: 'spawner', boundingBox: 'block' }
    if (lava.some(l => l.equals(p))) return { name: 'lava', boundingBox: 'empty' }
    return p.y < 64 ? { name: 'nether_bricks', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' }
  }
  const first = planBlazeNooks(lookup, spawner, { from: new Vec3(0.5, 64, 12.5) })[0]
  assert.ok(first != null)
  assert.equal(netherStepForbidden(lookup, first.stand), false)
  // lava at a corner of the stand, as at (-57, 78, 243) by (-56, 78, 242)
  lava = [first.stand.offset(-1, 0, 1)]
  assert.equal(netherStepForbidden(lookup, first.stand), true)
  const again = planBlazeNooks(lookup, spawner, { from: new Vec3(0.5, 64, 12.5) })
  assert.ok(again.length > 0)
  assert.ok(!again.some(n => n.stand.equals(first.stand)), again.map(n => n.stand.toString()).join(' '))
  // a magma block under it too
  lava = []
  const magma = (p: Vec3): any => p.equals(first.stand.offset(0, -1, 0)) ? { name: 'magma_block', boundingBox: 'block' } : lookup(p)
  assert.equal(netherStepForbidden(magma, first.stand), true)
})

test('collectBlazeRods: a nook there\'s no way into (NO_PATH) is not tried again on the next try of the fight (the task begun again after each reflex went back to it for 21000 ticks, ls3-1.21.11)', async () => {
  const { collectBlazeRods } = await import('../../src/nether/fortressSkills')
  const { SkillError } = await import('../../src/skills/errors')
  const fightModule = require('../../src/nether/blazeFight')
  const { item } = await import('../reflexes/fakeBot')
  const real = { build: fightModule.buildNook, fight: fightModule.fightFromNook }
  const tried: string[] = []
  fightModule.buildNook = async (_b: unknown, nook: any) => { tried.push(nook.stand.toString()); throw new SkillError('NO_PATH', 'goal inside excluded area') }
  fightModule.fightFromNook = async () => ({ kills: 0, shots: 0, blocked: 0, ticks: 1 })
  const bot = fakeBot({ position: new Vec3(0.5, 64, 12.5), items: [item('cobblestone', 64), item('bow'), item('arrow', 64)], world: (p: any) => p.y < 64 ? 'stone' : 'air' })
  bot.game.dimension = 'the_nether'
  ;(bot as any).world = { raycast: () => null }
  bot.findBlocks = () => []
  const ticking = setInterval(() => bot.emit('physicsTick'), 1)
  try {
    await collectBlazeRods(bot, { count: 1, spawner: new Vec3(0, 64, 0), maxTicks: 20, safety: false }).catch(() => {})
    const first = tried.slice()
    assert.ok(first.length > 0)
    tried.length = 0
    await collectBlazeRods(bot, { count: 1, spawner: new Vec3(0, 64, 0), maxTicks: 20, safety: false }).catch(() => {})
    assert.ok(!tried.some(t => first.includes(t)), `${first.join(' ')} | ${tried.join(' ')}`)
  } finally {
    clearInterval(ticking)
    fightModule.buildNook = real.build
    fightModule.fightFromNook = real.fight
  }
})

test('campSpots leaves out a spot by lava (netherStepForbidden), and a camp spot there was no way to twice is not gone for again over the fight\'s tries (ls3-1.21.11: (-56, 78, 242) by the lava walked to for 21000 ticks)', async () => {
  const { campSpots, collectBlazeRods, CAMP_SPOT_TRIES } = await import('../../src/nether/fortressSkills')
  const { SkillError } = await import('../../src/skills/errors')
  const gridModule = require('../../src/skills/gridWalk')
  let lava: Vec3[] = []
  const bot = fakeBot({ position: new Vec3(0.5, 64, 12.5), world: (p: any) => lava.some(l => l.equals(p.floored())) ? 'lava' : p.y < 64 ? 'netherrack' : 'air' })
  bot.game.dimension = 'the_nether'
  ;(bot as any).world = { raycast: () => null }
  bot.findBlocks = () => []
  const spawner = new Vec3(0, 64, 0)
  const spots = campSpots(bot, spawner, 9)
  assert.ok(spots.length > 3)
  lava = [spots[0].offset(1, 0, 1)]
  const after = campSpots(bot, spawner, 9)
  assert.ok(!after.some(s => s.equals(spots[0])))
  lava = []
  const tries = new Map<string, number>()
  const real = gridModule.moveNear
  gridModule.moveNear = async (_b: unknown, to: Vec3, range: number) => {
    if (range === 0) tries.set(to.toString(), (tries.get(to.toString()) ?? 0) + 1)
    throw new SkillError('NO_PATH', 'goal inside excluded area')
  }
  const ticking = setInterval(() => bot.emit('physicsTick'), 1)
  try {
    for (let i = 0; i < 4; i++) await collectBlazeRods(bot, { count: 1, spawner, maxTicks: 30, safety: false, nook: false }).catch(() => {})
  } finally {
    clearInterval(ticking)
    gridModule.moveNear = real
  }
  assert.ok(tries.size > 0)
  for (const [spot, n] of tries) assert.ok(n <= CAMP_SPOT_TRIES, `${spot} ${n}`)
})

test('collectBlazeRods gives up a spawner the bot died by (the memory\'s nether death within 20), no fight there with a fresh kit: the milestone\'s next spawner (ls3-1.21.11 died twice at (-56, 76, 250))', async () => {
  const { collectBlazeRods, unreachableSpawners, deathsByBlazeSpawner } = await import('../../src/nether/fortressSkills')
  const fightModule = require('../../src/nether/blazeFight')
  const { item } = await import('../reflexes/fakeBot')
  const { WorldMemory } = await import('../../src/core/memory')
  const real = { build: fightModule.buildNook, fight: fightModule.fightFromNook }
  const fought: string[] = []
  fightModule.buildNook = async () => {}
  fightModule.fightFromNook = async () => { fought.push('nook'); return { kills: 0, shots: 0, blocked: 0, ticks: 1 } }
  const bot = fakeBot({ position: new Vec3(0.5, 64, 12.5), items: [item('cobblestone', 64), item('bow'), item('arrow', 64)], world: (p: any) => p.y < 64 ? 'stone' : 'air' })
  bot.game.dimension = 'the_nether'
  ;(bot as any).world = { raycast: () => null }
  bot.findBlocks = () => []
  const memory = new WorldMemory()
  ;(bot as any).survival = { memory }
  const spawner = new Vec3(0, 64, 0)
  // a death 30 off: not the spawner's
  memory.addPoi('nether_death', { x: 30, y: 64, z: 0 }, 'the_nether')
  assert.equal(deathsByBlazeSpawner(bot, spawner), 0)
  memory.addPoi('nether_death', { x: -6, y: 66, z: 9 }, 'the_nether')
  assert.equal(deathsByBlazeSpawner(bot, spawner), 1)
  try {
    await assert.rejects(collectBlazeRods(bot, { count: 1, spawner, maxTicks: 20, safety: false }), /no way to the blaze spawner at \(0, 64, 0\): the bot died by it 1 times/)
  } finally {
    fightModule.buildNook = real.build
    fightModule.fightFromNook = real.fight
  }
  assert.deepEqual(fought, [])
  assert.deepEqual(unreachableSpawners(bot).map(p => [p.x, p.y, p.z]), [[0, 64, 0]])
})

test('collectBlazeRods fights from a sealed bunker by the spawn volume first (planBlazeBunkers), kept for its next call; with a potion of fire resistance held too', async () => {
  const { collectBlazeRods, resetBlazeCover } = await import('../../src/nether/fortressSkills')
  const fightModule = require('../../src/nether/blazeFight')
  const realBuild = fightModule.buildNook
  const realFight = fightModule.fightFromNook
  const built: any[] = []
  fightModule.buildNook = async (_b: unknown, nook: any) => { built.push(nook) }
  try {
    const bot = fakeBot({ position: new Vec3(0.5, 64, 12.5), items: [item('cobblestone', 64), item('bow'), item('arrow', 64)], world: (p: any) => p.y < 64 ? 'stone' : 'air' })
    bot.game.dimension = 'the_nether'
    bot.entity.effects = {}
    ;(bot as any).world = { raycast: () => null }
    bot.findBlocks = () => []
    resetBlazeCover(bot)
    fightModule.fightFromNook = async (_b: unknown, nook: any) => { bot.inventory.slots[20 + built.length] = item('blaze_rod'); return { kills: 1, shots: 0, blocked: 0, ticks: 10, nook } }
    await collectBlazeRods(bot, { count: 1, spawner: new Vec3(0, 64, 0), maxTicks: 100, safety: false })
    assert.equal(built.length, 1)
    assert.ok(built[0].bunker != null, 'a bunker')
    // the next rod from the same one
    await collectBlazeRods(bot, { count: 2, spawner: new Vec3(0, 64, 0), maxTicks: 100, safety: false })
    assert.deepEqual(built[1].stand, built[0].stand)
    assert.ok(built[1].bunker != null)
    // a potion held: the bunker all the same
    const potion = item('potion')
    potion.componentMap = new Map([['potion_contents', { type: 'potion_contents', data: { potionId: 11, customEffects: [] } }]])
    bot.inventory.slots[30] = potion
    bot.inventory.slots[30].slot = 30
    await collectBlazeRods(bot, { count: 3, spawner: new Vec3(0, 64, 0), maxTicks: 100, safety: false, fireResistance: false })
    assert.ok(built[2].bunker != null)
  } finally {
    fightModule.buildNook = realBuild
    fightModule.fightFromNook = realFight
  }
})

test('collectBlazeRods bunkerOnly (a sword alone, no fire resistance): no bunker to be had, no nook nor camp, MISSING_ITEMS noFireResistance', async () => {
  const { collectBlazeRods } = await import('../../src/nether/fortressSkills')
  const gridModule = require('../../src/skills/gridWalk')
  const realMove = gridModule.moveNear
  const moves: string[] = []
  gridModule.moveNear = async (_b: unknown, to: Vec3) => { moves.push(to.toString()) }
  try {
    // no blocks for one
    const bot = fakeBot({ position: new Vec3(0.5, 64, 12.5), items: [item('diamond_sword')], world: (p: any) => p.y < 64 ? 'stone' : 'air' })
    bot.game.dimension = 'the_nether'
    bot.entity.effects = {}
    ;(bot as any).world = { raycast: () => null }
    bot.findBlocks = () => []
    const err = await collectBlazeRods(bot, { count: 1, spawner: new Vec3(0, 64, 0), maxTicks: 100, safety: false, bunkerOnly: true }).catch(e => e)
    assert.match(String(err?.message), /no bunker to fight from/)
    assert.equal(err.noFireResistance, true)
    assert.deepEqual(moves, [])
  } finally {
    gridModule.moveNear = realMove
  }
})

test('collectBlazeRods: the bunker fought from before, the bot in it, a block of it not put, is built again a while on, not left for another', async () => {
  const { collectBlazeRods, resetBlazeCover, KEPT_BUNKER_TRIES } = await import('../../src/nether/fortressSkills')
  const { SkillError } = await import('../../src/skills/errors')
  const fightModule = require('../../src/nether/blazeFight')
  const realBuild = fightModule.buildNook
  const realFight = fightModule.fightFromNook
  const builds: string[] = []
  let failing = 0
  fightModule.buildNook = async (_b: unknown, nook: any) => {
    builds.push(nook.stand.toString())
    if (failing > 0) { failing--; throw new SkillError('CANNOT_PLACE', '1 of the nook\'s 1 blocks not put') }
  }
  const bot = fakeBot({ position: new Vec3(0.5, 64, 12.5), items: [item('cobblestone', 64), item('bow'), item('arrow', 64)], world: (p: any) => p.y < 64 ? 'stone' : 'air' })
  bot.game.dimension = 'the_nether'
  bot.entity.effects = {}
  ;(bot as any).world = { raycast: () => null }
  bot.findBlocks = () => []
  resetBlazeCover(bot)
  fightModule.fightFromNook = async () => { bot.inventory.slots[20 + builds.length] = item('blaze_rod'); return { kills: 1, shots: 0, blocked: 0, ticks: 10 } }
  const ticking = setInterval(() => { for (let k = 0; k < 20; k++) bot.emit('physicsTick') }, 1)
  try {
    await collectBlazeRods(bot, { count: 1, spawner: new Vec3(0, 64, 0), maxTicks: 1000, safety: false })
    const first = builds[0]
    // the bot in it now
    const [x, y, z] = first.replace(/[()]/g, '').split(',').map(Number)
    bot.entity.position = new Vec3(x + 0.5, y, z + 0.5)
    builds.length = 0
    failing = KEPT_BUNKER_TRIES - 1
    await collectBlazeRods(bot, { count: 2, spawner: new Vec3(0, 64, 0), maxTicks: 1000, safety: false })
    assert.deepEqual(builds, new Array(KEPT_BUNKER_TRIES).fill(first))
  } finally {
    clearInterval(ticking)
    fightModule.buildNook = realBuild
    fightModule.fightFromNook = realFight
  }
})
