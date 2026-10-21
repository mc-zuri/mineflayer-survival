import { test } from 'node:test'
import assert from 'node:assert/strict'
import minecraftData from 'minecraft-data'
import type { RegistryLike } from '../../src/core/registry'
import { WorldMemory } from '../../src/core/memory'
import { obtain, obtainAll, Resolver } from '../../src/planner/obtain'
import { checkPlan, type PlanStep, type MineStep, type CraftStep, type SmeltStep, type KillStep } from '../../src/planner/steps'
import { recipesFor } from '../../src/planner/recipes'
import { BLOCK_SOURCES, MOB_SOURCES, SMELTING, WALK_TICKS_PER_BLOCK } from '../../src/planner/sources'
import { burnTicks } from '../../src/core/items'

const registry: RegistryLike = minecraftData('1.21.11')

const mines = (steps: PlanStep[], item: string): MineStep[] => steps.filter((s): s is MineStep => s.kind === 'mine' && s.item === item)
const crafts = (steps: PlanStep[], item: string): CraftStep[] => steps.filter((s): s is CraftStep => s.kind === 'craft' && s.item === item)
const smelts = (steps: PlanStep[]): SmeltStep[] => steps.filter((s): s is SmeltStep => s.kind === 'smelt')
const kills = (steps: PlanStep[], mob: string): KillStep[] => steps.filter((s): s is KillStep => s.kind === 'kill' && s.mob === mob)
const total = (steps: Array<{ count: number }>): number => steps.reduce((n, s) => n + s.count, 0)
const indexOf = (steps: PlanStep[], pred: (s: PlanStep) => boolean): number => {
  const i = steps.findIndex(pred)
  assert.ok(i >= 0, 'step not in plan')
  return i
}

