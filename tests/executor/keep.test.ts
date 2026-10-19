import { test } from 'node:test'
import assert from 'node:assert/strict'
import minecraftData from 'minecraft-data'
import { defaultKeep, isValuable, junkToToss, splitInventory, THROW_LOOP_REPEATS, THROW_LOOP_TICKS, ThrowHistory, tossValue } from '../../src/executor/keep'
import { VERSIONS } from '../versions'

for (const version of VERSIONS) {
  test(`the default keep rule keeps the safe foods of ${version}'s registry, not the fish buckets`, () => {
    const registry = minecraftData(version)
    assert.equal(defaultKeep('cooked_beef', registry), Infinity)
    assert.equal(defaultKeep('bread', registry), Infinity)
    assert.equal(defaultKeep('rotten_flesh', registry), null)
    assert.equal(defaultKeep('cod_bucket', registry), null)
  })
}

test('the default keep rule: tools, armor and food all, a stack of cobblestone and torches, the rest stored', () => {
  const registry = minecraftData('1.21.11')
  assert.equal(defaultKeep('iron_pickaxe'), Infinity)
  assert.equal(defaultKeep('iron_chestplate'), Infinity)
  assert.equal(defaultKeep('cooked_beef', registry), Infinity)
  assert.equal(defaultKeep('rotten_flesh', registry), null)
  assert.equal(defaultKeep('cobblestone'), 64)
  assert.equal(defaultKeep('white_bed'), 1)
  assert.equal(defaultKeep('raw_iron'), null)
  const { keep, store } = splitInventory([
    { name: 'cobblestone', count: 64 }, { name: 'cobblestone', count: 40 }, { name: 'raw_iron', count: 12 },
    { name: 'stone_pickaxe', count: 1 }, { name: 'bread', count: 5 }, { name: 'diamond', count: 3 }
  ], { needed: { diamond: 2 }, registry })
  const rec = (l: Array<{ name: string, count: number }>): Record<string, number> => Object.fromEntries(l.map(i => [i.name, i.count]))
  assert.deepEqual(rec(keep), { cobblestone: 64, stone_pickaxe: 1, bread: 5, diamond: 2 })
  assert.deepEqual(rec(store), { cobblestone: 40, raw_iron: 12, diamond: 1 })
})

test('junkToToss frees whole slots of junk, never what is kept or needed', () => {
  const stacks = [
    { name: 'dirt', count: 64 }, { name: 'dirt', count: 12 }, { name: 'gravel', count: 30 }, { name: 'cobblestone', count: 64 },
    { name: 'cobblestone', count: 64 }, { name: 'wheat_seeds', count: 3 }, { name: 'raw_iron', count: 9 }
  ]
  assert.deepEqual(junkToToss(stacks, 2), [{ name: 'dirt', count: 64 }, { name: 'dirt', count: 12 }])
  // gravel the plan needs (flint) stays
  assert.deepEqual(junkToToss(stacks, 4, { needed: { gravel: 10 } }), [{ name: 'dirt', count: 64 }, { name: 'dirt', count: 12 }, { name: 'wheat_seeds', count: 3 }])
  // with `anything`, what storing would take goes too, the least worth first: the cobblestone over a stack before the
  // seeds; never the raw iron (an ore's)
  const all = junkToToss(stacks, 6, { anything: true })
  assert.deepEqual(all, [{ name: 'dirt', count: 64 }, { name: 'dirt', count: 12 }, { name: 'gravel', count: 30 }, { name: 'cobblestone', count: 64 }, { name: 'wheat_seeds', count: 3 }])
})

