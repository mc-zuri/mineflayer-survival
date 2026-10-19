import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { gridNeighbours, gridPath, type GridCellView } from '../../src/skills/gridWalk'
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
  try {
    await travel(bot, { target: new Vec3(0, 50, 0), range: 2, exactY: true })
  } finally {
    gridModule.gridWalk = realGrid
    navModule.navigate = realNav
  }
  assert.equal(navs, 1)
  assert.ok(grids <= 2)
})
