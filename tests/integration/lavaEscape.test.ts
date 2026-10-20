// Out of a wide shallow lava pool against a real server (SURVIVAL_VERSION): no ground within 16 blocks, the bot puts
// a block into the lava beside it against the pool's floor and climbs out onto it (escapeHazard's blockToClimb). The
// bot has fire resistance for the test, so it lives to be checked.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert'
import type { Bot } from 'mineflayer'
import { createPlugin } from '../../src'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { escapeHazard, inHazard } from '../../src/skills/escape'
import { countItems, waitUntil } from '../../src/skills/util'

const USERNAME = 'lavabot'

describe(`out of a wide lava pool on a ${DEFAULT_VERSION} server`, { timeout: 10 * 60 * 1000 }, () => {
  let server: TestServer
  let bot: Bot
  const run = async (cmd: string): Promise<string> => (await server.command(cmd)).join(' | ')

  before(async () => {
    server = await startServer({ flat: true, seed: 'lava', difficulty: 'peaceful', gamerules: { advance_time: false, spawn_mobs: false, advance_weather: false } })
    bot = await connectLockstepBot(server, { username: USERNAME, op: true } as any)
    await bot.waitForChunksToLoad()
    bot.loadPlugin(createPlugin({ reflexes: false }))
  })
  after(async () => {
    if (bot != null) await quitBot(bot)
    if (server != null) await server.cleanup()
  })

  it('climbs out on a block it puts in the lava', async () => {
    const o = bot.entity.position.floored()
    const xyz = (dx: number, dy: number, dz: number): string => `${o.x + dx} ${o.y + dy} ${o.z + dz}`
    await run(`fill ${xyz(-20, -2, -20)} ${xyz(20, -2, 20)} stone`)
    await run(`fill ${xyz(-20, -1, -20)} ${xyz(20, -1, 20)} lava`)
    await run(`fill ${xyz(-20, 0, -20)} ${xyz(20, 3, 20)} air`)
    await run(`clear ${USERNAME}`)
    await run(`give ${USERNAME} cobblestone 16`)
    await run(`effect give ${USERNAME} fire_resistance 120 0 true`)
    await run(`tp ${USERNAME} ${o.x + 0.5} ${o.y - 1} ${o.z + 0.5}`)
    assert.ok(await waitUntil(bot, () => countItems(bot, 'cobblestone') > 0 && inHazard(bot), 100))
    await escapeHazard(bot, { maxTicks: 300 })
    assert.equal(inHazard(bot), false)
    assert.ok(countItems(bot, 'cobblestone') < 16)
  })

  it('pours its water bucket into the lava of a walled pit it has no block to climb out of, and takes the water back', async () => {
    // (40 blocks over, at the flat ground's height) a 5 x 5 pit of lava a block deep, its walls 3 high
    const at = bot.entity.position.floored()
    const o = at.offset(40, 0, 0)
    o.y = -60
    const xyz = (dx: number, dy: number, dz: number): string => `${o.x + dx} ${o.y + dy} ${o.z + dz}`
    await run(`fill ${xyz(-3, -2, -3)} ${xyz(3, 2, 3)} stone`)
    await run(`fill ${xyz(-2, -1, -2)} ${xyz(2, -1, 2)} lava`)
    await run(`fill ${xyz(-2, 0, -2)} ${xyz(2, 4, 2)} air`)
    await run(`clear ${USERNAME}`)
    await run(`give ${USERNAME} water_bucket 1`)
    await run(`effect give ${USERNAME} fire_resistance 120 0 true`)
    await run(`tp ${USERNAME} ${o.x + 0.5} ${o.y - 1} ${o.z + 0.5}`)
    assert.ok(await waitUntil(bot, () => countItems(bot, 'water_bucket') > 0 && inHazard(bot) && bot.entity.position.distanceTo(o.offset(0.5, -1, 0.5)) < 1.5, 100))
    await escapeHazard(bot, { maxTicks: 300 })
    assert.equal(inHazard(bot), false)
    assert.equal(countItems(bot, 'water_bucket'), 1, 'the water scooped back')
  })
})
