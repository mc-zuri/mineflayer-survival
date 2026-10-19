import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { facingDir, liquidAround, oreLevel, spiralWaypoints, staircaseStep, tunnelStep, unsafeStep } from '../../src/executor/explore'

const SOLID = new Set(['stone', 'deepslate', 'cobblestone', 'dirt'])
const world = (blocks: Record<string, string>, fill = 'stone') => (pos: Vec3) => {
  const name = blocks[`${pos.x},${pos.y},${pos.z}`] ?? fill
  return { name, boundingBox: SOLID.has(name) ? 'block' : 'empty' }
}

test('ore levels as 1.21.11 places them: iron at 16, diamonds at -58, the deepest of several', () => {
  assert.equal(oreLevel(['iron_ore', 'deepslate_iron_ore']), 16)
  assert.equal(oreLevel(['diamond_ore', 'deepslate_diamond_ore']), -58)
  assert.equal(oreLevel(['iron_ore', 'diamond_ore']), -58)
  assert.equal(oreLevel(['oak_log']), null)
})

test('the spiral goes out leg by leg, each pair of legs a step longer, within the radius', () => {
  const wps = spiralWaypoints({ x: 0, z: 0 }, 10, 30)
  assert.deepEqual(wps.slice(0, 6), [{ x: 10, z: 0 }, { x: 10, z: 10 }, { x: -10, z: 10 }, { x: -10, z: -10 }, { x: 20, z: -10 }, { x: 20, z: 20 }])
  for (const w of wps) assert.ok(Math.max(Math.abs(w.x), Math.abs(w.z)) <= 30)
})

test('a staircase step opens the head room, the walk-through and the new feet a block down; a tunnel step two cells', () => {
  const feet = new Vec3(0, 20, 0)
  const s = staircaseStep(feet, new Vec3(1, 0, 0))
  assert.deepEqual(s.open.map(p => p.toArray()), [[1, 21, 0], [1, 20, 0], [1, 19, 0]])
  assert.deepEqual(s.next.toArray(), [1, 19, 0])
  assert.deepEqual(s.floor.toArray(), [1, 18, 0])
  const t = tunnelStep(feet, new Vec3(0, 0, -1))
  assert.deepEqual(t.open.map(p => p.toArray()), [[0, 20, -1], [0, 21, -1]])
})

test('a step next to lava or water is unsafe, and so is one over lava under the floor', () => {
  const feet = new Vec3(0, 20, 0)
  const step = tunnelStep(feet, new Vec3(1, 0, 0))
  assert.equal(unsafeStep(world({}), step), null)
  assert.match(unsafeStep(world({ '2,21,0': 'lava' }), step) ?? '', /^lava at \(2, 21, 0\)/)
  assert.match(liquidAround(world({ '1,22,0': 'water' }), new Vec3(1, 21, 0)) ?? '', /^water/)
  // lava two under the floor, air between: a dug-out floor drops the bot in
  assert.match(unsafeStep(world({ '1,19,0': 'air', '1,18,0': 'air', '1,17,0': 'lava' }), { open: [], floor: new Vec3(1, 19, 0) }) ?? '', /lava under/)
  // lava under solid stone is fine
  assert.equal(unsafeStep(world({ '1,18,0': 'lava' }), { open: [], floor: new Vec3(1, 19, 0) }), null)
})

test('facingDir snaps mineflayer\'s yaw to a cardinal', () => {
  assert.deepEqual(facingDir(0).toArray(), [0, 0, -1])
  assert.deepEqual(facingDir(Math.PI / 2).toArray(), [-1, 0, 0])
  assert.deepEqual(facingDir(Math.PI).toArray().map(Math.round), [0, 0, 1])
  assert.deepEqual(facingDir(-Math.PI / 2 + 0.2).toArray(), [1, 0, 0])
})

test('openSky: nothing over the cell but trees; GoalSurface ends there and leads up', async () => {
  const { openSky, GoalSurface } = await import('../../src/executor/explore')
  // stone up to y 70, a shaft at x 0 z 0 from 60 up; an oak over (5, 71, 5)
  const lookup = (pos: Vec3) => {
    const shaft = pos.x === 0 && pos.z === 0 && pos.y >= 60
    const name = pos.y > 75 ? 'air' : pos.x === 5 && pos.z === 5 && pos.y === 73 ? 'oak_leaves' : pos.y <= 70 && !shaft ? 'stone' : 'air'
    return { name, boundingBox: name === 'air' ? 'empty' : 'block' }
  }
  assert.equal(openSky(lookup, new Vec3(0, 60, 0)), true)
  assert.equal(openSky(lookup, new Vec3(1, 60, 0)), false)
  assert.equal(openSky(lookup, new Vec3(5, 71, 5)), true)
  const goal = new GoalSurface(lookup)
  assert.equal(goal.isEnd({ x: 3, y: 71, z: 3 }), true)
  assert.equal(goal.isEnd({ x: 3, y: 65, z: 3 }), false)
  // the climb left: up to over the column's top
  assert.equal(goal.distHeuristic({ x: 3, y: 65, z: 3 }), 6)
})

