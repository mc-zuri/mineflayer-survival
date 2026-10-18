import { BARTER, BARTER_TICKS_PER_INGOT, BARTER_TOTAL_WEIGHT, type BarterOffer } from '../planner/sources'

export interface BarterPlan {
  item: string
  wanted: number
  /** ingots for the expected yield to reach `wanted` (wanted / perIngot) */
  expectedIngots: number
  /** ingots for at least `wanted` with probability `confidence` */
  ingots: number
  confidence: number
  /** the chance `ingots` trades give at least `wanted` */
  chance: number
  /** ticks of admiring, with `piglins` piglins working at once */
  ticks: number
}

export interface BarterPlanOptions {
  /** wanted chance of getting enough (default 0.9) */
  confidence?: number
  /** piglins bartered with at once (default 1) */
  piglins?: number
  /** stop at this many ingots (default 2000) */
  maxIngots?: number
}

function offerFor (item: string): BarterOffer {
  const offer = BARTER.find(o => o.item === item)
  if (offer == null) throw new Error(`piglins don't barter ${item}`)
  return offer
}

/**
 * Gold to trade for `wanted` of an item: each ingot is one roll of piglin_bartering (the item
 * with weight / 469, then uniform min..max of it), so the count after n ingots is a sum of n
 * independent rolls. The chance of reaching `wanted` is worked out exactly by convolution
 * (counts capped at `wanted`), and the ingots are the fewest that reach `confidence`.
 */
export function planBarter (item: string, wanted: number, opts: BarterPlanOptions = {}): BarterPlan {
  const offer = offerFor(item)
  const confidence = opts.confidence ?? 0.9
  const piglins = Math.max(1, opts.piglins ?? 1)
  const maxIngots = opts.maxIngots ?? 2000
  const p = offer.weight / BARTER_TOTAL_WEIGHT
  const span = offer.max - offer.min + 1
  const expectedIngots = Math.ceil(wanted / offer.perIngot - 1e-9)
  // dist[k] = P(count = k) for k < wanted; dist[wanted] = P(count ≥ wanted)
  let dist = new Float64Array(wanted + 1)
  dist[0] = 1
  let ingots = 0
  while (dist[wanted] < confidence && ingots < maxIngots) {
    const next = new Float64Array(wanted + 1)
    for (let k = 0; k <= wanted; k++) {
      const pk = dist[k]
      if (pk === 0) continue
      if (k === wanted) { next[wanted] += pk; continue }
      next[k] += pk * (1 - p)
      for (let c = offer.min; c <= offer.max; c++) next[Math.min(wanted, k + c)] += pk * p / span
    }
    dist = next
    ingots++
  }
  return { item, wanted, expectedIngots, ingots, confidence, chance: dist[wanted], ticks: Math.ceil(ingots / piglins) * BARTER_TICKS_PER_INGOT }
}

/** gold ingots for `pearls` ender pearls */
export function goldForPearls (pearls: number, opts: BarterPlanOptions = {}): BarterPlan {
  return planBarter('ender_pearl', pearls, opts)
}
