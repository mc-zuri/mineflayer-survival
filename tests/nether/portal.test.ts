import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Pos } from '../../src/core/memory'
import { checkPortalFrame, findLavaSources, isSolid, planLavaCast, portalFrame, type BlockInfo, type LavaCastPlan } from '../../src/nether/portal'

const k = (p: Pos): string => `${p.x},${p.y},${p.z}`

/** flat stone at y 63 with a 4×4 lava pool let into it, air above */
function world (): Map<string, BlockInfo> {
  const w = new Map<string, BlockInfo>()
  for (let x = -24; x <= 24; x++) {
    for (let z = -24; z <= 24; z++) {
      for (let y = 58; y <= 63; y++) w.set(k({ x, y, z }), { name: 'stone' })
    }
  }
  for (let x = 8; x <= 11; x++) for (let z = -2; z <= 1; z++) w.set(k({ x, y: 63, z }), { name: 'lava', properties: { level: 0 } })
  w.set(k({ x: 12, y: 63, z: 1 }), { name: 'lava', properties: { level: 3 } }) // a flowing one: not a source
  return w
}

function getter (w: Map<string, BlockInfo>): (p: Pos) => BlockInfo | null {
  return p => w.get(k(p)) ?? (p.y > 63 && p.y < 120 && Math.abs(p.x) <= 24 && Math.abs(p.z) <= 24 ? { name: 'air' } : null)
}

const SIDES: Pos[] = [{ x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 }]

/**
 * Runs a cast plan on the world: buckets, placement rules, and LiquidBlock.shouldSpreadLiquid
 * (a lava source with water above or beside it becomes obsidian when the water arrives).
 */
function run (plan: LavaCastPlan, w: Map<string, BlockInfo>): void {
  const get = getter(w)
  let carried = 0
  let lastLava: Pos | null = null
  const add = (a: Pos, b: Pos): Pos => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z })
  for (const step of plan.steps) {
    switch (step.kind) {
      case 'place_block':
        assert.deepEqual(add(step.against, step.face), step.pos)
        assert.ok(isSolid(get(step.against)), `nothing to place ${k(step.pos)} against`)
        assert.equal(get(step.pos)?.name, 'air')
        w.set(k(step.pos), { name: step.item })
        break
      case 'fill_lava':
        assert.equal(get(step.pos)?.name, 'lava')
        assert.equal(get(step.pos)?.properties?.level, 0)
        w.set(k(step.pos), { name: 'air' })
        carried++
        assert.ok(carried <= plan.lavaBuckets)
        break
      case 'place_lava':
        assert.ok(carried > 0, 'no lava to pour')
        assert.deepEqual(add(step.against, step.face), step.pos)
        assert.ok(isSolid(get(step.against)))
        assert.equal(get(step.pos)?.name, 'air')
        w.set(k(step.pos), { name: 'lava', properties: { level: 0 } })
        carried--
        lastLava = step.pos
        break
      case 'place_water': {
        assert.deepEqual(add(step.against, step.face), step.pos)
        assert.ok(isSolid(get(step.against)))
        assert.equal(get(step.pos)?.name, 'air')
        assert.ok(step.within <= 30)
        w.set(k(step.pos), { name: 'water' })
        // neighborChanged on the lava around it: water above or beside a source makes obsidian
        for (const s of SIDES) {
          const lava = { x: step.pos.x - s.x, y: step.pos.y - s.y, z: step.pos.z - s.z }
          if (get(lava)?.name === 'lava') w.set(k(lava), { name: get(lava)?.properties?.level === 0 ? 'obsidian' : 'cobblestone' })
        }
        assert.equal(get(step.makes)?.name, 'obsidian')
        assert.deepEqual(step.makes, lastLava)
        break
      }
      case 'pickup_water':
        assert.equal(get(step.pos)?.name, 'water')
        w.set(k(step.pos), { name: 'air' })
        break
      case 'wait':
        break
      case 'light':
        assert.equal(get(step.against)?.name, 'obsidian')
        assert.equal(get(step.fire)?.name, 'air')
        w.set(k(step.fire), { name: 'fire' })
        break
    }
  }
}

test('the frame blueprint: 4 × 5, 10 obsidian, no corners, a 2 × 3 inside', () => {
  const f = portalFrame({ x: 0, y: 64, z: 0 }, 'x')
  assert.equal(f.obsidian.length, 10)
  assert.equal(f.interior.length, 6)
  assert.equal(f.corners.length, 4)
  const cells = new Set(f.obsidian.map(k))
  for (const c of f.corners) assert.ok(!cells.has(k(c)))
  assert.deepEqual(f.light, { against: { x: 1, y: 64, z: 0 }, face: { x: 0, y: 1, z: 0 }, fire: { x: 1, y: 65, z: 0 } })
  const zf = portalFrame({ x: 5, y: 70, z: 5 }, 'z', 6, 7)
  assert.equal(zf.obsidian.length, 2 * 4 + 2 * 5)
  assert.ok(zf.obsidian.every(p => p.x === 5))
  assert.throws(() => portalFrame({ x: 0, y: 0, z: 0 }, 'x', 3, 5))
})

