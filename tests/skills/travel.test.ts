import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { deadlySides, gridNeighbours, gridPath, type GridCellView } from '../../src/skills/gridWalk'
import { stepCells } from '../../src/skills/tunnel'
import { hopPoint } from '../../src/skills/travel'

test('hopPoint: hops of the given length toward the target, the target itself when near, turned for detours', () => {
  assert.deepEqual(hopPoint({ x: 0, z: 0 }, { x: 10, z: 0 }, 48), { x: 10, z: 0, last: true })
  const h = hopPoint({ x: 0, z: 0 }, { x: 100, z: 0 }, 48)
  assert.ok(Math.abs(h.x - 48) < 1e-9 && Math.abs(h.z) < 1e-9 && !h.last)
  const t = hopPoint({ x: 0, z: 0 }, { x: 100, z: 0 }, 48, Math.PI / 2)
  assert.ok(Math.abs(t.x) < 1e-9 && Math.abs(t.z - 48) < 1e-9)
})

/** a grid world from a set of solid cells, lava cells and harmful ones */
function view (solid: Set<string>, lava = new Set<string>()): GridCellView {
  const k = (p: Vec3): string => `${p.x},${p.y},${p.z}`
  return { free: p => !solid.has(k(p)) && !lava.has(k(p)), floor: p => solid.has(k(p)), lava: p => lava.has(k(p)) }
}

test('gridPath: round a wall through its gap, up a step, never beside lava', () => {
  const solid = new Set<string>()
  for (let x = -5; x <= 15; x++) for (let z = -5; z <= 5; z++) solid.add(`${x},63,${z}`)
  // a wall at x 4 with a gap at z 3; a step up at x 8..9; lava at (11, 64, -2) and (11, 64, -3)
  for (let z = -5; z <= 5; z++) if (z !== 3) { solid.add(`4,64,${z}`); solid.add(`4,65,${z}`) }
  for (let z = -5; z <= 5; z++) { solid.add(`8,64,${z}`); solid.add(`9,64,${z}`) }
  const lava = new Set(['11,64,-2', '11,64,-3'])
  const v = view(solid, lava)
  const path = gridPath(v, new Vec3(0, 64, 0), c => c.x === 12 && c.z === 0, c => Math.abs(c.x - 12) + Math.abs(c.z))
  assert.ok(path != null)
  assert.ok(path.some(c => c.x === 4 && c.z === 3), 'not through the gap')
  assert.ok(path.some(c => c.y === 65), 'not up the step')
  for (const c of path) for (const l of lava) { const [x, , z] = l.split(',').map(Number); assert.ok(Math.abs(c.x - x) + Math.abs(c.z - z) > 1 || c.y !== 64, `next to the lava at ${c.toString()}`) }
  // each step is to a neighbour
  let prev = new Vec3(0, 64, 0)
  for (const c of path) { assert.ok(gridNeighbours(v, prev).some(n => n.equals(c)), `${prev.toString()} -> ${c.toString()}`); prev = c }
})

test('gridPath: no path out of a closed room', () => {
  const solid = new Set<string>()
  for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) for (let y = 63; y <= 66; y++) if (y === 63 || Math.abs(x) === 2 || Math.abs(z) === 2) solid.add(`${x},${y},${z}`)
  assert.strictEqual(gridPath(view(solid), new Vec3(0, 64, 0), c => c.x === 10, c => Math.abs(c.x - 10), 2000), null)
})

test('tunnel steps: down a stair (head, feet, the cell under), or along at the feet and head', () => {
  const s = stepCells(new Vec3(0, 64, 0), new Vec3(1, 0, 0), true)
  assert.deepStrictEqual(s.clear.map(c => c.toString()), ['(1, 65, 0)', '(1, 64, 0)', '(1, 63, 0)'])
  assert.deepStrictEqual([s.stand.toString(), s.floor.toString()], ['(1, 63, 0)', '(1, 62, 0)'])
  const a = stepCells(new Vec3(0, 64, 0), new Vec3(0, 0, -1), false)
  assert.deepStrictEqual(a.clear.map(c => c.toString()), ['(0, 65, -1)', '(0, 64, -1)'])
  assert.deepStrictEqual([a.stand.toString(), a.floor.toString()], ['(0, 64, -1)', '(0, 63, -1)'])
})

