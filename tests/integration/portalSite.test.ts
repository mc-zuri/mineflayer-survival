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
    // a hole 3 deep under where every site's frame would stand (its ground filled from the bottom up)
    await run(`fill ${xyz(-2, -3, -2)} ${xyz(2, -1, 2)} air`)
    await run(`setblock ${xyz(0, -1, 0)} stone`)
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

describe(`a portal site a dig lets water into on a ${DEFAULT_VERSION} server`, { timeout: 10 * 60 * 1000 }, () => {
  let server: TestServer
  let bot: Bot
  const run = async (cmd: string): Promise<string> => (await server.command(cmd)).join(' | ')

  before(async () => {
    server = await startServer({ flat: true, seed: 'wetsite', difficulty: 'peaceful', gamerules: { advance_time: false, spawn_mobs: false, advance_weather: false } })
    bot = await connectLockstepBot(server, { username: USERNAME })
    await bot.waitForChunksToLoad()
    bot.loadPlugin(createPlugin({ reflexes: false }))
  })
  after(async () => {
    if (bot != null) await quitBot(bot)
    if (server != null) await server.cleanup()
  })

  it('plugs the water and fills the ground under it, then places and lights the frame', async () => {
    const o = bot.entity.position.floored()
    const xyz = (dx: number, dy: number, dz: number): string => `${o.x + dx} ${o.y + dy} ${o.z + dz}`
    await run(`fill ${xyz(-20, -3, -20)} ${xyz(20, 8, 20)} stone`)
    await run(`fill ${xyz(0, 0, 0)} ${xyz(0, 1, 0)} air`)
    // a hole 3 deep under where every site's frame would stand, as in the dry site's test
    await run(`fill ${xyz(-2, -3, -2)} ${xyz(2, -1, 2)} air`)
    await run(`setblock ${xyz(0, -1, 0)} stone`)
    // water sources hidden in the stone just past each site's outer row: the dig opens one of them
    for (const [x, z] of [[0, 4], [0, -4], [4, 0], [-4, 0]]) await run(`setblock ${xyz(x, 0, z)} water`)
    await run(`clear ${USERNAME}`)
    for (const [item, n] of [['obsidian', 10], ['flint_and_steel', 1], ['diamond_pickaxe', 1], ['cobblestone', 64]] as const) await run(`give ${USERNAME} ${item} ${n}`)
    await run(`tp ${USERNAME} ${o.x + 0.5} ${o.y} ${o.z + 0.5}`)
    assert.ok(await waitUntil(bot, () => countItems(bot, 'obsidian') >= 10 && bot.blockAt(o.offset(0, 0, 4))?.name === 'water' && bot.entity.position.distanceTo(o.offset(0.5, 0, 0.5)) < 1, 200))
    const site = await preparePortalSite(bot)
    const res = await buildPortal(bot, { method: 'obsidian', origin: site.origin, axis: site.axis })
    console.log(`wet site portal: ${res.portal.length} portal blocks`)
    assert.ok(res.portal.length > 0)
  })
})

