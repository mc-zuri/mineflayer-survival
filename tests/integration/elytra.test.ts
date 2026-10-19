// The elytra epoch's skills against a real server (SURVIVAL_VERSION, default 1.21.11), in order on one superflat world
// (seed "elytra", whose End is the End all the same), each set up with commands: the dragon killed with /kill (its
// gateway opens on the ring) and a pearl thrown into the gateway, out to the outer islands; an End City placed with
// /place structure where it has a ship, the bot set down 70 blocks off it to find it by its purpur, climb to the ship
// and take the elytra from its frame; rockets made from sugar cane and the gunpowder of creepers summoned at night;
// and a glide of 200 blocks over the overworld with them, landed. Each logs its ticks and wall time.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert'
import { performance } from 'node:perf_hooks'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { createPlugin } from '../../src'
import { GATEWAY_POI } from '../../src/end/gateway'
import { isInEnd, seekEndShip, seekGateway, takeElytra, throughGateway } from '../../src/end/skills'
import { END_CITY_POI } from '../../src/end/endCity'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { countItems } from '../../src/skills/util'

const USER = 'survivor'
const SEED = 'elytra'

async function waitFor (bot: Bot, predicate: () => boolean, ticks: number): Promise<boolean> {
  for (let i = 0; i < ticks; i++) {
    if (predicate()) return true
    await bot.waitForTicks(1)
  }
  return predicate()
}

/** runs a skill and reports its wall time and the ticks it took */
async function timed<T> (t: { diagnostic: (m: string) => void }, bot: Bot, name: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now()
  const ticks0 = bot.lockstep.ticks
  try {
    return await fn()
  } finally {
    const ms = performance.now() - start
    const ticks = bot.lockstep.ticks - ticks0
    const line = `[elytra] ${name}: ${ticks} ticks in ${(ms / 1000).toFixed(1)} s (${(ticks / (ms / 1000)).toFixed(0)} ticks/s)`
    t.diagnostic(line)
    console.log(line)
  }
}