test('blockSubstitutes and mobSubstitutes: another wood, deepslate for stone, another meat animal', async () => {
  const { blockSubstitutes, mobSubstitutes } = await import('../../src/executor/steps')
  assert.ok(blockSubstitutes({ block: 'oak_log', blocks: ['oak_log'] }).includes('birch_log'))
  assert.ok(!blockSubstitutes({ block: 'oak_log', blocks: ['oak_log'] }).includes('oak_log'))
  assert.deepEqual(blockSubstitutes({ block: 'stone', blocks: ['stone'] }), ['deepslate'])
  assert.deepEqual(blockSubstitutes({ block: 'iron_ore', blocks: ['iron_ore', 'deepslate_iron_ore'] }), [])
  assert.deepEqual(mobSubstitutes({ mob: 'cow', item: 'beef' }), ['pig', 'sheep', 'chicken', 'rabbit'])
  assert.deepEqual(mobSubstitutes({ mob: 'blaze', item: 'blaze_rod' }), [])
})

test('SURFACE_BLOCKS: what a mine step climbs out of a mine for', async () => {
  const { SURFACE_BLOCKS } = await import('../../src/executor/steps')
  for (const b of ['oak_log', 'birch_log', 'sand', 'sugar_cane', 'pumpkin']) assert.ok(SURFACE_BLOCKS.test(b), b)
  for (const b of ['stone', 'iron_ore', 'deepslate', 'sandstone', 'gravel']) assert.ok(!SURFACE_BLOCKS.test(b), b)
})

test('a staircase step up opens the room over the head and the column ahead a block up', async () => {
  const { staircaseUpStep } = await import('../../src/executor/explore')
  const s = staircaseUpStep(new Vec3(0, 20, 0), new Vec3(0, 0, 1))
  assert.deepEqual(s.open.map(p => p.toArray()), [[0, 22, 0], [0, 21, 1], [0, 22, 1]])
  assert.deepEqual(s.next.toArray(), [0, 21, 1])
  assert.deepEqual(s.floor.toArray(), [0, 20, 1])
})

test('ensurePickaxe: the one held, else a stone one made, else a wooden one', async () => {
  const { ensurePickaxe } = await import('../../src/executor/explore')
  const bag: string[] = []
  const bot: any = { inventory: { items: () => bag.map(name => ({ name })) } }
  const tried: string[] = []
  const craft = async (_b: unknown, args: { item: string }): Promise<void> => {
    tried.push(args.item)
    if (args.item === 'stone_pickaxe') throw new Error('no cobblestone')
    bag.push(args.item)
  }
  assert.equal(await ensurePickaxe(bot, undefined, craft), 'wooden_pickaxe')
  assert.deepEqual(tried, ['stone_pickaxe', 'wooden_pickaxe'])
  assert.equal(await ensurePickaxe(bot, undefined, craft), 'wooden_pickaxe')
  assert.equal(tried.length, 2)
})

test('withRoom: a station that found no room is tried again (from the surface)', async () => {
  const { withRoom } = await import('../../src/executor/steps')
  const { SkillError } = await import('../../src/skills/errors')
  const bot: any = { entity: { position: new Vec3(0.5, 64, 0.5) }, blockAt: () => ({ name: 'air', boundingBox: 'empty' }) }
  let calls = 0
  const out = await withRoom(bot, new AbortController().signal, async () => {
    if (++calls === 1) throw new SkillError('CANNOT_PLACE', 'no room next to the bot for a furnace')
    return 'smelted'
  })
  assert.equal(out, 'smelted')
  assert.equal(calls, 2)
  await assert.rejects(withRoom(bot, new AbortController().signal, async () => { throw new SkillError('MISSING_ITEMS', 'no fuel') }), /no fuel/)
})

