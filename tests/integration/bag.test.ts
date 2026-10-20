// The bag down a mine against a real server (SURVIVAL_VERSION): what the bot stores, stashes and throws away when its
// inventory fills with the stone of its own route, and what it never picks up again.
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { createPlugin } from '../../src'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { storeItems } from '../../src/skills/chest'
import { countItems, emptySlots, waitTicks, waitUntil } from '../../src/skills/util'
import { DEPOT_POI, Executor, LAVA_ROOM } from '../../src/executor/executor'
import { isThrownDrop } from '../../src/skills/pickupDrops'
import { obsidianFromPools, TABLE_OBSIDIAN } from '../../src/milestones'
import { descendTo } from '../../src/executor/explore'
import { milestoneNeeds } from '../../src/executor/keep'
import { milestone, milestonesAhead } from '../../src/planner/progression'
import { progressState } from '../../src/runner'

const USERNAME = 'bagbot'

/** a chest's items from `data get block ... Items` */
function parseItems (answer: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const m of answer.matchAll(/\{([^{}]*)\}/g)) {
    const id = /id: "minecraft:([a-z_]+)"/.exec(m[1])?.[1]
    const count = Number(/count: (\d+)/.exec(m[1])?.[1] ?? 1)
    if (id != null) out[id] = (out[id] ?? 0) + count
  }
  return out
}
// the superflat's grass is at y = -61; the bot stands at -60
const GROUND = -61

