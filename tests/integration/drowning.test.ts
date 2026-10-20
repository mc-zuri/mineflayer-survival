// Up for air against a real server (SURVIVAL_VERSION), the bot's air run down to a few bubbles under water first:
// out of a 1-wide flooded hole whose air is a tunnel's end over it, a ledge of the rock beside it over the bot's box
// (full-26.3-fresh-z: the bot drowned under it, its head bumped short of the air, t95955); out of a flooded cave under
// a ceiling of 3 blocks of stone, the open air 10 blocks across or, sealed, none; digging sand on a lake's floor with
// the reflexes on; and a starving bot under water eats only once its head is out.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { createPlugin } from '../../src'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { headInWater, surface } from '../../src/skills/escape'
import { collectBlock } from '../../src/skills/collectBlock'
import { waitUntil } from '../../src/skills/util'

const USERNAME = 'drownbot'

describe(`up for air on a ${DEFAULT_VERSION} server`, { timeout: 15 * 60 * 1000 }, () => {
  let server: TestServer
  let bot: Bot
  const run = async (cmd: string): Promise<string> => (await server.command(cmd)).join(' | ')
  /** the scenario's corner: well over the flat world's ground, a new one each time, 30 blocks on from the spawn's */
  let origin: Vec3
  let next = 0
  const site = (): Vec3 => new Vec3(origin.x + 30 * ++next, -30, origin.z)

  before(async () => {
    server = await startServer({ flat: true, seed: 'drown', difficulty: 'easy', gamerules: { advance_time: false, spawn_mobs: false, advance_weather: false } })
    bot = await connectLockstepBot(server, { username: USERNAME })
    await bot.waitForChunksToLoad()
    origin = bot.entity.position.floored()
    bot.loadPlugin(createPlugin({ reflexes: { enabled: false } }))
  })
  after(async () => {
    if (bot != null) await quitBot(bot)
    if (server != null) await server.cleanup()
  })

  /** fresh: full health and food, the given items, then at `pos` (feet) under water till the air is down to `air` */
  const dunk = async (pos: Vec3, items: string[], air = 5): Promise<void> => {
    bot.survival.reflexes!.enabled = false
    // (a scenario before that killed the bot: respawned first)
    assert.ok(await waitUntil(bot, () => bot.health > 0, 200), 'respawned')
    await run(`clear ${USERNAME}`)
    await run(`effect give ${USERNAME} minecraft:instant_health 1 10 true`)
    await run(`effect give ${USERNAME} minecraft:saturation 1 10 true`)
    for (const i of items) await run(`give ${USERNAME} ${i}`)
    await run(`tp ${USERNAME} ${pos.x} ${pos.y} ${pos.z}`)
    assert.ok(await waitUntil(bot, () => bot.entity.position.distanceTo(pos) < 1.5, 100), 'tp')
    assert.ok(await waitUntil(bot, () => headInWater(bot) && bot.oxygenLevel <= air, 600), `air down to ${air} (${bot.oxygenLevel})`)
  }

  /** health and air once out: alive, the head out of the water and the air back up */
  const survived = (label: string): void => {
    console.log(`${label}: health ${bot.health}, air ${bot.oxygenLevel}, at ${bot.entity.position.toString()}`)
    assert.ok(bot.health > 0, `${label}: dead`)
    assert.equal(headInWater(bot), false, `${label}: head under water`)
  }

  it('out of a 1-wide flooded hole whose air, a tunnel\'s end, is over a ledge the box is under (fresh-z)', async () => {
    const b = site()
    const at = (dx: number, dy: number, dz: number): string => `${b.x + dx} ${b.y + dy} ${b.z + dz}`
    await run(`fill ${at(-6, -2, -6)} ${at(6, 6, 6)} stone`)
    // the pool: x -2 to 0, y 0 to 2, z 0 to 3; the tunnel at y 3 and 4 from x 0 east; the stone at (-1, 3, 0) the ledge
    await run(`fill ${at(-2, 0, 0)} ${at(0, 2, 3)} water`)
    await run(`fill ${at(0, 3, 0)} ${at(4, 4, 0)} air`)
    // the bot's middle 0.12 into its column: its box 0.18 under the ledge's column
    await dunk(new Vec3(b.x + 0.12, b.y, b.z + 0.5), ['iron_pickaxe', 'cobblestone 32'])
    await surface(bot, { maxTicks: 300 })
    survived('fresh-z hole')
    // and out on the tunnel's floor, not on a jump over the water it sinks back into
    assert.ok(bot.entity.onGround && (bot.entity as any).isInWater !== true, `not ashore: ${bot.entity.position.toString()}`)
    assert.ok(bot.entity.position.y >= b.y + 3 - 1e-3)
  })

  it('out of a flooded cave under 3 blocks of stone, the open air 10 blocks across', async () => {
    const b = site()
    const at = (dx: number, dy: number, dz: number): string => `${b.x + dx} ${b.y + dy} ${b.z + dz}`
    await run(`fill ${at(-5, -2, -5)} ${at(15, 5, 5)} stone`)
    await run(`fill ${at(-5, 6, -5)} ${at(15, 12, 5)} air`)
    await run(`fill ${at(-2, 0, -2)} ${at(12, 2, 2)} water`)
    await run(`fill ${at(10, 3, -2)} ${at(12, 5, 2)} air`)
    await dunk(new Vec3(b.x + 0.5, b.y, b.z + 0.5), ['iron_pickaxe', 'cobblestone 32'])
    await surface(bot, { maxTicks: 300 })
    survived('cave, air across')
  })

  it('out of a sealed flooded cave under 3 blocks of stone: the ceiling dug', async () => {
    const b = site()
    const at = (dx: number, dy: number, dz: number): string => `${b.x + dx} ${b.y + dy} ${b.z + dz}`
    await run(`fill ${at(-5, -2, -5)} ${at(5, 5, 5)} stone`)
    await run(`fill ${at(-5, 6, -5)} ${at(5, 12, 5)} air`)
    await run(`fill ${at(-2, 0, -2)} ${at(2, 2, 2)} water`)
    await dunk(new Vec3(b.x + 0.5, b.y, b.z + 0.5), ['stone_pickaxe', 'cobblestone 32'])
    await surface(bot, { maxTicks: 300 })
    survived('sealed cave')
  })

  it('in a sealed flooded cave with no pickaxe: an air pocket at the ceiling, its sides sealed and its water scooped', async () => {
    const b = site()
    const at = (dx: number, dy: number, dz: number): string => `${b.x + dx} ${b.y + dy} ${b.z + dz}`
    await run(`fill ${at(-5, -2, -5)} ${at(5, 5, 5)} stone`)
    await run(`fill ${at(-2, 0, -2)} ${at(2, 2, 2)} water`)
    await dunk(new Vec3(b.x + 0.5, b.y, b.z + 0.5), ['bucket', 'cobblestone 32'])
    await surface(bot, { maxTicks: 300 })
    survived('pocket')
    assert.equal(bot.blockAt(new Vec3(b.x, b.y + 2, b.z))?.name, 'air')
  })

  it('digs sand on a lake\'s floor 8 deep with the reflexes on, and lives', async () => {
    const b = site()
    const at = (dx: number, dy: number, dz: number): string => `${b.x + dx} ${b.y + dy} ${b.z + dz}`
    await run(`fill ${at(-8, -3, -8)} ${at(8, 0, 8)} stone`)
    await run(`fill ${at(-8, 1, -8)} ${at(8, 1, 8)} sand`)
    await run(`fill ${at(-8, 2, -8)} ${at(8, 9, 8)} water`)
    await run(`fill ${at(-8, 10, -8)} ${at(8, 14, 8)} air`)
    await dunk(new Vec3(b.x + 0.5, b.y + 2, b.z + 0.5), ['iron_shovel'], 12)
    const deaths: string[] = []
    const onDeath = (): void => { deaths.push('died') }
    bot.on('death', onDeath)
    bot.survival.reflexes!.enabled = true
    try {
      const sand = bot.blockAt(new Vec3(b.x + 1, b.y + 1, b.z))
      assert.equal(sand?.name, 'sand')
      // as a plan's step runs: a foreground task the drowning reflex preempts
      await bot.survival.tasks.run({ name: 'collect sand', retries: 3 }, async (ctx) => await collectBlock(bot, { positions: [sand!.position] }, ctx.signal))
        .catch((err: Error) => console.log('collect:', err.message))
      // the reflex ends once the air is back; the bot's left to come up after
      await waitUntil(bot, () => !headInWater(bot) || deaths.length > 0, 600)
    } finally {
      bot.off('death', onDeath)
      bot.survival.reflexes!.enabled = false
    }
    assert.deepEqual(deaths, [])
    survived('lake floor')
  })

  it('a starving bot under water eats only once its head is out', async () => {
    const b = site()
    const at = (dx: number, dy: number, dz: number): string => `${b.x + dx} ${b.y + dy} ${b.z + dz}`
    await run(`fill ${at(-4, -2, -4)} ${at(4, 0, 4)} stone`)
    await run(`fill ${at(-4, 1, -4)} ${at(4, 4, 4)} water`)
    await run(`fill ${at(-4, 5, -4)} ${at(4, 8, 4)} air`)
    await dunk(new Vec3(b.x + 0.5, b.y + 1, b.z + 0.5), ['cooked_porkchop 4'], 14)
    await run(`effect give ${USERNAME} minecraft:hunger 30 255 true`)
    assert.ok(await waitUntil(bot, () => bot.food <= 6, 400), `food ${bot.food}`)
    await run(`effect clear ${USERNAME} minecraft:hunger`)
    const eaten: Array<{ underwater: boolean, air: number }> = []
    const onReflex = (name: string): void => { if (name === 'eat') eaten.push({ underwater: headInWater(bot), air: bot.oxygenLevel }) }
    bot.on('reflex' as any, onReflex)
    bot.survival.reflexes!.enabled = true
    try {
      // the bot left on the floor: the drowning reflex takes it up at low air, and the meal comes after
      assert.ok(await waitUntil(bot, () => eaten.length > 0, 1200), 'no meal')
    } finally {
      bot.off('reflex' as any, onReflex)
      bot.survival.reflexes!.enabled = false
    }
    console.log('meals:', JSON.stringify(eaten))
    assert.ok(eaten.every(e => !e.underwater), 'a meal under water')
  })
})
