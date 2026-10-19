// The pathfinder's search with the nether settings on the snapshot of seed 2's basalt delta (netherSnapshot): its nodes
// per second of computing, against the same search without them.
//   node -r ts-node/register/transpile-only tests/nether/searchBench.ts [fromX fromZ toX toZ] [--plain] [--budget ms]
import { Vec3 } from 'vec3'
import { netherSnapshotRig } from './netherSnapshot'
import { netherMoveSettings } from '../../src/nether/safety'

/** the pathfinder's working tree (its src), as the snapshot's rig is */
const pf = require('@nxg-org/mineflayer-pathfinder/src')

/** the cell nearest (x, z), within 12 sideways, where the bot can stand: two free cells over a solid one */
function standable (bot: any, x0: number, z0: number): Vec3 | null {
  const name = (x: number, y: number, z: number): string => bot.registry.blocksByStateId[bot.world.getBlockStateId(new Vec3(x, y, z))]?.name ?? 'air'
  const solid = (n: string): boolean => !['air', 'cave_air', 'void_air', 'lava', 'fire', 'magma_block'].includes(n)
  for (let r = 0; r <= 12; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
        for (let y = 95; y >= 40; y--) if (name(x0 + dx, y, z0 + dz) === 'air' && name(x0 + dx, y + 1, z0 + dz) === 'air' && solid(name(x0 + dx, y - 1, z0 + dz))) return new Vec3(x0 + dx, y, z0 + dz)
      }
    }
  }
  return null
}

export async function benchNetherSearch (from: [number, number], to: [number, number], opts: { plain?: boolean, budgetMs?: number } = {}): Promise<{ status: string, nodes: number, computeMs: number, nodesPerSecond: number }> {
  const { rig } = netherSnapshotRig(new Vec3(from[0] + 0.5, 64, from[1] + 0.5))
  try {
    const start = standable(rig.bot, from[0], from[1])
    const goal = standable(rig.bot, to[0], to[1])
    if (start == null || goal == null) throw new Error('no ground to stand on at the start or the goal')
    rig.bot.entity.position = start.offset(0.5, 0, 0.5)
    rig.bot.loadPlugin(pf.createPlugin({ pathfinderSettings: { partialPathProducer: false, partialPathLength: 50, searchTimeoutMs: opts.budgetMs ?? 8000 } }))
    if (opts.plain !== true) rig.bot.pathfinder.setMoveOptions({ ...rig.bot.pathfinder.defaultMoveSettings, ...netherMoveSettings(rig.bot, { avoidDeaths: false }) })
    let final: any
    for await (const res of rig.bot.pathfinder.getPathTo(new pf.goals.GoalNear(goal.x, goal.y, goal.z, 2))) final = res
    const ctx = final.astarContext
    return { status: final.result.status, nodes: ctx.closedDataSet.size, computeMs: ctx.computeTime, nodesPerSecond: ctx.closedDataSet.size / ctx.computeTime * 1000 }
  } finally {
    rig.stopPassivePhysics()
  }
}

if (require.main === module) {
  const args = process.argv.slice(2)
  const plain = args.includes('--plain')
  const b = args.indexOf('--budget')
  const budgetMs = b >= 0 ? Number(args[b + 1]) : undefined
  const nums = args.filter((a, i) => !a.startsWith('--') && (b < 0 || i !== b + 1)).map(Number)
  const [fx, fz, tx, tz] = nums.length === 4 ? nums : [320, 20, 400, 20]
  benchNetherSearch([fx, fz], [tx, tz], { plain, budgetMs }).then(r => {
    console.log(`${plain ? 'plain' : 'nether settings'}: ${r.status}, ${r.nodes} nodes in ${r.computeMs.toFixed(0)} ms of computing, ${r.nodesPerSecond.toFixed(0)} nodes/s`)
    process.exit(0)
  }, err => { console.error(err); process.exit(1) })
}
