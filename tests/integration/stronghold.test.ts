// The eyes milestone against a real server (SURVIVAL_VERSION, default 1.21.11) (the tests/harness lockstep server and bot), on the seed
// 'nether-skills', whose nearest stronghold to the plains at -1336, -118 has its locate pos at -1648, -80: eyes
// thrown 200 blocks apart, the rays crossed, the crossing reached and an eye thrown there until it comes down, checked
// against /locate (within 50 blocks); then the way dug down and the portal room found. Logs ticks and wall time.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert'
import type { Bot } from 'mineflayer'
import { createPlugin } from '../../src'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { findPortalRoom, locateStronghold, reachStronghold } from '../../src/end/strongholdSkills'
import type { EyeRay } from '../../src/end/triangulate'
import { countItems, waitUntil } from '../../src/skills/gather'

const USERNAME = 'eyebot'

describe(`stronghold skills on a ${DEFAULT_VERSION} server`, { timeout: 40 * 60 * 1000 }, () => {
  let server: TestServer
  let bot: Bot

  const run = async (cmd: string): Promise<string> => (await server.command(cmd)).join(' | ')

  before(async () => {
    server = await startServer({
      seed: 'nether-skills',
      difficulty: 'easy',
      gamerules: { advance_weather: false, advance_time: false, spawn_phantoms: false, spawn_monsters: false }
    })
    bot = await connectLockstepBot(server, { username: USERNAME, timeoutMs: 120000 })
    await bot.waitForChunksToLoad()
    bot.loadPlugin(createPlugin({ reflexes: false }))
  })

  after(async () => {
    if (bot != null) await quitBot(bot)
    if (server != null) await server.cleanup()
  })

  it('throws eyes, triangulates, reaches the stronghold within 50 blocks of /locate, and finds the portal room', async () => {
    await run('time set 1000')
    await run(`clear ${USERNAME}`)
    for (const [item, count] of [['ender_eye', 16], ['cooked_beef', 32], ['iron_pickaxe', 1], ['iron_shovel', 1], ['iron_sword', 1], ['cobblestone', 64], ['torch', 32]] as const) {
      await run(`give ${USERNAME} ${item} ${count}`)
    }
    assert.ok(await waitUntil(bot, () => countItems(bot, 'ender_eye') === 16, 40))
    const spread = await run(`spreadplayers -1336 -118 0 20 false ${USERNAME}`)
    assert.match(spread, /Spread 1/, spread)
    // (a far corner of a new world: the chunks there are generated as the bot arrives)
    assert.ok(await waitUntil(bot, () => Math.hypot(bot.entity.position.x + 1336, bot.entity.position.z + 118) < 30 && bot.entity.onGround, 1200), `at ${bot.entity.position.toString()}`)
    await bot.waitForChunksToLoad()
    await bot.waitForTicks(20)

    const t0 = Date.now()
    const k0 = bot.lockstep.ticks
    const located = await locateStronghold(bot, { sideways: 200 })
    console.log(`locateStronghold: ${located.throws.length} throws, the crossing at ${located.target.x.toFixed(1)}, ${located.target.z.toFixed(1)} (error ${located.estimate?.error.toFixed(1)}, crossing ${located.estimate?.crossingAngle.toFixed(1)} degrees), ${bot.lockstep.ticks - k0} ticks, ${Date.now() - t0} ms`)
    const reached = await reachStronghold(bot, { target: located.target, rays: located.throws.map(t => t.ray).filter((r): r is EyeRay => r != null) })
    console.log(`reachStronghold: the eye came down at ${reached.spot.x.toFixed(1)}, ${reached.spot.z.toFixed(1)} after ${reached.throws} throws; ${bot.lockstep.ticks - k0} ticks, ${Date.now() - t0} ms in all`)

    const out = (await server.command(`execute as ${USERNAME} at @s run locate structure minecraft:stronghold`)).join(' ')
    const m = /at \[(-?\d+), ~, (-?\d+)\]/.exec(out)
    assert.ok(m != null, out)
    const real = { x: Number(m[1]), z: Number(m[2]) }
    const off = Math.hypot(bot.entity.position.x - real.x, bot.entity.position.z - real.z)
    console.log(`/locate: ${out}; the bot is ${off.toFixed(1)} blocks from it`)
    assert.ok(off <= 50, `the bot is ${off.toFixed(1)} blocks from the stronghold at ${real.x}, ${real.z}`)
    assert.ok(Math.hypot(located.target.x - real.x, located.target.z - real.z) <= 50)

    const room = await findPortalRoom(bot, { near: reached.spot })
    console.log(`findPortalRoom: center ${room.room.center.x} ${room.room.center.y} ${room.room.center.z}, ${room.room.frames.length} frames, ${room.room.eyesNeeded} eyes needed; ${bot.lockstep.ticks - k0} ticks, ${Date.now() - t0} ms in all`)
    assert.strictEqual(room.room.frames.length, 12)
    assert.ok(bot.entity.position.distanceTo(new (require('vec3').Vec3)(room.room.center.x, room.room.center.y, room.room.center.z)) < 10)
    for (const f of room.room.frames) assert.strictEqual(bot.blockAt(new (require('vec3').Vec3)(f.pos.x, f.pos.y, f.pos.z))?.name, 'end_portal_frame')
  })
})
