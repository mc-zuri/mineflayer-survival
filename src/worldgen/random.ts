/**
 * Vanilla's seeded randomness, ported bit for bit so world-seed math (structure placement,
 * end spikes, stronghold rings) gives the server's answers. Java longs are BigInts here.
 *
 * The same in 1.21.11 and 26.3: LegacyRandomSource and BitRandomSource, WorldgenRandom's large feature seeds and salts,
 * Util.shuffle. (26.3's RandomSource.createThreadLocalInstance, which some of it now uses, is a SingleThreadedRandomSource:
 * the same LCG.)
 */

export type Seed = bigint | number | string

const MULTIPLIER = 0x5DEECE66Dn
const INCREMENT = 0xBn
const MODULUS_MASK = (1n << 48n) - 1n
/** BitRandomSource.FLOAT_MULTIPLIER (5.9604645E-8F) */
const FLOAT_MULTIPLIER = Math.fround(5.9604645e-8)
/** BitRandomSource.DOUBLE_MULTIPLIER: the float literal 1.110223E-16F widened, which is not quite 2^-53 */
const DOUBLE_MULTIPLIER = Math.fround(1.110223e-16)

/** a Java long from a number, BigInt or decimal string (wrapped to 64 bits) */
export function toLong (value: Seed): bigint {
  if (typeof value === 'bigint') return BigInt.asIntN(64, value)
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new RangeError(`seed ${value} is not a safe integer; pass it as a string or BigInt`)
    return BigInt.asIntN(64, BigInt(value))
  }
  return BigInt.asIntN(64, BigInt(value.trim()))
}

/** Java's String.hashCode, as a long */
function stringHash (text: string): bigint {
  let h = 0
  for (let i = 0; i < text.length; i++) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0
  return BigInt(h)
}

/** WorldOptions.parseSeed: a number as typed, else the text's String.hashCode */
export function parseSeed (text: string): bigint {
  const trimmed = text.trim()
  if (/^[+-]?\d+$/.test(trimmed)) {
    const n = BigInt(trimmed)
    if (n >= -(1n << 63n) && n < (1n << 63n)) return n
  }
  return stringHash(trimmed)
}

/** Mth.floor */
export function floor (d: number): number {
  const i = Math.trunc(d)
  return d < i ? i - 1 : i
}

/** LegacyRandomSource (java.util.Random's LCG) with BitRandomSource's derived methods */
export class LegacyRandomSource {
  private seed = 0n

  constructor (seed: Seed) {
    this.setSeed(seed)
  }

  setSeed (seed: Seed): void {
    this.seed = (toLong(seed) ^ MULTIPLIER) & MODULUS_MASK
  }

  next (bits: number): number {
    this.seed = (this.seed * MULTIPLIER + INCREMENT) & MODULUS_MASK
    return Number(BigInt.asIntN(32, this.seed >> BigInt(48 - bits)))
  }

  nextInt (bound?: number): number {
    if (bound == null) return this.next(32)
    if (bound <= 0) throw new RangeError('Bound must be positive')
    if ((bound & (bound - 1)) === 0) return Number((BigInt(bound) * BigInt(this.next(31))) >> 31n)
    let j: number
    let k: number
    do {
      j = this.next(31)
      k = j % bound
    } while (((j - k + (bound - 1)) | 0) < 0)
    return k
  }

  nextLong (): bigint {
    const hi = this.next(32)
    const lo = this.next(32)
    return BigInt.asIntN(64, (BigInt(hi) << 32n) + BigInt(lo))
  }

  nextBoolean (): boolean {
    return this.next(1) !== 0
  }

  nextFloat (): number {
    return Math.fround(this.next(24) * FLOAT_MULTIPLIER)
  }

  nextDouble (): number {
    const hi = this.next(26)
    const lo = this.next(27)
    return (hi * 134217728 + lo) * DOUBLE_MULTIPLIER
  }

  /** LegacyRandomSource.fork: a new source seeded from this one's nextLong */
  fork (): LegacyRandomSource {
    return new LegacyRandomSource(this.nextLong())
  }
}

/** WorldgenRandom.setLargeFeatureSeed: the seed structure selection rolls with */
export function setLargeFeatureSeed (random: LegacyRandomSource, levelSeed: Seed, chunkX: number, chunkZ: number): void {
  const l = toLong(levelSeed)
  random.setSeed(l)
  const m = random.nextLong()
  const n = random.nextLong()
  random.setSeed(BigInt.asIntN(64, (BigInt(chunkX) * m) ^ (BigInt(chunkZ) * n) ^ l))
}

/** WorldgenRandom.setLargeFeatureWithSalt: the seed random-spread placement rolls with */
export function setLargeFeatureWithSalt (random: LegacyRandomSource, levelSeed: Seed, regionX: number, regionZ: number, salt: number): void {
  random.setSeed(BigInt.asIntN(64, BigInt(regionX) * 341873128712n + BigInt(regionZ) * 132897987541n + toLong(levelSeed) + BigInt(salt)))
}

/** Util.toShuffledList(IntStream.range(0, n), random): Fisher-Yates from the top */
export function shuffledRange (n: number, random: LegacyRandomSource): number[] {
  const list = Array.from({ length: n }, (_, i) => i)
  for (let j = n; j > 1; j--) {
    const k = random.nextInt(j)
    const t = list[j - 1]
    list[j - 1] = list[k]
    list[k] = t
  }
  return list
}
