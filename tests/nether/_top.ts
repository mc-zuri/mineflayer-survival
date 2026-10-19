import * as path from 'node:path'
import { readNetherSnapshot } from './netherSnapshot'
const snap = readNetherSnapshot(path.join(__dirname, '..', 'fixtures', process.argv[2]))
const mcData = require('minecraft-data')(snap.version)
const [x0, y0, z0] = snap.origin; const [sx, sy, sz] = snap.size
const at = (x: number, y: number, z: number): string => { const id = snap.ids[((x - x0) * sz + (z - z0)) * sy + (y - y0)]; return mcData.blocksByStateId[id]?.name ?? '?' }
const [xa, xb, za, zb, ymax] = process.argv.slice(3).map(Number)
console.log('stands (feet y of the highest stand below ymax), M = on magma')
let hdr = '      '; for (let x = xa; x <= xb; x++) hdr += String(x).slice(-2).padStart(3); console.log(hdr)
for (let z = za; z <= zb; z++) {
  let row = String(z).padStart(5) + ' '
  for (let x = xa; x <= xb; x++) {
    let s = '  -'
    for (let y = ymax; y > y0; y--) {
      const f = at(x, y - 1, z); const a = at(x, y, z); const h = at(x, y + 1, z)
      if (/air/.test(a) && /air/.test(h) && !/air|lava|fire/.test(f)) { s = (f === 'magma_block' ? 'M' : ' ') + String(y).padStart(2); break }
      if (/air/.test(a) && /air/.test(h) && /lava/.test(f)) { s = 'L' + String(y).padStart(2); break }
    }
    row += s
  }
  console.log(row)
}