test('nookCell: a wall block beside the feet with rock under it, none next to lava or water, none in bedrock or air', async () => {
  const { nookCell } = await import('../../src/executor/explore')
  const feet = new Vec3(0, 20, 0)
  // a one-wide tunnel along x: rock on both sides, the tunnel itself open
  const tunnel = { '0,20,0': 'air', '0,21,0': 'air', '1,20,0': 'air', '1,21,0': 'air', '-1,20,0': 'air', '-1,21,0': 'air' }
  const nook = nookCell(world(tunnel), feet)
  assert.ok(nook != null && nook.y === 20 && nook.x === 0 && Math.abs(nook.z) === 1, String(nook))
  // lava behind the wall on one side: the other side
  const lavaBehind = nookCell(world({ ...tunnel, '0,20,-2': 'lava' }), feet)
  assert.deepEqual(lavaBehind?.toArray(), [0, 20, 1])
  // nothing but bedrock and lava-backed walls: none
  assert.equal(nookCell(world({ ...tunnel, '0,20,-2': 'lava', '0,20,2': 'water' }), feet), null)
  assert.equal(nookCell(world(tunnel, 'bedrock'), feet), null)
})

test('surfaceStepCost: a step under a roof (a cave, a ravine\'s overhang) costs more, one on the ground or under a tree none', async () => {
  const { surfaceStepCost, UNDER_ROOF_STEP_COST } = await import('../../src/executor/explore')
  // ground up to y 63 (rock), a cave cell at 40 in column 0,0; an oak's leaves over column 5,0
  const lookup = (pos: Vec3) => {
    if (pos.x === 0 && pos.z === 0 && (pos.y === 40 || pos.y === 41)) return { name: 'air', boundingBox: 'empty' }
    if (pos.x === 5 && pos.z === 0 && pos.y >= 67 && pos.y <= 68) return { name: 'oak_leaves', boundingBox: 'block' }
    return pos.y <= 63 ? { name: 'stone', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' }
  }
  const cost = surfaceStepCost(lookup, 64)
  assert.equal(cost({ position: new Vec3(0, 40, 0) }), UNDER_ROOF_STEP_COST)
  assert.equal(cost({ position: new Vec3(0, 64, 0) }), 0)
  assert.equal(cost({ position: new Vec3(5, 64, 0) }), 0)
  assert.equal(cost({ position: new Vec3(3, 64, 0) }), 0)
  // down a ravine, open to the sky: as dear
  const ravine = surfaceStepCost((pos: Vec3) => pos.x === 20 && pos.y > 40 ? { name: 'air', boundingBox: 'empty' } : lookup(pos), 64)
  assert.equal(ravine({ position: new Vec3(20, 41, 0) }), UNDER_ROOF_STEP_COST)
  assert.equal(ravine({ position: new Vec3(20, 60, 0) }), 0)
})

test('outOfTheWay: an animal in a cave (under a roof) or far below is left alone by a hunt from the surface', async () => {
  const { outOfTheWay } = await import('../../src/executor/steps')
  // rock up to y 63; a cave at y 40 under column 10,10
  const lookup = (pos: Vec3) => (pos.y <= 63 && !(pos.x === 10 && pos.z === 10 && pos.y >= 40 && pos.y <= 41)) ? { name: 'stone', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' }
  const bot: any = { entity: { position: new Vec3(0.5, 64, 0.5) }, blockAt: lookup }
  assert.equal(outOfTheWay(bot, new Vec3(5.5, 64, 5.5)), false)
  assert.equal(outOfTheWay(bot, new Vec3(10.5, 40, 10.5)), true)
  // a bot down in the cave goes for the one beside it
  bot.entity.position = new Vec3(10.5, 40, 10.5)
  assert.equal(outOfTheWay(bot, new Vec3(10.5, 41, 10.5)), false)
})

test('dryStart: off a lake\'s shore (water under every side), a place a few blocks off with no liquid under it', async () => {
  const { dryStart } = await import('../../src/executor/explore')
  // ground up to y 63; water at y 60..62 for x < 6 (under the shore the bot stands on); the bot at (0, 64, 0)
  const lookup = (pos: Vec3) => {
    if (pos.y >= 64) return { name: 'air', boundingBox: 'empty' }
    if (pos.x < 6 && pos.y >= 60 && pos.y <= 62) return { name: 'water', boundingBox: 'empty' }
    return { name: 'stone', boundingBox: 'block' }
  }
  const spot = dryStart(lookup, new Vec3(0, 64, 0))
  assert.ok(spot != null && spot.y === 64 && spot.x >= 7, String(spot))
  // water under everything in reach: none
  assert.equal(dryStart((pos: Vec3) => pos.y >= 64 ? { name: 'air', boundingBox: 'empty' } : pos.y >= 60 && pos.y <= 62 ? { name: 'water', boundingBox: 'empty' } : { name: 'stone', boundingBox: 'block' }, new Vec3(0, 64, 0)), null)
})

test('onTheSurface: the pathfinder gets the under-roof step cost and no drop into water of any height while fn runs, then its settings back', async () => {
  const { onTheSurface } = await import('../../src/executor/explore')
  const settings: any[] = []
  const pf: any = {
    defaultMoveSettings: { infiniteLiquidDropdownDistance: true, exclusionAreasStep: [] },
    setMoveOptions (s: any) { this.defaultMoveSettings = s; settings.push(s) }
  }
  const bot: any = { pathfinder: pf, entity: { position: new Vec3(0, 64, 0) }, blockAt: () => null }
  const during = await onTheSurface(bot, async () => ({ ...pf.defaultMoveSettings }))
  assert.equal(during.infiniteLiquidDropdownDistance, false)
  assert.equal(during.exclusionAreasStep.length, 1)
  assert.equal(pf.defaultMoveSettings.infiniteLiquidDropdownDistance, true)
  assert.equal(pf.defaultMoveSettings.exclusionAreasStep.length, 0)
})

test('runMine: an ore more than ORE_DEPTH below its level is left (iron at y -29 is a trip through the deep caves)', async () => {
  const { runMine, ORE_DEPTH } = await import('../../src/executor/steps')
  const { WorldMemory } = await import('../../src/core/memory')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const registry = require('minecraft-data')('1.21.11')
  const deepOre = new Vec3(1, 16 - ORE_DEPTH - 5, 0)
  const ore = new Vec3(6, 20, 0)
  const bot: any = fakeBot({ position: new Vec3(0.5, 0, 0.5), items: [item('stone_pickaxe')], world: (pos: Vec3) => pos.equals(deepOre) || pos.equals(ore) ? 'iron_ore' : 'stone' })
  const blockAt = bot.blockAt
  bot.blockAt = (pos: Vec3) => { const b = blockAt(pos); b.type = registry.blocksByName[b.name].id; b.harvestTools = registry.blocksByName[b.name].harvestTools; return b }
  bot.findBlocks = () => [deepOre, ore]
  const targets: string[] = []
  bot.pathingUtil = { refresh: () => {}, bestHarvestingTool: (block: any) => { targets.push(block.position.toString()); throw new Error('the test stops here') } }
  const step: any = { kind: 'mine', item: 'raw_iron', count: 1, block: 'iron_ore', blocks: ['iron_ore'], blockCount: 1, tool: 'stone_pickaxe', dimension: 'overworld' }
  await assert.rejects(runMine(step, { bot, memory: new WorldMemory(), signal: new AbortController().signal, state: {}, log: () => {} } as any))
  assert.ok(targets.length > 0 && targets.every(t => t === ore.toString()), targets.join(' '))
})

test('runMine: a worn tool hands the step back for a new one, unless the step is part of making that one (replacingTools)', async () => {
  const { runMine } = await import('../../src/executor/steps')
  const { WorldMemory } = await import('../../src/core/memory')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const registry = require('minecraft-data')('1.21.11')
  const log = new Vec3(3, 64, 0)
  const axe = item('stone_axe')
  axe.durabilityUsed = registry.itemsByName.stone_axe.maxDurability - 4
  const bot: any = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [axe], world: (pos: Vec3) => pos.equals(log) ? 'oak_log' : pos.y < 64 ? 'stone' : 'air' })
  const blockAt = bot.blockAt
  bot.blockAt = (pos: Vec3) => { const b = blockAt(pos); b.type = registry.blocksByName[b.name].id; b.harvestTools = registry.blocksByName[b.name].harvestTools; return b }
  bot.findBlocks = () => [log]
  const targets: string[] = []
  bot.pathingUtil = { refresh: () => {}, bestHarvestingTool: (block: any) => { targets.push(block.position.toString()); throw new Error('the test stops here') } }
  const step: any = { kind: 'mine', item: 'oak_log', count: 1, block: 'oak_log', blocks: ['oak_log'], blockCount: 1, tool: null, dimension: 'overworld' }
  const ctx = (replacingTools: boolean): any => ({ bot, memory: new WorldMemory(), signal: new AbortController().signal, state: {}, log: () => {}, replacingTools })
  assert.deepEqual(await runMine(step, ctx(false)), { gained: 0, replan: true })
  assert.equal(targets.length, 0)
  await assert.rejects(runMine(step, ctx(true)))
  assert.ok(targets.length > 0, 'the log was never gone for')
})

