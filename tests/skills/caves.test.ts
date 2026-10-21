import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { CAVE_BREAK_COST, CAVE_CELLS, CAVE_FORBID, CAVE_STEP_COST, CaveCells, caveBreakCost, caveCells, caveReady, caveStepCost, caveUnreadiness, dugByBot, keepOutOfCaves, type CaveView } from '../../src/skills/caves'
import { fakeBot, item } from '../reflexes/fakeBot'

const SOLID = new Set(['stone', 'deepslate', 'cobblestone', 'dirt', 'oak_planks'])

/** stone up to y 70 (air over it), the cells given their blocks */
function view (cells: Record<string, string>, opts: { lit?: Set<string>, dug?: Set<string> } = {}): CaveView {
  return {
    block: (p: Vec3) => {
      const name = cells[`${p.x},${p.y},${p.z}`] ?? (p.y > 70 ? 'air' : 'stone')
      return { name, boundingBox: SOLID.has(name) ? 'block' : 'empty' }
    },
    light: (p: Vec3) => opts.lit?.has(`${p.x},${p.y},${p.z}`) === true ? 14 : 0,
    dug: (p: Vec3) => opts.dug?.has(`${p.x},${p.y},${p.z}`) === true
  }
}

/** the cells of a box from `a` to `b`, all of `name` */
function box (a: [number, number, number], b: [number, number, number], name = 'air'): Record<string, string> {
  const out: Record<string, string> = {}
  for (let x = a[0]; x <= b[0]; x++) for (let y = a[1]; y <= b[1]; y++) for (let z = a[2]; z <= b[2]; z++) out[`${x},${y},${z}`] = name
  return out
}

/** a dug tunnel's cells: 1 wide, 2 high, along x from x0 to x1 at y and z */
function tunnel (x0: number, x1: number, y = 20, z = 0): Record<string, string> {
  return box([x0, y, z], [x1, y + 1, z])
}

test('a cave (a room of plain air under the rock, the noise caves\') is one, its corner cells too; a tunnel and a staircase are not', () => {
  const cave = box([0, 20, 0], [6, 23, 6])
  const cells = new CaveCells(view(cave))
  assert.equal(cells.isCave(new Vec3(3, 21, 3)), true)
  // (a corner of it: the flood finds the rest within its reach)
  assert.equal(new CaveCells(view(cave)).isCave(new Vec3(0, 20, 0)), true)
  // a long tunnel the bot dug, and a crossing of two
  const t = new CaveCells(view({ ...tunnel(-30, 30), ...box([0, 20, -30], [0, 21, 30]) }))
  assert.equal(t.isCave(new Vec3(10, 20, 0)), false)
  assert.equal(t.isCave(new Vec3(0, 20, 0)), false)
  // a staircase down along x
  const stairs: Record<string, string> = {}
  for (let i = 0; i < 20; i++) Object.assign(stairs, box([i, 40 - i, 0], [i, 42 - i, 0]))
  assert.equal(new CaveCells(view(stairs)).isCave(new Vec3(10, 31, 0)), false)
  // solid rock is no cave
  assert.equal(cells.isCave(new Vec3(20, 20, 20)), false)
})

test('cave_air (the carvers\' caves and ravines, a mineshaft\'s corridor) is a cave\'s however small, and the cells joined to it', () => {
  const cells = new CaveCells(view({ '0,20,0': 'cave_air', '1,20,0': 'air', '2,20,0': 'air' }))
  assert.equal(cells.isCave(new Vec3(0, 20, 0)), true)
  assert.equal(cells.isCave(new Vec3(2, 20, 0)), true)
  // a mineshaft's corridor: rails and cobwebs are open cells
  const shaft = { ...box([0, 20, -1], [20, 22, 1]), '5,20,0': 'rail', '6,21,1': 'cobweb' }
  assert.equal(new CaveCells(view(shaft)).isCave(new Vec3(6, 21, 1)), true)
})

