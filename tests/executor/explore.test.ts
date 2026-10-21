import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { BRIDGE_PLACE_COST, STUCK_LEG_TTL, bridgePlaceCost, climbHazard, facingDir, firstLegBeyond, floorHeld, legPassesSpot, noteStuckLeg, stuckSpots, liquidAround, oreLevel, spiralWaypoints, staircaseStep, tunnelStep, unsafeStep } from '../../src/executor/explore'

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
  // for what only that animal gives, none: a pig's no sheep for the wool
  assert.deepEqual(mobSubstitutes({ mob: 'sheep', item: 'white_wool' }), [])
  assert.deepEqual(mobSubstitutes({ mob: 'cow', item: 'leather' }), [])
  assert.deepEqual(mobSubstitutes({ mob: 'chicken', item: 'feather' }), [])
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

test('pickaxeKeeper: a dug route with no pickaxe makes one before its step, and after a failure tries again PICKAXE_RETRY_STEPS steps on; with one carried, none made', async () => {
  // (26.3 run full-f: the staircase to the deep lava dug from y 12 to -50 by hand after the diamond pickaxe broke, a
  // crafting table, 17 sticks and 600 cobblestone in the bag)
  const { pickaxeKeeper, PICKAXE_RETRY_STEPS } = await import('../../src/executor/explore')
  const bag: string[] = ['cobblestone', 'stick', 'crafting_table']
  const bot: any = { inventory: { items: () => bag.map(name => ({ name })) } }
  const tried: string[] = []
  let canMake = false
  const craft = async (_b: unknown, args: { item: string }): Promise<void> => {
    tried.push(args.item)
    if (!canMake) throw new Error('no sticks')
    bag.push(args.item)
  }
  const keep = pickaxeKeeper(bot, craft)
  await keep()
  assert.deepEqual(tried, ['stone_pickaxe', 'wooden_pickaxe'])
  for (let i = 1; i < PICKAXE_RETRY_STEPS; i++) await keep()
  assert.equal(tried.length, 2)
  canMake = true
  await keep()
  assert.deepEqual(tried.slice(2), ['stone_pickaxe'])
  assert.ok(bag.includes('stone_pickaxe'))
  // the bag has one now: none made
  for (let i = 0; i < 20; i++) await keep()
  assert.equal(tried.length, 3)
})

