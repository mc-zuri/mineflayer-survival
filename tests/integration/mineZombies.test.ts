// full-26.3-fresh-l's death (t279940) as lockstep scenarios on a SURVIVAL_VERSION (default 1.21.11) superflat world
// (the tests/harness server, normal difficulty, no natural spawning, the reflexes on): the night's mine at y -23, the
// bot in iron (helmet, chestplate, leggings), golden boots, a diamond sword and a shield, mining redstone, met four
// zombies, was hit 11 times (1.5 a hit) in 200 ticks, and died, the hostiles reflex fighting one of them at a time all
// the while. Each run is on fresh ground 64 blocks along from the last:
// - a 1-wide tunnel (2 high) in a block of stone, the bot at work 6 blocks in from its shut west end, four zombies coming
//   down it from the east;
// - a dungeon's zombie spawner (MonsterRoomFeature's room, 7 by 7 inside, 4 high, cobblestone) at the tunnel's east
//   end, the bot at work in the tunnel 8 blocks off it, the spawner spawning (BaseSpawner: up to 4 a go while fewer
//   than 6 are about, a player within 16);
// - the tunnel with the bot at 8 health (the run's was at 10 and less by its last fight), four zombies coming;
// - a cave 13 by 13 and 5 high round the bot, a trench 8 deep beside it, four zombies coming at it together, two from the west, two from the north.
// MINE_RUNS=n repeats each (default 3); NIGHT_VERBOSE=1 logs each hit, kill and reflex.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { createPlugin } from '../../src'
import { countItems } from '../../src/skills/util'
import { isAlive } from '../../src/skills/combatUtil'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { NightLog, summary, type RunLog } from './nightLog'

const USER = 'minebot'
const RUNS = Number(process.env.MINE_RUNS ?? 3)
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

/** full-26.3-fresh-l's bag in the mine (the armor and the shield worn, the sword, its pickaxe, the stone and the food it had) */
const MINE_KIT: Array<[string, number]> = [
  ['iron_helmet', 1], ['iron_chestplate', 1], ['iron_leggings', 1], ['golden_boots', 1], ['shield', 1],
  ['diamond_sword', 1], ['iron_pickaxe', 1], ['cobblestone', 64], ['torch', 17], ['cooked_chicken', 3]
]

const WORN: Record<string, string> = { helmet: 'armor.head', chestplate: 'armor.chest', leggings: 'armor.legs', boots: 'armor.feet' }

async function giveKit (kit: Array<[string, number]>): Promise<void> {
  for (const [item, count] of kit) {
    const kind = /_(helmet|chestplate|leggings|boots)$/.exec(item)?.[1]
    const slot = kind != null ? WORN[kind] : item === 'shield' ? 'weapon.offhand' : null
    await run(slot != null ? `item replace entity ${USER} ${slot} with ${item} ${count}` : `give ${USER} ${item} ${count}`)
  }
  const last = kit.filter(([i]) => !/_(helmet|chestplate|leggings|boots)$|^shield$/.test(i)).slice(-1)[0][0]
  await waitFor(() => countItems(bot, last) > 0, 200)
}

/** the reflexes and tasks off, the bot alive, its bag empty, no mobs, midnight; the fresh ground's x */
async function reset (): Promise<number> {
  if (bot.survival.reflexes != null) bot.survival.reflexes.enabled = false
  bot.survival.tasks.cancelAll('ABORTED', 'reset')
  if (bot.health <= 0) await waitFor(() => bot.health > 0, 200)
  bot.clearControlStates()
  bot.deactivateItem()
  for (const cmd of ['time set 18000', 'kill @e[type=!player]', `clear ${USER}`, `effect clear ${USER}`]) await run(cmd)
  return 64 * runs++
}

/**
 * A block of stone at x with a tunnel along +x through it (1 wide, 2 high, from x to x + 40, shut at both ends), the
 * bot at full health 6 blocks in from its west end; the bot's cell
 */
