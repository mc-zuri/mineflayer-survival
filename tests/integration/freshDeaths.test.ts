// The fights a 26.3 whole game on seed 2 died in (full-26.3-fresh-d), as lockstep scenarios on a SURVIVAL_VERSION
// (default 1.21.11) superflat world (the tests/harness server, normal difficulty, no natural spawning, the reflexes on),
// each run on fresh ground 64 blocks along from the last:
// - a fortress corridor of nether bricks in the nether (3 wide, 4 high), one or two wither skeletons down it, the bot
//   walking it with the nether's kit (FRESH_KIT: 'run', that run's iron armor, golden boots, a diamond sword, a shield
//   and a bow; 'stage', the nether stage's enchanted diamond): the run died to one at 8.8 health, walking its retreat
//   from the blazes 36 blocks along the corridors;
// - a night in the overworld with endermen about (summoned 12 to 20 off on stone ground), the bot with the run's kit
//   after pearls by night (pearlsByNight): the run lost two bare bots to an enderman out on the grass;
// - a re-geared bot (an iron chestplate and an iron sword) at night by its base (a hut with a door), three skeletons
//   about, walking out to a death spot 24 blocks off and back: the run's three skeleton deaths about the base;
// - a bare bot by day walking past a skeleton in the shade of a roof 8 blocks off its way (the run's last two deaths, by
//   its death spot: the flee ended a step on and the walk went back into the skeleton's sight).
// - (nether-26.3-q3) a ledge over the lava sea in the nether, its slope down to the shore where two skeletons stand (a third on a pillar out in the lava), the
//   bot with that run's kit (diamond, a shield, a bow, its 16 pearls and 10 rods) walking the ledge: the run chased one
//   down a soul sand valley into the lava sea.
// - (nether-26.3-q3) a 1-wide tunnel in stone, a creeper coming down it at a bot with an iron sword and no shield
//   mining at its dead end: that run was blown up there at y 11, cornered.
// FRESH_RUNS=n repeats each (default 3); NIGHT_VERBOSE=1 logs each hit, kill and reflex.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { goals } from '@nxg-org/mineflayer-pathfinder'
import { createPlugin } from '../../src'
import { navigate } from '../../src/skills/navigate'
import { pearlsByNight } from '../../src/milestones'
import { Executor } from '../../src/executor/executor'
import { countItems } from '../../src/skills/util'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { NightLog, summary, type RunLog } from './nightLog'
import { STAGES } from './stageKits'

const USER = 'freshbot'
const RUNS = Number(process.env.FRESH_RUNS ?? 3)
const KIT = process.env.FRESH_KIT ?? 'run'
/** the health the corridor's runs start at (the run's bot met the wither skeleton at 8.8) */
const HEALTH = Number(process.env.FRESH_HEALTH ?? 20)
// the superflat's ground: grass at y -61, the bot standing at -60
const GROUND = -60
// the corridor's floor in the nether: over the lava sea, under the roof
const CORRIDOR_Y = 100

let server: TestServer
let bot: Bot
let runs = 0

async function run (cmd: string): Promise<string[]> {
  return await server.command(cmd)
}
const nether = async (cmd: string): Promise<string[]> => await run(`execute in minecraft:the_nether run ${cmd}`)

async function waitFor (predicate: () => boolean, ticks: number): Promise<boolean> {
  for (let i = 0; i < ticks; i++) {
    if (predicate()) return true
    await bot.waitForTicks(1)
  }
  return predicate()
}

/** full-26.3-fresh-d's bag going into the nether (iron armor, golden boots, a plain diamond sword, a shield, a bow) */
const RUN_KIT: Array<[string, number]> = [
  ['iron_helmet', 1], ['iron_chestplate', 1], ['iron_leggings', 1], ['golden_boots', 1], ['shield', 1],
  ['diamond_sword', 1], ['diamond_pickaxe', 1], ['bow', 1], ['arrow', 16], ['cooked_beef', 16], ['cobblestone', 64], ['netherrack', 64]
]
/** what a death's re-equip gave it back at the base (an iron chestplate and sword, a pickaxe, some bread) */
const REGEAR_KIT: Array<[string, number]> = [['iron_chestplate', 1], ['iron_sword', 1], ['iron_pickaxe', 1], ['bread', 8], ['cobblestone', 32]]

