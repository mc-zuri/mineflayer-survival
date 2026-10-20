// A nether lava-sea crossing with too few blocks, against a real server (SURVIVAL_VERSION, default 1.21.11), the
// tests/harness lockstep server and bot on seed 4: a room built high in the nether, a netherrack shore, a lava sea 40
// blocks across with its lava 8 under the shore's floor, the far shore beyond; the bot's own cobblestone bridge 15 blocks
// out from the shore, the trail laid along it as the bot walks one, and the bot at its end with 4 cobblestone and a
// pickaxe (full-26.3-fresh-t: at the end of its 60-block bridge over the lava sea with 4 cobblestone, every hop on
// toward the fortress failed from t215000 to past t250000). The trip with the turn-back off fails there; with it, the
// bot walks back along the bridge to the shore, mines netherrack up to the working set, bridges across and gets there,
// never in the lava.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert'
import { appendFileSync } from 'node:fs'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { createPlugin } from '../../src'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { withNetherSafety } from '../../src/nether/safety'
import { travel } from '../../src/skills/travel'
import { countItems, waitUntil } from '../../src/skills/gather'
import { NETHER_TRAIL, extendTrail, keepNetherTrail, trailPoints } from '../../src/nether/trail'
import { SCAFFOLD_ITEMS } from '../../src/executor/steps'

const USERNAME = 'restockbot'
const SEED = '4'

