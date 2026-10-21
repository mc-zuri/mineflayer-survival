import { test } from 'node:test'
import assert from 'node:assert/strict'
import minecraftData from 'minecraft-data'
import { defaultKeep, isValuable, junkToToss, splitInventory, storable, THROW_LOOP_REPEATS, THROW_LOOP_TICKS, ThrowHistory, tossValue } from '../../src/executor/keep'
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

test("scaffoldKeepIn: NETHER_SCAFFOLD_KEEP building blocks in the nether, the scaffold keep's own elsewhere; junkToToss keeps them all together", async () => {
  const { NETHER_SCAFFOLD_KEEP, scaffoldKeepIn } = await import('../../src/executor/keep')
  const { SCAFFOLD_ITEMS } = await import('../../src/executor/steps')
  const scaffold = { items: SCAFFOLD_ITEMS, keep: 64 }
  assert.equal(scaffoldKeepIn(scaffold, 'overworld'), scaffold)
  assert.equal(scaffoldKeepIn(scaffold, 'the_end'), scaffold)
  assert.deepEqual(scaffoldKeepIn(scaffold, 'the_nether'), { items: SCAFFOLD_ITEMS, keep: NETHER_SCAFFOLD_KEEP })
  // a keep over it stays
  assert.equal(scaffoldKeepIn({ items: SCAFFOLD_ITEMS, keep: 200 }, 'the_nether').keep, 200)
  // the bag of full-26.3-fresh-t at t211310, in the nether: the netherrack thrown first in the overworld, none of the 109
  // building blocks (of two kinds together) in the nether, the junk drops still; with 203 of three kinds, a stack of
  // netherrack goes, the rest left under 128
  const bag = [{ name: 'cobblestone', count: 64 }, { name: 'cobblestone', count: 8 }, { name: 'netherrack', count: 37 }, { name: 'rotten_flesh', count: 3 }]
  assert.deepEqual(junkToToss(bag, 4, { scaffold }), [{ name: 'netherrack', count: 37 }, { name: 'rotten_flesh', count: 3 }])
  assert.deepEqual(junkToToss(bag, 4, { scaffold: scaffoldKeepIn(scaffold, 'the_nether') }), [{ name: 'rotten_flesh', count: 3 }])
  const more = [...bag, { name: 'blackstone', count: 30 }, { name: 'netherrack', count: 64 }]
  assert.deepEqual(junkToToss(more, 4, { scaffold: scaffoldKeepIn(scaffold, 'the_nether') }), [{ name: 'netherrack', count: 64 }, { name: 'rotten_flesh', count: 3 }])
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

for (const version of VERSIONS) {
  test(`milestoneNeeds: the nether's goals, the plan for them and its kit, and the eyes' after it (${version})`, async () => {
    const { milestoneNeeds } = await import('../../src/executor/keep')
    const { milestone, milestonesAhead, planMilestone } = await import('../../src/planner/progression')
    const { Inventory } = await import('../../src/core/inventory')
    const { WorldMemory } = await import('../../src/core/memory')
    const registry = minecraftData(version)
    // a flint and steel to craft from the bag's iron and flint, 6 obsidian made of the 10
    const inventory = new Inventory(registry as any, { diamond_pickaxe: 1, iron_ingot: 3, flint: 2, obsidian: 6, water_bucket: 1, bucket: 2, raw_gold: 2, crafting_table: 1 })
    const state = { inventory, memory: new WorldMemory() }
    const nether = milestone('nether')
    const ahead = milestonesAhead(nether, state)
    assert.deepEqual(ahead.map(m => m.id), ['nether', 'eyes'])
    let planned = 0
    const needs = milestoneNeeds(ahead, state, goals => { planned++; return planMilestone(registry as any, { ...nether, goals: () => goals }, state) })
    assert.equal(planned, 2)
    // the goals
    assert.equal(needs.obsidian, 10)
    assert.equal(needs.flint_and_steel, 1)
    assert.ok(needs.blaze_rod >= 8 && needs.ender_pearl >= 16, JSON.stringify(needs))
    // the plan's: the flint and steel's iron and flint
    assert.ok(needs.iron_ingot >= 1 && needs.flint >= 1, JSON.stringify(needs))
    // the kit: the cast's buckets and the gold
    for (const name of ['bucket', 'water_bucket', 'lava_bucket', 'gold_ingot', 'raw_gold']) assert.ok(needs[name] > 0, name)
    // the eyes after it: the powder and the eyes
    assert.ok(needs.blaze_powder > 0 && needs.ender_eye > 0)
    // with no plan (or one that throws): the goals and the kit alone
    const bare = milestoneNeeds(ahead, state, () => { throw new Error('no plan') })
    assert.equal(bare.obsidian, 10)
    assert.equal(bare.flint, undefined)
  })

  test(`milestoneNeeds: the enchanting's books, lapis, diamonds and obsidian, the table's makings from its plan (${version})`, async () => {
    const { milestoneNeeds } = await import('../../src/executor/keep')
    const { milestone, planMilestone } = await import('../../src/planner/progression')
    const { Inventory } = await import('../../src/core/inventory')
    const { WorldMemory } = await import('../../src/core/memory')
    const registry = minecraftData(version)
    const inventory = new Inventory(registry as any, { diamond_pickaxe: 1, diamond: 2, obsidian: 4, paper: 3, leather: 1, crafting_table: 1 })
    const state = { inventory, memory: new WorldMemory() }
    const m = milestone('enchanting')
    const needs = milestoneNeeds([m], state, goals => planMilestone(registry as any, { ...m, goals: () => goals }, state))
    assert.equal(needs.enchanting_table, 1)
    assert.ok(needs.lapis_lazuli >= 9)
    assert.ok(needs.diamond >= 2 && needs.obsidian >= 4 && needs.book > 0, JSON.stringify(needs))
    // the plan's: the book's paper and leather
    assert.ok(needs.paper >= 3 && needs.leather >= 1, JSON.stringify(needs))
  })
}

test('a full bag in the nether milestone: the stash and the store take the junk and the rest, never the obsidian, the buckets, the gold (protectedCounts needs)', () => {
  const registry = minecraftData('26.3')
  const needs = { obsidian: 10, bucket: Infinity, water_bucket: Infinity, lava_bucket: Infinity, flint_and_steel: 1, gold_ingot: Infinity, raw_gold: Infinity, diamond: 3 }
  const bag = [
    { name: 'diamond_pickaxe', count: 1 }, { name: 'obsidian', count: 6 }, { name: 'bucket', count: 2 }, { name: 'water_bucket', count: 1 },
    { name: 'lava_bucket', count: 1 }, { name: 'raw_gold', count: 2 }, { name: 'raw_iron', count: 2 }, { name: 'furnace', count: 1 },
    { name: 'oak_door', count: 1 }, { name: 'dirt', count: 64 }, { name: 'cobblestone', count: 64 }
  ]
  // a stock policy's keep rule of 0 for everything: what's kept is what's protected
  const nothing = (): number => 0
  const { keep, store } = splitInventory(bag, { keep: nothing, registry, protect: { needs } })
  const stored = Object.fromEntries(store.map(s => [s.name, s.count]))
  const kept = Object.fromEntries(keep.map(s => [s.name, s.count]))
  for (const name of ['obsidian', 'bucket', 'water_bucket', 'lava_bucket', 'raw_gold']) {
    assert.equal(stored[name], undefined, `${name} stored`)
    assert.equal(kept[name], bag.find(b => b.name === name)?.count, `${name} kept`)
  }
  assert.deepEqual(['cobblestone', 'dirt', 'furnace', 'oak_door', 'raw_iron'].filter(n => stored[n] > 0), ['cobblestone', 'dirt', 'furnace', 'oak_door', 'raw_iron'])
  // a chest's store of all of it (chest.ts storable) leaves them too
  const into = storable(bag, bag, registry, { needs })
  assert.deepEqual(into.filter(i => needs[i.name as keyof typeof needs] != null), [])
  // and a throw of anything for room takes none of them (the buckets and gold aren't valuable)
  const toss = junkToToss(bag, 10, { keep: nothing, registry, anything: true, protect: { needs } })
  assert.deepEqual(toss.filter(t => needs[t.name as keyof typeof needs] != null), [])
  assert.ok(toss.some(t => t.name === 'dirt'))
  // the same bag without the needs: the obsidian and the gold go to the stash (the 26.3 run's depot)
  const before = splitInventory(bag, { keep: nothing, registry })
  assert.ok(before.store.some(s => s.name === 'obsidian') && before.store.some(s => s.name === 'raw_gold'))
})

test('the nether\'s fire resistance makings are carried, not stored: the potions (water bottles too), the magma cream, 3 glass bottles, 4 nether wart', async () => {
  const { defaultKeep } = await import('../../src/executor/keep')
  assert.equal(defaultKeep('potion'), Infinity)
  assert.equal(defaultKeep('splash_potion'), Infinity)
  assert.equal(defaultKeep('magma_cream'), Infinity)
  assert.equal(defaultKeep('glass_bottle'), 3)
  assert.equal(defaultKeep('nether_wart'), 4)
})

test('the base store after a trip, the stash and a throw for room leave the whole brew kit in the bag while the nether is worked on (the water bottles, the stand, the powder, the slime ball, the table, the stand\'s cobblestone): fresh-v went in without its bottles', async () => {
  const { MILESTONE_KIT, defaultKeep } = await import('../../src/executor/keep')
  const { tripKitItems } = await import('../../src/skills/tripKit')
  const registry = minecraftData('26.3')
  const needs = MILESTONE_KIT.nether as Record<string, number>
  const brew = [
    { name: 'potion', count: 3 }, { name: 'glass_bottle', count: 2 }, { name: 'brewing_stand', count: 1 }, { name: 'blaze_powder', count: 2 },
    { name: 'slime_ball', count: 2 }, { name: 'magma_cream', count: 1 }, { name: 'nether_wart', count: 5 }, { name: 'crafting_table', count: 1 },
    { name: 'cobblestone', count: 32 }
  ]
  const bag = [...brew, { name: 'diamond_pickaxe', count: 1 }, { name: 'dirt', count: 64 }, { name: 'raw_iron', count: 12 }, { name: 'oak_door', count: 1 }]
  for (const keep of [defaultKeep, (): number => 0]) {
    const { store } = splitInventory(bag, { keep, registry, protect: { needs } })
    assert.deepEqual(store.filter(s => brew.some(b => b.name === s.name)), [], keep === defaultKeep ? 'the default keep' : 'a keep of nothing')
    assert.deepEqual(storable(bag, bag, registry, { needs }).filter(s => brew.some(b => b.name === s.name)), [])
    assert.deepEqual(junkToToss(bag, 10, { keep, registry, anything: true, protect: { needs } }).filter(t => brew.some(b => b.name === t.name)), [])
  }
  // the trip kit by the portal takes none of it (half the blocks: the stand's 3 left)
  const kit = tripKitItems(bag)
  assert.deepEqual(kit.filter(k => brew.some(b => b.name === k.name) && k.name !== 'cobblestone'), [])
  assert.ok(32 - (kit.find(k => k.name === 'cobblestone')?.count ?? 0) >= 3)
})

test('spareToolsKeep: of each tool kind the best kept (a spare pickaxe and sword too), the rest to store; anything else by the rule under it', async () => {
  const { spareToolsKeep, splitInventory } = await import('../../src/executor/keep')
  const items = [
    { name: 'stone_axe', count: 1 }, { name: 'stone_axe', count: 1 }, { name: 'stone_hoe', count: 1 }, { name: 'wooden_hoe', count: 1 },
    { name: 'diamond_pickaxe', count: 1 }, { name: 'iron_pickaxe', count: 1 }, { name: 'stone_pickaxe', count: 1 },
    { name: 'diamond_sword', count: 1 }, { name: 'iron_sword', count: 1 }, { name: 'stone_sword', count: 1 }, { name: 'torch', count: 17 }
  ]
  const { store } = splitInventory(items, { keep: spareToolsKeep(items) })
  const by = Object.fromEntries(store.map(s => [s.name, s.count]))
  assert.deepStrictEqual(by, { stone_axe: 1, wooden_hoe: 1, stone_pickaxe: 1, stone_sword: 1 })
})

test('the tools beyond the spare quota are junk to a room, after the junk drops, but a diamond one; the hoe but on a farm; 3 empty buckets kept (f6-26.3: 17 tools in a full bag, the nether kit with no room)', async () => {
  const { spareToolsBeyond } = await import('../../src/executor/keep')
  const registry = minecraftData('26.3')
  // f6-26.3's bag at t226504 (the tools one a stack)
  const one = (name: string, n: number): Array<{ name: string, count: number }> => Array.from({ length: n }, () => ({ name, count: 1 }))
  const stacks = [
    ...one('diamond_sword', 2), ...one('diamond_pickaxe', 2), ...one('iron_pickaxe', 3), ...one('iron_sword', 2), ...one('stone_sword', 1),
    ...one('stone_pickaxe', 1), ...one('stone_axe', 3), ...one('wooden_hoe', 1), ...one('stone_hoe', 1), ...one('bucket', 3),
    { name: 'water_bucket', count: 1 }, { name: 'oak_log', count: 21 }, { name: 'coal', count: 31 }, { name: 'cobblestone', count: 57 },
    { name: 'melon_slice', count: 64 }, { name: 'string', count: 4 }, { name: 'flint', count: 2 }
  ]
  const beyond = spareToolsBeyond(stacks)
  assert.deepEqual(Object.fromEntries(beyond), { iron_pickaxe: 3, iron_sword: 2, stone_sword: 1, stone_pickaxe: 1, stone_axe: 2, wooden_hoe: 1, stone_hoe: 1 })
  // on a farm the best hoe stays
  assert.equal(spareToolsBeyond(stacks, true).get('stone_hoe'), undefined)
  // a room's toss: the junk drops first, then the tools beyond the quota; never a diamond one, the best axe or a bucket of the 3
  const toss = junkToToss(stacks, 12, { registry, spareTools: true })
  const names = toss.map(t => t.name)
  assert.deepEqual(names.slice(0, 2).sort(), ['flint', 'string'])
  assert.equal(names.filter(n => n === 'iron_pickaxe').length, 3)
  assert.equal(names.filter(n => n === 'stone_axe').length, 2)
  assert.ok(!names.some(n => n.startsWith('diamond_') || n === 'bucket' || n === 'water_bucket'), names.join(', '))
  // and without spareTools, none of the tools
  assert.ok(!junkToToss(stacks, 12, { registry }).some(t => t.name.endsWith('_pickaxe')))
  assert.equal(defaultKeep('bucket'), 3)
})

test('lastResort: a room with nothing else to throw throws the stone beyond the scaffold\'s reserve and the wood beyond the needs, kept or not; never food, torches, arrows or a valuable (f6-26.3: the nether kit with no room 20000 ticks)', async () => {
  const { lastResortItem } = await import('../../src/executor/keep')
  const registry = minecraftData('26.3')
  const stacks = [
    { name: 'cobblestone', count: 64 }, { name: 'cobblestone', count: 64 }, { name: 'oak_log', count: 21 }, { name: 'jungle_log', count: 1 },
    { name: 'melon_slice', count: 64 }, { name: 'torch', count: 18 }, { name: 'coal', count: 31 }, { name: 'arrow', count: 40 }, { name: 'bow', count: 1 }
  ]
  const keep = (name: string): number | null => ({ cobblestone: 128, oak_log: 64, jungle_log: 64, torch: 64, arrow: Infinity } as Record<string, number>)[name] ?? defaultKeep(name, registry)
  const scaffold = { items: ['cobblestone'], keep: 64 }
  // the keep rule's: nothing
  assert.deepEqual(junkToToss(stacks, 4, { keep, registry, anything: true, scaffold }), [])
  // the last resort: a stack of the cobblestone (the reserve's left), the logs but the needed one
  const toss = junkToToss(stacks, 4, { keep, registry, anything: true, lastResort: true, scaffold, needed: { jungle_log: 1 } })
  assert.deepEqual(toss, [{ name: 'cobblestone', count: 64 }, { name: 'oak_log', count: 21 }])
  assert.ok(lastResortItem('oak_planks') && lastResortItem('cobblestone') && !lastResortItem('melon_slice') && !lastResortItem('torch'))
})

test('the home\'s food kept from a room\'s throw and a store (homeFoodKeeps): a farm\'s seeds up to 64, the herd\'s wheat up to 12; none of it with no farm and a herd of pigs but the start\'s seeds and the pigs\' carrots (f5-1.21.11: seeds thrown, the herd\'s wheat stashed a wheat at a time)', async () => {
  const registry = minecraftData('1.21.11')
  const { homeFoodKeeps, SEEDS_KEPT, HERD_FOOD_HELD } = await import('../../src/skills/herd')
  const { FARM_PLOTS } = await import('../../src/core/crops')
  const { WorldMemory } = await import('../../src/core/memory')
  const { rememberFarm } = await import('../../src/skills/farm')
  const { Vec3 } = await import('vec3')
  const memory = new WorldMemory()
  // no farm yet, no herd: the start's seeds and the herd's wheat to start one
  assert.deepEqual(homeFoodKeeps(memory), { wheat_seeds: FARM_PLOTS, wheat: HERD_FOOD_HELD })
  rememberFarm(memory, { water: new Vec3(0, 63, 0), cells: [new Vec3(1, 63, 0)], crop: 'wheat' }, 0)
  rememberFarm(memory, { water: new Vec3(20, 63, 0), cells: [new Vec3(21, 63, 0)], crop: 'carrots' }, 0)
  memory.addPoi('herd', new Vec3(10, 64, 10), 'overworld', JSON.stringify({ mob: 'pig', adults: 2, calves: 0, bred: null }))
  assert.deepEqual(homeFoodKeeps(memory), { wheat_seeds: SEEDS_KEPT, carrot: SEEDS_KEPT, potato: HERD_FOOD_HELD, beetroot: HERD_FOOD_HELD })
  assert.deepEqual(homeFoodKeeps(memory, 'the_nether'), {})
  // a room's throw: the junk goes, the farm's seeds and the herd's wheat stay
  const cows = new WorldMemory()
  rememberFarm(cows, { water: new Vec3(0, 63, 0), cells: [new Vec3(1, 63, 0)], crop: 'wheat' }, 0)
  const stacks = [{ name: 'wheat_seeds', count: 30 }, { name: 'wheat', count: 9 }, { name: 'dirt', count: 64 }, { name: 'gravel', count: 10 }]
  const tossed = junkToToss(stacks, 5, { registry, protect: { homeFood: homeFoodKeeps(cows) } })
  assert.deepEqual(tossed.map(t => t.name).sort(), ['dirt', 'gravel'])
  const { store } = splitInventory(stacks, { registry, protect: { homeFood: homeFoodKeeps(cows) } })
  assert.ok(!store.some(s => s.name === 'wheat' || s.name === 'wheat_seeds'), JSON.stringify(store))
})
