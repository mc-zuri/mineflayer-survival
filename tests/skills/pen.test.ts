// The pen's plan without a server: the ring's fences, the gate in the middle of its side, the holes filled and the
// steps fenced on top.
import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import minecraftData from 'minecraft-data'
import { choosePenSite, inPen, nearestSide, penCells, penFromMemory, planPen, rememberPen } from '../../src/skills/pen'
import { WorldMemory } from '../../src/core/memory'
import { itemTags } from '../../src/core/tags'
import { VERSIONS } from '../versions'

type Cell = { name: string, boundingBox: string }
const air: Cell = { name: 'air', boundingBox: 'empty' }
const grass: Cell = { name: 'grass_block', boundingBox: 'block' }
const poppy: Cell = { name: 'poppy', boundingBox: 'empty' }

/** flat grass at y 63, the feet at 64, with some cells changed */
function ground (changes: Record<string, Cell> = {}): (p: Vec3) => Cell {
  return (p) => changes[`${p.x},${p.y},${p.z}`] ?? (p.y <= 63 ? grass : air)
}

const key = (p: Vec3): string => `${p.x},${p.y},${p.z}`

test('planPen: a 5 × 5 ring of 15 fences on flat ground, the gate in the middle of the south side, nothing to fill', () => {
  const plan = planPen(ground(), new Vec3(0, 64, 0), 5, 'south')
  assert.strictEqual(plan.size, 5)
  assert.deepStrictEqual(plan.gate.toArray(), [0, 64, 2])
  assert.deepStrictEqual(plan.inside.toArray(), [0, 64, 1])
  assert.deepStrictEqual(plan.outside.toArray(), [0, 64, 3])
  assert.strictEqual(plan.fences.length, 15)
  assert.ok(plan.fences.every(p => p.y === 64 && Math.max(Math.abs(p.x), Math.abs(p.z)) === 2))
  assert.ok(!plan.fences.some(p => p.equals(plan.gate)))
  assert.deepStrictEqual(plan.fillers, [])
  assert.deepStrictEqual(plan.clear, [])
  assert.strictEqual(penCells(plan).length, 16)
})

test('planPen: a hole under the ring is filled (two deep at most), a step up is fenced on top, a flower is cleared', () => {
  const plan = planPen(ground({
    // a hole two deep under (-2, 64, 0), one deep under the gate's walkway outside it
    '-2,63,0': air,
    '-2,62,0': air,
    '0,63,3': air,
    // a step up at (2, 64, 1), a flower at (1, 64, -2)
    '2,64,1': grass,
    '1,64,-2': poppy
  }), new Vec3(0, 64, 0), 5, 'south')
  assert.deepStrictEqual(plan.fillers.map(key), ['-2,62,0', '-2,63,0', '0,63,3'])
  assert.ok(plan.fences.some(p => key(p) === '2,65,1'), 'the step is fenced on top')
  assert.ok(!plan.fences.some(p => key(p) === '2,64,1'))
  assert.deepStrictEqual(plan.clear.map(key), ['1,64,-2'])
})

test('inPen and nearestSide: the inside cells, not the ring; the side facing a point', () => {
  const plan = planPen(ground(), new Vec3(10, 64, 10), 7, 'west')
  assert.deepStrictEqual(plan.gate.toArray(), [7, 64, 10])
  assert.ok(inPen(plan, new Vec3(10.5, 64, 10.5)))
  assert.ok(inPen(plan, new Vec3(8.2, 64, 12.9)))
  assert.ok(!inPen(plan, new Vec3(7.5, 64, 10.5)), 'the gate is not inside')
  assert.ok(!inPen(plan, new Vec3(13.5, 64, 10.5)))
  assert.strictEqual(nearestSide(new Vec3(0, 64, 0), new Vec3(-10, 64, 3)), 'west')
  assert.strictEqual(nearestSide(new Vec3(0, 64, 0), new Vec3(2, 64, 9)), 'south')
})

