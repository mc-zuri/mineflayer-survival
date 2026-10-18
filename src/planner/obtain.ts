import { Inventory, type ItemCount } from '../core/inventory'
import { burnTicks, FOODS, parseTool, SMELT_TICKS, TOOL_MATERIAL_RANK, TOOL_MATERIALS, toolKindForMaterial } from '../core/items'
import type { Dimension, Pos, WorldMemory } from '../core/memory'
import { normalizeDimension } from '../core/memory'
import type { RegistryLike } from '../core/registry'
import { itemTags } from '../core/tags'
import { recipesFor, type CraftRecipe } from './recipes'
import {
  BARTER, BARTER_FIND, BARTER_TICKS_PER_INGOT, BLOCK_SOURCES, CRAFT_TICKS, DIMENSION_TRAVEL, FIGHT_TICKS, FILL_TICKS, FLUIDS,
  FUELS, GOLD_ARMOR, MOB_SOURCES, PICKUP_TICKS, SMELTING, WALK_TICKS_PER_BLOCK,
  type BarterOffer, type BlockSource, type FluidSource, type MobSource, type SmeltingRecipe
} from './sources'
import { checkPlan, type PlanStep, type Station } from './steps'

export type StrategyKind = PlanStep['kind']

export interface ObtainRequest {
  /** an item name, a `#tag`, or alternatives any of which will do */
  item: string | readonly string[]
  count: number
  /** left out of the plan (instead of failing it) when it can't be obtained */
  optional?: boolean
  /**
   * what `count` counts: items (the default), or the nutrition of the safe food among the alternatives (vanilla
   * FoodProperties.nutrition), any mix of them adding up: 40 points are 5 cooked beef or 20 sweet berries
   */
  unit?: 'items' | 'nutrition'
}

/** what one of an item counts for in a request: 1, or its nutrition for a nutrition request (0 for harmful food) */
export function unitValue (req: Pick<ObtainRequest, 'unit'>, item: string): number {
  if (req.unit !== 'nutrition') return 1
  const food = FOODS[item]
  return food == null || food.harmful === true ? 0 : food.nutrition
}

/** how much of a request the inventory holds, in the request's unit, over its (resolved) alternatives */
export function heldFor (inv: Inventory, alts: readonly string[], req: Pick<ObtainRequest, 'unit'>): number {
  if (req.unit !== 'nutrition') return inv.countAny(alts)
  return alts.reduce((n, a) => n + inv.count(a) * unitValue(req, a), 0)
}

export interface ObtainOptions {
  /** what the bot holds (default: nothing) */
  inventory?: Inventory | Record<string, number> | ItemCount[]
  /** stations usable without carrying one (the base's crafting table and furnace) */
  stations?: Station[]
  /** remembered blocks make mining cheaper; remembered chests can be looted */
  memory?: WorldMemory
  /** where the bot is, for distances to remembered things */
  position?: Pos
  /** the dimension the bot is in (default overworld) */
  dimension?: Dimension
  /** strategies not to use */
  exclude?: StrategyKind[]
  /** items never burnt as fuel, on top of the ones the plan is making */
  keepFuel?: string[]
  /** recursion limit (default 24) */
  maxDepth?: number
  /**
   * ticks to reach the first of a block or mob from what the bot sees now (one in sight; none found the last time it
   * was looked for), over the memory and the source's estimate; undefined leaves those
   */
  findCost?: (target: FindTarget) => number | undefined
}

/** what findCost is asked about: a block or mob of a source, and the source's own estimate */
export interface FindTarget {
  name: string
  kind: 'block' | 'mob'
  dimension: Dimension
  /** BlockSource.find or MobSource.find */
  find: number
}

export interface ObtainPlan {
  ok: boolean
  /** in execution order */
  steps: PlanStep[]
  /** estimated ticks (plus the replacement value of fuel burnt out of the inventory) */
  cost: number
  /** the inventory once every step is done, at expected yields */
  inventory: Inventory
  /** requests that couldn't be planned */
  unresolved: ObtainRequest[]
}

interface State {
  inv: Inventory
  cost: number
  steps: PlanStep[]
  /** dimensions the plan already travels to */
  dims: Set<string>
  /** block and mob types the plan already goes to (later ones are near) */
  visited: Set<string>
  /** remembered chest contents already planned out: `chestKey|item` → count */
  looted: Map<string, number>
}

