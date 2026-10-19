// Nether travel against a real server (SURVIVAL_VERSION, default 1.21.11), the tests/harness lockstep server and bot on
// seed 4: a room built high in the nether like a basalt delta (a basalt floor over the lava sea, one-block shafts down
// to it in pairs that touch at a corner, lava pockets in the floor) crossed with the nether's settings, there and back,
// without going into the lava; a magma cube fought across a lava pocket without the bot walking into it. 26.3 nether
// runs died in the lava: a Diagonal across two shafts' corners, a fight chasing a magma cube into a pocket, a step back
// off a ledge over the lava sea. And a room walked across round the spot where the bot died, there and back.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert'
import { appendFileSync } from 'node:fs'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { goals } from '@nxg-org/mineflayer-pathfinder'
import { createPlugin } from '../../src'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { NETHER_DEATH_RADIUS, rememberNetherDeath, withNetherSafety } from '../../src/nether/safety'
import { travel } from '../../src/skills/travel'
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

  it('crosses a basalt-delta room of lava shafts and pockets there and back with the nether settings, never in the lava', async () => {
    // the room: x0 to x0 + 30 along x, z -7 to 7 round z0, the floor of basalt at y - 1 over air down to the lava sea
    // at y - 8
    const [x0, y, z0] = [200, 100, 200]
    const start = new Vec3(x0 + 1.5, y, z0 + 0.5)
    const far = new Vec3(x0 + 29, y, z0)
    await arrive(start)
    await fill(`${x0 - 2} ${y - 9} ${z0 - 9} ${x0 + 32} ${y + 6} ${z0 + 9} netherrack`)
    await fill(`${x0 - 1} ${y - 7} ${z0 - 8} ${x0 + 31} ${y + 5} ${z0 + 8} air`)
    await fill(`${x0 - 1} ${y - 8} ${z0 - 8} ${x0 + 31} ${y - 8} ${z0 + 8} lava`)
    await fill(`${x0 - 1} ${y - 1} ${z0 - 8} ${x0 + 31} ${y - 1} ${z0 + 8} basalt`)
    // the shafts, in pairs touching at a corner (a Diagonal between the two cells beside them cuts across both), and
    // a lava pocket in the floor now and then
    let shafts = 0
    for (let x = x0 + 4; x <= x0 + 25; x += 3) {
      for (let z = z0 - 6; z <= z0 + 6; z += 3) {
        await setblock(x, y - 1, z, 'air')
        await setblock(x + 1, y - 1, z + 1, 'air')
        shafts += 2
        if ((x + z) % 2 === 0) await setblock(x + 1, y - 1, z, 'lava')
      }
    }
    await nether(`tp ${USERNAME} ${start.x} ${y} ${start.z}`)
    await run(`effect clear ${USERNAME} minecraft:slow_falling`)
    await kit([['netherrack', 64], ['diamond_pickaxe', 1], ['cooked_beef', 8]])
    assert.ok(await waitUntil(bot, () => bot.entity.onGround && bot.entity.position.distanceTo(start) < 1.5, 200), `at ${bot.entity.position.toString()}`)
    console.log(`the delta room: ${shafts} shafts`)

    // there: the nether's long walk (travel: the grid walk first, then the pathfinder)
    const watch = watchLava()
    const t0 = bot.lockstep.ticks
    await withNetherSafety(bot, async () => await travel(bot, { target: far, range: 2 }))
    const there = bot.entity.position.clone()
    // and back with the pathfinder alone
    await withNetherSafety(bot, async () => await bot.pathfinder.goto(new goals.GoalNear(Math.floor(start.x), y, Math.floor(start.z), 1)))
    const { lava, lowest } = watch.stop()
    console.log(`across and back: ${bot.lockstep.ticks - t0} ticks, there at ${there.toString()}, back at ${bot.entity.position.toString()}, lowest ${lowest.toFixed(2)}, ${lava} ticks in lava`)
    assert.ok(Math.hypot(there.x - far.x, there.z - far.z) <= 3, `the walk there ended at ${there.toString()}`)
    assert.ok(bot.entity.position.distanceTo(start) <= 2.5, `the walk back ended at ${bot.entity.position.toString()}`)
    assert.strictEqual(lava, 0, 'the bot was in the lava')
    assert.ok(lowest >= y - 1, `the bot fell to ${lowest}`)
    assert.ok(bot.health > 0)
  })

  it('walks round where it died in the nether on the way across, with the grid walk and with the pathfinder', async () => {
    // an open room 40 long and 25 wide, a death remembered in its middle
    const [x0, y, z0] = [200, 100, 260]
    const start = new Vec3(x0 + 0.5, y, z0 + 0.5)
    const death = { x: x0 + 20, y, z: z0 }
    await arrive(start)
    await fill(`${x0 - 2} ${y - 2} ${z0 - 13} ${x0 + 42} ${y + 5} ${z0 + 13} netherrack`)
    await fill(`${x0 - 1} ${y} ${z0 - 12} ${x0 + 41} ${y + 4} ${z0 + 12} air`)
    await nether(`tp ${USERNAME} ${start.x} ${y} ${start.z}`)
    await run(`effect clear ${USERNAME} minecraft:slow_falling`)
    await kit([['netherrack', 16], ['cooked_beef', 8]])
    assert.ok(await waitUntil(bot, () => bot.entity.onGround && bot.entity.position.distanceTo(start) < 1.5, 200))
    const memory = bot.survival.memory
    for (const old of memory.getPois('nether_death', { dimension: 'the_nether' })) memory.removePoi('nether_death', old, 'the_nether')
    rememberNetherDeath(memory, death)
    let nearest = Infinity
    const onTick = (): void => { nearest = Math.min(nearest, Math.hypot(bot.entity.position.x - death.x - 0.5, bot.entity.position.z - death.z - 0.5)) }
    bot.on('physicsTick', onTick)
    try {
      await withNetherSafety(bot, async () => await travel(bot, { target: new Vec3(x0 + 40, y, z0), range: 2 }))
      const gridNearest = nearest
      nearest = Infinity
      await withNetherSafety(bot, async () => await bot.pathfinder.goto(new goals.GoalNear(x0, y, z0, 1)))
      console.log(`round the death: the grid walk ${gridNearest.toFixed(1)} from it at nearest, the pathfinder ${nearest.toFixed(1)}; back at ${bot.entity.position.toString()}`)
      assert.ok(gridNearest > NETHER_DEATH_RADIUS - 1.5, `the walk there went ${gridNearest.toFixed(1)} from the death`)
      assert.ok(nearest > NETHER_DEATH_RADIUS - 1.5, `the walk back went ${nearest.toFixed(1)} from the death`)
      assert.ok(bot.entity.position.distanceTo(start) <= 2.5, `the walk back ended at ${bot.entity.position.toString()}`)
    } finally {
      bot.off('physicsTick', onTick)
      memory.removePoi('nether_death', death, 'the_nether')
    }
  })

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