test('inDeepWater and swimToward: out at sea the bot swims at the surface toward the point, jump held, until it stands on ground', async () => {
  const { inDeepWater, swimToward } = await import('../../src/skills/travel')
  const { fakeBot } = await import('../reflexes/fakeBot')
  // the sea to x 10, a beach from x 10 on (sand at y 62)
  const world = (p: Vec3): string => p.x >= 10 ? (p.y <= 62 ? 'sand' : 'air') : (p.y <= 50 ? 'sand' : p.y <= 62 ? 'water' : 'air')
  const lookup = (p: Vec3) => ({ name: world(p.floored()) })
  assert.strictEqual(inDeepWater(lookup, new Vec3(2.5, 61.6, 0.5)), true)
  assert.strictEqual(inDeepWater(lookup, new Vec3(12.5, 63, 0.5)), false)
  const bot = fakeBot({ position: new Vec3(0.5, 61.6, 0.5), world })
  bot.entity.onGround = false
  const timer = setInterval(() => {
    // the fake's swim: a tenth of a block a tick with forward held, on the beach once past x 10
    if (bot.controls.forward === true) bot.entity.position = bot.entity.position.offset(0.1, 0, 0)
    if (bot.entity.position.x >= 10.5) { bot.entity.position = new Vec3(bot.entity.position.x, 63, 0.5); bot.entity.onGround = true }
    bot.emit('physicsTick')
  }, 0)
  try {
    await swimToward(bot, new Vec3(40.5, 61.6, 0.5), 48)
  } finally {
    clearInterval(timer)
  }
  assert.ok(bot.entity.position.x >= 10.5 && bot.entity.position.x < 12, `${bot.entity.position.x}`)
  assert.deepStrictEqual(bot.controls, {})
})

test('travel to a height under the bot (exactY): the level grid walk leaves the height to the pathfinder, not looping on 0 cells', async () => {
  const gridModule = require('../../src/skills/gridWalk')
  const navModule = require('../../src/skills/navigate')
  const { travel } = await import('../../src/skills/travel')
  const { fakeBot } = await import('../reflexes/fakeBot')
  const bot = fakeBot({ position: new Vec3(0.5, 63, 0.5) })
  ;(bot as any).pathfinder = { pathfinderSettings: {}, defaultMoveSettings: {}, setOptions: () => {}, setMoveOptions: () => {} }
  ;(bot as any).world = { getColumnAt: () => ({}) }
  let grids = 0
  let navs = 0
  const realGrid = gridModule.gridWalk
  const realNav = navModule.navigate
  gridModule.gridWalk = async () => { grids++; if (grids > 20) throw new Error('looping'); return { cells: 0 } }
  navModule.navigate = async () => { navs++; bot.entity.position = new Vec3(0.5, 50, 0.5) }
  const ticking = setInterval(() => bot.emit('physicsTick'), 1)
  try {
    await travel(bot, { target: new Vec3(0, 50, 0), range: 2, exactY: true })
  } finally {
    clearInterval(ticking)
    gridModule.gridWalk = realGrid
    navModule.navigate = realNav
  }
  assert.equal(navs, 1)
  assert.ok(grids <= 2)
})

test('travel gives up after hops that leave the bot where it was, a tick each, not spinning', async () => {
  const gridModule = require('../../src/skills/gridWalk')
  const navModule = require('../../src/skills/navigate')
  const { travel, TRAVEL_STILL_HOPS } = await import('../../src/skills/travel')
  const { fakeBot } = await import('../reflexes/fakeBot')
  const bot = fakeBot({ position: new Vec3(0.5, 63, 0.5) })
  ;(bot as any).pathfinder = { pathfinderSettings: {}, defaultMoveSettings: {}, setOptions: () => {}, setMoveOptions: () => {} }
  ;(bot as any).world = { getColumnAt: () => ({}) }
  let ticks = 0
  bot.on('physicsTick', () => { ticks++ })
  const ticking = setInterval(() => bot.emit('physicsTick'), 1)
  const realGrid = gridModule.gridWalk
  const realNav = navModule.navigate
  let grids = 0
  // the grid walk 'succeeds' at once, 0 cells, the bot never moving
  gridModule.gridWalk = async () => { grids++; return { cells: 0 } }
  navModule.navigate = async () => {}
  try {
    await assert.rejects(travel(bot, { target: new Vec3(200, 63, 0), range: 2 }), /NO_PATH|no way on/)
  } finally {
    clearInterval(ticking)
    gridModule.gridWalk = realGrid
    navModule.navigate = realNav
  }
  assert.ok(grids <= TRAVEL_STILL_HOPS + 1, String(grids))
  assert.ok(ticks >= TRAVEL_STILL_HOPS, String(ticks))
})

