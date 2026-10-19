// A real stretch of seed 2's nether (26.3) for the pathfinder's search on the fake rig (the pathfinder's tests/setup):
// the block state ids of x 240 to 495, z -64 to 127, y 24 to 119 (tests/fixtures/nether-seed2-delta.json.gz: the
// basalt delta at x 320 to 380 that the runs cross heading east, read from a 26.3 server's chunks), and the columns
// round it left unloaded (a search doesn't go there).
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as zlib from 'node:zlib'
import { Vec3 } from 'vec3'

export const NETHER_SNAPSHOT = path.join(__dirname, '..', 'fixtures', 'nether-seed2-delta.json.gz')

export interface NetherSnapshot {
  version: string
  origin: [number, number, number]
  size: [number, number, number]
  /** state ids, x then z then y (y fastest) */
  ids: Uint16Array
}

export function readNetherSnapshot (file = NETHER_SNAPSHOT): NetherSnapshot {
  const json = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'))
  const buf = Buffer.from(json.ids, 'base64')
  return { version: json.version, origin: json.origin, size: json.size, ids: new Uint16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2) }
}

/** the pathfinder's fake rig on the snapshot: its world's columns over the snapshot's area hold its blocks */
export function netherSnapshotRig (start: Vec3, snapshot = readNetherSnapshot()): { rig: any, world: any, snapshot: NetherSnapshot } {
  const setup = require('@nxg-org/mineflayer-pathfinder/tests/setup')
  const world = setup.createFlatWorld(snapshot.version, 0, { renderDistance: 0, center: new Vec3(-100000, 0, -100000) })
  // (the pathfinder's own prismarine-chunk: survival doesn't depend on it)
  const ChunkLoader = require(require.resolve('prismarine-chunk', { paths: [path.dirname(require.resolve('@nxg-org/mineflayer-pathfinder/package.json'))] }))
  const Chunk = ChunkLoader(snapshot.version)
  const [x0, y0, z0] = snapshot.origin
  const [sx, sy, sz] = snapshot.size
  for (let cx = Math.floor(x0 / 16); cx <= Math.floor((x0 + sx - 1) / 16); cx++) {
    for (let cz = Math.floor(z0 / 16); cz <= Math.floor((z0 + sz - 1) / 16); cz++) {
      const chunk = new Chunk({ minY: -64, worldHeight: 384 })
      const p = new Vec3(0, 0, 0)
      for (let lx = 0; lx < 16; lx++) {
        for (let lz = 0; lz < 16; lz++) {
          const x = cx * 16 + lx - x0
          const z = cz * 16 + lz - z0
          if (x < 0 || x >= sx || z < 0 || z >= sz) continue
          const base = (x * sz + z) * sy
          for (let y = 0; y < sy; y++) {
            const id = snapshot.ids[base + y]
            if (id === 0) continue
            p.set(lx, y0 + y, lz)
            chunk.setBlockStateId(p, id)
          }
        }
      }
      world.setColumn(cx, cz, chunk)
    }
  }
  const { rig } = setup.createCacheWorld(snapshot.version, 0, start, { world, trackRenderDistance: false })
  return { rig, world, snapshot }
}
