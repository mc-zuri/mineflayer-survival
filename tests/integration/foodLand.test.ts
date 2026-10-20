// Food land against a real server (SURVIVAL_VERSION, default 1.21.11), under lockstep: a barren snowy land, as the
// snowy peaks of 26.3 seed 31337 were (a superflat of snow blocks, all of it grove, which spawns no farm animal), the
// bot hungry on a plateau about home, and the food (plains with cows) only some 150 blocks off to the west, downhill
// off the plateau's one edge with steps. play's food milestone (and the meal first) has the bot survey the loaded
// chunks' biomes, find none with food about home, scout downhill, see the plains' chunks, go there and get its food
// there, never starving. FOOD_LAND_LOG=1 prints the bot's log.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { createPlugin } from '../../src'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { countItems, waitUntil } from '../../src/skills/util'
import { FOOD_GOAL, FOOD_POINTS } from '../../src/planner/progression'
import { foodInfo } from '../../src/core/items'
import { FOOD_LAND_POI } from '../../src/executor/foodLand'
import type { MilestoneId } from '../../src/planner/progression'

const USERNAME = 'landbot'
// the superflat's top layer (snow blocks) is at y = 55: the overworld's surface is no lower than SURFACE_MIN_Y (50)
const GROUND = 55
// the plateau about home: 6 high, x -30 to 140 and z -110 to 110 of the spawn, steps down off its west edge
const PLATEAU = 6
// the plains: x -260 to -150 of the spawn, z -50 to 50, 8 cows
const PLAINS = { x0: -260, x1: -150, z0: -50, z1: 50 }
const MAX_TICKS = Number(process.env.FOOD_LAND_TICKS ?? 40000)