function clone (s: State): State {
  return { inv: s.inv.clone(), cost: s.cost, steps: s.steps.slice(), dims: new Set(s.dims), visited: new Set(s.visited), looted: new Map(s.looted) }
}

type Strategy = (s: State, path: string[], limit: number) => State | null

/** blocks a mine step goes down for (ORE_LEVELS' ores, the deep stone): the rest is got at the surface */
export const UNDERGROUND_BLOCKS = /(_ore|^ancient_debris|^deepslate|^obsidian)$/

const PREFERRED_WOOD = ['oak_', 'birch_', 'spruce_']

/**
 * The obtain resolver: plans how to end up with `count` of an item from what the bot holds.
 * Every way of getting an item (craft, smelt, mine, kill, barter, loot, fill a bucket) is a
 * strategy whose estimate is its ticks plus its prerequisites' (tools, a crafting table, a
 * furnace, fuel, ingredients), resolved recursively against a simulated inventory; the
 * cheapest wins, as in prismarine-gameplay where `estimate()` is a cost or Infinity. Stations
 * and tools are reusable: made once, then found in the inventory.
 */
export class Resolver {
  private readonly smelting = new Map<string, SmeltingRecipe[]>()
  private readonly blockSources = new Map<string, BlockSource[]>()
  private readonly mobSources = new Map<string, MobSource[]>()
  private readonly barter = new Map<string, BarterOffer>()
  private readonly fluids = new Map<string, FluidSource>()
  private readonly dimension: Dimension
  private readonly maxDepth: number
  private readonly exclude: Set<StrategyKind>

  constructor (readonly registry: RegistryLike, readonly opts: ObtainOptions = {}) {
    this.dimension = normalizeDimension(opts.dimension)
    this.maxDepth = opts.maxDepth ?? 24
    this.exclude = new Set(opts.exclude ?? [])
    const items = registry.itemsByName
    for (const r of SMELTING) {
      if (items[r.output] == null) continue
      push(this.smelting, r.output, r)
    }
    for (const b of BLOCK_SOURCES) {
      if (registry.blocksByName[b.block] == null) continue
      for (const d of b.drops) if (items[d.item] != null) push(this.blockSources, d.item, b)
    }
    for (const m of MOB_SOURCES) for (const d of m.drops) if (items[d.item] != null) push(this.mobSources, d.item, m)
    for (const o of BARTER) this.barter.set(o.item, o)
    for (const f of FLUIDS) this.fluids.set(f.item, f)
  }

  /** plans one request */
  obtain (item: string | readonly string[], count: number): ObtainPlan {
    return this.obtainAll([{ item, count }])
  }

  /**
   * Plans several requests into one plan, in order; the inventory is shared, so later ones
   * reuse what earlier ones made, and earlier ones are topped up if later ones used them up.
   */
  obtainAll (requests: readonly ObtainRequest[]): ObtainPlan {
    let s = this.initialState()
    const unresolved = new Set<ObtainRequest>()
    for (let round = 0; round < 4; round++) {
      let changed = false
      for (const req of requests) {
        if (unresolved.has(req)) continue
        const alts = this.alternatives(req.item)
        if (heldFor(s.inv, alts, req) >= req.count) continue
        const next = req.unit === 'nutrition' ? this.ensureValue(s, alts, req, req.count, [], Infinity) : this.ensure(s, alts, req.count, [], Infinity)
        if (next == null) {
          unresolved.add(req)
          if (req.optional !== true) return { ok: false, steps: this.tidy(s.steps), cost: s.cost, inventory: s.inv, unresolved: [...unresolved] }
          continue
        }
        s = next
        changed = true
      }
      if (!changed) break
    }
    return { ok: true, steps: this.tidy(s.steps), cost: s.cost, inventory: s.inv, unresolved: [...unresolved] }
  }

  /**
   * Folds repeated steps together: mine and kill steps always (mergeSteps), and a craft or
   * smelt into the first one like it when the plan still checks with it moved there, so the
   * bot crafts all its planks at once instead of a log at a time.
   */
  private tidy (steps: readonly PlanStep[]): PlanStep[] {
    let out = mergeSteps(steps)
    const start = this.initialState().inv
    const stations = this.opts.stations ?? []
    for (let i = 1; i < out.length; i++) {
      const step = out[i]
      if (step.kind !== 'craft' && step.kind !== 'smelt') continue
      for (let j = 0; j < i; j++) {
        const merged = mergeInto(out[j], step)
        if (merged == null) continue
        const candidate = [...out.slice(0, j), merged, ...out.slice(j + 1, i), ...out.slice(i + 1)]
        if (checkPlan(this.registry, candidate, start, stations).ok) {
          out = candidate
          i--
          break
        }
      }
    }
    return this.surfaceFirst(out, start, stations)
  }

