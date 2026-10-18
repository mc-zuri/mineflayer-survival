import { test } from 'node:test'
import assert from 'node:assert/strict'
import minecraftData from 'minecraft-data'
import { Inventory } from '../../src/core/inventory'
import { STOCK_MARKS, StockPolicy, describeLevel, markValue, stockLevels, storedAtBase, type StockMark } from '../../src/planner/stock'
import { splitInventory, stockKeepRule } from '../../src/executor/keep'
import { VERSIONS } from '../versions'

const ALL = ['wood', 'stone', 'food', 'base', 'iron', 'diamonds'] as const

for (const version of VERSIONS) {
  const registry: any = minecraftData(version)
  const inv = (items: Record<string, number>): Inventory => new Inventory(registry, items)
  const level = (policy: StockPolicy, id: string, items: Record<string, number>, stored: Record<string, number> = {}): number =>
    stockLevels(policy.marks, inv(items), stored).find(l => l.mark.id === id)?.have as number

  test(`${version}: every default mark gathers an item of the registry, its high mark over its low one`, () => {
    for (const m of STOCK_MARKS) {
      assert.ok(m.low < m.high, m.id)
      const gather = typeof m.gather === 'string' ? [m.gather] : m.gather
      for (const g of gather) assert.ok(g.startsWith('#') || registry.itemsByName[g] != null, `${m.id}: ${g}`)
      assert.ok(gather.some(g => markValue(m, g.startsWith('#') ? 'oak_log' : g, registry) > 0), `${m.id} doesn't count what it gathers`)
    }
  })

  test(`${version}: the stock counts the planks and sticks as wood, ores as their ingots and blocks, food by its points`, () => {
    const policy = new StockPolicy()
    assert.equal(level(policy, 'wood', { oak_log: 10, birch_planks: 8, stick: 16 }), 10 + 2 + 2)
    assert.equal(level(policy, 'iron', { raw_iron: 3, iron_ingot: 4, iron_block: 1 }), 16)
    assert.equal(level(policy, 'stone', { cobblestone: 10, cobbled_deepslate: 5 }), 15)
    assert.equal(level(policy, 'food', { cooked_beef: 2, bread: 1 }), 2 * 8 + 5)
  })

  test(`${version}: below the low mark a top-up is due, to the high mark; between the marks only one under way goes on`, () => {
    const policy = new StockPolicy()
    // 20 logs: under 32
    let ups = policy.topUps(inv({ oak_log: 20 }), {}, [], ['surface'])
    assert.deepEqual(ups.map(u => u.mark.id), ['wood'])
    assert.equal(ups[0].units, 64 - 20)
    assert.deepEqual(ups[0].request, { item: '#logs_that_burn', count: 64 })
    assert.equal(ups[0].budget, (64 - 20) * 100)
    // part of the way (40): still under way
    ups = policy.topUps(inv({ oak_log: 40 }), {}, [], ['surface'])
    assert.equal(ups[0]?.units, 24)
    // at the high mark it's over, and 40 again (over the low mark) starts none
    assert.equal(policy.topUps(inv({ oak_log: 64 }), {}, [], ['surface']).length, 0)
    assert.equal(policy.topUps(inv({ oak_log: 40 }), {}, [], ['surface']).length, 0)
    // under the low mark again: due again
    assert.equal(policy.topUps(inv({ oak_log: 30 }), {}, [], ['surface']).length, 1)
  })

  test(`${version}: what the base's chests hold counts: no top-up when the stock is at the base`, () => {
    const policy = new StockPolicy()
    const reached = [...ALL]
    const carried = { iron_pickaxe: 1, cobblestone: 64, raw_iron: 5 }
    // 64 carried: under 3 stacks, and 30 iron, under 32
    assert.deepEqual(policy.topUps(inv(carried), {}, reached, ['underground']).map(u => u.mark.id).filter(id => id === 'stone' || id === 'iron').sort(), ['iron', 'stone'])
    const fresh = new StockPolicy()
    const stored = storedAtBase([{ items: { cobblestone: 200 } }, { items: { iron_ingot: 30, cobblestone: 60 } }, undefined])
    assert.deepEqual(stored, { cobblestone: 260, iron_ingot: 30 })
    const ups = fresh.topUps(inv(carried), stored, reached, ['underground'])
    assert.ok(!ups.some(u => u.mark.id === 'stone' || u.mark.id === 'iron'), ups.map(u => describeLevel(u.level)).join(', '))
    // and what a top-up gathers is the high mark less what's stored too
    const low = new StockPolicy().topUps(inv({ cobblestone: 64 }), { cobblestone: 100 }, ['wood', 'stone'], ['underground']).find(u => u.mark.id === 'stone')
    assert.equal(low?.units, 320 - 164)
    assert.equal(low?.request.count, 64 + 320 - 164)
  })

  test(`${version}: a mark applies from its milestone, and only at its place (the surface's by day, the mine's by night)`, () => {
    const policy = new StockPolicy()
    assert.ok(!policy.topUps(inv({}), {}, [], ['underground']).some(u => u.mark.id === 'iron'))
    assert.ok(!policy.topUps(inv({}), {}, ['wood', 'stone'], ['surface']).some(u => u.mark.id === 'iron'))
    assert.ok(policy.topUps(inv({}), {}, ['wood', 'stone'], ['underground']).some(u => u.mark.id === 'iron'))
    // the lowest first
    const ups = policy.topUps(inv({ cobblestone: 150, coal: 30 }), {}, ['wood', 'stone'], ['underground'])
    assert.deepEqual(ups.map(u => u.mark.id), ['torch', 'iron', 'stone', 'coal'])
  })

  test(`${version}: a trip gathers what the free slots take beyond the reserve, shared out; the rest is for a later trip`, () => {
    const policy = new StockPolicy({ reserveSlots: 10 })
    const fill: Record<string, number> = {}
    // 20 slots used: 6 free beyond the 10 kept free
    const junk = ['dirt', 'andesite', 'diorite', 'granite', 'gravel', 'sand', 'tuff', 'calcite', 'netherrack', 'basalt']
    for (const j of junk) fill[j] = 128
    const ups = policy.topUps(inv({ ...fill }), {}, ['wood', 'stone'], ['underground'])
    // stone, torches, coal and iron due: 6 slots shared, a slot each
    assert.equal(ups.length, 4)
    for (const u of ups) assert.equal(u.units, 64, u.mark.id)
    // the inventory full: none this trip
    for (const j of ['blackstone', 'deepslate', 'cobblestone', 'stone', 'mud', 'clay']) fill[j] = 128
    assert.equal(policy.topUps(inv(fill), {}, ['wood', 'stone'], ['underground']).length, 0)
  })

  test(`${version}: an inventory over the working set sends the rest to the base (the stock keep rule)`, () => {
    const policy = new StockPolicy({ keep: { raw_iron: 8 } })
    const keep = stockKeepRule(policy)
    const rec = (l: Array<{ name: string, count: number }>): Record<string, number> => Object.fromEntries(l.map(i => [i.name, i.count]))
    const { keep: kept, store } = splitInventory([
      { name: 'oak_log', count: 64 }, { name: 'oak_log', count: 40 }, { name: 'cobblestone', count: 64 }, { name: 'cobblestone', count: 64 },
      { name: 'cobblestone', count: 64 }, { name: 'torch', count: 100 }, { name: 'raw_iron', count: 20 }, { name: 'diamond', count: 9 },
      { name: 'iron_pickaxe', count: 1 }, { name: 'cooked_beef', count: 12 }
    ], { keep, registry })
    assert.deepEqual(rec(kept), { oak_log: 64, cobblestone: 64, torch: 64, raw_iron: 8, iron_pickaxe: 1, cooked_beef: 12 })
    assert.deepEqual(rec(store), { oak_log: 40, cobblestone: 128, torch: 36, raw_iron: 12, diamond: 9 })
  })

  test(`${version}: the marks are configurable: replaced, or overridden by id`, () => {
    const custom: StockMark = { id: 'sand', counts: { sand: 1 }, gather: 'sand', low: 16, high: 64, where: 'surface', ticksPerUnit: 30 }
    const own = new StockPolicy({ marks: [custom] })
    assert.deepEqual(own.topUps(inv({}), {}, [], ['surface']).map(u => [u.mark.id, u.units]), [['sand', 64]])
    const over = new StockPolicy({ overrides: { wood: { low: 4, high: 16 } } })
    assert.equal(over.topUps(inv({ oak_log: 10 }), {}, [], ['surface']).length, 0)
    assert.equal(over.topUps(inv({ oak_log: 3 }), {}, [], ['surface'])[0].units, 13)
  })
}
