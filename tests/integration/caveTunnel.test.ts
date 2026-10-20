// The cave rule against a real server (SURVIVAL_VERSION, default 1.21.11; the tests/harness lockstep server, a superflat
// world, normal difficulty, no natural spawning, the reflexes on): a bot not fit for the caves (plain iron, a stone
// sword) mines only in its own tunnels. Each run on fresh ground 64 blocks along from the last, in a block of stone:
// - 'around': the bot in a short tunnel, a cave of cave_air (13 by 11, 6 high) with three zombies in it between the bot
//   and a diamond ore in the rock past it, another diamond ore in the cave's wall facing the bot. The executor's
//   obtain of 1 diamond digs its way round the cave to the one in the rock: the bot's feet never in the cave, the wall's
//   ore left, alive.
// - 'breach': the bot's tunnel already open into the cave at its east end, three zombies in the cave: they come down
//   the tunnel, and the bot walls itself in (the hostiles reflex's wall-in) or seals the hole (the caves reflex) rather
//   than fight in the cave: alive, never in the cave.
// CAVE_RUNS=n repeats each (default 2).
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { createPlugin } from '../../src'
import { Executor } from '../../src/executor/executor'
import { caveEntries, caveReady, caveUnreadiness } from '../../src/skills/caves'
import { countItems } from '../../src/skills/util'
import { isAlive } from '../../src/skills/combatUtil'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { NightLog, summary, type RunLog } from './nightLog'

const USER = 'cavebot'
const RUNS = Number(process.env.CAVE_RUNS ?? 2)
const GROUND = -60

const KIT: Array<[string, number]> = [
  ['iron_helmet', 1], ['iron_chestplate', 1], ['iron_leggings', 1], ['iron_boots', 1],
  ['stone_sword', 1], ['iron_pickaxe', 1], ['cobblestone', 64], ['cooked_beef', 8]
]
const WORN: Record<string, string> = { helmet: 'armor.head', chestplate: 'armor.chest', leggings: 'armor.legs', boots: 'armor.feet' }

let server: TestServer
let bot: Bot
let runs = 0

async function run (cmd: string): Promise<string[]> {
  return await server.command(cmd)
}

async function waitFor (predicate: () => boolean, ticks: number): Promise<boolean> {
  for (let i = 0; i < ticks; i++) {
    if (predicate()) return true
    await bot.waitForTicks(1)
  }
  return predicate()
}

/** the layout of a run at x: the stone, the bot's tunnel (x to x + 3 at z 0), the cave (x + 8 to x + 20, z -5 to 5) */
interface Layout { x: number, start: Vec3, inCave: (p: Vec3) => boolean, rock: Vec3, wall: Vec3 }

async function fresh (breach: boolean): Promise<Layout> {
  if (bot.survival.reflexes != null) bot.survival.reflexes.enabled = false
  bot.survival.tasks.cancelAll('ABORTED', 'reset')
  if (bot.health <= 0) await waitFor(() => bot.health > 0, 200)
  const x = 64 * runs++
  for (const cmd of ['time set 6000', 'kill @e[type=!player]', `clear ${USER}`, `effect clear ${USER}`, `forceload add ${x - 16} -16 ${x + 56} 16`,
    `fill ${x - 2} ${GROUND - 4} -10 ${x + 44} ${GROUND + 10} 10 minecraft:stone`,
    `fill ${x} ${GROUND} 0 ${x + (breach ? 7 : 3)} ${GROUND + 1} 0 minecraft:air`,
    `fill ${x + 8} ${GROUND} -5 ${x + 20} ${GROUND + 5} 5 minecraft:cave_air`]) await run(cmd)
  const rock = new Vec3(x + 30, GROUND, 0)
  const wall = new Vec3(x + 21, GROUND + 1, 0)
  await run(`setblock ${rock.x} ${rock.y} ${rock.z} minecraft:diamond_ore`)
  await run(`setblock ${wall.x} ${wall.y} ${wall.z} minecraft:diamond_ore`)
  const start = new Vec3(x + 1, GROUND, 0)
  await run(`tp ${USER} ${start.x + 0.5} ${GROUND} 0.5 -90 0`)
  await waitFor(() => Math.abs(bot.entity.position.x - start.x - 0.5) < 0.6 && bot.inventory.items().length === 0, 200)
  await bot.waitForChunksToLoad()
  for (const [item, count] of KIT) {
    const kind = /_(helmet|chestplate|leggings|boots)$/.exec(item)?.[1]
    await run(kind != null ? `item replace entity ${USER} ${WORN[kind]} with ${item} ${count}` : `give ${USER} ${item} ${count}`)
  }
  await waitFor(() => countItems(bot, 'cooked_beef') > 0, 200)
  await run(`effect give ${USER} minecraft:instant_health 1 10 true`)
  await run(`effect give ${USER} minecraft:saturation 1 20 true`)
  for (let k = 0; k < 3; k++) await run(`summon minecraft:zombie ${x + 14.5} ${GROUND} ${-2.5 + 2 * k} {PersistenceRequired:1b,CanPickUpLoot:0b}`)
  await bot.waitForTicks(20)
  const inCave = (p: Vec3): boolean => p.x >= x + 8 && p.x < x + 21 && p.z >= -5 && p.z < 6 && p.y >= GROUND && p.y < GROUND + 6
  return { x, start, inCave, rock, wall }
}