test('withRoom: no room for a station up here either (on a tree\'s leaves): walked to a place with room, and tried there', async () => {
  const { withRoom } = await import('../../src/executor/steps')
  const { SkillError } = await import('../../src/skills/errors')
  // open sky; ground with room everywhere but where the bot stands
  const bot: any = new (await import('node:events')).EventEmitter()
  bot.entity = { position: new Vec3(0.5, 80, 0.5), yaw: 0 }
  bot.blockAt = (p: Vec3) => p.y < 64 ? { name: 'stone', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' }
  const trips: string[] = []
  bot.pathfinder = {
    isPathing: false,
    // the trip down to the ground a few blocks off
    goto: async (goal: any) => { trips.push(`${goal.x},${goal.z}`); bot.entity.position = new Vec3(goal.x + 0.5, 64, goal.z + 0.5) },
    cancel: async () => {}
  }
  let calls = 0
  const out = await withRoom(bot, new AbortController().signal, async () => {
    if (bot.entity.position.y > 70) { calls++; throw new SkillError('CANNOT_PLACE', 'no room next to the bot for a crafting table') }
    return 'crafted'
  })
  assert.equal(out, 'crafted')
  assert.ok(calls >= 2 && trips.length >= 1, `${calls} calls, trips ${trips.join(' ')}`)
})

test('dryStart: from the middle of a lake, a dry place up to 24 blocks off', async () => {
  const { dryStart } = await import('../../src/executor/explore')
  // water at y 60..63 for x < 18 (the bot swims at (0, 63, 0)), dry ground beyond
  const lookup = (pos: Vec3) => {
    if (pos.y >= 64) return { name: 'air', boundingBox: 'empty' }
    if (pos.x < 18 && pos.y >= 60) return { name: 'water', boundingBox: 'empty' }
    return { name: 'stone', boundingBox: 'block' }
  }
  const spot = dryStart(lookup, new Vec3(0, 63, 0))
  assert.ok(spot != null && spot.x >= 19, String(spot))
})

test('runCraft: a crafted chestplate the armor reflex put on while the step was preempted counts as made', async () => {
  const { runCraft, ownedCount } = await import('../../src/executor/steps')
  const slots: any[] = new Array(46).fill(null)
  const bot: any = { inventory: { slots, items: () => slots.slice(9, 45).filter(s => s != null) } }
  // the first attempt crafted it (its start count kept in the task's state), the reflex then wore it
  slots[6] = { name: 'iron_chestplate', count: 1 }
  assert.equal(ownedCount(bot, 'iron_chestplate'), 1)
  const step: any = { kind: 'craft', item: 'iron_chestplate', count: 1, table: true }
  const out = await runCraft(step, { bot, signal: new AbortController().signal, state: { start: 0 }, log: () => {} } as any)
  assert.deepEqual(out, { gained: 1 })
})

test('exploreSurface picks up at the leg its progress kept: a step preempted and run again goes on, not round again', async () => {
  const { exploreSurface, spiralWaypoints } = await import('../../src/executor/explore')
  // under the open sky (nothing above), and no pathfinder: any leg walked would throw
  const bot: any = { entity: { position: new Vec3(0, 64, 0), yaw: 0 }, blockAt: () => null }
  const legs = spiralWaypoints({ x: 0, z: 0 }, 16, 96).length
  const progress = { leg: legs }
  assert.equal(await exploreSurface(bot, { found: () => false, center: new Vec3(0, 64, 0), maxRadius: 96, progress }), false)
  assert.equal(progress.leg, legs)
  // from the start every leg is tried (each fails here, with no pathfinder) and counted walked
  const fresh = { leg: 0 }
  assert.equal(await exploreSurface(bot, { found: () => false, center: new Vec3(0, 64, 0), maxRadius: 96, progress: fresh }), false)
  assert.equal(fresh.leg, legs)
})

test('a ravine\'s floor is open to the sky but not the surface: GoalSurface and ensureSurface want y 50 and up in the overworld', async () => {
  const { GoalSurface, onSurface, SURFACE_MIN_Y } = await import('../../src/executor/explore')
  const sky = (): any => ({ name: 'air', boundingBox: 'empty' })
  assert.equal(onSurface(sky, new Vec3(0, 8, 0)), false)
  assert.equal(onSurface(sky, new Vec3(0, 64, 0)), true)
  assert.equal(onSurface(sky, new Vec3(0, SURFACE_MIN_Y, 0)), true)
  // the End's islands are what there is
  assert.equal(onSurface(sky, new Vec3(0, 8, 0), false), true)
  const goal = new GoalSurface(sky)
  assert.equal(goal.isEnd({ x: 0, y: 8, z: 0 }), false)
  assert.equal(goal.isEnd({ x: 0, y: 70, z: 0 }), true)
})

test('columnSurface: what tops a column, trees and air passed; the sea is water; an unloaded column nothing', async () => {
  const { columnSurface } = await import('../../src/executor/explore')
  const sea = (p: Vec3): any => ({ name: p.y > 62 ? 'air' : p.y > 40 ? 'water' : 'sand', boundingBox: p.y > 62 ? 'empty' : 'block' })
  assert.equal(columnSurface(sea, 0, 0, 64), 'water')
  const forest = (p: Vec3): any => ({ name: p.y > 70 ? 'air' : p.y > 64 ? 'oak_leaves' : 'grass_block' })
  assert.equal(columnSurface(forest, 0, 0, 64), 'grass_block')
  assert.equal(columnSurface(() => null, 0, 0, 64), null)
})

test('runMine: logs are cut from under the open sky, not from a lush cave\'s azalea under the rock', async () => {
  const { runMine } = await import('../../src/executor/steps')
  const { WorldMemory } = await import('../../src/core/memory')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const registry = require('minecraft-data')('1.21.11')
  const caveLog = new Vec3(2, 66, 0)
  const treeLog = new Vec3(9, 70, 0)
  const world = (pos: Vec3): string => pos.equals(caveLog) || pos.equals(treeLog) ? 'oak_log' : pos.y < 70 && !(pos.x === 2 && pos.y >= 65 && pos.y <= 67) ? 'stone' : 'air'
  const bot: any = fakeBot({ position: new Vec3(0.5, 70, 0.5), items: [item('stone_axe')], world })
  const blockAt = bot.blockAt
  bot.blockAt = (pos: Vec3) => { const b = blockAt(pos); b.type = registry.blocksByName[b.name].id; b.harvestTools = registry.blocksByName[b.name].harvestTools; return b }
  bot.findBlocks = () => [caveLog, treeLog]
  const targets: string[] = []
  bot.pathingUtil = { refresh: () => {}, bestHarvestingTool: (block: any) => { targets.push(block.position.toString()); throw new Error('the test stops here') } }
  const step: any = { kind: 'mine', item: 'oak_log', count: 1, block: 'oak_log', blocks: ['oak_log'], blockCount: 1, tool: null, dimension: 'overworld' }
  await assert.rejects(runMine(step, { bot, memory: new WorldMemory(), signal: new AbortController().signal, state: {}, log: () => {} } as any))
  assert.ok(targets.length > 0 && targets.every(t => t === treeLog.toString()), targets.join(' '))
})

test('runMine: stone with water against it is left, like an ore (a flooded cave)', async () => {
  const { runMine } = await import('../../src/executor/steps')
  const { WorldMemory } = await import('../../src/core/memory')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const registry = require('minecraft-data')('1.21.11')
  const wet = new Vec3(2, 63, 0)
  const dry = new Vec3(6, 63, 0)
  const world = (pos: Vec3): string => pos.equals(wet.offset(0, 1, 0)) ? 'water' : pos.y < 64 ? 'stone' : 'air'
  const bot: any = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [item('stone_pickaxe')], world })
  const blockAt = bot.blockAt
  bot.blockAt = (pos: Vec3) => { const b = blockAt(pos); b.type = registry.blocksByName[b.name].id; b.harvestTools = registry.blocksByName[b.name].harvestTools; return b }
  bot.findBlocks = () => [wet, dry]
  const targets: string[] = []
  bot.pathingUtil = { refresh: () => {}, bestHarvestingTool: (block: any) => { targets.push(block.position.toString()); throw new Error('the test stops here') } }
  const step: any = { kind: 'mine', item: 'cobblestone', count: 1, block: 'stone', blocks: ['stone'], blockCount: 1, tool: 'stone_pickaxe', dimension: 'overworld' }
  await assert.rejects(runMine(step, { bot, memory: new WorldMemory(), signal: new AbortController().signal, state: {}, log: () => {} } as any))
  assert.ok(targets.length > 0 && targets.every(t => t === dry.toString()), targets.join(' '))
})

