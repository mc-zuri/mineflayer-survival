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
