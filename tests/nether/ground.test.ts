import { test } from 'node:test'
import assert from 'node:assert'
import * as path from 'node:path'
import { Vec3 } from 'vec3'
import { groundAround, pearlGroundScore, pearlLeg } from '../../src/nether/ground'
import { netherSnapshotRig, readNetherSnapshot } from './netherSnapshot'

/** the pathfinder's flat fake world (the 26.3 registry) with patches of blocks on its floor (y 63) */
function patchedWorld (patches: Array<{ block: string, x: [number, number], z: [number, number] }>): { bot: any, stop: () => void } {
  const setup = require('@nxg-org/mineflayer-pathfinder/tests/setup')
  const { rig, world } = setup.createCacheWorld('26.3', 64, new Vec3(0.5, 64, 0.5), { renderDistance: 8 })
  for (const p of patches) {
    for (let x = p.x[0]; x <= p.x[1]; x++) for (let z = p.z[0]; z <= p.z[1]; z++) world.setBlock(new Vec3(x, 63, z), p.block)
  }
  // (the chunks' height, as a server's login gives it: findBlocks reads the sections by it)
  rig.bot.game = { ...(rig.bot.game ?? {}), minY: -64, height: 384 }
  return { bot: rig.bot, stop: () => rig.stopPassivePhysics() }
}

test('pearlLeg: of the spiral\'s next points, away from a basalt delta and toward a warped forest; the first when nothing is seen', () => {
  const { bot, stop } = patchedWorld([
    { block: 'basalt', x: [20, 60], z: [-8, 8] },
    { block: 'magma_block', x: [62, 70], z: [-4, 4] },
    { block: 'warped_nylium', x: [-8, 8], z: [50, 70] }
  ])
  try {
    const from = new Vec3(0.5, 64, 0.5)
    const east = groundAround(bot, new Vec3(32, 64, 0), 24)
    assert.ok(east.delta >= 40, JSON.stringify(east))
    assert.ok(pearlGroundScore(east, false) < 0)
    // the spiral's next is east, into the delta: south, to the warped forest, instead
    const spiral = [{ x: 96, z: 0 }, { x: 96, z: 96 }, { x: 0, z: 96 }, { x: -96, z: 96 }]
    const leg = pearlLeg(bot, from, spiral)
    assert.strictEqual(leg.index, 2)
    assert.deepStrictEqual(leg.point, { x: 0, z: 96 })
    assert.ok(leg.ground.warped > 0)
    // without the forest's: not into the delta, the next after it
    assert.strictEqual(pearlLeg(bot, from, [{ x: 96, z: 0 }, { x: 96, z: 96 }]).index, 1)
    // nothing seen: the spiral's first
    const { bot: plain, stop: stopPlain } = patchedWorld([])
    try {
      assert.strictEqual(pearlLeg(plain, from, spiral).index, 0)
    } finally {
      stopPlain()
    }
  } finally {
    stop()
  }
})

test('pearlLeg from seed 2\'s fortress bridge east of the throne (26.3): the delta\'s ways scored against', () => {
  const { rig } = netherSnapshotRig(new Vec3(70.5, 61, -548.5), readNetherSnapshot(path.join(__dirname, '..', 'fixtures', 'nether-seed2-east.json.gz')))
  rig.bot.game = { ...(rig.bot.game ?? {}), minY: -64, height: 384 }
  try {
    const counts = groundAround(rig.bot, new Vec3(90, 40, -546), 24)
    assert.ok(counts.delta >= 40, JSON.stringify(counts))
    assert.ok(pearlGroundScore(counts, true) < 0)
  } finally {
    rig.stopPassivePhysics()
  }
})

test('nearestBiomeSpot: the nearest point deep in a biome by the seed, past the spots excluded', async () => {
  const { nearestBiomeSpot } = await import('../../src/nether/ground')
  const { NetherBiomeSource } = await import('../../src/worldgen/netherBiomes')
  const biomes = new NetherBiomeSource(2)
  const spot = nearestBiomeSpot(biomes, { x: 2, z: -2 }, 'warped_forest')
  assert.deepEqual(spot && { x: spot.x, z: spot.z }, { x: -224, z: 352 })
  // its 5 x 5 grid round it all warped forest
  for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) assert.equal(biomes.biomeAt(-224 + i * 16, 352 + j * 16), 'warped_forest')
  const other = nearestBiomeSpot(biomes, { x: 2, z: -2 }, 'warped_forest', { exclude: [spot as any] })
  assert.ok(other != null && Math.hypot(other.x + 224, other.z - 352) > 64)
  assert.equal(nearestBiomeSpot(biomes, { x: 2, z: -2 }, 'warped_forest', { radius: 200 }), null)
})