const WORN: Record<string, string> = { helmet: 'armor.head', chestplate: 'armor.chest', leggings: 'armor.legs', boots: 'armor.feet' }

/** the kit worn and given (the armor and the shield put on, the rest in the bag) */
async function giveKit (kit: Array<[string, number]>): Promise<void> {
  for (const [item, count] of kit) {
    const kind = /_(helmet|chestplate|leggings|boots)(\[|$)/.exec(item)?.[1]
    const slot = kind != null ? WORN[kind] : /^shield(\[|$)/.test(item) ? 'weapon.offhand' : null
    await run(slot != null ? `item replace entity ${USER} ${slot} with ${item} ${count}` : `give ${USER} ${item} ${count}`)
  }
  const last = kit.filter(([i]) => !/_(helmet|chestplate|leggings|boots)$|^shield$/.test(i)).slice(-1)[0][0].replace(/\[.*$/, '')
  await waitFor(() => countItems(bot, last) > 0, 200)
}

/** the reflexes and tasks off, the bot alive, its bag empty, no mobs; then `place` puts it on its fresh ground */
async function reset (time: number): Promise<number> {
  if (bot.survival.reflexes != null) bot.survival.reflexes.enabled = false
  bot.survival.tasks.cancelAll('ABORTED', 'reset')
  if (bot.health <= 0) await waitFor(() => bot.health > 0, 200)
  bot.clearControlStates()
  bot.deactivateItem()
  for (const cmd of ['gamerule advance_time false', `time set ${time}`, 'kill @e[type=!player]', `execute in minecraft:the_nether run kill @e[type=!player]`,
    `clear ${USER}`, `effect clear ${USER}`]) {
    await run(cmd)
  }
  return 64 * runs++
}

async function healUp (): Promise<void> {
  await run(`effect give ${USER} minecraft:instant_health 1 10 true`)
  await run(`effect give ${USER} minecraft:saturation 1 20 true`)
  await bot.waitForTicks(10)
}

/** fresh overworld ground at x: the bot at full health on it */
async function freshGround (time: number, stone = false): Promise<Vec3> {
  const x = await reset(time)
  await run(`tp ${USER} ${x + 0.5} ${GROUND} 0.5`)
  await waitFor(() => Math.abs(bot.entity.position.x - x - 0.5) < 1 && bot.inventory.items().length === 0, 100)
  await bot.waitForChunksToLoad()
  // (stone under it, the classic superflat's three blocks of dirt and grass: ground an enderman cover's ceiling holds
  // in; filled once the bot is there, its chunks loaded)
  if (stone) await run(`fill ${x - 24} ${GROUND - 3} -24 ${x + 24} ${GROUND - 1} 24 minecraft:stone`)
  await healUp()
  return new Vec3(x, GROUND, 0)
}

/**
 * A fortress corridor in the nether at x (nether bricks, inside 3 wide and 4 high, 40 long along x, shut at both ends,
 * its floor at CORRIDOR_Y), the bot at its west end at full health; the corridor's west end inside
 */
async function freshCorridor (): Promise<Vec3> {
  const x = await reset(18000)
  await nether(`forceload add ${x - 8} -8 ${x + 48} 8`)
  await nether(`fill ${x - 1} ${CORRIDOR_Y - 1} -2 ${x + 41} ${CORRIDOR_Y + 4} 2 minecraft:nether_bricks hollow`)
  // the bricks' light: none, as a fortress's corridors
  await nether(`tp ${USER} ${x + 2.5} ${CORRIDOR_Y} 0.5`)
  await waitFor(() => /nether/.test(String(bot.game?.dimension ?? '')) && Math.abs(bot.entity.position.x - x - 2.5) < 1, 400)
  await bot.waitForChunksToLoad()
  await waitFor(() => bot.inventory.items().length === 0, 100)
  await healUp()
  return new Vec3(x, CORRIDOR_Y, 0)
}

/** that run's bag on its way back to the portal */
const LEDGE_KIT: Array<[string, number]> = [
  ['diamond_helmet', 1], ['diamond_chestplate', 1], ['diamond_leggings', 1], ['shield', 1], ['diamond_sword', 1], ['bow', 1],
  ['arrow', 64], ['cooked_beef', 16], ['netherrack', 64], ['ender_pearl', 16], ['blaze_rod', 10]
]

/**
 * A ledge over the lava sea in the nether at x (soul soil, 3 wide along x at z -1 to 1, its floor at CORRIDOR_Y - 1),
 * a staircase down its +z side (a block down every 2) to a shore at z 10 and 11 one over the lava, the lava sea beyond
 * it and under all, and a pillar out in the lava at z 16; the bot on the ledge's west end
 */
async function freshLedge (): Promise<Vec3> {
  const x = await reset(18000)
  const y = CORRIDOR_Y
  await nether(`forceload add ${x - 8} -16 ${x + 48} 32`)
  await nether(`fill ${x - 4} ${y - 9} -4 ${x + 40} ${y + 6} 22 minecraft:air`)
  await nether(`fill ${x - 4} ${y - 10} -4 ${x + 40} ${y - 10} 22 minecraft:netherrack`)
  await nether(`fill ${x - 4} ${y - 9} -4 ${x + 40} ${y - 7} 22 minecraft:lava`)
  await nether(`fill ${x} ${y - 9} -1 ${x + 32} ${y - 1} 1 minecraft:soul_soil`)
  for (let k = 0; k < 4; k++) await nether(`fill ${x} ${y - 9} ${2 + 2 * k} ${x + 32} ${y - 2 - k} ${3 + 2 * k} minecraft:soul_soil`)
  await nether(`fill ${x} ${y - 9} 10 ${x + 32} ${y - 6} 11 minecraft:soul_soil`)
  await nether(`fill ${x + 15} ${y - 9} 16 ${x + 16} ${y - 4} 17 minecraft:soul_soil`)
  await nether(`tp ${USER} ${x + 1.5} ${y} 0.5`)
  await waitFor(() => /nether/.test(String(bot.game?.dimension ?? '')) && Math.abs(bot.entity.position.x - x - 1.5) < 1, 400)
  await bot.waitForChunksToLoad()
  await waitFor(() => bot.inventory.items().length === 0, 100)
  await healUp()
  return new Vec3(x, y, 0)
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

/** `ticks` with the reflexes on and the foreground task running (or till the bot dies, or `until`); the log */
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

function report (t: any, what: string, logs: RunLog[], extra: (i: number) => string = () => ''): void {
  logs.forEach((log, i) => t.diagnostic(`run ${i + 1}: ${extra(i)}${summary(log)}`))
  const failed = logs.filter(l => l.deaths.length > 0).length
  t.diagnostic(`${what}: ${logs.length - failed}/${logs.length} survived`)
  console.log(`[fresh] ${what}: ${logs.length - failed}/${logs.length} survived`)
  assert.strictEqual(failed, 0, logs.map(summary).join('\n'))
}

/** a hut of cobblestone 5 by 5 (inside 3 by 3, 3 high), its door on the west wall (closed), 10 blocks east of `at` */
async function buildHut (at: Vec3): Promise<Vec3> {
  const x0 = at.x + 10
  await run(`fill ${x0} ${GROUND} -2 ${x0 + 4} ${GROUND + 3} 2 minecraft:cobblestone hollow`)
  await run(`setblock ${x0} ${GROUND} 0 minecraft:oak_door[facing=east,half=lower,hinge=left,open=false]`)
  await run(`setblock ${x0} ${GROUND + 1} 0 minecraft:oak_door[facing=east,half=upper,hinge=left,open=false]`)
  return new Vec3(x0, GROUND, 0)
}

describe(`the fights of full-26.3-fresh-d on ${DEFAULT_VERSION} (normal difficulty)`, { timeout: 180 * 60 * 1000 }, () => {
  before(async () => {
    server = await startServer({
      flat: true,
      seed: 'fresh',
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

  for (const n of [1, 2]) {
    test(`a fortress corridor, ${n} wither skeleton${n > 1 ? 's' : ''} down it, the ${KIT === 'stage' ? 'nether stage\'s' : 'run\'s'} kit: alive (${RUNS} runs)`, async (t) => {
      const logs: RunLog[] = []
      for (let i = 0; i < RUNS; i++) {
        const at = await freshCorridor()
        await giveKit(KIT === 'stage' ? STAGES.nether.kit : RUN_KIT)
        await bot.waitForTicks(20)
        for (let k = 0; k < n; k++) await nether(`summon minecraft:wither_skeleton ${at.x + 20.5 + k * 2} ${CORRIDOR_Y} ${k === 0 ? 0.5 : -0.5}`)
        await waitFor(() => Object.values(bot.entities).filter(e => e.name === 'wither_skeleton').length >= n, 100)
        // (hurt, as the run's bot was coming back from the blazes: FRESH_HEALTH, default full)
        if (HEALTH < 20) await run(`damage ${USER} ${20 - HEALTH} minecraft:starve`)
        const log = await fightFor(1500, () => walkBetween(at.offset(2, 0, 0), at.offset(38, 0, 0)), () => bot.nearestEntity(e => e.name === 'wither_skeleton') == null)
        logs.push(log)
      }
      report(t, `${n} wither skeleton${n > 1 ? 's' : ''} in a corridor`, logs)
    })
  }

  test(`(nether-26.3-q3) a ledge over the lava sea, three skeletons on its shore and out in the lava, the run's kit, walking the ledge: alive, out of the lava (${RUNS} runs)`, async (t) => {
    const logs: RunLog[] = []
    const lava: boolean[] = []
    for (let i = 0; i < RUNS; i++) {
      const at = await freshLedge()
      await giveKit(LEDGE_KIT)
      await bot.waitForTicks(20)
      for (const dx of [10, 20]) await nether(`summon minecraft:skeleton ${at.x + dx + 0.5} ${CORRIDOR_Y - 5} 11.5 {PersistenceRequired:1b}`)
      await nether(`summon minecraft:skeleton ${at.x + 15.5} ${CORRIDOR_Y - 3} 16.5 {PersistenceRequired:1b}`)
      await waitFor(() => Object.values(bot.entities).filter(e => e.name === 'skeleton').length >= 3, 100)
      let inLava = false
      const onTick = (): void => { if ((bot.entity as any).isInLava === true) inLava = true }
      bot.on('physicsTick', onTick)
      const log = await fightFor(1500, () => walkBetween(at.offset(1, 0, 0), at.offset(31, 0, 0)))
      bot.off('physicsTick', onTick)
      if (inLava) log.deaths.push('in the lava')
      lava.push(inLava)
      logs.push(log)
    }
    report(t, 'skeletons on a lava shore', logs, i => lava[i] ? 'IN THE LAVA, ' : '')
  })

  test(`a night in the overworld, endermen about, the run's kit, pearls by night: alive (${RUNS} runs)`, async (t) => {
    const logs: RunLog[] = []
    const pearls: number[] = []
    for (let i = 0; i < RUNS; i++) {
      const home = await freshGround(18000, true)
      await giveKit(RUN_KIT.filter(([n]) => n !== 'netherrack'))
      await bot.waitForTicks(20)
      for (const [dx, dz] of [[14, 6], [-12, 12], [4, -18]]) await run(`summon minecraft:enderman ${home.x + dx + 0.5} ${GROUND} ${dz + 0.5}`)
      const lines: string[] = []
      const log = await fightFor(4000, () => {
        const stop = new AbortController()
        const executor = new Executor(bot, { log: l => lines.push(l) })
        void pearlsByNight(bot, executor, 4, stop.signal, l => { lines.push(l); if (process.env.NIGHT_VERBOSE != null) console.log(`[night] ${l}`) }).catch(() => {})
        return { stop: () => stop.abort(new Error('run over')) }
      }, () => countItems(bot, 'ender_pearl') >= 4)
      pearls.push(countItems(bot, 'ender_pearl'))
      logs.push(log)
    }
    report(t, 'endermen at night', logs, i => `${pearls[i]} pearls, `)
  })

  test(`by day, a bare bot walking past a skeleton in a roof's shade 8 blocks off its way: alive (${RUNS} runs)`, async (t) => {
    const logs: RunLog[] = []
    for (let i = 0; i < RUNS; i++) {
      const home = await freshGround(2000)
      await giveKit([['cobblestone', 64], ['wheat', 5], ['wheat_seeds', 12], ['rotten_flesh', 1]])
      // the shade: a roof of cobblestone on four posts, 4 by 4, 8 off the way's middle
      const r = home.offset(10, 0, 8)
      await run(`fill ${r.x - 2} ${GROUND + 3} ${r.z - 2} ${r.x + 2} ${GROUND + 3} ${r.z + 2} minecraft:cobblestone`)
      for (const [dx, dz] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) await run(`fill ${r.x + dx} ${GROUND} ${r.z + dz} ${r.x + dx} ${GROUND + 2} ${r.z + dz} minecraft:cobblestone`)
      await run(`summon minecraft:skeleton ${r.x + 0.5} ${GROUND} ${r.z + 0.5} {PersistenceRequired:1b}`)
      logs.push(await fightFor(1500, () => walkBetween(home, home.offset(20, 0, 0))))
    }
    report(t, 'bare past a skeleton in the shade', logs)
  })

  test(`(nether-26.3-q3) a creeper down a 1-wide tunnel at a bot with an iron sword at its dead end: alive (${RUNS} runs)`, async (t) => {
    const logs: RunLog[] = []
    for (let i = 0; i < RUNS; i++) {
      const home = await freshGround(6000)
      // a block of stone over the ground with a tunnel along +x through it, 1 wide and 2 high, shut at its west end
      await run(`fill ${home.x - 2} ${GROUND} -3 ${home.x + 24} ${GROUND + 4} 3 minecraft:stone`)
      await run(`fill ${home.x} ${GROUND} 0 ${home.x + 25} ${GROUND + 1} 0 minecraft:air`)
      await run(`tp ${USER} ${home.x + 0.5} ${GROUND} 0.5`)
      await waitFor(() => Math.abs(bot.entity.position.x - home.x - 0.5) < 0.6, 40)
      await giveKit([['iron_sword', 1], ['stone_pickaxe', 1], ['cobblestone', 32], ['cooked_beef', 4]])
      await bot.waitForTicks(20)
      await run(`summon minecraft:creeper ${home.x + 14.5} ${GROUND} 0.5`)
      await waitFor(() => bot.nearestEntity(e => e.name === 'creeper') != null, 100)
      // the foreground: still at the dead end (a dig), the reflexes on
      const log = await fightFor(800, () => {
        const handle = bot.survival.tasks.enqueue({ name: 'dig', onPreempt: 'resume' }, async (ctx) => { await ctx.waitTicks(100000) })
        handle.result.catch(() => {})
        return { stop: () => handle.cancel('run over') }
      }, () => bot.nearestEntity(e => e.name === 'creeper') == null)
      logs.push(log)
    }
    report(t, 'a creeper down a tunnel', logs)
  })

  test(`a re-geared bot at night by its base (a hut with a door), 3 skeletons about, out to its death spot and back: alive (${RUNS} runs)`, async (t) => {
    const logs: RunLog[] = []
    for (let i = 0; i < RUNS; i++) {
      const home = await freshGround(18000)
      await buildHut(home)
      await giveKit(REGEAR_KIT)
      await bot.waitForTicks(20)
      for (const [dx, dz] of [[-14, 8], [-20, -10], [4, 16]]) await run(`summon minecraft:skeleton ${home.x + dx + 0.5} ${GROUND} ${dz + 0.5}`)
      logs.push(await fightFor(1800, () => walkBetween(home, home.offset(-24, 0, 0))))
    }
    report(t, 'skeletons at night by the base', logs)
  })
})