test('the lava cast plan builds a frame PortalShape accepts, with no diamond pickaxe', () => {
  const w = world()
  const get = getter(w)
  const lava = findLavaSources(get, { x: 9, y: 63, z: 0 }, 6)
  assert.equal(lava.length, 16)
  const plan = planLavaCast(get, lava)
  assert.ok(plan != null)
  assert.equal(plan.sources.length, 10)
  assert.equal(new Set(plan.sources.map(k)).size, 10)
  // the mould is the 4 × 6 wall behind the frame, on flat ground
  assert.equal(plan.scaffold.length, 24)
  // the frame keeps out of the reach of its water from the pool
  for (const p of plan.frame.obsidian.filter(o => o.y === Math.min(...plan.frame.obsidian.map(b => b.y)))) assert.ok(lava.every(l => Math.abs(l.x - p.x) >= 9 || Math.abs(l.z - p.z) >= 9))
  run(plan, w)
  const check = checkPortalFrame(get, plan.frame)
  assert.deepEqual(check, { valid: true, missing: [], blocked: [] })
  assert.equal(get(plan.frame.light.fire)?.name, 'fire')
  // nothing left to flow: no lava or water around the frame
  for (const p of [...plan.frame.obsidian, ...plan.frame.interior]) {
    for (const s of SIDES) assert.ok(!['lava', 'water'].includes(get({ x: p.x + s.x, y: p.y + s.y, z: p.z + s.z })?.name ?? ''))
  }
})

test('with three lava buckets the trips carry three at a time', () => {
  const w = world()
  const get = getter(w)
  const plan = planLavaCast(get, findLavaSources(get, { x: 9, y: 63, z: 0 }, 6), { lavaBuckets: 3 })
  assert.ok(plan != null)
  const kinds = plan.steps.map(s => s.kind).filter(s => s === 'fill_lava' || s === 'place_lava').join(' ')
  assert.ok(kinds.startsWith('fill_lava fill_lava fill_lava place_lava place_lava place_lava fill_lava'))
  run(plan, w)
  assert.equal(checkPortalFrame(get, plan.frame).valid, true)
})

test('a hillside behind the frame saves the mould blocks; too little lava gives no plan', () => {
  const w = world()
  // a stone wall along z = -6 from x -10 to 0, 8 high
  for (let x = -10; x <= 0; x++) for (let y = 64; y <= 71; y++) w.set(k({ x, y, z: -6 }), { name: 'stone' })
  const get = getter(w)
  const plan = planLavaCast(get, findLavaSources(get, { x: 9, y: 63, z: 0 }, 6), { origin: { x: -5, y: 64, z: -5 }, axis: 'x' })
  assert.ok(plan != null)
  assert.equal(plan.scaffold.length, 0)
  run(plan, w)
  assert.equal(checkPortalFrame(get, plan.frame).valid, true)
  assert.equal(planLavaCast(get, findLavaSources(get, { x: 9, y: 63, z: 0 }, 6).slice(0, 9)), null)
})

test('lavaPools: lava sources within 2 blocks of each other are a pool, the ones of 10 or more nearest first', async () => {
  const { lavaPools } = await import('../../src/nether/portal')
  const lake = (x0: number, y: number, n: number) => Array.from({ length: n }, (_, i) => ({ x: x0 + (i % 4), y, z: Math.floor(i / 4) }))
  const pools = lavaPools([...lake(100, -54, 12), ...lake(20, -40, 16), ...lake(0, 10, 3)], { x: 0, y: 64, z: 0 })
  assert.equal(pools.length, 2)
  assert.equal(pools[0].sources.length, 16)
  assert.ok(Math.abs(pools[0].center.x - 21.5) < 0.01)
  assert.equal(pools[1].sources.length, 12)
  assert.deepEqual(lavaPools(lake(0, 10, 9), { x: 0, y: 0, z: 0 }), [])
})

test('a cast on the surface from a cave lake\'s lava far below: a site about the bot, the lava fetched 5 buckets a trip', async () => {
  const { chooseFrameSite, planLavaCast } = await import('../../src/nether/portal')
  // flat grass at y 63 with air over it; a lake of 12 lava sources at y 47 under the ground
  const lake = new Set<string>()
  for (let x = -30; x < -26; x++) for (let z = -42; z < -39; z++) lake.add(`${x},47,${z}`)
  const world = (p: any) => {
    if (lake.has(`${p.x},${p.y},${p.z}`)) return { name: 'lava', properties: { level: 0 } }
    return { name: p.y <= 63 ? (p.y === 63 ? 'grass_block' : 'stone') : 'air' }
  }
  const lava = [...lake].map(k => { const [x, y, z] = k.split(',').map(Number); return { x, y, z } })
  const site = chooseFrameSite(world, [{ x: -36, y: 63, z: 7 }], { lavaClearance: 0, siteRadius: 12 })
  assert.ok(site != null)
  const plan = planLavaCast(world, lava, { origin: site.origin, axis: site.axis, lavaBuckets: 5 })
  assert.ok(plan != null)
  assert.equal(plan.lavaBuckets, 5)
  assert.equal(plan.steps.filter(st => st.kind === 'fill_lava').length, 10)
})