test('ensurePickaxe: no room for the table in a one-wide staircase digs a nook beside the bot, once, and crafts there', async (t) => {
  const { ensurePickaxe } = await import('../../src/executor/explore')
  const { SkillError } = await import('../../src/skills/errors')
  const bag: string[] = []
  // a one-wide shaft along x: the walls beside the feet are stone with stone under them
  const cells: Record<string, string> = { '0,20,0': 'air', '0,21,0': 'air', '1,20,0': 'air', '1,21,0': 'air', '-1,20,0': 'air', '-1,21,0': 'air' }
  const lookup = world(cells)
  const dug: string[] = []
  const bot: any = {
    inventory: { items: () => bag.map(name => ({ name })) },
    entity: { position: new Vec3(0.5, 20, 0.5) },
    blockAt: (p: Vec3) => ({ ...lookup(p), position: p })
  }
  const tried: string[] = []
  const craft = async (_b: unknown, args: { item: string }): Promise<void> => {
    tried.push(args.item)
    if (dug.length === 0) throw new SkillError('CANNOT_PLACE', 'no room for the crafting table')
    bag.push(args.item)
  }
  const collect = await import('../../src/skills/collectBlock')
  t.mock.method(collect, 'collectBlock', async (_b: unknown, args: { positions: Vec3[] }) => {
    for (const p of args.positions) { cells[`${p.x},${p.y},${p.z}`] = 'air'; dug.push(p.toString()) }
    return {}
  })
  assert.equal(await ensurePickaxe(bot, undefined, craft), 'stone_pickaxe')
  assert.deepEqual(tried, ['stone_pickaxe', 'stone_pickaxe'])
  assert.equal(dug.length, 1)
  // the wall beside the feet
  assert.match(dug[0], /^\(0, 20, -?1\)$/)
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
  // a pen's fences and gate, a wall: never dug for a nook
  for (const built of ['oak_fence', 'oak_fence_gate', 'cobblestone_wall']) {
    const fenced = (pos: Vec3) => (pos.y === 20 && pos.z !== 0 ? { name: built, boundingBox: 'block' } : world(tunnel)(pos))
    assert.equal(nookCell(fenced, feet), null, built)
  }
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
  // a bot down in the cave: under the cave rule (not fit for the caves) not there either; fit for them, it goes for
  // the one beside it
  bot.entity.position = new Vec3(10.5, 40, 10.5)
  assert.equal(outOfTheWay(bot, new Vec3(10.5, 41, 10.5)), true)
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const prot = [{ name: 'protection', lvl: 1 }]
  const ready = fakeBot({
    position: new Vec3(10.5, 40, 10.5),
    armor: { head: item('iron_helmet', 1, prot), torso: item('iron_chestplate', 1, prot), legs: item('iron_leggings'), feet: item('iron_boots') },
    items: [item('iron_sword', 1, [{ name: 'sharpness', lvl: 1 }]), item('cooked_beef', 10)]
  })
  ready.blockAt = lookup
  ready.game.dimension = 'overworld'
  assert.equal(outOfTheWay(ready, new Vec3(10.5, 41, 10.5)), false)
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

test('dumpPitFor: with no route\'s step to go by (a room made between steps, a trip), the pit goes PIT_DEPTH (2) under the floor, out of the reach of a bot walking by a block lower; a block less where the rock 2 down is missing', async () => {
  // (26.3 run full-26.3-fresh-f: the room made before a step dug its pits a block under the floor, the walk to the
  // next ore went by them a block lower, and the same stone was picked up and thrown three times)
  const { dumpPitFor, pitThrow, PIT_DEPTH } = await import('../../src/executor/explore')
  const { touches } = await import('../../src/skills/pickupDrops')
  assert.equal(PIT_DEPTH, 2)
  const feet = new Vec3(0, 20, 0)
  const room = { '0,20,0': 'air', '0,21,0': 'air' }
  for (const toward of [undefined, new Vec3(40.5, 20, 0.5)]) {
    const pit = dumpPitFor(world(room), feet, 0, toward)
    assert.ok(pit != null)
    assert.deepEqual(pit.open.map(c => c.y), [21, 20, 19, 18], String(toward))
    assert.equal(pit.bottom.y, 18)
    const item = pit.bottom.offset(0.5, 0, 0.5)
    // a bot by the pit on its floor, and a block lower beside it
    assert.equal(touches(feet.offset(0.5, 0, 0.5), item), false)
    assert.equal(touches(pit.side.plus(pit.side.minus(feet)).offset(0.5, -1, 0.5), item), false)
    assert.equal(touches(feet.offset(0.5, -1, 0.5), item), false)
    // (a pit 1 deep was in that one's reach)
    assert.equal(touches(feet.offset(0.5, -1, 0.5), item.offset(0, 1, 0)), true)
    // and a throw lands in its bottom
    const dug: Record<string, string> = { ...room }
    for (const c of pit.open) dug[`${c.x},${c.y},${c.z}`] = 'air'
    assert.ok(pitThrow(world(dug), feet.offset(0.5, 0, 0.5), pit.bottom) != null)
  }
  // a cave 2 under every side: a block deep
  const cave: Record<string, string> = { ...room }
  for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) cave[`${x},17,${z}`] = 'air'
  const shallow = dumpPitFor(world(cave), feet, 0)
  assert.ok(shallow != null && shallow.bottom.y === 19, String(shallow?.bottom))
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

test("floorHeld: a step's floor is there, or can be put against a block beside it the step doesn't open; on a bridge in the air, a step down off it has none (26.3 seed 31337: the staircase cut the bridge behind the bot)", () => {
  // a bridge of cobblestone at y 143 along z, the bot on it at (41, 144, 14), air all round
  const bridge: Record<string, string> = {}
  for (let z = -20; z <= 50; z++) bridge[`41,143,${z}`] = 'cobblestone'
  const air = (pos: Vec3) => {
    const name = bridge[`${pos.x},${pos.y},${pos.z}`] ?? 'air'
    return { name, boundingBox: SOLID.has(name) ? 'block' : 'empty' }
  }
  const feet = new Vec3(41, 144, 14)
  for (const dir of [new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(1, 0, 0), new Vec3(-1, 0, 0)]) {
    const down = staircaseStep(feet, dir)
    // the bridge block it opens is the only one by its floor: nothing to put a floor against, so it isn't dug
    assert.equal(floorHeld(air, down, true), false, `down ${dir}`)
  }
  // along the bridge: its block is the floor
  assert.equal(floorHeld(air, tunnelStep(feet, new Vec3(0, 0, -1)), false), true)
  // off its side: a floor put against the bridge block under the bot, with a block to put
  assert.equal(floorHeld(air, tunnelStep(feet, new Vec3(1, 0, 0)), true), true)
  assert.equal(floorHeld(air, tunnelStep(feet, new Vec3(1, 0, 0)), false), false)
  // a staircase over a cave in the rock: the floor put against the rock beside it
  const cave = world({ '1,18,0': 'air', '1,17,0': 'air' })
  assert.equal(floorHeld(cave, staircaseStep(new Vec3(0, 20, 0), new Vec3(1, 0, 0)), true), true)
  assert.equal(floorHeld(cave, staircaseStep(new Vec3(0, 20, 0), new Vec3(1, 0, 0)), false), false)
  assert.equal(floorHeld(world({}), staircaseStep(new Vec3(0, 20, 0), new Vec3(1, 0, 0)), false), true)
})

test('climbHazard: a bot in the water already digs its climb by the water, never by lava; a dry one by neither', () => {
  const step = tunnelStep(new Vec3(0, 20, 0), new Vec3(1, 0, 0))
  const wet = unsafeStep(world({ '2,20,0': 'water' }), step)
  assert.match(wet ?? '', /^water at/)
  assert.equal(climbHazard(wet, true), null)
  assert.equal(climbHazard(wet, false), wet)
  const lava = unsafeStep(world({ '2,20,0': 'lava' }), step)
  assert.equal(climbHazard(lava, true), lava)
  assert.equal(climbHazard(null, true), null)
})

test('stuck legs: a spot a leg ended short at twice lately is passed by the legs whose way goes by it; once, or long ago, not', async () => {
  const { WorldMemory } = await import('../../src/core/memory')
  const memory = new WorldMemory()
  memory.now = 1000
  const spot = new Vec3(-131.6, 61, 47.5)
  assert.equal(noteStuckLeg(memory, spot), 1)
  assert.deepEqual(stuckSpots(memory), [])
  // the same pond 160000 ticks on... is long ago: one again
  memory.now += STUCK_LEG_TTL + 1
  assert.equal(noteStuckLeg(memory, spot.offset(2, 0, -1)), 1)
  // and again soon after, a few blocks off: the same spot, twice
  memory.now += 5000
  assert.equal(noteStuckLeg(memory, spot.offset(-3, 0, 2)), 2)
  const spots = stuckSpots(memory)
  assert.equal(spots.length, 1)
  // the leg from (-131, 65, 65) to (-136, -96) goes through it; one off to the east doesn't
  assert.equal(legPassesSpot(new Vec3(-131, 65, 65), { x: -136, z: -96 }, spots), true)
  assert.equal(legPassesSpot(new Vec3(-131, 65, 65), { x: 40, z: 64 }, spots), false)
  // from the spot itself, every leg starts there: none passed over for it
  assert.equal(legPassesSpot(spot, { x: -136, z: -96 }, spots), false)
  assert.equal(legPassesSpot(spot.offset(3, 0, 2), { x: 64, z: -48 }, spots), false)
  // two days on, forgotten
  memory.now += STUCK_LEG_TTL
  assert.deepEqual(stuckSpots(memory), [])
})

test('the hunt explores twice as far after each exploration that found none, to 384, past the legs walked before (26.3 seed 31337: the same 96-block spiral five times on a snowy mountain)', async () => {
  const { huntRadius, HUNT_EXPLORE_RADIUS, HUNT_EXPLORE_MAX } = await import('../../src/executor/steps')
  assert.deepEqual([0, 1, 2, 3, 9].map(huntRadius), [HUNT_EXPLORE_RADIUS, 192, 384, HUNT_EXPLORE_MAX, HUNT_EXPLORE_MAX])
  const center = { x: 0, z: 0 }
  const wps = spiralWaypoints(center, 16, 192)
  const i = firstLegBeyond(wps, center, 96)
  assert.ok(i > 0 && i < wps.length)
  for (const w of wps.slice(0, i)) assert.ok(Math.max(Math.abs(w.x), Math.abs(w.z)) <= 96)
  assert.ok(Math.max(Math.abs(wps[i].x), Math.abs(wps[i].z)) > 96)
  assert.equal(firstLegBeyond(wps, center), 0)
  assert.equal(firstLegBeyond(spiralWaypoints(center, 16, 96), center, 96), spiralWaypoints(center, 16, 96).length)
})

test("huntProgress: the spiral walked so far is the executor's across the plans (a plan made again goes on from its leg), by animals and radius; the step's own without it", async () => {
  const { huntProgress } = await import('../../src/executor/steps')
  const kept = new Map<string, { leg: number }>()
  const ctx = () => ({ state: {}, progress: (key: string) => kept.get(key) ?? kept.set(key, { leg: 0 }).get(key) as { leg: number } })
  const first = huntProgress(ctx(), ['cow', 'pig'], 96)
  first.progress.leg = 9
  // the next plan's step, a new state: on from leg 9
  assert.equal(huntProgress(ctx(), ['pig', 'cow'], 96).progress.leg, 9)
  // further out, a spiral of its own
  assert.equal(huntProgress(ctx(), ['cow', 'pig'], 192).progress.leg, 0)
  // no executor's: the step's state
  const state: Record<string, any> = {}
  huntProgress({ state }, ['cow'], 96).progress.leg = 3
  assert.equal(huntProgress({ state }, ['cow'], 96).progress.leg, 3)
})

test('bridgePlaceCost: a block put over 4 blocks and more of open air (a bridge across a valley) costs more; one with ground under it, or a short gap, not', () => {
  // the valley's floor at y 70, the bridge's level at y 98
  const valley = (pos: Vec3) => ({ name: pos.y <= 70 ? 'stone' : 'air', boundingBox: pos.y <= 70 ? 'block' : 'empty' })
  const cost = bridgePlaceCost(valley)
  assert.equal(cost({ position: new Vec3(0, 97, 0) }), BRIDGE_PLACE_COST)
  // a block on the ground (a pillar's first), or 3 over it
  assert.equal(cost({ position: new Vec3(0, 71, 0) }), 0)
  assert.equal(cost({ position: new Vec3(0, 74, 0) }), 0)
  assert.equal(cost({ position: new Vec3(0, 75, 0) }), BRIDGE_PLACE_COST)
  // unloaded below: no opinion
  assert.equal(bridgePlaceCost(() => null)({ position: new Vec3(0, 97, 0) }), 0)
})

test('leftWhenSubmerged: a mine step leaves the ores, the stones and a lake floor (sand, gravel, clay) with water against them; logs not', async () => {
  const { leftWhenSubmerged } = await import('../../src/executor/steps')
  assert.equal(leftWhenSubmerged(['sand'], 'sand'), true)
  assert.equal(leftWhenSubmerged(['gravel'], 'gravel'), true)
  assert.equal(leftWhenSubmerged(['iron_ore', 'deepslate_iron_ore'], 'iron_ore'), true)
  assert.equal(leftWhenSubmerged(['stone'], 'stone'), true)
  assert.equal(leftWhenSubmerged(['oak_log'], 'oak_log'), false)
})

test('climbOut: no step dug through what the pathfinder is kept from breaking (breakKept: the base\'s roof), the climb given up; with the roof not kept, its steps dug (ls-1.21.11: up through its own house\'s roof)', async () => {
  const { breakKept, climbOut } = await import('../../src/executor/explore')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  // a 1 × 2 pocket at y 64 under stone, the roof from y 66 up kept
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [item('stone_pickaxe'), item('cobblestone', 16)], world: (p: Vec3) => p.x === 0 && p.z === 0 && (p.y === 64 || p.y === 65) ? 'air' : p.y > 90 ? 'air' : 'stone' })
  bot.game.dimension = 'overworld'
  const kept = (block: any): number => block.position.y >= 66 && block.position.y < 70 ? 1e9 : 0
  bot.pathfinder = { defaultMoveSettings: { exclusionAreasBreak: [kept] }, setMoveOptions (s: any) { this.defaultMoveSettings = s } }
  let digs = 0
  bot.pathingUtil = { refresh () { digs++; throw new Error('no dig in this test') } }
  assert.equal(breakKept(bot, new Vec3(0, 66, 0)), true)
  assert.equal(breakKept(bot, new Vec3(1, 65, 0)), false, 'the wall beside')
  assert.equal(breakKept(bot, new Vec3(0, 65, 0)), false, 'air')
  assert.equal(await climbOut(bot, { room: async () => {}, maxSteps: 2 }), false)
  assert.equal(digs, 0, 'nothing dug')
  bot.pathfinder.defaultMoveSettings.exclusionAreasBreak = []
  assert.equal(await climbOut(bot, { room: async () => {}, maxSteps: 2 }), false)
  assert.ok(digs > 0, 'the roof not kept: its steps tried')
})

test('climbToward: already at the target height, nothing dug; no step it can take (all its ways kept from breaking), false', async () => {
  const { climbToward } = await import('../../src/executor/explore')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [item('stone_pickaxe'), item('cobblestone', 16)], world: (p: Vec3) => p.x === 0 && p.z === 0 && (p.y === 64 || p.y === 65) ? 'air' : p.y > 90 ? 'air' : 'stone' })
  bot.game.dimension = 'the_nether'
  let digs = 0
  bot.pathingUtil = { refresh () { digs++; throw new Error('no dig in this test') } }
  bot.pathfinder = { defaultMoveSettings: { exclusionAreasBreak: [] }, setMoveOptions (s: any) { this.defaultMoveSettings = s } }
  assert.equal(await climbToward(bot, new Vec3(5, 64, 0), { room: async () => {} }), true)
  assert.equal(digs, 0)
  bot.pathfinder.defaultMoveSettings.exclusionAreasBreak = [() => 1e9]
  assert.equal(await climbToward(bot, new Vec3(5, 70, 0), { room: async () => {}, maxSteps: 2 }), false)
  assert.equal(digs, 0)
})

