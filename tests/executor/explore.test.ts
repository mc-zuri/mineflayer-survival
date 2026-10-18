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