test('under the open sky, under a house\'s roof, lit or dug by the bot: no cave', () => {
  // a pit open to the sky (the column's top under the cells)
  const pit = box([0, 60, 0], [6, 70, 6])
  assert.equal(new CaveCells(view(pit)).isCave(new Vec3(3, 65, 3)), false)
  // a room under a roof 2 over its floor (a house's: the rock's top is the roof, under CAVE_ROOF)
  const house: Record<string, string> = { ...box([0, 71, 0], [6, 72, 6]), ...box([0, 73, 0], [6, 73, 6], 'oak_planks') }
  assert.equal(new CaveCells(view(house)).isCave(new Vec3(3, 71, 3)), false)
  // the same cave lit by torches (no spawning there) or dug out by the bot
  const cave = box([0, 20, 0], [6, 23, 6])
  const all = new Set(Object.keys(cave))
  assert.equal(new CaveCells(view(cave, { lit: all })).isCave(new Vec3(3, 21, 3)), false)
  assert.equal(new CaveCells(view(cave, { dug: all })).isCave(new Vec3(3, 21, 3)), false)
})

test('a tunnel dug into a cave: its own cells are no cave\'s, the cave\'s cells against its end are (beside)', () => {
  const t = tunnel(-10, -1)
  const cave = box([0, 20, -3], [6, 23, 3])
  const cells = new CaveCells(view({ ...t, ...cave }, { dug: new Set(Object.keys(t)) }))
  assert.equal(cells.isCave(new Vec3(-1, 20, 0)), false)
  const end = [new Vec3(-1, 20, 0), new Vec3(-1, 21, 0)]
  assert.deepEqual(cells.beside(end).map(p => p.toArray()), [[0, 20, 0], [0, 21, 0]])
  // a tunnel far from it: nothing beside
  assert.deepEqual(cells.beside([new Vec3(-8, 20, 0), new Vec3(-8, 21, 0)]), [])
})

test('a flood of fewer open cells than CAVE_CELLS (a pocket, a crack) is no cave; forget() lets a change in', () => {
  const pocket = box([0, 20, 0], [2, 21, 2])
  assert.ok(Object.keys(pocket).length < CAVE_CELLS)
  const world: Record<string, string> = { ...pocket }
  const cells = new CaveCells(view(world))
  assert.equal(cells.isCave(new Vec3(1, 20, 1)), false)
  Object.assign(world, box([3, 20, 0], [8, 23, 6]))
  assert.equal(cells.isCave(new Vec3(1, 20, 1)), false)
  cells.forget()
  assert.equal(cells.isCave(new Vec3(1, 20, 1)), true)
})

test('caveReady: four iron pieces worn, two enchanted, an enchanted iron sword, the bar at 18 and 40 points of cooked food', () => {
  const prot = [{ name: 'protection', lvl: 2 }]
  const kit = (over: { armor?: any, items?: any[], food?: number, health?: number } = {}): any => fakeBot({
    armor: over.armor ?? { head: item('iron_helmet', 1, prot), torso: item('iron_chestplate', 1, prot), legs: item('iron_leggings'), feet: item('iron_boots') },
    items: over.items ?? [item('iron_sword', 1, [{ name: 'sharpness', lvl: 1 }]), item('cooked_beef', 5)],
    food: over.food ?? 20,
    health: over.health ?? 20
  })
  assert.equal(caveUnreadiness(kit()), null)
  assert.equal(caveReady(kit()), true)
  // the early game's kit: plain iron, a stone sword
  assert.match(caveUnreadiness(kit({ armor: { head: item('iron_helmet'), torso: item('iron_chestplate'), legs: item('iron_leggings'), feet: item('iron_boots') } })) ?? '', /not enchanted/)
  assert.match(caveUnreadiness(kit({ items: [item('stone_sword', 1, [{ name: 'sharpness', lvl: 1 }]), item('cooked_beef', 5)] })) ?? '', /sword/)
  assert.match(caveUnreadiness(kit({ items: [item('iron_sword'), item('cooked_beef', 5)] })) ?? '', /sword/)
  // a piece missing, or leather
  assert.match(caveUnreadiness(kit({ armor: { head: item('iron_helmet', 1, prot), torso: item('iron_chestplate', 1, prot), legs: item('iron_leggings') } })) ?? '', /armor/)
  assert.match(caveUnreadiness(kit({ armor: { head: item('leather_helmet', 1, prot), torso: item('iron_chestplate', 1, prot), legs: item('iron_leggings'), feet: item('iron_boots') } })) ?? '', /armor/)
  // hungry, raw meat only, hurt
  assert.match(caveUnreadiness(kit({ food: 16 })) ?? '', /food 16/)
  assert.match(caveUnreadiness(kit({ items: [item('iron_sword', 1, [{ name: 'sharpness', lvl: 1 }]), item('beef', 20), item('cooked_beef', 2)] })) ?? '', /16 points/)
  assert.match(caveUnreadiness(kit({ health: 8 })) ?? '', /health/)
  // diamond counts as iron and better
  assert.equal(caveReady(kit({ armor: { head: item('diamond_helmet', 1, prot), torso: item('diamond_chestplate', 1, prot), legs: item('iron_leggings'), feet: item('netherite_boots') } })), true)
})