test('runMine: the logs collectBlock couldn\'t get to are noted unreachable, and the next run goes for others (ls-1.21.11: the same log planned 48 times, no path each time); UnreachableBlocks forgets them after UNREACHABLE_TICKS', async (t) => {
  const { runMine } = await import('../../src/executor/steps')
  const { UnreachableBlocks, UNREACHABLE_TICKS } = await import('../../src/executor/sight')
  const { WorldMemory } = await import('../../src/core/memory')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const registry = require('minecraft-data')('1.21.11')
  const logs = Array.from({ length: 24 }, (_, i) => new Vec3(6 + i, 64, 0))
  const bot: any = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [item('stone_axe')], world: (pos: Vec3) => logs.some(l => l.equals(pos)) ? 'oak_log' : pos.y < 64 ? 'stone' : 'air' })
  bot.game.dimension = 'overworld'
  const blockAt = bot.blockAt
  bot.blockAt = (pos: Vec3) => { const b = blockAt(pos); b.type = registry.blocksByName[b.name].id; b.harvestTools = registry.blocksByName[b.name].harvestTools; return b }
  bot.findBlocks = () => logs
  const targets: string[] = []
  // every walk to a log fails: no path (the bot shut in)
  bot.pathingUtil = { refresh: () => {}, bestHarvestingTool: (block: any) => { targets.push(block.position.toString()); return null } }
  bot.pathfinder = { get world () { throw new Error('no path to the goal') } }
  // (the ticks unstick's walk waits on)
  const ticker = setInterval(() => { for (let i = 0; i < 20; i++) bot.emit('physicsTick') }, 1)
  t.after(() => clearInterval(ticker))
  let tick = 0
  const unreachable = new UnreachableBlocks(() => tick)
  const step: any = { kind: 'mine', item: 'oak_log', count: 1, block: 'oak_log', blocks: ['oak_log'], blockCount: 1, tool: null, dimension: 'overworld' }
  const ctx = (): any => ({ bot, memory: new WorldMemory(), signal: new AbortController().signal, state: {}, log: () => {}, unreachable: { note: (ps: Vec3[]) => unreachable.note(ps, 'overworld'), has: (p: Vec3) => unreachable.has(p, 'overworld') } })
  await assert.rejects(runMine(step, ctx()))
  const first = new Set(targets)
  assert.ok(first.size > 0)
  for (const t of first) assert.ok(unreachable.has(logs.find(l => l.toString() === t)!, 'overworld'), `${t} noted`)
  targets.length = 0
  await assert.rejects(runMine(step, ctx()))
  assert.ok(targets.length > 0 && targets.every(t => !first.has(t)), `the next run goes for others: ${targets.join(' ')}`)
  assert.equal(unreachable.has(logs[0], 'the_nether'), false, 'another dimension')
  tick = UNREACHABLE_TICKS
  assert.equal(unreachable.has(logs[0], 'overworld'), false, 'forgotten after its ticks')
})

