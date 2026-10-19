import * as path from 'node:path'
import { Vec3 } from 'vec3'
import { netherSnapshotRig, readNetherSnapshot } from './netherSnapshot'
import { botGridView, gridPath } from '../../src/skills/gridWalk'
const snap = readNetherSnapshot(path.join(__dirname, '..', 'fixtures', 'nether-seed2-east.json.gz'))
const [sx, sy, sz, tx, ty, tz, r] = process.argv.slice(2).map(Number)
const { rig } = netherSnapshotRig(new Vec3(sx + 0.5, sy, sz + 0.5), snap)
const bot = rig.bot
bot.game.dimension = 'the_nether'
const view = botGridView(bot)
const t = new Vec3(tx, ty, tz)
const dist = (c: Vec3): number => Math.hypot(c.x - t.x, c.z - t.z)
const p = (gridPath as any)(view, new Vec3(sx, sy, sz), (c: Vec3) => dist(c) <= r, dist)
console.log(p == null ? 'none' : p.map((c: Vec3) => `${c.x},${c.y},${c.z}`).join(' '))
rig.stopPassivePhysics(); process.exit(0)