test('junkToToss never throws a valuable, a station, gear or an enchanted stack, even with `anything` and no room', () => {
  // (26.3 enchant run u: a forced room threw an enchanting table and a diamond away, and the gear's enchanting failed
  // at "can't craft 1 enchanting_table")
  const registry = minecraftData('1.21.11')
  const stacks = [
    { name: 'enchanting_table', count: 1 }, { name: 'anvil', count: 1 }, { name: 'diamond', count: 1 }, { name: 'crafting_table', count: 1 },
    { name: 'furnace', count: 1 }, { name: 'chest', count: 1 }, { name: 'white_bed', count: 1 }, { name: 'iron_ingot', count: 40 },
    { name: 'raw_gold', count: 5 }, { name: 'deepslate_diamond_ore', count: 1 }, { name: 'lapis_lazuli', count: 32 }, { name: 'obsidian', count: 4 },
    { name: 'ender_eye', count: 16 }, { name: 'book', count: 3 }, { name: 'iron_block', count: 2 }, { name: 'bookshelf', count: 12 },
    { name: 'leather', count: 39, enchanted: false }, { name: 'fishing_rod', count: 1, enchanted: true }, { name: 'rotten_flesh', count: 7 },
    { name: 'cobblestone', count: 64 }, { name: 'cobblestone', count: 61 }, { name: 'wheat_seeds', count: 32 }, { name: 'dirt', count: 20 },
    { name: 'sugar_cane', count: 64 }
  ]
  const toss = junkToToss(stacks, 30, { registry, anything: true, needed: { sugar_cane: 64 } })
  // the least worth first: the dirt, the cobblestone over its stack, the seeds and the rotten flesh, then the leather
  // the plan doesn't need; nothing else, whatever the room asked for
  assert.deepEqual(toss.map(t => t.name), ['dirt', 'cobblestone', 'wheat_seeds', 'rotten_flesh', 'leather'])
  for (const name of ['enchanting_table', 'anvil', 'diamond', 'iron_ingot', 'raw_gold', 'white_bed', 'obsidian', 'bookshelf', 'iron_block']) {
    assert.equal(isValuable(name), true, name)
    assert.equal(tossValue(name), null, name)
  }
  assert.deepEqual(['dirt', 'cobblestone', 'rotten_flesh', 'leather'].map(tossValue), [0, 1, 2, 3])
})

test('spare kit: a second pickaxe, sword and axe at the carried tier, and 20 food points, less what the chests hold', async () => {
  const { spareKitGoals, SPARE_FOOD_POINTS } = await import('../../src/executor/keep')
  const { Inventory } = await import('../../src/core/inventory')
  const { FOOD_GOAL } = await import('../../src/planner/progression')
  const registry = require('minecraft-data')('1.21.11')
  const carried = new Inventory(registry, { iron_pickaxe: 1, iron_sword: 1, stone_axe: 1, wooden_shovel: 1, cooked_beef: 5 })
  const goals = spareKitGoals(carried, {})
  assert.deepEqual(goals.map(g => g.item).slice(0, 3), [
    ['iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'],
    ['iron_sword', 'diamond_sword', 'netherite_sword'],
    ['stone_axe', 'copper_axe', 'iron_axe', 'diamond_axe', 'netherite_axe']
  ].map(alts => alts.filter(a => registry.itemsByName[a] != null)))
  assert.deepEqual(goals.map(g => g.count), [2, 2, 2, 40 + SPARE_FOOD_POINTS])
  assert.deepEqual(goals[3].item, FOOD_GOAL)
  // the chests hold a diamond pickaxe and 12 points of bread: the rest
  const rest = spareKitGoals(carried, { diamond_pickaxe: 1, bread: 2, cobblestone: 64 })
  assert.equal(rest.length, 3)
  assert.equal(rest[2].count, 40 + SPARE_FOOD_POINTS - 10)
  // wooden tools are no loss
  assert.deepEqual(spareKitGoals(new Inventory(registry, { wooden_pickaxe: 1 }), { bread: 4 }), [])
})

test('spare kit: a bucket too once one is carried, none when the chests hold one (of water or lava too)', async () => {
  const { spareKitGoals } = await import('../../src/executor/keep')
  const { Inventory } = await import('../../src/core/inventory')
  const registry = require('minecraft-data')('1.21.11')
  const carried = new Inventory(registry, { water_bucket: 1, bucket: 1, bread: 10 })
  const goals = spareKitGoals(carried, { bread: 10 })
  assert.deepEqual(goals, [{ item: ['bucket'], count: 2 }])
  assert.deepEqual(spareKitGoals(carried, { bread: 10, water_bucket: 1 }), [])
  assert.deepEqual(spareKitGoals(new Inventory(registry, { bread: 10 }), { bread: 10 }), [])
})

test('junkToToss: after the junk, what surplus names may go beyond its kept count (the stock with no base), never below it', async () => {
  const registry = minecraftData('1.21.11')
  const { StockPolicy } = await import('../../src/planner/stock')
  const { stockKeepRule } = await import('../../src/executor/keep')
  const policy = new StockPolicy()
  const stacks = [{ name: 'dirt', count: 64 }, { name: 'cobblestone', count: 64 }, { name: 'cobblestone', count: 64 }, { name: 'cobblestone', count: 64 }, { name: 'raw_iron', count: 20 }]
  const keep = stockKeepRule(policy)
  // without surplus only the junk goes
  assert.deepEqual(junkToToss(stacks, 3, { keep, registry }), [{ name: 'dirt', count: 64 }])
  const surplus = (name: string): boolean => policy.keepCount(name, registry) != null
  assert.deepEqual(junkToToss(stacks, 3, { keep, registry, surplus }), [{ name: 'dirt', count: 64 }, { name: 'cobblestone', count: 64 }, { name: 'cobblestone', count: 64 }])
})

