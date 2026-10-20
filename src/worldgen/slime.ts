// Slime chunks: Slime.checkSlimeSpawnRules lets a slime spawn under y 40 in a chunk whose WorldgenRandom.seedSlimeChunk
// draws nextInt(10) == 0 (a tenth of the chunks), whatever the light and the biome; elsewhere only in the swamps
// (BiomeTags.ALLOWS_SURFACE_SLIME_SPAWNS, y 51 to 69, dark, by the moon). The same in 1.21.11 and 26.3 (26.3's
// seedSlimeChunk read from its server jar: the same constants, RandomSource.createThreadLocalInstance's LCG).
import { LegacyRandomSource, toLong, type Seed } from './random'

/** Slime.checkSlimeSpawnRules' salt */
export const SLIME_CHUNK_SALT = 987234911n
/** a slime chunk's slimes spawn below this y (Slime.checkSlimeSpawnRules: blockPos.getY() < 40) */
export const SLIME_CHUNK_MAX_Y = 40

/** WorldgenRandom.seedSlimeChunk: the int products wrap at 32 bits before they're widened, as Java's */
export function seedSlimeChunk (chunkX: number, chunkZ: number, levelSeed: Seed, salt: bigint = SLIME_CHUNK_SALT): LegacyRandomSource {
  const int = (v: number): bigint => BigInt(v | 0)
  const a = int(Math.imul(Math.imul(chunkX, chunkX), 4987142))
  const b = int(Math.imul(chunkX, 5947611))
  const c = int(Math.imul(chunkZ, chunkZ)) * 4392871n
  const d = int(Math.imul(chunkZ, 389711))
  return new LegacyRandomSource(BigInt.asIntN(64, BigInt.asIntN(64, toLong(levelSeed) + a + b + c + d) ^ salt))
}

/** whether the chunk is a slime chunk (seedSlimeChunk(...).nextInt(10) == 0) */
export function isSlimeChunk (levelSeed: Seed, chunkX: number, chunkZ: number): boolean {
  return seedSlimeChunk(chunkX, chunkZ, levelSeed).nextInt(10) === 0
}

/** the slime chunks within `radius` chunks of the block (x, z), nearest first (by their middles) */
export function slimeChunksNear (levelSeed: Seed, x: number, z: number, radius: number): Array<{ x: number, z: number, distance: number }> {
  const cx = Math.floor(x / 16)
  const cz = Math.floor(z / 16)
  const seed = toLong(levelSeed)
  const out: Array<{ x: number, z: number, distance: number }> = []
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      if (!isSlimeChunk(seed, cx + dx, cz + dz)) continue
      out.push({ x: cx + dx, z: cz + dz, distance: Math.hypot((cx + dx) * 16 + 8 - x, (cz + dz) * 16 + 8 - z) })
    }
  }
  return out.sort((a, b) => a.distance - b.distance)
}
