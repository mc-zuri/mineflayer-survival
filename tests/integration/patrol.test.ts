// Fights of the overworld's real-run deaths on a SURVIVAL_VERSION (default 1.21.11) superflat world (the tests/harness lockstep
// server, normal difficulty, no natural spawning, the reflexes on), each run on fresh ground 64 blocks along from the last:
// - a pillager patrol of 3 (one a captain, with its banner) by a hut with a door, the bot bare or in iron with a shield;
// - a night with a skeleton, a spider and a creeper summoned about a bot walking up and down, bare or in iron;
// - the runner's wait for the day after a respawn (waitOutTheNight) as the night ends, the night reflex on.
// PATROL_RUNS=n repeats each (default 3); NIGHT_VERBOSE=1 logs each hit, kill and reflex.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { goals } from '@nxg-org/mineflayer-pathfinder'
import { createPlugin } from '../../src'
import { navigate } from '../../src/skills/navigate'
import { isEnclosed, shelterToLeave } from '../../src/skills/shelter'
import { waitOutTheNight } from '../../src/runner'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { NightLog, summary, type RunLog } from './nightLog'

const USER = 'patrolbot'
const RUNS = Number(process.env.PATROL_RUNS ?? 3)
// the superflat's ground: grass at y -61, the bot standing at -60
const GROUND = -60

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

async function give (item: string, count = 1): Promise<void> {
  await run(`give ${USER} ${item} ${count}`)
}

const IRON_KIT = ['iron_sword', 'shield', 'iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots']

/** a fresh patch of ground 64 blocks along from the last: the bot there at full health and food, its bag empty, no mobs, at `time` */
async function freshGround (time: number): Promise<Vec3> {
  if (bot.survival.reflexes != null) bot.survival.reflexes.enabled = false
  bot.survival.tasks.cancelAll('ABORTED', 'reset')
  if (bot.health <= 0) await waitFor(() => bot.health > 0, 200)
  bot.clearControlStates()
  bot.deactivateItem()
  const x = 64 * runs++
  for (const cmd of ['gamerule advance_time false', `time set ${time}`, 'kill @e[type=!player]', `clear ${USER}`, `effect clear ${USER}`,
    `tp ${USER} ${x + 0.5} ${GROUND} 0.5`, `effect give ${USER} minecraft:instant_health 1 10 true`, `effect give ${USER} minecraft:saturation 1 20 true`]) {
    await run(cmd)
  }
  await waitFor(() => Math.abs(bot.entity.position.x - x - 0.5) < 1 && bot.inventory.items().length === 0, 100)
  await bot.waitForChunksToLoad()
  await bot.waitForTicks(20)
  return new Vec3(x, GROUND, 0)
}

/**
 * A hut of cobblestone 5 by 5 (inside 3 by 3, 3 high) with its floor at the ground, its door on the west wall facing
 * east (closed), 10 blocks east of `at`; the door's cell
 */
async function buildHut (at: Vec3): Promise<Vec3> {
  const x0 = at.x + 10
  await run(`fill ${x0} ${GROUND} -2 ${x0 + 4} ${GROUND + 3} 2 minecraft:cobblestone hollow`)
  await run(`setblock ${x0} ${GROUND} 0 minecraft:oak_door[facing=east,half=lower,hinge=left,open=false]`)
  await run(`setblock ${x0} ${GROUND + 1} 0 minecraft:oak_door[facing=east,half=upper,hinge=left,open=false]`)
  return new Vec3(x0, GROUND, 0)
}

const count = (lines: string[]): number => {
  const m = /count: (\d+)/i.exec(lines.join(' '))
  return m == null ? 0 : Number(m[1])
}

/**
 * A pillager patrol of 3 at `at`: pillagers summoned in a pen 60 blocks off (each its crossbow, Pillager's
 * finalizeSpawn, and 6% of them a captain with the ominous banner, PatrollingMonster's) till there's a captain and
 * two more, the rest killed, the three put at `at`
 */
