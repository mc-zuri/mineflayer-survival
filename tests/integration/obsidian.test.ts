// Obsidian from a lava lake with a water bucket against a real server (SURVIVAL_VERSION): a 4 x 4 lake let into
// stone with no shore at its level (the rim a block over it), the bot on the rim; obsidianFromLava makes 10.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { createPlugin } from '../../src'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { obsidianFromLava } from '../../src/nether/obsidian'
import { collectBlock } from '../../src/skills/collectBlock'
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

  let start: Vec3 | null = null
  it('turns a shoreless lake\'s lava to obsidian and mines 10', async () => {
    const o = bot.entity.position.floored()
    start = o
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

  it('turns the lava of a deep lake to obsidian, the pedestal put against its wall (its floor more lava)', async () => {
    // (beside the first test's ground, at its height)
    const o = (start ?? bot.entity.position.floored()).offset(24, 0, 0)
    const xyz = (dx: number, dy: number, dz: number): string => `${o.x + dx} ${o.y + dy} ${o.z + dz}`
    await run(`fill ${xyz(-8, -4, -8)} ${xyz(8, -1, 8)} stone`)
    await run(`fill ${xyz(-8, 0, -8)} ${xyz(8, 6, 8)} air`)
    // the lake: 4 x 4, 2 deep (y -3 to -2), under a rim of stone at y -1 except over the lake (the flat world's
    // bedrock at y -64 leaves no deeper)
    await run(`fill ${xyz(2, -3, 2)} ${xyz(5, -2, 5)} lava`)
    await run(`fill ${xyz(2, -1, 2)} ${xyz(5, -1, 5)} air`)
    await run(`clear ${USERNAME}`)
    for (const [item, n] of [['water_bucket', 1], ['bucket', 2], ['diamond_pickaxe', 1], ['cobblestone', 16]] as const) await run(`give ${USERNAME} ${item} ${n}`)
    await run(`tp ${USERNAME} ${o.x + 0.5} ${o.y} ${o.z + 0.5}`)
    assert.ok(await waitUntil(bot, () => countItems(bot, 'cobblestone') > 0 && bot.blockAt(o.offset(2, -3, 2))?.name === 'lava', 200))
    const got = await obsidianFromLava(bot, 4)
    console.log(`obsidianFromLava (deep): ${got} obsidian, water bucket ${countItems(bot, 'water_bucket')}`)
    assert.ok(got >= 4, `${got} obsidian`)
  })
  it('mines the obsidian it was given, passing over one that lava has come against since the list was made', async () => {
    // (beside the other tests' ground) obsidian at x 2 and x 4 sunk in the stone, the bot by them; then lava let in
    // against x 4 (as the lava a mined block let in flows on), after the list of blocks to mine was made
    const o = (start ?? bot.entity.position.floored()).offset(-24, 0, 0)
    const xyz = (dx: number, dy: number, dz: number): string => `${o.x + dx} ${o.y + dy} ${o.z + dz}`
    await run(`fill ${xyz(-6, -4, -6)} ${xyz(8, -1, 6)} stone`)
    await run(`fill ${xyz(-6, 0, -6)} ${xyz(8, 6, 6)} air`)
    await run(`setblock ${xyz(2, -1, 0)} obsidian`)
    await run(`setblock ${xyz(4, -1, 0)} obsidian`)
    await run(`clear ${USERNAME}`)
    await run(`give ${USERNAME} diamond_pickaxe 1`)
    await run(`tp ${USERNAME} ${o.x + 3.5} ${o.y} ${o.z + 2.5}`)
    assert.ok(await waitUntil(bot, () => countItems(bot, 'diamond_pickaxe') > 0 && bot.blockAt(o.offset(4, -1, 0))?.name === 'obsidian', 200))
    const positions = [o.offset(2, -1, 0), o.offset(4, -1, 0)]
    await run(`setblock ${xyz(5, -1, 0)} lava`)
    assert.ok(await waitUntil(bot, () => bot.blockAt(o.offset(5, -1, 0))?.name === 'lava', 20))
    let lava = 0
    const onTick = (): void => { if ((bot.entity as any).isInLava === true) lava++ }
    bot.on('physicsTick', onTick)
    try {
      // (one of the two: NOT_FOUND, 'broke 1 of 2 blocks')
      const out = await collectBlock(bot, { positions, pickup: false, avoidLava: true }).then(r => `${r.mined} mined`, (err: Error) => err.message)
      console.log(`by the lava: ${out}, x 2 ${bot.blockAt(positions[0])?.name}, x 4 ${bot.blockAt(positions[1])?.name}, ${lava} ticks in lava`)
      assert.strictEqual(bot.blockAt(positions[0])?.name, 'air')
      assert.strictEqual(bot.blockAt(positions[1])?.name, 'obsidian', 'the block lava had come against was mined, the lava let into its cell')
      assert.strictEqual(lava, 0)
    } finally {
      bot.off('physicsTick', onTick)
    }
  })
})
