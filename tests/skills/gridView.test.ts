import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { botGridView, gridBlockLookup, gridPath, HARMFUL, type GridCellView } from '../../src/skills/gridWalk'
import { netherSnapshotRig } from '../nether/netherSnapshot'

test('botGridView: reads the world by state id, cell by cell as bot.blockAt does, without a Block for each (the snapshot of a basalt delta)', () => {
  const { rig } = netherSnapshotRig(new Vec3(480.5, 53, 20.5))
  try {
    check(rig.bot)
  } finally {
    rig.stopPassivePhysics()
  }
})

function check (bot: any): void {
  bot.game = { ...(bot.game ?? {}), dimension: 'the_nether' }
  const blockAt = bot.blockAt.bind(bot)
  const byBlockAt: GridCellView = {
    free: p => { const b = blockAt(p); return b != null && b.boundingBox === 'empty' && !HARMFUL.has(b.name) },
    floor: p => { const b = blockAt(p); return b != null && b.boundingBox === 'block' && b.name !== 'magma_block' },
    lava: p => blockAt(p)?.name === 'lava',
    edgeCost: 3
  }
  let calls = 0
  bot.blockAt = (p: Vec3) => { calls++; return blockAt(p) }
  const view = botGridView(bot)
  const lookup = gridBlockLookup(bot)
  // every cell of a stretch of the delta, and one the world has no column for (as blockAt: no block)
  for (let x = 330; x < 350; x++) {
    for (let z = 0; z < 20; z++) {
      for (let y = 40; y < 90; y++) {
        const p = new Vec3(x, y, z)
        assert.strictEqual(view.free(p), byBlockAt.free(p), `free ${p.toString()}`)
        assert.strictEqual(view.floor(p), byBlockAt.floor(p), `floor ${p.toString()}`)
        assert.strictEqual(view.lava?.(p), byBlockAt.lava?.(p), `lava ${p.toString()}`)
      }
    }
  }
  assert.strictEqual(lookup(new Vec3(5000, 64, 5000)), null)
  assert.strictEqual(view.free(new Vec3(5000, 64, 5000)), false)
  const goal = new Vec3(330, 80, 60)
  const dist = (c: Vec3): number => Math.hypot(c.x - goal.x, c.z - goal.z)
  const path = gridPath(view, new Vec3(480, 53, 20), c => dist(c) <= 6, dist, 20000)
  assert.deepStrictEqual(path?.map(String), gridPath(byBlockAt, new Vec3(480, 53, 20), c => dist(c) <= 6, dist, 20000)?.map(String))
  assert.ok(path != null && path.length > 100, `a path of ${path?.length} cells`)
  // (the view's own lookups made none: the calls counted are byBlockAt's)
  const viewOnly = botGridView(bot)
  const counted = calls
  gridPath(viewOnly, new Vec3(480, 53, 20), c => dist(c) <= 6, dist, 20000)
  assert.strictEqual(calls, counted, 'botGridView called bot.blockAt')
}
