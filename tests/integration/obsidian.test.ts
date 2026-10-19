// Obsidian from a lava lake with a water bucket against a real server (SURVIVAL_VERSION): a 4 x 4 lake let into
// stone with no shore at its level (the rim a block over it), the bot on the rim; obsidianFromLava makes 10.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { createPlugin } from '../../src'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { obsidianFromLava } from '../../src/nether/obsidian'
import { countItems, waitUntil } from '../../src/skills/util'

const USERNAME = 'obsidianbot'

describe(`obsidian from a lava lake on a ${DEFAULT_VERSION} server`, { timeout: 10 * 60 * 1000 }, () => {
  let server: TestServer
  let bot: Bot
  const run = async (cmd: string): Promise<string> => (await server.command(cmd)).join(' | ')

  before(async () => {
    server = await startServer({ flat: true, seed: 'obsidian', difficulty: 'peaceful', gamerules: { advance_time: false, spawn_mobs: false, advance_weather: false } })
    bot = await connectLockstepBot(server, { username: USERNAME })
    await bot.waitForChunksToLoad()
    bot.loadPlugin(createPlugin({ reflexes: false }))
  })
  after(async () => {
    if (bot != null) await quitBot(bot)
    if (server != null) await server.cleanup()
  })

  it('turns a shoreless lake\'s lava to obsidian and mines 10', async () => {
    const o = bot.entity.position.floored()
    const xyz = (dx: number, dy: number, dz: number): string => `${o.x + dx} ${o.y + dy} ${o.z + dz}`
    await run(`fill ${xyz(-8, -4, -8)} ${xyz(8, -1, 8)} stone`)
    await run(`fill ${xyz(-8, 0, -8)} ${xyz(8, 6, 8)} air`)
    // the lake: 4 x 4 at y -2, under a rim of stone at y -1 except over the lake (open above)
    await run(`fill ${xyz(2, -2, 2)} ${xyz(5, -2, 5)} lava`)
    await run(`fill ${xyz(2, -1, 2)} ${xyz(5, -1, 5)} air`)
    await run(`clear ${USERNAME}`)
    for (const [item, n] of [['water_bucket', 1], ['bucket', 2], ['diamond_pickaxe', 1], ['cobblestone', 16]] as const) await run(`give ${USERNAME} ${item} ${n}`)
    await run(`tp ${USERNAME} ${o.x + 0.5} ${o.y} ${o.z + 0.5}`)
    assert.ok(await waitUntil(bot, () => countItems(bot, 'cobblestone') > 0 && bot.blockAt(o.offset(2, -2, 2))?.name === 'lava', 200))
    const got = await obsidianFromLava(bot, 10)
    console.log(`obsidianFromLava: ${got} obsidian, water bucket ${countItems(bot, 'water_bucket')}`)
    assert.ok(got >= 10, `${got} obsidian`)
    assert.strictEqual(countItems(bot, 'water_bucket'), 1)
  })
})