test('nearestShore: from the sea, the nearest column topped by land in the eight directions', async () => {
  const { nearestShore } = await import('../../src/executor/explore')
  // the sea west of x 10, a beach from there east
  const world = (p: Vec3): any => ({ name: p.y > 62 ? 'air' : p.x >= 10 ? 'sand' : p.y > 50 ? 'water' : 'gravel', boundingBox: p.y > 62 ? 'empty' : 'block' })
  const shore = nearestShore(world, new Vec3(0, 60, 0))
  assert.ok(shore != null && shore.x >= 10 && shore.x <= 12, String(shore))
  assert.equal(nearestShore((p: Vec3): any => ({ name: p.y > 62 ? 'air' : 'water', boundingBox: 'empty' }), new Vec3(0, 60, 0)), null)
})

test('a dug route breaks its cells with any tool and walks after no drops (its next step picks them up)', async () => {
  const { ROUTE_DIG } = await import('../../src/executor/explore')
  assert.deepEqual(ROUTE_DIG, { anyTool: true, pickup: false })
})

test('dumpPitCells: a side of the facing opened from head height to a block under the floor, rock under it; behind and ahead last; none next to lava', async () => {
  const { dumpPitCells } = await import('../../src/executor/explore')
  const feet = new Vec3(0, 20, 0)
  // a one-wide tunnel along x, the bot facing +x
  const tunnel = { '0,20,0': 'air', '0,21,0': 'air', '1,20,0': 'air', '1,21,0': 'air', '-1,20,0': 'air', '-1,21,0': 'air' }
  const pit = dumpPitCells(world(tunnel), feet, new Vec3(1, 0, 0))
  assert.ok(pit != null && pit.side.x === 0 && Math.abs(pit.side.z) === 1, String(pit?.side))
  assert.deepEqual(pit.bottom.toArray(), [pit.side.x, 19, pit.side.z])
  assert.deepEqual(pit.open.map(c => c.y), [21, 20, 19])
  // lava under one side and against the other: behind
  const wet = dumpPitCells(world({ ...tunnel, [`0,18,${pit.side.z}`]: 'lava', [`0,20,${-2 * pit.side.z}`]: 'lava' }), feet, new Vec3(1, 0, 0))
  assert.deepEqual(wet?.side.toArray(), [-1, 20, 0])
  // nothing under the bottom (a cave below): no pit there
  assert.equal(dumpPitCells(world({ '0,20,0': 'air' }, 'air'), feet, new Vec3(1, 0, 0)), null)
})