test('the bot\'s classifier notes the cells it digs as its own and forgets its verdicts as blocks change near it', () => {
  const bot = fakeBot({ position: new Vec3(0.5, 20, 0.5) })
  let cave = true
  bot.blockAt = (p: Vec3) => {
    const open = cave && p.y >= 20 && p.y <= 23 && Math.abs(p.x) <= 4 && Math.abs(p.z) <= 4
    const name = open ? 'air' : p.y > 70 ? 'air' : 'stone'
    return { name, position: p, boundingBox: name === 'air' ? 'empty' : 'block' }
  }
  const cells = caveCells(bot)
  assert.equal(cells.isCave(new Vec3(1, 21, 1)), true)
  bot.emit('diggingCompleted', { position: new Vec3(1, 21, 1) })
  assert.equal(dugByBot(bot, new Vec3(1, 21, 1)), true)
  assert.equal(cells.isCave(new Vec3(1, 21, 1)), false)
  assert.equal(cells.isCave(new Vec3(2, 21, 1)), true)
  // the cave filled in: the verdict goes with the block update by the bot
  cave = false
  bot.emit('blockUpdate', { name: 'air', boundingBox: 'empty', position: new Vec3(2, 21, 1) }, { name: 'stone', boundingBox: 'block', position: new Vec3(2, 21, 1) })
  assert.equal(cells.isCave(new Vec3(2, 21, 1)), false)
})

const pf = require('@nxg-org/mineflayer-pathfinder')
const setup = require('@nxg-org/mineflayer-pathfinder/tests/setup')

/**
 * The fake rig under the rock (stone from y 64 up to 75, x -6 to 20, z -8 to 8): the bot at the end of the tunnel it
 * dug (x -5 to 0 at z 0, its cells noted as dug), a cave of plain air from x 3 to 9 (y 64 to 67, z -3 to 3) in the way,
 * and the goal in a pocket at x 14; digging cheap (digCost 0.02: a block 3 ticks by hand). The rig's bot wears nothing:
 * not cave-ready.
 */
async function caveRig (rule: boolean): Promise<{ bot: any, stop: () => void }> {
  const { rig } = setup.createCacheWorld('1.21.11', 64, new Vec3(-4.5, 64, 0.5))
  const bot = rig.bot
  const inCave = (x: number, y: number, z: number): boolean => x >= 3 && x <= 9 && y >= 64 && y <= 67 && z >= -3 && z <= 3
  for (let x = -6; x <= 20; x++) {
    for (let y = 64; y <= 75; y++) {
      for (let z = -8; z <= 8; z++) {
        const tunnel = z === 0 && x >= -5 && x <= 0 && y <= 65
        const pocket = z === 0 && x === 14 && y <= 65
        if (!tunnel && !pocket && !inCave(x, y, z)) bot.world.setBlock(new Vec3(x, y, z), 'stone')
      }
    }
  }
  bot.loadPlugin(pf.createPlugin({ pathfinderSettings: { partialPathProducer: false, searchTimeoutMs: 15000 } }))
  bot.pathfinder.setMoveOptions({ ...bot.pathfinder.defaultMoveSettings, canDig: true, canPlace: false, digCost: 0.02 })
  caveCells(bot)
  for (let x = -5; x <= 0; x++) for (const y of [64, 65]) bot.emit('diggingCompleted', { position: new Vec3(x, y, 0) })
  if (rule) keepOutOfCaves(bot)
  return { bot, stop: () => rig.stopPassivePhysics() }
}

test('keepOutOfCaves: a bot not fit for the caves digs its way round a cave in the way, one with the rule off walks through it', { timeout: 60000 }, async () => {
  const cave = (m: any): boolean => m.x >= 3 && m.x <= 9 && m.y >= 64 && m.y <= 67 && m.z >= -3 && m.z <= 3
  for (const rule of [false, true]) {
    const { bot, stop } = await caveRig(rule)
    try {
      assert.equal(caveReady(bot), false)
      let final: any
      for await (const res of bot.pathfinder.getPathTo(new pf.goals.GoalBlock(14, 64, 0))) final = res
      assert.equal(final?.result?.status, 'success')
      const through = final.result.path.filter(cave)
      if (rule) assert.deepEqual(through.map((m: any) => `${m.x},${m.y},${m.z}`), [], 'the way through the cave')
      else assert.ok(through.length > 0, 'the way without the rule is the cave\'s')
    } finally {
      stop()
    }
  }
})

