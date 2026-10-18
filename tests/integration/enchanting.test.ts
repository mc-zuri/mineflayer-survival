// The enchanting skills against a real 1.21.11 server (the tests/harness lockstep server and bot), on a superflat
// patch set up with commands: the table and its 15 shelves set up from the parts and checked by the offers, gear
// enchanted with levels from /xp, experience gained by mining and smelting, and sugar cane harvested into paper.
import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { createPlugin } from '../../src'
import { connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { collectBlock, countItems, craft, harvestSugarCane, waitUntil } from '../../src/skills/gather'
import { BOOKSHELF_OFFSETS, MAX_BOOKSHELVES, countBookshelves, enchant, enchantAll, setupEnchanting } from '../../src/skills/enchant'
import { experience, gainLevels } from '../../src/skills/xp'
import { applyBooks, repairItem } from '../../src/skills/anvil'

const USERNAME = 'enchantbot'
// the superflat's grass is at y = -61; the bot stands at -60
const GROUND = -61

describe('enchanting skills on a 1.21.11 server', { timeout: 20 * 60 * 1000 }, () => {
  let server: TestServer
  let bot: Bot
  let origin: Vec3
  let ticks = 0
  let startTicks = 0
  let startWall = 0
  const timings: string[] = []

  const run = async (cmd: string): Promise<string> => (await server.command(cmd)).join(' ')
  const at = (dx: number, dy: number, dz: number): Vec3 => origin.offset(dx, dy, dz)
  const xyz = (pos: Vec3): string => `${pos.x} ${pos.y} ${pos.z}`

  before(async () => {
    server = await startServer({
      flat: true,
      seed: 'enchanting',
      difficulty: 'peaceful',
      gamerules: { advance_weather: false, spawn_mobs: false, spawn_monsters: false, random_tick_speed: 0 },
      properties: { 'spawn-protection': 0 }
    })
    bot = await connectLockstepBot(server, { username: USERNAME })
    await bot.waitForChunksToLoad()
    bot.loadPlugin(createPlugin({ reflexes: false }))
    bot.on('physicsTick', () => { ticks++ })
    origin = new Vec3(Math.floor(bot.entity.position.x), GROUND + 1, Math.floor(bot.entity.position.z))
  })

  after(async () => {
    if (bot != null) await quitBot(bot)
    if (server != null) await server.cleanup()
    console.log(`enchanting integration timings:\n${timings.join('\n')}`)
  })

  // a clean patch: grass and air, no items about, an empty inventory and no levels, the bot at the origin by day
  beforeEach(async () => {
    await run(`fill ${xyz(at(-14, 0, -14))} ${xyz(at(14, 8, 14))} air`)
    await run(`fill ${xyz(at(-14, -1, -14))} ${xyz(at(14, -1, 14))} grass_block`)
    await run(`fill ${xyz(at(-14, -2, -14))} ${xyz(at(14, -2, 14))} dirt`)
    await run('kill @e[type=item]')
    await run('kill @e[type=experience_orb]')
    await run(`clear ${USERNAME}`)
    await run(`xp set ${USERNAME} 0 levels`)
    await run(`xp set ${USERNAME} 0 points`)
    await run('time set 1000')
    await run(`tp ${USERNAME} ${origin.x + 0.5} ${origin.y} ${origin.z + 0.5}`)
    bot.survival.memory.removePoi('enchanting_table')
    const settled = await waitUntil(bot, () => bot.entity.position.distanceTo(origin.offset(0.5, 0, 0.5)) < 0.1 && bot.inventory.items().length === 0 &&
      experience(bot).level === 0 && experience(bot).progress === 0 && bot.blockAt(at(0, -1, 0))?.name === 'grass_block', 100)
    assert.ok(settled, `the bot is at ${bot.entity.position.toString()} with ${bot.inventory.items().map(item => `${item.name}x${item.count}`).join(' ')}`)
    startTicks = ticks
    startWall = Date.now()
  })

  afterEach((t) => {
    const n = ticks - startTicks
    const ms = Date.now() - startWall
    timings.push(`  ${t.name}: ${n} ticks in ${(ms / 1000).toFixed(1)} s (${(n / Math.max(ms / 1000, 1e-3)).toFixed(0)} ticks/s, ${(n * 50 / Math.max(ms, 1)).toFixed(1)}x real time)`)
  })

  async function give (item: string, count: number): Promise<void> {
    const had = countItems(bot, item)
    await run(`give ${USERNAME} ${item} ${count}`)
    assert.ok(await waitUntil(bot, () => countItems(bot, item) >= had + count, 40), `no ${count} ${item} given`)
  }

  async function setblock (pos: Vec3, block: string): Promise<void> {
    await run(`setblock ${xyz(pos)} ${block}`)
    const name = block.replace(/^minecraft:/, '').replace(/\[.*$/, '')
    assert.ok(await waitUntil(bot, () => bot.blockAt(pos)?.name === name, 40), `no ${name} at ${pos.toString()}`)
  }

  const lookup = (pos: Vec3): any => bot.blockAt(pos)

  it('crafts the table and 15 bookshelves from their parts, sets them up, and the table offers level 30', async () => {
    await give('oak_planks', 96)
    await give('book', 46)
    await give('diamond', 2)
    await give('obsidian', 4)
    await give('diamond_sword', 1)

    const setup = await setupEnchanting(bot, {})
    assert.strictEqual(bot.blockAt(setup.table)?.name, 'enchanting_table')
    assert.strictEqual(setup.placedTable, true)
    assert.strictEqual(setup.bookshelves, MAX_BOOKSHELVES)
    assert.strictEqual(countBookshelves(lookup, setup.table), 15)
    assert.strictEqual(setup.placedShelves, 15)
    assert.strictEqual(countItems(bot, 'bookshelf'), 0)
    // the offers the server sent for the sword: the top one is 30
    assert.ok(setup.costs != null)
    assert.strictEqual(setup.costs[2], 30)
    assert.ok(setup.costs[0] >= 1 && setup.costs[1] > setup.costs[0])
    assert.strictEqual(countItems(bot, 'diamond_sword'), 1)
    assert.strictEqual(bot.survival.memory.getPois('enchanting_table').length, 1)
    // the shelves stand where the table counts them, the gap to the table left free
    for (const o of BOOKSHELF_OFFSETS) {
      if (bot.blockAt(setup.table.plus(o))?.name !== 'bookshelf') continue
      assert.strictEqual(bot.blockAt(setup.table.offset(Math.trunc(o.x / 2), o.y, Math.trunc(o.z / 2)))?.name, 'air')
    }
  })

  it('with levels from /xp, enchants a diamond sword and a set of diamond armor (the boots worn) at the top offer', async () => {
    // a table and 15 shelves set with commands, 4 blocks off
    const table = at(0, 0, 5)
    await setblock(table, 'enchanting_table')
    for (const o of BOOKSHELF_OFFSETS.filter(o => o.y === 0 && !(o.x === 0 && o.z === -2))) await setblock(table.plus(o), 'bookshelf')
    assert.strictEqual(countBookshelves(lookup, table), 15)
    for (const item of ['diamond_sword', 'diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots']) await give(item, 1)
    await give('lapis_lazuli', 64)
    await bot.equip(bot.inventory.items().find(i => i.name === 'diamond_boots') as any, 'feet')
    await run(`xp add ${USERNAME} 100 levels`)
    assert.ok(await waitUntil(bot, () => experience(bot).level === 100, 40))

    const { setup, enchanted } = await enchantAll(bot, { categories: ['sword', 'chestplate', 'leggings', 'helmet', 'boots'], targetLevel: 0 })
    assert.deepStrictEqual(setup.table.toArray(), table.toArray())
    assert.strictEqual(setup.placedTable, false)
    assert.deepStrictEqual(enchanted.map(e => e.item), ['diamond_sword', 'diamond_chestplate', 'diamond_leggings', 'diamond_helmet', 'diamond_boots'])
    for (const e of enchanted) {
      assert.strictEqual(e.slot, 2, `${e.item}: ${JSON.stringify(e.offers)}`)
      assert.strictEqual(e.cost, 30)
      assert.ok(e.enchants.length > 0)
      // the hint is one of the enchantments it got (EnchantmentMenu.enchantClue: the server's registry id, read by name)
      assert.ok(e.hint != null && e.enchants.some(x => x.name === e.hint), `${e.item}: hint ${String(e.hint)}, got ${JSON.stringify(e.enchants)}`)
      // three levels and three lapis a time (Player.onEnchantmentPerformed)
      assert.strictEqual(e.levelBefore - e.levelAfter, 3)
      assert.strictEqual(e.lapisUsed, 3)
    }
    assert.strictEqual(experience(bot).level, 85)
    assert.strictEqual(countItems(bot, 'lapis_lazuli'), 64 - 15)
    // the boots went back on, enchanted
    const boots = bot.inventory.slots[bot.getEquipmentDestSlot('feet')]
    assert.strictEqual(boots?.name, 'diamond_boots')
    assert.ok((boots?.enchants.length ?? 0) > 0)
    const sword = bot.inventory.items().find(i => i.name === 'diamond_sword')
    assert.ok(sword != null && sword.enchants.length > 0)
    console.log('  enchanted:', enchanted.map(e => `${e.item} [${e.enchants.map(x => `${x.name ?? '?'} ${x.lvl}`).join(', ')}] (hint ${e.hint ?? '-'})`).join('; '))

    // an enchanted item has no offers: none to take
    await assert.rejects(enchant(bot, { item: 'diamond_sword' }), /no unenchanted diamond_sword/)
    // with 10 levels and the top offer asked for: told to wait for 30
    await give('iron_pickaxe', 1)
    await run(`xp set ${USERNAME} 10 levels`)
    assert.ok(await waitUntil(bot, () => experience(bot).level === 10, 40))
    await assert.rejects(enchant(bot, { item: 'iron_pickaxe', waitForTop: true }), (err: any) => err.code === 'MISSING_ITEMS' && err.partial?.needLevels === 30)
    // without waiting: the best offer 10 levels pay for
    const pick = await enchant(bot, { item: 'iron_pickaxe' })
    assert.ok(pick.cost <= 10 && pick.enchants.length > 0)
    assert.strictEqual(pick.levelAfter, 10 - (pick.slot + 1))
  })

  it('gains levels mining experience ores, and by smelting raw iron and taking the ingots', async () => {
    await give('iron_pickaxe', 1)
    const ores = ['diamond_ore', 'diamond_ore', 'lapis_ore', 'lapis_ore', 'redstone_ore', 'redstone_ore', 'coal_ore', 'coal_ore']
    for (const [i, ore] of ores.entries()) await setblock(at(-4 + i, -1, 3), ore)
    const mined = await gainLevels(bot, { level: 2, sources: ['ore'] })
    assert.ok(mined.level >= 2, `level ${mined.level}`)
    assert.ok(mined.mined >= 1 && mined.points >= 16)
    assert.strictEqual(experience(bot).level, mined.level)

    await run(`xp set ${USERNAME} 0 levels`)
    await run(`xp set ${USERNAME} 0 points`)
    assert.ok(await waitUntil(bot, () => experience(bot).level === 0 && experience(bot).progress === 0, 40))
    await give('raw_iron', 10)
    await give('coal', 2)
    await give('furnace', 1)
    // 10 × 0.7 = 7 points: level 1
    const smelted = await gainLevels(bot, { level: 1, sources: ['smelt'] })
    assert.strictEqual(smelted.smelted, 10)
    assert.strictEqual(experience(bot).level, 1)
    assert.strictEqual(countItems(bot, 'iron_ingot'), 10)
  })

  it('at an anvil: puts a looted sharpness book on a sword (applyBooks) and repairs a pickaxe with diamonds', async () => {
    await setblock(at(3, 0, 0), 'anvil')
    await give('diamond_sword', 1)
    await run(`give ${USERNAME} enchanted_book[stored_enchantments={"minecraft:sharpness":3}] 1`)
    assert.ok(await waitUntil(bot, () => countItems(bot, 'enchanted_book') === 1, 40))
    await run(`give ${USERNAME} diamond_pickaxe[damage=1000] 1`)
    assert.ok(await waitUntil(bot, () => countItems(bot, 'diamond_pickaxe') === 1, 40))
    await give('diamond', 2)
    await run(`xp add ${USERNAME} 20 levels`)
    assert.ok(await waitUntil(bot, () => experience(bot).level === 20, 40))

    const books = await applyBooks(bot)
    assert.strictEqual(books.length, 1)
    assert.strictEqual(books[0].item, 'diamond_sword')
    assert.deepStrictEqual(books[0].enchants.map(e => `${e.name ?? '?'} ${e.lvl}`), ['sharpness 3'])
    assert.strictEqual(countItems(bot, 'enchanted_book'), 0)
    const sword = bot.inventory.items().find(i => i.name === 'diamond_sword')
    assert.deepStrictEqual(sword?.enchants.map(e => e.name), ['sharpness'])
    assert.strictEqual(experience(bot).level, 20 - books[0].cost)

    // two diamonds put back half the pickaxe's 1561 (ItemStack.getMaxDamage / 4 each): 1000 damage to 220
    const levels = experience(bot).level
    const repaired = await repairItem(bot, { item: 'diamond_pickaxe' })
    assert.strictEqual(repaired.item, 'diamond_pickaxe')
    assert.strictEqual(repaired.damage, 1000 - 2 * Math.floor(1561 / 4))
    assert.strictEqual(countItems(bot, 'diamond'), 0)
    assert.strictEqual(experience(bot).level, levels - repaired.cost)
    const pick = bot.inventory.items().find(i => i.name === 'diamond_pickaxe') as any
    assert.strictEqual(pick?.durabilityUsed, repaired.damage)
  })

  it('from nothing, by water: harvests sugar cane leaving the bottom blocks, chops a log, and crafts paper', async () => {
    // a strip of water in the ground, three columns of cane on the grass beside it, a log a few blocks off
    for (let dz = -1; dz <= 1; dz++) await setblock(at(4, -1, dz), 'water')
    for (let dz = -1; dz <= 1; dz++) for (let dy = 0; dy < 3; dy++) await setblock(at(5, dy, dz), 'sugar_cane')
    await setblock(at(-3, 0, 2), 'oak_log')

    const cane = await harvestSugarCane(bot, { count: 3 })
    assert.ok(countItems(bot, 'sugar_cane') >= 3, `${countItems(bot, 'sugar_cane')} sugar cane`)
    assert.ok(cane.mined >= 2)
    // every column keeps its bottom block, the harvested ones lose the rest
    for (let dz = -1; dz <= 1; dz++) assert.strictEqual(bot.blockAt(at(5, 0, dz))?.name, 'sugar_cane')
    const cut = [-1, 0, 1].filter(dz => bot.blockAt(at(5, 1, dz))?.name !== 'sugar_cane')
    assert.strictEqual(cut.length, cane.mined)
    for (const dz of cut) assert.strictEqual(bot.blockAt(at(5, 2, dz))?.name, 'air')

    await collectBlock(bot, { names: ['oak_log'], count: 1 })
    const paper = await craft(bot, { item: 'paper', count: 3 })
    assert.strictEqual(paper.crafted, 3)
    assert.strictEqual(paper.placedTable, true)
    assert.strictEqual(countItems(bot, 'paper'), 3)
  })
})