test('dumpPitFor: by a staircase\'s next step, a pit at its side 2 under the floor that the next steps down never touch; behind a trip; none by a staircase with no side to dig', async () => {
  // (26.3 run full-f: the staircase to the deep lava threw 19 dirt, 5 sand and 2 gravel into a pit at its side a block
  // under the floor, picked them up with the next step a block lower, and threw them again, 30 steps running)
  const { dumpPitFor, staircaseStep } = await import('../../src/executor/explore')
  const { touches } = await import('../../src/skills/pickupDrops')
  const feet = new Vec3(0, 20, 0)
  const dir = new Vec3(1, 0, 0)
  // the staircase dug so far, down along +x to the bot's feet
  const cells: Record<string, string> = {}
  for (let i = -3; i <= 0; i++) for (const dy of [0, 1, 2]) cells[`${i},${20 - i + dy},0`] = 'air'
  const lookup = world(cells)
  const pos = new Vec3(0.5, 20, 0.5)
  const next = staircaseStep(feet, dir).next
  const pit = dumpPitFor(lookup, feet, -Math.PI / 2, next.offset(0.5, 0, 0.5))
  assert.ok(pit != null && pit.side.x === 0 && Math.abs(pit.side.z) === 1, String(pit?.side))
  assert.deepEqual(pit.bottom.toArray(), [0, 18, pit.side.z])
  assert.deepEqual(pit.open.map(c => c.y), [21, 20, 19, 18])
  // what lies on its floor is out of reach of the steps down from here, and of the step back up
  const item = new Vec3(pit.bottom.x + 0.5, pit.bottom.y, pit.bottom.z + 0.5)
  const steps = [feet]
  for (let i = 0; i < 4; i++) steps.push(staircaseStep(steps[steps.length - 1], dir).next)
  for (const s of steps) assert.equal(touches(s.offset(0.5, 0, 0.5), item), false, s.toString())
  assert.equal(touches(feet.offset(-0.5, 1, 0.5), item), false)
  // a block under the floor, as before, is in the next step's reach
  assert.equal(touches(steps[1].offset(0.5, 0, 0.5), item.offset(0, 1, 0)), true)
  // a tunnel's next step: a side, 2 under the floor as well
  const level = dumpPitFor(world({ '0,20,0': 'air', '0,21,0': 'air', '-1,20,0': 'air', '-1,21,0': 'air' }), feet, 0, new Vec3(1.5, 20, 0.5))
  assert.ok(level != null && level.side.x === 0 && level.bottom.y === 18, String(level?.side))
  // a trip's goal far off: behind the bot
  const trip = dumpPitFor(world({}), feet, 0, new Vec3(40.5, 20, 0.5))
  assert.deepEqual(trip?.side.toArray(), [-1, 20, 0])
  // no side by a staircase (water at both): none, not the way back or the way on
  assert.equal(dumpPitFor(world({ ...cells, '0,20,2': 'water', '0,20,-2': 'water' }), feet, 0, next.offset(0.5, 0, 0.5)), null)
})

