// The nether's biomes from the seed, as the server places them: MultiNoiseBiomeSource with the nether preset
// (MultiNoiseBiomeSourceParameterList.Preset.NETHER) over the nether noise router's temperature and vegetation, the
// only two of its climate parameters that aren't 0. The same in 1.21.11 and 26.3.
//
// noise_settings/nether: temperature and vegetation are shifted_noise of minecraft:temperature and minecraft:vegetation
// at xz_scale 0.25, y_scale 0 (so the biome is the same at every height), shifted by shift_x / shift_z; with the
// nether's legacy_random_source RandomState swaps those noises for NormalNoise.createLegacyNetherBiome(new
// LegacyRandomSource(seed + 0 / + 1), firstOctave -7, amplitudes 1, 1) and the shift's for one of amplitude 0 (no shift).
import { LegacyNormalNoise } from './noise'
import { LegacyRandomSource, toLong, type Seed } from './random'

export type NetherBiome = 'nether_wastes' | 'soul_sand_valley' | 'crimson_forest' | 'warped_forest' | 'basalt_deltas'

/** Climate.quantizeCoord: a float parameter as the long the search compares */
function quantize (f: number): number {
  return Math.trunc(Math.fround(Math.fround(f) * 10000))
}

/** the nether preset's points: temperature, humidity (vegetation) and offset; continentalness, erosion, depth and weirdness are all 0 */
const NETHER_POINTS: ReadonlyArray<{ biome: NetherBiome, temperature: number, humidity: number, offset: number }> = [
  { biome: 'nether_wastes', temperature: 0, humidity: 0, offset: 0 },
  { biome: 'soul_sand_valley', temperature: 0, humidity: -0.5, offset: 0 },
  { biome: 'crimson_forest', temperature: 0.4, humidity: 0, offset: 0 },
  { biome: 'warped_forest', temperature: 0, humidity: 0.5, offset: 0.375 },
  { biome: 'basalt_deltas', temperature: -0.5, humidity: 0, offset: 0.175 }
].map(p => ({ biome: p.biome as NetherBiome, temperature: quantize(p.temperature), humidity: quantize(p.humidity), offset: quantize(p.offset) }))

/** The nether's biome source for a seed: its noises made once, then a biome a lookup */
export class NetherBiomeSource {
  private readonly temperature: LegacyNormalNoise
  private readonly vegetation: LegacyNormalNoise

  constructor (levelSeed: Seed) {
    const seed = toLong(levelSeed)
    // RandomState.NoiseWiringHelper: newLegacyInstance(0) and (1), the seed plus that
    this.temperature = new LegacyNormalNoise(new LegacyRandomSource(seed), -7, [1, 1])
    this.vegetation = new LegacyNormalNoise(new LegacyRandomSource(BigInt.asIntN(64, seed + 1n)), -7, [1, 1])
  }

  /** the climate (quantized temperature and humidity) at a block (sampled where its quart's corner is) */
  climate (x: number, z: number): { temperature: number, humidity: number } {
    // Climate.Sampler.sample at QuartPos.toBlock of the quart: the block's quart corner
    const bx = (x >> 2) << 2
    const bz = (z >> 2) << 2
    return {
      temperature: quantize(this.temperature.getValue(bx * 0.25, 0, bz * 0.25)),
      humidity: quantize(this.vegetation.getValue(bx * 0.25, 0, bz * 0.25))
    }
  }

  /**
   * the biome at a block (MultiNoiseBiomeSource.getNoiseBiome at its quart: Climate.ParameterList's nearest point,
   * the squares of the distances and the offset). Not the BiomeManager's fuzzy zoom of a block lookup: within 2 or
   * so blocks of a biome's edge the server may say the other.
   */
  biomeAt (x: number, z: number): NetherBiome {
    const c = this.climate(Math.floor(x), Math.floor(z))
    let best = NETHER_POINTS[0]
    let bestFit = Infinity
    for (const p of NETHER_POINTS) {
      const fit = (c.temperature - p.temperature) ** 2 + (c.humidity - p.humidity) ** 2 + p.offset ** 2
      if (fit < bestFit) { best = p; bestFit = fit }
    }
    return best.biome
  }
}