test('junkToToss throws the leaves and leaf litter a shears\' dig picked up', () => {
  const stacks = [{ name: 'oak_leaves', count: 64 }, { name: 'leaf_litter', count: 25 }, { name: 'oak_log', count: 45 }, { name: 'leather', count: 38 }]
  const toss = junkToToss(stacks, 2)
  assert.deepEqual(toss.map(t => t.name).sort(), ['leaf_litter', 'oak_leaves'])
})

test('junkToToss: the route\'s stone over the keep count goes when `surplus` says so, and a stack of building blocks always stays (scaffold)', async () => {
  const { ROUTE_STONE } = await import('../../src/executor/keep')
  const { SCAFFOLD_ITEMS } = await import('../../src/executor/steps')
  const stacks = [
    { name: 'cobblestone', count: 64 }, { name: 'cobblestone', count: 64 }, { name: 'cobblestone', count: 64 }, { name: 'cobblestone', count: 50 },
    { name: 'andesite', count: 20 }, { name: 'raw_iron', count: 9 }
  ]
  const surplus = (name: string): boolean => ROUTE_STONE.has(name)
  const scaffold = { items: SCAFFOLD_ITEMS, keep: 64 }
  // the stock full: the andesite, then the cobblestone over a stack, the most first
  assert.deepEqual(junkToToss(stacks, 6, { surplus, scaffold }), [{ name: 'andesite', count: 20 }, { name: 'cobblestone', count: 64 }, { name: 'cobblestone', count: 64 }, { name: 'cobblestone', count: 50 }])
  // the stock short of its high mark: only the junk
  assert.deepEqual(junkToToss(stacks, 6, { surplus: () => false, scaffold }), [{ name: 'andesite', count: 20 }])
  // no cobblestone: the junk that's all there is to build with keeps a stack's worth
  const deep = [{ name: 'cobbled_deepslate', count: 64 }, { name: 'cobbled_deepslate', count: 40 }, { name: 'tuff', count: 30 }, { name: 'dirt', count: 10 }]
  assert.deepEqual(junkToToss(deep, 4, { surplus, scaffold }), [{ name: 'cobbled_deepslate', count: 64 }, { name: 'dirt', count: 10 }])
  assert.deepEqual(junkToToss(deep, 4, { surplus }).length, 4)
})

for (const version of VERSIONS) {
  test(`protectedCounts (${version}): the best of each tool kind, a shield, a bow and its arrows, a water bucket, the food's working set; the hoe when farming`, async () => {
    const { protectedCounts, storable, FOOD_WORKING_SET } = await import('../../src/executor/keep')
    const registry = minecraftData(version)
    const bag = [
      { name: 'diamond_pickaxe', count: 1 }, { name: 'iron_pickaxe', count: 1 }, { name: 'stone_axe', count: 1 },
      { name: 'iron_sword', count: 1 }, { name: 'diamond_sword', count: 1 }, { name: 'wooden_hoe', count: 1 },
      { name: 'shield', count: 2 }, { name: 'bow', count: 1 }, { name: 'arrow', count: 64 }, { name: 'water_bucket', count: 1 },
      { name: 'cooked_beef', count: 10 }, { name: 'bread', count: 20 }, { name: 'cobblestone', count: 64 }
    ]
    const kept = protectedCounts(bag, registry)
    assert.deepEqual({ ...kept, cooked_beef: undefined }, { diamond_pickaxe: 1, stone_axe: 1, diamond_sword: 1, shield: 1, bow: 1, arrow: 32, water_bucket: 1, cooked_beef: undefined })
    // the most filling first: 5 cooked beef (8 each) make the 40
    assert.equal(FOOD_WORKING_SET, 40)
    assert.equal(kept.cooked_beef, 5)
    assert.equal(kept.bread, undefined)
    assert.equal(protectedCounts(bag, registry, { farming: true }).wooden_hoe, 1)
    // no bow: no arrows kept
    assert.equal(protectedCounts([{ name: 'arrow', count: 10 }], registry).arrow, undefined)
    // a store of everything leaves them; the spare pickaxe goes
    const moved = Object.fromEntries(storable(bag, bag, registry).map(i => [i.name, i.count]))
    assert.equal(moved.diamond_pickaxe, undefined)
    assert.equal(moved.iron_pickaxe, 1)
    assert.equal(moved.shield, 1)
    assert.equal(moved.arrow, 32)
    assert.equal(moved.cooked_beef, 5)
    assert.equal(moved.cobblestone, 64)
  })
}

