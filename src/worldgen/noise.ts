// The noise the nether's biomes come from, ported from vanilla: ImprovedNoise (Perlin's), the legacy PerlinNoise octave
// stack and the NormalNoise pair over it. Only the legacy nether biome construction is here (the nether and the End
// have legacy_random_source: RandomState makes their temperature and vegetation noises with
// NormalNoise.createLegacyNetherBiome from a LegacyRandomSource of the seed + 0 and + 1). The same in 1.21.11 and 26.3.
import { floor, LegacyRandomSource } from './random'

/** SimplexNoise.GRADIENT */
const GRADIENT: ReadonlyArray<readonly [number, number, number]> = [
  [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0], [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
  [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1], [1, 1, 0], [0, -1, 1], [-1, 1, 0], [0, -1, -1]
]

function gradDot (hash: number, x: number, y: number, z: number): number {
  const g = GRADIENT[hash & 15]
  return g[0] * x + g[1] * y + g[2] * z
}

/** Mth.smoothstep */
function smoothstep (d: number): number {
  return d * d * d * (d * (d * 6 - 15) + 10)
}

function lerp (d: number, a: number, b: number): number {
  return a + d * (b - a)
}

function lerp2 (d: number, e: number, a: number, b: number, c: number, f: number): number {
  return lerp(e, lerp(d, a, b), lerp(d, c, f))
}

/** Mth.lerp3 */
function lerp3 (d: number, e: number, f: number, a: number, b: number, c: number, g: number, h: number, i: number, j: number, k: number): number {
  return lerp(f, lerp2(d, e, a, b, c, g), lerp2(d, e, h, i, j, k))
}

/** ImprovedNoise: Perlin's noise with a shuffled permutation and an offset, both from the random */
export class ImprovedNoise {
  readonly xo: number
  readonly yo: number
  readonly zo: number
  private readonly p = new Uint8Array(256)

  constructor (random: LegacyRandomSource) {
    this.xo = random.nextDouble() * 256
    this.yo = random.nextDouble() * 256
    this.zo = random.nextDouble() * 256
    for (let i = 0; i < 256; i++) this.p[i] = i
    for (let i = 0; i < 256; i++) {
      const j = random.nextInt(256 - i)
      const b = this.p[i]
      this.p[i] = this.p[i + j]
      this.p[i + j] = b
    }
  }

  private hash (i: number): number {
    return this.p[i & 0xFF]
  }

  /** noise(x, y, z) with no y scale (ImprovedNoise.noise(d, e, f, 0, 0)) */
  noise (x: number, y: number, z: number): number {
    const d = x + this.xo
    const e = y + this.yo
    const f = z + this.zo
    const i = floor(d)
    const j = floor(e)
    const k = floor(f)
    return this.sampleAndLerp(i, j, k, d - i, e - j, f - k)
  }

  private sampleAndLerp (i: number, j: number, k: number, d: number, e: number, f: number): number {
    const l = this.hash(i)
    const m = this.hash(i + 1)
    const n = this.hash(l + j)
    const o = this.hash(l + j + 1)
    const q = this.hash(m + j)
    const r = this.hash(m + j + 1)
    const h = gradDot(this.hash(n + k), d, e, f)
    const s = gradDot(this.hash(q + k), d - 1, e, f)
    const t = gradDot(this.hash(o + k), d, e - 1, f)
    const u = gradDot(this.hash(r + k), d - 1, e - 1, f)
    const v = gradDot(this.hash(n + k + 1), d, e, f - 1)
    const w = gradDot(this.hash(q + k + 1), d - 1, e, f - 1)
    const x = gradDot(this.hash(o + k + 1), d, e - 1, f - 1)
    const y = gradDot(this.hash(r + k + 1), d - 1, e - 1, f - 1)
    return lerp3(smoothstep(d), smoothstep(e), smoothstep(f), h, s, t, u, v, w, x, y)
  }
}

/** PerlinNoise.wrap: keeps the inputs where a double still has the precision */
function wrap (d: number): number {
  return d - Math.floor(d / 3.3554432e7 + 0.5) * 3.3554432e7
}

/** PerlinNoise, built the legacy way (createLegacyForLegacyNetherBiome): octaves made from the top one down */
export class LegacyPerlinNoise {
  private readonly levels: Array<ImprovedNoise | null>
  private readonly lowestFreqInputFactor: number
  private readonly lowestFreqValueFactor: number

  constructor (random: LegacyRandomSource, readonly firstOctave: number, readonly amplitudes: readonly number[]) {
    const i = amplitudes.length
    const j = -firstOctave
    this.levels = new Array(i).fill(null)
    const top = new ImprovedNoise(random)
    if (j >= 0 && j < i && amplitudes[j] !== 0) this.levels[j] = top
    for (let k = j - 1; k >= 0; k--) {
      if (k < i && amplitudes[k] !== 0) this.levels[k] = new ImprovedNoise(random)
      else for (let n = 0; n < 262; n++) random.nextInt() // skipOctave: consumeCount(262)
    }
    if (j < i - 1) throw new RangeError('Positive octaves are temporarily disabled')
    this.lowestFreqInputFactor = Math.pow(2, -j)
    this.lowestFreqValueFactor = Math.pow(2, i - 1) / (Math.pow(2, i) - 1)
  }

  getValue (x: number, y: number, z: number): number {
    let sum = 0
    let g = this.lowestFreqInputFactor
    let l = this.lowestFreqValueFactor
    for (let i = 0; i < this.levels.length; i++) {
      const level = this.levels[i]
      if (level != null) sum += this.amplitudes[i] * level.noise(wrap(x * g), wrap(y * g), wrap(z * g)) * l
      g *= 2
      l /= 2
    }
    return sum
  }
}

/** NormalNoise.INPUT_FACTOR: the second noise's inputs are scaled by it */
const INPUT_FACTOR = 1.0181268882175227

/** NormalNoise.createLegacyNetherBiome: two legacy PerlinNoises, one at a slightly other scale, added and normalised */
export class LegacyNormalNoise {
  private readonly first: LegacyPerlinNoise
  private readonly second: LegacyPerlinNoise
  private readonly valueFactor: number

  constructor (random: LegacyRandomSource, firstOctave: number, amplitudes: readonly number[]) {
    this.first = new LegacyPerlinNoise(random, firstOctave, amplitudes)
    this.second = new LegacyPerlinNoise(random, firstOctave, amplitudes)
    let lo = Infinity
    let hi = -Infinity
    amplitudes.forEach((a, i) => { if (a !== 0) { lo = Math.min(lo, i); hi = Math.max(hi, i) } })
    // NormalNoise.expectedDeviation(hi - lo)
    this.valueFactor = 0.16666666666666666 / (0.1 * (1 + 1 / (hi - lo + 1)))
  }

  getValue (x: number, y: number, z: number): number {
    return (this.first.getValue(x, y, z) + this.second.getValue(x * INPUT_FACTOR, y * INPUT_FACTOR, z * INPUT_FACTOR)) * this.valueFactor
  }
}
