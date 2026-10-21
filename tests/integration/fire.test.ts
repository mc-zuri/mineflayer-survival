// Fires put out against a real server (SURVIVAL_VERSION): fire on netherrack about the bot (as a blaze's fireballs
// light it, burning for good), put out with a hit each (putOutFiresNear), and the bot standing in one got out of it
// (escapeHazard), also from a fire its box reaches into from the next cell (inHazard by the box's cells); the fire the
// bot burns with out of lava or a fire put out by the hazard reflex with its water bucket (douseBurning).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert'
import type { Bot } from 'mineflayer'
import { createPlugin } from '../../src'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { putOutFiresNear } from '../../src/nether/fortressSkills'
import { escapeHazard, inHazard, isOnFire } from '../../src/skills/escape'
import { isSource } from '../../src/skills/bucket'
import { ReflexEngine } from '../../src/reflexes/engine'
import { hazardReflex } from '../../src/reflexes/rules'
import { countItems, waitUntil } from '../../src/skills/util'

const USERNAME = 'firebot'

describe(`fires put out on a ${DEFAULT_VERSION} server`, { timeout: 10 * 60 * 1000 }, () => {
  let server: TestServer
  let bot: Bot
  const run = async (cmd: string): Promise<string> => (await server.command(cmd)).join(' | ')

  before(async () => {
    server = await startServer({ flat: true, seed: 'fire', difficulty: 'peaceful', gamerules: { advance_time: false, spawn_mobs: false, advance_weather: false } })
    bot = await connectLockstepBot(server, { username: USERNAME })
    await bot.waitForChunksToLoad()
    bot.loadPlugin(createPlugin({ reflexes: false }))
  })
  after(async () => {
    if (bot != null) await quitBot(bot)
    if (server != null) await server.cleanup()
  })

  it('puts out the fires about the bot and gets it out of the one it stands in', async () => {
    const o = bot.entity.position.floored()
    const xyz = (dx: number, dy: number, dz: number): string => `${o.x + dx} ${o.y + dy} ${o.z + dz}`
    await run(`fill ${xyz(-6, -1, -6)} ${xyz(6, -1, 6)} netherrack`)
    await run(`fill ${xyz(-6, 0, -6)} ${xyz(6, 4, 6)} air`)
    await run(`tp ${USERNAME} ${o.x + 0.5} ${o.y} ${o.z + 0.5}`)
    for (const [dx, dz] of [[2, 0], [0, 2], [-1, 1]]) await run(`setblock ${xyz(dx, 0, dz)} fire`)
    await waitUntil(bot, () => [[2, 0], [0, 2], [-1, 1]].every(([dx, dz]) => bot.blockAt(o.offset(dx, 0, dz))?.name === 'fire'), 100)
    const lit = [[2, 0], [0, 2], [-1, 1]].filter(([dx, dz]) => bot.blockAt(o.offset(dx, 0, dz))?.name === 'fire').length
    const out = await putOutFiresNear(bot, 2)
    assert.ok(lit >= 2 && out === lit, `${out} of ${lit} put out`)
    assert.ok(await waitUntil(bot, () => [[2, 0], [0, 2], [-1, 1]].every(([dx, dz]) => bot.blockAt(o.offset(dx, 0, dz))?.name !== 'fire'), 20))
    // in a fire
    await run(`setblock ${xyz(0, 0, 0)} fire`)
    assert.ok(await waitUntil(bot, () => inHazard(bot), 40))
    await escapeHazard(bot, { maxTicks: 100 })
    assert.equal(inHazard(bot), false)
  })

  it('gets out of a fire its box reaches into from the next cell, its middle out of it', async () => {
    const o = bot.entity.position.floored()
    const xyz = (dx: number, dy: number, dz: number): string => `${o.x + dx} ${o.y + dy} ${o.z + dz}`
    await run(`fill ${xyz(-6, -1, -6)} ${xyz(6, -1, 6)} netherrack`)
    await run(`fill ${xyz(-6, 0, -6)} ${xyz(6, 4, 6)} air`)
    await run(`effect give ${USERNAME} minecraft:instant_health 1 10 true`)
    // the bot's middle at x + 0.75 of its cell: its box (0.6 wide) reaches 0.05 into the cell east of it
    await run(`tp ${USERNAME} ${o.x + 0.75} ${o.y} ${o.z + 0.5}`)
    await waitUntil(bot, () => Math.abs(bot.entity.position.x - (o.x + 0.75)) < 0.01 && bot.entity.onGround, 40)
    await run(`setblock ${xyz(1, 0, 0)} fire`)
    assert.ok(await waitUntil(bot, () => bot.blockAt(o.offset(1, 0, 0))?.name === 'fire', 40))
    assert.ok(await waitUntil(bot, () => inHazard(bot), 5), 'the fire beside the bot middle, in its box, is no hazard')
    const health = bot.health
    await escapeHazard(bot, { maxTicks: 100 })
    assert.equal(inHazard(bot), false)
    console.log(`out of the fire beside: health ${health} to ${bot.health}`)
  })

  /**
   * The bot set burning by a moment in lava (its fire on 15 seconds after, Entity.lavaIgnite), the reflexes off the
   * while, then the hazard reflex on: the water bucket poured at the feet puts it out within a few ticks, and the water
   * taken back up (f9-26.3, t347525: out of a deep lava pool at 9 health, a water bucket in its bag, it burned to death)
   */
  it('puts out the fire it burns with out of the lava with its water bucket, and takes the water back up', async () => {
    const o = bot.entity.position.floored()
    const xyz = (dx: number, dy: number, dz: number): string => `${o.x + dx} ${o.y + dy} ${o.z + dz}`
    await run(`fill ${xyz(-6, -1, -6)} ${xyz(6, -1, 6)} stone`)
    await run(`fill ${xyz(-6, 0, -6)} ${xyz(6, 4, 6)} air`)
    await run(`clear ${USERNAME}`)
    await run(`give ${USERNAME} water_bucket 1`)
    await run(`give ${USERNAME} cobblestone 16`)
    await run(`effect give ${USERNAME} minecraft:instant_health 1 10 true`)
    await run(`tp ${USERNAME} ${o.x + 0.5} ${o.y} ${o.z + 0.5}`)
    assert.ok(await waitUntil(bot, () => countItems(bot, 'water_bucket') === 1 && bot.entity.onGround, 40))
    const engine = new ReflexEngine(bot, { reflexes: [hazardReflex], enabled: false })
    try {
      await run(`setblock ${xyz(0, 0, 0)} lava`)
      assert.ok(await waitUntil(bot, () => isOnFire(bot), 40), 'never caught fire in the lava')
      await run(`setblock ${xyz(0, 0, 0)} air`)
      await run(`fill ${xyz(-2, 0, -2)} ${xyz(2, 1, 2)} air`)
      assert.ok(await waitUntil(bot, () => !inHazard(bot) && bot.entity.onGround, 40), 'still in the lava')
      assert.ok(isOnFire(bot), 'the fire went out by itself')
      const health = bot.health
      engine.enabled = true
      let ticks = 0
      const out = await waitUntil(bot, () => { ticks++; return !isOnFire(bot) }, 60)
      assert.ok(out, `still burning after ${ticks} ticks`)
      // the water back in the bucket, none left at the feet
      assert.ok(await waitUntil(bot, () => countItems(bot, 'water_bucket') === 1 && engine.current == null, 60), `${countItems(bot, 'water_bucket')} water buckets, ${countItems(bot, 'bucket')} empty`)
      assert.ok(![[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => isSource(bot.blockAt(bot.entity.position.floored().offset(dx, 0, dz)), 'water')), 'the water left poured')
      console.log(`burning out of the lava: out in ${ticks} ticks, health ${health} to ${bot.health}`)
      assert.ok(bot.health > 0 && health - bot.health <= 2, `health ${health} to ${bot.health}`)
    } finally {
      engine.stop()
    }
  })

  it('in a fire with a water bucket: out of it, the fire it burns with put out, the bucket full again', async () => {
    const o = bot.entity.position.floored()
    const xyz = (dx: number, dy: number, dz: number): string => `${o.x + dx} ${o.y + dy} ${o.z + dz}`
    await run(`fill ${xyz(-6, -1, -6)} ${xyz(6, -1, 6)} netherrack`)
    await run(`fill ${xyz(-6, 0, -6)} ${xyz(6, 4, 6)} air`)
    await run(`clear ${USERNAME}`)
    await run(`give ${USERNAME} water_bucket 1`)
    await run(`effect give ${USERNAME} minecraft:instant_health 1 10 true`)
    await run(`tp ${USERNAME} ${o.x + 0.5} ${o.y} ${o.z + 0.5}`)
    assert.ok(await waitUntil(bot, () => countItems(bot, 'water_bucket') === 1 && bot.entity.onGround, 40))
    // (the reflex on once the fire's caught: BaseFireBlock.entityInside lights the body some ticks in)
    const engine = new ReflexEngine(bot, { reflexes: [hazardReflex], enabled: false })
    try {
      const health = bot.health
      await run(`setblock ${xyz(0, 0, 0)} fire`)
      assert.ok(await waitUntil(bot, () => isOnFire(bot) && inHazard(bot), 60), 'never caught fire in the fire')
      engine.enabled = true
      let ticks = 0
      const out = await waitUntil(bot, () => { ticks++; return !inHazard(bot) && !isOnFire(bot) }, 100)
      assert.ok(out, `in the fire or burning after ${ticks} ticks`)
      assert.ok(await waitUntil(bot, () => countItems(bot, 'water_bucket') === 1 && engine.current == null, 60), `${countItems(bot, 'water_bucket')} water buckets, ${countItems(bot, 'bucket')} empty`)
      console.log(`in a fire: out and put out in ${ticks} ticks, health ${health} to ${bot.health}`)
      assert.ok(bot.health > 0 && health - bot.health <= 4, `health ${health} to ${bot.health}`)
    } finally {
      engine.stop()
    }
  })
})
