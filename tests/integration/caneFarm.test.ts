// The enchanting's cane farm against a real server (SURVIVAL_VERSION, default 1.21.11) on a superflat patch: home has no
// water and no cane; a river 130 blocks east (out of the 6-chunk view), its bank grown with cane, is in the biome survey
// (as the loaded chunks' or the seed's biomes put it there). keepCaneFarm explores the shores for the farm's canes, cuts
// the river's above their bottom blocks, carries them home and plants them on the banks of a water channel dug and
// filled from the water bucket; with the random ticks sped up (the scenario's only: random_tick_speed), the canes grow
// and the farm is harvested, each cut above its bottom block, which stays to grow again.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { createPlugin } from '../../src'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { countItems, waitUntil } from '../../src/skills/util'
import { WorldMemory } from '../../src/core/memory'
import { Executor } from '../../src/executor/executor'
import { keepCaneFarm, CANE_FARM_CANES } from '../../src/milestones'
import { grownCanes, knownCaneFarm } from '../../src/skills/caneFarm'

const USERNAME = 'canebot'
// the superflat's grass is at y = -61; the bot stands at -60
const GROUND = -61
/** the river's west bank, east of home */
const RIVER = 130
/** the bank's cane columns (z), 3 high */
const COLUMNS = [-10, -6, -2, 2, 6, 10]

describe(`a cane farm by home from a river's canes on a ${DEFAULT_VERSION} server`, { timeout: 30 * 60 * 1000 }, () => {
  let server: TestServer
  let bot: Bot
  let origin: Vec3
  let executor: Executor
  const memory = new WorldMemory()
  const run = async (cmd: string): Promise<string> => (await server.command(cmd)).join(' ')
  const at = (dx: number, dy: number, dz: number): Vec3 => origin.offset(dx, dy, dz)
  const xyz = (pos: Vec3): string => `${pos.x} ${pos.y} ${pos.z}`
  const log = (line: string): void => { console.log(`[cane] t${(bot as any).survival?.tasks?.tick ?? 0} ${line}`) }

  before(async () => {
    server = await startServer({
      flat: true,
      seed: 'cane',
      difficulty: 'peaceful',
      gamerules: { advance_weather: false, advance_time: false, spawn_mobs: false, spawn_monsters: false },
      properties: { 'spawn-protection': 0 }
    })
    bot = await connectLockstepBot(server, { username: USERNAME })
    await bot.waitForChunksToLoad()
    bot.loadPlugin(createPlugin({ reflexes: false }))
    origin = new Vec3(Math.floor(bot.entity.position.x), GROUND + 1, Math.floor(bot.entity.position.z))
    // the river, loaded for the commands only: a strip of water 4 wide with a sand bank, canes 3 high on the bank
    const r = (dx: number, dy: number, dz: number): Vec3 => at(RIVER + dx, dy, dz)
    await run(`forceload add ${r(-8, 0, -16).x} ${r(0, 0, -16).z} ${r(12, 0, 16).x} ${r(0, 0, 16).z}`)
    await run(`fill ${xyz(r(0, -1, -14))} ${xyz(r(3, -1, 14))} water`)
    await run(`fill ${xyz(r(-1, -1, -14))} ${xyz(r(-1, -1, 14))} sand`)
    for (const z of COLUMNS) await run(`fill ${xyz(r(-1, 0, z))} ${xyz(r(-1, 2, z))} sugar_cane`)
    await run(`forceload remove ${r(-8, 0, -16).x} ${r(0, 0, -16).z} ${r(12, 0, 16).x} ${r(0, 0, 16).z}`)
    await run(`clear ${USERNAME}`)
    await run(`give ${USERNAME} water_bucket 1`)
    await run(`give ${USERNAME} bread 16`)
    await run('time set 1000')
    assert.ok(await waitUntil(bot, () => countItems(bot, 'water_bucket') > 0, 100))
    memory.setBase(origin, 'overworld')
    executor = new Executor(bot, { memory, log })
    // the river's chunk in the biome survey (as a pass by it, or the seed's read, would note it)
    executor.biomes.note({ x: RIVER + origin.x + 2, z: origin.z, y: GROUND, biome: 'river' })
  })

  after(async () => {
    if (bot != null) await quitBot(bot)
    if (server != null) await server.cleanup()
  })

  it('finds the canes by the river, brings them home and plants them on a channel dug there', async () => {
    assert.strictEqual(bot.findBlock({ matching: bot.registry.blocksByName.sugar_cane.id, maxDistance: 96 }), null, 'a cane in sight from home')
    const ctrl = new AbortController()
    const t0 = (bot as any).survival.tasks.tick
    const canes = await keepCaneFarm(bot, executor, ctrl.signal, log)
    const farm = knownCaneFarm(memory)
    log(`${canes} canes held, the farm's ${farm?.spots.length ?? 0} spots, in ${(bot as any).survival.tasks.tick - t0} ticks`)
    assert.ok(farm != null, 'no farm')
    // the river's 6 columns cut above their bottom blocks: 12 canes, the table's book's 3 kept
    assert.ok(farm.spots.length >= CANE_FARM_CANES, `${farm.spots.length} spots planted`)
    assert.ok(canes >= 3, `${canes} canes held`)
    // planted by home, by water
    for (const s of farm.spots) {
      assert.ok(Math.hypot(s.x - origin.x, s.z - origin.z) <= 20, `a spot at ${s.toString()}`)
      assert.strictEqual(bot.blockAt(s.offset(0, 1, 0))?.name, 'sugar_cane', `no cane on ${s.toString()}`)
    }
  })

  it('the farm grows (random ticks sped up) and is harvested above its bottom blocks', async () => {
    const farm = knownCaneFarm(memory)
    assert.ok(farm != null, 'no farm from the test before')
    await run('gamerule random_tick_speed 400')
    const lookup = (p: Vec3): any => bot.blockAt(p)
    assert.ok(await waitUntil(bot, () => grownCanes(lookup, farm).length >= farm.spots.length - 1, 4000), `${grownCanes(lookup, farm).length} of ${farm.spots.length} grown`)
    await run('gamerule random_tick_speed 0')
    const before = countItems(bot, 'sugar_cane')
    const grown = grownCanes(lookup, farm).length
    const canes = await keepCaneFarm(bot, executor, new AbortController().signal, log)
    // the canes cut, and those beyond the table's book's planted on more of the channel's banks (CANE_FARM_SPOTS)
    const after = knownCaneFarm(memory)
    const planted = (after?.spots.length ?? 0) - farm.spots.length
    log(`harvest: ${canes - before} canes more held and ${planted} planted, from ${grown} grown`)
    assert.ok(canes - before + planted >= grown, `${canes - before} canes more held and ${planted} planted, from ${grown} grown`)
    assert.ok(canes >= 3, 'the table\'s book\'s canes kept')
    for (const s of after?.spots ?? []) assert.strictEqual(bot.blockAt(s.offset(0, 1, 0))?.name, 'sugar_cane', `no cane on ${s.toString()} (its bottom block kept, or planted)`)
    assert.strictEqual(grownCanes(lookup, farm).length, 0)
  })
})
