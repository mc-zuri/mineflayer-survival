// The lockstep server mod and client against a real Fabric server of the SURVIVAL_VERSION (default 1.21.11): the
// server advances a tick only once the bot acked the last one, so 2000 ticks take far less than 2000 x 50 ms, and both
// sides count the same ticks.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert'
import { performance } from 'node:perf_hooks'
import type { Bot } from 'mineflayer'
import { botCommand, connectLockstepBot, DEFAULT_VERSION, quitBot, startServer } from '../harness'
import type { TestServer } from '../harness'

const TICKS = 2000

// "/lockstep status": "lockstep on, timeout 5000 ms, tick 1234, ..." (MinecraftServer.tickCount)
const statusTick = (status: string): number => Number(/, tick (\d+),/.exec(status)?.[1] ?? NaN)
// "/time query gametime": "The time is 1234" (1.21.11), "The game time is 1234 tick(s)" (26.x)
const gametime = (answer: string): number => Number(/^The (?:game )?time is (\d+)/.exec(answer)?.[1] ?? NaN)
// "/data get entity Bot Pos": "Bot has the following entity data: [0.5d, -60.0d, 0.5d]"
function entityPos (answer: string): [number, number, number] {
  const m = /\[(-?[\d.E-]+)d, (-?[\d.E-]+)d, (-?[\d.E-]+)d\]/.exec(answer)
  assert.ok(m != null, `no position in "${answer}"`)
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

describe(`lockstep (${DEFAULT_VERSION} server mod and client)`, () => {
  let server: TestServer
  let bot: Bot

  before(async () => {
    server = await startServer({
      flat: true,
      seed: 'lockstep',
      gamerules: { advance_weather: false, spawn_mobs: false, respawn_radius: 0 }
    })
    bot = await connectLockstepBot(server)
  })

  after(async () => {
    if (bot != null) await quitBot(bot)
    if (server != null) await server.cleanup()
  })

  test(`${TICKS} ticks run well under ${TICKS} x 50 ms, and the server counts the ticks the bot ran`, async (t) => {
    // the server waits between two ticks while the bot holds the ack: its counters stand still
    const n1 = await bot.lockstep.step()
    const tick1 = statusTick(await botCommand(bot, 'lockstep status', /^lockstep on/))
    const time1 = gametime(await botCommand(bot, 'time query gametime', /^The (game )?time is/))
    assert.strictEqual(tick1, n1, 'the tick message carries the server\'s tick count')
    const botTicks1 = bot.lockstep.lockstepTicks

    const start = performance.now()
    const n2 = await bot.lockstep.step(TICKS)
    const wallMs = performance.now() - start

    const tick2 = statusTick(await botCommand(bot, 'lockstep status', /^lockstep on/))
    const time2 = gametime(await botCommand(bot, 'time query gametime', /^The (game )?time is/))
    assert.strictEqual(bot.lockstep.lockstepTicks - botTicks1, TICKS, 'the bot ran one tick a server tick')
    assert.strictEqual(n2 - n1, TICKS)
    assert.strictEqual(tick2 - tick1, TICKS, 'the server\'s tick count went up by the ticks the bot ran')
    assert.strictEqual(time2 - time1, TICKS, 'the game time went up by the ticks the bot ran')
    const tps = TICKS / wallMs * 1000
    t.diagnostic(`${TICKS} ticks in ${wallMs.toFixed(0)} ms: ${tps.toFixed(0)} ticks/s (${(tps / 20).toFixed(1)}x real time)`)
    console.log(`lockstep: ${TICKS} ticks in ${wallMs.toFixed(0)} ms, ${tps.toFixed(0)} ticks/s`)
    assert.ok(wallMs < TICKS * 50 / 4, `${TICKS} ticks took ${wallMs.toFixed(0)} ms, not well under ${TICKS * 50} ms`)
  })

  test('the bot walks with control states, and the server has it where it has itself', async () => {
    let corrections = 0
    bot.on('forcedMove', () => { corrections++ })
    const start = bot.entity.position.clone()

    bot.lockstep.resume()
    bot.setControlState('forward', true)
    bot.setControlState('sprint', true)
    await bot.lockstep.waitTicks(60)
    bot.setControlState('sprint', false)
    bot.setControlState('left', true)
    bot.setControlState('jump', true)
    await bot.lockstep.waitTicks(30)
    bot.clearControlStates()
    // at rest (LivingEntity.aiStep zeroes a negligible motion), the position reminder (20 ticks) sent it
    await bot.lockstep.step(50)

    const own = bot.entity.position
    const [x, y, z] = entityPos(await botCommand(bot, `data get entity ${bot.username} Pos`, /has the following entity data/))
    assert.ok(own.distanceTo(start) > 10, `the bot walked ${own.distanceTo(start).toFixed(2)} blocks`)
    assert.ok(Math.abs(own.x - x) < 1e-9 && Math.abs(own.y - y) < 1e-9 && Math.abs(own.z - z) < 1e-9,
      `the bot is at ${own.toString()}, the server has it at (${x}, ${y}, ${z})`)
    assert.strictEqual(corrections, 0, 'the server never moved the bot back')
    bot.lockstep.resume()
  })

  test('a bot that stops acking stops gating the server after the timeout, and gates it again once it caught up', async () => {
    await server.command('lockstep timeout 300')
    try {
      const warned = server.waitForLine(/^Bot has not acked lockstep tick \d+ in \d+ ms/, 10000)
      const held = await bot.lockstep.step()
      await warned
      // the server ticks on in real time, and the bot runs those ticks too (holding their acks)
      assert.ok(await bot.lockstep.nextTick() > held)
      const caughtUp = server.waitForLine(/^Bot caught up with lockstep at tick \d+/, 10000)
      bot.lockstep.resume()
      await caughtUp
      // gated again: the bot holds a tick, and the server stays on it
      const n = await bot.lockstep.step()
      const status = await botCommand(bot, 'lockstep status', /^lockstep on/)
      assert.strictEqual(statusTick(status), n)
      assert.ok(!status.includes('stalled'), status)
    } finally {
      bot.lockstep.resume()
      await server.command('lockstep timeout 5000')
    }
  })
})