describe(`food land on a barren snowy land on a ${DEFAULT_VERSION} server`, { timeout: (MAX_TICKS / 50 + 600) * 1000 }, () => {
  let server: TestServer
  let bot: Bot
  let origin: Vec3
  let ticks = 0
  const lines: string[] = []

  const run = async (cmd: string): Promise<string> => (await server.command(cmd)).join(' ')
  const at = (dx: number, dy: number, dz: number): Vec3 => origin.offset(dx, dy, dz)
  const xyz = (pos: Vec3): string => `${pos.x} ${pos.y} ${pos.z}`
  /** a fill, its answer checked */
  const fill = async (cmd: string): Promise<void> => {
    let out = ''
    // (a forceloaded chunk loads over the next ticks: "That position is not loaded" till then)
    for (let i = 0; i < 30; i++) {
      out = await run(cmd)
      if (/Success|filled|changed|entries set/i.test(out)) return
      await bot.waitForTicks(20)
    }
    assert.fail(`${cmd}: ${out}`)
  }
  const points = (): number => FOOD_GOAL.reduce((n, f) => n + countItems(bot, f) * (foodInfo(bot.registry as any, f)?.nutrition ?? 0), 0)

  before(async () => {
    server = await startServer({
      flat: true,
      seed: 'foodland',
      // (easy: peaceful fills the hunger bar again; no monster spawns all the same)
      difficulty: 'easy',
      gamerules: { advance_weather: false, advance_time: false, spawn_mobs: false, spawn_monsters: false },
      properties: {
        'spawn-protection': 0,
        // (grove all over: snowy, no cow, pig, sheep nor chicken; no structures, no features)
        'generator-settings': JSON.stringify({ layers: [{ block: 'minecraft:bedrock', height: 1 }, { block: 'minecraft:stone', height: 116 }, { block: 'minecraft:dirt', height: 2 }, { block: 'minecraft:snow_block', height: 1 }], biome: 'minecraft:grove', features: false, lakes: false, structure_overrides: [] })
      }
    })
    bot = await connectLockstepBot(server, { username: USERNAME })
    await bot.waitForChunksToLoad()
    bot.on('physicsTick', () => { ticks++ })
    const spawn = bot.entity.position.floored()
    origin = new Vec3(spawn.x, GROUND, spawn.z)
    await run('time set 1000')
    await run('weather clear')
    // the plateau, its chunks loaded, in strips under the fill's 32768 blocks; its west edge cut into steps
    await run(`forceload add ${origin.x - 30} ${origin.z - 110} ${origin.x + 140} ${origin.z + 110}`)
    for (let z = -110; z <= 110; z += 25) await fill(`fill ${xyz(at(-30, 1, z))} ${xyz(at(140, PLATEAU, Math.min(110, z + 24)))} snow_block`)
    for (let i = 0; i < PLATEAU - 1; i++) await fill(`fill ${xyz(at(-30 + i, 2 + i, -110))} ${xyz(at(-30 + i, PLATEAU, 110))} air`)
    // the plains, their chunks loaded on the server (out of the bot's sight) for the fills and the cows
    await run(`forceload add ${origin.x + PLAINS.x0} ${origin.z + PLAINS.z0} ${origin.x + PLAINS.x1} ${origin.z + PLAINS.z1}`)
    await fill(`fill ${xyz(at(PLAINS.x0, 0, PLAINS.z0))} ${xyz(at(PLAINS.x1, 0, PLAINS.z1))} grass_block`)
    for (let z = PLAINS.z0; z <= PLAINS.z1; z += 18) await fill(`fillbiome ${xyz(at(PLAINS.x0, -3, z))} ${xyz(at(PLAINS.x1, 12, Math.min(PLAINS.z1, z + 17)))} minecraft:plains`)
    for (let i = 0; i < 8; i++) await run(`summon cow ${xyz(at(-205 + (i % 4) * 6, 1, -9 + Math.floor(i / 4) * 18))}`)
    await run(`tp ${USERNAME} ${origin.x + 0.5} ${origin.y + PLATEAU + 1} ${origin.z + 0.5}`)
    assert.ok(await waitUntil(bot, () => bot.entity.position.y > origin.y + PLATEAU && bot.entity.onGround, 100), `not on the plateau: ${bot.entity.position.toString()}`)
    for (const [item, n] of [['iron_sword', 1], ['stone_pickaxe', 1], ['stone_axe', 1], ['furnace', 1], ['crafting_table', 1], ['coal', 16], ['spruce_planks', 16]] as const) await run(`give ${USERNAME} ${item} ${n}`)
    assert.ok(await waitUntil(bot, () => countItems(bot, 'coal') === 16 && countItems(bot, 'spruce_planks') === 16, 60))
    // hungry: the hunger bar down to 8 or so
    await run(`effect give ${USERNAME} minecraft:hunger 30 250 true`)
    assert.ok(await waitUntil(bot, () => (bot.food ?? 20) <= 8, 600), `food ${bot.food}`)
    await run(`effect clear ${USERNAME}`)
    bot.loadPlugin(createPlugin())
  })

  after(async () => {
    bot?.survival?.reflexes?.stop()
    if (bot != null) await quitBot(bot)
    if (server != null) await server.cleanup()
  })

  test('the food milestone got from the plains 150 blocks off downhill, the bot never starving', async () => {
    const start = ticks
    let minFood = bot.food ?? 20
    const onHealth = (): void => { minFood = Math.min(minFood, bot.food ?? 20) }
    bot.on('health', onHealth)
    const skip: MilestoneId[] = ['wood', 'stone', 'base', 'iron', 'diamonds', 'enchanting', 'nether', 'eyes', 'end']
    const log = (l: string): void => { lines.push(l); if (process.env.FOOD_LAND_LOG != null) console.log(`[land] t${ticks} ${l}`) }
    const result = await bot.survival.play({ until: 'food', skip, maxTicks: MAX_TICKS, log, stock: false })
    bot.off('health', onHealth)
    const took = ticks - start
    const land = bot.survival.memory.getPois(FOOD_LAND_POI)[0]
    console.log(`[land] ${result.reason} in ${took} ticks: ${points()} food points, food ${bot.food} (at least ${minFood}), the food land ${land != null ? `${land.x - origin.x} ${land.z - origin.z} (${land.note ?? ''})` : 'none'}, the bot at ${bot.entity.position.minus(origin).floored().toString()}`)
    const trace = lines.filter(l => /food|meal|hungry|plan|step failed/.test(l)).join('\n')
    assert.ok(land != null && land.x - origin.x < -120, `no food land in the plains:\n${trace}`)
    assert.ok(result.reached.some(r => r.id === 'food'), `the food milestone not reached (${result.reason}, ${points()} points):\n${trace}`)
    assert.ok(points() >= FOOD_POINTS)
    assert.ok(minFood > 0, `starved to ${minFood}`)
  })
})
