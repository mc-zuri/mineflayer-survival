// A water bucket poured into a lava source's own cell, against a real server (SURVIVAL_VERSION): the full bucket's
// ray ignores the lava and lands on the floor under it, so the water goes into the lava's cell (a fluid's cell can be
// replaced: BucketItem.emptyContents). The lava there is replaced by a water source, which the bucket scoops back up,
// and the lava sources beside it turn to obsidian (LiquidBlock.shouldSpreadLiquid). obsidianFromLava pours there when
// a pool has no shore to pour on.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { createPlugin } from '../../src'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { countItems, findInventoryItem, waitUntil } from '../../src/skills/util'
import { isSource } from '../../src/skills/bucket'
import { obsidianFromLava } from '../../src/nether/obsidian'

const USERNAME = 'pourbot'

describe(`a water bucket poured into a lava source on a ${DEFAULT_VERSION} server`, { timeout: 5 * 60 * 1000 }, () => {
  let server: TestServer
  let bot: Bot
  const run = async (cmd: string): Promise<string> => (await server.command(cmd)).join(' | ')

  before(async () => {
    server = await startServer({ flat: true, seed: 'pourlava', difficulty: 'peaceful', gamerules: { advance_time: false, spawn_mobs: false, advance_weather: false } })
    bot = await connectLockstepBot(server, { username: USERNAME })
    await bot.waitForChunksToLoad()
    bot.loadPlugin(createPlugin({ reflexes: false }))
  })
  after(async () => {
    if (bot != null) await quitBot(bot)
    if (server != null) await server.cleanup()
  })

  it('replaces the lava with a water source (scooped back), the lava beside it turned to obsidian', async () => {
    const o = bot.entity.position.floored()
    const xyz = (dx: number, dy: number, dz: number): string => `${o.x + dx} ${o.y + dy} ${o.z + dz}`
    await run(`fill ${xyz(-6, -4, -6)} ${xyz(6, -1, 6)} stone`)
    await run(`fill ${xyz(-6, 0, -6)} ${xyz(6, 5, 6)} air`)
    // three lava sources in a row let into the stone at y -1 (x 2 to 4), open above
    await run(`fill ${xyz(2, -1, 0)} ${xyz(4, -1, 0)} lava`)
    await run(`clear ${USERNAME}`)
    await run(`give ${USERNAME} water_bucket 1`)
    // (on the stone by the middle source: the ray down through its cell to the floor, over no other block)
    await run(`tp ${USERNAME} ${o.x + 3.5} ${o.y} ${o.z - 0.5}`)
    const mid = o.offset(3, -1, 0)
    assert.ok(await waitUntil(bot, () => countItems(bot, 'water_bucket') > 0 && isSource(bot.blockAt(mid) as any, 'lava') && bot.entity.position.distanceTo(o.offset(3.5, 0, -0.5)) < 0.2 && bot.entity.onGround, 200))
    // the floor under the middle source: its top face, the full bucket's ray going through the lava to it
    await bot.equip(findInventoryItem(bot, 'water_bucket')!, 'hand')
    const aim = o.offset(3.5, -0.999, 0.5)
    const eye = bot.entity.position.offset(0, 1.62, 0)
    const hit: any = bot.world.raycast(eye, aim.minus(eye).normalize(), 5)
    console.log(`the ray from ${eye} hits ${hit?.name} at ${hit?.position} face ${hit?.face}`)
    await bot.lookAt(aim, true)
    await waitUntil(bot, () => false, 3)
    bot.activateItem()
    await waitUntil(bot, () => false, 40)
    const names = [2, 3, 4].map(dx => bot.blockAt(o.offset(dx, -1, 0))?.name)
    const over = [2, 3, 4].map(dx => `${bot.blockAt(o.offset(dx, 0, 0))?.name}/${(bot.blockAt(o.offset(dx, 0, 0)) as any)?.getProperties?.()?.level}`)
    console.log(`after the pour into (3, -1, 0): ${names.join(', ')}; over them ${over.join(', ')}; the middle a source ${isSource(bot.blockAt(mid) as any, 'water')}`)
    assert.strictEqual(names[1], 'water')
    assert.ok(isSource(bot.blockAt(mid) as any, 'water'), 'the middle is no water source')
    assert.strictEqual(names[0], 'obsidian')
    assert.strictEqual(names[2], 'obsidian')
    // the water back up in the bucket
    await bot.lookAt(mid.offset(0.5, 0.8, 0.5), true)
    await waitUntil(bot, () => false, 3)
    bot.activateItem()
    assert.ok(await waitUntil(bot, () => countItems(bot, 'water_bucket') > 0, 20), 'no water bucket back')
  })

  it('obsidianFromLava pours into the own cell of a source where the pool has no shore and no block for a pedestal: 2 obsidian, the water back', async () => {
    const o = bot.entity.position.floored().offset(16, 0, 0)
    const xyz = (dx: number, dy: number, dz: number): string => `${o.x + dx} ${o.y + dy} ${o.z + dz}`
    await run(`fill ${xyz(-6, -4, -6)} ${xyz(6, -1, 6)} stone`)
    await run(`fill ${xyz(-6, 0, -6)} ${xyz(6, 5, 6)} air`)
    await run(`fill ${xyz(2, -1, 0)} ${xyz(4, -1, 0)} lava`)
    await run(`clear ${USERNAME}`)
    for (const [name, n] of [['water_bucket', 1], ['diamond_pickaxe', 1]] as const) await run(`give ${USERNAME} ${name} ${n}`)
    await run(`tp ${USERNAME} ${o.x + 0.5} ${o.y} ${o.z + 0.5}`)
    assert.ok(await waitUntil(bot, () => countItems(bot, 'diamond_pickaxe') > 0 && isSource(bot.blockAt(o.offset(3, -1, 0)) as any, 'lava') && bot.entity.position.distanceTo(o.offset(0.5, 0, 0.5)) < 0.5, 200))
    const got = await obsidianFromLava(bot, 2)
    console.log(`obsidianFromLava (no shore, no blocks): ${got} obsidian, water bucket ${countItems(bot, 'water_bucket')}`)
    assert.ok(got >= 2, `${got} obsidian`)
    assert.strictEqual(countItems(bot, 'water_bucket'), 1)
  })
})
