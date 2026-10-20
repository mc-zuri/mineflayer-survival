// A respawn with nothing at night by its bed, zombies there (full-1.21.11-fresh-m, t133686 to t134432: killed at night,
// respawned bare at its bed by the base with a zombie there already, it went for the base's chest, fought the zombie
// with its fists and died 750 ticks after), as lockstep scenarios on a SURVIVAL_VERSION (default 1.21.11) superflat
// world (the tests/harness server, normal difficulty, no natural spawning, the day going on, the reflexes on), each run
// on fresh ground 64 blocks along from the last:
// - the base: a hut of cobblestone (its door on the west wall, a torch and a chest with a kit in it: a stone sword, an
//   iron chestplate, cooked beef), the bed 4 west of it in the open, the memory's base with its entrance, box and chest;
// - the bot, past the iron milestone, killed by a zombie at night (time RESPAWN_TIME, default 19000) 20 blocks east of
//   the hut with an iron pickaxe and 16 torches, respawns at the bed, two zombies summoned 5 blocks west of the bed as
//   it does; the runner's recovery (Runner.recover, its re-equip from scratch left out) runs till it's done.
// A run passes alive with the chest's kit (the sword and the chestplate) by day; the log says what the recovery did and
// whether the death spot's items came back. RESPAWN_RUNS=n repeats each (default 2); RESPAWN_BASE=0 leaves the hut
// out (the bed in the open: a pillar, a hole or a run); RESPAWN_VERBOSE=1 logs the runner's lines.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { createPlugin } from '../../src'
import { Runner } from '../../src/runner'
import { countItems } from '../../src/skills/util'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'

const USER = 'respawnbot'
const RUNS = Number(process.env.RESPAWN_RUNS ?? 2)
const TIME = Number(process.env.RESPAWN_TIME ?? 19000)
const WITH_BASE = process.env.RESPAWN_BASE !== '0'
const VERBOSE = process.env.RESPAWN_VERBOSE != null
// the superflat's ground: grass at y -61, the bot standing at -60
const GROUND = -60
/** ticks the recovery gets at most (the night and the walk back) */
const RECOVERY_TICKS = 12000

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

const worn = (name: string): boolean => [5, 6, 7, 8].some(s => bot.inventory.slots[s]?.name === name) || countItems(bot, name) > 0

interface RespawnRun { alive: boolean, kit: boolean, picked: boolean, lines: string[], deaths: number, day: boolean }

