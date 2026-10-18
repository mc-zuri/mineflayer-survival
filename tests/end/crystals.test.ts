import { test } from 'node:test'
import assert from 'node:assert/strict'
import { boxEntry, cellsOnLine, planCrystals, spikeBlocks } from '../../src/end/crystals'
import { getSpikesForLevel } from '../../src/end/spikes'

test('every crystal gets a plan: shoot the open ones, pillar to the caged ones and open the cage', () => {
  const spikes = getSpikesForLevel(0)
  const plan = planCrystals(spikes, { from: { x: 0, z: 0 } })
  assert.equal(plan.length, 10)
  const blocks = spikeBlocks(spikes)
  for (const t of plan) {
    if (t.spike.guarded) {
      assert.equal(t.method, 'pillar')
      assert.ok(t.pillar != null && t.pillar.breakBars.length > 0)
      assert.equal(t.pillar.topY, t.spike.height + 1)
      // the column is just outside the obsidian
      const d = Math.hypot(t.pillar.column.x - t.spike.centerX, t.pillar.column.z - t.spike.centerZ)
      assert.ok(d > t.spike.radius && d < t.spike.radius + 3)
    } else {
      assert.equal(t.method, 'shoot')
    }
    assert.ok(t.shootFrom != null)
    assert.ok(t.shootFrom.distance >= 12)
    // the bow shot was flown with skills/arrow's vanilla arrow physics and enters the crystal's box
    assert.ok(t.shootFrom.shot.ticks > 0 && t.shootFrom.shot.ticks < 60)
    // with the planned bars broken, the line from the shooter's eyes is clear up to the crystal's box
    const broken = new Set((t.pillar?.breakBars ?? []).map(b => `${b.x},${b.y},${b.z}`))
    const eye = { x: t.shootFrom.x, y: t.shootFrom.y + 1.62, z: t.shootFrom.z }
    const hit = cellsOnLine(eye, boxEntry(eye, t.shootFrom.aim, t.crystal.box)).filter(c => blocks.has(`${c.x},${c.y},${c.z}`) && !broken.has(`${c.x},${c.y},${c.z}`))
    assert.deepEqual(hit, [], `spike ${t.spike.index}`)
  }
})

test('the route starts at the nearest and skips destroyed crystals; no bow means pillars everywhere', () => {
  const spikes = getSpikesForLevel(0)
  const plan = planCrystals(spikes, { from: { x: 30, z: 0 }, destroyed: [3, 4] })
  assert.equal(plan.length, 8)
  // nearest-neighbour from `from` over the places each crystal is dealt with from
  const at = (t: typeof plan[number]): { x: number, z: number } => t.shootFrom ?? { x: t.pillar?.column.x ?? 0, z: t.pillar?.column.z ?? 0 }
  const d0 = Math.hypot(at(plan[0]).x - 30, at(plan[0]).z)
  assert.ok(plan.every(t => Math.hypot(at(t).x - 30, at(t).z) >= d0))
  assert.ok(plan.every(t => t.spike.index !== 3 && t.spike.index !== 4))
  const melee = planCrystals(spikes, { bow: false })
  assert.ok(melee.every(t => t.method === 'pillar' && t.shootFrom == null))
})

test('a line through blocks lists the cells between its ends', () => {
  assert.deepEqual(cellsOnLine({ x: 0.5, y: 0.5, z: 0.5 }, { x: 3.5, y: 0.5, z: 0.5 }), [{ x: 1, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }])
})
