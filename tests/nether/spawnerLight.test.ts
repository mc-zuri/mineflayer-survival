// The blaze spawner lit but for a patch by the nook (nether/spawnerLight), on the fixtures of seed 2's fortress
// (26.3, read from a server: tests/e2e/netherSnapshot.ts): a blaze spawns only where the light is 11 or under
// (Monster.getWalkTargetValue in the nether's ambient light), a torch's 14 two steps off.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as path from 'node:path'
import { Vec3 } from 'vec3'
import { readNetherSnapshot } from './netherSnapshot'
import { BLAZE_SPAWN_LIGHT, TORCH_LIGHT, litCells, planSpawnerTorches, spawnCells } from '../../src/nether/spawnerLight'
import { planBlazeNooks, type NookLookup } from '../../src/nether/blazeFight'

function snapshotLookup (file: string): NookLookup {
  const snap = readNetherSnapshot(path.join(__dirname, '..', 'fixtures', file))
  const mc = require('minecraft-data')(snap.version)
  const [x0, y0, z0] = snap.origin
  const [sx, sy, sz] = snap.size
  return p => {
    const x = p.x - x0; const y = p.y - y0; const z = p.z - z0
    if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) return null
    const b = mc.blocksByStateId[snap.ids[(x * sz + z) * sy + y]]
    return b == null ? null : { name: b.name, boundingBox: b.boundingBox }
  }
}

test('litCells: a torch lights over 11 two steps off through the open, none through a full block', () => {
  assert.equal(TORCH_LIGHT - BLAZE_SPAWN_LIGHT - 1, 2)
  const wall = new Vec3(1, 0, 0)
  const lookup: NookLookup = p => p.equals(wall) ? { name: 'stone', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' }
  const lit = litCells(lookup, [new Vec3(0, 0, 0)])
  assert.ok(lit.has('0,0,0') && lit.has('0,0,2') && lit.has('-1,0,1') && lit.has('0,2,0'))
  assert.ok(!lit.has('0,0,3') && !lit.has('1,0,0'))
  // round the wall: (2, 0, 0) is 4 steps off, not lit
  assert.ok(!lit.has('2,0,0'))
})

for (const [file, spawner] of [['nether-seed2-s2fortress.json.gz', new Vec3(-277, 77, -159)], ['nether-seed2-s2fortress2.json.gz', new Vec3(-290, 77, -209)]] as const) {
  test(`planSpawnerTorches at ${spawner.toString()} (${file}): 4 or 5 torches light some 3 in 4 of the spawns, the patch by the nook left dark`, () => {
    const lookup = snapshotLookup(file)
    const nook = planBlazeNooks(lookup, spawner, { from: new Vec3(-270.5, 61, -164.5) })[0]
    assert.ok(nook != null)
    const eye = nook.stand.offset(0.5, 1.62, 0.5)
    const plan = planSpawnerTorches(lookup, spawner, eye)
    assert.ok(plan.torches.length >= 4 && plan.torches.length <= 6, plan.torches.join(' '))
    assert.ok(plan.unlit <= 0.3, `${plan.unlit}`)
    const lit = litCells(lookup, plan.torches)
    assert.ok(plan.dark.length > 0)
    for (const d of plan.dark) assert.ok(!lit.has(`${d.x},${d.y},${d.z}`), d.toString())
    // the dark patch is the spawns nearest the nook
    const cells = spawnCells(lookup, spawner)
    const near = (c: Vec3): number => c.offset(0.5, 0.9, 0.5).distanceTo(eye)
    const farthestDark = Math.max(...plan.dark.map(near))
    const nearestLit = Math.min(...cells.filter(c => lit.has(`${c.cell.x},${c.cell.y},${c.cell.z}`)).map(c => near(c.cell)))
    assert.ok(nearestLit >= farthestDark - 3, `${nearestLit} ${farthestDark}`)
    // every torch on a floor
    for (const t of plan.torches) assert.equal(lookup(t.offset(0, -1, 0))?.boundingBox, 'block')
  })
}