describe(`the elytra epoch's skills on ${DEFAULT_VERSION}: the gateway, an End City's ship, rockets, a glide`, { timeout: 30 * 60 * 1000 }, () => {
  let server: TestServer
  let bot: Bot
  const run = async (cmd: string): Promise<string> => (await server.command(cmd)).join(' | ')
  const commands = async (list: string[]): Promise<void> => { for (const c of list) await run(c) }
  const kit = async (): Promise<void> => {
    await commands([
      `clear ${USER}`, `effect clear ${USER}`,
      `give ${USER} diamond_sword`, `give ${USER} diamond_pickaxe`, `give ${USER} bow`, `give ${USER} arrow 64`,
      `give ${USER} ender_pearl 8`, `give ${USER} end_stone 192`, `give ${USER} cooked_beef 32`, `give ${USER} water_bucket`,
      `item replace entity ${USER} armor.head with diamond_helmet`, `item replace entity ${USER} armor.chest with diamond_chestplate`,
      `item replace entity ${USER} armor.legs with diamond_leggings`, `item replace entity ${USER} armor.feet with diamond_boots`,
      `item replace entity ${USER} weapon.offhand with shield`,
      `effect give ${USER} minecraft:instant_health 1 10 true`, `effect give ${USER} minecraft:saturation 1 20 true`
    ])
    await waitFor(bot, () => countItems(bot, 'end_stone') === 192, 100)
  }

  before(async () => {
    server = await startServer({
      flat: true,
      seed: SEED,
      gamerules: { advance_time: false, advance_weather: false, spawn_mobs: false, spawn_monsters: false },
      properties: { 'spawn-protection': 0 }
    })
    bot = await connectLockstepBot(server, { username: USER })
    await bot.waitForChunksToLoad()
    // the skills look out for the shulkers and the creepers themselves; the reflexes stay off as in the End scenarios
    bot.loadPlugin(createPlugin({ reflexes: false }))
  })

  after(async () => {
    if (bot != null) await quitBot(bot)
    if (server != null) await server.cleanup()
  })

  test('the dragon killed, a pearl thrown into the gateway it opened takes the bot out to the outer islands', async (t) => {
    await kit()
    // into the End under resistance while the dragon lives (it spawns as the bot arrives), killed at once
    await run(`effect give ${USER} minecraft:resistance 60 4 true`)
    await run(`execute in minecraft:the_end run spreadplayers 0 20 0 2 false ${USER}`)
    assert.ok(await waitFor(bot, () => isInEnd(bot) && Object.values(bot.entities).some(e => e.name === 'ender_dragon'), 600), 'no dragon came')
    assert.match(await run('execute in minecraft:the_end run kill @e[type=minecraft:ender_dragon]'), /Killed/)
    await run(`effect clear ${USER}`)
    await waitFor(bot, () => bot.entity.onGround, 200)
    const gateway = await timed(t, bot, 'seekGateway', async () => await seekGateway(bot))
    assert.ok(gateway != null, 'no gateway seen')
    assert.match(await run(`execute in minecraft:the_end if block ${gateway.x} ${gateway.y} ${gateway.z} minecraft:end_gateway`), /passed/)
    const res = await timed(t, bot, 'throughGateway', async () => await throughGateway(bot, gateway))
    t.diagnostic(`pearls ${res.throws}, thrown from ${res.from.toString()}, arrived at ${res.arrival.toString()}, the exit gateway ${String(res.exit)}`)
    console.log(`[elytra] gateway ${gateway.toString()}: ${res.throws} pearl(s) from ${res.from.toString()} to ${res.arrival.toString()}, exit ${String(res.exit)}`)
    assert.ok(isInEnd(bot))
    assert.ok(Math.hypot(bot.entity.position.x, bot.entity.position.z) > 700, `still near the main island at ${bot.entity.position.toString()}`)
    assert.ok(bot.entity.onGround)
    assert.ok(res.exit != null, 'no exit gateway by the arrival')
    const memory = bot.survival.memory
    assert.ok(memory.getPois(GATEWAY_POI, { dimension: 'the_end' }).some(p => p.note === 'main'))
    assert.ok(memory.getPois(GATEWAY_POI, { dimension: 'the_end' }).some(p => p.note === 'exit'))
  })

  test('an End City placed with /place: found by its purpur, the ship climbed to, the elytra taken from its frame', async (t) => {
    await kit()
    // seed "elytra" puts a city with a ship at 1196, -24 (its ship's frame at 1274, 132, 4): the area loaded for the
    // place, and let go after
    await run('execute in minecraft:the_end run forceload add 1090 -130 1300 80')
    // (the chunks are generated over the next ticks: the place says 'not loaded' till then)
    let placed = ''
    for (let i = 0; i < 60 && !/Generated/.test(placed); i++) {
      await bot.waitForTicks(20)
      placed = await run('execute in minecraft:the_end run place structure minecraft:end_city 1196 70 -24')
    }
    assert.match(placed, /Generated/)
    assert.match(await run('execute in minecraft:the_end positioned 1196 70 -24 if entity @e[type=minecraft:item_frame,distance=..150]'), /passed/)
    await run('execute in minecraft:the_end run forceload remove all')
    // set down on the island 70 blocks off the city's start, out of the ship's sight
    await run(`execute in minecraft:the_end run spreadplayers 1150 -80 0 3 false ${USER}`)
    assert.ok(await waitFor(bot, () => isInEnd(bot) && bot.entity.onGround && bot.entity.position.distanceTo(new Vec3(1150, bot.entity.position.y, -80)) < 6, 400))
    await bot.waitForChunksToLoad()
    const health = bot.health
    const frame = await timed(t, bot, 'seekEndShip', async () => await seekEndShip(bot))
    assert.ok(frame != null, 'no ship found')
    assert.ok(bot.survival.memory.getPois(END_CITY_POI, { dimension: 'the_end' }).length > 0, 'no city remembered')
    const res = await timed(t, bot, 'takeElytra', async () => await takeElytra(bot, { frame }))
    console.log(`[elytra] the elytra from the frame at ${res.frame.toString()}, health ${health} to ${bot.health}; the chests: ${JSON.stringify(res.looted)}`)
    assert.ok(countItems(bot, 'elytra') >= 1)
    assert.ok(Object.keys(res.looted).length > 0, 'the ship\'s chests gave nothing')
    assert.match(await run('execute in minecraft:the_end positioned 1274 132 4 if entity @e[type=minecraft:item_frame,distance=..2,nbt={Item:{id:"minecraft:elytra"}}]'), /failed/)
  })
})
