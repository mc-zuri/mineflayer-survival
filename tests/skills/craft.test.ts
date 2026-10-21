import { test } from 'node:test'
import assert from 'node:assert'
import { planCraft, recipeFinder } from '../../src/skills/craft'
import { craftingRecipes, recipesFor } from '../../src/planner/recipes'
import { itemTags } from '../../src/core/tags'
import { VERSIONS } from '../versions'
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
function fakeCraftBot (items: Record<string, number>, version = '1.21.11'): any {
  const registry = require('minecraft-data')(version)
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

for (const version of VERSIONS) {
  const reg = require('minecraft-data')(version)
  const stacks = (list: Array<[string, number]>): Array<{ id: number, count: number }> => list.map(([name, count]) => ({ id: reg.itemsByName[name].id, count }))
  const madeFrom = (plan: any): string[] => plan.recipesToDo.flatMap((s: any) => s.recipe.delta.filter((d: any) => d.count < 0).map((d: any) => reg.items[d.id].name))

  test(`${version}: planCraft makes planks of any member of the wood's log tag (the log, the wood, the stripped log and wood), as vanilla's #<wood>_logs`, async () => {
    const tags = itemTags(reg)
    for (const planks of tags.members('#planks')) {
      const recipe = recipesFor(reg, planks)[0]
      const members = recipe.ingredients[0].items
      assert.ok(members.length === (planks === 'bamboo_planks' ? 2 : 4), `${planks}: ${members.join(', ')}`)
      for (const member of members) {
        const plan = await planCraft(reg, stacks([[member, 1]]), planks, recipe.count)
        assert.strictEqual(plan.status, 'complete', `${planks} from ${member}`)
        assert.deepStrictEqual(madeFrom(plan), [member])
      }
    }
    // f2-grim's: 32 oak_wood and 1 oak_planks held, 8 oak_planks wanted
    const plan = await planCraft(reg, stacks([['oak_wood', 32], ['oak_planks', 1]]), 'oak_planks', 8)
    assert.strictEqual(plan.status, 'complete')
    assert.deepStrictEqual(plan.recipesToDo.map((s: any) => [madeFrom({ recipesToDo: [s] })[0], s.recipeApplications]), [['oak_wood', 2]])
    // and from a mix: 2 logs and 2 wood make 16
    const mixed = await planCraft(reg, stacks([['oak_log', 2], ['oak_wood', 2]]), 'oak_planks', 16)
    assert.strictEqual(mixed.status, 'complete')
    assert.deepStrictEqual(mixed.recipesToDo.map((s: any) => s.recipeApplications).reduce((a: number, b: number) => a + b, 0), 4)
  })

  test(`${version}: the craft skill can make every recipe the planner plans, of each of its ingredients' alternatives`, async () => {
    // The planner's recipes and the skill's are one table (rawRecipes): a plan's craft the skill can't make fails the
    // same way at every plan (f2-grim: 'craft 8 oak_planks' of 32 oak_wood, short of 8 oak_planks, 5 times over). Left
    // out: what minecraft-data has fewer of than vanilla's tags make (a barrel and a chiseled bookshelf of planks and
    // slabs of two woods; a campfire of charcoal and any log but dark_oak_wood, of coal and dark_oak_wood), and the
    // smithing templates' copies, which take the template itself
    const known = (result: string): boolean => ['barrel', 'chiseled_bookshelf', 'campfire'].includes(result) || result.endsWith('_smithing_template')
    const bad: string[] = []
    for (const [result, list] of craftingRecipes(reg)) {
      for (const recipe of list) {
        for (let k = 0; k < recipe.ingredients.length; k++) {
          for (const alt of recipe.ingredients[k].items) {
            const held = new Map<string, number>()
            recipe.ingredients.forEach((ing, j) => { const it = j === k ? alt : ing.items[0]; held.set(it, (held.get(it) ?? 0) + ing.count) })
            const plan = await planCraft(reg, stacks([...held]), result, recipe.count)
            if (plan.status !== 'complete' && !known(result)) bad.push(`${result} of ${[...held].map(([n, c]) => `${c} ${n}`).join(', ')}`)
          }
        }
      }
    }
    assert.deepStrictEqual(bad, [])
  })
}

test('recipeFinder: the recipes of its own registry, whatever registry prismarine-recipe was loaded with last', () => {
  const [a, b] = VERSIONS.map(v => require('minecraft-data')(v))
  const findA = recipeFinder(a)
  recipeFinder(b)
  require('prismarine-recipe')(b)
  const planksA = a.itemsByName.oak_planks.id
  assert.notStrictEqual(planksA, b.itemsByName.oak_planks.id)
  const found = findA.find(planksA, null)
  assert.strictEqual(found.length, 4)
  assert.deepStrictEqual(found.map((r: any) => a.items[r.ingredients[0].id].name).sort(), ['oak_log', 'oak_wood', 'stripped_oak_log', 'stripped_oak_wood'])
  assert.ok(found.every((r: any) => r.result.id === planksA && r.result.count === 4 && r.requiresTable === false))
})

test('craft: planks of oak_wood go to bot.craft as a recipe of oak_wood (f2-grim\'s 32 oak_wood, short of 8 oak_planks)', async () => {
  const { craft } = require('../../src/skills/craft')
  const bot = fakeCraftBot({ oak_wood: 32, oak_planks: 1 })
  const used: string[] = []
  bot.craft = async (recipe: any, count: number) => {
    const input = registry.items[recipe.ingredients[0].id].name
    used.push(`${count} ${input}`)
    bot.counts.set(input, (bot.counts.get(input) ?? 0) - count)
    bot.counts.set('oak_planks', (bot.counts.get('oak_planks') ?? 0) + 4 * count)
  }
  const ticking = setInterval(() => bot.emit('physicsTick'), 5)
  try {
    const res = await craft(bot, { item: 'oak_planks', count: 8 })
    assert.strictEqual(res.crafted, 8)
  } finally {
    clearInterval(ticking)
  }
  assert.deepStrictEqual(used, ['2 oak_wood'])
})

for (const version of ['1.21.11', '26.3']) {
  test(`craft (${version}): the walk to the table makes no pickaxe of the craft's ingredients, and the plan is made again after it: short then, MISSING_ITEMS, no clicks (f9-26.3: 'missing ingredient' after each respawn, the planks made a table on the way)`, async () => {
    const { craft } = require('../../src/skills/craft')
    const navModule = require('../../src/skills/navigate')
    const reg = require('minecraft-data')(version)
    const { Vec3 } = require('vec3')
    const table = new Vec3(-246, 59, -112)
    const make = (): any => {
      const bot = fakeCraftBot({ spruce_planks: 3, stick: 2 }, version)
      bot.entity = { position: new Vec3(-217, 64, -84) }
      bot.blockAt = (p: any) => p.equals(table) ? { type: reg.blocksByName.crafting_table.id, name: 'crafting_table', position: table } : null
      bot.crafted = 0
      bot.craft = async () => { bot.crafted++; bot.counts.set('spruce_planks', 0); bot.counts.set('stick', 0); bot.counts.set('wooden_pickaxe', 1) }
      return bot
    }
    const real = navModule.navigateToReach
    const walks: any[] = []
    let onWalk = (_bot: any): void => {}
    navModule.navigateToReach = async (b: any, _p: unknown, _s: unknown, opts: any) => { walks.push(opts); onWalk(b); return { position: b.entity.position, ticks: 0 } }
    try {
      const bot = make()
      const ticking = setInterval(() => bot.emit('physicsTick'), 5)
      try {
        const res = await craft(bot, { item: 'wooden_pickaxe', table })
        assert.strictEqual(res.crafted, 1)
      } finally { clearInterval(ticking) }
      assert.deepStrictEqual(walks, [{ pickaxe: false }])
      // the planks gone on the way (a table made of them): short, and bot.craft never clicked with the old plan
      const short = make()
      onWalk = (b) => b.counts.set('spruce_planks', 2)
      const ticking2 = setInterval(() => short.emit('physicsTick'), 5)
      try {
        await assert.rejects(craft(short, { item: 'wooden_pickaxe', table }), (err: any) => err.code === 'MISSING_ITEMS' && /after the walk to the table/.test(err.message))
      } finally { clearInterval(ticking2) }
      assert.strictEqual(short.crafted, 0)
    } finally {
      navModule.navigateToReach = real
    }
  })
}