describe(`a cast portal on a dug site in a cave on a ${DEFAULT_VERSION} server`, { timeout: 10 * 60 * 1000 }, () => {
  let server: TestServer
  let bot: Bot
  const run = async (cmd: string): Promise<string> => (await server.command(cmd)).join(' | ')

  before(async () => {
    server = await startServer({ flat: true, seed: 'castsite', difficulty: 'peaceful', gamerules: { advance_time: false, spawn_mobs: false, advance_weather: false } })
    bot = await connectLockstepBot(server, { username: USERNAME })
    await bot.waitForChunksToLoad()
    bot.loadPlugin(createPlugin({ reflexes: false }))
  })
  after(async () => {
    if (bot != null) await quitBot(bot)
    if (server != null) await server.cleanup()
  })

  it('casts the frame from lava carried in buckets on a site dug out of the stone', async () => {
    const { castPortalAway } = await import('../../src/nether/skills')
    const { Vec3 } = await import('vec3')
    const o = bot.entity.position.floored()
    const xyz = (dx: number, dy: number, dz: number): string => `${o.x + dx} ${o.y + dy} ${o.z + dz}`
    await run(`fill ${xyz(-20, -3, -20)} ${xyz(20, 8, 20)} stone`)
    await run(`fill ${xyz(0, 0, 0)} ${xyz(0, 1, 0)} air`)
    // a pool of 12 lava sources a corridor away (dug: y 0 to 1 from the bot to it)
    await run(`fill ${xyz(1, 0, 0)} ${xyz(8, 1, 0)} air`)
    await run(`fill ${xyz(6, -1, 1)} ${xyz(9, -1, 3)} lava`)
    await run(`fill ${xyz(6, 0, 1)} ${xyz(9, 1, 3)} air`)
    await run(`clear ${USERNAME}`)
    for (const [it, n] of [['bucket', 3], ['flint_and_steel', 1], ['diamond_pickaxe', 1], ['cobblestone', 64], ['water_bucket', 1]] as const) await run(`give ${USERNAME} ${it} ${n}`)
    await run(`tp ${USERNAME} ${o.x + 0.5} ${o.y} ${o.z + 0.5}`)
    assert.ok(await waitUntil(bot, () => countItems(bot, 'cobblestone') > 0 && bot.blockAt(o.offset(6, -1, 1))?.name === 'lava', 200))
    const lava: InstanceType<typeof Vec3>[] = []
    for (let x = 6; x <= 9; x++) for (let z = 1; z <= 3; z++) lava.push(o.offset(x, -1, z))
    const res = await castPortalAway(bot, lava, 3).catch(err => { console.log('inventory', bot.inventory.items().map(i => `${i.name}:${i.count}`).join(' ')); throw err })
    console.log(`cast away: ${res.portal.length} portal blocks`)
    assert.ok(res.portal.length > 0)
  })

  it('casts the rest of the frame from a 4-source pool with 6 obsidian carried', async () => {
    const { castPortalAway } = await import('../../src/nether/skills')
    const { Vec3 } = await import('vec3')
    // (40 blocks over, at the flat ground's standing height whatever pit the last test left the bot in)
    const at = bot.entity.position.floored()
    const o = new Vec3(at.x + 40, -60, at.z)
    const xyz = (dx: number, dy: number, dz: number): string => `${o.x + dx} ${o.y + dy} ${o.z + dz}`
    await run(`fill ${xyz(-20, -3, -20)} ${xyz(20, 8, 20)} stone`)
    await run(`fill ${xyz(0, 0, 0)} ${xyz(0, 1, 0)} air`)
    // a pool of 4 lava sources a corridor away (dug: y 0 to 1 from the bot to it)
    await run(`fill ${xyz(1, 0, 0)} ${xyz(8, 1, 0)} air`)
    await run(`fill ${xyz(6, -1, 1)} ${xyz(7, -1, 2)} lava`)
    await run(`fill ${xyz(6, 0, 1)} ${xyz(9, 1, 3)} air`)
    await run(`clear ${USERNAME}`)
    for (const [it, n] of [['bucket', 3], ['flint_and_steel', 1], ['diamond_pickaxe', 1], ['cobblestone', 64], ['water_bucket', 1], ['obsidian', 6]] as const) await run(`give ${USERNAME} ${it} ${n}`)
    await run(`tp ${USERNAME} ${o.x + 0.5} ${o.y} ${o.z + 0.5}`)
    assert.ok(await waitUntil(bot, () => countItems(bot, 'cobblestone') > 0 && bot.blockAt(o.offset(6, -1, 1))?.name === 'lava' && bot.entity.position.distanceTo(o.offset(0.5, 0, 0.5)) < 1, 200))
    const lava: InstanceType<typeof Vec3>[] = []
    for (let x = 6; x <= 7; x++) for (let z = 1; z <= 2; z++) lava.push(o.offset(x, -1, z))
    const res = await castPortalAway(bot, lava, 3).catch(err => { console.log('inventory', bot.inventory.items().map(i => `${i.name}:${i.count}`).join(' ')); throw err })
    console.log(`cast away with obsidian: ${res.portal.length} portal blocks, ${countItems(bot, 'obsidian')} obsidian left`)
    assert.ok(res.portal.length > 0)
    assert.strictEqual(countItems(bot, 'obsidian'), 0)
  })
})