for (const version of VERSIONS) {
  test(`#wooden_fences and #fence_gates on ${version}: every wood's (the pen's materials), not the nether brick fence`, () => {
    const tags = itemTags(minecraftData(version))
    const fences = tags.members('#wooden_fences')
    assert.ok(fences.includes('oak_fence') && fences.includes('crimson_fence') && fences.includes('bamboo_fence'))
    assert.ok(!fences.includes('nether_brick_fence'))
    assert.ok(tags.members('#fence_gates').includes('spruce_fence_gate'))
    assert.ok(!tags.members('#fence_gates').includes('oak_fence'))
  })
}

test('choosePenSite: flat ground near home, not over the pond; a pen remembered comes back as planned', () => {
  // a pond west of home: x -20..-1 water at y 63
  const pond = (p: Vec3): Cell | null => (p.y === 63 && p.x < 0 ? { name: 'water', boundingBox: 'empty' } : null)
  const lookup = (p: Vec3): Cell => pond(p) ?? ground()(p)
  const site = choosePenSite(lookup, new Vec3(0, 64, 0), 7)
  assert.ok(site != null)
  const plan = planPen(lookup, site.center, 7, site.side)
  assert.ok(site.center.x - 3 >= 0, `the pen at ${site.center.toString()} is over the pond`)
  assert.deepStrictEqual(plan.fillers, [])
  // the gate faces home
  assert.ok(plan.gate.distanceTo(new Vec3(0, 64, 0)) < site.center.distanceTo(new Vec3(0, 64, 0)))

  const memory = new WorldMemory()
  rememberPen(memory, plan)
  const back = penFromMemory(memory, new Vec3(0, 64, 0))
  assert.ok(back != null)
  assert.deepStrictEqual(back.gate.toArray(), plan.gate.toArray())
  assert.deepStrictEqual(back.fences.map(key), plan.fences.map(key))
  assert.strictEqual(penFromMemory(memory, new Vec3(500, 64, 0)), null, 'none near another place')
})

test('planPen: a ring begun before (a try that failed) keeps its fences, on a step too, and nothing goes on top of them', () => {
  const fence: Cell = { name: 'oak_fence', boundingBox: 'block' }
  const gate: Cell = { name: 'oak_fence_gate', boundingBox: 'block' }
  const first = planPen(ground({ '2,64,1': grass }), new Vec3(0, 64, 0), 5, 'south')
  // the fences placed as far as it got (the step's on top of it), and the gate
  const changes: Record<string, Cell> = { '2,64,1': grass, '0,64,2': gate }
  for (const p of first.fences.slice(0, 9)) changes[key(p)] = fence
  changes['2,65,1'] = fence
  const again = planPen(ground(changes), new Vec3(0, 64, 0), 5, 'south')
  assert.deepStrictEqual(again.fences.map(key).sort(), first.fences.map(key).sort())
  assert.deepStrictEqual(again.clear, [], 'the gate is not dug out')
  assert.deepStrictEqual(again.fillers, [])
})

test('penBroken: a gap in the ring or no gate; blocks not loaded are not known broken', async () => {
  const { penBroken, ringOut } = await import('../../src/skills/pen')
  const plan = planPen(ground(), new Vec3(0, 64, 0), 5, 'south')
  const world: Record<string, string> = { [key(plan.gate)]: 'oak_fence_gate' }
  for (const p of plan.fences) world[key(p)] = 'oak_fence'
  const lookup = (p: Vec3): { name: string } | null => world[key(p)] != null ? { name: world[key(p)] } : null
  assert.strictEqual(penBroken(lookup, plan), false)
  world[key(plan.gate)] = 'air'
  assert.strictEqual(penBroken(lookup, plan), true, 'no gate')
  world[key(plan.gate)] = 'oak_fence_gate'
  world[key(plan.fences[3])] = 'leaf_litter'
  assert.strictEqual(penBroken(lookup, plan), true, 'a gap')
  delete world[key(plan.fences[3])]
  assert.strictEqual(penBroken(lookup, plan), false, 'not loaded')
  // the way across the ring at a cell: out of the pen
  assert.deepStrictEqual(ringOut(plan, plan.gate).toArray(), [0, 0, 1])
  assert.deepStrictEqual(ringOut(plan, new Vec3(-2, 64, 1)).toArray(), [-1, 0, 0])
})
