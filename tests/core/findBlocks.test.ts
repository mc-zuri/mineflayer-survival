import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { findBlock, findBlocks } from '../../src/core/findBlocks'
import { netherSnapshotRig } from '../nether/netherSnapshot'

test('findBlocks: the nearest blocks of the ids within reach, as a look at every cell finds them, read by state id (the snapshot of a basalt delta)', () => {
  const { rig, world } = netherSnapshotRig(new Vec3(360.5, 70, 20.5))
  try {
    const bot = rig.bot
    bot.game = { ...(bot.game ?? {}), minY: -64, height: 384 }
    let blockAts = 0
    const blockAt = bot.blockAt.bind(bot)
    bot.blockAt = (p: Vec3) => { blockAts++; return blockAt(p) }
    const reg = bot.registry
    const id = (n: string): number => reg.blocksByName[n].id
    // every cell within reach: the reference
    const brute = (ids: number[], point: Vec3, maxDistance: number): Array<{ p: Vec3, d: number }> => {
      const out: Array<{ p: Vec3, d: number }> = []
      const r = Math.ceil(maxDistance)
      for (let x = point.x - r; x <= point.x + r; x++) {
        for (let y = point.y - r; y <= point.y + r; y++) {
          for (let z = point.z - r; z <= point.z + r; z++) {
            const p = new Vec3(x, y, z)
            const d = p.distanceTo(point)
            if (d > maxDistance) continue
            const b = reg.blocksByStateId[world.getBlockStateId(p)]
            if (b != null && ids.includes(b.id)) out.push({ p, d })
          }
        }
      }
      return out.sort((a, b) => a.d - b.d)
    }
    const cases: Array<{ names: string[], point: Vec3, maxDistance: number, count: number }> = [
      { names: ['lava'], point: new Vec3(360, 70, 20), maxDistance: 16, count: 64 },
      { names: ['magma_block'], point: new Vec3(330, 60, 0), maxDistance: 24, count: 4096 },
      { names: ['nether_gold_ore', 'gilded_blackstone'], point: new Vec3(400, 60, 40), maxDistance: 40, count: 1 },
      { names: ['polished_blackstone_bricks'], point: new Vec3(300, 70, 100), maxDistance: 32, count: 16 },
      { names: ['soul_sand'], point: new Vec3(385, 40, 45), maxDistance: 20, count: 8 }
    ]
    for (const c of cases) {
      const ids = c.names.map(id)
      const want = brute(ids, c.point, c.maxDistance).slice(0, c.count)
      const got = findBlocks(bot, { matching: ids, point: c.point, maxDistance: c.maxDistance, count: c.count })
      assert.ok(want.length > 0, `none of ${c.names.join(', ')} near ${c.point.toString()}`)
      assert.deepStrictEqual(got.map(p => p.distanceTo(c.point)), want.map(w => w.d), c.names.join(', '))
      for (const p of got) assert.ok(ids.includes(reg.blocksByStateId[world.getBlockStateId(p)].id))
    }
    assert.strictEqual(blockAts, 0, 'findBlocks made a Block')
    assert.deepStrictEqual(findBlocks(bot, { matching: id('lava'), point: new Vec3(5000, 64, 5000), maxDistance: 16, count: 4 }), [])
    assert.strictEqual(findBlock(bot, { matching: id('soul_sand'), point: new Vec3(385, 40, 45), maxDistance: 20 })?.name, 'soul_sand')
  } finally {
    rig.stopPassivePhysics()
  }
})
