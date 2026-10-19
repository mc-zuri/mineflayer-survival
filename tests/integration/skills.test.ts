// The gathering skills against a real server (SURVIVAL_VERSION, default 1.21.11) (the tests/harness lockstep server and bot): each scenario sets up
// a patch of a superflat world with commands, runs the skills, and checks the inventory and the world.
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { createPlugin } from '../../src'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import {
  castObsidian, collectBlock, countItems, craft, emptyBucket, fillBucket, retrieveItems, sleep, smelt, storeItems, waitTicks, waitUntil
} from '../../src/skills/gather'

const USERNAME = 'skillbot'
// the superflat's grass is at y = -61; the bot stands at -60
const GROUND = -61

describe(`gathering skills on a ${DEFAULT_VERSION} server`, { timeout: 15 * 60 * 1000 }, () => {
  let server: TestServer
  let bot: Bot
  let origin: Vec3

  const run = async (cmd: string): Promise<string> => (await server.command(cmd)).join(' ')
  const at = (dx: number, dy: number, dz: number): Vec3 => origin.offset(dx, dy, dz)
  const xyz = (pos: Vec3): string => `${pos.x} ${pos.y} ${pos.z}`

  before(async () => {
    server = await startServer({
      flat: true,
      seed: 'gather',
      difficulty: 'peaceful',
      gamerules: { advance_weather: false, spawn_mobs: false, spawn_monsters: false },
      properties: { 'spawn-protection': 0 }
    })
    bot = await connectLockstepBot(server, { username: USERNAME })
    await bot.waitForChunksToLoad()
    bot.loadPlugin(createPlugin({ reflexes: false }))
    origin = new Vec3(Math.floor(bot.entity.position.x), GROUND + 1, Math.floor(bot.entity.position.z))
  })

  after(async () => {
    if (bot != null) await quitBot(bot)
    if (server != null) await server.cleanup()
  })

  // a clean patch: grass and air, no items about, an empty inventory, the bot at the origin by day
  beforeEach(async () => {
    await run(`fill ${xyz(at(-12, 0, -12))} ${xyz(at(12, 10, 12))} air`)
    await run(`fill ${xyz(at(-12, -1, -12))} ${xyz(at(12, -1, 12))} grass_block`)
    await run(`fill ${xyz(at(-12, -2, -12))} ${xyz(at(12, -2, 12))} dirt`)
    await run('kill @e[type=item]')
    await run(`clear ${USERNAME}`)
    await run('time set 1000')
    await run('weather clear')
    await run(`tp ${USERNAME} ${origin.x + 0.5} ${origin.y} ${origin.z + 0.5}`)
    const settled = await waitUntil(bot, () => bot.entity.position.distanceTo(origin.offset(0.5, 0, 0.5)) < 0.1 && bot.inventory.items().length === 0 && bot.blockAt(at(0, -1, 0))?.name === 'grass_block', 100)
    assert.ok(settled, `the bot is at ${bot.entity.position.toString()} with ${bot.inventory.items().map(item => `${item.slot}:${item.name}x${item.count}`).join(" ")}`)
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

  it('chops 5 logs, then crafts a wooden pickaxe', async () => {
    for (let dy = 0; dy < 5; dy++) await setblock(at(3, dy, 2), 'oak_log')

    const chopped = await collectBlock(bot, { names: ['oak_log'], count: 5 })
    assert.strictEqual(chopped.mined, 5)
    assert.strictEqual(chopped.count, 5)
    assert.deepStrictEqual(chopped.items, { oak_log: 5 })
    assert.strictEqual(countItems(bot, 'oak_log'), 5)
    for (let dy = 0; dy < 5; dy++) assert.strictEqual(bot.blockAt(at(3, dy, 2))?.name, 'air')

    const crafted = await craft(bot, { item: 'wooden_pickaxe' })
    assert.strictEqual(crafted.crafted, 1)
    assert.strictEqual(crafted.placedTable, true)
    assert.strictEqual(countItems(bot, 'wooden_pickaxe'), 1)
    assert.ok(crafted.table != null)
    assert.strictEqual(bot.blockAt(crafted.table)?.name, 'crafting_table')
  })

  it('mines 3 cobblestone, then crafts a furnace at a table nearby', async () => {
    await give('wooden_pickaxe', 1)
    await give('cobblestone', 5)
    for (let dx = 0; dx < 3; dx++) await setblock(at(-3 - dx, 0, 3), 'stone')
    await setblock(at(2, 0, -2), 'crafting_table')

    const mined = await collectBlock(bot, { names: ['stone'], count: 3 })
    assert.strictEqual(mined.mined, 3)
    assert.strictEqual(mined.count, 3)
    assert.strictEqual(mined.items.cobblestone, 3)
    assert.strictEqual(countItems(bot, 'cobblestone'), 8)

    const crafted = await craft(bot, { item: 'furnace' })
    assert.strictEqual(crafted.crafted, 1)
    assert.strictEqual(crafted.placedTable, false)
    assert.deepStrictEqual(crafted.table?.toArray(), at(2, 0, -2).toArray())
    assert.strictEqual(countItems(bot, 'furnace'), 1)
    assert.strictEqual(countItems(bot, 'cobblestone'), 0)
  })

  it('smelts 3 raw iron in a furnace it places', async () => {
    await give('raw_iron', 3)
    await give('coal', 2)
    await give('furnace', 1)

    const smelted = await smelt(bot, { input: 'raw_iron', count: 3 })
    assert.strictEqual(smelted.output, 'iron_ingot')
    assert.strictEqual(smelted.count, 3)
    assert.strictEqual(smelted.placedFurnace, true)
    assert.deepStrictEqual(smelted.fuel, { coal: 1 })
    assert.ok(smelted.ticks >= 3 * 200, `smelted in ${smelted.ticks} ticks`)
    assert.strictEqual(countItems(bot, 'iron_ingot'), 3)
    assert.strictEqual(countItems(bot, 'raw_iron'), 0)
    // the fuel left over came back
    assert.strictEqual(countItems(bot, 'coal'), 1)
    assert.strictEqual(bot.blockAt(smelted.furnace)?.name, 'furnace')
  })

  it('stores items in a chest, then takes some back', async () => {
    const chest = at(-2, 0, -2)
    await setblock(chest, 'chest')
    await give('cobblestone', 20)
    await give('oak_planks', 10)

    const stored = await storeItems(bot, { chest, filter: ['cobblestone'] })
    assert.deepStrictEqual(stored.moved, { cobblestone: 20 })
    assert.strictEqual(countItems(bot, 'cobblestone'), 0)
    assert.strictEqual(countItems(bot, 'oak_planks'), 10)

    const retrieved = await retrieveItems(bot, { chest, filter: 'cobblestone', count: 12 })
    assert.deepStrictEqual(retrieved.moved, { cobblestone: 12 })
    assert.strictEqual(countItems(bot, 'cobblestone'), 12)

    // what's left in the chest, opened afresh
    const window = await bot.openContainer(bot.blockAt(chest) as any)
    const left = window.containerItems().reduce((n, item) => n + (item.name === 'cobblestone' ? item.count : 0), 0)
    window.close()
    assert.strictEqual(left, 8)
  })

  it('takes planks out of a chest, then crafts sticks in its own grid with the inventory menu\'s state id', async () => {
    // (26.3 seeds 2 and 3: "craft 4 stick: VERIFY_FAILED: crafting stick x1 gave 0 of 4" after a loot or a table's
    // craft: the clicks went with the chest's state id, each answered with the whole inventory)
    const chest = at(-2, 0, -2)
    await setblock(chest, 'chest')
    await give('oak_planks', 6)
    await storeItems(bot, { chest, filter: ['oak_planks'] })
    await retrieveItems(bot, { chest, filter: 'oak_planks', count: 2 })
    assert.strictEqual(countItems(bot, 'oak_planks'), 2)

    let resyncs = 0
    const onItems = (packet: any): void => { if (packet.windowId === 0) resyncs++ }
    bot._client.on('window_items', onItems)
    try {
      const crafted = await craft(bot, { item: 'stick', count: 4 })
      assert.strictEqual(crafted.crafted, 4)
    } finally {
      bot._client.off('window_items', onItems)
    }
    assert.strictEqual(countItems(bot, 'stick'), 4)
    assert.strictEqual(countItems(bot, 'oak_planks'), 0)
    // the craft's own resync (resyncInventory) only: no click went with a state id behind the server's
    assert.strictEqual(resyncs, 1)
  })

  it('crafts 64 planks while items come into the bag between its clicks', async () => {
    // (26.3 enchant run u: "crafting oak_planks x18 failed: Error: missing ingredient" holding 61 logs: an item picked
    // up as the clicks went made them behind the menu's state id, the server answered each with the whole menu, and the
    // craft's next clicks went from that menu, with the logs on the cursor, not in the slot the craft took them from)
    await give('oak_log', 20)
    let going = true
    const pickups = (async () => {
      for (let i = 0; going && i < 400; i++) await run(`give ${USERNAME} dirt 1`)
    })()
    try {
      const crafted = await craft(bot, { item: 'oak_planks', count: 64 })
      assert.strictEqual(crafted.crafted, 64)
    } finally {
      going = false
      await pickups
    }
    assert.strictEqual(countItems(bot, 'oak_planks'), 64)
    assert.strictEqual(countItems(bot, 'oak_log'), 4)
    // nothing left in the grid or on the cursor, nor made of planks (a button)
    assert.deepStrictEqual(bot.inventory.slots.slice(0, 5).map(item => item?.name ?? null), [null, null, null, null, null])
    assert.strictEqual(bot.inventory.selectedItem, null)
    assert.strictEqual(countItems(bot, 'oak_button'), 0)
  })

  it('takes lava up in a bucket, pours it back, and casts it to obsidian with water', async () => {
    const pit = at(3, -1, 0)
    await setblock(pit, 'lava')
    await give('bucket', 1)
    await give('water_bucket', 1)

    const filled = await fillBucket(bot, { fluid: 'lava', pos: pit })
    assert.strictEqual(filled.item, 'lava_bucket')
    assert.strictEqual(countItems(bot, 'lava_bucket'), 1)
    assert.ok(await waitUntil(bot, () => bot.blockAt(pit)?.name === 'air', 20), `${bot.blockAt(pit)?.name} in the pit`)

    await emptyBucket(bot, { pos: pit, fluid: 'lava' })
    assert.strictEqual(bot.blockAt(pit)?.name, 'lava')
    assert.strictEqual(countItems(bot, 'lava_bucket'), 0)

    const cast = await castObsidian(bot, { lava: pit })
    assert.deepStrictEqual(cast.obsidian.toArray(), pit.toArray())
    assert.strictEqual(bot.blockAt(pit)?.name, 'obsidian')
    assert.strictEqual(cast.waterRecovered, true)
    assert.strictEqual(countItems(bot, 'water_bucket'), 1)
    await waitTicks(bot, 40)
    assert.notStrictEqual(bot.blockAt(cast.water)?.name, 'water')
  })

  it('sleeps through the night in a bed it places', async () => {
    await give('red_bed', 1)
    await run('time set 13000')
    assert.ok(await waitUntil(bot, () => bot.time.timeOfDay >= 13000, 40))

    const slept = await sleep(bot, {})
    assert.strictEqual(slept.placedBed, true)
    assert.strictEqual(bot.blockAt(slept.bed)?.name, 'red_bed')
    assert.ok(await waitUntil(bot, () => bot.time.timeOfDay < 12000, 40), `time of day ${bot.time.timeOfDay} after sleeping`)
  })
})