test('splitInventory and junkToToss never put away the protected items, whatever the keep rule (a stock policy\'s count of 0)', () => {
  const registry = minecraftData('26.3')
  const bag = [{ name: 'diamond_pickaxe', count: 1 }, { name: 'water_bucket', count: 1 }, { name: 'bread', count: 30 }, { name: 'cobblestone', count: 64 }]
  const nothing = (): number => 0
  const { keep, store } = splitInventory(bag, { keep: nothing, registry })
  assert.deepEqual(keep, [{ name: 'diamond_pickaxe', count: 1 }, { name: 'water_bucket', count: 1 }, { name: 'bread', count: 8 }])
  assert.deepEqual(store, [{ name: 'bread', count: 22 }, { name: 'cobblestone', count: 64 }])
  const toss = junkToToss(bag, 4, { keep: nothing, registry, anything: true })
  assert.deepEqual(toss.map(t => t.name).sort(), ['cobblestone'])
})

for (const version of VERSIONS) {
  test(`trip spare: a second pickaxe in the bag, iron or better beside an iron or diamond one, stone or better beside a stone one (${version})`, async () => {
    const { tripSpareGoals } = await import('../../src/executor/keep')
    const { Inventory } = await import('../../src/core/inventory')
    const registry = minecraftData(version)
    const iron = ['iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe']
    // a diamond one alone: one more of iron or better
    assert.deepEqual(tripSpareGoals(new Inventory(registry as any, { diamond_pickaxe: 1, iron_ingot: 3 })), [{ item: iron, count: 2 }])
    // a stone one: stone or better (copper where the version has it)
    const [stone] = tripSpareGoals(new Inventory(registry as any, { stone_pickaxe: 1 }))
    assert.equal(stone.count, 2)
    assert.ok((stone.item as string[]).includes('stone_pickaxe') && (stone.item as string[]).includes('iron_pickaxe'))
    // a spare carried already, a wooden one, none: nothing
    assert.deepEqual(tripSpareGoals(new Inventory(registry as any, { diamond_pickaxe: 1, iron_pickaxe: 1 })), [])
    assert.deepEqual(tripSpareGoals(new Inventory(registry as any, { wooden_pickaxe: 1 })), [])
    assert.deepEqual(tripSpareGoals(new Inventory(registry as any, { cobblestone: 64 })), [])
    // a stone spare beside a diamond one is no spare of iron: one more
    assert.deepEqual(tripSpareGoals(new Inventory(registry as any, { diamond_pickaxe: 1, stone_pickaxe: 1 })), [{ item: iron, count: 2 }])
  })
}

test('ThrowHistory: a part stack thrown again with the same count is looping at its THROW_LOOP_REPEATS-th throw within THROW_LOOP_TICKS; a whole stack, a new count or an old throw are not', () => {
  // (26.3 run full-f: '19 dirt, 5 sand, 2 gravel' every step of a staircase, then '29 andesite, 19 dirt' and the diorite dug)
  const h = new ThrowHistory()
  assert.equal(h.repeats, THROW_LOOP_REPEATS)
  assert.equal(h.window, THROW_LOOP_TICKS)
  const toss = [{ name: 'dirt', count: 19 }, { name: 'sand', count: 5 }, { name: 'cobblestone', count: 64 }]
  assert.deepEqual(h.looping(toss, 100), [])
  h.record(toss, 100)
  assert.deepEqual(h.looping(toss, 200), [])
  h.record(toss, 200)
  // the third: the dirt and sand came back, the whole stack of cobblestone is new work
  assert.deepEqual(h.looping(toss, 300), [{ name: 'dirt', count: 19 }, { name: 'sand', count: 5 }])
  // with more dug into it, a stack's count is new; the andesite the same
  assert.deepEqual(h.looping([{ name: 'dirt', count: 22 }], 300), [])
  // long after, the old throws are forgotten
  assert.deepEqual(h.looping(toss, 200 + THROW_LOOP_TICKS + 1), [])
  // eggs stack to 16: a whole stack at 16 is whole at 16
  const pearls = new ThrowHistory(2)
  pearls.record([{ name: 'egg', count: 16 }], 0)
  assert.deepEqual(pearls.looping([{ name: 'egg', count: 16 }], 10, name => name === 'egg' ? 16 : 64), [])
  assert.deepEqual(pearls.looping([{ name: 'egg', count: 16 }], 10), [{ name: 'egg', count: 16 }])
})
