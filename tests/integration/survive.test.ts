// The reflexes keeping the bot alive on a 1.21.11 superflat (the tests/harness lockstep server, normal difficulty):
// a crowd of summoned mobs (three zombies, two skeletons, a spider and a creeper) against the iron kit, the shield
// against the skeletons' arrows, a bed placed and slept in at dusk (the monsters that keep the bot up dealt with
// first), and the lava, drowning and totem reflexes in game. SURVIVE_RUNS=n repeats each scenario (default 1).
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { createPlugin } from '../../src'
import { connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { NightLog, summary, type RunLog } from './nightLog'

const USER = 'survivor'
const RUNS = Number(process.env.SURVIVE_RUNS ?? 1)
// the superflat's grass is at y -61, the bot stands at -60
const GROUND = -60

let server: TestServer
let bot: Bot

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

async function ironKit (): Promise<void> {
  for (const item of ['iron_sword', 'shield', 'iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots']) await give(item)
  await give('cooked_beef', 16)
  // the armor reflex puts it on
  await waitFor(() => bot.inventory.slots[6]?.name === 'iron_chestplate', 100)
}

/** a clean slate at the origin: no mobs, the patch rebuilt, an empty inventory, full health and food, at noon */
async function reset (): Promise<void> {
  if (bot.survival.reflexes != null) bot.survival.reflexes.enabled = false
  bot.survival.tasks.cancelAll('ABORTED', 'reset')
  if (bot.health <= 0) await waitFor(() => bot.health > 0, 200)
  bot.clearControlStates()
  bot.deactivateItem()
  for (const cmd of ['time set noon', 'weather clear', 'kill @e[type=!player]', `clear ${USER}`, `effect clear ${USER}`,
    'fill -24 -60 -24 24 -50 24 minecraft:air', 'fill -24 -61 -24 24 -61 24 minecraft:grass_block', 'fill -24 -63 -24 24 -62 24 minecraft:dirt',
    `tp ${USER} 0.5 ${GROUND} 0.5 0 0`, `effect give ${USER} minecraft:instant_health 1 10 true`, `effect give ${USER} minecraft:saturation 1 20 true`]) {
    await run(cmd)
  }
  await waitFor(() => bot.entity.position.distanceTo(new Vec3(0.5, GROUND, 0.5)) < 0.5 && bot.inventory.items().length === 0, 100)
  // a fire still burning from the scenario before (Entity.clearFire: in water)
  await run('setblock 0 -60 0 minecraft:water')
  await bot.waitForTicks(5)
  await run('setblock 0 -60 0 minecraft:air')
  await bot.waitForTicks(20)
}

/** the hits the shield took: each blocked arrow or blow wears it (BlocksAttacks.hurtBlockingItem: 1 + the damage) */
function shieldHits (): { stop: () => number } {
  let hits = 0
  let used = (bot.inventory.slots[45] as any)?.durabilityUsed ?? 0
  const onSlot = (slot: number, _old: unknown, item: any): void => {
    if (slot !== 45 || item?.name !== 'shield') return
    if ((item.durabilityUsed ?? 0) > used) hits++
    used = item.durabilityUsed ?? 0
  }
  ;(bot.inventory as any).on('updateSlot', onSlot)
  return { stop: () => { (bot.inventory as any).off('updateSlot', onSlot); return hits } }
}

function reflexesOn (): void {
  bot.survival.reflexes!.enabled = true
}

/** repeats a scenario, logging each run; fails if any run failed */
async function repeat (t: any, name: string, scenario: (log: NightLog) => Promise<string | null>): Promise<void> {
  const fails: string[] = []
  for (let i = 0; i < RUNS; i++) {
    await reset()
    const log = new NightLog(bot)
    let failure: string | null
    try {
      failure = await scenario(log)
    } catch (err) {
      failure = (err as Error).stack ?? String(err)
    }
    bot.survival.reflexes!.enabled = false
    const result: RunLog = log.finish()
    if (result.deaths.length > 0 && failure == null) failure = `died: ${result.deaths.join('; ')}`
    t.diagnostic(`${name} ${i + 1}: ${failure == null ? 'ok' : `FAILED (${failure})`}, ${summary(result)}`)
    if (failure != null) fails.push(`run ${i + 1}: ${failure}`)
  }
  t.diagnostic(`${name}: ${RUNS - fails.length}/${RUNS} passed`)
  assert.deepStrictEqual(fails, [])
}

describe('surviving on 1.21.11 (reflexes on, normal difficulty)', { timeout: 120 * 60 * 1000 }, () => {
  before(async () => {
    server = await startServer({
      flat: true,
      seed: 'survive',
      difficulty: 'normal',
      gamerules: { advance_weather: false, spawn_monsters: false, respawn_radius: 0 }
    })
    bot = await connectLockstepBot(server, { username: USER })
    await bot.waitForChunksToLoad()
    bot.loadPlugin(createPlugin())
    bot.survival.reflexes!.enabled = false
  })

  after(async () => {
    bot?.survival?.reflexes?.stop()
    if (bot != null) await quitBot(bot)
    if (server != null) await server.cleanup()
  })

  test('a crowd: 3 zombies, 2 skeletons, a spider and a creeper around the bot with the iron kit; all killed or evaded, arrows taken on the shield', async (t) => {
    await repeat(t, 'crowd', async () => {
      await ironKit()
      await run('time set midnight')
      const shield = shieldHits()
      const mobs: Array<[string, number, number]> = [['zombie', 8, 0], ['zombie', -8, 2], ['zombie', 1, 8], ['skeleton', 12, -10], ['skeleton', -12, -9], ['spider', -6, -6], ['creeper', 9, 9]]
      for (const [name, x, z] of mobs) await run(`summon minecraft:${name} ${x + 0.5} ${GROUND} ${z + 0.5}`)
      await waitFor(() => Object.values(bot.entities).filter(e => mobs.some(m => m[0] === e.name)).length === mobs.length, 40)
      const ids = Object.values(bot.entities).filter(e => mobs.some(m => m[0] === e.name)).map(e => e.id)
      reflexesOn()
      const gone = (): number => ids.filter(id => bot.entities[id] == null).length
      const done = await waitFor(() => bot.health <= 0 || gone() === ids.length, 3000)
      const blocked = shield.stop()
      const left = ids.map(id => bot.entities[id]).filter(e => e != null).map(e => `${e.name} at ${e.position.distanceTo(bot.entity.position).toFixed(0)}`)
      t.diagnostic(`crowd: ${gone()}/${ids.length} gone, ${blocked} hits on the shield, health ${bot.health.toFixed(1)}`)
      if (bot.health <= 0) return 'the bot died'
      // evaded: alive and the rest out of reach
      if (!done && left.length > 0 && left.some(l => Number(l.split(' at ')[1]) < 16)) return `still about: ${left.join(', ')}`
      return null
    })
  })

  test('a creeper at the iron kit with a shield: fought behind the shield (the blast blocked) and killed', async (t) => {
    await repeat(t, 'creeper', async () => {
      await ironKit()
      await run('time set midnight')
      await run(`summon minecraft:creeper 6.5 ${GROUND} 0.5`)
      await waitFor(() => bot.nearestEntity(e => e.name === 'creeper') != null, 40)
      const creeper = bot.nearestEntity(e => e.name === 'creeper')!
      reflexesOn()
      await waitFor(() => bot.health <= 0 || bot.entities[creeper.id] == null, 1200)
      if (bot.health <= 0) return 'the bot died'
      if (bot.entities[creeper.id] != null) return 'the creeper is still about'
      return null
    })
  })

  test('two skeletons shooting from 12 blocks: the bot closes in behind its shield and kills them', async (t) => {
    await repeat(t, 'skeletons', async () => {
      await ironKit()
      await run('time set midnight')
      const shield = shieldHits()
      await run(`summon minecraft:skeleton 12.5 ${GROUND} 0.5`)
      await run(`summon minecraft:skeleton 10.5 ${GROUND} 6.5`)
      await waitFor(() => Object.values(bot.entities).filter(e => e.name === 'skeleton').length === 2, 40)
      const ids = Object.values(bot.entities).filter(e => e.name === 'skeleton').map(e => e.id)
      // let them start shooting before the bot moves (the hostiles reflex reaches 8 blocks)
      reflexesOn()
      await waitFor(() => bot.health <= 0 || ids.every(id => bot.entities[id] == null), 2400)
      const blocked = shield.stop()
      t.diagnostic(`skeletons: ${blocked} arrows on the shield`)
      if (bot.health <= 0) return 'the bot died'
      if (!ids.every(id => bot.entities[id] == null)) return 'a skeleton is still alive'
      if (blocked === 0) return 'no arrow blocked'
      return null
    })
  })

  test('a bed in the bag at dusk: placed and slept in through the night', async (t) => {
    await repeat(t, 'sleep', async () => {
      await give('red_bed')
      await give('stone_sword')
      await run('time set 12600')
      await waitFor(() => bot.time.timeOfDay >= 12600, 40)
      reflexesOn()
      let slept = false
      const onSleep = (): void => { slept = true }
      bot.on('sleep', onSleep)
      const morning = await waitFor(() => bot.time.timeOfDay < 12000, 1500)
      bot.off('sleep', onSleep)
      if (!slept) return 'never slept'
      if (!morning) return `still night (${bot.time.timeOfDay})`
      // the bed taken back
      if (!await waitFor(() => bot.inventory.items().some(i => i.name === 'red_bed'), 200)) return 'the bed was left behind'
      return null
    })
  })

  test('a bed at dusk with a zombie in the bed\'s reach: "you may not rest now", the zombie killed, then slept', async (t) => {
    await repeat(t, 'sleep with a monster', async () => {
      await give('red_bed')
      await give('iron_sword')
      await run('time set 12600')
      await waitFor(() => bot.time.timeOfDay >= 12600, 40)
      // a zombie standing still 6 blocks across and 6 along: within 8 of the bed each way (Player.startSleepInBed), 8.5 from the bot (the hostiles reflex leaves it)
      await run(`summon minecraft:zombie 6.5 ${GROUND} 6.5 {NoAI:1b,PersistenceRequired:1b}`)
      await waitFor(() => bot.nearestEntity(e => e.name === 'zombie') != null, 40)
      const zombie = bot.nearestEntity(e => e.name === 'zombie')!
      reflexesOn()
      let slept = false
      const onSleep = (): void => { slept = true }
      bot.on('sleep', onSleep)
      await waitFor(() => bot.time.timeOfDay < 12000, 3000)
      bot.off('sleep', onSleep)
      if (bot.entities[zombie.id] != null) return 'the zombie is alive'
      if (!slept) return 'never slept'
      return null
    })
  })

  test('a taken bed nearby (a villager\'s): the bot sleeps in its own from the bag', async (t) => {
    await repeat(t, 'taken bed', async () => {
      await give('red_bed')
      await give('stone_sword')
      await run(`setblock 4 ${GROUND} 0 minecraft:white_bed[part=foot,facing=east,occupied=true]`)
      await run(`setblock 5 ${GROUND} 0 minecraft:white_bed[part=head,facing=east,occupied=true]`)
      await run('time set 12600')
      await waitFor(() => bot.time.timeOfDay >= 12600, 40)
      reflexesOn()
      let slept = false
      const onSleep = (): void => { slept = true }
      bot.on('sleep', onSleep)
      await waitFor(() => bot.time.timeOfDay < 12000, 3000)
      bot.off('sleep', onSleep)
      if (!slept) return 'never slept'
      if (!await waitFor(() => bot.inventory.items().some(i => i.name === 'red_bed'), 200)) return 'its own bed was left behind'
      return null
    })
  })

  test('in a lava pool: out of it alive (the hazard reflex)', async (t) => {
    await repeat(t, 'lava', async () => {
      await give('cooked_beef', 8)
      await run(`fill -1 ${GROUND - 1} -1 1 ${GROUND - 1} 1 minecraft:lava`)
      await run(`tp ${USER} 0.5 ${GROUND - 1} 0.5`)
      await waitFor(() => (bot.entity as any).isInLava === true, 40)
      reflexesOn()
      const out = await waitFor(() => bot.health <= 0 || ((bot.entity as any).isInLava !== true && bot.entity.onGround && bot.blockAt(bot.entity.position.floored())?.name !== 'lava'), 400)
      if (bot.health <= 0) return 'the bot died'
      if (!out) return `still in lava at ${bot.entity.position.toString()}`
      // still burning: it doesn't stand in lava again
      await bot.waitForTicks(160)
      if (bot.health <= 0) return 'burnt to death after getting out'
      return null
    })
  })

  test('under water with a roof over it: up to the one opening for air (the drowning reflex)', async (t) => {
    await repeat(t, 'drowning', async () => {
      // a 5x5 pool 5 deep in stone walls on the grass, roofed with stone but for one corner
      await run('fill -3 -60 -3 3 -55 3 minecraft:stone')
      await run('fill -2 -60 -2 2 -56 2 minecraft:water')
      await run('setblock 2 -55 2 minecraft:air')
      await run(`tp ${USER} 0.5 -60 0.5`)
      await waitFor(() => (bot.entity as any).isInWater === true, 40)
      reflexesOn()
      let surfaced = false
      const ok = await waitFor(() => {
        if (bot.health <= 0) return true
        if (bot.oxygenLevel >= 18 && surfaced) return true
        if (bot.blockAt(bot.entity.position.offset(0, 1.62, 0).floored())?.name !== 'water') surfaced = true
        return false
      }, 1200)
      if (bot.health <= 0) return 'the bot drowned'
      if (!ok) return `air ${bot.oxygenLevel} at ${bot.entity.position.toString()}`
      return null
    })
  })

  test('two totems: one in the off hand, a deadly hit survived, and the second in its place for the next', async (t) => {
    await repeat(t, 'totem', async () => {
      await give('totem_of_undying', 2)
      reflexesOn()
      if (!await waitFor(() => bot.inventory.slots[45]?.name === 'totem_of_undying', 100)) return 'no totem in the off hand'
      let popped = 0
      const onStatus = (p: any): void => { if (p.entityId === bot.entity.id && p.entityStatus === 35) popped++ }
      bot._client.on('entity_status', onStatus)
      try {
        await run(`damage ${USER} 100 minecraft:generic`)
        if (!await waitFor(() => popped === 1, 40)) return 'the totem never popped'
        if (bot.health <= 0) return 'the bot died with a totem'
        if (!await waitFor(() => bot.inventory.slots[45]?.name === 'totem_of_undying', 100)) return 'the second totem never went to the off hand'
        await bot.waitForTicks(20)
        await run(`damage ${USER} 100 minecraft:generic`)
        if (!await waitFor(() => popped === 2, 40)) return 'the second totem never popped'
        await bot.waitForTicks(10)
        if (bot.health <= 0) return 'the bot died with the second totem'
      } finally {
        bot._client.off('entity_status', onStatus)
      }
      return null
    })
  })
})
