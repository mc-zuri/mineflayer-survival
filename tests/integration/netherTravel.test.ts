// Nether travel against a real server (SURVIVAL_VERSION, default 1.21.11), the tests/harness lockstep server and bot on
// seed 4: a magma cube fought across a lava pocket without the bot walking into it. 26.3 nether runs died in the lava:
// a fight chasing a magma cube into a pocket, a step back off a ledge over the lava sea.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert'
import { appendFileSync } from 'node:fs'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { createPlugin } from '../../src'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { fight } from '../../src/skills/fight'
import { countItems, waitUntil } from '../../src/skills/gather'

const USERNAME = 'deltabot'
const SEED = '4'

describe(`nether travel on a ${DEFAULT_VERSION} server (seed 4)`, { timeout: 20 * 60 * 1000 }, () => {
  let server: TestServer
  let bot: Bot

  const run = async (cmd: string): Promise<string> => (await server.command(cmd)).join(' | ')
  const nether = async (cmd: string): Promise<string> => await run(`execute in minecraft:the_nether run ${cmd}`)

  before(async () => {
    server = await startServer({
      seed: SEED,
      difficulty: 'easy',
      gamerules: { advance_weather: false, advance_time: false, spawn_phantoms: false, spawn_monsters: false },
      log: process.env.SURVIVAL_SERVER_LOG != null ? line => appendFileSync(process.env.SURVIVAL_SERVER_LOG as string, `${line}\n`) : undefined
    })
    bot = await connectLockstepBot(server, { username: USERNAME, timeoutMs: 120000 })
    await bot.waitForChunksToLoad()
    bot.loadPlugin(createPlugin({ reflexes: false }))
  })

  after(async () => {
    if (bot != null) await quitBot(bot)
    if (server != null) await server.cleanup()
  })

  async function kit (items: Array<[string, number]>): Promise<void> {
    await run(`clear ${USERNAME}`)
    for (const [item, count] of items) await run(`give ${USERNAME} ${item} ${count}`)
    await run(`effect give ${USERNAME} minecraft:instant_health 1 10 true`)
    await run(`effect give ${USERNAME} minecraft:saturation 1 20 true`)
    assert.ok(await waitUntil(bot, () => countItems(bot, items[0][0]) > 0, 40), `no ${items[0][0]} given`)
  }

  async function fill (args: string): Promise<void> {
    let out = ''
    for (let i = 0; i < 20; i++) {
      out = await nether(`fill ${args}`)
      if (!/not loaded/.test(out)) break
      await bot.waitForTicks(10)
    }
    assert.match(out, /Successfully filled|No blocks were filled/, `fill ${args}: ${out}`)
  }

  async function setblock (x: number, y: number, z: number, block: string): Promise<void> {
    const out = await nether(`setblock ${x} ${y} ${z} ${block}`)
    assert.match(out, /Changed the block|Could not set the block/, `setblock ${x} ${y} ${z} ${block}: ${out}`)
  }

  /** whether the bot is in lava, or its feet or head are, any tick from now on until the returned stop is called */
  function watchLava (): { stop: () => { lava: number, lowest: number } } {
    let lava = 0
    let lowest = Infinity
    const onTick = (): void => {
      if (bot.game.dimension !== 'the_nether' && bot.game.dimension !== 'minecraft:the_nether') return
      const feet = bot.entity.position.floored()
      if ((bot.entity as any).isInLava === true || bot.blockAt(feet)?.name === 'lava' || bot.blockAt(feet.offset(0, 1, 0))?.name === 'lava') lava++
      lowest = Math.min(lowest, bot.entity.position.y)
    }
    bot.on('physicsTick', onTick)
    return { stop: () => { bot.off('physicsTick', onTick); return { lava, lowest } } }
  }

  /** to the nether, standing at `at` (slow falling while the room is built round it) */
  async function arrive (at: Vec3): Promise<void> {
    await run(`effect give ${USERNAME} minecraft:slow_falling 60 0 true`)
    await nether(`tp ${USERNAME} ${at.x} ${at.y + 3} ${at.z}`)
    assert.ok(await waitUntil(bot, () => bot.game.dimension === 'the_nether' || bot.game.dimension === 'minecraft:the_nether', 1200))
    await bot.waitForChunksToLoad()
  }

  it('fights a magma cube across a lava pocket from its edge, never stepping into the lava', async () => {
    // a basalt floor at y - 1 with a lava pocket 3 wide across it between the bot and the cube (which doesn't move)
    const [x0, y, z0] = [260, 100, 200]
    const start = new Vec3(x0 + 0.5, y, z0 + 0.5)
    await arrive(start)
    await fill(`${x0 - 4} ${y - 3} ${z0 - 4} ${x0 + 10} ${y + 5} ${z0 + 4} netherrack`)
    await fill(`${x0 - 3} ${y} ${z0 - 3} ${x0 + 9} ${y + 4} ${z0 + 3} air`)
    await fill(`${x0 - 3} ${y - 1} ${z0 - 3} ${x0 + 9} ${y - 1} ${z0 + 3} basalt`)
    await fill(`${x0 + 2} ${y - 1} ${z0 - 3} ${x0 + 4} ${y - 1} ${z0 + 3} lava`)
    await nether(`tp ${USERNAME} ${start.x} ${y} ${start.z} -90 0`)
    await run(`effect clear ${USERNAME} minecraft:slow_falling`)
    await kit([['diamond_sword', 1], ['cooked_beef', 8]])
    await nether('kill @e[type=magma_cube]')
    await nether(`summon magma_cube ${x0 + 6.5} ${y} ${z0 + 0.5} {Size:1,NoAI:1b,PersistenceRequired:1b}`)
    assert.ok(await waitUntil(bot, () => bot.entity.onGround && bot.nearestEntity(e => e.name === 'magma_cube') != null, 200))
    const cube = bot.nearestEntity(e => e.name === 'magma_cube')
    assert.ok(cube != null)
    await bot.equip(bot.inventory.items().find(i => i.name === 'diamond_sword') as any, 'hand')

    const watch = watchLava()
    const outcome = await fight(bot, cube as any, { maxTicks: 100, maxDistance: 16 }).then(r => `killed ${String(r.killed)}`, (err: Error) => err.message)
    const { lava } = watch.stop()
    console.log(`the fight across the pocket: ${outcome}; the bot at ${bot.entity.position.toString()}, ${lava} ticks in lava`)
    assert.strictEqual(lava, 0, 'the bot walked into the lava pocket')
    assert.ok(bot.entity.position.x < x0 + 2, `the bot is past the pocket's edge: ${bot.entity.position.toString()}`)
    assert.ok(bot.health > 0)
  })
})