async function freshTunnel (): Promise<Vec3> {
  const x = await reset()
  await run(`forceload add ${x - 16} -16 ${x + 56} 16`)
  await run(`fill ${x - 2} ${GROUND - 3} -4 ${x + 42} ${GROUND + 4} 4 minecraft:stone`)
  await run(`fill ${x} ${GROUND} 0 ${x + 40} ${GROUND + 1} 0 minecraft:air`)
  const at = new Vec3(x + 6, GROUND, 0)
  await run(`tp ${USER} ${at.x + 0.5} ${GROUND} 0.5 -90 0`)
  await waitFor(() => Math.abs(bot.entity.position.x - at.x - 0.5) < 0.6 && bot.inventory.items().length === 0, 100)
  await bot.waitForChunksToLoad()
  await run(`effect give ${USER} minecraft:instant_health 1 10 true`)
  await run(`effect give ${USER} minecraft:saturation 1 20 true`)
  await bot.waitForTicks(10)
  // fresh-l's bot had its food bar full and no saturation (FoodData.tick: a point healed every 80 ticks, not every 10):
  // the saturation burnt off with hunger
  await run(`effect give ${USER} minecraft:hunger 30 255 true`)
  await waitFor(() => bot.foodSaturation <= 0, 400)
  await run(`effect clear ${USER} minecraft:hunger`)
  await bot.waitForTicks(5)
  return at
}

/** the foreground: at work where it stands (a dig's wait), resumed after each reflex */
function atWork (): { stop: () => void } {
  const handle = bot.survival.tasks.enqueue({ name: 'mine', onPreempt: 'resume' }, async (ctx) => { await ctx.waitTicks(1000000) })
  handle.result.catch(() => {})
  return { stop: () => handle.cancel('run over') }
}

/** `ticks` with the reflexes on and the bot at work (or till it dies, or `until`); the log */
async function fightFor (ticks: number, until: () => boolean = () => false): Promise<RunLog> {
  const log = new NightLog(bot)
  bot.survival.reflexes!.enabled = true
  const task = atWork()
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
  console.log(`[mine] ${what}: ${logs.length - failed}/${logs.length} survived`)
  logs.forEach((log, i) => console.log(`[mine]   run ${i + 1}: ${extra(i)}${summary(log)}`))
  assert.strictEqual(failed, 0, logs.map(summary).join('\n'))
}

const zombiesLeft = (): number => Object.values(bot.entities).filter(e => e.name === 'zombie' && isAlive(bot, e)).length