test('diamond_pickaxe from an empty inventory: wood, table, wooden pickaxe, cobblestone, stone pickaxe, iron, diamonds', () => {
  const plan = obtain(registry, 'diamond_pickaxe', 1)
  assert.equal(plan.ok, true)
  const { steps } = plan
  const check = checkPlan(registry, steps, {})
  assert.equal(check.ok, true, check.error?.reason)
  assert.equal(plan.inventory.count('diamond_pickaxe'), 1)

  // counts: 4 logs make the 16 planks (table 4, sticks 4, wooden pickaxe 3, fuel 2, 3 spare)
  assert.equal(total(mines(steps, 'oak_log')), 4)
  assert.equal(total(crafts(steps, 'crafting_table')), 1)
  assert.equal(total(crafts(steps, 'furnace')), 1)
  assert.equal(total(crafts(steps, 'stick')), 8)
  assert.equal(total(mines(steps, 'cobblestone')), 11) // furnace 8 + stone pickaxe 3
  assert.equal(total(mines(steps, 'raw_iron')), 3)
  assert.equal(total(mines(steps, 'diamond')), 3)
  assert.equal(total(smelts(steps)), 3)
  for (const tool of ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe']) assert.equal(total(crafts(steps, tool)), 1, tool)
  assert.equal(steps.filter(s => s.kind === 'kill' || s.kind === 'barter' || s.kind === 'loot').length, 0)

  // tools: each mine step uses the tier its block needs
  assert.equal(mines(steps, 'oak_log')[0].tool, null)
  assert.equal(mines(steps, 'cobblestone')[0].tool, 'wooden_pickaxe')
  assert.equal(mines(steps, 'raw_iron')[0].tool, 'stone_pickaxe')
  assert.deepEqual(mines(steps, 'raw_iron')[0].blocks.sort(), ['deepslate_iron_ore', 'iron_ore'])
  assert.equal(mines(steps, 'diamond')[0].tool, 'iron_pickaxe')

  // order
  const order = [
    indexOf(steps, s => s.kind === 'mine' && s.item === 'oak_log'),
    indexOf(steps, s => s.kind === 'craft' && s.item === 'crafting_table'),
    indexOf(steps, s => s.kind === 'craft' && s.item === 'wooden_pickaxe'),
    indexOf(steps, s => s.kind === 'mine' && s.item === 'cobblestone'),
    indexOf(steps, s => s.kind === 'craft' && s.item === 'stone_pickaxe'),
    indexOf(steps, s => s.kind === 'mine' && s.item === 'raw_iron'),
    indexOf(steps, s => s.kind === 'smelt' && s.item === 'iron_ingot'),
    indexOf(steps, s => s.kind === 'craft' && s.item === 'iron_pickaxe'),
    indexOf(steps, s => s.kind === 'mine' && s.item === 'diamond'),
    indexOf(steps, s => s.kind === 'craft' && s.item === 'diamond_pickaxe')
  ]
  assert.deepEqual(order, [...order].sort((a, b) => a - b))
  assert.ok(indexOf(steps, s => s.kind === 'craft' && s.item === 'furnace') < order[6])
  assert.equal(order[9], steps.length - 1)

  // the smelt has its fuel, and the planks are crafted in one go
  const smelt = smelts(steps)[0]
  assert.equal(smelt.input, 'raw_iron')
  assert.ok(smelt.fuel.reduce((n, f) => n + burnTicks(f.name) * f.count, 0) >= 3 * 200)
  assert.equal(crafts(steps, 'oak_planks').length, 1)
})

test('from an inventory that has the parts, the plan is short', () => {
  const ready = obtain(registry, 'diamond_pickaxe', 1, { inventory: { diamond: 3, stick: 2, crafting_table: 1 } })
  assert.deepEqual(ready.steps.map(s => `${s.kind} ${s.item}`), ['craft diamond_pickaxe'])

  // a table at the base counts like one in the inventory
  const atBase = obtain(registry, 'diamond_pickaxe', 1, { inventory: { diamond: 3, stick: 2 }, stations: ['crafting_table'] })
  assert.deepEqual(atBase.steps.map(s => `${s.kind} ${s.item}`), ['craft diamond_pickaxe'])

  // with an iron pickaxe and some logs: mine the diamonds, make sticks; no lower tiers, no furnace
  const midGame = obtain(registry, 'diamond_pickaxe', 1, { inventory: { iron_pickaxe: 1, crafting_table: 1, birch_log: 2 } })
  assert.equal(midGame.ok, true)
  assert.equal(checkPlan(registry, midGame.steps, { iron_pickaxe: 1, crafting_table: 1, birch_log: 2 }).ok, true)
  assert.deepEqual(midGame.steps.map(s => `${s.kind} ${s.item}`), ['mine diamond', 'craft birch_planks', 'craft stick', 'craft diamond_pickaxe'])

  assert.deepEqual(obtain(registry, 'diamond_pickaxe', 1, { inventory: { diamond_pickaxe: 1 } }).steps, [])
})

test('ender_eye pulls in blaze_powder from blaze rods (kill blazes in the nether) and ender pearls', () => {
  const plan = obtain(registry, 'ender_eye', 12)
  assert.equal(plan.ok, true)
  assert.equal(checkPlan(registry, plan.steps, {}).ok, true)
  const blaze = kills(plan.steps, 'blaze')
  assert.equal(blaze.length, 1)
  assert.equal(blaze[0].item, 'blaze_rod')
  assert.equal(blaze[0].count, 6) // 2 powder per rod
  assert.equal(blaze[0].kills, 12) // a blaze drops 0-1 rods
  assert.equal(blaze[0].dimension, 'the_nether')
  assert.equal(total(crafts(plan.steps, 'blaze_powder')), 12)
  const pearls = plan.steps.filter(s => s.item === 'ender_pearl')
  assert.equal(total(pearls), 12)
  assert.equal(crafts(plan.steps, 'ender_eye')[0].count, 12)
  assert.equal(plan.steps[plan.steps.length - 1].item, 'ender_eye')

  // with the rods and pearls held it is two crafts
  const held = obtain(registry, 'ender_eye', 12, { inventory: { blaze_rod: 6, ender_pearl: 12 } })
  assert.deepEqual(held.steps.map(s => `${s.kind} ${s.item} ${s.count}`), ['craft blaze_powder 12', 'craft ender_eye 12'])

  // no killing: pearls by bartering gold with piglins, wearing gold armor; rods have no other source
  const pearlsOnly = obtain(registry, 'ender_pearl', 2, { inventory: { gold_ingot: 40, golden_boots: 1 }, exclude: ['kill'] })
  assert.deepEqual(pearlsOnly.steps.map(s => s.kind), ['barter'])
  assert.equal(checkPlan(registry, pearlsOnly.steps, { gold_ingot: 40, golden_boots: 1 }).ok, true)
  assert.equal(obtain(registry, 'blaze_rod', 1, { exclude: ['kill'] }).ok, false)
})

test('fuel choice: no coal wasted on one item, coal for a full load, never the blaze rods, planks before logs', () => {
  const fuelOf = (inventory: Record<string, number>, n: number, opts = {}): string[] => {
    const plan = obtain(registry, 'iron_ingot', n, { inventory: { furnace: 1, raw_iron: n, ...inventory }, ...opts })
    assert.equal(plan.ok, true)
    assert.equal(checkPlan(registry, plan.steps, { furnace: 1, raw_iron: n, ...inventory }).ok, true)
    return smelts(plan.steps).flatMap(s => s.fuel.map(f => `${f.count} ${f.name}`))
  }
  assert.deepEqual(fuelOf({ coal: 2, oak_planks: 10 }, 8), ['1 coal'])
  assert.deepEqual(fuelOf({ coal: 2, oak_planks: 10 }, 1), ['1 oak_planks'])
  assert.deepEqual(fuelOf({ charcoal: 1, oak_planks: 1 }, 9), ['1 charcoal', '1 oak_planks'])
  // blaze rods are kept; the planks come from a log
  const kept = obtain(registry, 'iron_ingot', 1, { inventory: { furnace: 1, raw_iron: 1, blaze_rod: 3 } })
  assert.ok(!smelts(kept.steps)[0].fuel.some(f => f.name === 'blaze_rod'))
  assert.equal(kept.inventory.count('blaze_rod'), 3)
  // a log is worth four planks of burning: craft them rather than burn logs
  const charcoal = obtain(registry, 'charcoal', 4, { inventory: { furnace: 1, oak_log: 8 } })
  assert.deepEqual(charcoal.steps.map(s => `${s.kind} ${s.item}`), ['craft oak_planks', 'smelt charcoal'])
  assert.equal(smelts(charcoal.steps)[0].fuel[0].name, 'oak_planks')
  // a coal vein remembered next to the bot makes coal the cheaper fuel for a big load
  const memory = new WorldMemory()
  memory.rememberBlock('coal_ore', { x: 3, y: 60, z: 0 })
  const withVein = obtain(registry, 'iron_ingot', 32, { inventory: { furnace: 1, raw_iron: 32, wooden_pickaxe: 1 }, memory, position: { x: 0, y: 60, z: 0 } })
  assert.equal(mines(withVein.steps, 'coal').length, 1)
  assert.deepEqual(smelts(withVein.steps)[0].fuel, [{ name: 'coal', count: 4 }])
})

test('the last ingots of a bucket are smelted, not crafted back from the nuggets the held ingots make (seeds 2 and 5)', () => {
  // two ingots held: the third came out of a craft of 9 nuggets from one of them, which leaves two, and meet gave up
  for (const inventory of [{ iron_pickaxe: 1, furnace: 1, crafting_table: 1, iron_ingot: 2 }, { iron_pickaxe: 1, furnace: 1, crafting_table: 1, iron_ingot: 2, raw_iron: 1 }]) {
    const plan = obtain(registry, ['bucket', 'water_bucket', 'lava_bucket'], 1, { inventory })
    assert.equal(plan.ok, true, JSON.stringify(inventory))
    assert.equal(checkPlan(registry, plan.steps, inventory).ok, true)
    assert.equal(crafts(plan.steps, 'iron_nugget').length, 0)
    assert.equal(total(smelts(plan.steps)), 1)
    assert.equal(plan.inventory.count('bucket'), 1)
  }
  // the same for any count held short of the recipe: an ingot is never planned out of the ingots it takes
  for (let held = 1; held < 9; held++) {
    const plan = obtain(registry, 'iron_ingot', held + 1, { inventory: { iron_pickaxe: 1, furnace: 1, crafting_table: 1, iron_ingot: held } })
    assert.equal(plan.ok, true)
    assert.equal(crafts(plan.steps, 'iron_ingot').length, 0, `${held} held`)
    assert.equal(plan.inventory.count('iron_ingot'), held + 1)
  }
  // nothing to burn held: the fuel is got (a log cut into planks), not the smelt priced out
  const noFuel = obtain(registry, 'bucket', 1, { inventory: { iron_pickaxe: 1, furnace: 1, crafting_table: 1, raw_iron: 3 } })
  assert.equal(noFuel.ok, true)
  assert.ok(smelts(noFuel.steps)[0].fuel.length > 0)
  assert.ok(noFuel.steps.some(s => s.kind === 'mine' && s.item.endsWith('_log')))
})

test('tag groups and alternatives: any planks, any stone material, any pickaxe that will do', () => {
  const planks = obtain(registry, '#planks', 4, { inventory: { birch_log: 1 } })
  assert.deepEqual(planks.steps.map(s => `${s.kind} ${s.item}`), ['craft birch_planks'])
  assert.equal(planks.inventory.count('#planks'), 4)

  // a stripped log makes planks of its wood (#oak_logs)
  const stripped = obtain(registry, 'oak_planks', 4, { inventory: { stripped_oak_wood: 1 } })
  assert.deepEqual((stripped.steps[0] as CraftStep).ingredients, [{ name: 'stripped_oak_wood', count: 1 }])

  // blackstone is a stone tool material
  const pick = obtain(registry, 'stone_pickaxe', 1, { inventory: { blackstone: 3, stick: 2, crafting_table: 1 } })
  assert.deepEqual((pick.steps[0] as CraftStep).ingredients, [{ name: 'blackstone', count: 3 }, { name: 'stick', count: 2 }])

  // a better pickaxe already satisfies "stone pickaxe or better"
  const better = obtain(registry, ['stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe'], 1, { inventory: { iron_pickaxe: 1 } })
  assert.deepEqual(better.steps, [])

  // cooked food: any member will do, the cheapest is made
  const food = obtain(registry, '#cooked_food', 3, { inventory: { furnace: 1, oak_planks: 4 } })
  assert.equal(food.ok, true)
  assert.equal(food.inventory.count('#cooked_food'), 3)
})

test('tool tiers gate the mine steps: obsidian needs a diamond pickaxe', () => {
  const plan = obtain(registry, 'obsidian', 4, { inventory: { iron_pickaxe: 1, diamond: 3, stick: 2, crafting_table: 1 } })
  assert.deepEqual(plan.steps.map(s => `${s.kind} ${s.item}`), ['craft diamond_pickaxe', 'mine obsidian'])
  assert.equal((plan.steps[1] as MineStep).tool, 'diamond_pickaxe')
  const r = new Resolver(registry)
  // vanilla BlockBehaviour.getDestroyProgress: 1.5 hardness stone, wooden pickaxe speed 2 → 23 ticks, by hand 150
  assert.equal(r.digTicks('stone', 'wooden_pickaxe'), 23)
  assert.equal(r.digTicks('stone', null), 150)
  assert.equal(r.digTicks('obsidian', 'diamond_pickaxe'), 188)
  assert.equal(r.digTicks('oak_log', null), 60)
  assert.equal(r.digTicks('oak_log', 'stone_axe'), 15)
  assert.equal(r.digTicks('bedrock', 'netherite_pickaxe'), Infinity)
})

test('remembered chests are looted before anything is made', () => {
  const memory = new WorldMemory()
  memory.rememberChest({ x: 10, y: 64, z: 0 }, { diamond: 2 })
  const plan = obtain(registry, 'diamond', 3, { inventory: { iron_pickaxe: 1 }, memory, position: { x: 0, y: 64, z: 0 } })
  assert.deepEqual(plan.steps.map(s => `${s.kind} ${s.item} ${s.count}`), ['loot diamond 2', 'mine diamond 1'])
})

test('a chest opened more than CHEST_TRUST_TICKS ago is less sure: its walk counted STALE_LOOT_FACTOR times, a chest opened lately looted first', async () => {
  const { CHEST_TRUST_TICKS, STALE_LOOT_FACTOR } = await import('../../src/planner/obtain')
  const memory = new WorldMemory()
  memory.now = 1000
  memory.rememberChest({ x: 100, y: 64, z: 0 }, { diamond_pickaxe: 1 })
  const at = { inventory: { iron_pickaxe: 1 }, memory, position: { x: 0, y: 64, z: 0 } }
  const fresh = obtain(registry, 'diamond_pickaxe', 1, at)
  assert.deepEqual(fresh.steps.map(s => s.kind), ['loot'])
  memory.now = 1000 + CHEST_TRUST_TICKS + 1
  const stale = obtain(registry, 'diamond_pickaxe', 1, at)
  assert.deepEqual(stale.steps.map(s => s.kind), ['loot'])
  // the walk's 100 blocks counted twice over, the rest the same
  assert.equal((stale.steps[0] as any).cost - (fresh.steps[0] as any).cost, (STALE_LOOT_FACTOR - 1) * Math.ceil(100 * WALK_TICKS_PER_BLOCK))
  // a chest opened since, with fewer of them, goes first
  memory.rememberChest({ x: 120, y: 64, z: 0 }, { diamond: 2 })
  memory.now += 10
  memory.rememberChest({ x: 0, y: 64, z: 80 }, { diamond: 1 })
  memory.now += 10
  memory.chestAt({ x: 120, y: 64, z: 0 })!.seen = 0
  const both = obtain(registry, 'diamond', 1, at)
  assert.deepEqual(both.steps.map(s => `${s.kind} ${(s as any).from?.z}`), ['loot 80'])
})

test('obtainAll plans milestone goals into one plan that leaves all of them held', () => {
  const plan = obtainAll(registry, [
    { item: 'cobblestone', count: 16 },
    { item: 'furnace', count: 1 },
    { item: ['stone_pickaxe', 'iron_pickaxe'], count: 1 },
    { item: 'bedrock', count: 1, optional: true }
  ], { inventory: { wooden_pickaxe: 1, crafting_table: 1, stick: 2 } })
  assert.equal(plan.ok, true)
  assert.equal(plan.inventory.count('cobblestone') >= 16, true)
  assert.equal(plan.inventory.count('furnace'), 1)
  assert.equal(plan.inventory.count('stone_pickaxe'), 1)
  // the cobblestone the furnace and pickaxe used up is mined in the same trip
  assert.deepEqual(mines(plan.steps, 'cobblestone').map(s => s.count), [27])
  assert.deepEqual(plan.unresolved.map(r => r.item), ['bedrock'])

  const impossible = obtainAll(registry, [{ item: 'bedrock', count: 1 }, { item: 'stick', count: 4, optional: true }])
  assert.equal(impossible.ok, false)
  assert.deepEqual(impossible.unresolved.map(r => r.item), ['bedrock'])
})

test('checkPlan finds a step whose tool or ingredients are not there yet', () => {
  const plan = obtain(registry, 'stone_pickaxe', 1)
  assert.equal(checkPlan(registry, plan.steps, {}).ok, true)
  const i = plan.steps.findIndex(s => s.kind === 'mine' && s.item === 'cobblestone')
  const swapped = [plan.steps[i], ...plan.steps.slice(0, i), ...plan.steps.slice(i + 1)]
  const bad = checkPlan(registry, swapped, {})
  assert.equal(bad.ok, false)
  assert.equal(bad.error?.index, 0)
  assert.match(bad.error?.reason ?? '', /harvest stone/)
})

test('crafting recipes: one recipe per tag member merged back into tag ingredients', () => {
  const table = recipesFor(registry, 'crafting_table')
  assert.equal(table.length, 1)
  assert.equal(table[0].ingredients[0].items.length, 12)
  assert.equal(table[0].table, false)
  assert.deepEqual([...recipesFor(registry, 'torch')[0].ingredients[0].items].sort(), ['charcoal', 'coal'])
  assert.equal(recipesFor(registry, 'furnace')[0].ingredients[0].items.length, 3)
  assert.equal(recipesFor(registry, 'oak_planks')[0].ingredients[0].items.length, 4)
  assert.equal(recipesFor(registry, 'iron_pickaxe')[0].table, true)
  // a white bed needs white wool, not any wool
  assert.deepEqual(recipesFor(registry, 'white_bed')[0].ingredients.find(i => i.items.includes('white_wool'))?.items, ['white_wool'])
})

test('every source names blocks and items of the 1.21.11 registry (but the poplar of 26.3)', () => {
  for (const b of BLOCK_SOURCES) {
    if (b.block === 'poplar_log') continue
    assert.ok(registry.blocksByName[b.block] != null, b.block)
    for (const d of b.drops) assert.ok(registry.itemsByName[d.item] != null, d.item)
  }
  for (const m of MOB_SOURCES) for (const d of m.drops) assert.ok(registry.itemsByName[d.item] != null, `${m.mob} ${d.item}`)
  for (const s of SMELTING) assert.ok(registry.itemsByName[s.output] != null, s.output)
})

test('the logs a plan burns and crafts are cut before the trip down for its ore', () => {
  const plan = obtainAll(registry, [{ item: 'iron_pickaxe', count: 1 }, { item: 'shield', count: 1 }, { item: 'bucket', count: 1 }], { inventory: { stone_pickaxe: 1, stone_axe: 1, furnace: 1, crafting_table: 1 } })
  assert.equal(plan.ok, true)
  assert.equal(checkPlan(registry, plan.steps, { stone_pickaxe: 1, stone_axe: 1, furnace: 1, crafting_table: 1 }).ok, true)
  const logs = indexOf(plan.steps, s => s.kind === 'mine' && s.item.endsWith('_log'))
  const iron = indexOf(plan.steps, s => s.kind === 'mine' && s.item === 'raw_iron')
  assert.ok(logs < iron, plan.steps.map(s => `${s.kind} ${s.item}`).join(', '))
  // the wood for the first pickaxe still comes before the stone it mines
  const fresh = obtain(registry, 'stone_pickaxe', 1)
  assert.equal(checkPlan(registry, fresh.steps, {}).ok, true)
})

test('a plan counts what its kills and blocks drop beyond the count wanted as its check does: the second beef of a cow, the rest of an ore\'s redstone', () => {
  // 26.3 seed 2: a cooked beef wanted, then 5 in all: the first cow's second beef was planned on for the 4 more, and
  // the check of every one of 30 plans found "smelt 4 cooked_beef needs 4 beef, has 3"
  const food = { furnace: 1, coal: 8, stone_sword: 1 }
  const beef = obtainAll(registry, [{ item: 'cooked_beef', count: 1 }, { item: 'cooked_beef', count: 5 }], { inventory: food })
  assert.equal(beef.ok, true)
  const check = checkPlan(registry, beef.steps, food)
  assert.equal(check.ok, true, check.error?.reason)
  assert.equal(total(kills(beef.steps, 'cow')), 4)
  assert.equal(kills(beef.steps, 'cow').reduce((n, s) => n + s.kills, 0), 3)
  assert.deepEqual(kills(beef.steps, 'cow')[0].extra?.find(e => e.name === 'beef'), { name: 'beef', count: 2 })
  assert.equal(check.inventory.count('cooked_beef'), 5)
  assert.equal(check.inventory.count('beef'), beef.inventory.count('beef'))

  const ore = { iron_pickaxe: 1 }
  const redstone = obtainAll(registry, [{ item: 'redstone', count: 3 }, { item: 'redstone', count: 9 }], { inventory: ore })
  assert.equal(redstone.ok, true)
  const oreCheck = checkPlan(registry, redstone.steps, ore)
  assert.equal(oreCheck.ok, true, oreCheck.error?.reason)
  assert.equal(oreCheck.inventory.count('redstone'), redstone.inventory.count('redstone'))
})

test('a kill of the herd\'s kind takes its surplus first, a walk to the pen, then its calves once grown, then wild ones; the breeders never', async () => {
  const { HERD_EACH_TICKS } = await import('../../src/planner/obtain')
  const cow = MOB_SOURCES.find(m => m.mob === 'cow') as typeof MOB_SOURCES[number]
  const fight = 105
  const supply = (surplus: number, growing = 0, growTicks = 0) => (mob: string) => mob === 'cow' ? { surplus, growing, growTicks, distance: 10 } : undefined
  // 2 kills for 4 beef, the herd's two surplus cows 10 blocks off
  const herd = obtain(registry, 'beef', 4, { herd: supply(2) })
  assert.equal(kills(herd.steps, 'cow')[0].cost, 10 * WALK_TICKS_PER_BLOCK + HERD_EACH_TICKS + 2 * fight)
  const wild = obtain(registry, 'beef', 4)
  assert.equal(kills(wild.steps, 'cow')[0].cost, cow.find + cow.each + 2 * fight)
  // 4 kills, 2 from the herd and 2 wild
  assert.equal(kills(obtain(registry, 'beef', 8, { herd: supply(2) }).steps, 'cow')[0].cost, 10 * WALK_TICKS_PER_BLOCK + HERD_EACH_TICKS + cow.find + cow.each + 4 * fight)
  // no surplus, a calf 3000 ticks from grown: its growing waited, cheaper than a wild one only when it's near grown
  assert.equal(kills(obtain(registry, 'beef', 2, { herd: supply(0, 1, 300) }).steps, 'cow')[0].cost, 10 * WALK_TICKS_PER_BLOCK + 300 + fight)
  // the two of a plan's kill steps for the herd don't take its one surplus cow twice
  const both = obtainAll(registry, [{ item: 'beef', count: 2 }, { item: 'leather', count: 3 }], { herd: supply(1) })
  const cost = kills(both.steps, 'cow').reduce((n, s) => n + s.cost, 0)
  // (the one from the herd, the two more wild: the cows found by then, each the source's next)
  assert.equal(cost, 10 * WALK_TICKS_PER_BLOCK + fight + 2 * cow.each + 2 * fight)
})

test('the food points come from the herd\'s surplus cows, cooked, over a hunt for wild animals', () => {
  const inventory = { furnace: 1, coal: 8, stone_sword: 1 }
  const food = obtainAll(registry, [{ item: ['cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'bread'], count: 32, unit: 'nutrition' }], { inventory, herd: mob => mob === 'cow' ? { surplus: 3, growing: 0, growTicks: 0, distance: 12 } : undefined })
  assert.equal(food.ok, true)
  assert.ok(kills(food.steps, 'cow').length > 0, food.steps.map(s => `${s.kind} ${s.item}`).join(', '))
  const plain = obtainAll(registry, [{ item: ['cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'bread'], count: 32, unit: 'nutrition' }], { inventory })
  assert.ok(food.cost < plain.cost - 300, `${food.cost} vs ${plain.cost}`)
})

test('a bow\'s string from the cobwebs remembered near (a mineshaft\'s), broken with the sword; unseen, the spiders first; underground too (the night\'s mine)', () => {
  const memory = new WorldMemory()
  const inventory = { iron_sword: 1, stick: 3, crafting_table: 1 }
  const far = obtain(registry, 'bow', 1, { inventory })
  assert.equal(far.ok, true)
  assert.equal(kills(far.steps, 'spider').length, 1)
  assert.equal(mines(far.steps, 'string').length, 0)
  for (let i = 0; i < 4; i++) memory.rememberBlock('cobweb', { x: 6 + i, y: 30, z: 0 })
  const near = obtain(registry, 'bow', 1, { inventory, memory, position: { x: 0, y: 30, z: 0 } })
  assert.equal(near.ok, true)
  const webs = mines(near.steps, 'string')
  assert.equal(webs.length, 1)
  assert.equal(webs[0].block, 'cobweb')
  assert.equal(kills(near.steps, 'spider').length, 0)
  assert.equal(crafts(near.steps, 'bow').length, 1)
  // the night's mine (undergroundOnly): cobwebs are a mine's
  const night = obtain(registry, 'string', 3, { inventory, memory, position: { x: 0, y: 30, z: 0 }, undergroundOnly: true })
  assert.equal(night.ok, true)
  assert.equal(mines(night.steps, 'string')[0]?.block, 'cobweb')
})

test('a bot not fit for the caves (caves: false) plans no cobweb, even remembered near: the bow\'s string from spiders, the bed\'s wool from sheep, the nether\'s arrows as before', () => {
  const memory = new WorldMemory()
  for (let i = 0; i < 12; i++) memory.rememberBlock('cobweb', { x: 6 + i, y: 30, z: 0 })
  const inventory = { iron_sword: 1, stick: 3, crafting_table: 1 }
  const at = { x: 0, y: 30, z: 0 }
  const bow = obtain(registry, 'bow', 1, { inventory, memory, position: at, caves: false })
  assert.equal(bow.ok, true)
  assert.equal(mines(bow.steps, 'string').length, 0)
  assert.equal(kills(bow.steps, 'spider').length, 1)
  const wool = obtain(registry, 'white_wool', 3, { inventory, memory, position: at, caves: false })
  assert.equal(wool.ok, true)
  assert.equal(mines(wool.steps, 'string').length, 0)
  assert.ok(wool.steps.some(s => s.kind === 'kill'), wool.steps.map(s => `${s.kind} ${s.item}`).join(', '))
  // (the cobwebs near are the cheapest string for one fit for the caves)
  assert.equal(mines(obtain(registry, 'white_wool', 3, { inventory, memory, position: at }).steps, 'string').length, 1)
  // the night's mine (undergroundOnly) has no string to plan then
  assert.equal(obtain(registry, 'string', 3, { inventory, memory, position: at, undergroundOnly: true, caves: false }).ok, false)
  const arrows = obtain(registry, 'arrow', 32, { inventory, memory, position: at, caves: false })
  assert.equal(arrows.ok, true)
  assert.deepEqual(arrows.steps.filter(s => s.kind === 'mine' || s.kind === 'kill').map(s => `${s.kind} ${(s as any).block ?? (s as any).mob}`).sort(), [...new Set(obtain(registry, 'arrow', 32, { inventory, memory, position: at }).steps.filter(s => s.kind === 'mine' || s.kind === 'kill').map(s => `${s.kind} ${(s as any).block ?? (s as any).mob}`))].sort())
})

test('uncraftable: a recipe\'s ingredients the craft skill makes none of its result from are left out of it (the executor\'s), the rest of its alternatives or another source used', () => {
  const held = { oak_wood: 4, oak_log: 1 }
  const ofWood = (steps: PlanStep[]): boolean => crafts(steps, 'oak_planks').some(s => s.ingredients.some(i => i.name === 'oak_wood'))
  assert.equal(ofWood(obtain(registry, 'oak_planks', 8, { inventory: held }).steps), true)
  const plan = obtain(registry, 'oak_planks', 8, { inventory: held, uncraftable: { oak_planks: ['oak_wood'] } })
  assert.equal(plan.ok, true)
  assert.equal(ofWood(plan.steps), false)
  assert.equal(total(mines(plan.steps, 'oak_log')), 1)
  assert.equal(plan.inventory.count('oak_wood'), 4)
  // none of the oak's alternatives left: the oak_planks are no craft at all
  const none = obtain(registry, 'oak_planks', 4, { inventory: held, uncraftable: { oak_planks: ['oak_log', 'oak_wood', 'stripped_oak_log', 'stripped_oak_wood'] } })
  assert.equal(none.ok, false)
  // and the other planks are made as before
  assert.equal(obtain(registry, 'birch_planks', 4, { uncraftable: { oak_planks: ['oak_log'] } }).ok, true)
})
