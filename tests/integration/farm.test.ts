// A wheat farm against a real server (SURVIVAL_VERSION): a water hole let into flat grass with sugar cane on two of its
// sides (the cane farm's hole, which the herd's wheat farm took on 26.3), the bot with a hoe and seeds; plantFarm sows.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert'
import type { Bot } from 'mineflayer'
import { createPlugin } from '../../src'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { plantFarm } from '../../src/skills/farm'
import { countItems, waitUntil } from '../../src/skills/util'

const USERNAME = 'farmbot'

describe(`a wheat farm on a ${DEFAULT_VERSION} server`, { timeout: 10 * 60 * 1000 }, () => {
  let server: TestServer
  let bot: Bot
  const run = async (cmd: string): Promise<string> => (await server.command(cmd)).join(' | ')

  before(async () => {
    server = await startServer({ flat: true, seed: 'farm', difficulty: 'peaceful', gamerules: { advance_time: false, spawn_mobs: false, advance_weather: false } })
    bot = await connectLockstepBot(server, { username: USERNAME })
    await bot.waitForChunksToLoad()
    bot.loadPlugin(createPlugin({ reflexes: false }))
  })
  after(async () => {
    if (bot != null) await quitBot(bot)
    if (server != null) await server.cleanup()
  })

  it('tills and sows the grass by a water hole with canes on two sides', async () => {
    const o = bot.entity.position.floored()
    const xyz = (dx: number, dy: number, dz: number): string => `${o.x + dx} ${o.y + dy} ${o.z + dz}`
    await run(`fill ${xyz(-8, -3, -8)} ${xyz(8, -2, 8)} dirt`)
    await run(`fill ${xyz(-8, -1, -8)} ${xyz(8, -1, 8)} grass_block`)
    await run(`fill ${xyz(-8, 0, -8)} ${xyz(8, 6, 8)} air`)
    await run(`setblock ${xyz(3, -1, 3)} water`)
    await run(`setblock ${xyz(4, 0, 3)} sugar_cane`)
    await run(`setblock ${xyz(3, 0, 4)} sugar_cane`)
    await run(`clear ${USERNAME}`)
    for (const [item, n] of [['wooden_hoe', 1], ['wheat_seeds', 16]] as const) await run(`give ${USERNAME} ${item} ${n}`)
    // a shield in the off hand, as a run's kit has (every till failed with one on 26.3)
    await run(`item replace entity ${USERNAME} weapon.offhand with shield`)
    await run(`tp ${USERNAME} ${o.x + 0.5} ${o.y} ${o.z + 0.5}`)
    assert.ok(await waitUntil(bot, () => countItems(bot, 'wheat_seeds') > 0 && bot.blockAt(o.offset(3, -1, 3))?.name === 'water', 200))
    const res = await plantFarm(bot, { seed: 'wheat_seeds', center: bot.entity.position, plots: 8 })
    console.log(`plantFarm: ${res.cells.length} sown by ${res.water.toString()}`)
    assert.ok(res.cells.length >= 4, `${res.cells.length} sown`)
  })
})