async function summonPatrol (at: Vec3): Promise<void> {
  const pen = at.offset(-60, 0, 0)
  await run(`fill ${pen.x - 2} ${GROUND} -2 ${pen.x + 2} ${GROUND + 2} 2 minecraft:glass hollow`)
  const inPen = `x=${pen.x - 3},y=${GROUND - 1},z=-3,dx=6,dy=5,dz=6`
  for (let i = 0; i < 300; i++) {
    const leaders = count(await run(`execute if entity @e[type=pillager,${inPen},nbt={PatrolLeader:1b}]`))
    const others = count(await run(`execute if entity @e[type=pillager,${inPen},nbt={PatrolLeader:0b}]`))
    if (leaders === 1 && others === 2) break
    if (leaders > 1) await run(`kill @e[type=pillager,${inPen},nbt={PatrolLeader:1b},limit=1]`)
    else if (others > 2) await run(`kill @e[type=pillager,${inPen},nbt={PatrolLeader:0b},limit=1]`)
    else await run(`summon minecraft:pillager ${pen.x + 0.5} ${GROUND} 0.5`)
  }
  await run(`tp @e[type=pillager,${inPen}] ${at.x + 0.5} ${GROUND} ${at.z + 0.5}`)
  await run(`fill ${pen.x - 2} ${GROUND} -2 ${pen.x + 2} ${GROUND + 2} 2 minecraft:air`)
}

/** walks back and forth between two points as the foreground task (reflexes preempt it and it resumes) */
function walkBetween (a: Vec3, b: Vec3): { stop: () => void } {
  let stopped = false
  const handle = bot.survival.tasks.enqueue({ name: 'walk', onPreempt: 'resume' }, async (ctx) => {
    let i = (ctx.state as any).leg ?? 0
    while (!stopped) {
      const to = i % 2 === 0 ? b : a
      try {
        await navigate(bot, { goal: new goals.GoalNearXZ(to.x, to.z, 1) }, ctx.signal)
      } catch (err) {
        if (ctx.signal.aborted) throw err
        await ctx.waitTicks(20)
      }
      i++
      ;(ctx.state as any).leg = i
      await ctx.waitTicks(20)
    }
  })
  handle.result.catch(() => {})
  return { stop: () => { stopped = true; handle.cancel('run over') } }
}

/** `ticks` with the reflexes on and the foreground task running (or till the bot dies); the log */
async function fightFor (ticks: number, foreground: () => { stop: () => void }, until: () => boolean = () => false): Promise<RunLog> {
  const log = new NightLog(bot)
  bot.survival.reflexes!.enabled = true
  const task = foreground()
  let died = false
  const onDeath = (): void => { died = true }
  bot.on('death', onDeath)
  try {
    await waitFor(() => died || until(), ticks)
  } finally {
    bot.off('death', onDeath)
    task.stop()
    bot.survival.reflexes!.enabled = false
  }
  if (died) await bot.waitForTicks(5)
  return log.finish()
}

const badOmen = (): boolean => {
  const id = (bot.registry as any).effectsByName?.BadOmen?.id
  return id != null && (bot.entity as any).effects?.[id] != null
}

function report (t: any, what: string, logs: RunLog[], extra: (i: number) => string = () => ''): void {
  logs.forEach((log, i) => t.diagnostic(`run ${i + 1}: ${extra(i)}${summary(log)}`))
  const failed = logs.filter(l => l.deaths.length > 0).length
  t.diagnostic(`${what}: ${RUNS - failed}/${RUNS} survived`)
  assert.strictEqual(failed, 0, logs.map(summary).join('\n'))
}

