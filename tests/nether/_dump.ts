import * as path from 'node:path'
import { readNetherSnapshot } from './netherSnapshot'
const snap = readNetherSnapshot(path.join(__dirname, '..', 'fixtures', process.argv[2]))
const mcData = require('minecraft-data')(snap.version)
const [x0, y0, z0] = snap.origin; const [sx, sy, sz] = snap.size
const at = (x: number, y: number, z: number): string => { const id = snap.ids[((x - x0) * sz + (z - z0)) * sy + (y - y0)]; return mcData.blocksByStateId[id]?.name ?? '?' }
const [cx, cy, cz, r] = process.argv.slice(3).map(Number)
const abbrev: Record<string, string> = { air: '.', cave_air: '.', magma_block: 'M', lava: 'L', basalt: 'b', blackstone: 'k', netherrack: 'n', nether_bricks: 'B', soul_sand: 's', polished_basalt: 'p', nether_brick_fence: 'f', spawner: 'S', soul_soil: 'o', gravel: 'g', nether_brick_stairs: 'z', fire: 'F' }
const seen = new Set<string>()
console.log('origin', snap.origin, 'size', snap.size)
for (let y = cy + 2; y >= cy - 3; y--) {
  console.log('y', y, '   x from', cx - r, 'to', cx + r, '(rows z)')
  for (let z = cz - r; z <= cz + r; z++) {
    let row = ''
    for (let x = cx - r; x <= cx + r; x++) { const n = at(x, y, z); seen.add(n); row += abbrev[n] ?? '#' }
    console.log(String(z).padStart(5), row)
  }
}
console.log([...seen].join(' '))
