// The pathfinder's edge guard on for the skills' own walks (guardEdges): walkTo's steps (gridWalk's, ensureSurface's,
// the explore legs') and steerToward's (the fight's, the escapes') are held at a cliff's edge they'd walk off, on the
// pathfinder's fake rig. Before, each walked off it: 26.3 bots fell 31, 35 and 6 blocks off ledges in the whole-game
// runs (full-26.3-fresh-o, full-26.3-fresh-r, full-26.3-s31337-f).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { guardEdges } from '../../src/skills/edgeGuard'
import { walkTo } from '../../src/skills/navigate'
import { steerToward } from '../../src/skills/steer'

const pf = require('@nxg-org/mineflayer-pathfinder')
const setup = require('@nxg-org/mineflayer-pathfinder/tests/setup')

/** the fake rig (the feet at 64) with the floor cut away from x 4 on and stone 30 down; the guard on when `guard` */
async function cliffRig (version: string, guard: boolean): Promise<{ bot: any, lowest: () => number, stop: () => void }> {
  const { rig } = setup.createCacheWorld(version, 64, new Vec3(0.5, 64, 0.5))
  const bot = rig.bot
  for (let x = 4; x <= 20; x++) {
    for (let z = -10; z <= 10; z++) {
      bot.world.setBlock(new Vec3(x, 63, z), 'air')
      bot.world.setBlock(new Vec3(x, 33, z), 'stone')
    }
  }
  bot.loadPlugin(pf.createPlugin())
  if (guard) guardEdges(bot)
  let lowest = Infinity
  const onTick = (): void => { lowest = Math.min(lowest, bot.entity.position.y) }
  bot.on('physicsTick', onTick)
  for (let i = 0; i < 40 && bot.entity.onGround !== true; i++) await new Promise(resolve => setTimeout(resolve, 50))
  return { bot, lowest: () => lowest, stop: () => { bot.off('physicsTick', onTick); rig.stopPassivePhysics() } }
}

for (const version of ['26.3', '1.21.11']) {
  test(`${version}: walkTo a point past a cliff's edge is held at the edge with the guard, and walks off without`, { timeout: 60000 }, async () => {
    for (const guard of [false, true]) {
      const { bot, lowest, stop } = await cliffRig(version, guard)
      try {
        const ok = await walkTo(bot, new Vec3(8.5, 64, 0.5), { within: 0.3, maxTicks: 60 })
        if (!guard) {
          assert.ok(lowest() < 60, `the bot never fell (lowest ${lowest()})`)
          continue
        }
        assert.equal(ok, false)
        assert.ok(lowest() > 63.9, `the bot fell to ${lowest().toFixed(1)}`)
        assert.ok(bot.entity.position.x > 3.5 && bot.entity.position.x < 4.31, `at ${bot.entity.position.toString()}`)
        assert.ok(bot.pathfinder.edgeGuard.catches > 0)
      } finally {
        stop()
      }
    }
  })

  test(`${version}: steerToward (sprinting, no guard of its own) a mob past a cliff's edge is held at the edge`, { timeout: 60000 }, async () => {
    for (const guard of [false, true]) {
      const { bot, lowest, stop } = await cliffRig(version, guard)
      try {
        for (let i = 0; i < 60; i++) {
          steerToward(bot, new Vec3(10, 64, 0.5))
          await bot.waitForTicks(1)
        }
        bot.clearControlStates()
        if (!guard) {
          assert.ok(lowest() < 60, `the bot never fell (lowest ${lowest()})`)
          continue
        }
        assert.ok(lowest() > 63.9, `the bot fell to ${lowest().toFixed(1)}`)
        assert.ok(bot.entity.position.x > 3.5, `at ${bot.entity.position.toString()}`)
      } finally {
        stop()
      }
    }
  })
}

test('guardEdges: the guard on for every tick, once; a bot with no pathfinder is let be', () => {
  const guard: any = { mode: 'auto' }
  const listeners: string[] = []
  const bot: any = { pathfinder: { edgeGuard: guard }, on: (event: string) => listeners.push(event) }
  guardEdges(bot)
  guardEdges(bot)
  assert.equal(guard.mode, 'always')
  assert.deepEqual(listeners, ['edgeGuard'])
  assert.doesNotThrow(() => guardEdges({ on () {} } as any))
})
