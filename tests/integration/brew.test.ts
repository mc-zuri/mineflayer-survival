// Brewing against a real server (SURVIVAL_VERSION, default 1.21.11; the nether runs are 26.3), the tests/harness
// lockstep server and bot on a superflat patch: glass bottles filled at a water source (fillBottles), then fire
// resistance brewed of them (brew: a stand made of a blaze rod and 3 cobblestone at a crafting table and put down, a
// blaze powder made of the other rod for its fuel, the nether wart's awkward potion, then the magma cream's), three
// potions out of three bottles, and one drunk for the effect.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { createPlugin } from '../../src'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { countItems, waitUntil } from '../../src/skills/util'
import { fillBottles } from '../../src/skills/bucket'
import { POTION, brew, waterBottles } from '../../src/skills/brew'
import { drinkPotion, findPotion, hasEffect, potionOf } from '../../src/skills/potion'

const USERNAME = 'brewbot'
// the superflat's grass is at y = -61; the bot stands at -60
const GROUND = -61

describe(`brewing on a ${DEFAULT_VERSION} server`, { timeout: 10 * 60 * 1000 }, () => {
  let server: TestServer
  let bot: Bot
  let origin: Vec3
  let ticks = 0
  const run = async (cmd: string): Promise<string> => (await server.command(cmd)).join(' ')
  const xyz = (p: Vec3): string => `${p.x} ${p.y} ${p.z}`

  before(async () => {
    server = await startServer({
      flat: true,
      seed: 'brewing',
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
  })

  it('fills 3 glass bottles at a water source and brews them into 3 potions of fire resistance, one drunk', async () => {
    await run(`fill ${xyz(origin.offset(-8, 0, -8))} ${xyz(origin.offset(8, 6, 8))} air`)
    await run(`fill ${xyz(origin.offset(-8, -1, -8))} ${xyz(origin.offset(8, -1, 8))} grass_block`)
    // a pool of water 4 off: a source to fill the bottles at
    await run(`fill ${xyz(origin.offset(4, -1, 0))} ${xyz(origin.offset(5, -1, 1))} water`)
    await run(`clear ${USERNAME}`)
    await run('time set 1000')
    await run(`tp ${USERNAME} ${origin.x + 0.5} ${origin.y} ${origin.z + 0.5}`)
    for (const [item, n] of [['glass_bottle', 3], ['blaze_rod', 2], ['cobblestone', 3], ['crafting_table', 1], ['nether_wart', 1], ['magma_cream', 1]] as const) {
      await run(`give ${USERNAME} ${item} ${n}`)
    }
    assert.ok(await waitUntil(bot, () => countItems(bot, 'magma_cream') === 1 && countItems(bot, 'glass_bottle') === 3, 100), 'the items given')
    const t0 = ticks

    assert.strictEqual(await fillBottles(bot), 3)
    assert.strictEqual(waterBottles(bot), 3)
    const t1 = ticks

    const result = await brew(bot)
    console.log(`brew: bottles filled in ${t1 - t0} ticks, brewed in ${ticks - t1}; ${JSON.stringify(result)}`)
    assert.strictEqual(result.potion, POTION.fire_resistance)
    assert.strictEqual(result.potions, 3)
    const potions = bot.inventory.items().filter(i => i.name === 'potion' && potionOf(i) === POTION.fire_resistance)
    assert.strictEqual(potions.length, 3)
    // the stand taken back, the powder left over (2 made, 1 burnt), the ingredients used
    assert.strictEqual(countItems(bot, 'brewing_stand'), 1)
    assert.strictEqual(countItems(bot, 'blaze_powder'), 1)
    assert.strictEqual(countItems(bot, 'nether_wart') + countItems(bot, 'magma_cream'), 0)

    assert.ok(findPotion(bot, 'fire_resistance') != null)
    assert.ok(await drinkPotion(bot, 'fire_resistance'))
    assert.ok(hasEffect(bot, 'fire_resistance'))
  })

  it('with no water about, fills the bottles at the water its bucket pours, and takes the water back up', async () => {
    await run(`fill ${xyz(origin.offset(-8, 0, -8))} ${xyz(origin.offset(8, 6, 8))} air`)
    await run(`fill ${xyz(origin.offset(-8, -1, -8))} ${xyz(origin.offset(8, -1, 8))} grass_block`)
    await run(`clear ${USERNAME}`)
    await run(`tp ${USERNAME} ${origin.x + 0.5} ${origin.y} ${origin.z + 0.5}`)
    await run(`give ${USERNAME} glass_bottle 2`)
    await run(`give ${USERNAME} water_bucket 1`)
    assert.ok(await waitUntil(bot, () => countItems(bot, 'glass_bottle') === 2 && countItems(bot, 'water_bucket') === 1, 100), 'the items given')
    assert.strictEqual(await fillBottles(bot, { maxDistance: 8 }), 2)
    assert.strictEqual(waterBottles(bot), 2)
    assert.strictEqual(countItems(bot, 'water_bucket'), 1)
  })
})