  /**
   * Moves what is mined at the surface (logs for fuel and sticks, sand, stone) before the first trip down for ore,
   * where the plan still checks: the iron plan cut its logs after its 33 raw iron, a climb back up from y 16 (17000
   * ticks for one log on seed 1234567890, a staircase dug up with a wooden pickaxe) and the way down again.
   */
  private surfaceFirst (steps: PlanStep[], start: Inventory, stations: readonly Station[]): PlanStep[] {
    let out = steps
    const deep = (s: PlanStep): boolean => s.kind === 'mine' && UNDERGROUND_BLOCKS.test(s.block)
    for (let i = 0; i < out.length; i++) {
      const s = out[i]
      if (s.kind !== 'mine' || deep(s)) continue
      const at = out.findIndex(deep)
      if (at < 0 || at >= i) continue
      const candidate = [...out.slice(0, at), s, ...out.slice(at, i), ...out.slice(i + 1)]
      if (checkPlan(this.registry, candidate, start, stations).ok) out = candidate
    }
    return out
  }

  private initialState (): State {
    const inv = this.opts.inventory instanceof Inventory
      ? this.opts.inventory.clone()
      : new Inventory(this.registry, this.opts.inventory ?? [])
    return { inv, cost: 0, steps: [], dims: new Set([this.dimension]), visited: new Set(), looted: new Map() }
  }

  private alternatives (item: string | readonly string[]): string[] {
    const tags = itemTags(this.registry)
    const list = typeof item === 'string' ? [item] : item
    const out: string[] = []
    for (const i of list) for (const m of tags.resolve(i)) if (!out.includes(m)) out.push(m)
    return out
  }

  /**
   * A state holding at least `count` of the alternatives together, or null if none can be
   * had within `limit`. Doesn't change `s`; may return it as is.
   */
  private ensure (s: State, alts: readonly string[], count: number, path: string[], limit: number): State | null {
    const have = s.inv.countAny(alts)
    if (have >= count) return s
    const missing = count - have
    let best: State | null = null
    for (const item of this.orderAlternatives(s, alts)) {
      const lim = best == null ? limit : Math.min(limit, best.cost)
      const r = this.produce(clone(s), item, missing, path, lim)
      if (r != null && r.cost <= lim && (best == null || r.cost < best.cost)) best = r
    }
    return best
  }

  /**
   * A state holding alternatives worth `count` in the request's unit (food points), or null: the cheapest one
   * alternative that makes up what is missing (the points from one source, as a hunt for cows or a patch of berry
   * bushes gets them; what is held of the others counts)
   */
  private ensureValue (s: State, alts: readonly string[], req: Pick<ObtainRequest, 'unit'>, count: number, path: string[], limit: number): State | null {
    const have = heldFor(s.inv, alts, req)
    if (have >= count) return s
    let best: State | null = null
    for (const item of this.orderAlternatives(s, alts)) {
      const value = unitValue(req, item)
      if (value <= 0) continue
      const n = Math.ceil((count - have) / value - 1e-9)
      const lim = best == null ? limit : Math.min(limit, best.cost)
      const r = this.produce(clone(s), item, n, path, lim)
      if (r != null && r.cost <= lim && (best == null || r.cost < best.cost)) best = r
    }
    return best
  }

  /** held ones first, then the common woods, then the lower tool tiers: the cheap ones tend to come first, which prunes the rest */
  private orderAlternatives (s: State, alts: readonly string[]): string[] {
    const key = (n: string): number => {
      const tool = parseTool(n)
      const toolRank = tool == null ? 0 : TOOL_MATERIAL_RANK.indexOf(tool.material) + (tool.material === 'golden' ? 3 : 0)
      const wood = PREFERRED_WOOD.findIndex(p => n.startsWith(p) || n.startsWith('stripped_' + p))
      return -s.inv.count(n) * 1000 + toolRank * 10 + (wood < 0 ? 5 : wood)
    }
    return [...alts].sort((a, b) => key(a) - key(b))
  }

