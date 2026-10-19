import { test } from 'node:test'
import assert from 'node:assert/strict'
import { boxEntry, cellsOnLine, pillarColumn, planCrystals, spikeBlocks } from '../../src/end/crystals'
import { cageBars, getSpikesForLevel, spikeColumns } from '../../src/end/spikes'
import { parseSeed } from '../../src/worldgen/random'

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

test('no shooting spot on a spike\'s top, where the ground a getter reads is the obsidian (seed endfight, spike 7 from beside spike 6)', () => {
  const spikes = getSpikesForLevel(parseSeed('endfight'))
  const columns = new Map<string, number>()
  for (const s of spikes) for (const c of spikeColumns(s)) columns.set(`${c.x},${c.z}`, s.height)
  // the world's ground: the island at 65, a spike's top where there is one
  const groundY = (x: number, z: number): number => columns.get(`${Math.floor(x)},${Math.floor(z)}`) ?? 65
  const plan = planCrystals(spikes, { groundY, from: { x: -27.5, z: -0.5 }, destroyed: [0, 1, 2, 3, 4, 5, 6, 8, 9] })
  assert.equal(plan.length, 1)
  const spot = plan[0].shootFrom
  assert.ok(spot != null)
  assert.ok(!columns.has(`${Math.floor(spot.x)},${Math.floor(spot.z)}`), `spot ${spot.x}, ${spot.z} is on a spike`)
  assert.equal(spot.y - spot.pillar, 65)
})

test('the shooting spot keeps off the ground to avoid (a breath cloud where the plan stood)', () => {
  const spikes = getSpikesForLevel(parseSeed('endfight'))
  const first = planCrystals(spikes, { from: { x: -15, z: -5 }, destroyed: [0, 1, 2, 3, 4, 5, 6, 7, 9] })[0].shootFrom
  assert.ok(first != null)
  const cloud = { x: first.x, z: first.z, r: 6 }
  const avoid = (x: number, z: number): boolean => Math.hypot(x - cloud.x, z - cloud.z) < cloud.r
  const moved = planCrystals(spikes, { from: { x: -15, z: -5 }, destroyed: [0, 1, 2, 3, 4, 5, 6, 7, 9], avoid })[0].shootFrom
  assert.ok(moved != null)
  assert.ok(!avoid(moved.x, moved.z), `spot ${moved.x}, ${moved.z} in the cloud`)
})

test('the pillar column is outside the obsidian, and outside the cage of a caged spike, whichever way the shot lies', () => {
  for (const seed of [0, parseSeed('endfight'), 12345]) {
    const spikes = getSpikesForLevel(seed)
    for (const spike of spikes) {
      const obsidian = new Set(spikeColumns(spike).map(c => `${c.x},${c.z}`))
      for (let k = 0; k < 32; k++) {
        const a = k * Math.PI / 16
        const c = pillarColumn(spike, Math.cos(a), Math.sin(a))
        assert.ok(!obsidian.has(`${c.x},${c.z}`), `spike ${spike.index} at ${a.toFixed(2)}: ${c.x}, ${c.z} in the obsidian`)
        if (spike.guarded) assert.ok(Math.max(Math.abs(c.x - spike.centerX), Math.abs(c.z - spike.centerZ)) >= 3, `spike ${spike.index} at ${a.toFixed(2)}: ${c.x}, ${c.z} in the cage`)
        // next to it: within reach of the bars
        assert.ok(Math.hypot(c.x + 0.5 - (spike.centerX + 0.5), c.z + 0.5 - (spike.centerZ + 0.5)) < spike.radius + 3.5)
      }
    }
    for (const t of planCrystals(spikes)) {
      if (t.pillar == null || !t.spike.guarded) continue
      assert.ok(Math.max(Math.abs(t.pillar.column.x - t.spike.centerX), Math.abs(t.pillar.column.z - t.spike.centerZ)) >= 3)
    }
  }
})

test('no shooting spot on a caged spike\'s cage either, where the ground a getter reads is the bars\' top (seed 2: spike 9 from on top of spike 0)', () => {
  const spikes = getSpikesForLevel(parseSeed('2'))
  const tops = new Map<string, number>()
  for (const s of spikes) {
    for (const c of spikeColumns(s)) tops.set(`${c.x},${c.z}`, s.height)
    if (s.guarded) for (const b of cageBars(s)) tops.set(`${b.x},${b.z}`, Math.max(tops.get(`${b.x},${b.z}`) ?? 0, b.y + 1))
  }
  const groundY = (x: number, z: number): number => tops.get(`${Math.floor(x)},${Math.floor(z)}`) ?? 63
  const plan = planCrystals(spikes, { groundY, from: { x: 30, z: 0 } })
  assert.equal(plan.length, 10)
  for (const t of plan) {
    const spot = t.shootFrom
    if (spot == null) continue
    assert.ok(!tops.has(`${Math.floor(spot.x)},${Math.floor(spot.z)}`), `spike ${t.spike.index} shot from ${spot.x}, ${spot.y}, ${spot.z}, on a spike or its cage`)
  }
})