/** ticks the bot's feet spent in the cave while `fn` ran */
async function watchCave<T> (layout: Layout, fn: () => Promise<T>): Promise<{ out: T | Error, caveTicks: number, log: RunLog }> {
  const log = new NightLog(bot)
  let caveTicks = 0
  const onTick = (): void => { if (layout.inCave(bot.entity.position)) caveTicks++ }
  bot.on('physicsTick', onTick)
  bot.survival.reflexes!.enabled = true
  let out: T | Error
  try {
    out = await fn()
  } catch (err) {
    out = err as Error
  } finally {
    bot.off('physicsTick', onTick)
    bot.survival.reflexes!.enabled = false
  }
  return { out, caveTicks, log: log.finish() }
}

const zombiesLeft = (): number => Object.values(bot.entities).filter(e => e.name === 'zombie' && isAlive(bot, e)).length

describe(`the cave rule on ${DEFAULT_VERSION}: a bot not fit for the caves mines in its own tunnels`, { timeout: 60 * 60 * 1000 }, () => {
  before(async () => {
    server = await startServer({
      flat: true,
      seed: 'caves',
      difficulty: 'normal',
      gamerules: { advance_time: false, advance_weather: false, spawn_monsters: false, spawn_mobs: false, respawn_radius: 0 },
      startTimeoutMs: 10 * 60 * 1000
    })
    bot = await connectLockstepBot(server, { username: USER, timeoutMs: 120000 })
    await bot.waitForChunksToLoad()
    bot.loadPlugin(createPlugin({}))
    bot.survival.reflexes!.enabled = false
  })

  after(async () => {
    bot?.survival?.reflexes?.stop()
    if (bot != null) await quitBot(bot)
    if (server != null) await server.cleanup()
  })

  test(`a diamond past a cave with zombies: dug round to, the cave never entered (${RUNS} runs)`, async () => {
    const results: string[] = []
    let failed = 0
    for (let i = 0; i < RUNS; i++) {
      const layout = await fresh(false)
      assert.strictEqual(caveReady(bot), false, caveUnreadiness(bot) ?? '')
      const executor = new Executor(bot, { log: line => console.log(`  [executor] ${line}`) })
      const entries = caveEntries(bot)
      const r = await watchCave(layout, async () => await executor.obtain([{ item: 'diamond', count: 1 }]))
      const got = countItems(bot, 'diamond')
      const wallLeft = bot.blockAt(layout.wall)?.name === 'diamond_ore'
      const ok = got >= 1 && r.caveTicks === 0 && r.log.deaths.length === 0
      if (!ok) failed++
      results.push(`run ${i + 1}: ${got} diamond, the rock's ore ${bot.blockAt(layout.rock)?.name === 'diamond_ore' ? 'left' : 'mined'}, the wall's ${wallLeft ? 'left' : 'mined'}, ${r.caveTicks} ticks in the cave, ${caveEntries(bot) - entries} entries, ${summary(r.log)}${r.out instanceof Error ? `; ${r.out.message}` : ''}`)
    }
    for (const l of results) console.log(`[caves] around: ${l}`)
    assert.strictEqual(failed, 0, results.join('\n'))
  })

  test(`a tunnel open into a cave, its zombies coming: walled in or sealed, alive, never in the cave (${RUNS} runs)`, async () => {
    const results: string[] = []
    let failed = 0
    for (let i = 0; i < RUNS; i++) {
      const layout = await fresh(true)
      let walls = 0
      let seals = 0
      const onReflex = (_name: string, detail?: string): void => { if (detail === 'wall in') walls++; if (/^seal \d/.test(detail ?? '')) seals++ }
      bot.on('reflex' as any, onReflex)
      // the foreground at work where it stands, resumed after each reflex
      const handle = bot.survival.tasks.enqueue({ name: 'mine', onPreempt: 'resume' }, async (ctx) => { await ctx.waitTicks(1000000) })
      handle.result.catch(() => {})
      let died = false
      const onDeath = (): void => { died = true }
      bot.on('death', onDeath)
      const r = await watchCave(layout, async () => await waitFor(() => died, 2400))
      handle.cancel('run over')
      bot.off('death', onDeath)
      bot.off('reflex' as any, onReflex)
      const ok = !died && r.caveTicks === 0
      if (!ok) failed++
      results.push(`run ${i + 1}: ${walls} wall-ins, ${seals} seals, ${zombiesLeft()} zombies left, ${r.caveTicks} ticks in the cave, ${summary(r.log)}`)
    }
    for (const l of results) console.log(`[caves] breach: ${l}`)
    assert.strictEqual(failed, 0, results.join('\n'))
  })
})