  /** `s` with n more of `item`, the cheapest way within `limit`; owns and may change `s` */
  private produce (s: State, item: string, n: number, path: string[], limit: number, skip?: StrategyKind): State | null {
    if (path.length >= this.maxDepth || path.includes(item)) return null
    const sub = [...path, item]
    const before = s.inv.count(item)
    let best: State | null = null
    for (const strategy of this.strategies(item, n, skip)) {
      const lim = best == null ? limit : Math.min(limit, best.cost)
      const r = strategy(clone(s), sub, lim)
      // it has to leave n more of the item: an ingot crafted back from the nuggets a held ingot crafts into only moves
      // the iron round (2 ingots held, the bucket's third planned that way, and meet gave up: "no plan for 1 bucket")
      if (r != null && r.inv.count(item) < before + n) continue
      if (r != null && r.cost <= lim && (best == null || r.cost < best.cost)) best = r
    }
    return best
  }

  private strategies (item: string, n: number, skip?: StrategyKind): Strategy[] {
    const out: Strategy[] = []
    const use = (kind: StrategyKind): boolean => kind !== skip && !this.exclude.has(kind)
    if (use('loot') && this.opts.memory != null && this.opts.memory.findItem(item).length > 0) out.push((s, p, l) => this.loot(s, item, n, p, l))
    if (use('craft')) for (const r of recipesFor(this.registry, item)) out.push((s, p, l) => this.craft(s, r, n, p, l))
    if (use('smelt')) for (const r of this.smelting.get(item) ?? []) out.push((s, p, l) => this.smelt(s, r, item, n, p, l))
    if (use('mine')) for (const b of this.blockSources.get(item) ?? []) out.push((s, p, l) => this.mine(s, b, item, n, p, l))
    if (use('fill')) { const f = this.fluids.get(item); if (f != null) out.push((s, p, l) => this.fill(s, f, n, p, l)) }
    if (use('kill')) for (const m of this.mobSources.get(item) ?? []) out.push((s, p, l) => this.kill(s, m, item, n, p, l))
    if (use('barter')) { const o = this.barter.get(item); if (o != null) out.push((s, p, l) => this.trade(s, o, n, p, l)) }
    return out
  }

  private hasStation (s: State, station: Station): boolean {
    return this.opts.stations?.includes(station) === true || s.inv.has(station)
  }

  /**
   * Meets a list of requirements that all have to hold at once: getting one can use up
   * another (the crafting table eats the planks the pickaxe needed), so loop until they do.
   */
  private meet (s: State, reqs: Array<{ alts: readonly string[], count: number }>, path: string[], limit: number): State | null {
    let t: State | null = s
    for (let round = 0; round < 8; round++) {
      const unmet = reqs.find(r => (t as State).inv.countAny(r.alts) < r.count)
      if (unmet == null) return t
      t = this.ensure(t, unmet.alts, unmet.count, path, limit)
      if (t == null) return null
    }
    return null
  }

  private stationReq (s: State, station: Station): Array<{ alts: readonly string[], count: number }> {
    return this.hasStation(s, station) && !s.inv.has(station) ? [] : [{ alts: [station], count: 1 }]
  }

  private craft (s: State, recipe: CraftRecipe, n: number, path: string[], limit: number): State | null {
    const crafts = Math.ceil(n / recipe.count)
    s.cost += CRAFT_TICKS
    if (s.cost > limit) return null
    const reqs = [
      ...(recipe.table ? this.stationReq(s, 'crafting_table') : []),
      ...recipe.ingredients.map(i => ({ alts: i.items, count: i.count * crafts }))
    ]
    const t = this.meet(s, reqs, path, limit)
    if (t == null) return null
    const ingredients: ItemCount[] = []
    for (const ing of recipe.ingredients) ingredients.push(...takeFrom(t.inv, ing.items, ing.count * crafts))
    for (const r of recipe.remainders) t.inv.add(r.name, r.count * crafts)
    const made = crafts * recipe.count
    t.inv.add(recipe.result, made)
    const last = t.steps[t.steps.length - 1]
    if (last?.kind === 'craft' && last.recipe === recipe && sameItems(last.ingredients, ingredients)) {
      // the same craft twice in a row (a top-up round): one step
      t.steps[t.steps.length - 1] = { ...last, count: last.count + made, crafts: last.crafts + crafts, ingredients: addItems(last.ingredients, ingredients), cost: last.cost + CRAFT_TICKS }
    } else {
      t.steps.push({ kind: 'craft', item: recipe.result, count: made, crafts, recipe, ingredients, table: recipe.table, cost: CRAFT_TICKS })
    }
    return t
  }

