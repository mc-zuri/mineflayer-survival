// play's epochs after the dragon against a real server (SURVIVAL_VERSION, default 1.21.11), backwards from a kit: the
// game's milestones in the save as reached, the bot with what a run has after the dragon (the diamond gear, a hoe,
// seeds and bone meal, a rod, an anvil, blocks, food), and play({ epochs: true }) works them in order on a superflat
// set up with commands: a farm by a water hole (sown to FARM_EPOCH_PLOTS, the bone meal growing it, harvested and sown
// again), an experience farm round a zombie spawner (a dungeon's room in a block of stone 20 blocks off, its spawner on
// short delays, one zombie a go and two about at most, noted as the bot passes), and mending from a pond 9 across (a
// data pack's fishing loot: a book of mending in open water only, a cod elsewhere) put on the pickaxe, the sword and
// the chestplate. Reports each epoch's tick and wall time.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { createPlugin } from '../../src'
import { MILESTONES } from '../../src/planner/progression'
import { FARM_EPOCH_PLOTS } from '../../src/epochs'
import { farmPlots } from '../../src/skills/farm'
import { hasEnchant } from '../../src/skills/fish'
import { knownXpFarms } from '../../src/skills/spawnerFarm'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { countItems, inventoryItems, waitUntil } from '../../src/skills/util'

const USERNAME = 'epochs'
const GROUND = -61
const TICKS = Number(process.env.EPOCH_TICKS ?? 60000)

/** the fishing loot of tests/integration/fish.test.ts: a book of mending in open water, a cod elsewhere */
function writeMendingPack (worldDir: string, version: string): void {
  const root = path.join(worldDir, 'datapacks', 'mending_fishing')
  const tables = path.join(root, 'data', 'minecraft', 'loot_table', 'gameplay')
  fs.mkdirSync(tables, { recursive: true })
  fs.writeFileSync(path.join(root, 'pack.mcmeta'), JSON.stringify({ pack: { description: 'mending in open water', min_format: 94, max_format: 200 } }))
  const book = /^1\./.test(version)
    ? {
        type: 'minecraft:item',
        name: 'minecraft:book',
        conditions: [{ condition: 'minecraft:entity_properties', entity: 'this', predicate: { type_specific: { type: 'minecraft:fishing_hook', in_open_water: true } } }],
        functions: [{ function: 'minecraft:set_enchantments', enchantments: { 'minecraft:mending': 1 } }]
      }
    : {
        type: 'minecraft:item',
        name: 'minecraft:book',
        condition: { type: 'minecraft:entity_properties', entity: 'this', predicate: { 'minecraft:type_specific/fishing_hook': { in_open_water: true } } },
        modifier: { type: 'minecraft:set_enchantments', enchantments: { 'minecraft:mending': 1 } }
      }
  fs.writeFileSync(path.join(tables, 'fishing.json'), JSON.stringify({
    type: 'minecraft:fishing',
    pools: [{ rolls: 1, entries: [{ type: 'minecraft:alternatives', children: [book, { type: 'minecraft:item', name: 'minecraft:cod' }] }] }]
  }))
}