test('caveStepCost and caveBreakCost: a cave\'s cell, and a block against one, cost more under the rule; nothing in the rock or when cave-ready', () => {
  const bot = fakeBot({ position: new Vec3(0.5, 20, 0.5) })
  bot.game.dimension = 'overworld'
  bot.blockAt = (p: Vec3) => {
    const open = p.y >= 20 && p.y <= 23 && p.x >= 2 && p.x <= 8 && Math.abs(p.z) <= 3
    const name = open ? 'air' : p.y > 70 ? 'air' : 'stone'
    return { name, position: p, boundingBox: name === 'air' ? 'empty' : 'block' }
  }
  const step = caveStepCost(bot)
  const brk = caveBreakCost(bot)
  // out of the cave: no way into it; in it, its way out costs CAVE_STEP_COST a cell
  assert.equal(step({ position: { x: 4, y: 21, z: 0 } }), CAVE_FORBID)
  bot.entity.position = new Vec3(5.5, 20, 0.5)
  assert.equal(step({ position: { x: 4, y: 21, z: 0 } }), CAVE_STEP_COST)
  bot.entity.position = new Vec3(0.5, 20, 0.5)
  assert.equal(step({ position: { x: 0, y: 21, z: 0 } }), 0)
  assert.equal(brk({ position: { x: 1, y: 21, z: 0 } }), CAVE_BREAK_COST)
  assert.equal(brk({ position: { x: 0, y: 21, z: 0 } }), 0)
  // in the nether, or cave-ready: no rule
  bot.game.dimension = 'the_nether'
  bot.emit('physicsTick')
  assert.equal(step({ position: { x: 4, y: 21, z: 0 } }), 0)
})

test('caveStepHazard: a staircase\'s or a tunnel\'s step into a cave, against one or over one is a cave\'s; one in the rock beside it not', async () => {
  const { caveStepHazard } = await import('../../src/skills/caves')
  const { staircaseStep, tunnelStep } = await import('../../src/executor/explore')
  // a cave from x 3 to 9 (y 18 to 21, z -3 to 3); the bot's tunnel at z 0 up to x 0, its cells dug
  const t = tunnel(-6, 0)
  const cells = new CaveCells(view({ ...t, ...box([3, 18, -3], [9, 21, 3]) }, { dug: new Set(Object.keys(t)) }))
  const body = [new Vec3(0, 20, 0), new Vec3(0, 21, 0)]
  const east = new Vec3(1, 0, 0)
  // x 1: rock between; x 2: the next cells against the cave's at x 3
  assert.equal(caveStepHazard(cells, tunnelStep(new Vec3(0, 20, 0), east), body), null)
  assert.match(caveStepHazard(cells, tunnelStep(new Vec3(1, 20, 0), east), body) ?? '', /a cave at \(3, 2[01], 0\)/)
  assert.match(caveStepHazard(cells, tunnelStep(new Vec3(2, 20, 0), east), body) ?? '', /a cave at \(3, 20, 0\)/)
  // a staircase down over the cave: the step two over its roof (at 22) is in the rock, the next one opens the roof
  assert.equal(caveStepHazard(cells, staircaseStep(new Vec3(4, 24, 0), east)), null)
  assert.match(caveStepHazard(cells, staircaseStep(new Vec3(4, 23, 0), east)) ?? '', /cave/)
  // a step over the cave (its floor a cave's cell)
  assert.match(caveStepHazard(cells, { open: [new Vec3(5, 23, 5)], floor: new Vec3(5, 21, 3) }) ?? '', /under/)
  // north, away from it: nothing
  assert.equal(caveStepHazard(cells, tunnelStep(new Vec3(0, 20, 0), new Vec3(0, 0, -1)), body), null)
})