test('dryStandNear: out of a flooded pit 7 deep, the dry ground at its rim; none out in a lake', async () => {
  const { dryStandNear } = await import('../../src/executor/explore')
  // stone up to y 62, a pit at x 0 z 0 from 56 to 62 full of water, air over the stone
  const pit = (p: Vec3) => {
    const name = p.x === 0 && p.z === 0 && p.y >= 56 && p.y <= 62 ? 'water' : p.y <= 62 ? 'stone' : 'air'
    return { name, boundingBox: name === 'stone' ? 'block' : 'empty' }
  }
  const out = dryStandNear(pit, new Vec3(0.5, 56, 0.5))
  assert.ok(out != null)
  assert.equal(out.y, 63)
  assert.ok(Math.hypot(out.x, out.z) <= 1.5, out.toString())
  const lake = (p: Vec3) => ({ name: p.y >= 50 && p.y <= 62 ? 'water' : p.y < 50 ? 'stone' : 'air', boundingBox: p.y < 50 ? 'block' : 'empty' })
  assert.equal(dryStandNear(lake, new Vec3(0.5, 60, 0.5)), null)
})

test('swimTo: out of the water by the keys, forward toward the stand with the jump held, when the pathfinder\'s way out fails (f1-grim resumed)', async () => {
  const { swimTo } = await import('../../src/executor/explore')
  const { fakeBot } = await import('../reflexes/fakeBot')
  // a pond for x < 3 (y 60 to 62), the shore's ground beyond
  const bot = fakeBot({ position: new Vec3(0.5, 61, 0.5), world: (p: Vec3) => p.x < 3 && p.y >= 60 && p.y <= 62 ? 'water' : p.y <= 62 ? 'stone' : 'air' })
  const held: string[] = []
  // each tick, forward and jump held: a little on and up (the swim), onto the shore's top once past it
  const timer = setInterval(() => {
    if (bot.controls.forward === true && bot.controls.jump === true) {
      held.push('swim')
      const p = bot.entity.position
      bot.entity.position = new Vec3(p.x + 0.25, p.x + 0.25 >= 3 ? 63 : 61.5, p.z)
    }
    bot.emit('physicsTick')
  }, 1)
  try {
    assert.equal(await swimTo(bot, new Vec3(4, 63, 0)), true)
  } finally {
    clearInterval(timer)
  }
  assert.ok(held.length > 0 && held.length < 40, `${held.length} ticks swimming`)
  assert.deepEqual(bot.controls, {})
})

