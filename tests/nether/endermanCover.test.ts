import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { ENDERMAN_HOLDABLE, coverAt, coverIntact, planEndermanCover } from '../../src/nether/endermanCover'
import type { BlockLookup } from '../../src/skills/placement'

const block = (name: string): { name: string, boundingBox: string } => ({ name, boundingBox: /^(air|warped_roots|twisting_vines|lava|water)$/.test(name) ? 'empty' : 'block' })

/** a warped forest's flat floor: warped nylium at y 63 over netherrack, the feet at 64; `extra` overrides cells */
function forest (extra: (p: Vec3) => string | null = () => null): BlockLookup {
  return p => {
    const e = extra(p)
    if (e != null) return block(e)
    if (p.y > 63) return block('air')
    return block(p.y === 63 ? 'warped_nylium' : 'netherrack')
  }
}

/** the lookup with the cover's cells dug */
function dug (lookup: BlockLookup, cells: Vec3[]): BlockLookup {
  const open = new Set(cells.map(c => c.toString()))
  return p => open.has(p.toString()) ? block('air') : lookup(p)
}

test('coverAt: the ceiling over the tunnel no enderman takes: 3 deep its ceiling is the nylium (EndermanTakeBlockGoal), 4 deep the netherrack', () => {
  assert.ok(ENDERMAN_HOLDABLE.test('warped_nylium') && ENDERMAN_HOLDABLE.test('grass_block') && !ENDERMAN_HOLDABLE.test('netherrack'))
  const lookup = forest()
  const top = new Vec3(0, 64, 0)
  const east = new Vec3(1, 0, 0)
  assert.equal(coverAt(lookup, top, east, 3), null)
  const cover = coverAt(lookup, top, east, 4)
  assert.ok(cover != null)
  assert.deepEqual(cover.steps.map(s => s.toString()), ['(1, 63, 0)', '(2, 62, 0)', '(3, 61, 0)'])
  assert.equal(cover.pit.toString(), '(4, 60, 0)')
  assert.equal(cover.front.toString(), '(5, 60, 0)')
  assert.equal(cover.stand.toString(), '(6, 60, 0)')
  // each step open from its floor to the surface (an enderman comes down it), the tunnel two high: 1+2+3+4 and 2+2
  assert.equal(cover.dig.length, 14)
  assert.ok(cover.dig.every(p => p.y < 64))
  assert.ok(!cover.dig.some(p => p.equals(new Vec3(5, 62, 0)) || p.equals(new Vec3(6, 62, 0))), 'the ceiling is kept')
  // dug, it holds; with the ceiling over the bot's cell or a wall beside it gone, not
  const after = dug(lookup, cover.dig)
  assert.equal(coverIntact(after, cover), true)
  assert.equal(coverIntact(dug(after, [new Vec3(6, 62, 0)]), cover), false)
  assert.equal(coverIntact(dug(after, [new Vec3(6, 61, 1)]), cover), false)
  assert.equal(coverIntact(dug(after, [new Vec3(5, 61, 1)]), cover), false, 'a wall by the front, where an enderman would reach the bot from')
})