  private smelt (s: State, recipe: SmeltingRecipe, item: string, n: number, path: string[], limit: number): State | null {
    const own = CRAFT_TICKS + n * SMELT_TICKS
    s.cost += own
    if (s.cost > limit) return null
    const inputs = this.alternatives(recipe.input)
    const burn = n * SMELT_TICKS
    const keep = [...path, ...(this.opts.keepFuel ?? [])]
    let t: State = s
    for (let round = 0; round < 8; round++) {
      const met = this.meet(t, [...this.stationReq(t, 'furnace'), { alts: inputs, count: n }], path, limit)
      if (met == null) return null
      t = met
      // the fuel comes out of what is left once the input is set aside (logs can be both)
      const rest = t.inv.clone()
      takeFrom(rest, inputs, n)
      const fuel = this.fuelFromInventory(rest, burn, keep)
      const held = fuel == null ? Infinity : t.cost + fuel.penalty
      // making better fuel can beat burning what is held (a log into planks burns 4 times longer)
      const made = this.obtainFuel(t, burn, inputs, n, keep, path, Math.min(limit, held))
      if (fuel != null && (made == null || held <= made.total)) {
        if (held > limit) return null
        const input = takeFrom(t.inv, inputs, n)
        for (const f of fuel.items) t.inv.remove(f.name, f.count)
        t.cost = held
        t.inv.add(item, n)
        t.steps.push({ kind: 'smelt', item, count: n, input: input[0].name, inputs: input, fuel: fuel.items, station: 'furnace', cost: own + fuel.penalty })
        return t
      }
      if (made == null) return null
      t = made.state
    }
    return null
  }

  /** the inventory fuel to burn for `burn` ticks at the least replacement value, or null if there isn't enough */
  private fuelFromInventory (inv: Inventory, burn: number, keep: readonly string[]): { items: ItemCount[], penalty: number } | null {
    const held: Array<{ name: string, count: number, ticks: number, value: number }> = []
    for (const f of FUELS) {
      for (const name of itemTags(this.registry).resolve(f.item)) {
        const ticks = burnTicks(name)
        const count = inv.count(name)
        if (ticks > 0 && count > 0 && !keep.includes(name)) held.push({ name, count, ticks, value: f.value })
      }
    }
    let best: { items: ItemCount[], penalty: number } | null = null
    const consider = (items: ItemCount[], penalty: number): void => {
      if (best == null || penalty < best.penalty) best = { items, penalty }
    }
    // one kind of fuel
    for (const h of held) {
      const units = Math.ceil(burn / h.ticks)
      if (units <= h.count) consider([{ name: h.name, count: units }], units * h.value)
    }
    // or a mix, cheapest per burnt tick first
    const sorted = [...held].sort((a, b) => a.value / a.ticks - b.value / b.ticks)
    let left = burn
    const items: ItemCount[] = []
    let penalty = 0
    for (const h of sorted) {
      if (left <= 0) break
      const units = Math.min(h.count, Math.ceil(left / h.ticks))
      items.push({ name: h.name, count: units })
      penalty += units * h.value
      left -= units * h.ticks
    }
    if (left <= 0) consider(items, penalty)
    return best
  }

  /**
   * Gets fuel for `burn` ticks: the obtainable fuel whose making plus burning costs least,
   * if that total is under `limit`
   */
  private obtainFuel (s: State, burn: number, inputs: readonly string[], n: number, keep: readonly string[], path: string[], limit: number): { state: State, total: number } | null {
    let best: State | null = null
    let bestTotal = limit
    for (const f of FUELS) {
      if (!f.obtain) continue
      const alts = this.alternatives(f.item).filter(a => burnTicks(a) > 0 && !keep.includes(a))
      if (alts.length === 0) continue
      const ticks = Math.min(...alts.map(burnTicks))
      const units = Math.ceil(burn / ticks)
      // the input may be the same item (logs into charcoal): get both
      const shared = alts.filter(a => inputs.includes(a)).length > 0 ? n : 0
      const lim = Math.min(limit, bestTotal)
      const r = this.ensure(s, alts, units + shared, path, lim)
      if (r == null || r === s) continue
      const rest = r.inv.clone()
      takeFrom(rest, inputs, Math.min(n, rest.countAny(inputs)))
      const fuel = this.fuelFromInventory(rest, burn, keep)
      const total = r.cost + (fuel?.penalty ?? Infinity)
      if (total < bestTotal) { best = r; bestTotal = total }
    }
    return best == null ? null : { state: best, total: bestTotal }
  }