test('caveOpenings: the holes from the bot\'s tunnel into a cave, by its feet and head (not under it); sealed with cobblestone, none once cave-ready', async () => {
  const { caveOpenings, sealCaveOpenings } = await import('../../src/skills/caves')
  const filled = new Set<string>()
  const bot = fakeBot({ position: new Vec3(0.5, 20, 0.5), items: [item('cobblestone', 16)] })
  bot.game.dimension = 'overworld'
  bot.blockAt = (p: Vec3) => {
    const k = `${p.x},${p.y},${p.z}`
    const open = !filled.has(k) && ((p.z === 0 && p.x >= -6 && p.x <= 0 && (p.y === 20 || p.y === 21)) || (p.x >= 1 && p.x <= 7 && p.y >= 19 && p.y <= 23 && Math.abs(p.z) <= 3))
    const name = open ? 'air' : p.y > 70 ? 'air' : filled.has(k) ? 'cobblestone' : 'stone'
    return { name, position: p, boundingBox: name === 'air' ? 'empty' : 'block' }
  }
  caveCells(bot)
  for (let x = -6; x <= 0; x++) for (const y of [20, 21]) bot.emit('diggingCompleted', { position: new Vec3(x, y, 0) })
  assert.deepEqual(caveOpenings(bot).map(p => p.toArray()).sort(), [[1, 20, 0], [1, 21, 0]])
  const placed: string[] = []
  const mod = require('../../src/skills/placeBlock')
  const real = mod.placeBlock
  mod.placeBlock = async (_b: any, args: any) => { placed.push(`${args.item} ${args.pos.toString()}`); filled.add(`${args.pos.x},${args.pos.y},${args.pos.z}`); bot.emit('blockUpdate', { name: 'air', boundingBox: 'empty', position: args.pos }, { name: 'cobblestone', boundingBox: 'block', position: args.pos }) }
  try {
    assert.equal(await sealCaveOpenings(bot), 2)
  } finally {
    mod.placeBlock = real
  }
  assert.deepEqual(placed.sort(), ['cobblestone (1, 20, 0)', 'cobblestone (1, 21, 0)'])
  assert.deepEqual(caveOpenings(bot), [])
  // the bot in the cave itself: no openings to seal (it walks out first)
  bot.entity.position = new Vec3(4.5, 20, 0.5)
  assert.deepEqual(caveOpenings(bot), [])
})

test('sealPocket: the night\'s wait down the mine shut in where the bot stands, a tunnel\'s two ends (4 blocks); a room of 10, more than its most is none (ls3-1.21.11)', async () => {
  const { POCKET_MAX_BLOCKS, pocketCells, sealPocket } = await import('../../src/skills/caves')
  const tunnelWorld = (p: Vec3): string => p.z === 0 && (p.y === 20 || p.y === 21) && Math.abs(p.x) <= 8 ? 'air' : p.y > 70 ? 'air' : 'stone'
  const bot = fakeBot({ position: new Vec3(0.5, 20, 0.5), world: tunnelWorld, items: [item('cobblestone', 16)] })
  assert.deepEqual((await pocketCells(bot))?.map(p => p.toArray()).sort(), [[-1, 20, 0], [-1, 21, 0], [1, 20, 0], [1, 21, 0]])
  const mod = require('../../src/skills/sealIn')
  const real = mod.sealIn
  const calls: any[] = []
  mod.sealIn = async (_b: any, opts: any) => { calls.push(opts); return { placed: 4, ticks: 0, health: 20 } }
  try {
    assert.equal(await sealPocket(bot), 4)
    assert.equal(calls[0].healTo, 0)
    // a cave room 9 across: the back, the sides, a block for the roof, the roof and the front, POCKET_MAX_BLOCKS
    const room = fakeBot({ position: new Vec3(0.5, 20, 0.5), world: (p: Vec3) => Math.abs(p.x) <= 4 && Math.abs(p.z) <= 4 && p.y >= 20 && p.y <= 24 ? 'air' : p.y > 70 ? 'air' : 'stone', items: [item('cobblestone', 16)] })
    assert.equal((await pocketCells(room))?.length, POCKET_MAX_BLOCKS)
    assert.equal(await pocketCells(room, 8), null)
    // in the open air of a ravine's floor 12 wide under the sky: no roof to put up there (sealBox's null), CANNOT_PLACE
    const open = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [item('cobblestone', 16)] })
    const box = await pocketCells(open)
    if (box == null) {
      let err: any = null
      await sealPocket(open).catch(e => { err = e })
      assert.equal(err?.code ?? err?.reason, 'CANNOT_PLACE')
    }
    assert.equal(calls.length, 1)
  } finally {
    mod.sealIn = real
  }
})