describe(`a lava-sea crossing short of blocks on a ${DEFAULT_VERSION} server (seed 4)`, { timeout: 20 * 60 * 1000 }, () => {
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

  async function fill (args: string): Promise<void> {
    let out = ''
    for (let i = 0; i < 20; i++) {
      out = await nether(`fill ${args}`)
      if (!/not loaded/.test(out)) break
      await bot.waitForTicks(10)
    }
    assert.match(out, /Successfully filled|No blocks were filled/, `fill ${args}: ${out}`)
  }

  // the room: x0 - 16 to x0 + 60 along x, z0 - 8 to z0 + 8; the shore to x0 - 1 and the far shore from x0 + 40, their
  // floor at y - 1 over solid netherrack; the sea's lava at y - 8 from x0 to x0 + 39, air over it, bedrock round it
  const [x0, y, z0] = [200, 100, 500]
  const bridgeEnd = new Vec3(x0 + 14.5, y, z0 + 0.5)
  const target = new Vec3(x0 + 50.5, y, z0 + 0.5)

  async function build (): Promise<void> {
    await run(`effect give ${USERNAME} minecraft:slow_falling 120 0 true`)
    await nether(`tp ${USERNAME} ${x0 - 8} ${y + 3} ${z0}`)
    assert.ok(await waitUntil(bot, () => bot.game.dimension === 'the_nether' || bot.game.dimension === 'minecraft:the_nether', 1200))
    await bot.waitForChunksToLoad()
    await nether(`forceload add ${x0 - 20} ${z0 - 12} ${x0 + 64} ${z0 + 12}`)
    // sealed in bedrock (the nether's own caves under it were a way round, dug down to), the shores' netherrack to
    // mine, the sea's walls, ceiling and bed bedrock (no tunnel round or under it)
    await fill(`${x0 - 18} ${y - 11} ${z0 - 10} ${x0 + 62} ${y + 7} ${z0 + 10} bedrock`)
    await fill(`${x0 - 17} ${y - 10} ${z0 - 9} ${x0 - 1} ${y + 6} ${z0 + 9} netherrack`)
    await fill(`${x0 + 40} ${y - 10} ${z0 - 9} ${x0 + 61} ${y + 6} ${z0 + 9} netherrack`)
    await fill(`${x0 - 16} ${y} ${z0 - 8} ${x0 + 60} ${y + 5} ${z0 + 8} air`)
    await fill(`${x0} ${y - 7} ${z0 - 8} ${x0 + 39} ${y - 1} ${z0 + 8} air`)
    await fill(`${x0} ${y - 8} ${z0 - 8} ${x0 + 39} ${y - 8} ${z0 + 8} lava`)
    // the bot's bridge, 15 out over the sea
    await fill(`${x0} ${y - 1} ${z0} ${x0 + 14} ${y - 1} ${z0} cobblestone`)
  }

  async function atBridgeEnd (items: Array<[string, number]>): Promise<void> {
    await run(`clear ${USERNAME}`)
    await nether(`tp ${USERNAME} ${bridgeEnd.x} ${y} ${bridgeEnd.z} -90 0`)
    await run(`effect clear ${USERNAME} minecraft:slow_falling`)
    for (const [item, count] of items) await run(`give ${USERNAME} ${item} ${count}`)
    await run(`effect give ${USERNAME} minecraft:instant_health 1 10 true`)
    await run(`effect give ${USERNAME} minecraft:saturation 1 20 true`)
    assert.ok(await waitUntil(bot, () => countItems(bot, items[0][0]) > 0 && bot.entity.onGround && bot.entity.position.distanceTo(bridgeEnd) < 1, 400), `at ${bot.entity.position.toString()}`)
    // the trail as the bot laid it: along the shore, then out along its bridge
    const memory = bot.survival.memory
    for (const p of trailPoints(memory)) memory.removePoi(NETHER_TRAIL, p, 'the_nether')
    for (let x = x0 - 14; x <= x0 + 14; x++) extendTrail(memory, { x, y, z: z0 })
  }

  /** whether the bot is in lava, or its feet or head are, any tick from now on until the returned stop is called */
  function watchLava (): { stop: () => { lava: number, lowest: number, lowestAt: Vec3 | null } } {
    let lava = 0
    let lowest = Infinity
    let lowestAt: Vec3 | null = null
    const onTick = (): void => {
      const feet = bot.entity.position.floored()
      if ((bot.entity as any).isInLava === true || bot.blockAt(feet)?.name === 'lava' || bot.blockAt(feet.offset(0, 1, 0))?.name === 'lava') lava++
      if (bot.entity.position.y < lowest) { lowest = bot.entity.position.y; lowestAt = bot.entity.position.clone() }
    }
    bot.on('physicsTick', onTick)
    return { stop: () => { bot.off('physicsTick', onTick); return { lava, lowest, lowestAt } } }
  }

  it('at its bridge\'s end with 4 cobblestone, the trip turns back along the bridge, mines netherrack on the shore and crosses; with the turn-back off it fails there', async () => {
    await build()
    keepNetherTrail(bot, bot.survival.memory)
    const kit: Array<[string, number]> = [['cobblestone', 4], ['diamond_pickaxe', 1], ['cooked_beef', 8]]

    // before: no turn-back (as main had it)
    await atBridgeEnd(kit)
    let t0 = bot.lockstep.ticks
    const before = await withNetherSafety(bot, async () => await travel(bot, { target, range: 2, restock: false }))
      .then(() => 'arrived', (err: Error) => err.message)
    console.log(`with no turn-back: ${before} after ${bot.lockstep.ticks - t0} ticks, at ${bot.entity.position.toString()}, ${countItems(bot, SCAFFOLD_ITEMS)} blocks`)
    assert.notStrictEqual(before, 'arrived')
    assert.ok(bot.entity.position.x < x0 + 40, `the bot crossed with 4 blocks: ${bot.entity.position.toString()}`)

    // after: the turn-back (the room built anew)
    await build()
    await atBridgeEnd(kit)
    t0 = bot.lockstep.ticks
    let turnedAt = -1
    let mostBlocks = 0
    const onTick = (): void => {
      const n = countItems(bot, SCAFFOLD_ITEMS)
      mostBlocks = Math.max(mostBlocks, n)
      if (turnedAt < 0 && bot.entity.position.x < x0 - 1) turnedAt = bot.lockstep.ticks - t0
    }
    bot.on('physicsTick', onTick)
    const watch = watchLava()
    let outcome: string
    try {
      outcome = await withNetherSafety(bot, async () => await travel(bot, { target, range: 2 }))
        .then(() => 'arrived', (err: Error) => err.message)
    } finally {
      bot.off('physicsTick', onTick)
    }
    const { lava, lowest, lowestAt } = watch.stop()
    const ticks = bot.lockstep.ticks - t0
    console.log(`with the turn-back: ${outcome} in ${ticks} ticks, on the shore at tick ${turnedAt}, ${mostBlocks} blocks at most, ${countItems(bot, SCAFFOLD_ITEMS)} left, at ${bot.entity.position.toString()}, lowest ${lowest.toFixed(2)} at ${String(lowestAt)}, ${lava} ticks in lava`)
    assert.strictEqual(outcome, 'arrived')
    assert.ok(Math.hypot(bot.entity.position.x - target.x, bot.entity.position.z - target.z) <= 3, `ended at ${bot.entity.position.toString()}`)
    assert.ok(turnedAt >= 0 && turnedAt < 1000, `back on the shore at tick ${turnedAt}`)
    assert.ok(mostBlocks >= 64, `${mostBlocks} blocks mined at most`)
    assert.strictEqual(lava, 0, 'the bot was in the lava')
    assert.ok(lowest >= y - 1.5, `the bot fell to ${lowest}`)
    assert.ok(bot.health > 0)
  })
})