test('coverAt: no cover with lava beside a cell to dig, a cave under the bot\'s cell or beside it, gravel for its ceiling, or bedrock on the stair', () => {
  const top = new Vec3(0, 64, 0)
  const east = new Vec3(1, 0, 0)
  assert.ok(coverAt(forest(), top, east, 4) != null)
  const at = (cells: Record<string, string>): BlockLookup => forest(p => cells[p.toString()] ?? null)
  assert.equal(coverAt(at({ '(6, 60, 1)': 'lava' }), top, east, 4), null, 'lava beside the stand')
  assert.equal(coverAt(at({ '(3, 60, 0)': 'lava' }), top, east, 4), null, 'lava under a step')
  assert.equal(coverAt(at({ '(6, 59, 0)': 'air' }), top, east, 4), null, 'no floor')
  assert.equal(coverAt(at({ '(7, 60, 1)': 'air', '(7, 61, 1)': 'air' }), top, east, 4), null, 'a cave beside it')
  assert.equal(coverAt(at({ '(6, 62, 0)': 'gravel' }), top, east, 4), null, 'a ceiling that falls')
  // a hollow 3 deep behind the top: a knock off it is a fall; 2 deep, none
  assert.equal(coverAt(at({ '(-1, 63, 1)': 'air', '(-1, 62, 1)': 'air', '(-1, 61, 1)': 'air' }), top, east, 4), null, 'a drop by the top')
  assert.ok(coverAt(at({ '(-1, 63, 1)': 'air', '(-1, 62, 1)': 'air' }), top, east, 4) != null)
  // a stem on the stair: cut through; what the bot can't break there: no cover
  assert.ok(coverAt(at({ '(2, 64, 0)': 'warped_stem' }), top, east, 4)?.dig.some(p => p.equals(new Vec3(2, 64, 0))))
  assert.equal(coverAt(at({ '(2, 64, 0)': 'bedrock' }), top, east, 4), null, 'bedrock on the stair')
  // roots in the way are no matter: dug through like air; twisting vines are broken (the bot climbs them, and stood on
  // them over a step's floor)
  assert.ok(coverAt(at({ '(2, 64, 0)': 'warped_roots' }), top, east, 4) != null)
  const vines = coverAt(forest(p => p.toString() === '(1, 63, 0)' ? 'twisting_vines' : null), top, east, 4)
  assert.ok(vines?.dig.some(p => p.equals(new Vec3(1, 63, 0))))
})

test('planEndermanCover: the nearest cover, on flat ground round the bot', () => {
  const lookup = forest()
  const cover = planEndermanCover(lookup, new Vec3(0.5, 64, 0.5))
  assert.ok(cover != null)
  assert.ok(Math.hypot(cover.top.x, cover.top.z) <= 1)
  assert.equal(cover.stand.y, 60)
  // over the lava sea: none
  const sea: BlockLookup = p => block(p.y < 32 ? 'lava' : 'air')
  assert.equal(planEndermanCover(sea, new Vec3(0.5, 40, 0.5)), null)
})

test('scanSpot: with no enderman in sight from the cover\'s top, the nearest cell near it whose eyes see one, off the cover\'s line', async () => {
  const { scanSpot, SCAN_RADIUS } = await import('../../src/nether/endermanCover')
  const lookup = forest()
  const cover = coverAt(lookup, new Vec3(0, 64, 0), new Vec3(1, 0, 0), 4)
  assert.ok(cover != null)
  // an enderman 20 north; a stem wall west of x 3 hides it from the eyes there
  const enderman = new Vec3(0.5, 64, -20.5)
  const raycast = (from: Vec3): unknown => from.x < 3 ? { position: new Vec3(0, 65, -3) } : null
  const spot = scanSpot(lookup, cover, [enderman], raycast)
  assert.ok(spot != null)
  assert.ok(spot.x >= 3 && spot.y === 64, spot.toString())
  assert.ok(Math.hypot(spot.x, spot.z) <= SCAN_RADIUS)
  assert.ok(spot.z !== 0, 'off the cover\'s line')
  assert.equal(scanSpot(lookup, cover, [enderman], () => ({})), null, 'none seen from anywhere')
  assert.equal(scanSpot(lookup, cover, [], () => null), null)
})

test('coverView: the clear sight lines from a top, fewer with a wall by it; planEndermanCovers leaves out the tops excluded (one no enderman was seen from)', async () => {
  const { coverView, planEndermanCovers } = await import('../../src/nether/endermanCover')
  const top = new Vec3(0, 64, 0)
  const open = coverView(top, () => null)
  assert.equal(open, 32)
  // a wall 2 off on the -x side: those lines end there
  const walled = coverView(top, (from: Vec3, dir: Vec3) => dir.x < -0.3 ? { intersect: from.plus(dir.scaled(2)) } : null)
  assert.ok(walled < open && walled > 15, String(walled))
  const lookup = forest()
  const all = planEndermanCovers(lookup, new Vec3(0.5, 64, 0.5), {}, undefined, 5)
  assert.equal(all.length, 5)
  assert.equal(new Set(all.map(c => c.top.toString())).size, 5, 'no top twice')
  const away = planEndermanCovers(lookup, new Vec3(0.5, 64, 0.5), { exclude: t => t.distanceTo(new Vec3(0, 64, 0)) < 10 }, undefined, 5)
  assert.ok(away.length > 0 && away.every(c => c.top.distanceTo(new Vec3(0, 64, 0)) >= 10))
})
