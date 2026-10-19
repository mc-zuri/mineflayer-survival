import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { FORBID, lavaBeside, netherMoveSettings } from '../../src/nether/safety'
import { netherSnapshotRig } from './netherSnapshot'

test('netherMoveSettings: the step rule reads each cell of the world once (kept by section), its answers those of a read of every cell (the snapshot of a basalt delta)', () => {
  const { rig, world } = netherSnapshotRig(new Vec3(360.5, 70, 20.5))
  try {
    const bot = rig.bot
    const reg = bot.registry
    const nameAt = (p: Vec3): string => reg.blocksByStateId[world.getBlockStateId(p)]?.name ?? 'air'
    // every read of a cell the rules make, through the world's columns or its getBlockStateId
    const reads = new Map<string, number>()
    const count = (x: number, y: number, z: number): void => { const k = `${x},${y},${z}`; reads.set(k, (reads.get(k) ?? 0) + 1) }
    const getColumnAt = world.getColumnAt.bind(world)
    const getBlockStateId = world.getBlockStateId.bind(world)
    bot.world = Object.create(world)
    bot.world.getBlockStateId = (p: Vec3) => { count(p.x, p.y, p.z); return getBlockStateId(p) }
    bot.world.getColumnAt = (p: Vec3) => {
      const column = getColumnAt(p)
      if (column == null) return column
      const cx = Math.floor(p.x / 16) * 16
      const cz = Math.floor(p.z / 16) * 16
      return { getBlockStateId: (local: Vec3) => { count(cx + local.x, local.y, cz + local.z); return column.getBlockStateId(local) } }
    }
    const step = netherMoveSettings(bot, { avoidDeaths: false }).exclusionAreasStep?.[0] as any
    const isLava = (p: Vec3): boolean => nameAt(p) === 'lava'
    let forbidden = 0
    let near = 0
    for (let x = 340; x < 380; x++) {
      for (let z = 0; z < 40; z++) {
        for (let y = 60; y < 80; y++) {
          const p = new Vec3(x, y, z)
          const want = isLava(p) || isLava(p.offset(0, 1, 0)) || isLava(p.offset(0, -1, 0)) || lavaBeside(isLava, p, 1) || nameAt(p.offset(0, -1, 0)) === 'magma_block'
            ? FORBID
            : lavaBeside(isLava, p, 2) ? 40 : 0
          assert.strictEqual(step({ position: p, type: 0 }), want, p.toString())
          if (want === FORBID) forbidden++
          if (want === 40) near++
        }
      }
    }
    assert.ok(forbidden > 1000 && near > 500, `${forbidden} forbidden, ${near} near lava`)
    const twice = [...reads].filter(([, n]) => n > 1)
    assert.deepStrictEqual(twice.slice(0, 5), [], `${twice.length} cells read more than once`)
  } finally {
    rig.stopPassivePhysics()
  }
})