test('watchCaveEntries: each way into a cave under the rule counted and logged, the gate\'s opening logged; none once cave-ready', async () => {
  const { caveEntries, watchCaveEntries } = await import('../../src/skills/caves')
  const bot = fakeBot({ position: new Vec3(-2.5, 20, 0.5) })
  bot.game.dimension = 'overworld'
  bot.blockAt = (p: Vec3) => {
    const open = (p.z === 0 && p.x >= -6 && p.x <= 0 && (p.y === 20 || p.y === 21)) || (p.x >= 1 && p.x <= 7 && p.y >= 19 && p.y <= 23 && Math.abs(p.z) <= 3)
    const name = open ? 'air' : p.y > 70 ? 'air' : 'stone'
    return { name, position: p, boundingBox: name === 'air' ? 'empty' : 'block' }
  }
  caveCells(bot)
  for (let x = -6; x <= 0; x++) for (const y of [20, 21]) bot.emit('diggingCompleted', { position: new Vec3(x, y, 0) })
  const lines: string[] = []
  watchCaveEntries(bot, l => lines.push(l))
  const walk = (x: number): void => { bot.entity.position = new Vec3(x + 0.5, 20, 0.5); bot.emit('physicsTick') }
  for (const x of [-1, 0, 1, 2, 3, 2, 1, 0, 1, 2]) walk(x)
  // (out and in again at once: a body at the cave's edge, one entry)
  assert.equal(caveEntries(bot), 1)
  walk(0)
  for (let i = 0; i < 40; i++) bot.emit('physicsTick')
  walk(1)
  assert.equal(caveEntries(bot), 2)
  assert.match(lines[0], /^caves: into a cave at 1 20 0 \(1 so far, not cave-ready: /)
  // ready (its kit put on): the gate's line, no more counting
  const prot = [{ name: 'protection', lvl: 1 }]
  for (const [slot, it] of [[5, item('iron_helmet', 1, prot)], [6, item('iron_chestplate', 1, prot)], [7, item('iron_leggings')], [8, item('iron_boots')], [9, item('iron_sword', 1, [{ name: 'sharpness', lvl: 1 }])], [10, item('cooked_beef', 10)]] as const) { (it as any).slot = slot; bot.inventory.slots[slot] = it }
  for (let i = 0; i < 40; i++) bot.emit('physicsTick')
  assert.ok(lines.some(l => /cave-ready now/.test(l)), lines.join('\n'))
  for (const x of [0, 1, 2]) walk(x)
  assert.equal(caveEntries(bot), 2)
})

test('keepOutOfCaves: a wide cave in the way is dug round however dear the digging (CAVE_FORBID: no way through it at all), through it without the rule or at CAVE_STEP_COST a cell, and a bot in a cave walks out of it', { timeout: 180000 }, async () => {
  // rock from y 64 to 75; a cave 31 across (x 3 to 33, z -15 to 15) between the bot's tunnel and the goal at x 38; a
  // block dug by hand 45 ticks (digCost 0.3): round the cave some 6000 ticks, through it 31 cells (3100 at CAVE_STEP_COST)
  const inCave = (x: number, y: number, z: number): boolean => x >= 3 && x <= 33 && y >= 64 && y <= 67 && z >= -15 && z <= 15
  for (const mode of ['none', 'cost', 'rule']) {
    const { rig } = setup.createCacheWorld('1.21.11', 64, new Vec3(-2.5, 64, 0.5))
    const bot = rig.bot
    // (a shell of bedrock round the rock: no way round it over the open ground outside)
    for (let x = -5; x <= 41; x++) for (let y = 64; y <= 76; y++) for (let z = -20; z <= 20; z++) {
      const shell = x === -5 || x === 41 || z === -20 || z === 20 || y === 76
      const tunnel = z === 0 && x >= -3 && x <= 0 && y <= 65
      const goal = z === 0 && x === 38 && y <= 65
      if (shell) bot.world.setBlock(new Vec3(x, y, z), 'bedrock')
      else if (!tunnel && !goal && !inCave(x, y, z)) bot.world.setBlock(new Vec3(x, y, z), 'stone')
    }
    bot.loadPlugin(pf.createPlugin({ pathfinderSettings: { partialPathProducer: false, searchTimeoutMs: 60000 } }))
    bot.pathfinder.setMoveOptions({ ...bot.pathfinder.defaultMoveSettings, canDig: true, canPlace: false, digCost: 1 })
    caveCells(bot)
    for (let x = -3; x <= 0; x++) for (const y of [64, 65]) bot.emit('diggingCompleted', { position: new Vec3(x, y, 0) })
    if (mode === 'rule') keepOutOfCaves(bot)
    // (the old rule: CAVE_STEP_COST a cave's cell, the bot in the cave or not)
    if (mode === 'cost') {
      const settings = bot.pathfinder.defaultMoveSettings
      bot.pathfinder.setMoveOptions({ ...settings, exclusionAreasStep: [...settings.exclusionAreasStep, (b: any) => caveCells(bot).isCave(b.position) ? CAVE_STEP_COST : 0] })
    }

    try {
      let final: any
      for await (const res of bot.pathfinder.getPathTo(new pf.goals.GoalBlock(38, 64, 0))) final = res
      assert.equal(final?.result?.status, 'success', mode)
      const through = final.result.path.filter((m: any) => inCave(m.x, m.y, m.z))
      if (mode === 'rule') assert.deepEqual(through.map((m: any) => `${m.x},${m.y},${m.z}`), [])
      else assert.ok(through.length > 0, `${mode}: the way through the cave`)
      if (mode === 'rule') {
        // the bot down in the cave: a way out of it (to its tunnel) all the same
        const a = caveStepCost(bot)
        bot.entity.position = new Vec3(10.5, 64, 0.5)
        assert.equal(a({ position: { x: 9, y: 64, z: 0 } }), CAVE_STEP_COST)
      }
    } finally {
      rig.stopPassivePhysics()
    }
  }
})

test('tunnelTo: a dug way that would open into a cave is turned from under the cave rule (NO_PATH with no other way), nothing dug', async () => {
  const { tunnelTo } = await import('../../src/skills/tunnel')
  // the bot in its dug cell at x 0 (y 20), the target 10 east, a cave from x 2 to 8 in the way
  const bot = fakeBot({ position: new Vec3(0.5, 20, 0.5), world: (p: Vec3) => (p.x >= 2 && p.x <= 8 && p.y >= 19 && p.y <= 23 && Math.abs(p.z) <= 3) || (p.x === 0 && p.z === 0 && (p.y === 20 || p.y === 21)) ? 'air' : p.y > 70 ? 'air' : 'stone' })
  bot.game.dimension = 'overworld'
  caveCells(bot)
  for (const y of [20, 21]) bot.emit('diggingCompleted', { position: new Vec3(0, y, 0) })
  let dug = 0
  bot.dig = async () => { dug++ }
  let err: any = null
  await tunnelTo(bot, { target: new Vec3(10, 20, 0), range: 1 }).catch(e => { err = e })
  assert.equal(err?.code ?? err?.reason, 'NO_PATH')
  assert.equal(dug, 0)
})

test('tunnelTo with caves false (a way off the lava): the cave rule\'s turns left out, the step toward the cave dug', async () => {
  const { tunnelTo } = await import('../../src/skills/tunnel')
  const bot = fakeBot({ position: new Vec3(0.5, 20, 0.5), world: (p: Vec3) => (p.x >= 2 && p.x <= 8 && p.y >= 19 && p.y <= 23 && Math.abs(p.z) <= 3) || (p.x === 0 && p.z === 0 && (p.y === 20 || p.y === 21)) ? 'air' : p.y > 70 ? 'air' : 'stone' })
  bot.game.dimension = 'overworld'
  caveCells(bot)
  // (the fake bot's blocks dug as stone is)
  const blockAt = bot.blockAt
  bot.blockAt = (p: Vec3) => ({ ...blockAt(p), diggable: true })
  const actions = require('../../src/core/actions')
  const realDig = actions.dig
  let dug = 0
  actions.dig = async () => { dug++; throw new Error('stop here') }
  try {
    await tunnelTo(bot, { target: new Vec3(10, 20, 0), range: 1, caves: false }).catch(() => {})
    assert.ok(dug > 0)
    // (and with the rule, none: the same way turned from)
    dug = 0
    await tunnelTo(bot, { target: new Vec3(10, 20, 0), range: 1 }).catch(() => {})
    assert.equal(dug, 0)
  } finally {
    actions.dig = realDig
  }
})