describe(`pillager patrols and night mobs on ${DEFAULT_VERSION} (normal difficulty)`, { timeout: 120 * 60 * 1000 }, () => {
  before(async () => {
    server = await startServer({
      flat: true,
      seed: 'patrol',
      difficulty: 'normal',
      gamerules: { advance_time: false, advance_weather: false, spawn_monsters: false, spawn_mobs: false, respawn_radius: 0 },
      startTimeoutMs: 10 * 60 * 1000
    })
    bot = await connectLockstepBot(server, { username: USER })
    await bot.waitForChunksToLoad()
    bot.loadPlugin(createPlugin({}))
    bot.survival.reflexes!.enabled = false
  })

  after(async () => {
    bot?.survival?.reflexes?.stop()
    if (bot != null) await quitBot(bot)
    if (server != null) await server.cleanup()
  })

  test(`bare (back from a death), a pillager patrol of 3 by a hut with a door: alive (${RUNS} runs)`, async (t) => {
    const logs: RunLog[] = []
    const inside: boolean[] = []
    for (let i = 0; i < RUNS; i++) {
      const home = await freshGround(6000)
      const door = await buildHut(home)
      await give('dirt', 8)
      await summonPatrol(home.offset(-18, 0, 0))
      const log = await fightFor(1500, () => walkBetween(home, home.offset(0, 0, 8)))
      const p = bot.entity.position
      inside.push(p.x > door.x && p.x < door.x + 4 && Math.abs(p.z) < 2)
      logs.push(log)
    }
    report(t, 'bare by a hut', logs, i => inside[i] ? 'in the hut, ' : 'out, ')
  })

  test(`an iron kit and a shield, a pillager patrol of 3 in the open: alive, the patrol fought, no Bad Omen (${RUNS} runs)`, async (t) => {
    const logs: RunLog[] = []
    const omen: boolean[] = []
    for (let i = 0; i < RUNS; i++) {
      const home = await freshGround(6000)
      for (const item of IRON_KIT) await give(item)
      await give('cooked_beef', 16)
      await bot.waitForTicks(10)
      await summonPatrol(home.offset(-18, 0, 0))
      const log = await fightFor(1500, () => walkBetween(home, home.offset(0, 0, 8)), () => bot.nearestEntity(e => e.name === 'pillager') == null)
      await bot.waitForTicks(40)
      omen.push(badOmen())
      if (omen[i]) log.deaths.push('Bad Omen')
      logs.push(log)
    }
    report(t, 'iron kit vs a patrol', logs, i => omen[i] ? 'BAD OMEN, ' : '')
  })

  for (const kit of ['iron', 'bare'] as const) {
    test(`night, ${kit === 'iron' ? 'an iron kit' : 'bare (back from a death)'}: a skeleton, a spider and a creeper about the bot at its walk: alive (${RUNS} runs)`, async (t) => {
      const logs: RunLog[] = []
      for (let i = 0; i < RUNS; i++) {
        const home = await freshGround(18000)
        if (kit === 'iron') {
          for (const item of IRON_KIT) await give(item)
          await give('cooked_beef', 16)
        }
        await bot.waitForTicks(10)
        await run(`summon minecraft:skeleton ${home.x + 12.5} ${GROUND} 6.5`)
        await run(`summon minecraft:spider ${home.x - 8.5} ${GROUND} -4.5`)
        await run(`summon minecraft:creeper ${home.x + 2.5} ${GROUND} -11.5`)
        logs.push(await fightFor(1200, () => walkBetween(home, home.offset(10, 0, 0))))
      }
      report(t, `night, ${kit}`, logs)
    })
  }

  test(`the respawn's wait for the day (waitOutTheNight) at the night's end, the night reflex on: out of its hole by day and done (${RUNS} runs)`, async (t) => {
    const logs: RunLog[] = []
    const outcome: string[] = []
    for (let i = 0; i < RUNS; i++) {
      await freshGround(22000)
      await give('dirt', 2)
      await run('gamerule advance_time true')
      let done = false
      let attempts = 0
      const log = await fightFor(4000, () => {
        const handle = bot.survival.tasks.enqueue({ name: 'wait out the night' }, async (ctx) => { attempts++; return await waitOutTheNight(bot, ctx.signal) })
        handle.result.then(() => { done = true }, () => {})
        return { stop: () => handle.cancel('run over') }
      }, () => {
        const t = bot.time.timeOfDay
        return done && t > 0 && t < 12000 && shelterToLeave(bot) == null && !isEnclosed((p) => bot.blockAt(p) as any, bot.entity.position)
      })
      await run('gamerule advance_time false')
      const out = done && shelterToLeave(bot) == null && !isEnclosed((p) => bot.blockAt(p) as any, bot.entity.position)
      outcome.push(`${out ? 'out and done' : done ? 'done, NOT OUT' : 'NOT DONE'} at time ${bot.time.timeOfDay} after ${attempts} tries, `)
      if (!out) log.deaths.push('not out of the hole by day')
      // (each try a hole dug and climbed out of: once or twice is the night's)
      if (attempts > 3) log.deaths.push(`${attempts} tries`)
      logs.push(log)
    }
    report(t, 'the respawn\'s night wait', logs, i => outcome[i])
  })
})