test('pitThrow: a look whose stack comes to rest in the bottom of a pit 2 deep beside a staircase for every lift, where one aimed at the bottom stops on the edge of the bot\'s floor', async () => {
  const { dumpPitFor, itemFlight, pitThrow, staircaseStep } = await import('../../src/executor/explore')
  const cells: Record<string, string> = {}
  for (let i = -3; i <= 0; i++) for (const dy of [0, 1, 2]) cells[`${i},${20 - i + dy},0`] = 'air'
  const feet = new Vec3(0, 20, 0)
  const pos = new Vec3(0.5, 20, 0.5)
  const pit = dumpPitFor(world(cells), feet, 0, staircaseStep(feet, new Vec3(1, 0, 0)).next.offset(0.5, 0, 0.5))
  assert.ok(pit != null)
  for (const c of pit.open) cells[`${c.x},${c.y},${c.z}`] = 'air'
  const lookup = world(cells)
  const eye = pos.offset(0, 1.62, 0)
  // (tossAway's aim at the bottom's far half: a stack on the floor's edge, at the bot's feet)
  const aim = new Vec3(pit.bottom.x + 0.5, pit.bottom.y + 0.1, pit.bottom.z + 0.5 + 0.35 * Math.sign(pit.bottom.z)).minus(eye)
  const edge = itemFlight(lookup, eye, Math.atan2(-aim.x, -aim.z), Math.atan2(aim.y, Math.hypot(aim.x, aim.z)), 0.1)
  assert.ok(edge instanceof Vec3 && edge.y === 20, String(edge))
  const look = pitThrow(lookup, pos, pit.bottom)
  assert.ok(look != null)
  for (const lift of [0, 0.1, 0.2]) {
    const at = itemFlight(lookup, eye, look.yaw, look.pitch, lift)
    assert.ok(at instanceof Vec3 && at.floored().equals(pit.bottom), `${lift}: ${String(at)}`)
  }
  // no pit open: no look into it
  assert.equal(pitThrow(world({ '0,20,0': 'air', '0,21,0': 'air' }), pos, pit.bottom), null)
})