test('dumpPitFor: no pit in a column the bot\'s box stands over (bodyColumns: its feet at x -18.3, the box\'s edge on x -18 counted), the block under it there what may hold the bot up (f5-1.21.11: the throw\'s pit dug under the bot by a lava lake\'s cave)', async () => {
  const { dumpPitFor, bodyColumns } = await import('../../src/executor/explore')
  assert.deepEqual(bodyColumns(new Vec3(-18.3, 20, 0.5)).map(p => `${p.x},${p.z}`).sort(), ['-18,0', '-19,0'].sort())
  assert.deepEqual(bodyColumns(new Vec3(-18.5, 20, 0.5)).map(p => `${p.x},${p.z}`), ['-19,0'])
  // a corridor along x at y 20 and 21 from x -22 to -14, the bot facing +x at x -18.3 (feet -19)
  const cells: Record<string, string> = {}
  for (let x = -22; x <= -14; x++) for (const y of [20, 21]) cells[`${x},${y},0`] = 'air'
  // bedrock round the bot's cell but ahead (+x): no pit to its sides nor behind
  for (const y of [18, 19, 20, 21]) { cells[`-19,${y},1`] = 'bedrock'; cells[`-19,${y},-1`] = 'bedrock'; cells[`-20,${y},0`] = 'bedrock' }
  const feet = new Vec3(-19, 20, 0)
  const free = dumpPitFor(world(cells), feet, -Math.PI / 2)
  assert.ok(free != null && free.side.x === -18, String(free?.side))
  // the box over x -18 too: not there
  assert.equal(dumpPitFor(world(cells), feet, -Math.PI / 2, undefined, bodyColumns(new Vec3(-18.3, 20, 0.5))), null)
})