describe(`play's epochs on a ${DEFAULT_VERSION} server`, { timeout: (TICKS / 40 + 600) * 1000 }, () => {
  let server: TestServer
  let bot: Bot
  let origin: Vec3
  const run = async (cmd: string): Promise<string> => (await server.command(cmd)).join(' | ')
  const xyz = (p: Vec3): string => `${p.x} ${p.y} ${p.z}`

  before(async () => {
    server = await startServer({
      flat: true,
      seed: 'epochs',
      difficulty: 'easy',
      gamerules: { advance_weather: false, advance_time: false, spawn_mobs: false, spawn_monsters: false },
      properties: { 'spawn-protection': 0 }
    })
    bot = await connectLockstepBot(server, { username: USERNAME })
    await bot.waitForChunksToLoad()
    origin = new Vec3(Math.floor(bot.entity.position.x), GROUND + 1, Math.floor(bot.entity.position.z))
    writeMendingPack(path.join(server.dir, 'world'), server.version)
    console.log(`reload: ${await run('reload')}`)
    await run('time set 1000')
    await run(`fill ${xyz(origin.offset(-24, 0, -24))} ${xyz(origin.offset(24, 8, 24))} air`)
    // the farm's water: a hole in the grass 4 east of the bot
    await run(`setblock ${xyz(origin.offset(4, -1, 0))} water`)
    // the pond: 9 x 9, 3 deep, 8 west of the bot
    await run(`fill ${xyz(origin.offset(-16, -3, -4))} ${xyz(origin.offset(-8, -1, 4))} water`)
    // the dungeon: a room 7 x 7 and 4 high in a block of stone 20 blocks south, a zombie spawner on short delays
    const c = origin.offset(0, 0, 20)
    await run(`fill ${xyz(c.offset(-5, -1, -5))} ${xyz(c.offset(5, 5, 5))} stone`)
    await run(`fill ${xyz(c.offset(-3, 0, -3))} ${xyz(c.offset(3, 3, 3))} cave_air`)
    // a way in from the north, 2 high, that the farm seals
    await run(`fill ${xyz(c.offset(0, 0, -5))} ${xyz(c.offset(0, 1, -4))} cave_air`)
    console.log(`spawner: ${await run(`setblock ${xyz(c)} spawner{SpawnData:{entity:{id:"minecraft:zombie"}},Delay:200,MinSpawnDelay:20,MaxSpawnDelay:40,SpawnCount:1,MaxNearbyEntities:2}`)}`)
    await run(`clear ${USERNAME}`)
    const kit: Array<[string, number]> = [
      ['diamond_sword[enchantments={sharpness:3,unbreaking:3}]', 1], ['diamond_pickaxe[enchantments={efficiency:4,unbreaking:3}]', 1], ['diamond_axe', 1],
      ['iron_hoe', 1], ['wheat_seeds', 24], ['bone_meal', 64], ['fishing_rod', 1], ['anvil', 1], ['crafting_table', 1],
      ['cobblestone', 128], ['cobblestone_slab', 2], ['cooked_beef', 32], ['bread', 16], ['oak_log', 16], ['torch', 16]
    ]
    for (const [item, n] of kit) await run(`give ${USERNAME} ${item} ${n}`)
    for (const [slot, item] of [['armor.head', 'diamond_helmet'], ['armor.chest', 'diamond_chestplate[enchantments={protection:3}]'], ['armor.legs', 'diamond_leggings'], ['armor.feet', 'diamond_boots'], ['weapon.offhand', 'shield']]) await run(`item replace entity ${USERNAME} ${slot} with ${item}`)
    await run(`xp set ${USERNAME} 0 levels`)
    await run(`tp ${USERNAME} ${origin.x + 0.5} ${origin.y} ${origin.z + 0.5}`)
    assert.ok(await waitUntil(bot, () => countItems(bot, 'torch') === 16, 200), 'the kit never came')
    bot.loadPlugin(createPlugin())
  })

  after(async () => {
    bot?.survival?.reflexes?.stop()
    if (bot != null) await quitBot(bot)
    if (server != null) await server.cleanup()
  })

  it('works the farm, the experience farm and mending after the dragon', async () => {
    const saveFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'survival-epochs-')), 'save.json')
    const reached = MILESTONES.map((m, i) => ({ id: m.id, title: m.title, tick: i, wallMs: 0 }))
    fs.writeFileSync(saveFile, JSON.stringify({ version: 1, memory: { version: 1, blocks: [], chests: [], base: null, pois: [], death: null }, reached, ticks: reached.length }))
    const t0 = Date.now()
    const k0 = bot.lockstep.ticks
    const result = await bot.survival.play({ epochs: true, saveFile, maxTicks: TICKS, stock: false, sleep: false, nightMining: false })
    const ticks = bot.lockstep.ticks - k0
    const wall = (Date.now() - t0) / 1000
    for (const r of result.reached.filter(r => r.tick > MILESTONES.length)) console.log(`[epochs] ${r.id}: tick ${r.tick}, ${(r.wallMs / 1000).toFixed(1)} s wall`)
    console.log(`[epochs] ${ticks} ticks in ${wall.toFixed(0)} s (${(ticks / Math.max(1, wall)).toFixed(0)} ticks/s); stopped: ${result.reason}${result.error != null ? `: ${(result.error as Error).message}` : ''}`)
    console.log(`[epochs] level ${(bot as any).experience?.level}, bread ${countItems(bot, 'bread')}, wheat ${countItems(bot, 'wheat')}, gear: ${[...inventoryItems(bot), ...[5, 6, 7, 8].map(s => bot.inventory.slots[s])].filter(i => i != null && hasEnchant(i, 'mending')).map(i => i?.name).join(', ')}`)
    assert.strictEqual(result.reason, 'finished')
    assert.deepStrictEqual(result.reached.filter(r => r.tick > MILESTONES.length).map(r => r.id).sort(), ['farm', 'mending', 'xp_farm'])
    assert.ok(farmPlots(bot.survival.memory) >= FARM_EPOCH_PLOTS)
    assert.strictEqual(knownXpFarms(bot.survival.memory).length, 1)
    const owned = [...inventoryItems(bot), ...[5, 6, 7, 8].map(s => bot.inventory.slots[s])]
    for (const kind of ['pickaxe', 'sword', 'chestplate']) assert.ok(owned.some(i => i != null && i.name.endsWith(kind) && hasEnchant(i, 'mending')), `no mending on the ${kind}`)
  })
})
