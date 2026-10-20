// Walks along a 30-high cliff's edge, as lockstep scenarios on a SURVIVAL_VERSION (default 1.21.11) superflat world
// (the tests/harness server, no mobs): a plateau of stone 30 blocks over the grass, its rim notched, a ledge one block
// wide out from it over the drop with a turn in it (the bridges the explore legs built, full-26.3-fresh-r), the bot
// with a stack of cobblestone. Each run, on fresh ground 64 blocks along from the last: gotos to the rim's corners, out
// along the ledge, round its turn and back, then the explore legs of a spiral over the plateau and out past its edges.
// Then the same ground with the gotos' Forward moves made to run on 2 blocks past their end (the fault the guard is the
// last line against). The whole-game runs lost their kits to such falls: 31 blocks off a move that ran on
// (full-26.3-fresh-o), 35 off a bridge on an explore leg (full-26.3-fresh-r), 26 off a bridge's turn (full-26.3-fresh-r,
// t347511). CLIFF_RUNS=n runs (default 3) of each, each must end with no fall; CLIFF_GUARD=off turns the pathfinder's
// edge guard off (the before).
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { goals } from '@nxg-org/mineflayer-pathfinder'
import { createPlugin } from '../../src'
import { navigate } from '../../src/skills/navigate'
import { exploreSurface } from '../../src/executor/explore'
import { countItems } from '../../src/skills/util'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'

const USER = 'cliffbot'
const RUNS = Number(process.env.CLIFF_RUNS ?? 3)
const GUARD = process.env.CLIFF_GUARD !== 'off'
/** the superflat's ground: grass at y -61, the bot standing at -60 */
const GROUND = -60
/** the cliff's height: the plateau's top stood on at GROUND + HEIGHT */
const HEIGHT = 30
/** the plateau's side */
const SIDE = 16
/** a run's ticks at most */
const RUN_TICKS = 6000

let server: TestServer
let bot: Bot

async function run (cmd: string): Promise<string[]> { return await server.command(cmd) }
async function waitFor (predicate: () => boolean, ticks: number): Promise<boolean> {
  for (let i = 0; i < ticks; i++) {
    if (predicate()) return true
    await bot.waitForTicks(1)
  }
  return predicate()
}

/**
 * The plateau with its corner at (x0, z0): stone from the ground up to the top's floor, two notches cut in its rim, and
 * the ledge from its +x side's middle: 12 out along +x, then 10 along +z, one block wide at the top's floor
 */
async function buildCliff (x0: number, z0: number): Promise<{ top: number, rim: Vec3[], ledge: Vec3[] }> {
  const floor = GROUND + HEIGHT - 1
  await run(`fill ${x0 - 6} ${GROUND} ${z0 - 6} ${x0 + SIDE + 18} ${floor + 4} ${z0 + SIDE + 18} minecraft:air`)
  // (fill's limit is 32768 blocks: the plateau in slices)
  for (let y = GROUND; y <= floor; y += 8) await run(`fill ${x0} ${y} ${z0} ${x0 + SIDE - 1} ${Math.min(floor, y + 7)} ${z0 + SIDE - 1} minecraft:stone`)
  // the notches: a bite out of the -z rim and one out of the +z rim, all the way down
  await run(`fill ${x0 + 4} ${GROUND} ${z0} ${x0 + 6} ${floor} ${z0 + 1} minecraft:air`)
  await run(`fill ${x0 + 9} ${GROUND} ${z0 + SIDE - 2} ${x0 + 10} ${floor} ${z0 + SIDE - 1} minecraft:air`)
  const mid = z0 + Math.floor(SIDE / 2)
  const out = x0 + SIDE + 11
  await run(`fill ${x0 + SIDE} ${floor} ${mid} ${out} ${floor} ${mid} minecraft:stone`)
  await run(`fill ${out} ${floor} ${mid} ${out} ${floor} ${mid + 10} minecraft:stone`)
  const top = floor + 1
  const rim = [new Vec3(x0, top, z0 + 2), new Vec3(x0 + SIDE - 1, top, z0), new Vec3(x0 + SIDE - 1, top, z0 + SIDE - 1), new Vec3(x0, top, z0 + SIDE - 1)]
  const ledge = [new Vec3(out, top, mid), new Vec3(out, top, mid + 10)]
  return { top, rim, ledge }
}