describe(`the bag down a mine on a ${DEFAULT_VERSION} server`, { timeout: 20 * 60 * 1000 }, () => {
  let server: TestServer
  let bot: Bot
  let origin: Vec3

  const run = async (cmd: string): Promise<string> => (await server.command(cmd)).join(' ')
  const at = (dx: number, dy: number, dz: number): Vec3 => origin.offset(dx, dy, dz)
  const xyz = (pos: Vec3): string => `${pos.x} ${pos.y} ${pos.z}`

  before(async () => {
    server = await startServer({
      flat: true,
      seed: 'bag',
      difficulty: 'peaceful',
      gamerules: { advance_weather: false, advance_time: false, spawn_mobs: false, spawn_monsters: false },
      properties: { 'spawn-protection': 0 }
    })
    bot = await connectLockstepBot(server, { username: USERNAME })
    await bot.waitForChunksToLoad()
    bot.loadPlugin(createPlugin({ reflexes: false }))
    origin = new Vec3(Math.floor(bot.entity.position.x), GROUND + 1, Math.floor(bot.entity.position.z))
  })

  after(async () => {
    if (bot != null) await quitBot(bot)
    if (server != null) await server.cleanup()
  })

  beforeEach(async () => {
    await run(`fill ${xyz(at(-12, 0, -12))} ${xyz(at(12, 10, 12))} air`)
    await run(`fill ${xyz(at(-12, -1, -12))} ${xyz(at(12, -1, 12))} grass_block`)
    await run('kill @e[type=item]')
    await run(`clear ${USERNAME}`)
    await run(`tp ${USERNAME} ${origin.x + 0.5} ${origin.y} ${origin.z + 0.5}`)
    assert.ok(await waitUntil(bot, () => bot.entity.position.distanceTo(origin.offset(0.5, 0, 0.5)) < 0.1 && bot.inventory.items().length === 0, 100))
  })

  async function give (item: string, count: number): Promise<void> {
    const had = countItems(bot, item)
    await run(`give ${USERNAME} ${item} ${count}`)
    assert.ok(await waitUntil(bot, () => countItems(bot, item) >= had + count, 40), `no ${count} ${item} given`)
  }

  async function setblock (pos: Vec3, block: string): Promise<void> {
    await run(`setblock ${xyz(pos)} ${block}`)
    const name = block.replace(/^minecraft:/, '').replace(/\[.*$/, '')
    assert.ok(await waitUntil(bot, () => bot.blockAt(pos)?.name === name, 40), `no ${name} at ${pos.toString()}`)
  }

  it('stores into a chest with stone over it, the stone broken first (ChestBlock.isChestBlockedAt)', async () => {
    // (26.3 seed 2: the base's one chest under its wall's stone, every store 'windowOpen did not fire')
    await give('cobblestone', 64)
    await give('iron_pickaxe', 1)
    const chest = at(3, 0, 0)
    await setblock(chest, 'chest[facing=west]')
    await setblock(chest.offset(0, 1, 0), 'stone')
    const res = await storeItems(bot, { chest, filter: ['cobblestone'] })
    assert.deepStrictEqual(res.moved, { cobblestone: 64 })
    assert.strictEqual(countItems(bot, 'cobblestone'), 0)
    assert.notStrictEqual(bot.blockAt(chest.offset(0, 1, 0))?.name, 'stone')
  })

  /** solid stone round the origin (a mine), with a two-high tunnel along +x from it, `length` long */
  async function mine (length: number): Promise<void> {
    await run(`fill ${xyz(at(-6, -1, -6))} ${xyz(at(26, 5, 6))} stone`)
    await run(`fill ${xyz(at(0, 0, 0))} ${xyz(at(length, 1, 0))} air`)
    await run('kill @e[type=item]')
    await run(`tp ${USERNAME} ${origin.x + 0.5} ${origin.y} ${origin.z + 0.5} -90 0`)
    assert.ok(await waitUntil(bot, () => bot.blockAt(at(1, 2, 0))?.name === 'stone' && bot.blockAt(at(length, 0, 0))?.name === 'air', 100))
  }

  it('puts down a depot chest in a nook off a one-wide tunnel (a chest crafted from the bag\'s logs) and stashes what isn\'t kept in it', async (t) => {
    await mine(10)
    await run(`tp ${USERNAME} ${origin.x + 5.5} ${origin.y} ${origin.z + 0.5} -90 0`)
    // 35 slots: the bag a slot short of its 2 free
    for (const [item, n] of [['cobblestone', 64], ['oak_log', 4], ['crafting_table', 1], ['diamond_pickaxe', 1], ['leather', 5], ['white_wool', 3], ['diamond', 2], ['raw_iron', 28 * 64]] as const) await give(item, n)
    assert.strictEqual(emptySlots(bot), 1)
    const lines: string[] = []
    const executor = new Executor(bot, { log: line => { lines.push(line); t.diagnostic(line) }, stocked: () => false })
    await executor.makeRoom()
    const depots = bot.survival.memory.getPois(DEPOT_POI)
    assert.strictEqual(depots.length, 1, lines.join(' | '))
    const d = depots[0]
    assert.strictEqual(bot.blockAt(new Vec3(d.x, d.y, d.z))?.name, 'chest')
    // in the wall beside the tunnel, not in it
    assert.notStrictEqual(d.z, origin.z)
    const inChest = parseItems(await run(`data get block ${d.x} ${d.y} ${d.z} Items`))
    assert.deepStrictEqual(inChest, bot.survival.memory.chestAt(d)?.items, 'the memory has what the chest holds')
    assert.ok((inChest.raw_iron ?? 0) >= 20 * 64, JSON.stringify(inChest))
    assert.ok(emptySlots(bot) >= 2, `${emptySlots(bot)} slots free`)
    // (and what digging the nook dropped)
    assert.ok(countItems(bot, 'cobblestone') >= 64)
    assert.strictEqual(countItems(bot, 'diamond_pickaxe'), 1)
  })

  it('a full bag in the nether milestone: the depot takes the iron, the junk is thrown, the obsidian, the buckets and the gold stay (milestoneNeeds)', async (t) => {
    await mine(10)
    await run(`tp ${USERNAME} ${origin.x + 5.5} ${origin.y} ${origin.z + 0.5} -90 0`)
    // 35 slots: the bag a slot short of its 2 free (26.3 run full-26.3-j: '1 furnace, 6 obsidian, 2 raw_iron, 2
    // chicken, 1 oak_door, 2 raw_gold' stashed in a depot by a diamond, and the frame had no obsidian)
    for (const [item, n] of [['diamond_pickaxe', 1], ['obsidian', 6], ['bucket', 2], ['water_bucket', 1], ['lava_bucket', 1], ['flint_and_steel', 1], ['raw_gold', 2], ['oak_log', 4], ['crafting_table', 1], ['cobblestone', 64], ['dirt', 64], ['furnace', 1], ['raw_iron', 23 * 64]] as const) await give(item, n)
    assert.strictEqual(emptySlots(bot), 1)
    const lines: string[] = []
    const nether = milestone('nether')
    let executor: Executor | null = null
    const needs = (): Record<string, number> => {
      const state = progressState(bot, bot.survival.memory)
      return milestoneNeeds(milestonesAhead(nether, state), state, goals => executor!.plan(goals, state.inventory))
    }
    executor = new Executor(bot, { log: line => { lines.push(line); t.diagnostic(line) }, stocked: () => false, milestoneNeeds: needs })
    await executor.makeRoom()
    const depots = bot.survival.memory.getPois(DEPOT_POI)
    assert.strictEqual(depots.length, 1, lines.join(' | '))
    const d = depots[0]
    const inChest = parseItems(await run(`data get block ${d.x} ${d.y} ${d.z} Items`))
    assert.ok((inChest.raw_iron ?? 0) >= 20 * 64, JSON.stringify(inChest))
    for (const name of ['obsidian', 'bucket', 'water_bucket', 'lava_bucket', 'flint_and_steel', 'raw_gold']) assert.strictEqual(inChest[name], undefined, `${name} in the depot: ${JSON.stringify(inChest)}`)
    for (const [name, n] of [['obsidian', 6], ['bucket', 2], ['water_bucket', 1], ['lava_bucket', 1], ['flint_and_steel', 1], ['raw_gold', 2], ['diamond_pickaxe', 1]] as const) assert.strictEqual(countItems(bot, name), n, name)
    assert.ok(lines.some(l => /throwing away 64 dirt/.test(l)), lines.join(' | '))
    assert.ok(emptySlots(bot) >= 2, `${emptySlots(bot)} slots free`)
  })

  it('mines 4 diamonds through the stone with a bag nearly full of cobblestone: room made on the way, no inventory full, nothing thrown picked up again', async (t) => {
    await mine(3)
    // the ores in the rock ahead, off the tunnel's line
    const ores = [at(7, 0, 1), at(11, 1, -1), at(15, 0, 0), at(19, 0, 1)]
    for (const o of ores) await setblock(o, 'diamond_ore')
    // 34 slots: 31 stacks of cobblestone, the 2 free the executor keeps (the room before the step makes none)
    for (const [item, n] of [['cobblestone', 31 * 64], ['diamond_pickaxe', 1], ['bread', 16], ['torch', 32]] as const) await give(item, n)
    assert.strictEqual(emptySlots(bot), 2)
    const lines: string[] = []
    let recollected = 0
    const onCollect = (collector: any, collected: any): void => {
      if (collector === bot.entity && isThrownDrop(bot, collected)) {
        recollected++
        t.diagnostic(`picked up again: ${collected.id} at ${collected.position.toString()}, the bot at ${bot.entity.position.toString()}`)
      }
    }
    bot.on('playerCollect', onCollect)
    const executor = new Executor(bot, { log: line => { lines.push(line); t.diagnostic(line) } })
    const start = bot.survival.tasks.tick
    try {
      await executor.obtain([{ item: 'diamond', count: 4 }])
    } finally {
      bot.off('playerCollect', onCollect)
    }
    t.diagnostic(`4 diamonds in ${bot.survival.tasks.tick - start} ticks, ${countItems(bot, 'cobblestone')} cobblestone carried, ${emptySlots(bot)} slots free`)
    assert.ok(countItems(bot, 'diamond') >= 4)
    assert.ok(!lines.some(l => /inventory full|INVENTORY_FULL|NO_SPACE/.test(l)), lines.filter(l => /full|NO_SPACE/.test(l)).join(' | '))
    assert.ok(lines.some(l => /throwing away/.test(l)), 'no room made')
    assert.strictEqual(recollected, 0, 'thrown items picked up again')
  })

  it('throws what it doesn\'t want into the lava in reach, where it burns, and makes more room then', async (t) => {
    await run(`fill ${xyz(at(-4, -4, -7))} ${xyz(at(10, -1, 7))} stone`)
    await run(`fill ${xyz(at(-4, 0, -7))} ${xyz(at(10, 5, 7))} air`)
    // a pool of lava a block down, 2 to 4 blocks off the bot's rim
    await run(`fill ${xyz(at(2, -1, -2))} ${xyz(at(4, -1, 2))} lava`)
    await run('kill @e[type=item]')
    await run(`tp ${USERNAME} ${origin.x + 0.5} ${origin.y} ${origin.z + 0.5} 90 0`)
    assert.ok(await waitUntil(bot, () => bot.blockAt(at(3, -1, 0))?.name === 'lava', 100))
    for (const [item, n] of [['diamond_pickaxe', 1], ['cobblestone', 33 * 64], ['diorite', 64]] as const) await give(item, n)
    assert.strictEqual(emptySlots(bot), 1)
    const lines: string[] = []
    const executor = new Executor(bot, { log: line => { lines.push(line); t.diagnostic(line) } })
    await executor.task('make room by the lava', async (s) => await executor.makeRoomDuringStep(s))
    // the room made and more (LAVA_ROOM), the thrown stacks burnt up
    assert.ok(emptySlots(bot) >= 2 + 2 + LAVA_ROOM - 1, `${emptySlots(bot)} slots free: ${lines.join(' | ')}`)
    await waitTicks(bot, 40)
    const items = Object.values(bot.entities).filter(e => e.name === 'item' && e.position.distanceTo(bot.entity.position) < 16)
    assert.deepStrictEqual(items.map(e => e.position.toString()), [], 'thrown items left lying')
    // the rim's floor as it was: no pit dug
    assert.strictEqual(bot.blockAt(at(0, -1, 1))?.name, 'stone')
    assert.strictEqual(bot.blockAt(at(0, -1, -1))?.name, 'stone')
  })

  it('makes the enchanting table\'s obsidian from a deep lava lake through the rock with a bag nearly full of the route\'s stone: room made on the way, no inventory full, nothing thrown picked up again', async (t) => {
    // (26.3 whole game: obsidianFromLava by the deep lakes failed its pickups 'the inventory is full' over and over,
    // the bag full of the walk's cobblestone, diorite, andesite and granite)
    await run(`fill ${xyz(at(-4, -4, -7))} ${xyz(at(24, 5, 7))} stone`)
    // the bot in a pocket in the rock; the lake in a cave 12 blocks along +x at the bottom of the world, under a rim
    // open over it (no shore at its level), andesite and diorite in the rock between
    await run(`fill ${xyz(at(0, 0, 0))} ${xyz(at(0, 1, 0))} air`)
    await run(`fill ${xyz(at(4, -1, -2))} ${xyz(at(10, 2, 2))} andesite`)
    await run(`fill ${xyz(at(6, 0, -1))} ${xyz(at(8, 1, 1))} diorite`)
    await run(`fill ${xyz(at(12, 0, -5))} ${xyz(at(21, 3, 5))} air`)
    await run(`fill ${xyz(at(15, -2, -2))} ${xyz(at(18, -2, 1))} lava`)
    await run(`fill ${xyz(at(15, -1, -2))} ${xyz(at(18, -1, 1))} air`)
    await run('kill @e[type=item]')
    await run(`tp ${USERNAME} ${origin.x + 0.5} ${origin.y} ${origin.z + 0.5} -90 0`)
    assert.ok(await waitUntil(bot, () => bot.blockAt(at(15, -2, -2))?.name === 'lava' && bot.blockAt(at(5, 0, 0))?.name === 'andesite', 200))
    // 34 slots: the tools and 31 stacks of the route's stone, the 2 free the executor keeps
    for (const [item, n] of [['diamond_pickaxe', 1], ['water_bucket', 1], ['bucket', 1], ['cobblestone', 28 * 64], ['diorite', 64], ['andesite', 64], ['granite', 64]] as const) await give(item, n)
    assert.strictEqual(emptySlots(bot), 2)
    const lines: string[] = []
    const traced: string[] = []
    let recollected = 0
    const onCollect = (collector: any, collected: any): void => {
      if (collector === bot.entity && isThrownDrop(bot, collected)) {
        recollected++
        t.diagnostic(`picked up again: ${collected.id} at ${collected.position.toString()}, the bot at ${bot.entity.position.toString()}`)
      }
    }
    // the skills' trace (SURVIVAL_DEBUG): the pickups' NO_SPACE is caught and traced by obsidianFromLava
    const debug = process.env.SURVIVAL_DEBUG
    const error = console.error
    process.env.SURVIVAL_DEBUG = '1'
    console.error = (...args: unknown[]) => { traced.push(args.map(String).join(' ')) }
    bot.on('playerCollect', onCollect)
    const executor = new Executor(bot, { log: line => { lines.push(line); t.diagnostic(line) } })
    const start = bot.survival.tasks.tick
    let made = false
    try {
      made = await obsidianFromPools(bot, executor, TABLE_OBSIDIAN, new AbortController().signal, line => { lines.push(line); t.diagnostic(line) })
    } finally {
      bot.off('playerCollect', onCollect)
      console.error = error
      if (debug == null) delete process.env.SURVIVAL_DEBUG
      else process.env.SURVIVAL_DEBUG = debug
    }
    for (const l of traced) if (/obsidianFromLava|pedestal|tossAway|navigate:|collectBlock: broke|pickupDrops/.test(l)) t.diagnostic(l)
    const full = [...lines, ...traced].filter(l => /inventory (is )?full|INVENTORY_FULL|NO_SPACE/.test(l))
    t.diagnostic(`${countItems(bot, 'obsidian')} obsidian in ${bot.survival.tasks.tick - start} ticks, ${emptySlots(bot)} slots free; ${traced.filter(l => /tossAway/.test(l)).join(' | ')}`)
    assert.ok(made && countItems(bot, 'obsidian') >= TABLE_OBSIDIAN, `${countItems(bot, 'obsidian')} obsidian`)
    assert.deepStrictEqual(full, [])
    assert.ok(lines.some(l => /throwing away/.test(l)), 'no room made')
    assert.strictEqual(recollected, 0, 'thrown items picked up again')
  })


  /** a stone mound 40 long along +x and `height` high, the air over it cleared, the bot on top facing +x (a staircase goes along the facing) */
  async function mound (height: number): Promise<void> {
    await run(`fill ${xyz(at(-4, 0, -4))} ${xyz(at(36, height - 1, 4))} stone`)
    await run(`fill ${xyz(at(-4, height, -4))} ${xyz(at(36, height + 4, 4))} air`)
    await run('kill @e[type=item]')
    await run(`tp ${USERNAME} ${origin.x + 0.5} ${origin.y + height} ${origin.z + 0.5} -90 0`)
    assert.ok(await waitUntil(bot, () => bot.entity.position.distanceTo(origin.offset(0.5, height, 0.5)) < 0.5 && bot.blockAt(at(0, height - 1, 0))?.name === 'stone', 200))
  }

  /** the blocks the bot stood on (a staircase's floors), and the blocks broken near it, while `fn` runs */
  async function watchSteps<T> (fn: () => Promise<T>): Promise<{ result: T, floors: Vec3[], broken: Vec3[] }> {
    const floors: Vec3[] = []
    const broken: Vec3[] = []
    const onMove = (): void => {
      const under = bot.entity.position.floored().offset(0, -1, 0)
      if (bot.entity.onGround && bot.blockAt(under)?.boundingBox === 'block' && !floors.some(f => f.equals(under))) floors.push(under)
    }
    const onBlock = (old: any, now: any): void => {
      if (old?.boundingBox === 'block' && now?.boundingBox === 'empty' && now.position.distanceTo(bot.entity.position) < 6) broken.push(now.position.clone())
    }
    bot.on('physicsTick', onMove)
    bot.on('blockUpdate', onBlock)
    try {
      return { result: await fn(), floors, broken }
    } finally {
      bot.off('physicsTick', onMove)
      bot.off('blockUpdate', onBlock)
    }
  }

  it('walks a staircase\'s steps straight in: 3 blocks dug a step, none under the bot, every step\'s floor left whole', async (t) => {
    // (26.3 run full-f: the pathfinder's way into each step broke the floor under the bot and walked in level, a block
    // more to dig each step: 220 ticks a step by hand, 70 without)
    const height = 20
    await mound(height)
    await run(`clear ${USERNAME}`)
    await give('diamond_pickaxe', 1)
    const executor = new Executor(bot, { log: line => t.diagnostic(line) })
    const start = bot.survival.tasks.tick
    const { result, floors, broken } = await watchSteps(async () => await executor.task('down the staircase', async (s) => await descendTo(bot, origin.y + 3, {}, s)))
    const steps = origin.y + height - (origin.y + 3)
    t.diagnostic(`${steps} steps in ${bot.survival.tasks.tick - start} ticks, ${broken.length} blocks broken`)
    assert.strictEqual(result, true)
    assert.ok(broken.length <= 3 * steps, `${broken.length} blocks broken for ${steps} steps`)
    assert.deepStrictEqual(floors.filter(f => bot.blockAt(f)?.boundingBox !== 'block').map(f => f.toString()), [])
    assert.ok(floors.length >= steps, `${floors.length} floors stood on`)
  })

  it('digs a staircase down a stone mound with a bag nearly full of the route\'s stone and junk: what it throws goes into pits beside the stairs under the next steps\' reach, none picked up again, no throw twice, the steps left whole', async (t) => {
    // (26.3 run full-f: the staircase to the deep lava threw 19 dirt, 5 sand and 2 gravel into a pit at its side a
    // block under the floor and picked them up with its next step, a block lower, 30 steps running)
    const height = 30
    await mound(height)
    await run(`clear ${USERNAME}`)
    // 34 slots: the pickaxe, the food, the junk and the route's stone, 2 free; a stack of cobblestone 4 short of full
    for (const [item, n] of [['diamond_pickaxe', 1], ['bread', 16], ['dirt', 19], ['sand', 5], ['gravel', 2], ['granite', 12], ['andesite', 29], ['diorite', 40], ['cobblestone', 26 * 64 - 4]] as const) await give(item, n)
    assert.strictEqual(emptySlots(bot), 2)
    const lines: string[] = []
    let recollected = 0
    const onCollect = (collector: any, collected: any): void => {
      if (collector === bot.entity && isThrownDrop(bot, collected)) {
        recollected++
        t.diagnostic(`picked up again: ${collected.id} at ${collected.position.toString()}, the bot at ${bot.entity.position.toString()}`)
      }
    }
    bot.on('playerCollect', onCollect)
    const executor = new Executor(bot, { log: line => { lines.push(line); t.diagnostic(line) } })
    const start = bot.survival.tasks.tick
    let steps
    try {
      steps = await watchSteps(async () => await executor.task('down the staircase', async (s) => await descendTo(bot, origin.y + 3, {}, s)))
    } finally {
      bot.off('playerCollect', onCollect)
    }
    const throws = lines.filter(l => /throwing away/.test(l))
    t.diagnostic(`down to ${bot.entity.position.floored().toString()} in ${bot.survival.tasks.tick - start} ticks, ${throws.length} throws, ${emptySlots(bot)} slots free`)
    assert.strictEqual(steps.result, true, lines.join(' | '))
    assert.ok(throws.length >= 1, 'no room made')
    assert.strictEqual(recollected, 0, 'thrown items picked up again')
    // each stack thrown once: none came back to be thrown again
    const stacks = throws.flatMap(l => l.replace(/^.*throwing away /, '').split(', ')).filter(s => !/^64 /.test(s))
    assert.deepStrictEqual(stacks.filter((s, i) => stacks.indexOf(s) !== i), [], throws.join(' | '))
    assert.ok(!lines.some(l => /making room loops/.test(l)), lines.join(' | '))
    // the way back up whole: the pits beside it, not in it
    assert.deepStrictEqual(steps.floors.filter(f => bot.blockAt(f)?.boundingBox !== 'block').map(f => f.toString()), [])
    assert.ok(emptySlots(bot) >= 2, `${emptySlots(bot)} slots free`)
  })

  it('puts a stack that keeps coming back into the chest near rather than throw it a third time (a pocket in the obsidian with nowhere to throw)', async (t) => {
    // (26.3 run full-f: the same stacks thrown every step of a staircase and picked up again)
    await run(`fill ${xyz(at(-2, -1, -2))} ${xyz(at(2, 3, 2))} obsidian`)
    await run(`fill ${xyz(at(0, 0, 0))} ${xyz(at(0, 1, 0))} air`)
    // a chest in the wall, opening into the cell over it (ChestBlock.isChestBlockedAt)
    const chest = at(1, 0, 0)
    await setblock(chest, 'chest[facing=west]')
    await setblock(chest.offset(0, 1, 0), 'air')
    await run('kill @e[type=item]')
    await run(`tp ${USERNAME} ${origin.x + 0.5} ${origin.y} ${origin.z + 0.5} -90 0`)
    assert.ok(await waitUntil(bot, () => bot.entity.position.distanceTo(origin.offset(0.5, 0, 0.5)) < 0.2 && bot.blockAt(at(0, 2, 0))?.name === 'obsidian', 100))
    // 35 slots: the food and the pickaxe kept, the junk; 1 free
    for (const [item, n] of [['cooked_beef', 30 * 64], ['diamond_pickaxe', 1], ['bread', 16], ['rotten_flesh', 7], ['string', 5], ['bone', 3]] as const) await give(item, n)
    assert.strictEqual(emptySlots(bot), 1)
    const lines: string[] = []
    const executor = new Executor(bot, { log: line => { lines.push(line); t.diagnostic(line) } })
    executor.memory.rememberChest(chest, {})
    // the room made the way a dug route makes it, once a step: what's thrown at the walls falls at the bot's feet and is
    // picked up again once its 40 ticks are up
    for (let step = 0; step < 4 && countItems(bot, 'rotten_flesh') > 0; step++) {
      await executor.task('a step', async (s) => await executor.makeRoomDuringStep(s))
      await waitTicks(bot, 60)
    }
    const throws = lines.filter(l => /throwing away/.test(l))
    t.diagnostic(`${throws.length} throws, ${emptySlots(bot)} slots free`)
    assert.ok(lines.some(l => /making room loops: .*7 rotten_flesh/.test(l)), lines.join(' | '))
    assert.strictEqual(throws.length, 2, throws.join(' | '))
    const inChest = parseItems(await run(`data get block ${xyz(chest)} Items`))
    assert.strictEqual(inChest.rotten_flesh, 7, JSON.stringify(inChest))
    assert.strictEqual(countItems(bot, 'rotten_flesh'), 0)
    assert.ok(emptySlots(bot) >= 2, `${emptySlots(bot)} slots free`)
  })
})
