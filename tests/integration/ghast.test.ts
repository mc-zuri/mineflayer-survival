// A ghast over the lava sea against a real server (SURVIVAL_VERSION, default 1.21.11), the tests/harness lockstep server
// and bot on seed 4: a room built high in the nether, its floor the lava sea, a one-wide netherrack bridge across it
// and a ghast summoned beside the bridge; the bot crosses there and back with its reflexes on, as a task of the
// executor's (the nether's path settings), and never falls off into the lava. A 26.3 nether run stood on a ledge 58
// blocks over the lava sea when a ghast's fireball came: the deflect reflex fired, missed, and the blast knocked the
// bot off into the lava.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert'
import { appendFileSync } from 'node:fs'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { goals } from '@nxg-org/mineflayer-pathfinder'
import { createPlugin } from '../../src'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { countItems, navigate, waitUntil } from '../../src/skills/gather'
import { Executor } from '../../src/executor/executor'

const USERNAME = 'ghastbot'
const SEED = '4'

describe(`a ghast by a bridge over lava on a ${DEFAULT_VERSION} server (seed 4)`, { timeout: 20 * 60 * 1000 }, () => {
  let server: TestServer
  let bot: Bot

  const run = async (cmd: string): Promise<string> => (await server.command(cmd)).join(' | ')
  const nether = async (cmd: string): Promise<string> => await run(`execute in minecraft:the_nether run ${cmd}`)

  before(async () => {
    server = await startServer({
      seed: SEED,
      difficulty: 'normal',
      gamerules: { advance_weather: false, advance_time: false, spawn_phantoms: false, spawn_monsters: false },
      log: process.env.SURVIVAL_SERVER_LOG != null ? line => appendFileSync(process.env.SURVIVAL_SERVER_LOG as string, `${line}\n`) : undefined
    })
    bot = await connectLockstepBot(server, { username: USERNAME, timeoutMs: 120000 })
    await bot.waitForChunksToLoad()
    bot.loadPlugin(createPlugin({ reflexes: { enabled: false } }))
  })

  after(async () => {
    bot?.survival?.reflexes?.stop()
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

  it('crosses a bridge over the lava sea there and back with a ghast shooting at it, and never falls off', async () => {
    // the room: x0 - 4 to x0 + 34 along x, z0 - 14 to z0 + 14 across, the lava sea at y - 8, the bridge at y - 1 along
    // z0 from x0 to x0 + 30 with a landing of 3 × 3 at each end
    const [x0, y, z0] = [400, 100, 400]
    const start = new Vec3(x0 + 0.5, y, z0 + 0.5)
    const far = new Vec3(x0 + 30, y, z0)
    await run(`effect give ${USERNAME} minecraft:slow_falling 60 0 true`)
    await nether(`tp ${USERNAME} ${start.x} ${y + 3} ${start.z}`)
    assert.ok(await waitUntil(bot, () => bot.game.dimension === 'the_nether' || bot.game.dimension === 'minecraft:the_nether', 1200))
    await bot.waitForChunksToLoad()
    await fill(`${x0 - 5} ${y - 9} ${z0 - 15} ${x0 + 35} ${y + 14} ${z0 + 15} netherrack`)
    await fill(`${x0 - 4} ${y - 7} ${z0 - 14} ${x0 + 34} ${y + 13} ${z0 + 14} air`)
    await fill(`${x0 - 4} ${y - 8} ${z0 - 14} ${x0 + 34} ${y - 8} ${z0 + 14} lava`)
    await fill(`${x0} ${y - 1} ${z0} ${x0 + 30} ${y - 1} ${z0} netherrack`)
    await fill(`${x0 - 2} ${y - 1} ${z0 - 1} ${x0} ${y - 1} ${z0 + 1} netherrack`)
    await fill(`${x0 + 30} ${y - 1} ${z0 - 1} ${x0 + 32} ${y - 1} ${z0 + 1} netherrack`)
    await nether('kill @e[type=!player]')
    await nether(`tp ${USERNAME} ${start.x} ${y} ${start.z}`)
    await run(`effect clear ${USERNAME} minecraft:slow_falling`)
    await run(`clear ${USERNAME}`)
    for (const [item, count] of [['netherrack', 64], ['cooked_beef', 16], ['diamond_sword', 1], ['shield', 1], ['diamond_helmet', 1], ['diamond_chestplate', 1], ['diamond_leggings', 1], ['golden_boots', 1]] as Array<[string, number]>) {
      await run(`give ${USERNAME} ${item} ${count}`)
    }
    await run(`effect give ${USERNAME} minecraft:instant_health 1 10 true`)
    await run(`effect give ${USERNAME} minecraft:saturation 1 20 true`)
    assert.ok(await waitUntil(bot, () => countItems(bot, 'golden_boots') + countItems(bot, 'diamond_helmet') > 0 && bot.entity.onGround && bot.entity.position.distanceTo(start) < 1.5, 200), `at ${bot.entity.position.toString()}`)

    // the ghast beside the bridge's middle, 10 blocks off and level with it (it targets a player within 4 blocks up or
    // down, Ghast's NearestAttackableTargetGoal)
    await nether(`summon ghast ${x0 + 15} ${y + 1} ${z0 + 10}`)
    assert.ok(await waitUntil(bot, () => Object.values(bot.entities).some(e => e.name === 'ghast'), 100), 'no ghast')
    let fireballs = 0
    const seen = new Set<number>()
    let lowest = Infinity
    let lava = 0
    let died = false
    const onTick = (): void => {
      for (const e of Object.values(bot.entities)) if (e.name === 'fireball' && !seen.has(e.id)) { seen.add(e.id); fireballs++ }
      if (process.env.GHAST_TRACE != null) for (const e of Object.values(bot.entities)) if (e.name === 'fireball' && e.position.distanceTo(bot.entity.position) < 8) console.log('fb', bot.lockstep.ticks, e.id, e.position.toString(), e.velocity.toString(), 'bot', bot.entity.position.toString())
      lowest = Math.min(lowest, bot.entity.position.y)
      if ((bot.entity as any).isInLava === true || bot.blockAt(bot.entity.position.floored())?.name === 'lava') lava++
    }
    const onDeath = (): void => { died = true }
    const onExplosion = (p: any): void => {
      if (process.env.GHAST_TRACE != null) console.log('explosion', bot.lockstep.ticks, JSON.stringify(p).slice(0, 200), 'bot', bot.entity.position.toString())
    }
    ;(bot as any)._client.on('explosion', onExplosion)
    const onReflex = (name: string, err?: Error): void => { if (process.env.GHAST_TRACE != null) console.log('reflex', bot.lockstep.ticks, name, err?.message ?? '', 'running', JSON.stringify(bot.survival.reflexes?.current)) }
    bot.on('reflex' as any, onReflex)
    bot.on('reflexFailed' as any, onReflex)
    bot.on('physicsTick', onTick)
    bot.on('death', onDeath)
    bot.survival.reflexes!.enabled = true
    const executor = new Executor(bot, { log: () => {} })
    const t0 = bot.lockstep.ticks
    try {
      for (let trip = 0; trip < 2 && !died && lowest >= y - 1.5; trip++) {
        for (const to of [far, start]) {
          await executor.task('across the bridge', async (s) => await navigate(bot, { goal: new goals.GoalNear(Math.floor(to.x), y, Math.floor(to.z), 1) }, s))
            .catch(err => console.log('the walk:', (err as Error).message))
          if (died || lowest < y - 1.5) break
        }
      }
    } finally {
      bot.removeListener('physicsTick', onTick)
      bot.removeListener('death', onDeath)
      ;(bot as any)._client.removeListener('explosion', onExplosion)
      bot.removeListener('reflex' as any, onReflex)
      bot.removeListener('reflexFailed' as any, onReflex)
      bot.survival.reflexes!.enabled = false
    }
    const ghastAlive = Object.values(bot.entities).some(e => e.name === 'ghast')
    console.log(`across and back twice: ${bot.lockstep.ticks - t0} ticks, ${fireballs} fireballs, the ghast ${ghastAlive ? 'alive' : 'dead'}, lowest ${lowest.toFixed(2)}, ${lava} ticks in lava, health ${bot.health}, at ${bot.entity.position.toString()}`)
    // (one sent back at it kills it: a fireball turned back hurts a ghast 1000, Ghast.isReflectedFireball)
    assert.ok(fireballs >= 1, 'the ghast shot no fireball')
    assert.ok(!died, 'the bot died')
    assert.strictEqual(lava, 0, 'the bot was in the lava')
    assert.ok(lowest >= y - 1.5, `the bot fell to ${lowest.toFixed(2)}`)
    assert.ok(bot.entity.position.distanceTo(start) <= 3, `the walk back ended at ${bot.entity.position.toString()}`)
  })
})
