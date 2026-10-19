// Fires put out against a real server (SURVIVAL_VERSION): fire on netherrack about the bot (as a blaze's fireballs
// light it, burning for good), put out with a hit each (putOutFiresNear), and the bot standing in one got out of it
// (escapeHazard), also from a fire its box reaches into from the next cell (inHazard by the box's cells).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert'
import type { Bot } from 'mineflayer'
import { createPlugin } from '../../src'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { putOutFiresNear } from '../../src/nether/fortressSkills'
import { escapeHazard, inHazard } from '../../src/skills/escape'
import { waitUntil } from '../../src/skills/util'

const USERNAME = 'firebot'

describe(`fires put out on a ${DEFAULT_VERSION} server`, { timeout: 10 * 60 * 1000 }, () => {
  let server: TestServer
  let bot: Bot
  const run = async (cmd: string): Promise<string> => (await server.command(cmd)).join(' | ')

  before(async () => {
    server = await startServer({ flat: true, seed: 'fire', difficulty: 'peaceful', gamerules: { advance_time: false, spawn_mobs: false, advance_weather: false } })
    bot = await connectLockstepBot(server, { username: USERNAME })
    await bot.waitForChunksToLoad()
    bot.loadPlugin(createPlugin({ reflexes: false }))
  })
  after(async () => {
    if (bot != null) await quitBot(bot)
    if (server != null) await server.cleanup()
  })

  it('puts out the fires about the bot and gets it out of the one it stands in', async () => {
    const o = bot.entity.position.floored()
    const xyz = (dx: number, dy: number, dz: number): string => `${o.x + dx} ${o.y + dy} ${o.z + dz}`
    await run(`fill ${xyz(-6, -1, -6)} ${xyz(6, -1, 6)} netherrack`)
    await run(`fill ${xyz(-6, 0, -6)} ${xyz(6, 4, 6)} air`)
    await run(`tp ${USERNAME} ${o.x + 0.5} ${o.y} ${o.z + 0.5}`)
    for (const [dx, dz] of [[2, 0], [0, 2], [-1, 1]]) await run(`setblock ${xyz(dx, 0, dz)} fire`)
    await waitUntil(bot, () => [[2, 0], [0, 2], [-1, 1]].every(([dx, dz]) => bot.blockAt(o.offset(dx, 0, dz))?.name === 'fire'), 100)
    const lit = [[2, 0], [0, 2], [-1, 1]].filter(([dx, dz]) => bot.blockAt(o.offset(dx, 0, dz))?.name === 'fire').length
    const out = await putOutFiresNear(bot, 2)
    assert.ok(lit >= 2 && out === lit, `${out} of ${lit} put out`)
    assert.ok(await waitUntil(bot, () => [[2, 0], [0, 2], [-1, 1]].every(([dx, dz]) => bot.blockAt(o.offset(dx, 0, dz))?.name !== 'fire'), 20))
    // in a fire
    await run(`setblock ${xyz(0, 0, 0)} fire`)
    assert.ok(await waitUntil(bot, () => inHazard(bot), 40))
    await escapeHazard(bot, { maxTicks: 100 })
    assert.equal(inHazard(bot), false)
  })

  it('gets out of a fire its box reaches into from the next cell, its middle out of it', async () => {
    const o = bot.entity.position.floored()
    const xyz = (dx: number, dy: number, dz: number): string => `${o.x + dx} ${o.y + dy} ${o.z + dz}`
    await run(`fill ${xyz(-6, -1, -6)} ${xyz(6, -1, 6)} netherrack`)
    await run(`fill ${xyz(-6, 0, -6)} ${xyz(6, 4, 6)} air`)
    await run(`effect give ${USERNAME} minecraft:instant_health 1 10 true`)
    // the bot's middle at x + 0.75 of its cell: its box (0.6 wide) reaches 0.05 into the cell east of it
    await run(`tp ${USERNAME} ${o.x + 0.75} ${o.y} ${o.z + 0.5}`)
    await waitUntil(bot, () => Math.abs(bot.entity.position.x - (o.x + 0.75)) < 0.01 && bot.entity.onGround, 40)
    await run(`setblock ${xyz(1, 0, 0)} fire`)
    assert.ok(await waitUntil(bot, () => bot.blockAt(o.offset(1, 0, 0))?.name === 'fire', 40))
    assert.ok(await waitUntil(bot, () => inHazard(bot), 5), 'the fire beside the bot middle, in its box, is no hazard')
    const health = bot.health
    await escapeHazard(bot, { maxTicks: 100 })
    assert.equal(inHazard(bot), false)
    console.log(`out of the fire beside: health ${health} to ${bot.health}`)
  })
})