  private dimensionCost (s: State, dimension: Dimension): number {
    return s.dims.has(dimension) ? 0 : DIMENSION_TRAVEL
  }

  /** ticks to the first one: less if one is in sight or memory knows where some are, more if none was found */
  private findCost (s: State, name: string, kind: FindTarget['kind'], dimension: Dimension, find: number, each: number): number {
    if (s.visited.has(name)) return each
    const sighted = this.opts.findCost?.({ name, kind, dimension, find })
    if (sighted != null) return sighted
    const memory = this.opts.memory
    if (memory == null) return find
    const known = memory.findBlocks(name, { dimension, near: this.opts.position, count: 1 })
    if (known.length === 0) return find
    if (this.opts.position == null) return Math.min(find, each * 4)
    const p = this.opts.position
    const d = Math.hypot(known[0].x - p.x, known[0].y - p.y, known[0].z - p.z)
    return Math.min(find, Math.ceil(d * WALK_TICKS_PER_BLOCK))
  }

  private harvestTools (block: string): string[] | null {
    const tools = this.registry.blocksByName[block]?.harvestTools
    if (tools == null) return null
    return Object.keys(tools).map(id => this.registry.items[Number(id)]?.name).filter((n): n is string => n != null)
  }

  /**
   * Ticks to break a block: vanilla BlockBehaviour.getDestroyProgress, speed / hardness /
   * (30 if the tool harvests it, else 100) per tick, with the tool's material speed when it
   * is the block's tool kind. No enchantments, effects, water or air penalties.
   */
  digTicks (block: string, tool: string | null): number {
    const b = this.registry.blocksByName[block]
    if (b == null || b.hardness == null || b.hardness < 0) return Infinity
    if (b.hardness === 0) return 1
    const parsed = tool == null ? null : parseTool(tool)
    const kind = toolKindForMaterial(b.material)
    const speed = parsed != null && parsed.kind === kind ? TOOL_MATERIALS[parsed.material].speed : 1
    const harvest = this.harvestTools(block)
    const canHarvest = harvest == null || (tool != null && harvest.includes(tool))
    return Math.ceil(b.hardness * (canHarvest ? 30 : 100) / speed)
  }

  private mine (s: State, src: BlockSource, item: string, n: number, path: string[], limit: number): State | null {
    const perBlock = src.drops.find(d => d.item === item)?.count ?? 0
    if (perBlock <= 0) return null
    const blockCount = Math.ceil(n / perBlock - 1e-9)
    const travel = this.dimensionCost(s, src.dimension) + this.findCost(s, src.block, 'block', src.dimension, src.find, src.each) + (blockCount - 1) * src.each
    const ownWith = (tool: string | null): number => travel + blockCount * (this.digTicks(src.block, tool) + PICKUP_TICKS)
    const harvest = this.harvestTools(src.block)
    // the cheapest it can be: with the best tool there is
    if (s.cost + ownWith(harvest?.[harvest.length - 1] ?? s.inv.bestTool(src.block)) > limit) return null
    let t: State | null = s
    if (harvest != null && !harvest.some(h => s.inv.has(h))) {
      t = this.ensure(s, harvest, 1, path, limit - travel)
      if (t == null) return null
    }
    const tool = t.inv.bestTool(src.block)
    const own = ownWith(tool)
    if (!Number.isFinite(own)) return null
    t.cost += own
    if (t.cost > limit) return null
    t.inv.add(item, Math.max(n, Math.floor(blockCount * perBlock)))
    const extra = extras(src.drops, item, blockCount)
    for (const e of extra) t.inv.add(e.name, e.count)
    t.visited.add(src.block)
    t.dims.add(src.dimension)
    const blocks = (this.blockSources.get(item) ?? [])
      .filter(b => b.dimension === src.dimension)
      .filter(b => { const h = this.harvestTools(b.block); return h == null || (tool != null && h.includes(tool)) })
      .sort((a, b) => (a === src ? -1 : b === src ? 1 : a.find - b.find))
      .map(b => b.block)
    t.steps.push({ kind: 'mine', item, count: n, block: src.block, blocks, blockCount, tool, dimension: src.dimension, cost: own, ...(extra.length > 0 ? { extra } : {}) })
    return t
  }