describe(`a 30-high cliff's edge on ${DEFAULT_VERSION}`, { timeout: 120 * 60 * 1000 }, () => {
  before(async () => {
    server = await startServer({
      flat: true,
      seed: 'cliff',
      difficulty: 'normal',
      gamerules: { advance_time: false, advance_weather: false, spawn_monsters: false, spawn_mobs: false },
      startTimeoutMs: 10 * 60 * 1000
    })
    bot = await connectLockstepBot(server, { username: USER, timeoutMs: 120000 })
    await bot.waitForChunksToLoad()
    bot.loadPlugin(createPlugin({}))
    bot.survival.reflexes!.enabled = false
    if (!GUARD) (bot.pathfinder as any).edgeGuard.mode = 'off'
  })

  after(async () => {
    bot?.survival?.reflexes?.stop()
    if (bot != null) await quitBot(bot)
    if (server != null) await server.cleanup()
  })

  /** the bot put on a new cliff's plateau (64 blocks along from the last), its kit given, the bag and the health full */
  let cliffs = 0
  async function newCliff (): Promise<{ top: number, rim: Vec3[], ledge: Vec3[], start: Vec3 }> {
    const x0 = 64 * ++cliffs
    const z0 = 0
    await run(`forceload add ${x0 - 32} ${z0 - 32} ${x0 + 64} ${z0 + 64}`)
    const cliff = await buildCliff(x0, z0)
    if (bot.health <= 0) await waitFor(() => bot.health > 0, 200)
    bot.clearControlStates()
    for (const cmd of [`clear ${USER}`, `effect clear ${USER}`, `give ${USER} cobblestone 32`, `give ${USER} bread 16`]) await run(cmd)
    await run(`effect give ${USER} minecraft:instant_health 1 10 true`)
    await run(`effect give ${USER} minecraft:saturation 1 20 true`)
    const start = new Vec3(x0 + SIDE / 2, cliff.top, z0 + SIDE / 2)
    await run(`tp ${USER} ${start.x + 0.5} ${cliff.top} ${start.z + 0.5}`)
    await waitFor(() => bot.entity.position.distanceTo(start.offset(0.5, 0, 0.5)) < 2 && bot.entity.onGround, 400)
    await bot.waitForChunksToLoad()
    await waitFor(() => countItems(bot, 'cobblestone') >= 32, 200)
    return { ...cliff, start }
  }

  /**
   * The falls while `fn` runs (a way down of more than 4 blocks in the air from where the bot last stood, swam or
   * climbed: a dig down the plateau, a block at a time, is none), the lowest the bot got, the guard's catches and the
   * ticks it took
   */
  async function watchFalls (t: any, label: string, fn: (fell: () => boolean) => Promise<void>): Promise<{ falls: number, lowest: number, catches: number, ticks: number }> {
    let lowest = Infinity
    let falls = 0
    let stood = bot.entity.position.y
    let ticks = 0
    const catches0 = (bot.pathfinder as any).edgeGuard.catches as number
    const onTick = (): void => {
      ticks++
      const y = bot.entity.position.y
      lowest = Math.min(lowest, y)
      const e = bot.entity as any
      if (e.onGround === true || e.isInWater === true || e.onClimbable === true) stood = y
      if (falls === 0 && stood - y > 4) {
        falls++
        t.diagnostic(`${label}: FELL from about ${bot.entity.position.floored().toString()}`)
      }
    }
    bot.on('physicsTick', onTick)
    try {
      await fn(() => falls > 0)
    } finally {
      bot.off('physicsTick', onTick)
    }
    // (a fall under way at the end is waited out)
    await waitFor(() => bot.entity.onGround, 100)
    return { falls, lowest, catches: ((bot.pathfinder as any).edgeGuard.catches as number) - catches0, ticks }
  }

  test(`gotos along the rim and a ledge and explore legs past the edges: no fall (${RUNS} runs, the guard ${GUARD ? 'on' : 'off'})`, async (t) => {
    const results: string[] = []
    let failed = 0
    for (let i = 0; i < RUNS; i++) {
      const { top, rim, ledge, start } = await newCliff()
      const walks: string[] = []
      const abort = new AbortController()
      const r = await watchFalls(t, `run ${i + 1}`, async (fell) => {
        let ticks = 0
        const timer = (): void => { if (++ticks > RUN_TICKS) abort.abort() }
        bot.on('physicsTick', timer)
        try {
          // the gotos: the rim's corners, out along the ledge and round its turn, back to the plateau
          for (const to of [...rim, ...ledge, ledge[0], rim[1], start]) {
            if (fell() || abort.signal.aborted) break
            try {
              await navigate(bot, { goal: new goals.GoalNear(to.x, to.y, to.z, 1) }, abort.signal)
              walks.push('ok')
            } catch (err) {
              walks.push((err as any).code ?? 'err')
            }
          }
          // the explore legs: a spiral over the plateau and out past its edges, 30 below
          if (!fell() && !abort.signal.aborted) {
            await exploreSurface(bot, { found: fell, center: start, step: 8, maxRadius: 24 }, abort.signal).catch(() => {})
          }
        } finally {
          bot.off('physicsTick', timer)
        }
      })
      const line = `run ${i + 1}: ${r.falls > 0 ? 'FELL' : 'no fall'}, lowest y ${r.lowest.toFixed(1)} (top ${top}), health ${bot.health.toFixed(1)}, ${r.ticks} ticks, gotos ${walks.join(' ')}, guard catches ${r.catches}`
      t.diagnostic(line)
      results.push(line)
      if (r.falls > 0 || bot.health <= 0) failed++
      await bot.waitForTicks(20)
    }
    console.log(`[cliff] ${RUNS - failed}/${RUNS} with no fall (the guard ${GUARD ? 'on' : 'off'})`)
    assert.strictEqual(failed, 0, results.join('\n'))
  })

  test(`a goto whose moves run on 2 blocks past their end, along the rim and out the ledge: no fall (${RUNS} runs, the guard ${GUARD ? 'on' : 'off'})`, async (t) => {
    // a Forward executor that holds forward and sprint along its move till 2 blocks past its exit (an overshoot: a
    // run's momentum, an alignment that never held as full-26.3-fresh-o's), on the real server
    const { NewForwardExecutor } = require('@nxg-org/mineflayer-pathfinder/dist/mineflayer-specific/movements/movementExecutors')
    const { movementProviders } = require('@nxg-org/mineflayer-pathfinder')
    class RunsOn extends NewForwardExecutor {
      async align (): Promise<boolean> { return true }
      async performInit (): Promise<void> {}
      isAlreadyCompleted (): boolean { return false }
      async performPerTick (move: any): Promise<boolean> {
        const d = move.exitPos.minus(move.entryPos)
        const dir = d.scaled(1 / Math.max(1e-6, Math.hypot(d.x, d.z)))
        const pos = this.bot.entity.position
        void this.bot.look(Math.atan2(-dir.x, -dir.z), 0, true)
        this.bot.setControlState('forward', true)
        this.bot.setControlState('sprint', true)
        return (pos.x - move.exitPos.x) * dir.x + (pos.z - move.exitPos.z) * dir.z > 2
      }
    }
    const pf = bot.pathfinder as any
    const results: string[] = []
    let failed = 0
    for (let i = 0; i < RUNS; i++) {
      const { top, rim, ledge, start } = await newCliff()
      const walks: string[] = []
      const saved = pf.movements.get(movementProviders.Forward)
      pf.setExecutor(movementProviders.Forward, RunsOn)
      const r = await watchFalls(t, `fault run ${i + 1}`, async (fell) => {
        try {
          // out along the ledge round its turn to its end and back, twice (navigate stops a goto near its goal: the run
          // on past a move's end is at the turn)
          for (const to of [ledge[1], start, ledge[1], start]) {
            if (fell()) break
            const abort = new AbortController()
            let ticks = 0
            const timer = (): void => { if (++ticks > 600) abort.abort() }
            bot.on('physicsTick', timer)
            try {
              await navigate(bot, { goal: new goals.GoalNear(to.x, to.y, to.z, 0) }, abort.signal)
              walks.push(`ok@${bot.entity.position.floored().toString()}`)
            } catch (err) {
              walks.push(`${String((err as any).code ?? 'err')}@${bot.entity.position.floored().toString()}`)
            } finally {
              bot.off('physicsTick', timer)
            }
          }
        } finally {
          pf.setExecutor(movementProviders.Forward, saved)
        }
      })
      const line = `fault run ${i + 1}: ${r.falls > 0 ? 'FELL' : 'no fall'}, lowest y ${r.lowest.toFixed(1)} (top ${top}), health ${bot.health.toFixed(1)}, ${r.ticks} ticks, gotos ${walks.join(' ')}, guard catches ${r.catches}`
      t.diagnostic(line)
      results.push(line)
      if (r.falls > 0 || bot.health <= 0) failed++
      await bot.waitForTicks(20)
    }
    console.log(`[cliff] fault: ${RUNS - failed}/${RUNS} with no fall (the guard ${GUARD ? 'on' : 'off'})`)
    assert.strictEqual(failed, 0, results.join('\n'))
  })
})
