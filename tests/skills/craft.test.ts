import { test } from 'node:test'
import assert from 'node:assert'
import { planCraft } from '../../src/skills/craft'
import { countsDelta } from '../../src/skills/util'

const registry = require('minecraft-data')('1.21.11')
const items = (list: Array<[string, number]>): Array<{ id: number, count: number }> => list.map(([name, count]) => ({ id: registry.itemsByName[name].id, count }))

test('planCraft: a wooden pickaxe from logs goes through planks and sticks, at a table', async () => {
  const plan = await planCraft(registry, items([['oak_log', 5]]), 'wooden_pickaxe', 1)
  assert.strictEqual(plan.status, 'complete')
  assert.strictEqual(plan.requiresCraftingTable, true)
  const made = plan.recipesToDo.map(step => registry.items[step.recipe.result.id].name)
  assert.deepStrictEqual([...new Set(made)].sort(), ['oak_planks', 'stick', 'wooden_pickaxe'])
})

test('planCraft: a crafting table needs no table, a furnace needs eight cobblestone', async () => {
  const table = await planCraft(registry, items([['birch_log', 1]]), 'crafting_table', 1)
  assert.strictEqual(table.status, 'complete')
  assert.strictEqual(table.requiresCraftingTable, false)
  const short = await planCraft(registry, items([['cobblestone', 7]]), 'furnace', 1)
  assert.notStrictEqual(short.status, 'complete')
  const furnace = await planCraft(registry, items([['cobblestone', 8]]), 'furnace', 1)
  assert.strictEqual(furnace.status, 'complete')
})

test('countsDelta keeps the names that changed', () => {
  assert.deepStrictEqual(countsDelta({ oak_log: 5, stick: 2 }, { oak_log: 3, stick: 2, oak_planks: 8 }), { oak_log: -2, oak_planks: 8 })
})

/** a bot in its inventory menu, ticked by hand, whose server answers a resync (a click on no slot) with the menu */
function fakeCraftBot (items: Record<string, number>): any {
  const { EventEmitter } = require('node:events')
  const bot: any = new EventEmitter()
  bot.registry = registry
  const counts = new Map(Object.entries(items))
  const slots = (): any[] => {
    const out: any[] = new Array(46).fill(null)
    let i = 9
    for (const [name, count] of counts) if (count > 0) out[i++] = { name, count, type: registry.itemsByName[name].id, slot: i - 1 }
    return out
  }
  bot.inventory = { id: 0, get slots () { return slots() }, selectedItem: null, items: () => slots().slice(9, 45).filter(s => s != null) }
  bot.counts = counts
  bot.currentWindow = null
  bot._stateId = 5
  bot.supportFeature = (name: string) => name === 'stateIdUsed'
  bot._client = new EventEmitter()
  bot._client.write = (name: string, packet: any) => {
    if (name !== 'window_click' || packet.slot !== -1) return
    // the menu as the server has it
    setImmediate(() => { bot.serverHas?.(); bot._client.emit('window_items', { windowId: 0, stateId: 6 }) })
  }
  return bot
}

test('craft: a step whose result comes after the clicks\' prediction was undone is counted by what the server has', async () => {
  const { craft } = require('../../src/skills/craft')
  const bot = fakeCraftBot({ oak_planks: 2 })
  // the clicks' answers undid the prediction (a full menu for a click behind its state id): no stick when bot.craft
  // is done, though the server made the 4 sticks
  bot.craft = async () => {
    bot.counts.set('oak_planks', 0)
    bot.serverHas = () => bot.counts.set('stick', 4)
  }
  const ticking = setInterval(() => bot.emit('physicsTick'), 5)
  try {
    const res = await craft(bot, { item: 'stick', count: 4 })
    assert.strictEqual(res.crafted, 4)
  } finally {
    clearInterval(ticking)
  }
  // one the server never made fails
  const short = fakeCraftBot({ oak_planks: 2 })
  short.craft = async () => {}
  const ticking2 = setInterval(() => short.emit('physicsTick'), 5)
  try {
    await assert.rejects(craft(short, { item: 'stick', count: 4 }), /crafting stick x1 gave 0 of 4/)
  } finally {
    clearInterval(ticking2)
  }
})

test('craft: a result with no room for it in a full bag is NO_SPACE, for the executor to make room', async () => {
  const { craft } = require('../../src/skills/craft')
  const full = fakeCraftBot({ oak_planks: 2 })
  full.craft = async () => {}
  full.inventory.emptySlotCount = () => 0
  const ticking = setInterval(() => full.emit('physicsTick'), 5)
  try {
    await assert.rejects(craft(full, { item: 'stick', count: 4 }), (err: any) => err.code === 'NO_SPACE' || /NO_SPACE|inventory is full/.test(String(err.message)))
  } finally {
    clearInterval(ticking)
  }
})

test('craft: the reflexes are held while bot.craft\'s clicks are on their way, in parts of CRAFTS_PER_HOLD crafts', async () => {
  const { craft, CRAFTS_PER_HOLD } = require('../../src/skills/craft')
  const bot = fakeCraftBot({ oak_log: 9 })
  const held = new Map<string, number>()
  bot.survival = {
    reflexes: {
      reflexes: [{ name: 'armor' }, { name: 'eat' }, { name: 'hostiles' }],
      inhibit: (names: string[]) => {
        for (const n of names) held.set(n, (held.get(n) ?? 0) + 1)
        return () => { for (const n of names) held.set(n, (held.get(n) ?? 0) - 1) }
      }
    }
  }
  const calls: Array<{ count: number, held: string[] }> = []
  bot.craft = async (_recipe: any, count: number) => {
    calls.push({ count, held: [...held].filter(([, k]) => k > 0).map(([n]) => n).sort() })
    bot.counts.set('oak_log', (bot.counts.get('oak_log') ?? 0) - count)
    bot.counts.set('oak_planks', (bot.counts.get('oak_planks') ?? 0) + 4 * count)
  }
  const ticking = setInterval(() => bot.emit('physicsTick'), 5)
  try {
    const res = await craft(bot, { item: 'oak_planks', count: 36 })
    assert.strictEqual(res.crafted, 36)
  } finally {
    clearInterval(ticking)
  }
  assert.strictEqual(CRAFTS_PER_HOLD, 4)
  assert.deepStrictEqual(calls.map(c => c.count), [4, 4, 1])
  for (const c of calls) assert.deepStrictEqual(c.held, ['armor', 'eat', 'hostiles'])
  // released after
  assert.deepStrictEqual([...held.values()], [0, 0, 0])
})

test('craft: a result the bag shows only ticks after the steps (the menu closed with the inventory as it was) is waited for', async () => {
  const { craft } = require('../../src/skills/craft')
  const bot = fakeCraftBot({ oak_planks: 2 })
  let ticks = 0
  let backAt = Infinity
  bot.on('physicsTick', () => { if (++ticks >= backAt) bot.counts.set('stick', 4) })
  // the step sees its sticks; then the bag shows none of them until the server's answer, 15 ticks on
  bot.craft = async () => {
    bot.counts.set('oak_planks', 0)
    bot.counts.set('stick', 4)
    setImmediate(() => { bot.counts.set('stick', 0); backAt = ticks + 15 })
  }
  const ticking = setInterval(() => bot.emit('physicsTick'), 5)
  try {
    const res = await craft(bot, { item: 'stick', count: 4 })
    assert.strictEqual(res.crafted, 4)
  } finally {
    clearInterval(ticking)
  }
})