test('gridPath: a ledge with a deadly fall either side is walked only with no edge cost; with one the way round is taken', () => {
  // a ledge a block wide along x at z 0 from x 1 to 9 over the void (the lava sea), the ground round it wide at z 5 to 8
  const solid = new Set<string>()
  for (let x = -3; x <= 13; x++) {
    for (let z = -3; z <= 8; z++) {
      const ledge = z === 0
      const ground = z >= 5 || x <= 0 || x >= 10
      if (ledge || ground) solid.add(`${x},63,${z}`)
    }
  }
  const lava = new Set<string>()
  for (let x = 1; x <= 9; x++) for (const z of [-1, 1, 2, 3, 4]) lava.add(`${x},60,${z}`)
  const goal = (c: Vec3): boolean => c.x === 10 && c.z === 0
  const h = (c: Vec3): number => Math.abs(c.x - 10) + Math.abs(c.z)
  const plain = view(solid, lava)
  assert.strictEqual(deadlySides(plain, new Vec3(5, 64, 0)), 2)
  assert.strictEqual(deadlySides(plain, new Vec3(-2, 64, 6)), 0)
  const straight = gridPath(plain, new Vec3(0, 64, 0), goal, h)
  assert.ok(straight != null && straight.every(c => c.z === 0), 'with no edge cost the ledge is the shortest')
  const careful = gridPath({ ...plain, edgeCost: 10 }, new Vec3(0, 64, 0), goal, h)
  assert.ok(careful != null)
  assert.ok(careful.every(c => c.z !== 0 || c.x <= 0 || c.x >= 10), `the path walks the ledge: ${careful.map(c => c.toString()).join(' ')}`)
})

test('dropLanding: a short drop onto ground is a step; a long one, or onto lava or through water, isn\'t', async () => {
  const { dropLanding } = await import('../../src/skills/tunnel')
  const room = (floorY: number, floor = 'stone') => (p: Vec3) => ({ name: p.y === floorY ? floor : p.y < floorY ? 'stone' : 'air', boundingBox: p.y <= floorY && floor !== 'lava' ? 'block' : 'empty' })
  assert.deepStrictEqual(dropLanding(room(60), new Vec3(0, 64, 0), 4), new Vec3(0, 61, 0))
  assert.strictEqual(dropLanding(room(55), new Vec3(0, 64, 0), 4), null)
  assert.strictEqual(dropLanding(room(60, 'lava'), new Vec3(0, 64, 0), 4), null)
})

test('GoalNearXZBand: near on x and z with the feet within the band of the height; its heuristic counts the height past the band', async () => {
  const { GoalNearXZBand } = await import('../../src/skills/travel')
  const goal = new GoalNearXZBand(100, 0, 6, 64, 20)
  assert.strictEqual(goal.isEnd({ x: 104, y: 80, z: 3 }), true)
  assert.strictEqual(goal.isEnd({ x: 104, y: 110, z: 3 }), false, 'up in the rock under the roof')
  assert.strictEqual(goal.isEnd({ x: 90, y: 64, z: 0 }), false)
  assert.strictEqual(goal.distHeuristic({ x: 100, y: 110, z: 0 }), 26)
  assert.strictEqual(goal.distHeuristic({ x: 97, y: 70, z: 4 }), 5)
})

test('tunnelTo never digs a portal frame\'s obsidian or the bot\'s chest', async () => {
  const actions = require('../../src/core/actions')
  const { tunnelTo } = await import('../../src/skills/tunnel')
  const { fakeBot } = await import('../reflexes/fakeBot')
  // obsidian and chests all round the bot's feet level and over it: no step can be dug
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), world: (p: any) => p.y < 63 ? 'stone' : (p.x === 0 && p.z === 0 && (p.y === 64 || p.y === 65)) ? 'air' : (p.x === 1 ? 'obsidian' : 'chest') })
  const realAt = bot.blockAt.bind(bot)
  bot.blockAt = ((p: any) => { const b = realAt(p); return b == null ? b : { ...b, diggable: true } }) as any
  const dug: string[] = []
  const real = actions.dig
  actions.dig = async (_b: unknown, block: any) => { dug.push(block.name) }
  try {
    await assert.rejects(tunnelTo(bot, { target: new Vec3(10, 64, 0), maxSteps: 3 }), /no safe step/)
  } finally {
    actions.dig = real
  }
  assert.deepEqual(dug, [])
})
