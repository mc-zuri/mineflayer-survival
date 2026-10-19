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