describe(`full-26.3-fresh-l's zombies in the mine on ${DEFAULT_VERSION} (normal difficulty)`, { timeout: 120 * 60 * 1000 }, () => {
  before(async () => {
    server = await startServer({
      flat: true,
      seed: 'mine',
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

  test(`four zombies down a 1-wide tunnel at a bot in iron with a diamond sword and a shield: alive (${RUNS} runs)`, async (t) => {
    const logs: RunLog[] = []
    for (let i = 0; i < RUNS; i++) {
      const at = await freshTunnel()
      await giveKit(MINE_KIT)
      await bot.waitForTicks(20)
      for (let k = 0; k < 4; k++) await run(`summon minecraft:zombie ${at.x + 10.5 + k} ${GROUND} 0.5 {PersistenceRequired:1b,CanPickUpLoot:0b}`)
      await waitFor(() => zombiesLeft() >= 4, 100)
      logs.push(await fightFor(2400, () => zombiesLeft() === 0))
    }
    report(t, 'four zombies down a tunnel', logs, i => `${logs[i].kills.zombie ?? 0} of 4 killed, `)
  })

  test(`hurt (8 health) down the tunnel, four zombies coming: shut in, healed and alive (${RUNS} runs)`, async (t) => {
    const logs: RunLog[] = []
    const sealed: number[] = []
    for (let i = 0; i < RUNS; i++) {
      const at = await freshTunnel()
      await giveKit(MINE_KIT)
      // (starving's damage goes past the armor: DamageTypeTags.BYPASSES_ARMOR)
      await run(`damage ${USER} 12 minecraft:starve`)
      await waitFor(() => bot.health <= 8.5, 40)
      for (let k = 0; k < 4; k++) await run(`summon minecraft:zombie ${at.x + 10.5 + k} ${GROUND} 0.5 {PersistenceRequired:1b,CanPickUpLoot:0b}`)
      await waitFor(() => zombiesLeft() >= 4, 100)
      let seals = 0
      const onReflex = (_name: string, detail?: string): void => { if (detail === 'seal in') seals++ }
      bot.on('reflex' as any, onReflex)
      try {
        logs.push(await fightFor(2400))
      } finally {
        bot.off('reflex' as any, onReflex)
      }
      sealed.push(seals)
    }
    report(t, 'hurt down a tunnel', logs, i => `${sealed[i]} shut-ins, health ${logs[i].minHealth.toFixed(1)} at the least, `)
  })

  test(`a cave, four zombies coming at the bot together from two sides, a drop of 8 beside it: alive (${RUNS} runs)`, async (t) => {
    const logs: RunLog[] = []
    for (let i = 0; i < RUNS; i++) {
      const at = await freshTunnel()
      // the cave: 13 by 13 inside, 5 high, round the bot's cell, a trench 3 wide and 8 deep 2 off the bot, a way round its south end
      // (fresh-l's bot fought on the cave's floor at y -16 and fell 8 to -23, 5 lost in the fall)
      await run(`fill ${at.x - 6} ${GROUND} ${at.z - 6} ${at.x + 6} ${GROUND + 4} ${at.z + 6} minecraft:air`)
      await run(`fill ${at.x + 2} ${GROUND - 8} ${at.z - 6} ${at.x + 4} ${GROUND - 1} ${at.z + 2} minecraft:air`)
      await giveKit(MINE_KIT)
      await bot.waitForTicks(20)
      for (const [dx, dz] of [[-5, -1], [-5, 1], [-1, -5], [1, -5]]) await run(`summon minecraft:zombie ${at.x + dx + 0.5} ${GROUND} ${at.z + dz + 0.5} {PersistenceRequired:1b,CanPickUpLoot:0b}`)
      await waitFor(() => zombiesLeft() >= 4, 100)
      logs.push(await fightFor(2400, () => zombiesLeft() === 0))
    }
    report(t, 'four zombies in a cave', logs, i => `${logs[i].kills.zombie ?? 0} of 4 killed, `)
  })

  test(`a dungeon's zombie spawner at the end of a 1-wide tunnel, the bot at work 8 off it: alive (${RUNS} runs)`, async (t) => {
    const logs: RunLog[] = []
    for (let i = 0; i < RUNS; i++) {
      const at = await freshTunnel()
      // the room east of the bot: 7 by 7 inside, 4 high, its middle 12 off the bot, the tunnel coming in at its west wall
      const c = at.offset(12, 0, 0)
      await run(`fill ${c.x - 4} ${GROUND - 1} ${c.z - 4} ${c.x + 4} ${GROUND + 4} ${c.z + 4} minecraft:cobblestone hollow`)
      await run(`fill ${c.x - 4} ${GROUND} 0 ${c.x - 4} ${GROUND + 1} 0 minecraft:air`)
      await run(`setblock ${c.x} ${GROUND} ${c.z} minecraft:spawner{SpawnData:{entity:{id:"minecraft:zombie"}},Delay:20s}`)
      await giveKit(MINE_KIT)
      await bot.waitForTicks(20)
      logs.push(await fightFor(3000))
    }
    report(t, 'a zombie spawner by the tunnel', logs, i => `${logs[i].kills.zombie ?? 0} zombies killed, `)
  })
})