test('itemFlight: a stack thrown level flies some 2 blocks before it lands (Player.drop at 0.3 a tick along the look, 0.1 up; ItemEntity.tick)', async () => {
  const { itemFlight } = await import('../../src/executor/explore')
  // open ground: stone under y 64
  const open = (pos: Vec3) => ({ name: pos.y < 64 ? 'stone' : 'air', boundingBox: pos.y < 64 ? 'block' : 'empty' })
  const eye = new Vec3(0.5, 64 + 1.62, 0.5)
  // yaw 0 throws to -z
  const rest = itemFlight(open, eye, 0, 0)
  assert.ok(rest instanceof Vec3)
  assert.equal(rest.y, 64)
  assert.ok(rest.z < -1 && rest.z > -3.5, `landed at ${rest.toString()}`)
  assert.ok(Math.abs(rest.x - 0.5) < 1e-9)
  // a wall a block ahead stops it at the bot's feet
  const walled = (pos: Vec3) => pos.z === -1 || pos.y < 64 ? { name: 'stone', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' }
  const fell = itemFlight(walled, eye, 0, 0)
  assert.ok(fell instanceof Vec3 && fell.z > -0.2, `landed at ${String(fell)}`)
})

test('lavaThrow: a look that lands the stack in the lake\'s lava below the rim whatever Player.drop\'s random lift; none across a wall or with no lava near', async () => {
  const { lavaThrow, itemFlight } = await import('../../src/executor/explore')
  // the bot on a rim at y 64 (stone under it), a lake of lava at y 63 from x 2 to 5, open above
  const lake = (pos: Vec3) => {
    if (pos.y === 63 && pos.x >= 2 && pos.x <= 5 && pos.z >= -2 && pos.z <= 2) return { name: 'lava', boundingBox: 'empty' }
    return pos.y < 64 ? { name: 'stone', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' }
  }
  const feet = new Vec3(0.5, 64, 0.5)
  const t = lavaThrow(lake, feet)
  assert.ok(t != null)
  assert.ok(t.lava.x >= 2 && t.lava.y === 63)
  for (const lift of [0, 0.1, 0.2]) assert.equal(itemFlight(lake, feet.offset(0, 1.62, 0), t.yaw, t.pitch, lift), 'lava')
  // a wall two high between the bot and the lake
  const walled = (pos: Vec3) => pos.x === 1 && pos.y >= 64 && pos.y <= 66 ? { name: 'stone', boundingBox: 'block' } : lake(pos)
  assert.equal(lavaThrow(walled, feet), null)
  // no lava
  assert.equal(lavaThrow(pos => ({ name: pos.y < 64 ? 'stone' : 'air', boundingBox: pos.y < 64 ? 'block' : 'empty' }), feet), null)
})