  private kill (s: State, src: MobSource, item: string, n: number, path: string[], limit: number): State | null {
    const perKill = src.drops.find(d => d.item === item)?.count ?? 0
    if (perKill <= 0) return null
    const kills = Math.ceil(n / perKill - 1e-9)
    const own = this.dimensionCost(s, src.dimension) + this.findCost(s, src.mob, 'mob', src.dimension, src.find, src.each) + (kills - 1) * src.each + kills * (FIGHT_TICKS + PICKUP_TICKS)
    s.cost += own
    if (s.cost > limit) return null
    s.inv.add(item, Math.max(n, Math.floor(kills * perKill)))
    const extra = extras(src.drops, item, kills)
    for (const e of extra) s.inv.add(e.name, e.count)
    s.visited.add(src.mob)
    s.dims.add(src.dimension)
    s.steps.push({ kind: 'kill', item, count: n, mob: src.mob, kills, weapon: s.inv.bestTool('sword'), dimension: src.dimension, cost: own, ...(extra.length > 0 ? { extra } : {}) })
    return s
  }

  private trade (s: State, offer: BarterOffer, n: number, path: string[], limit: number): State | null {
    const ingots = Math.ceil(n / offer.perIngot - 1e-9)
    const own = this.dimensionCost(s, 'the_nether') + (s.visited.has('piglin') ? 0 : BARTER_FIND) + ingots * BARTER_TICKS_PER_INGOT
    s.cost += own
    if (s.cost > limit) return null
    const t = this.meet(s, [{ alts: GOLD_ARMOR, count: 1 }, { alts: ['gold_ingot'], count: ingots }], path, limit)
    if (t == null) return null
    t.inv.remove('gold_ingot', ingots)
    t.inv.add(offer.item, n)
    t.visited.add('piglin')
    t.dims.add('the_nether')
    const wear = GOLD_ARMOR.find(a => t.inv.has(a)) as string
    t.steps.push({ kind: 'barter', item: offer.item, count: n, pay: { name: 'gold_ingot', count: ingots }, wear, cost: own })
    return t
  }

  private fill (s: State, src: FluidSource, n: number, path: string[], limit: number): State | null {
    const own = this.dimensionCost(s, src.dimension) + (s.visited.has(src.fluid) ? 0 : src.find) + n * FILL_TICKS
    s.cost += own
    if (s.cost > limit) return null
    const t = this.meet(s, [{ alts: ['bucket'], count: n }], path, limit)
    if (t == null) return null
    t.inv.remove('bucket', n)
    t.inv.add(src.item, n)
    t.visited.add(src.fluid)
    t.steps.push({ kind: 'fill', item: src.item, count: n, fluid: src.fluid, dimension: src.dimension, cost: own })
    return t
  }

  private loot (s: State, item: string, n: number, path: string[], limit: number): State | null {
    const memory = this.opts.memory as WorldMemory
    let left = n
    for (const { chest, count } of memory.findItem(item)) {
      if (left <= 0) break
      const k = `${chest.dimension}:${chest.x},${chest.y},${chest.z}|${item}`
      const available = count - (s.looted.get(k) ?? 0)
      if (available <= 0) continue
      const take = Math.min(available, left)
      const p = this.opts.position
      const travel = (p == null ? 200 : Math.ceil(Math.hypot(chest.x - p.x, chest.y - p.y, chest.z - p.z) * WALK_TICKS_PER_BLOCK)) +
        this.dimensionCost(s, chest.dimension) + CRAFT_TICKS
      s.cost += travel
      if (s.cost > limit) return null
      s.looted.set(k, (s.looted.get(k) ?? 0) + take)
      s.inv.add(item, take)
      s.dims.add(chest.dimension)
      s.steps.push({ kind: 'loot', item, count: take, from: { x: chest.x, y: chest.y, z: chest.z, dimension: chest.dimension }, cost: travel })
      left -= take
    }
    if (left === n) return null
    // the chests ran out: the rest some other way
    return left > 0 ? this.produce(s, item, left, path.slice(0, -1), limit, 'loot') : s
  }
}

