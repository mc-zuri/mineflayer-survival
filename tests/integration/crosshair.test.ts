// The crosshair rule against a real server (SURVIVAL_VERSION, default 1.21.11): a dig breaks only the block the
// crosshair hits, as vanilla's player's (Minecraft.hitResult → MultiPlayerGameMode.startDestroyBlock), and leaves are
// dug through like any block in the pathfinder's way. Each scenario runs with mineflayer's own dig and with
// mineflayer-mouse loaded (its left click held on the cursor block).
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { goals } from '@nxg-org/mineflayer-pathfinder'
import { createPlugin } from '../../src'
import { dig } from '../../src/core/actions'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { waitUntil } from '../../src/skills/gather'

// the superflat's grass is at y = -61; the bot stands at -60
const GROUND = -61
const LEAVES = 'oak_leaves[persistent=true]'

describe(`the crosshair on a ${DEFAULT_VERSION} server`, { timeout: 20 * 60 * 1000 }, () => {
  let server: TestServer

  before(async () => {
    server = await startServer({
      flat: true,
      seed: 'crosshair',
      difficulty: 'peaceful',
      gamerules: { advance_weather: false, spawn_mobs: false, spawn_monsters: false, advance_time: false },
      properties: { 'spawn-protection': 0 }
    })
  })

  after(async () => {
    if (server != null) await server.cleanup()
  })

  for (const mouse of [false, true]) {
    describe(mouse ? 'with mineflayer-mouse' : 'with mineflayer\'s dig', () => {
      const username = mouse ? 'mousebot' : 'digbot'
      let bot: Bot
      let origin: Vec3
      const events: string[] = []
      const run = async (cmd: string): Promise<string> => (await server.command(cmd)).join(' ')
      const at = (dx: number, dy: number, dz: number): Vec3 => origin.offset(dx, dy, dz)
      const xyz = (pos: Vec3): string => `${pos.x} ${pos.y} ${pos.z}`
      const setblock = async (pos: Vec3, block: string): Promise<void> => {
        await run(`setblock ${xyz(pos)} ${block}`)
        const name = block.replace(/\[.*$/, '')
        assert.ok(await waitUntil(bot, () => bot.blockAt(pos)?.name === name, 40), `no ${name} at ${pos.toString()}`)
      }
      // the blocks broken, in order
      const broken: string[] = []

      before(async () => {
        bot = await connectLockstepBot(server, { username })
        await bot.waitForChunksToLoad()
        if (mouse) {
          const { createMouse } = require('mineflayer-mouse')
          bot.loadPlugin(createMouse({}))
          for (const name of ['startDigging', 'botArmSwingStart']) bot.on(name as any, () => events.push(name))
        }
        bot.loadPlugin(createPlugin({ reflexes: false }))
        origin = new Vec3(Math.floor(bot.entity.position.x), GROUND + 1, Math.floor(bot.entity.position.z))
        bot.on('blockUpdate', (old: any, now: any) => {
          if (old != null && old.name !== 'air' && now?.name === 'air') broken.push(`${old.name} ${old.position.minus(origin).toString()}`)
        })
      })

      after(async () => {
        if (bot != null) await quitBot(bot)
      })

      beforeEach(async () => {
        await run(`fill ${xyz(at(-10, 0, -10))} ${xyz(at(10, 10, 10))} air`)
        await run(`fill ${xyz(at(-10, -1, -10))} ${xyz(at(10, -1, 10))} grass_block`)
        await run(`tp ${username} ${origin.x + 0.5} ${origin.y} ${origin.z + 0.5} -90 0`)
        assert.ok(await waitUntil(bot, () => bot.entity.position.distanceTo(origin.offset(0.5, 0, 0.5)) < 0.1 && bot.entity.onGround, 100))
        broken.length = 0
        events.length = 0
      })

      it('a log behind a leaf: the leaf the crosshair hits is broken first, then the log', async () => {
        await setblock(at(2, 1, 0), LEAVES)
        await setblock(at(3, 1, 0), 'oak_log')
        await dig(bot, bot.blockAt(at(3, 1, 0)) as any)
        assert.ok(await waitUntil(bot, () => bot.blockAt(at(3, 1, 0))?.name === 'air', 40))
        assert.deepStrictEqual(broken, ['oak_leaves (2, 1, 0)', 'oak_log (3, 1, 0)'])
        if (mouse) assert.ok(events.includes('startDigging'), 'the mouse dug')
      })

      it('a log seen around a leaf: dug through the face in sight, the leaf left', async () => {
        await setblock(at(2, 1, 0), LEAVES)
        await setblock(at(3, 1, 1), 'oak_log')
        await dig(bot, bot.blockAt(at(3, 1, 1)) as any)
        assert.ok(await waitUntil(bot, () => bot.blockAt(at(3, 1, 1))?.name === 'air', 40))
        assert.strictEqual(bot.blockAt(at(2, 1, 0))?.name, 'oak_leaves')
        assert.deepStrictEqual(broken, ['oak_log (3, 1, 1)'])
      })

      it('a wall of leaves in the way is dug through, as any wall is', async () => {
        await run(`fill ${xyz(at(3, 0, -8))} ${xyz(at(3, 4, 8))} ${LEAVES}`)
        assert.ok(await waitUntil(bot, () => bot.blockAt(at(3, 4, 8))?.name === 'oak_leaves', 40))
        const goal = new goals.GoalBlock(origin.x + 6, origin.y, origin.z)
        await bot.pathfinder.goto(goal)
        assert.ok(goal.isEnd(bot.entity.position.floored() as any), `at ${bot.entity.position.toString()}`)
        assert.ok(broken.some(b => b.startsWith('oak_leaves')), broken.join(', '))
      })

      it('from on top of a canopy of leaves down to the ground', async () => {
        await run(`fill ${xyz(at(-4, 5, -4))} ${xyz(at(4, 6, 4))} ${LEAVES}`)
        await run(`fill ${xyz(at(0, 0, 0))} ${xyz(at(0, 6, 0))} oak_log`)
        assert.ok(await waitUntil(bot, () => bot.blockAt(at(4, 6, 4))?.name === 'oak_leaves' && bot.blockAt(at(0, 6, 0))?.name === 'oak_log', 40))
        await run(`tp ${username} ${origin.x + 2.5} ${origin.y + 7} ${origin.z + 2.5}`)
        assert.ok(await waitUntil(bot, () => bot.entity.position.y < origin.y + 7.5 && bot.entity.onGround, 100))
        const goal = new goals.GoalBlock(origin.x + 7, origin.y, origin.z + 7)
        await bot.pathfinder.goto(goal)
        assert.ok(goal.isEnd(bot.entity.position.floored() as any), `at ${bot.entity.position.toString()}`)
      })
    })
  }
})
