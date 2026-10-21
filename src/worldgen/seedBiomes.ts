// The overworld's surface biomes from the seed, read with the minecraft-java-worldgen package (the vanilla generator in
// WebAssembly, run in a worker) when it is installed and has the bot's version: the land past the loaded chunks, for
// where to go for food. A point costs some 2.4 s of the worker's (it generates the chunks round it), so the reads are
// a few points at a time, never in the tick.
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Seed } from './random'

/** the package: installed, else the workspace's checkout (packages/minecraft-java-worldgen in a directory above), else null */
function loadGenerator (): any {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('minecraft-java-worldgen')
  } catch {}
  for (let dir = __dirname, i = 0; i < 8; i++, dir = path.dirname(dir)) {
    const pkg = path.join(dir, 'packages', 'minecraft-java-worldgen')
    if (!fs.existsSync(path.join(pkg, 'package.json'))) continue
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require(pkg)
    } catch {
      return null
    }
  }
  return null
}

export interface SurfaceBiome {
  x: number
  z: number
  /** the top block's y + 1 (WORLD_SURFACE) */
  y: number
  /** the biome's name without its namespace */
  biome: string
  /** the top block is water (a lake's, a river's, the sea's) */
  water?: boolean
}

export interface SeedBiomes {
  /** the surface biome at a column (Biome lookup at the WORLD_SURFACE height's top block) */
  surface: (x: number, z: number) => Promise<SurfaceBiome>
  dispose: () => Promise<void>
}

/** the generator's world for a seed and version, or null when the package isn't there or hasn't the version */
export async function openSeedBiomes (seed: Seed, version: string): Promise<SeedBiomes | null> {
  // (an optional package: required only when there's a seed to read)
  const gen = loadGenerator()
  if (gen == null) return null
  let world: any
  try {
    const parsed = typeof seed === 'string' ? (gen.parseSeed?.(seed) ?? seed) : seed
    world = await gen.createWorld({ seed: parsed, version })
  } catch {
    return null
  }
  return {
    surface: async (x, z) => {
      const y = await world.getHeight(x, z)
      const b = await world.getBiome({ x, y: y - 1, z })
      // (the top block: its chunk generated for the height already)
      const top = await world.getBlock({ x, y: y - 1, z }).catch(() => null)
      const name = String(top?.state?.name ?? top?.name ?? '')
      return { x, z, y, biome: String(b.name).replace(/^minecraft:/, ''), water: /^(minecraft:)?water$/.test(name) }
    },
    dispose: async () => { await world.dispose() }
  }
}