/** one run: the base and the bed at x, the death 20 east, the respawn by the bed with two zombies, the recovery */
async function respawnRun (): Promise<RespawnRun> {
  const x = 64 * runs++
  if (bot.survival.reflexes != null) bot.survival.reflexes.enabled = false
  bot.survival.tasks.cancelAll('ABORTED', 'reset')
  if (bot.health <= 0) await waitFor(() => bot.health > 0, 200)
  for (const cmd of ['gamerule advance_time false', `time set ${TIME}`, 'kill @e[type=!player]', `clear ${USER}`, `effect clear ${USER}`]) await run(cmd)
  await run(`tp ${USER} ${x + 0.5} ${GROUND} 8.5`)
  await waitFor(() => Math.abs(bot.entity.position.x - x - 0.5) < 1, 100)
  await bot.waitForChunksToLoad()
  await run(`fill ${x - 16} ${GROUND} -16 ${x + 30} ${GROUND + 6} 16 minecraft:air`)
  // the hut: x0..x0+4 by -2..2, its floor in the ground and 3 high inside, its door in the west wall facing east, a
  // torch and the kit's chest inside
  const x0 = x
  if (WITH_BASE) {
    await run(`fill ${x0} ${GROUND - 1} -2 ${x0 + 4} ${GROUND + 3} 2 minecraft:cobblestone hollow`)
    await run(`setblock ${x0} ${GROUND} 0 minecraft:oak_door[facing=east,half=lower,hinge=left,open=false]`)
    await run(`setblock ${x0} ${GROUND + 1} 0 minecraft:oak_door[facing=east,half=upper,hinge=left,open=false]`)
    await run(`setblock ${x0 + 3} ${GROUND} 1 minecraft:chest[facing=west]{Items:[{Slot:0b,id:"minecraft:stone_sword",count:1},{Slot:1b,id:"minecraft:iron_chestplate",count:1},{Slot:2b,id:"minecraft:cooked_beef",count:8}]}`)
    await run(`setblock ${x0 + 3} ${GROUND + 2} -1 minecraft:wall_torch[facing=south]`)
  }
  // the bed in the open 4 west of the hut, the spawn point at it
  const bed = new Vec3(x0 - 4, GROUND, 3)
  await run(`setblock ${bed.x} ${GROUND} ${bed.z + 1} minecraft:white_bed[facing=south,part=head]`)
  await run(`setblock ${bed.x} ${GROUND} ${bed.z} minecraft:white_bed[facing=south,part=foot]`)
  await run(`spawnpoint ${USER} ${bed.x} ${GROUND} ${bed.z}`)
  // the runner, its memory's base (the hut's entrance, box and chest)
  const lines: string[] = []
  const runner = new Runner(bot, { log: l => { lines.push(l); if (VERBOSE) console.log(`[respawn] ${l}`) } })
  for (const id of ['wood', 'stone', 'food', 'base', 'iron'] as const) runner.reached.push({ id, title: '', tick: 0, wallMs: 0 })
  ;(runner as any).reequip = async () => {}
  const memory = runner.memory
  memory.base = null
  ;(memory as any).pois = (memory as any).pois.filter((p: any) => !String(p.kind).startsWith('base_'))
  for (const c of memory.knownChests()) memory.forgetChest(c)
  memory.death = null
  if (WITH_BASE) {
    memory.setBase({ x: x0 + 3, y: GROUND, z: 1 })
    memory.addPoi('base_entrance', { x: x0 - 1, y: GROUND, z: 0 })
    memory.addPoi('base_bounds', { x: x0, y: GROUND - 1, z: -2 }, 'overworld', `${x0 + 5},${GROUND + 4},3`)
    memory.rememberChest({ x: x0 + 3, y: GROUND, z: 1 }, { stone_sword: 1, iron_chestplate: 1, cooked_beef: 8 })
  }
  // the death 20 east of the hut, a zombie's, with what it had
  const spot = new Vec3(x0 + 20, GROUND, 0)
  await run(`tp ${USER} ${spot.x + 0.5} ${GROUND} ${spot.z + 0.5}`)
  await waitFor(() => bot.entity.position.distanceTo(spot.offset(0.5, 0, 0.5)) < 1, 100)
  await run(`give ${USER} iron_pickaxe 1`)
  await run(`give ${USER} torch 16`)
  await waitFor(() => countItems(bot, 'torch') > 0, 100)
  await run(`summon minecraft:zombie ${spot.x + 1.5} ${GROUND} ${spot.z + 0.5} {NoAI:1b,PersistenceRequired:1b,Tags:["killer"]}`)
  await waitFor(() => bot.nearestEntity(e => e.name === 'zombie') != null, 100)
  // two zombies by the bed, held (no AI, the bot not drawn to them) till the bot is dead
  for (const [dx, dz] of [[-5, 0], [-4, 4]]) {
    const out = await run(`summon minecraft:zombie ${bed.x + dx + 0.5} ${GROUND} ${bed.z + dz + 0.5} {NoAI:1b,PersistenceRequired:1b,Tags:["bedzombie"]}`)
    if (!out.some(l => /Summoned/.test(l))) throw new Error(`no zombie by the bed: ${out.join(' | ')}`)
  }
  await run('gamerule advance_time true')
  let deaths = 0
  const onDeath = (): void => { deaths++ }
  bot.on('death', onDeath)
  bot.survival.reflexes!.enabled = true
  await run(`damage ${USER} 100 minecraft:mob_attack by @e[tag=killer,limit=1]`)
  await waitFor(() => bot.health <= 0, 100)
  await run('kill @e[tag=killer]')
  // the zombies by the bed let go before the bot's back there (held, they don't keep it from its bed: the night slept
  // through)
  const released = await run('execute as @e[tag=bedzombie] run data merge entity @s {NoAI:0b}')
  const ctrl = new AbortController()
  let ticks = 0
  const onTick = (): void => { if (++ticks >= RECOVERY_TICKS) ctrl.abort(new Error('the recovery ran out of ticks')) }
  bot.on('physicsTick', onTick)
  try {
    const recovering = runner.recover(ctrl.signal).catch(err => { lines.push(`recover threw: ${(err as Error).message}`) })
    await waitFor(() => bot.health > 0 && bot.entity.position.distanceTo(bed.offset(0.5, 0, 0.5)) < 4, 200)
    const p = bot.entity.position
    lines.push(`respawned at ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}, the zombies ${Object.values(bot.entities).filter(e => e.name === 'zombie').map(e => e.position.distanceTo(p).toFixed(1)).join(', ')} off (${released.length} let go)`)
    await recovering
  } finally {
    bot.off('physicsTick', onTick)
    bot.off('death', onDeath)
    bot.survival.reflexes!.enabled = false
    await run('gamerule advance_time false')
  }
  const result: RespawnRun = {
    alive: bot.health > 0 && deaths <= 1,
    kit: worn('stone_sword') && worn('iron_chestplate'),
    picked: countItems(bot, 'iron_pickaxe') > 0,
    lines,
    deaths: deaths - 1,
    day: (bot.time?.timeOfDay ?? 0) < 12542 || (bot.time?.timeOfDay ?? 0) > 23460
  }
  console.log(`[respawn] run ${runs} on ${DEFAULT_VERSION}: ${result.alive ? 'alive' : `DIED ${result.deaths} more times`}, ${result.kit ? 'the kit' : 'NO KIT'}, ${result.picked ? 'the death spot\'s items back' : 'the death spot\'s items not back'}, ${ticks} ticks, time ${bot.time?.timeOfDay ?? '?'}`)
  for (const l of lines.filter(l => /respawned at|after the respawn|refuge|death spot|kit|night|sleep/.test(l))) console.log(`[respawn]   ${l}`)
  return result
}

