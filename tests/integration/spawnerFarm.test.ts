// The spawner experience farm against a real server (SURVIVAL_VERSION, default 1.21.11): a dungeon's room built with
// commands on a superflat (dug out of a block of stone, 7 x 7 and 4 high inside, dark), a zombie spawner set in its middle
// with short delays (MinSpawnDelay 20, MaxSpawnDelay 40: the farm, not the wait, is what's tested), a chest by a wall
// and a hole through the east wall to a dark cave. The bot, noting the spawner, builds the farm (the hole sealed, the
// booth dug into a wall behind a slab) and stands in it killing zombies through its slit until level 30, its health untouched.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { createPlugin } from '../../src'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { buildSpawnerFarm, knownFarmableSpawners, knownXpFarms, noteSpawners, rememberXpFarm } from '../../src/skills/spawnerFarm'
import { experience, gainLevels } from '../../src/skills/xp'
import { countItems, waitUntil } from '../../src/skills/util'

const USERNAME = 'farmer'
const GROUND = -61

describe(`a spawner experience farm on a ${DEFAULT_VERSION} server`, { timeout: 30 * 60 * 1000 }, () => {
  let server: TestServer
  let bot: Bot
  let origin: Vec3
  let ticks = 0
  const run = async (cmd: string): Promise<string> => (await server.command(cmd)).join(' | ')
  const xyz = (p: Vec3): string => `${p.x} ${p.y} ${p.z}`

  before(async () => {
    server = await startServer({
      flat: true,
      seed: 'spawner',
      difficulty: 'easy',
      // no natural spawns: what's in the room came from the spawner
      gamerules: { advance_weather: false, advance_time: false, spawn_mobs: false, spawn_monsters: false, random_tick_speed: 0 },
      properties: { 'spawn-protection': 0 }
    })
    bot = await connectLockstepBot(server, { username: USERNAME })
    await bot.waitForChunksToLoad()
    bot.loadPlugin(createPlugin({ reflexes: false }))
    bot.on('physicsTick', () => { ticks++ })
    origin = new Vec3(Math.floor(bot.entity.position.x), GROUND + 1, Math.floor(bot.entity.position.z))
  })

  after(async () => {
    if (bot != null) await quitBot(bot)
    if (server != null) await server.cleanup()
  })

  it('builds the farm round a zombie spawner and gains 30 levels on it', async () => {
    await run('time set 1000')
    // the room: its floor on the grass, the spawner on the floor 10 blocks east of the bot
    const c = origin.offset(10, 1, 0)
    // in a block of stone: the room 7 x 7 and 4 high, a cave pocket east of it, a hole between
    await run(`fill ${xyz(c.offset(-7, -1, -7))} ${xyz(c.offset(9, 5, 7))} stone`)
    await run(`fill ${xyz(c.offset(-3, 0, -3))} ${xyz(c.offset(3, 3, 3))} cave_air`)
    await run(`fill ${xyz(c.offset(5, 0, -1))} ${xyz(c.offset(7, 2, 1))} cave_air`)
    await run(`fill ${xyz(c.offset(4, 0, 0))} ${xyz(c.offset(4, 1, 0))} cave_air`)
    await run(`setblock ${xyz(c.offset(-3, 0, -1))} chest`)
    const spawner = c
    const nbt = '{SpawnData:{entity:{id:"minecraft:zombie"}},Delay:200,MinSpawnDelay:20,MaxSpawnDelay:40}'
    console.log(`setblock: ${await run(`setblock ${xyz(spawner)} spawner${nbt}`)}`)
    await run(`clear ${USERNAME}`)
    for (const [item, n] of [['diamond_sword[enchantments={sharpness:5}]', 1], ['cobblestone', 64], ['cobblestone_slab', 2], ['diamond_pickaxe', 1], ['cooked_beef', 16]] as const) await run(`give ${USERNAME} ${item} ${n}`)
    for (const [slot, item] of [['armor.head', 'diamond_helmet'], ['armor.chest', 'diamond_chestplate'], ['armor.legs', 'diamond_leggings'], ['armor.feet', 'diamond_boots']]) await run(`item replace entity ${USERNAME} ${slot} with ${item}`)
    await run(`xp set ${USERNAME} 0 levels`)
    await run(`xp set ${USERNAME} 0 points`)
    // in the room, by the spawner
    await run(`tp ${USERNAME} ${spawner.x + 2.5} ${spawner.y} ${spawner.z + 2.5}`)
    assert.ok(await waitUntil(bot, () => countItems(bot, 'cobblestone') === 64 && bot.entity.position.distanceTo(spawner) < 5 && bot.blockAt(spawner)?.name === 'spawner', 200))
    assert.ok(await waitUntil(bot, () => bot.blockAt(spawner)?.blockEntity != null, 100), 'the spawner\'s block entity never came')
    // seen, as a mine passing by notes it
    noteSpawners(bot, bot.survival.memory)
    assert.deepStrictEqual(knownFarmableSpawners(bot.survival.memory).map(s => s.mob), ['zombie'])

    const k0 = ticks
    const t0 = Date.now()
    const farm = await buildSpawnerFarm(bot, spawner)
    console.log(`built: the bot in the booth at ${farm.stand.toString()} in ${ticks - k0} ticks (${((Date.now() - t0) / 1000).toFixed(1)} s)`)
    assert.ok(bot.blockAt(c.offset(4, 0, 0))?.boundingBox === 'block' && bot.blockAt(c.offset(4, 1, 0))?.boundingBox === 'block', 'the hole to the cave isn\'t sealed')
    // a chicken jockey in the room as well (a baby zombie on a chicken: one went through the slit and, the client
    // leaving it where it mounted, hit the bot to death unseen, 26.3)
    console.log(`jockey: ${await run(`summon chicken ${spawner.x + 0.5} ${spawner.y} ${spawner.z + 2.5} {Passengers:[{id:"minecraft:zombie",IsBaby:1b}]}`)}`)
    rememberXpFarm(bot.survival.memory, farm)
    assert.strictEqual(knownXpFarms(bot.survival.memory).length, 1)

    const k1 = ticks
    const t1 = Date.now()
    // through gainLevels, as levelsToward has it: the farm its first source
    const res = await gainLevels(bot, { level: 30, sources: ['farm'], farm: knownXpFarms(bot.survival.memory)[0], maxTicks: 60000 })
    const wall = (Date.now() - t1) / 1000
    console.log(`farmed: level ${res.level}, ${res.points} points, ${res.killed} kills in ${ticks - k1} ticks, ${wall.toFixed(1)} s (${((ticks - k1) / wall).toFixed(0)} ticks/s); health ${bot.health}`)
    assert.ok(experience(bot).level >= 30)
    assert.ok(bot.health >= 18, `health ${bot.health}: a zombie reached the bot in its booth`)
  })
})
