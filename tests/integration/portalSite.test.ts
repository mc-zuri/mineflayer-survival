// A placed portal where no flat clear ground is (a cave) against a real server (SURVIVAL_VERSION): the bot in a pocket
// in stone with 10 obsidian; preparePortalSite digs a site out and buildPortal places and lights the frame there.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert'
import type { Bot } from 'mineflayer'
import { createPlugin } from '../../src'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { buildPortal, choosePortalSite, blockGetter, preparePortalSite } from '../../src/nether/skills'
import { countItems, waitUntil } from '../../src/skills/util'

const USERNAME = 'sitebot'

describe(`a portal site dug out of a cave on a ${DEFAULT_VERSION} server`, { timeout: 10 * 60 * 1000 }, () => {
  let server: TestServer
  let bot: Bot
  const run = async (cmd: string): Promise<string> => (await server.command(cmd)).join(' | ')

  before(async () => {
    server = await startServer({ flat: true, seed: 'site', difficulty: 'peaceful', gamerules: { advance_time: false, spawn_mobs: false, advance_weather: false } })
    bot = await connectLockstepBot(server, { username: USERNAME })
    await bot.waitForChunksToLoad()
    bot.loadPlugin(createPlugin({ reflexes: false }))
  })
  after(async () => {
    if (bot != null) await quitBot(bot)
    if (server != null) await server.cleanup()
  })

  it('digs a site, then places and lights the frame', async () => {
    const o = bot.entity.position.floored()
    const xyz = (dx: number, dy: number, dz: number): string => `${o.x + dx} ${o.y + dy} ${o.z + dz}`
    await run(`fill ${xyz(-20, -3, -20)} ${xyz(20, 8, 20)} stone`)
    await run(`fill ${xyz(0, 0, 0)} ${xyz(0, 1, 0)} air`)
    await run(`clear ${USERNAME}`)
    for (const [item, n] of [['obsidian', 10], ['flint_and_steel', 1], ['diamond_pickaxe', 1], ['cobblestone', 16]] as const) await run(`give ${USERNAME} ${item} ${n}`)
    await run(`tp ${USERNAME} ${o.x + 0.5} ${o.y} ${o.z + 0.5}`)
    assert.ok(await waitUntil(bot, () => countItems(bot, 'obsidian') >= 10 && bot.blockAt(o.offset(1, 0, 0))?.name === 'stone', 200))
    assert.equal(choosePortalSite(blockGetter(bot), bot.entity.position, { radius: 16 }), null)
    const site = await preparePortalSite(bot)
    const res = await buildPortal(bot, { method: 'obsidian', origin: site.origin, axis: site.axis })
    console.log(`portal: ${res.portal.length} portal blocks`)
    assert.ok(res.portal.length > 0)
  })
})