describe(`a respawn with nothing at night by its bed, two zombies there, on ${DEFAULT_VERSION} (normal difficulty)`, { timeout: 120 * 60 * 1000 }, () => {
  before(async () => {
    server = await startServer({
      flat: true,
      seed: 'respawn',
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

  test(`killed at night ${WITH_BASE ? 'by its hut' : 'with its bed in the open'}, respawned bare at the bed with two zombies there: alive through the night, the kit back (${RUNS} runs)`, async (t) => {
    const results: RespawnRun[] = []
    for (let i = 0; i < RUNS; i++) results.push(await respawnRun())
    const alive = results.filter(r => r.alive).length
    const kitted = results.filter(r => r.kit).length
    const picked = results.filter(r => r.picked).length
    t.diagnostic(`${alive}/${RUNS} alive, ${kitted}/${RUNS} with the kit, ${picked}/${RUNS} with the death spot's items`)
    console.log(`[respawn] ${DEFAULT_VERSION}: ${alive}/${RUNS} alive, ${kitted}/${RUNS} with the kit, ${picked}/${RUNS} with the death spot's items`)
    assert.strictEqual(alive, RUNS, results.map(r => r.lines.join('\n')).join('\n----\n'))
    if (WITH_BASE) assert.strictEqual(kitted, RUNS, results.map(r => r.lines.join('\n')).join('\n----\n'))
  })
})