function push<T> (map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key)
  if (list == null) map.set(key, [value])
  else list.push(value)
}

/** removes `count` from the alternatives, the most held first; returns what it took */
function takeFrom (inv: Inventory, alts: readonly string[], count: number): ItemCount[] {
  const out: ItemCount[] = []
  let left = count
  const held = alts.map(name => ({ name, count: inv.count(name) })).filter(h => h.count > 0).sort((a, b) => b.count - a.count)
  for (const h of held) {
    if (left <= 0) break
    const take = Math.min(h.count, left)
    inv.remove(h.name, take)
    out.push({ name: h.name, count: take })
    left -= take
  }
  if (left > 0) throw new Error(`planner bug: ${left} of [${alts.join(', ')}] missing`)
  return out
}

function extras (drops: ReadonlyArray<{ item: string, count: number }>, item: string, times: number): ItemCount[] {
  return drops
    .filter(d => d.item !== item)
    .map(d => ({ name: d.item, count: Math.floor(d.count * times) }))
    .filter(d => d.count > 0)
}

function sameItems (a: readonly ItemCount[], b: readonly ItemCount[]): boolean {
  const names = (l: readonly ItemCount[]): string => l.map(i => i.name).sort().join(',')
  return names(a) === names(b)
}

function addItems (a: readonly ItemCount[], b: readonly ItemCount[]): ItemCount[] {
  const out = a.map(i => ({ ...i }))
  for (const i of b) {
    const same = out.find(o => o.name === i.name)
    if (same != null) same.count += i.count
    else out.push({ ...i })
  }
  return out
}

/** `into` with `step` added to it, if they are the same craft (or smelt) */
function mergeInto (into: PlanStep, step: PlanStep): PlanStep | null {
  if (into.kind === 'craft' && step.kind === 'craft') {
    if (into.recipe !== step.recipe || !sameItems(into.ingredients, step.ingredients)) return null
    return { ...into, count: into.count + step.count, crafts: into.crafts + step.crafts, ingredients: addItems(into.ingredients, step.ingredients), cost: into.cost + step.cost }
  }
  if (into.kind === 'smelt' && step.kind === 'smelt') {
    if (into.item !== step.item || into.input !== step.input) return null
    return { ...into, count: into.count + step.count, inputs: addItems(into.inputs, step.inputs), fuel: addItems(into.fuel, step.fuel), cost: into.cost + step.cost }
  }
  return null
}

/**
 * Folds every later mine or kill step into the first one for the same block or mob and
 * item: getting the items earlier never breaks a later step, and it saves the trips.
 */
export function mergeSteps (steps: readonly PlanStep[]): PlanStep[] {
  const out: PlanStep[] = []
  for (const step of steps) {
    if (step.kind === 'mine' || step.kind === 'kill') {
      const i = out.findIndex(o =>
        o.kind === step.kind && o.item === step.item && o.dimension === step.dimension &&
        // the earlier step's tool harvests the block too: it was checked there
        (o.kind === 'mine' && step.kind === 'mine' ? o.block === step.block : o.kind === 'kill' && step.kind === 'kill' && o.mob === step.mob))
      if (i >= 0) {
        const o = out[i]
        const extra = addItems(o.extra ?? [], step.extra ?? [])
        if (o.kind === 'mine' && step.kind === 'mine') {
          out[i] = { ...o, count: o.count + step.count, blockCount: o.blockCount + step.blockCount, cost: o.cost + step.cost, ...(extra.length > 0 ? { extra } : {}) }
        } else if (o.kind === 'kill' && step.kind === 'kill') {
          out[i] = { ...o, count: o.count + step.count, kills: o.kills + step.kills, cost: o.cost + step.cost, ...(extra.length > 0 ? { extra } : {}) }
        }
        continue
      }
    }
    out.push(step)
  }
  return out
}

/** plans `count` of an item (a name, `#tag` or alternatives) from the options' inventory */
export function obtain (registry: RegistryLike, item: string | readonly string[], count: number, opts: ObtainOptions = {}): ObtainPlan {
  return new Resolver(registry, opts).obtain(item, count)
}

/** plans several requests into one plan */
export function obtainAll (registry: RegistryLike, requests: readonly ObtainRequest[], opts: ObtainOptions = {}): ObtainPlan {
  return new Resolver(registry, opts).obtainAll(requests)
}
