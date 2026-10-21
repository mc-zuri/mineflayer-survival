import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Vec3 } from 'vec3'
import { TaskRunner } from '../../src/core/taskRunner'
import { TaskError } from '../../src/core/errors'
import { WorldMemory } from '../../src/core/memory'
import { Runner, deathSpotWorthIt, progressState, tickLine, type MilestoneHandler } from '../../src/runner'
import { dropsWorthATrip } from '../../src/executor/keep'

/* eslint-disable @typescript-eslint/no-var-requires */
const registry = require('minecraft-data')('1.21.11')

function fakeBot (items: Record<string, number> = {}): any {
  const bot: any = new EventEmitter()
  bot.registry = registry
  const counts = new Map(Object.entries(items))
  const slots = (): any[] => {
    const out: any[] = new Array(46).fill(null)
    let i = 9
    for (const [name, count] of counts) if (count > 0) out[i++] = { name, count, type: registry.itemsByName[name].id, slot: i - 1 }
    return out
  }
  bot.inventory = { get slots () { return slots() }, inventoryStart: 9, inventoryEnd: 45, items: () => slots().slice(9, 45).filter(s => s != null) }
  bot.give = (name: string, n: number) => counts.set(name, (counts.get(name) ?? 0) + n)
  bot.entity = { position: new Vec3(0, 64, 0) }
  bot.game = { dimension: 'overworld' }
  bot.health = 20
  bot.time = { timeOfDay: 1000 }
  bot.isRaining = false
  bot.survival = { memory: new WorldMemory(), tasks: new TaskRunner(bot), handlers: {}, advancements: new Set() }
  return bot
}

test('play works the milestones in order, an event for each reached, and stops before the one stopAt names', async () => {
  const bot = fakeBot()
  const worked: string[] = []
  const events: string[] = []
  bot.on('survivalMilestone', (e: any) => events.push(e.id))
  const give = (items: Record<string, number>): MilestoneHandler => async ({ milestone }) => {
    worked.push(milestone.id)
    for (const [n, c] of Object.entries(items)) bot.give(n, c)
  }
  const enchantedPick = { done: false }
  const handlers = {
    wood: give({ wooden_pickaxe: 1, crafting_table: 1 }),
    stone: give({ stone_pickaxe: 1, stone_sword: 1, stone_axe: 1, stone_shovel: 1, furnace: 1 }),
    food: give({ cooked_beef: 8 }),
    base: async () => { worked.push('base'); bot.survival.memory.setBase({ x: 0, y: 40, z: 0 }) },
    iron: give({ iron_pickaxe: 1, iron_sword: 1, iron_helmet: 1, iron_chestplate: 1, iron_leggings: 1, iron_boots: 1, shield: 1, bucket: 1 }),
    diamonds: give({ diamond_pickaxe: 1, diamond_sword: 1 }),
    enchanting: async () => { worked.push('enchanting'); bot.survival.memory.addPoi('enchanting_table', { x: 1, y: 40, z: 1 }); enchantedPick.done = true }
  }
  const runner = new Runner(bot, { handlers, stopAt: 'nether', log: () => {} })
  // the enchanted check reads item.enchants: the fake's pickaxe gets one once the handler ran
  const items = bot.inventory.items
  // (and the iron armor: the milestone's done asks for it enchanted too)
  bot.inventory.items = () => items().map((i: any) => /^(diamond_pickaxe|iron_(helmet|chestplate|leggings))$/.test(i.name) && enchantedPick.done ? { ...i, enchants: [{ name: 'efficiency', lvl: 1 }] } : i)
  const result = await runner.play()
  assert.deepEqual(worked, ['wood', 'stone', 'food', 'base', 'iron', 'diamonds', 'enchanting'])
  assert.equal(result.reason, 'until')
  assert.equal(result.stoppedAt, 'nether')
  assert.deepEqual(events, ['wood', 'stone', 'food', 'base', 'iron', 'diamonds', 'enchanting'])
  assert.deepEqual(result.reached.map(r => r.id), events)
})

test('until and skip; a milestone failing five times stops play; the save file resumes the run', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-test-'))
  const saveFile = path.join(dir, 'save.json')
  const bot = fakeBot()
  const runner = new Runner(bot, {
    until: 'stone',
    saveFile,
    log: () => {},
    handlers: {
      wood: async () => { bot.give('wooden_pickaxe', 1); bot.give('crafting_table', 1) },
      stone: async () => { bot.give('stone_pickaxe', 1); bot.give('stone_sword', 1); bot.give('stone_axe', 1); bot.give('stone_shovel', 1); bot.give('furnace', 1) }
    }
  })
  bot.survival.memory.rememberBlock('iron_ore', { x: 3, y: 12, z: 4 })
  const result = await runner.play()
  assert.equal(result.reason, 'until')
  assert.deepEqual(result.reached.map(r => r.id), ['wood', 'stone'])
  const saved = JSON.parse(fs.readFileSync(saveFile, 'utf8'))
  assert.deepEqual(saved.reached.map((r: any) => r.id), ['wood', 'stone'])
  assert.equal(saved.memory.blocks[0].name, 'iron_ore')

  // a new run from the file: the memory and the milestones come back
  const bot2 = fakeBot({ wooden_pickaxe: 1, crafting_table: 1, stone_pickaxe: 1, stone_sword: 1, stone_axe: 1, stone_shovel: 1, furnace: 1 })
  let tries = 0
  const runner2 = new Runner(bot2, { saveFile, skip: ['food'], log: () => {}, handlers: { base: async () => { tries++; throw new TaskError('NO_PATH', 'no way to the site') } } })
  const result2 = await runner2.play()
  assert.equal(bot2.survival.memory.findBlocks('iron_ore').length, 1)
  assert.equal(tries, 5)
  assert.equal(result2.reason, 'failed')
  assert.equal(result2.stoppedAt, 'base')
  assert.deepEqual(result2.reached.map(r => r.id), ['wood', 'stone'])
})

test('a save store (a browser\'s localStorage, no fs) saves and resumes the run as a save file does', async () => {
  let saved: string | null = null
  const store = { name: 'localStorage', read: () => saved, write: (json: string) => { saved = json } }
  const bot = fakeBot()
  const runner = new Runner(bot, {
    until: 'wood',
    saveStore: store,
    log: () => {},
    handlers: { wood: async () => { bot.give('wooden_pickaxe', 1); bot.give('crafting_table', 1) } }
  })
  bot.survival.memory.rememberBlock('iron_ore', { x: 3, y: 12, z: 4 })
  await runner.play()
  assert.notEqual(saved, null)
  assert.deepEqual(JSON.parse(saved as unknown as string).reached.map((r: any) => r.id), ['wood'])

  const lines: string[] = []
  const bot2 = fakeBot({ wooden_pickaxe: 1, crafting_table: 1 })
  const runner2 = new Runner(bot2, { until: 'wood', saveStore: store, log: line => lines.push(line) })
  const result2 = await runner2.play()
  assert.deepEqual(result2.reached.map(r => r.id), ['wood'])
  assert.equal(bot2.survival.memory.findBlocks('iron_ore').length, 1)
  assert.ok(lines.some(l => l.startsWith('resumed from localStorage')), lines.join('\n'))
})

test('progressState: worn armor and the base\'s stations count', () => {
  const bot = fakeBot({ iron_pickaxe: 1 })
  bot.survival.memory.setBase({ x: 0, y: 40, z: 0 })
  bot.survival.memory.addPoi('base_crafting_table', { x: 1, y: 40, z: 0 })
  const s = progressState(bot, bot.survival.memory)
  assert.deepEqual(s.stations, ['crafting_table'])
  assert.equal(s.inventory.count('iron_pickaxe'), 1)
})

test('the death spot is worth going back to only while the items last and away from lava', () => {
  const air = (): { name: string } => ({ name: 'air' })
  const now = { tick: 2000, dimension: 'overworld', position: new Vec3(0, 64, 0), minY: -64, blockAt: air }
  const death = { x: 100, y: 64, z: 0, dimension: 'overworld', seen: 1000 }
  assert.equal(deathSpotWorthIt(death, now, 6000), true)
  // too long ago, or too far to get there in time
  assert.equal(deathSpotWorthIt({ ...death, seen: -5000 }, now, 6000), false)
  assert.equal(deathSpotWorthIt({ ...death, x: 1100 }, now, 6000), false)
  // in lava, in the void, in another dimension
  assert.equal(deathSpotWorthIt(death, { ...now, blockAt: (p: Vec3) => ({ name: p.y === 64 ? 'lava' : 'air' }) }, 6000), false)
  assert.equal(deathSpotWorthIt({ ...death, y: -70 }, now, 6000), false)
  assert.equal(deathSpotWorthIt({ ...death, dimension: 'the_nether' }, now, 6000), false)
  assert.equal(deathSpotWorthIt(null, now, 6000), false)
  // a death under a roof (a cave, a mine) is left for the mobs there
  assert.equal(deathSpotWorthIt({ ...death, underground: true }, now, 6000), false)
  assert.equal(deathSpotWorthIt({ ...death, underground: false }, now, 6000), true)
  // nothing dropped worth the trip (8 dirt and 2 leaf litter shot off a bare bot by a pillager patrol, 26.3)
  assert.equal(deathSpotWorthIt({ ...death, worth: false }, now, 6000), false)
  assert.equal(deathSpotWorthIt({ ...death, worth: true }, now, 6000), true)
})

test('dropsWorthATrip: gear, ores, food or arrows are; a few blocks of dirt and leaf litter are not', () => {
  const registry = require('minecraft-data')('26.3')
  assert.equal(dropsWorthATrip(['dirt', 'leaf_litter'], registry), false)
  assert.equal(dropsWorthATrip([], registry), false)
  assert.equal(dropsWorthATrip(['dirt', 'stone_pickaxe'], registry), true)
  assert.equal(dropsWorthATrip(['dirt', 'bread'], registry), true)
  assert.equal(dropsWorthATrip(['cobblestone', 'arrow'], registry), true)
  assert.equal(dropsWorthATrip(['raw_iron'], registry), true)
})

test('maxTicks: play stops when its tick budget runs out, the work in hand aborted', async () => {
  const bot = fakeBot()
  let aborted = false
  const runner = new Runner(bot, {
    maxTicks: 50,
    log: () => {},
    handlers: { wood: async ({ signal }) => { await new Promise<void>(resolve => signal.addEventListener('abort', () => { aborted = true; resolve() })) } }
  })
  const result = runner.play()
  for (let i = 0; i < 60; i++) { bot.emit('physicsTick'); await new Promise(resolve => setImmediate(resolve)) }
  const r = await result
  assert.equal(aborted, true)
  assert.equal(r.reason, 'budget')
  assert.equal(r.stoppedAt, 'wood')
})

test('maxTicks: an abort that gets past the loop (a recovery under way when the budget runs out) is a budget stop, not a throw', async () => {
  const bot = fakeBot()
  const runner = new Runner(bot, {
    maxTicks: 50,
    log: () => {},
    handlers: { wood: async () => { throw new TaskError('DIED', 'the bot died') } }
  })
  // the recovery waits out the budget, then throws the abort
  ;(runner as any).recoverFromDeath = async (signal?: AbortSignal) => {
    await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve()))
    throw new TaskError('ABORTED', 'aborted')
  }
  ;(runner as any).recover = (runner as any).recoverFromDeath
  const result = runner.play()
  for (let i = 0; i < 60; i++) { bot.emit('physicsTick'); await new Promise(resolve => setImmediate(resolve)) }
  const r = await result
  assert.equal(r.reason, 'budget')
  assert.equal(r.stoppedAt, 'wood')
})

test('netherNeeds: the rods and pearls still wanted for the eyes', async () => {
  const { netherNeeds } = await import('../../src/milestones')
  const inv = (items: Record<string, number>) => ({ count: (n: string) => items[n] ?? 0 })
  assert.deepEqual(netherNeeds(inv({})), { rods: 8, pearls: 16 })
  assert.deepEqual(netherNeeds(inv({ blaze_rod: 3, ender_pearl: 10, ender_eye: 2 })), { rods: 4, pearls: 4 })
  assert.deepEqual(netherNeeds(inv({ ender_eye: 16 })), { rods: 0, pearls: 0 })
})

test('a death spot the bot died at again going back for its items is left for good, and so is a death near it', async () => {
  const bot = fakeBot()
  bot.waitForTicks = async () => {}
  bot.blockAt = () => ({ name: 'air' })
  const logs: string[] = []
  const runner = new Runner(bot, { log: (l: string) => logs.push(l) })
  const memory = (runner as any).memory as WorldMemory
  memory.setDeath(new Vec3(20, 13, 0), 'overworld')
  const trips: string[] = []
  ;(runner as any).executor.task = async (name: string) => {
    trips.push(name)
    // killed again in the cave on the way: the new death a few blocks from the first
    memory.setDeath(new Vec3(24, 15, 3), 'overworld')
    throw new TaskError('DIED', 'the bot died')
  }
  // (the re-equipping after it is another test's)
  ;(runner as any).executor.obtain = async () => {}
  await runner.recoverFromDeath()
  assert.deepEqual(trips, ['to the death spot'])
  assert.ok(logs.some(l => /not back to the death spot at 24 15 3/.test(l)), logs.join('\n'))
})

test('the default log puts the game tick in front of each line', async () => {
  assert.equal(tickLine(1234, 'plan 1: mine 3 oak_log'), '[survival] t1234 plan 1: mine 3 oak_log')
  const bot = fakeBot({ wooden_pickaxe: 1, crafting_table: 1 })
  const lines: string[] = []
  const log = console.log
  console.log = (line: string) => { lines.push(line) }
  try {
    await new Runner(bot, { until: 'wood' }).play()
  } finally {
    console.log = log
  }
  assert.ok(lines.some(l => /^\[survival\] t\d+ milestone wood reached/.test(l)), lines.join('\n'))
})

test('a death after the iron: the milestones reached stay reached, the food is got back and the diamonds go on', async () => {
  const bot = fakeBot()
  bot.waitForTicks = async () => {}
  const worked: string[] = []
  const lines: string[] = []
  const give = (items: Record<string, number>): MilestoneHandler => async ({ milestone }) => {
    worked.push(milestone.id)
    for (const [n, c] of Object.entries(items)) bot.give(n, c)
  }
  let died = false
  const handlers = {
    wood: give({ wooden_pickaxe: 1, crafting_table: 1 }),
    stone: give({ stone_pickaxe: 1, stone_sword: 1, stone_axe: 1, stone_shovel: 1, furnace: 1 }),
    food: give({ cooked_beef: 8 }),
    iron: give({ iron_pickaxe: 1, iron_sword: 1, iron_helmet: 1, iron_chestplate: 1, iron_leggings: 1, iron_boots: 1, shield: 1, bucket: 1 }),
    diamonds: async () => {
      worked.push('diamonds')
      if (!died) {
        // dies down the mine: everything is gone, the respawn has nothing
        died = true
        for (const i of bot.inventory.items()) bot.give(i.name, -i.count)
        throw new TaskError('DIED', 'the bot died')
      }
      bot.give('diamond_pickaxe', 1)
      bot.give('diamond_sword', 1)
    }
  }
  // the food comes back through the executor's plan: a hunt and a smelt that do what they say
  const runners = {
    kill: async (step: any) => { bot.give(step.item, step.count); return { gained: step.count } },
    mine: async (step: any) => { bot.give(step.item, step.count); return { gained: step.count } },
    craft: async (step: any) => { for (const i of step.ingredients) bot.give(i.name, -i.count); bot.give(step.item, step.count); return { gained: step.count } },
    smelt: async (step: any) => { for (const i of [...step.inputs, ...step.fuel]) bot.give(i.name, -i.count); bot.give(step.item, step.count); return { gained: step.count } }
  }
  const runner = new Runner(bot, { handlers, until: 'diamonds', skip: ['base'], log: l => lines.push(l), executor: { runners, log: () => {} } })
  const result = await runner.play()
  assert.equal(result.reason, 'until')
  assert.deepEqual(worked, ['wood', 'stone', 'food', 'iron', 'diamonds', 'diamonds'])
  assert.ok(lines.some(l => /food low \(0 points\)/.test(l)), lines.join('\n'))
  assert.ok(progressState(bot, bot.survival.memory).inventory.foodPoints() >= 20)
  assert.deepEqual(result.reached.map(r => r.id), ['wood', 'stone', 'food', 'iron', 'diamonds'])
})

test('at night with a pickaxe and no bed the runner mines the night: the iron down there, once a night, the reflex left out', async () => {
  const bot = fakeBot({ stone_pickaxe: 1, stone_sword: 1, torch: 20, crafting_table: 1, furnace: 1, cooked_beef: 8, shield: 1, oak_log: 4, coal: 5 })
  bot.time = { timeOfDay: 13000, day: 1 }
  bot.findBlock = () => null
  const lines: string[] = []
  const mined: string[] = []
  let nightWork: boolean | undefined
  const runners = {
    mine: async (step: any) => { nightWork = bot.survival.nightWork; mined.push(`${step.item} ${String(step.block)}`); bot.give(step.item, step.count); return { gained: step.count } }
  }
  const runner = new Runner(bot, { log: l => lines.push(l), executor: { runners, log: () => {} } })
  runner.reached.push({ id: 'wood', title: '', tick: 0, wallMs: 0 }, { id: 'stone', title: '', tick: 0, wallMs: 0 }, { id: 'food', title: '', tick: 0, wallMs: 0 })
  await runner.nightSchedule()
  assert.ok(lines.some(l => /down the mine for 33 raw_iron/.test(l)), lines.join('\n'))
  assert.deepEqual(mined, ['raw_iron iron_ore'])
  assert.equal(nightWork, true)
  assert.equal(bot.survival.nightWork, false)
  // once a night
  await runner.nightSchedule()
  assert.equal(mined.length, 1)
  // by day, or with a bed to sleep in, no mining
  const day = new Runner(bot, { log: () => {}, executor: { runners, log: () => {} } })
  bot.time = { timeOfDay: 6000, day: 2 }
  await day.nightSchedule()
  bot.time = { timeOfDay: 13000, day: 2 }
  bot.give('white_bed', 1)
  await day.nightSchedule()
  assert.equal(mined.length, 1)
})

test('at night with a bed in the bag the runner sleeps on the surface; below it, down a staircase, the night is work', async () => {
  const bot = fakeBot({ stone_pickaxe: 1, white_bed: 1 })
  bot.time = { timeOfDay: 13000, day: 1 }
  bot.findBlock = () => null
  const block = (name: string, p: Vec3): any => ({ name, position: p, boundingBox: name === 'air' ? 'empty' : 'block' })
  // a 1-wide staircase along +x through stone to y 80, the step at x with its feet at 75 - x
  bot.blockAt = (p: Vec3) => { const q = p.floored(); return block(q.z === 0 && q.x >= 0 && q.x <= 20 && q.y >= 75 - q.x && q.y <= 77 - q.x ? 'air' : q.y < 80 ? 'stone' : 'air', q) }
  bot.entity.position = new Vec3(10.5, 65, 0.5)
  const lines: string[] = []
  const runner = new Runner(bot, { log: l => lines.push(l), executor: { log: () => {} } })
  await runner.nightCheck()
  assert.deepEqual(lines, [])
  // on the surface: the bed
  bot.entity.position = new Vec3(30.5, 80, 0.5)
  await runner.nightCheck().catch(() => {})
  assert.ok(lines.some(l => /sleeping/.test(l)), lines.join(' | '))
})

test('the reflexes that fire are logged, a run of the same one counted', async () => {
  const bot = fakeBot()
  const lines: string[] = []
  const runner = new Runner(bot, {
    log: l => lines.push(l),
    until: 'wood',
    handlers: {
      wood: async () => {
        for (let i = 0; i < 5; i++) bot.emit('reflex', 'drowning')
        bot.emit('reflex', 'eat')
        bot.emit('reflex', 'fall', 'water at (0, 60, 0)')
        bot.give('wooden_pickaxe', 1)
        bot.give('crafting_table', 1)
      }
    }
  })
  await runner.play()
  assert.deepEqual(lines.filter(l => l.startsWith('reflex')), ['reflex drowning', 'reflex drowning 4 times more', 'reflex eat', 'reflex fall (water at (0, 60, 0)) at 0.0 64.0 0.0'])
})

test('the death messages are told from the other system lines about the bot', async () => {
  const { isDeathMessage } = await import('../../src/runner')
  assert.equal(isDeathMessage('miner fell from a high place'), true)
  assert.equal(isDeathMessage('miner was slain by Zombie'), true)
  assert.equal(isDeathMessage('miner has made the advancement [Stone Age]'), false)
  assert.equal(isDeathMessage('miner joined the game'), false)
})

test('dusk cuts the day\'s work off for the night\'s mine, and the milestone goes on after', async () => {
  const bot = fakeBot({ wooden_pickaxe: 1, crafting_table: 1, stone_pickaxe: 1, stone_sword: 1, stone_axe: 1, stone_shovel: 1, furnace: 1, torch: 20, cooked_beef: 8, shield: 1, oak_log: 4, coal: 5 })
  bot.time = { timeOfDay: 11000, day: 0 }
  bot.findBlock = () => null
  const mined: string[] = []
  const runners = { mine: async (step: any) => { mined.push(step.item); bot.give(step.item, step.count); return { gained: step.count } } }
  let calls = 0
  const lines: string[] = []
  const runner = new Runner(bot, {
    log: l => lines.push(l),
    until: 'iron',
    skip: ['base'],
    executor: { runners, log: () => {} },
    handlers: {
      iron: async ({ signal }) => {
        calls++
        if (calls === 1) {
          // a hunt that runs on past dusk
          await new Promise<void>((resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason))
          })
        }
        for (const n of ['iron_pickaxe', 'iron_sword', 'iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots', 'shield', 'bucket']) bot.give(n, 1)
      }
    }
  })
  runner.reached.push(...['wood', 'stone', 'food'].map(id => ({ id: id as any, title: '', tick: 0, wallMs: 0 })))
  const result = runner.play()
  for (let i = 0; i < 400 && calls === 0; i++) await new Promise(resolve => setImmediate(resolve))
  bot.time = { timeOfDay: 11600, day: 0 }
  for (let i = 0; i < 40; i++) { bot.emit('physicsTick'); await new Promise(resolve => setImmediate(resolve)) }
  const r = await result
  assert.equal(r.reason, 'until')
  assert.equal(calls, 2)
  assert.ok(lines.some(l => /dusk: iron left for the night's mine/.test(l)), lines.join('\n'))
  assert.deepEqual(mined, ['raw_iron'])
})

test('a night down the mine with no wood carried cuts a few logs first, for its torches and tools', async () => {
  const { woodCarried, DUSK_LOGS } = await import('../../src/runner')
  const { Inventory } = await import('../../src/core/inventory')
  assert.equal(woodCarried(new Inventory(registry, { oak_log: 1, oak_planks: 4, stick: 8 })), 3)
  const bot = fakeBot({ wooden_pickaxe: 1, stone_sword: 1, cooked_beef: 8 })
  bot.time = { timeOfDay: 12000, day: 3 }
  bot.findBlock = () => null
  const mined: string[] = []
  const runners = { mine: async (step: any) => { mined.push(step.item); bot.give(step.item, step.count); return { gained: step.count } } }
  const runner = new Runner(bot, { log: () => {}, executor: { runners, log: () => {} } })
  runner.reached.push(...['wood', 'stone', 'food'].map(id => ({ id: id as any, title: '', tick: 0, wallMs: 0 })))
  await runner.nightSchedule()
  assert.equal(mined[0], 'oak_log')
  assert.ok(progressState(bot, bot.survival.memory).inventory.count('oak_log') >= DUSK_LOGS)
})

test('the night\'s goals got, the rest of the night is waited out down the mine until the day', async () => {
  const bot = fakeBot({ stone_pickaxe: 1, cooked_beef: 8, oak_log: 4 })
  bot.time = { timeOfDay: 14000, day: 1 }
  bot.food = 20
  bot.blockAt = () => ({ name: 'stone', boundingBox: 'block' })
  const lines: string[] = []
  const runner = new Runner(bot, { log: l => lines.push(l), executor: { log: () => {} } })
  let done = false
  const night = runner.mineTheNight([]).then(() => { done = true })
  for (let i = 0; i < 20; i++) { bot.emit('physicsTick'); await new Promise(resolve => setImmediate(resolve)) }
  assert.equal(done, false)
  assert.ok(lines.some(l => /the rest of it waited out down the mine/.test(l)), lines.join('\n'))
  bot.time = { timeOfDay: 100, day: 2 }
  bot.emit('physicsTick')
  await night
  assert.equal(bot.survival.nightWork, false)
})

test('with the iron the work up next, the night is not waited out (its last logs are a short trip up)', async () => {
  const bot = fakeBot({ stone_pickaxe: 1, cooked_beef: 8, oak_log: 4 })
  bot.time = { timeOfDay: 14000, day: 1 }
  bot.food = 20
  bot.blockAt = () => ({ name: 'stone', boundingBox: 'block' })
  const lines: string[] = []
  const runner = new Runner(bot, { log: l => lines.push(l), skip: ['base'], executor: { log: () => {} } })
  runner.reached.push(...['wood', 'stone', 'food'].map(id => ({ id: id as any, title: '', tick: 0, wallMs: 0 })))
  await runner.mineTheNight([])
  assert.ok(!lines.some(l => /waited out/.test(l)), lines.join('\n'))
})

test('the enchanting milestone failing five times is left out and play goes on to the nether (the dragon needs none of it)', async () => {
  const bot = fakeBot({ wooden_pickaxe: 1, crafting_table: 1, stone_pickaxe: 1, stone_sword: 1, stone_axe: 1, stone_shovel: 1, furnace: 1, cooked_beef: 8 })
  bot.give('iron_pickaxe', 1)
  for (const n of ['iron_sword', 'iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots', 'shield', 'bucket', 'diamond_pickaxe', 'diamond_sword']) bot.give(n, 1)
  bot.survival.memory.setBase({ x: 0, y: 40, z: 0 })
  let tries = 0
  const lines: string[] = []
  const runner = new Runner(bot, {
    stopAt: 'nether',
    log: line => lines.push(line),
    handlers: { enchanting: async () => { tries++; throw new TaskError('NOT_FOUND', 'no more sugar_cane found') } }
  })
  const result = await runner.play()
  assert.equal(tries, 5)
  assert.equal(result.reason, 'until')
  assert.equal(result.stoppedAt, 'nether')
  assert.ok(lines.some(l => /milestone enchanting left out after 5 failures/.test(l)), lines.join(' | '))
})

test('a trip across the world (the eyes\' stronghold search, the End) isn\'t stopped for a night down a mine', async () => {
  const bot = fakeBot({ diamond_pickaxe: 1, diamond_sword: 1, iron_chestplate: 1, torch: 2, cooked_beef: 8, ender_eye: 16 })
  bot.time = { timeOfDay: 13000, day: 1 }
  bot.findBlock = () => null
  const runner = new Runner(bot, { log: () => {} })
  for (const id of ['wood', 'stone', 'food', 'base', 'iron', 'diamonds', 'enchanting', 'nether'] as const) runner.reached.push({ id, title: '', tick: 0, wallMs: 0 })
  assert.equal(runner.nightDue(), null)
  // the nether next (worked from home), the torches are the night's work as before
  const bot2 = fakeBot({ diamond_pickaxe: 1, diamond_sword: 1, iron_chestplate: 1, torch: 2, cooked_beef: 8 })
  bot2.time = { timeOfDay: 13000, day: 1 }
  bot2.findBlock = () => null
  const home = new Runner(bot2, { log: () => {} })
  for (const id of ['wood', 'stone', 'food', 'base', 'iron', 'diamonds', 'enchanting'] as const) home.reached.push({ id, title: '', tick: 0, wallMs: 0 })
  assert.notEqual(home.nightDue(), null)
  // the rods got: the pearls are the night's work, on the surface
  bot2.give('blaze_rod', 8)
  assert.equal(home.nightDue(), null)
})

test('a bot back bare from a death isn\'t sent down the mine at night (nightGeared), and its re-equip waits for the day first (full-26.3-fresh-u)', async () => {
  const reach = (runner: Runner): void => { for (const id of ['wood', 'stone', 'food', 'base', 'iron', 'diamonds', 'enchanting'] as const) runner.reached.push({ id, title: '', tick: 0, wallMs: 0 }) }
  // the night's mine with the kit: torches to make (as in the trip test)
  const geared = fakeBot({ diamond_pickaxe: 1, diamond_sword: 1, iron_chestplate: 1, torch: 2, cooked_beef: 8 })
  geared.time = { timeOfDay: 13000, day: 1 }
  geared.findBlock = () => null
  const kitted = new Runner(geared, { log: () => {} })
  reach(kitted)
  assert.notEqual(kitted.nightDue(), null)
  assert.equal(geared.survival.nightGeared(), true)
  // back from a death with a pickaxe from a chest, no sword and no armor: not down the mine
  const bare = fakeBot({ stone_pickaxe: 1, torch: 2, cooked_beef: 8 })
  bare.time = { timeOfDay: 13000, day: 1 }
  bare.findBlock = () => null
  const lines: string[] = []
  const runner = new Runner(bare, { log: l => lines.push(l) })
  reach(runner)
  assert.equal(runner.nightDue(), null)
  assert.equal(bare.survival.nightGeared(), false)
  // a sword alone isn't enough past the iron milestone; with a chestplate too it is
  bare.give('stone_sword', 1)
  assert.equal(runner.nightDue(), null)
  bare.give('iron_chestplate', 1)
  assert.notEqual(runner.nightDue(), null)
  // the re-equip at night, bare: the night waited out first, then the goals
  const bot = fakeBot({ dirt: 3 })
  bot.time = { timeOfDay: 14000, day: 1 }
  const order: string[] = []
  const r2 = new Runner(bot, { log: l => order.push(l) })
  reach(r2)
  r2.executor.task = (async (name: string) => { order.push(`task ${name}`); bot.time = { timeOfDay: 0, day: 2 } }) as any
  r2.executor.obtain = (async (reqs: any[]) => { order.push(`obtain ${String(reqs[0].item)}`); bot.give(reqs[0].item, 1) }) as any
  await r2.reequip()
  const wait = order.findIndex(l => l === 'task wait out the night')
  assert.ok(wait >= 0 && wait < order.findIndex(l => l.startsWith('obtain')), order.join(' | '))
  // by day: no wait
  const day = fakeBot({ dirt: 3 })
  const r3 = new Runner(day, { log: () => {} })
  reach(r3)
  const tasks: string[] = []
  r3.executor.task = (async (name: string) => { tasks.push(name) }) as any
  r3.executor.obtain = (async (reqs: any[]) => { day.give(reqs[0].item, 1) }) as any
  await r3.reequip()
  assert.deepEqual(tasks, [])
})

test('a death while recovering from one is recovered from in turn, not thrown out of play', async () => {
  const bot = fakeBot({ cooked_beef: 8 })
  const lines: string[] = []
  const runner = new Runner(bot, { log: line => lines.push(line) })
  let calls = 0
  runner.recoverFromDeath = async () => { calls++; if (calls < 3) throw new TaskError('DIED', 'the bot died') }
  await runner.recover()
  assert.equal(calls, 3)
  calls = 0
  runner.recoverFromDeath = async () => { calls++; throw new TaskError('NO_PATH', 'no way to the kit') }
  await runner.recover()
  assert.equal(calls, 1)
  assert.ok(lines.some(l => /recovery: no way to the kit/.test(l)), lines.join(' | '))
})

test('a resumed run keeps the trip kit\'s chest and the spawn bed (its foot and the cells round it) from the paths', async () => {
  const bot: any = fakeBot()
  let settings: any = { exclusionAreasBreak: [] }
  bot.pathfinder = { get defaultMoveSettings () { return settings }, setMoveOptions: (s: any) => { settings = s } }
  const memory = { version: 1, blocks: [], chests: [], base: null, pois: [{ kind: 'trip_kit', x: 2358, y: -24, z: 1015, dimension: 'overworld', seen: 1 }, { kind: 'spawn_bed', x: 2359, y: -24, z: 1014, dimension: 'overworld', seen: 1 }], death: null }
  const store = { name: 'mem', read: () => JSON.stringify({ version: 1, memory, reached: [], ticks: 0 }), write: () => {} }
  const runner = new Runner(bot, { saveStore: store, log: () => {} })
  runner.load()
  const cost = (x: number, y: number, z: number): number => settings.exclusionAreasBreak.reduce((n: number, f: any) => n + f({ position: { x, y, z } }), 0)
  for (const p of [[2358, -24, 1015], [2359, -24, 1014], [2359, -24, 1013]]) assert.ok(cost(p[0], p[1], p[2]) >= 1e9, p.join(','))
  assert.strictEqual(cost(2365, -24, 1014), 0)
})

test('an optional milestone that has had its ticks is left out before it fails five times', async () => {
  const { OPTIONAL_MILESTONE_TICKS } = await import('../../src/runner')
  const bot = fakeBot({ wooden_pickaxe: 1, crafting_table: 1, stone_pickaxe: 1, stone_sword: 1, stone_axe: 1, stone_shovel: 1, furnace: 1, cooked_beef: 8 })
  bot.give('iron_pickaxe', 1)
  for (const n of ['iron_sword', 'iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots', 'shield', 'bucket', 'diamond_pickaxe', 'diamond_sword']) bot.give(n, 1)
  bot.survival.memory.setBase({ x: 0, y: 40, z: 0 })
  let tries = 0
  const lines: string[] = []
  const runner = new Runner(bot, {
    stopAt: 'nether',
    log: line => lines.push(line),
    handlers: { enchanting: async () => { tries++; (bot.survival.tasks as any).tick += OPTIONAL_MILESTONE_TICKS; throw new TaskError('NOT_FOUND', 'no more sugar_cane found') } }
  })
  const result = await runner.play()
  assert.equal(tries, 1)
  assert.equal(result.stoppedAt, 'nether')
  assert.ok(lines.some(l => /milestone enchanting left out after \d+ ticks/.test(l)), lines.join(' | '))
})

test('rekit gets to a dug-in base the long way (hops, a stair down) when the path search fails, then takes the kit', async () => {
  const navModule = require('../../src/skills/navigate')
  const strongholdModule = require('../../src/end/strongholdSkills')
  const chestModule = require('../../src/skills/chest')
  const { Vec3 } = await import('vec3')
  const bot = fakeBot({ cooked_beef: 2 })
  bot.survival.memory.setBase({ x: -56, y: 60, z: -16 })
  bot.survival.memory.addPoi('base_entrance', { x: -52, y: 60, z: -19 }, 'overworld')
  bot.survival.memory.rememberChest({ x: -56, y: 60, z: -16 }, { diamond_pickaxe: 1, diamond_sword: 1 }, 'overworld')
  const runner = new Runner(bot, { log: () => {} })
  const calls: string[] = []
  const realNav = navModule.navigate
  const realOver = strongholdModule.overland
  const realGet = chestModule.retrieveItems
  navModule.navigate = async () => { calls.push('navigate'); throw new TaskError('NO_PATH', 'the last search ended: timeout') }
  strongholdModule.overland = async (_b: unknown, a: any) => { calls.push(`overland ${a.target.toString()}`) }
  chestModule.retrieveItems = async () => { calls.push('retrieve'); return { moved: { diamond_pickaxe: 1, diamond_sword: 1 } } }
  runner.executor.task = (async (_name: string, fn: any) => await fn(new AbortController().signal)) as any
  const exploreModule = require('../../src/executor/explore')
  const realEnsure = exploreModule.ensurePickaxe
  exploreModule.ensurePickaxe = async () => { calls.push('ensurePickaxe'); return 'stone_pickaxe' }
  try {
    const took = await runner.rekit()
    assert.deepEqual(took, { diamond_pickaxe: 1, diamond_sword: 1 })
  } finally {
    navModule.navigate = realNav
    strongholdModule.overland = realOver
    chestModule.retrieveItems = realGet
    exploreModule.ensurePickaxe = realEnsure
  }
  // a pickaxe made for the stone on the way first (the bot back from a death has none)
  assert.deepEqual(calls.slice(0, 3), ['ensurePickaxe', 'navigate', `overland ${new Vec3(-52, 60, -19).toString()}`])
  assert.ok(calls.includes('retrieve'))
})

test('rekit with nothing to make a pickaxe from gets one the way the game starts (wood, then stone) before the way into the base', async () => {
  const navModule = require('../../src/skills/navigate')
  const strongholdModule = require('../../src/end/strongholdSkills')
  const chestModule = require('../../src/skills/chest')
  const exploreModule = require('../../src/executor/explore')
  const bot = fakeBot({ dirt: 2 })
  bot.survival.memory.setBase({ x: -56, y: 60, z: -16 })
  bot.survival.memory.addPoi('base_entrance', { x: -51, y: 60, z: -20 }, 'overworld')
  bot.survival.memory.rememberChest({ x: -56, y: 60, z: -16 }, { diamond_pickaxe: 1 }, 'overworld')
  const runner = new Runner(bot, { log: () => {} })
  const calls: string[] = []
  const real = [navModule.navigate, strongholdModule.overland, chestModule.retrieveItems, exploreModule.ensurePickaxe]
  navModule.navigate = async () => { calls.push('navigate') }
  strongholdModule.overland = async () => { calls.push('overland') }
  chestModule.retrieveItems = async () => { calls.push('retrieve'); return { moved: {} } }
  exploreModule.ensurePickaxe = async () => { calls.push('ensurePickaxe'); return null }
  runner.executor.task = (async (_name: string, fn: any) => await fn(new AbortController().signal)) as any
  runner.executor.obtain = (async (reqs: any[]) => { calls.push(`obtain ${String(reqs[0].item)}`) }) as any
  try {
    await runner.rekit()
  } finally {
    [navModule.navigate, strongholdModule.overland, chestModule.retrieveItems, exploreModule.ensurePickaxe] = real
  }
  assert.deepEqual(calls.slice(0, 3), ['ensurePickaxe', 'obtain stone_pickaxe,wooden_pickaxe', 'navigate'])
})

test('after a death the basics lacking are made again in order: stone tools (a shovel and an axe among them, for the dirt and the wood), a shield (f7-26.3: speared with none), iron ones, a bucket, a chestplate', async () => {
  const { reequipGoals } = await import('../../src/runner')
  const inv = (items: Record<string, number>) => ({ count: (n: string) => items[n] ?? 0 })
  assert.deepEqual(reequipGoals(inv({ dirt: 3 })).map(g => g.item), ['stone_pickaxe', 'stone_sword', 'stone_shovel', 'stone_axe', 'shield', 'iron_pickaxe', 'bucket', 'iron_sword', 'iron_chestplate'])
  assert.deepEqual(reequipGoals(inv({ diamond_pickaxe: 1, diamond_sword: 1, water_bucket: 1, iron_chestplate: 1, shield: 1 })).map(g => g.item), ['stone_shovel', 'stone_axe'])
  // any axe will do
  for (const axe of ['wooden_axe', 'iron_axe', 'diamond_axe']) assert.deepEqual(reequipGoals(inv({ diamond_pickaxe: 1, diamond_sword: 1, [axe]: 1, iron_shovel: 1, water_bucket: 1, iron_chestplate: 1, shield: 1 })).map(g => g.item), [], axe)
  assert.deepEqual(reequipGoals(inv({ diamond_pickaxe: 1, diamond_sword: 1, iron_shovel: 1, stone_axe: 1, water_bucket: 1, iron_chestplate: 1, shield: 1 })).map(g => g.item), [])
  const bot = fakeBot({ dirt: 3 })
  const runner = new Runner(bot, { log: () => {} })
  const asked: string[] = []
  runner.executor.obtain = (async (reqs: any[]) => { asked.push(reqs[0].item); bot.give(reqs[0].item, 1) }) as any
  await runner.reequip()
  // the stone ones, then the iron ones (the stone sword's need gone once iron came is still asked in order)
  assert.deepEqual(asked, ['stone_pickaxe', 'stone_sword', 'stone_shovel', 'stone_axe', 'shield', 'iron_pickaxe', 'bucket', 'iron_sword', 'iron_chestplate'])
})

test('in the nether milestone the executor\'s stores keep what it and the eyes need: the goals, their plan, the kit (Runner.milestoneNeeds)', async () => {
  const bot = fakeBot({ diamond_pickaxe: 1, iron_ingot: 2, flint: 1, obsidian: 6, bucket: 1, water_bucket: 1, raw_gold: 3, crafting_table: 1 })
  let needs: Record<string, number> = {}
  const runner = new Runner(bot, {
    skip: ['wood', 'stone', 'food', 'base', 'iron', 'diamonds', 'enchanting'],
    stopAt: 'eyes',
    log: () => {},
    handlers: { nether: async ({ executor }) => { needs = { ...executor.protect().needs }; bot.give('ender_eye', 16) } }
  })
  const result = await runner.play()
  assert.equal(result.stoppedAt, 'eyes')
  assert.equal(needs.obsidian, 10)
  assert.equal(needs.flint_and_steel, 1)
  // the flint and steel's makings, from the plan
  assert.ok(needs.flint >= 1 && needs.iron_ingot >= 1, JSON.stringify(needs))
  for (const name of ['bucket', 'water_bucket', 'lava_bucket', 'raw_gold', 'gold_ingot', 'ender_pearl', 'blaze_rod', 'blaze_powder', 'ender_eye']) assert.ok(needs[name] > 0, name)
})

test('the save is written after every chest change, not only at the milestones, and holds the milestone when its event fires (the e2e checkpoint copies it then)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-test-'))
  const saveFile = path.join(dir, 'save.json')
  const read = (): any => JSON.parse(fs.readFileSync(saveFile, 'utf8'))
  const bot = fakeBot()
  const atEvent: string[][] = []
  bot.on('survivalMilestone', () => atEvent.push(read().reached.map((r: any) => r.id)))
  let midway: any = null
  const runner = new Runner(bot, {
    until: 'stone',
    saveFile,
    log: () => {},
    handlers: {
      wood: async () => {
        // a take from the base's chest mid-milestone (a rekit's): in the save before the milestone ends
        bot.survival.memory.rememberChest({ x: 1, y: 40, z: 1 }, { bread: 2 })
        await new Promise(resolve => setImmediate(resolve))
        midway = read()
        bot.give('wooden_pickaxe', 1)
        bot.give('crafting_table', 1)
      },
      stone: async () => { bot.give('stone_pickaxe', 1); bot.give('stone_sword', 1); bot.give('stone_axe', 1); bot.give('stone_shovel', 1); bot.give('furnace', 1) }
    }
  })
  await runner.play()
  assert.deepEqual(midway?.memory.chests.map((c: any) => c.items), [{ bread: 2 }])
  assert.deepEqual(midway?.reached, [])
  assert.deepEqual(atEvent, [['wood'], ['wood', 'stone']])
  // no listener left once play is over
  const before = fs.statSync(saveFile).mtimeMs
  fs.writeFileSync(saveFile, '{}')
  bot.survival.memory.rememberChest({ x: 1, y: 40, z: 1 }, {})
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(fs.readFileSync(saveFile, 'utf8'), '{}', String(before))
})

test('a resumed run\'s memory clock goes on from the save\'s ticks (WorldMemory.tickBase): a chest\'s age holds across the runs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-test-'))
  const saveFile = path.join(dir, 'save.json')
  const memory = new WorldMemory()
  memory.now = 90000
  memory.rememberChest({ x: 1, y: 40, z: 1 }, { diamond_pickaxe: 1 })
  fs.writeFileSync(saveFile, JSON.stringify({ version: 1, memory: memory.toJSON(), reached: [], ticks: 100000 }))
  const bot = fakeBot()
  let seen: { now: number, base: number, age: number } | null = null
  const runner = new Runner(bot, {
    saveFile,
    until: 'wood',
    log: () => {},
    handlers: {
      wood: async () => {
        const m = bot.survival.memory
        seen = { now: m.now, base: m.tickBase, age: m.now - m.chestAt({ x: 1, y: 40, z: 1 }).seen }
        bot.give('wooden_pickaxe', 1)
        bot.give('crafting_table', 1)
      }
    }
  })
  await runner.play()
  assert.equal(seen!.base, 100000)
  assert.ok(seen!.now >= 100000, String(seen!.now))
  assert.ok(seen!.age >= 10000, String(seen!.age))
})

test('waitOutTheNight: by day nothing; a bed that fails as the night ends (the server\'s not night at dawn) is the end of it, no hole dug', async () => {
  const { waitOutTheNight } = await import('../../src/runner')
  const { fakeBot } = await import('../reflexes/fakeBot')
  const day = fakeBot()
  day.time = { timeOfDay: 1000 }
  day.findBlock = () => { throw new Error('looked for a bed by day') }
  assert.equal(await waitOutTheNight(day, new AbortController().signal), undefined)
  const dawn = fakeBot()
  dawn.time = { timeOfDay: 23400 }
  // the bed found, and the night over by the time the bot lies down
  dawn.findBlock = () => { dawn.time.timeOfDay = 100; return { name: 'white_bed', position: new Vec3(2, 64, 0) } }
  dawn.sleep = async () => { throw new Error("it's not night") }
  dawn.dig = async () => { throw new Error('a hole dug by day') }
  const ticker = setInterval(() => dawn.emit('physicsTick'), 1)
  try {
    assert.equal(await waitOutTheNight(dawn, new AbortController().signal), undefined)
  } finally {
    clearInterval(ticker)
  }
})

test('a milestone not ready to go on (notReady) is tried again without counting a failure', async () => {
  const { SkillError } = await import('../../src/skills/errors')
  const bot = fakeBot()
  let calls = 0
  const logs: string[] = []
  const runner = new Runner(bot, {
    until: 'wood',
    log: (l: string) => logs.push(l),
    maxFailures: 2,
    handlers: {
      wood: async () => {
        calls++
        if (calls <= 3) throw Object.assign(new SkillError('MISSING_ITEMS', 'not going in without the gear'), { notReady: true })
        bot.give('wooden_pickaxe', 1)
        bot.give('crafting_table', 1)
      }
    }
  })
  // (back at once each time: a while waited before the next, the ticks run here)
  const ticking = setInterval(() => { for (let i = 0; i < 50; i++) bot.emit('physicsTick') }, 1)
  let r: any
  try {
    r = await runner.play()
  } finally {
    clearInterval(ticking)
  }
  assert.equal(r.reason, 'until', logs.join('\n'))
  assert.equal(calls, 4)
  assert.ok(logs.some(l => /milestone wood not ready \(3\)/.test(l)))
  assert.ok(!logs.some(l => /milestone wood failed/.test(l)))
  assert.equal(logs.filter(l => /nothing came of it, the stock topped up/.test(l)).length, 3)
})

test('a milestone short of only its food banks more of it each try without a try counted (FOOD_BANK_TRIES); a try that banked none is counted', async () => {
  const { SkillError } = await import('../../src/skills/errors')
  const bot = fakeBot()
  let calls = 0
  const logs: string[] = []
  // 20, 40, 60 points banked over the tries, then 60 again (none more), then in
  const points = [20, 40, 60, 60]
  const runner = new Runner(bot, {
    until: 'wood',
    log: (l: string) => logs.push(l),
    maxFailures: 2,
    handlers: {
      wood: async () => {
        calls++
        if (calls <= points.length) throw Object.assign(new SkillError('MISSING_ITEMS', 'not going in without the food'), { notReady: true, foodShort: true, foodPoints: points[calls - 1] })
        bot.give('wooden_pickaxe', 1)
        bot.give('crafting_table', 1)
      }
    }
  })
  const ticking = setInterval(() => { for (let i = 0; i < 200; i++) bot.emit('physicsTick') }, 1)
  let r: any
  try {
    r = await runner.play()
  } finally {
    clearInterval(ticking)
  }
  assert.equal(r.reason, 'until', logs.join(' | '))
  assert.equal(calls, 5)
  assert.equal(logs.filter(l => /food points banked/.test(l)).length, 3, logs.join(' | '))
  assert.equal(logs.filter(l => /milestone wood not ready \(1\)/.test(l)).length, 1, logs.join(' | '))
})

test('a milestone waiting for a farm to grow (growing) waits by home its waitTicks each try, no try counted, GROW_WAIT_TRIES times; then its tries count (f3-1.21.11)', async () => {
  const { SkillError } = await import('../../src/skills/errors')
  const { GROW_WAIT_TRIES } = await import('../../src/runner')
  for (const grows of [true, false]) {
    const bot = fakeBot()
    let calls = 0
    const logs: string[] = []
    const ticksAt: number[] = []
    const runner = new Runner(bot, {
      until: 'wood',
      log: (l: string) => logs.push(l),
      maxFailures: 1,
      handlers: {
        wood: async () => {
          calls++
          ticksAt.push(bot.survival.tasks.tick)
          // the farm's canes in after 3 waits; or never
          if (!grows || calls <= 3) throw Object.assign(new SkillError('MISSING_ITEMS', 'the table\'s book: 0 canes of 3, the cane farm growing'), { notReady: true, growing: true, waitTicks: 500 })
          bot.give('wooden_pickaxe', 1)
          bot.give('crafting_table', 1)
        }
      }
    })
    const ticking = setInterval(() => { for (let i = 0; i < 200; i++) bot.emit('physicsTick') }, 1)
    let r: any
    try {
      r = await runner.play()
    } finally {
      clearInterval(ticking)
    }
    const waits = logs.filter(l => /the cane farm growing: waiting by home/.test(l)).length
    if (grows) {
      assert.equal(r.reason, 'until', logs.join(' | '))
      assert.equal(calls, 4)
      assert.equal(waits, 3)
      // a wait of its waitTicks between the tries
      assert.ok(ticksAt.slice(1).every((t, i) => t - ticksAt[i] >= 500), ticksAt.join(' '))
    } else {
      // the waits had, then not-ready tries and a failure as before
      assert.equal(waits, GROW_WAIT_TRIES, logs.join(' | '))
      assert.ok(logs.some(l => /milestone wood not ready \(1\)/.test(l)))
      assert.notEqual(r.reason, 'until')
    }
  }
})

test('a milestone whose way is being searched for (searching: the portal frame lava search) is tried again past maxFailures and NOT_READY_TRIES, never counted, a wait after a fast one (f4-1.21.11: play stopped at the nether)', async () => {
  const { SkillError } = await import('../../src/skills/errors')
  const { NOT_READY_TRIES } = await import('../../src/runner')
  const bot = fakeBot()
  let calls = 0
  const logs: string[] = []
  const ticksAt: number[] = []
  const runner = new Runner(bot, {
    until: 'wood',
    log: (l: string) => logs.push(l),
    maxFailures: 1,
    handlers: {
      wood: async () => {
        calls++
        ticksAt.push(bot.survival.tasks.tick)
        if (calls <= NOT_READY_TRIES + 2) throw Object.assign(new SkillError('NOT_FOUND', 'the portal frame: 0 obsidian, no more known: the lava searched for, the frame tried again'), { notReady: true, searching: true })
        bot.give('wooden_pickaxe', 1)
        bot.give('crafting_table', 1)
      }
    }
  })
  const ticking = setInterval(() => { for (let i = 0; i < 400; i++) bot.emit('physicsTick') }, 1)
  let r: any
  try {
    r = await runner.play()
  } finally {
    clearInterval(ticking)
  }
  assert.equal(r.reason, 'until', logs.join(' | '))
  assert.equal(calls, NOT_READY_TRIES + 3)
  assert.ok(!logs.some(l => /milestone wood (failed|not ready)/.test(l)), logs.join(' | '))
  // a wait between the fast tries
  assert.ok(ticksAt.slice(1).every((t, i) => t - ticksAt[i] >= 1000), ticksAt.join(' '))
})

test('the death spot: not gone back to bare where an archer shot the bot dead; a death to a mob at night gone back to by day if the items last (full-26.3-fresh-d)', async () => {
  const { deathSpotTiming } = await import('../../src/runner')
  const air = (): { name: string } => ({ name: 'air' })
  const now = { tick: 2000, dimension: 'overworld', position: new Vec3(0, 64, 0), minY: -64, blockAt: air }
  const death = { x: 20, y: 64, z: 0, dimension: 'overworld', seen: 1900 }
  assert.equal(deathSpotWorthIt({ ...death, killer: 'skeleton' }, { ...now, bare: true }, 6000), false)
  assert.equal(deathSpotWorthIt({ ...death, killer: 'skeleton' }, { ...now, bare: false }, 6000), true)
  assert.equal(deathSpotWorthIt({ ...death, killer: 'zombie' }, { ...now, bare: true }, 6000), true)
  // by day: go; at night with the day 3540 off: wait, the items last; at 13000 (10460 to the day): skip
  assert.equal(deathSpotTiming({ seen: 1900, killer: 'zombie' }, { tick: 2000, timeOfDay: 6000, dimension: 'overworld' }, 100, 6000), 'go')
  assert.equal(deathSpotTiming({ seen: 1900, killer: 'skeleton' }, { tick: 2000, timeOfDay: 19920, dimension: 'overworld' }, 100, 6000), 'wait')
  assert.equal(deathSpotTiming({ seen: 1900, killer: 'skeleton' }, { tick: 2000, timeOfDay: 13000, dimension: 'overworld' }, 100, 6000), 'skip')
  // a fall (no killer) or the nether: go
  assert.equal(deathSpotTiming({ seen: 1900 }, { tick: 2000, timeOfDay: 13000, dimension: 'overworld' }, 100, 6000), 'go')
  assert.equal(deathSpotTiming({ seen: 1900, killer: 'blaze' }, { tick: 2000, timeOfDay: 13000, dimension: 'the_nether' }, 100, 6000), 'go')
})

test('a hungry bot short of food gets a meal first: mealDue in the overworld, the work stopped for it (untilDusk\'s hunger watch), none in the nether or when fed (full-26.3-s31337-g: a hunt for cows went on from food 9 to 0)', async () => {
  const bot = fakeBot({ stone_pickaxe: 1 })
  bot.food = 9
  const runner = new Runner(bot, { log: () => {} })
  const meal = runner.mealDue()
  assert.ok(meal != null && meal[0].unit === 'nutrition', JSON.stringify(meal))
  assert.notEqual(meal[0].harmful, true)
  // starving: rotten flesh will do
  bot.food = 5
  assert.equal(runner.mealDue()?.[0].harmful, true)
  bot.food = 9
  // the work under way is stopped for it
  let ticked = 0
  const work = runner.untilDusk(new AbortController().signal, { hunger: true }, async (s) => {
    await new Promise<void>((resolve, reject) => {
      s.addEventListener('abort', () => reject(s.reason), { once: true })
      const t = setInterval(() => { bot.emit('physicsTick'); if (++ticked > 100) { clearInterval(t); resolve() } }, 0)
      s.addEventListener('abort', () => clearInterval(t), { once: true })
    })
  })
  assert.equal(await work, 'hungry')
  assert.ok(ticked <= 21, `${ticked} ticks`)
  // fed (12 points carried), in the nether, or the bar high: none
  bot.give('cooked_beef', 2)
  assert.equal(runner.mealDue(), null)
  const nether = fakeBot({})
  nether.food = 3
  nether.game.dimension = 'the_nether'
  assert.equal(new Runner(nether, { log: () => {} }).mealDue(), null)
  const full = fakeBot({})
  full.food = 18
  assert.equal(new Runner(full, { log: () => {} }).mealDue(), null)
})

test('the night down the mine starts in the nearest slime chunk from the seed when the slime balls of the brew are short and the iron is got; not with the balls, nor without the seed', async () => {
  const { nearestSlimeChunk } = await import('../../src/skills/slimeChunk')
  const travelModule = require('../../src/skills/travel')
  const real = travelModule.travel
  const walks: string[] = []
  travelModule.travel = async (b: any, a: any) => { walks.push(a.target.toString()); b.entity.position = a.target.offset(0.5, 0, 0.5) }
  const night = async (items: Record<string, number>, seed?: string): Promise<string[]> => {
    const bot = fakeBot({ iron_pickaxe: 1, cooked_beef: 8, oak_log: 4, ...items })
    bot.time = { timeOfDay: 14000, day: 1 }
    bot.food = 20
    bot.entity.position = new Vec3(0.5, 70, 0.5)
    // (the surface: open sky from 70 up)
    bot.blockAt = (p: Vec3) => ({ name: p.y >= 70 ? 'air' : 'stone', boundingBox: p.y >= 70 ? 'empty' : 'block', position: p })
    const lines: string[] = []
    const runner = new Runner(bot, { log: l => lines.push(l), seed, skip: ['base'], executor: { log: () => {} } })
    runner.reached.push(...['wood', 'stone', 'food', 'iron'].map(id => ({ id: id as any, title: '', tick: 0, wallMs: 0 })))
    walks.length = 0
    await runner.mineTheNight([])
    return lines.filter(l => /slime/.test(l))
  }
  try {
    const target = nearestSlimeChunk('2', 0.5, 0.5, 70)
    assert.ok(target != null)
    assert.deepEqual(await night({}, '2'), [`night: the mine in the slime chunk at ${target.x} ${target.z}, for slime balls`])
    assert.deepEqual(walks, [target.toString()])
    assert.deepEqual(await night({ slime_ball: 2 }, '2'), [])
    assert.deepEqual(await night({}), [])
    assert.deepEqual(walks, [])
  } finally {
    travelModule.travel = real
  }
})

test('home: the food land while the bot has no base (its farm, herd and base go up there), with a base only while the food work is under way', async () => {
  const { FOOD_LAND_POI } = await import('../../src/executor/foodLand')
  const bot = fakeBot()
  bot.spawnPoint = new Vec3(0, 120, 0)
  const runner: any = new Runner(bot, { log: () => {} })
  assert.ok(runner.home().equals(new Vec3(0, 120, 0)))
  runner.memory.addPoi(FOOD_LAND_POI, { x: 230, y: 70, z: -10 }, 'overworld', 'snowy_taiga')
  assert.ok(runner.home().equals(new Vec3(230, 70, -10)))
  runner.memory.base = { x: 5, y: 110, z: 5, dimension: 'overworld' }
  assert.ok(runner.home().equals(new Vec3(5, 110, 5)))
  const during = await runner.foodWorking(async () => runner.home())
  assert.ok(during.equals(new Vec3(230, 70, -10)))
  assert.ok(runner.home().equals(new Vec3(5, 110, 5)))
})

test('withinTicks: only the ticks `counts` takes count against the budget (a trip\'s own, not a night\'s shelter that preempted it)', async () => {
  const bot = fakeBot()
  const runner: any = new Runner(bot, { log: () => {} })
  let mine = false
  let ran = 0
  const done = runner.withinTicks(10, new AbortController().signal, () => mine, async (s: AbortSignal) => {
    await new Promise<void>((resolve, reject) => {
      s.addEventListener('abort', () => reject(s.reason), { once: true })
      bot.on('physicsTick', () => { ran++ })
    })
  }).catch((err: Error) => err)
  for (let i = 0; i < 50; i++) bot.emit('physicsTick')
  mine = true
  for (let i = 0; i < 9; i++) bot.emit('physicsTick')
  assert.equal(ran, 59)
  bot.emit('physicsTick')
  const err = await done
  assert.ok(TaskError.is(err, 'TIMEOUT'), String(err))
})

test('foodWorking: a try of FOOD_DRY_TICKS or more that got no food counts dry, one that got some ends the run of them', async () => {
  const { FOOD_DRY_TICKS } = await import('../../src/runner')
  const bot = fakeBot()
  bot.food = 10
  const runner: any = new Runner(bot, { log: () => {} })
  const ticks = async (n: number): Promise<void> => { for (let i = 0; i < n; i++) bot.emit('physicsTick') }
  await runner.foodWorking(async () => await ticks(FOOD_DRY_TICKS))
  await runner.foodWorking(async () => await ticks(FOOD_DRY_TICKS))
  assert.equal(runner.foodDry, 2)
  // a short one: not counted
  await runner.foodWorking(async () => await ticks(10))
  assert.equal(runner.foodDry, 2)
  await runner.foodWorking(async () => { await ticks(FOOD_DRY_TICKS); bot.give('cooked_beef', 2) })
  assert.equal(runner.foodDry, 0)
  // not the food work's: not counted
  await runner.foodWorking(async () => await ticks(FOOD_DRY_TICKS), false)
  assert.equal(runner.foodDry, 0)
})

test('a food restock that gets nothing gives up after RESTOCK_TICKS of its own (a reflex\'s not counted) and the milestone goes on, tried again after RESTOCK_RETRY_TICKS (rt-1: kelp explored for 29000 ticks, the enchanting held up)', async () => {
  const { RESTOCK_TICKS } = await import('../../src/runner')
  const bot = fakeBot()
  bot.waitForTicks = async () => {}
  const worked: string[] = []
  const lines: string[] = []
  const give = (items: Record<string, number>): MilestoneHandler => async ({ milestone }) => {
    worked.push(milestone.id)
    for (const [n, c] of Object.entries(items)) bot.give(n, c)
  }
  let ironTries = 0
  const handlers = {
    wood: give({ wooden_pickaxe: 1, crafting_table: 1 }),
    stone: give({ stone_pickaxe: 1, stone_sword: 1, stone_axe: 1, stone_shovel: 1, furnace: 1, coal: 16 }),
    food: give({ cooked_beef: 8 }),
    iron: async () => {
      worked.push('iron')
      // the first time, most of the food eaten on the way: 1 beef (8 points) left, under the restock's mark
      if (ironTries++ === 0) { bot.give('cooked_beef', -7); return }
      give({ iron_pickaxe: 1, iron_sword: 1, iron_helmet: 1, iron_chestplate: 1, iron_leggings: 1, iron_boots: 1, shield: 1, bucket: 1 })({ milestone: { id: 'iron' } } as any)
      worked.pop()
    }
  }
  // the restock's steps explore and find nothing: the ticks go by until the step is stopped; a reflex takes 500 of
  // them in between, not counted against the restock
  let explored = 0
  let reflexDone = false
  const explore = async (_step: any, ctx: any): Promise<any> => {
    for (;;) {
      if (ctx.signal.aborted) throw ctx.signal.reason
      if (explored === 1000 && !reflexDone) {
        // (preempts the step, which runs again after it)
        reflexDone = true
        bot.survival.tasks.enqueue({ name: 'reflex:fight', priority: 50 }, async () => { for (let i = 0; i < 500; i++) { bot.emit('physicsTick'); await Promise.resolve() } })
      }
      explored++
      bot.emit('physicsTick')
      await Promise.resolve()
    }
  }
  const runners = { kill: explore, mine: explore, fish: explore, farm: explore }
  const runner = new Runner(bot, { handlers, until: 'iron', skip: ['base'], log: l => lines.push(l), executor: { runners, log: () => {}, maxStepFailures: 30 } })
  const result = await runner.play()
  assert.equal(result.reason, 'until')
  assert.deepEqual(worked, ['wood', 'stone', 'food', 'iron', 'iron'])
  assert.ok(lines.some(l => /food low \(8 points\)/.test(l)), lines.join('\n'))
  assert.ok(lines.some(l => new RegExp(`no more food for now: out of its ${RESTOCK_TICKS} ticks`).test(l)), lines.join('\n'))
  // its own ticks only: the reflex's 500 on top
  assert.ok(explored >= RESTOCK_TICKS - 5 && explored <= RESTOCK_TICKS + 5, String(explored))
})

test('a food restock in the nether goes back to the overworld first (restockFrom), then restocks there; none from the End (f6-1.21.11: the nether explored for a pig among the blazes, fireballed)', async () => {
  const { restockFrom } = await import('../../src/runner')
  assert.equal(restockFrom('overworld'), 'here')
  assert.equal(restockFrom('minecraft:the_nether'), 'overworld')
  assert.equal(restockFrom('the_end'), 'none')
  const portal = require('../../src/nether/portalTravel')
  const realReturn = portal.returnOverworld
  const bot = fakeBot()
  bot.waitForTicks = async () => {}
  const worked: string[] = []
  const lines: string[] = []
  let back = 0
  portal.returnOverworld = async () => { back++; bot.game.dimension = 'overworld'; return {} }
  const give = (items: Record<string, number>): MilestoneHandler => async ({ milestone }) => {
    worked.push(milestone.id)
    for (const [n, c] of Object.entries(items)) bot.give(n, c)
  }
  let ironTries = 0
  const handlers = {
    wood: give({ wooden_pickaxe: 1, crafting_table: 1 }),
    stone: give({ stone_pickaxe: 1, stone_sword: 1, stone_axe: 1, stone_shovel: 1, furnace: 1, coal: 16 }),
    food: give({ cooked_beef: 8 }),
    iron: async () => {
      worked.push('iron')
      // the first time, in the nether with 1 beef (8 points) left, under the restock's mark
      if (ironTries++ === 0) { bot.give('cooked_beef', -7); bot.game.dimension = 'the_nether'; return }
      give({ iron_pickaxe: 1, iron_sword: 1, iron_helmet: 1, iron_chestplate: 1, iron_leggings: 1, iron_boots: 1, shield: 1, bucket: 1 })({ milestone: { id: 'iron' } } as any)
      worked.pop()
    }
  }
  const dims: string[] = []
  const explore = async (_step: any, ctx: any): Promise<any> => {
    dims.push(String(bot.game.dimension))
    for (;;) {
      if (ctx.signal.aborted) throw ctx.signal.reason
      bot.emit('physicsTick')
      await Promise.resolve()
    }
  }
  const runners = { kill: explore, mine: explore, fish: explore, farm: explore }
  const runner = new Runner(bot, { handlers, until: 'iron', skip: ['base'], log: l => lines.push(l), executor: { runners, log: () => {}, maxStepFailures: 30 } })
  try {
    const result = await runner.play()
    assert.equal(result.reason, 'until')
  } finally {
    portal.returnOverworld = realReturn
  }
  assert.equal(back, 1)
  assert.ok(lines.some(l => /food low \(8 points\) in the nether: back to the overworld for it/.test(l)), lines.join(' | '))
  assert.ok(lines.some(l => /food low \(8 points\): getting more before going on/.test(l)), lines.join(' | '))
  // the restock's steps all in the overworld
  assert.ok(dims.length > 0 && dims.every(d => d === 'overworld'), dims.join(' '))
})

test('failureBackoff: a milestone failing at once waits before its next try, doubled each fast failure in a row; one that worked a while not (ls-1.21.11: 5 failures in 180 ticks, the game stopped)', async () => {
  const { failureBackoff, FAILURE_BACKOFF_TICKS, FAST_FAILURE_TICKS } = await import('../../src/runner')
  assert.equal(failureBackoff(1, 45), FAILURE_BACKOFF_TICKS)
  assert.equal(failureBackoff(2, 45), 2 * FAILURE_BACKOFF_TICKS)
  assert.equal(failureBackoff(4, 45), 8 * FAILURE_BACKOFF_TICKS)
  assert.equal(failureBackoff(1, FAST_FAILURE_TICKS), 0, 'worked a while')
  assert.equal(failureBackoff(0, 45), 0)
  assert.equal(failureBackoff(1, 45, 0), 0, 'none asked for')

  // play: the tries of a milestone that fails at once come FAILURE_BACKOFF_TICKS, then twice that, apart
  const bot = fakeBot()
  const at: number[] = []
  const logs: string[] = []
  const runner = new Runner(bot, {
    log: (l: string) => logs.push(l),
    maxFailures: 3,
    failureBackoffTicks: FAILURE_BACKOFF_TICKS,
    handlers: { wood: async () => { at.push(bot.survival.tasks.tick); throw new TaskError('NO_PATH', 'no path to the goal') } }
  })
  const ticking = setInterval(() => { for (let i = 0; i < 100; i++) bot.emit('physicsTick') }, 1)
  let r: any
  try {
    r = await runner.play()
  } finally {
    clearInterval(ticking)
  }
  assert.equal(r.reason, 'failed')
  assert.equal(at.length, 3)
  assert.ok(at[1] - at[0] >= FAILURE_BACKOFF_TICKS, `${at.join(' ')}`)
  assert.ok(at[2] - at[1] >= 2 * FAILURE_BACKOFF_TICKS, `${at.join(' ')}`)
  assert.equal(logs.filter(l => /ticks before its next try/.test(l)).length, 2, logs.join(' | '))
})

test('after a respawn bare at night with a zombie by, safe first (refugeFirst): the run from it, then nothing once the day comes; a refuge that fails is not chosen again (full-1.21.11-fresh-m)', async () => {
  const refuge = require('../../src/skills/refuge')
  const real = refuge.takeRefuge
  const bot = fakeBot()
  bot.time = { timeOfDay: 18000 }
  bot.blockAt = () => ({ name: 'air', boundingBox: 'empty' })
  const zombie = { id: 5, name: 'zombie', position: new Vec3(2, 64, 0), metadata: [] }
  bot.entities = { 5: zombie }
  const lines: string[] = []
  const runner = new Runner(bot, { log: l => lines.push(l) })
  runner.executor.task = (async (_name: string, fn: (s: AbortSignal) => Promise<unknown>) => await fn(new AbortController().signal)) as any
  const taken: string[] = []
  try {
    refuge.takeRefuge = async (_bot: any, r: string) => {
      taken.push(r)
      // off out of the zombie's sight, and the night's over
      zombie.position = new Vec3(40, 64, 0)
      bot.time = { timeOfDay: 1000 }
    }
    assert.equal(await runner.refugeFirst(), 'flee')
    assert.deepEqual(taken, ['flee'])
    assert.ok(lines.some(l => /after the respawn \(night, 1 zombie within 16 \(the nearest 2\.0 off\)\): a run from them/.test(l)), lines.join(' | '))
    // cornered: the run fails, nothing else to choose (the reflexes then)
    zombie.position = new Vec3(2, 64, 0)
    bot.time = { timeOfDay: 18000 }
    taken.length = 0
    refuge.takeRefuge = async (_bot: any, r: string) => { taken.push(r); throw new TaskError('NO_PATH', 'cornered') }
    assert.equal(await runner.refugeFirst(), null)
    assert.deepEqual(taken, ['flee'])
    assert.ok(lines.some(l => /refuge flee: cornered/.test(l)), lines.join(' | '))
    // by day with nothing about: none
    bot.time = { timeOfDay: 1000 }
    delete bot.entities[5]
    taken.length = 0
    assert.equal(await runner.refugeFirst(), null)
    assert.deepEqual(taken, [])
  } finally {
    refuge.takeRefuge = real
  }
})

test('a respawn shut in behind the base\'s door takes the kit from its chests there and then, the night waited out in there, the death spot by day after; no second kit', async () => {
  const refuge = require('../../src/skills/refuge')
  const real = { shutInBase: refuge.shutInBase, findBaseDoor: refuge.findBaseDoor }
  const bot = fakeBot()
  bot.time = { timeOfDay: 18000 }
  bot.waitForTicks = async () => {}
  bot.blockAt = () => ({ name: 'air', boundingBox: 'empty' })
  bot.entities = {}
  const runner = new Runner(bot, { log: () => {} })
  const memory = runner.memory
  memory.setBase({ x: 0, y: 64, z: 4 })
  // killed by a zombie at night 20 blocks off, its items worth the trip
  memory.setDeath(new Vec3(20, 64, 0), 'overworld', false, true, 'zombie')
  const order: string[] = []
  ;(runner as any).refugeFirst = async () => { order.push('refuge'); return 'base' }
  ;(runner as any).rekit = async () => { order.push('kit'); return { stone_sword: 1 } }
  ;(runner as any).tripRekit = async () => null
  ;(runner as any).waitOutNight = async () => { order.push('night'); bot.time = { timeOfDay: 0 } }
  runner.executor.task = (async (name: string) => { order.push(name); return { items: { iron_pickaxe: 1 } } }) as any
  try {
    refuge.shutInBase = () => true
    refuge.findBaseDoor = () => null
    await runner.recoverFromDeath()
  } finally {
    Object.assign(refuge, real)
  }
  assert.deepEqual(order, ['refuge', 'kit', 'night', 'to the death spot'])
})

test('a death spot under the ground is gone back to for dear drops by the way down walked, the trip half the items\' time left at most; the reason a spot is skipped said (ls-26.3, t100061: slain at y 20 with diamond gear and iron armor, skipped)', async () => {
  const { deathSpotSkip, deathSpotTiming } = await import('../../src/runner')
  const air = (): { name: string } => ({ name: 'air' })
  // respawned at the base 50 blocks off the cave's mouth, the way down some 40 blocks long
  const now = { tick: 100100, dimension: 'overworld', position: new Vec3(40, 71, -7), minY: -64, blockAt: air }
  const way = [{ x: -9, y: 64, z: 30 }, ...Array.from({ length: 14 }, (_, k) => ({ x: -9, y: 61 - 3 * k, z: 30 - 2 * k }))]
  const death = { x: -9, y: 20, z: -4, dimension: 'overworld', seen: 100061, underground: true, worth: true, killer: 'zombie', dear: true, way }
  assert.equal(deathSpotSkip(death, now, 6000), null)
  assert.equal(deathSpotWorthIt(death, now, 6000), true)
  // nothing dear (cobblestone and torches), or no way down known: left, and said why
  assert.equal(deathSpotSkip({ ...death, dear: false }, now, 6000), 'underground, nothing dear')
  assert.equal(deathSpotSkip({ ...death, way: undefined }, now, 6000), 'underground, no way down known')
  // the trip over half the items' time left: left
  assert.match(String(deathSpotSkip({ ...death, seen: 100100 - 5000 }, now, 6000)), /the way down too long/)
  // the surface's reasons said too
  assert.equal(deathSpotSkip({ ...death, underground: false, killer: 'skeleton' }, { ...now, bare: true }, 6000), 'shot dead by a skeleton, back bare')
  assert.equal(deathSpotSkip({ ...death, worth: false }, now, 6000), 'nothing worth the trip')
  assert.equal(deathSpotSkip(null, now, 6000), 'no death spot')
  // under the ground the night is no reason to wait
  assert.equal(deathSpotTiming({ seen: 1900, killer: 'zombie', underground: true }, { tick: 2000, timeOfDay: 19920, dimension: 'overworld' }, 100, 6000), 'go')
})

test('the trip to a death spot under the ground: the base\'s kit first when it is by, to the way down\'s start, then along it, then the spot', async () => {
  const wayMod = require('../../src/skills/wayDown')
  const nav = require('../../src/skills/navigate')
  const pick = require('../../src/skills/pickupDrops')
  const real = { followWay: wayMod.followWay, navigateNear: nav.navigateNear, pickupDrops: pick.pickupDrops }
  const bot = fakeBot()
  bot.waitForTicks = async () => {}
  bot.blockAt = () => ({ name: 'air', boundingBox: 'empty' })
  bot.entities = {}
  bot.entity.position = new Vec3(2, 64, 2)
  const runner = new Runner(bot, { log: () => {} })
  const memory = runner.memory
  memory.setBase({ x: 0, y: 64, z: 4 })
  memory.setDeath(new Vec3(20, 20, 0), 'overworld', true, true, 'zombie', { dear: true, way: [{ x: 10, y: 64, z: 0 }, { x: 12, y: 60, z: 0 }, { x: 20, y: 20, z: 0 }] })
  const order: string[] = []
  ;(runner as any).refugeFirst = async () => null
  ;(runner as any).rekit = async () => { order.push('kit'); return { iron_sword: 1 } }
  runner.executor.task = (async (name: string, fn: (s: AbortSignal) => Promise<unknown>) => { order.push(name); return await fn(new AbortController().signal) }) as any
  try {
    nav.navigateNear = async (_b: any, at: Vec3) => { order.push(`near ${at.x} ${at.y} ${at.z}`) }
    wayMod.followWay = async (_b: any, rest: any[]) => { order.push(`along ${rest.length}`) }
    pick.pickupDrops = async () => ({ items: { diamond_sword: 1 } })
    await runner.recoverFromDeath()
  } finally {
    nav.navigateNear = real.navigateNear
    pick.pickupDrops = real.pickupDrops
    wayMod.followWay = real.followWay
  }
  assert.deepEqual(order, ['kit', 'to the death spot', 'near 10 64 0', 'along 2', 'near 20 20 0'])
  assert.equal(memory.death, null)
})

test('rekit: with the base\'s door in sight no pickaxe is made for the way in; without, one is (tests/integration/respawn: 12000 ticks exploring a plain for logs, the kit behind a door)', async () => {
  const refuge = require('../../src/skills/refuge')
  const nav = require('../../src/skills/navigate')
  const real = { findBaseDoor: refuge.findBaseDoor, pickaxeForTheWay: nav.pickaxeForTheWay, navigate: nav.navigate }
  const run = async (door: boolean): Promise<string[]> => {
    const bot = fakeBot()
    bot.blockAt = () => ({ name: 'air', boundingBox: 'empty' })
    const runner = new Runner(bot, { log: () => {} })
    const memory = runner.memory
    memory.setBase({ x: 20, y: 64, z: 1 })
    memory.addPoi('base_entrance', { x: 16, y: 64, z: 0 })
    memory.addPoi('base_bounds', { x: 17, y: 63, z: -2 }, 'overworld', '22,68,3')
    memory.rememberChest({ x: 20, y: 64, z: 1 }, { stone_sword: 1 })
    const asked: string[] = []
    runner.executor.obtain = (async (reqs: any[]) => { asked.push(String(reqs[0].item)) }) as any
    runner.executor.task = (async (name: string) => { asked.push(name) }) as any
    refuge.findBaseDoor = () => door ? { door: new Vec3(17, 64, 0), inside: new Vec3(18, 64, 0), outside: new Vec3(16, 64, 0) } : null
    nav.pickaxeForTheWay = async () => { asked.push('pickaxeForTheWay') }
    await runner.rekit()
    return asked
  }
  try {
    assert.deepEqual(await run(true), ['to the base', 'to the kit', 'kit'])
    assert.deepEqual(await run(false), ['pickaxeForTheWay', 'stone_pickaxe,wooden_pickaxe', 'to the base', 'to the kit', 'kit'])
  } finally {
    Object.assign(refuge, { findBaseDoor: real.findBaseDoor })
    Object.assign(nav, { pickaxeForTheWay: real.pickaxeForTheWay, navigate: real.navigate })
  }
})

test('a death spot\'s killers still about: given up killed by more than one with no better gear now, by a drowned in the water, in a cave not cave-ready, or died at twice (ls4-26.3, t386611: slain by four zombies in a cave at y -58, slain again going back; ls3b-1.21.11, t401692: impaled by a drowned in the sea, again going back)', async () => {
  const { deathSpotSkip, DEATH_SPOT_SAME } = await import('../../src/runner')
  const { gearScore } = await import('../../src/executor/keep')
  const { WorldMemory } = await import('../../src/core/memory')
  const air = (): { name: string } => ({ name: 'air' })
  const now = { tick: 386700, dimension: 'overworld', position: new Vec3(126, -58, -40), minY: -64, blockAt: air, caveReady: true }
  // the death's gear: an iron chestplate and an iron sword; back from the base in iron but the boots and with the sword
  const then = gearScore(['iron_chestplate', 'iron_sword'])
  const better = gearScore(['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_sword', 'shield'])
  assert.ok(better > then && gearScore([]) < then, `${gearScore([])} ${then} ${better}`)
  const death = { x: 126, y: -58, z: -77, dimension: 'overworld', seen: 386611, underground: true, worth: true, killer: 'zombie', dear: true, way: [{ x: 126, y: -50, z: -60 }], killers: 4, gear: then }
  assert.match(String(deathSpotSkip(death, { ...now, gear: then }, 6000)), /killed by 4 mobs \(zombie\), no better armed now/)
  assert.match(String(deathSpotSkip(death, { ...now, gear: gearScore(['iron_sword']) }, 6000)), /no better armed now/)
  // better armed: gone back to; a lone zombie: gone back to
  assert.equal(deathSpotSkip(death, { ...now, gear: better }, 6000), null)
  assert.equal(deathSpotSkip({ ...death, killers: 1 }, { ...now, gear: then }, 6000), null)
  // in a cave and not fit for the caves: left; a death in its own tunnel (no cave) is gone back to
  assert.equal(deathSpotSkip({ ...death, cave: true }, { ...now, gear: better, caveReady: false }, 6000), 'in a cave, not cave-ready')
  assert.equal(deathSpotSkip({ ...death, cave: false }, { ...now, gear: better, caveReady: false }, 6000), null)
  // a drowned in the water: left, whatever the gear
  assert.equal(deathSpotSkip({ ...death, underground: false, killer: 'drowned', killers: 1, inWater: true }, { ...now, gear: better }, 6000), 'killed by a drowned in the water')
  assert.equal(deathSpotSkip({ ...death, underground: false, killer: 'drowned', killers: 1, inWater: false }, { ...now, gear: better }, 6000), null)
  // died there before: given up
  const memory = new WorldMemory()
  memory.setDeath({ x: 126, y: -58, z: -77 }, 'overworld', true, true, 'zombie', { killers: 4 })
  assert.equal(memory.deathsNear({ x: 126, y: -58, z: -77 }, 'overworld', DEATH_SPOT_SAME), 0)
  memory.setDeath({ x: 128, y: -54, z: -69 }, 'overworld', true, true, 'zombie', { killers: 3 })
  const before = memory.deathsNear(memory.death!, 'overworld', DEATH_SPOT_SAME)
  assert.equal(before, 1)
  assert.equal(deathSpotSkip({ ...death, before }, { ...now, gear: better }, 6000), 'died there 2 times')
  // the deaths kept over a save
  const again = WorldMemory.fromJSON(JSON.parse(JSON.stringify(memory.toJSON())))
  assert.equal(again.deathsNear(again.death!, 'overworld', DEATH_SPOT_SAME), 1)
  assert.equal(again.death?.killers, 3)
})

test('a death after a milestone (the herd\'s upkeep, the store at the base: afterTrip) goes to the recovery, and play goes on (ls3c-1.21.11, t390765: drowned getting the herd\'s kelp, \'play threw: the bot died\')', async () => {
  const bot = fakeBot()
  const logs: string[] = []
  const runner = new Runner(bot, { handlers: { wood: async () => { bot.give('wooden_pickaxe', 1); bot.give('crafting_table', 1) } }, until: 'wood', log: (l: string) => logs.push(l) })
  let trips = 0
  ;(runner as any).afterTrip = async () => {
    trips++
    if (trips === 1) throw new TaskError('DIED', 'the bot died')
  }
  let recovered = 0
  ;(runner as any).recover = async () => { recovered++ }
  const r = await runner.play()
  assert.equal(recovered, 1)
  assert.equal(r.reason, 'until')
  assert.ok(logs.some(l => /died after wood/.test(l)), logs.join('\n'))
})

test('deathSpotSkip: a spot the bot drowned at, its drops under the water, isn\'t gone back to; one with a dry stand by the drops is (f1-grim)', async () => {
  const { deathSpotSkip, dropsUnderWater } = await import('../../src/runner')
  const { Vec3 } = await import('vec3')
  // the sea from y 50 to 62 over x < 0; the shore's ground at y 62 for x >= 0, air over it
  const sea = (p: any): { name: string } => ({ name: p.x < 0 && p.y >= 50 && p.y <= 62 ? 'water' : p.y <= 62 ? 'stone' : 'air' })
  const deep = { x: -10, y: 50, z: 0, dimension: 'overworld', seen: 0, drowned: true, inWater: true, worth: true } as any
  const now: any = { tick: 100, dimension: 'overworld', position: new Vec3(5, 63, 0), minY: -64, blockAt: sea }
  assert.equal(dropsUnderWater(sea, deep), true)
  assert.equal(deathSpotSkip(deep, now, 6000), 'drowned there, the drops under the water')
  // by the shore: the drops a reach from the dry ground
  const shore = { ...deep, x: -1, y: 62 }
  assert.equal(dropsUnderWater(sea, shore), false)
  assert.notEqual(deathSpotSkip(shore, now, 6000), 'drowned there, the drops under the water')
})

test('bedLater: a base built without its bed (no wool near then) gets it once the bed\'s wool is near, tried every BED_LATER_TICKS at most; none for a base with its bed', async () => {
  const { BED_LATER_TICKS } = await import('../../src/runner')
  const { BASE_POI } = await import('../../src/base/pois')
  const { BED_NOW_TICKS } = await import('../../src/base/build')
  const bot = fakeBot()
  const lines: string[] = []
  const runner = new Runner(bot, { log: l => lines.push(l) })
  const memory = bot.survival.memory as WorldMemory
  memory.setBase({ x: 0, y: 60, z: 0 }, 'overworld')
  memory.addPoi(BASE_POI.build, { x: 0, y: 60, z: 0 }, 'overworld', '1/40/1/0')
  let planned = 0
  let cost = BED_NOW_TICKS + 100
  ;(runner.executor as any).plan = () => { planned++; return { ok: true, cost, steps: [] } }
  await runner.bedLater()
  assert.equal(planned, 1)
  assert.ok(lines.some(l => l.startsWith('base bed: no bed for now')), lines.join('\n'))
  // again at once: not tried
  await runner.bedLater()
  assert.equal(planned, 1)
  // BED_LATER_TICKS on, a sheep in sight: got (the fake obtain gives the bed), then put in (the build: stopped here)
  for (let i = 0; i < BED_LATER_TICKS; i++) bot.survival.tasks.tick++
  cost = 500
  ;(runner.executor as any).obtain = async () => { bot.give('white_bed', 1); return { plans: 1, steps: 1 } }
  await runner.bedLater().catch(() => {})
  assert.equal(planned, 2)
  assert.ok(lines.includes('base bed: put in'), lines.join('\n'))
  // the base with its bed: nothing
  memory.addPoi(BASE_POI.bed, { x: 1, y: 60, z: 1 }, 'overworld')
  for (let i = 0; i < BED_LATER_TICKS; i++) bot.survival.tasks.tick++
  await runner.bedLater()
  assert.equal(planned, 2)
})

test('bare after the wood (no pickaxe: a re-equip that failed), no milestone work: the kit and the basics tried again, with a backoff, the work waiting (f4-26.3, t107263: 165000 ticks of the enchanting\'s work with dirt and gravel)', async () => {
  const { bareForWork, bareBackoffTicks, BARE_BACKOFF_TICKS, BARE_BACKOFF_MAX, woodSurveyRadius, WOOD_SURVEY_RADIUS, WOOD_SURVEY_MAX } = await import('../../src/runner')
  assert.equal(bareBackoffTicks(0), BARE_BACKOFF_TICKS)
  assert.equal(bareBackoffTicks(1), 2 * BARE_BACKOFF_TICKS)
  assert.equal(bareBackoffTicks(10), BARE_BACKOFF_MAX)
  assert.equal(woodSurveyRadius(0), WOOD_SURVEY_RADIUS)
  assert.equal(woodSurveyRadius(5), WOOD_SURVEY_MAX)
  const bot = fakeBot({ wooden_pickaxe: 1, crafting_table: 1 })
  assert.equal(bareForWork(bot, []), false)
  assert.equal(bareForWork(bot, ['wood']), false)
  let stoneWork = 0
  const runner = new Runner(bot, {
    maxTicks: 3000,
    log: () => {},
    handlers: {
      // the stone's work loses the pickaxe (a death's drops left)
      stone: async () => { stoneWork++; bot.give('wooden_pickaxe', -1) }
    }
  })
  let reequips = 0
  ;(runner as any).rekit = async () => null
  ;(runner as any).reequip = async () => { reequips++ }
  const result = runner.play()
  for (let i = 0; i < 3100; i++) { bot.emit('physicsTick'); await new Promise(resolve => setImmediate(resolve)) }
  const r = await result
  assert.equal(r.reason, 'budget')
  assert.equal(stoneWork, 1)
  // at once, then after 1200 (the next at 3600, past the budget)
  assert.equal(reequips, 2)
})

test('a re-equip with no wood found surveys for trees further out, and tries the goal again once (f4-26.3, t106821: no oak_log found exploring, each re-equip)', async () => {
  const bot = fakeBot()
  const logs: string[] = []
  const runner = new Runner(bot, { log: (l: string) => logs.push(l) })
  let tries = 0
  ;(runner as any).executor.obtain = async (goals: any[]) => {
    if (goals[0].item !== 'stone_pickaxe') return
    tries++
    if (tries === 1) throw new TaskError('NOT_FOUND', 'NOT_FOUND: no oak_log found exploring')
    bot.give('stone_pickaxe', 1)
  }
  let surveys = 0
  ;(runner as any).woodSurvey = async () => { surveys++; return true }
  ;(runner as any).nightOutFirst = async () => {}
  await runner.reequip()
  assert.equal(surveys, 1)
  assert.equal(tries, 2)
  assert.ok(logs.some(l => /no stone_pickaxe: NOT_FOUND/.test(l)), logs.join('\n'))
})

test('a meal under the cave rule begins under the open sky: up by the rock first (ensureSurface), no meal from underground with no way up but a cave; none on the surface (f5-26.3: cave spiders at y 27)', async () => {
  const explore = require('../../src/executor/explore')
  const real = explore.ensureSurface
  const asked: number[] = []
  let way = false
  explore.ensureSurface = async (b: any) => { asked.push(Math.floor(b.entity.position.y)); return way }
  try {
    const bot = fakeBot()
    bot.entity.position = new Vec3(0.5, 30, 0.5)
    bot.blockAt = (p: Vec3) => ({ name: p.y < 64 ? 'stone' : 'air', position: p, boundingBox: p.y < 64 ? 'block' : 'empty' })
    bot.game.dimension = 'overworld'
    const runner: any = new Runner(bot, { log: () => {} })
    const signal = new AbortController().signal
    await assert.rejects(runner.upForFood(signal), /no way up but through a cave/)
    way = true
    await runner.upForFood(signal)
    assert.deepEqual(asked, [30, 30])
    // on the surface: nothing to do
    bot.entity.position = new Vec3(0.5, 70, 0.5)
    await runner.upForFood(signal)
    assert.equal(asked.length, 2)
  } finally {
    explore.ensureSurface = real
  }
})

test('a spare kit for the base gives way to a meal when hungry, and is held to SPARE_KIT_TICKS: none stored then (f5-1.21.11: 76000 ticks for its food, starved to 0.08 health)', async () => {
  const { SPARE_KIT_TICKS } = await import('../../src/runner')
  for (const hungry of [true, false]) {
    const bot = fakeBot({ iron_pickaxe: 1, iron_sword: 1, iron_axe: 1 })
    bot.food = hungry ? 5 : 20
    bot.survival.memory.setBase({ x: 0, y: 64, z: 0 })
    bot.survival.memory.rememberChest({ x: 2, y: 64, z: 0 }, {}, 'overworld')
    const lines: string[] = []
    const runner: any = new Runner(bot, { log: (l: string) => lines.push(l) })
    let stored = 0
    let ticks = 0
    runner.executor.obtain = async (_goals: any, s: AbortSignal) => await new Promise((_resolve, reject) => { s.addEventListener('abort', () => reject(s.reason), { once: true }) })
    runner.executor.storeExact = async () => { stored++ }
    runner.nightDue = () => null
    const ticking = setInterval(() => { for (let i = 0; i < 400; i++) { ticks++; bot.emit('physicsTick') } }, 1)
    try {
      await runner.stashSpareKit(new AbortController().signal)
    } finally {
      clearInterval(ticking)
    }
    assert.equal(stored, 0)
    if (hungry) {
      assert.ok(lines.some(l => /a spare kit for the base: hungry, a meal first/.test(l)), lines.join('\n'))
      assert.ok(ticks < 2000, String(ticks))
    } else {
      assert.ok(lines.some(l => new RegExp(`out of its ${SPARE_KIT_TICKS} ticks`).test(l)), lines.join('\n'))
    }
  }
})

test('the spare kit after a recovery is its tools alone, within SPARE_KIT_RECOVERY_TICKS, and no spare kit asks for food from a bot short of its own (f5-1.21.11, t312126, t385877, t1206281: a starving bot back from a death explored for animals for the base\'s spare food, and died again)', async () => {
  const { SPARE_KIT_RECOVERY_TICKS } = await import('../../src/runner')
  assert.ok(SPARE_KIT_RECOVERY_TICKS > 0)
  // back with a stone pickaxe and sword, no food; the base's chest empty
  const bot = fakeBot({ stone_pickaxe: 1, stone_sword: 1 })
  const runner = new Runner(bot, { log: () => {} })
  const memory = (runner as any).memory as WorldMemory
  memory.setBase({ x: 0, y: 64, z: 0 })
  memory.rememberChest({ x: 1, y: 64, z: 0 }, {})
  const asked: any[] = []
  ;(runner as any).executor.obtain = async (goals: any[]) => { asked.push(...goals) }
  ;(runner as any).executor.storeExact = async () => {}
  await (runner as any).spareKitAfterRecovery()
  assert.ok(asked.length > 0, 'the tools asked for')
  assert.ok(asked.every(g => g.unit !== 'nutrition'), JSON.stringify(asked))
  // the afterTrip's stash with the bot's own food short: no food asked for either; with its food in the bag, it is
  asked.length = 0
  await runner.stashSpareKit()
  assert.ok(asked.every(g => g.unit !== 'nutrition'), JSON.stringify(asked))
  bot.give('cooked_beef', 10)
  asked.length = 0
  await runner.stashSpareKit()
  assert.ok(asked.some(g => g.unit === 'nutrition'), JSON.stringify(asked))
})

test('a milestone not ready past maxFailures of NOT_READY_TRIES each never ends play: backed off, tried again till its kit comes (f3k-run5, f4-run2 stopped at the nether gate)', async () => {
  const { SkillError } = await import('../../src/skills/errors')
  const { NOT_READY_TRIES } = await import('../../src/runner')
  const bot = fakeBot()
  let calls = 0
  const logs: string[] = []
  const short = NOT_READY_TRIES * 2 + 3
  const runner = new Runner(bot, {
    until: 'wood',
    log: (l: string) => logs.push(l),
    maxFailures: 2,
    handlers: {
      wood: async () => {
        calls++
        if (calls <= short) throw Object.assign(new SkillError('MISSING_ITEMS', 'not going into the nether without a bow or 3 water bottles for fire resistance'), { notReady: true })
        bot.give('wooden_pickaxe', 1)
        bot.give('crafting_table', 1)
      }
    }
  })
  const ticking = setInterval(() => { for (let i = 0; i < 200; i++) bot.emit('physicsTick') }, 1)
  let r: any
  try {
    r = await runner.play()
  } finally {
    clearInterval(ticking)
  }
  assert.equal(r.reason, 'until', logs.slice(-5).join('\n'))
  assert.equal(calls, short + 1)
  assert.ok(logs.some(l => /milestone wood still not ready after 2 failures: backing off/.test(l)), logs.filter(l => /failed|still/.test(l)).join('\n'))
})

test('roomForTopUps: a bag short of the stock\'s free slots stores at the base first; with room, or no base, nothing', async () => {
  const bot = fakeBot()
  const runner = new Runner(bot, { log: () => {}, executor: { log: () => {} } })
  let stored = 0
  ;(runner as any).executor.storeAtBase = async () => { stored++; return { dirt: 64 } }
  bot.inventory.emptySlotCount = () => 4
  await runner.roomForTopUps()
  assert.equal(stored, 0)
  bot.survival.memory.setBase({ x: 0, y: 64, z: 0 })
  bot.survival.memory.rememberChest({ x: 1, y: 64, z: 0 }, {})
  await runner.roomForTopUps()
  assert.equal(stored, 1)
  bot.inventory.emptySlotCount = () => 20
  await runner.roomForTopUps()
  assert.equal(stored, 1)
})

test('starving (food 6 or under, nothing to eat carried) cuts any work under way, a long milestone task too, no failure counted; food is the only work till the bar is over 12, then the work goes on (f5-1.21.11: starved twice under a tool\'s replacement and a spare kit)', async () => {
  const bot = fakeBot()
  bot.blockAt = (p: Vec3) => ({ name: p.y < 64 ? 'stone' : 'air', position: p, boundingBox: p.y < 64 ? 'block' : 'empty' })
  bot.food = 20
  const logs: string[] = []
  const calls: string[] = []
  let cutReason = ''
  const runner: any = new Runner(bot, {
    until: 'wood',
    log: (l: string) => logs.push(l),
    handlers: {
      wood: async ({ signal }: any) => {
        calls.push(`wood at food ${bot.food}`)
        if (calls.length === 1) {
          // a long task: the bar runs down to 4 under it, nothing to eat carried
          bot.food = 4
          await new Promise<void>((_resolve, reject) => { signal.addEventListener('abort', () => { cutReason = String(signal.reason?.message ?? signal.reason); reject(signal.reason) }, { once: true }) })
          return
        }
        bot.give('wooden_pickaxe', 1)
        bot.give('crafting_table', 1)
      }
    }
  })
  runner.toFoodLand = async () => {}
  let meals = 0
  runner.executor.obtain = async (reqs: any[]) => {
    if (reqs.some(r => r.unit === 'nutrition')) {
      meals++
      calls.push(`meal at food ${bot.food}`)
      // the first meal gets the bar to 10 only (still under 13: food first again), the second to 20
      bot.food = meals === 1 ? 10 : 20
    }
    return { plans: 0, steps: 0 }
  }
  const ticking = setInterval(() => { for (let i = 0; i < 200; i++) bot.emit('physicsTick') }, 1)
  let r: any
  try {
    r = await runner.play()
  } finally {
    clearInterval(ticking)
  }
  assert.equal(r.reason, 'until', logs.join(' | '))
  assert.match(cutReason, /starving: food first/)
  assert.deepEqual(calls, ['wood at food 20', 'meal at food 4', 'meal at food 10', 'wood at food 20'])
  assert.ok(!logs.some(l => /milestone wood failed/.test(l)), logs.join(' | '))
  assert.ok(logs.some(l => /the work stopped for food/.test(l)), logs.join(' | '))
})

test('the upkeep between trips tends the farm before the herd (keepFarm: started, harvested, baked, grown), by day once food is reached', async () => {
  const milestones = require('../../src/milestones')
  const realFarm = milestones.keepFarm
  const realHerd = milestones.tendHerd
  const order: string[] = []
  milestones.keepFarm = async () => { order.push('farm'); return 0 }
  milestones.tendHerd = async () => { order.push('herd'); return 0 }
  try {
    const bot = fakeBot()
    const runner: any = new Runner(bot, { log: () => {}, handlers: {} })
    // no food milestone yet: nothing
    await runner.keepHerd()
    assert.deepEqual(order, [])
    runner.reached.push({ id: 'food', tick: 0, wallMs: 0 })
    runner.herdTendedAt = -Infinity
    await runner.keepHerd()
    assert.deepEqual(order, ['farm', 'herd'])
    // by night: none
    runner.herdTendedAt = -Infinity
    bot.time.timeOfDay = 18000
    await runner.keepHerd()
    assert.deepEqual(order, ['farm', 'herd'])
  } finally {
    milestones.keepFarm = realFarm
    milestones.tendHerd = realHerd
  }
})

test('a meal goes to the home\'s food first (a grown farm harvested and baked) and to no food land nor hunt once fed by it; with none at home, the food land and the meal\'s plans (f5-1.21.11: meals hunted 170 blocks off)', async () => {
  const milestones = require('../../src/milestones')
  const { mealGoals } = await import('../../src/planner/progression')
  const { ownedInventory } = await import('../../src/executor/executor')
  const realHarvest = milestones.harvestGrownFarms
  const realTend = milestones.tendHerd
  try {
    const bot = fakeBot()
    bot.food = 8
    const runner: any = new Runner(bot, { log: () => {}, handlers: {} })
    const calls: string[] = []
    runner.upForFood = async () => { calls.push('up') }
    runner.toFoodLand = async () => { calls.push('food land') }
    runner.executor.obtain = async () => { calls.push('obtain') }
    runner.executor.farmCost = () => 0
    let yieldBread = 5
    milestones.harvestGrownFarms = async () => { calls.push('harvest'); bot.give('bread', yieldBread); return yieldBread }
    const meal = (): any => mealGoals(bot.food, ownedInventory(bot))
    // no farm: the food land and the meal's plans
    await runner.getMeal(meal(), new AbortController().signal)
    assert.deepEqual(calls, ['up', 'food land', 'obtain'])
    // a farm grown by home: harvested and baked, 5 bread: no food land, no plan
    bot.survival.memory.addPoi('farm', { x: 10, y: 63, z: 10 }, 'overworld', JSON.stringify({ crop: 'wheat', cells: [[11, 63, 10]], sown: 0 }))
    calls.length = 0
    await runner.getMeal(meal(), new AbortController().signal)
    assert.deepEqual(calls, ['up', 'harvest'])
    // the harvest gave nothing: on to the food land after it
    bot.give('bread', -5)
    yieldBread = 0
    calls.length = 0
    await runner.getMeal(meal(), new AbortController().signal)
    assert.deepEqual(calls, ['up', 'harvest', 'food land', 'obtain'])
    // a farm not grown yet (its growing ahead): not gone to
    runner.executor.farmCost = () => 30000
    calls.length = 0
    await runner.getMeal(meal(), new AbortController().signal)
    assert.deepEqual(calls, ['up', 'food land', 'obtain'])
    // a herd of 5 out of sight, 100 off (2 beyond its breeders, as remembered): its surplus slaughtered and cooked first
    bot.survival.memory.addPoi('herd', { x: 100, y: 64, z: 0 }, 'overworld', JSON.stringify({ mob: 'cow', adults: 5, calves: 0, bred: null }))
    bot.entities = {}
    milestones.tendHerd = async () => { calls.push('herd'); bot.give('cooked_beef', 2); return 16 }
    calls.length = 0
    await runner.getMeal(meal(), new AbortController().signal)
    assert.deepEqual(calls, ['up', 'herd'])
  } finally {
    milestones.harvestGrownFarms = realHarvest
    milestones.tendHerd = realTend
  }
})

test('the farm watch: by day, the bot within 32 of its farm with 3 plots ripe, the round of work cut for the harvest (no failure), again only after FARM_PASS_TICKS; not far off, nor by night, nor with 2 ripe', async () => {
  const { FARM_WATCH_EVERY, FARM_PASS_TICKS } = await import('../../src/runner')
  const bot = fakeBot()
  const runner: any = new Runner(bot, { log: () => {}, handlers: {} })
  const cells = [[10, 63, 0], [11, 63, 0], [12, 63, 0], [13, 63, 0]]
  bot.survival.memory.addPoi('farm', { x: 10, y: 63, z: 1 }, 'overworld', JSON.stringify({ crop: 'wheat', cells, sown: 0 }))
  let ripe = 3
  bot.blockAt = (p: any) => {
    const i = cells.findIndex(([x, y, z]) => x === p.x && y + 1 === p.y && z === p.z)
    if (i >= 0) return { name: 'wheat', getProperties: () => ({ age: i < ripe ? 7 : 3 }) }
    return { name: 'air' }
  }
  let tick = 10000
  Object.defineProperty(runner, 'tick', { get: () => tick })
  const off = runner.watchFarm()
  const look = (): void => { for (let i = 0; i < FARM_WATCH_EVERY; i++) bot.emit('physicsTick') }
  try {
    runner.roundCtrl = new AbortController()
    look()
    assert.equal(runner.roundCtrl.signal.aborted, true)
    assert.equal(runner.farmDue, true)
    assert.equal(runner.cutForFood, true)
    // the next look within FARM_PASS_TICKS: none
    runner.farmDue = false
    runner.roundCtrl = new AbortController()
    tick += FARM_PASS_TICKS - 1
    look()
    assert.equal(runner.roundCtrl.signal.aborted, false)
    // far off, by night, or 2 ripe: none
    tick += FARM_PASS_TICKS
    bot.entity.position = new Vec3(60, 64, 0)
    look()
    assert.equal(runner.roundCtrl.signal.aborted, false)
    bot.entity.position = new Vec3(0, 64, 0)
    bot.time.timeOfDay = 18000
    look()
    assert.equal(runner.roundCtrl.signal.aborted, false)
    bot.time.timeOfDay = 1000
    ripe = 2
    look()
    assert.equal(runner.roundCtrl.signal.aborted, false)
    ripe = 3
    look()
    assert.equal(runner.roundCtrl.signal.aborted, true)
  } finally {
    off()
  }
})

test('back by home after a trip: the farm 60 off with 3 plots ripe harvested first, whatever the upkeep\'s cadence or the hour; none ripe, not', async () => {
  const bot = fakeBot()
  const runner: any = new Runner(bot, { log: () => {}, handlers: {} })
  const cells = [[60, 63, 0], [61, 63, 0], [62, 63, 0]]
  bot.survival.memory.addPoi('farm', { x: 60, y: 63, z: 1 }, 'overworld', JSON.stringify({ crop: 'wheat', cells, sown: 0 }))
  let ripe = 3
  bot.blockAt = (p: any) => {
    const i = cells.findIndex(([x, y, z]) => x === p.x && y + 1 === p.y && z === p.z)
    return i >= 0 ? { name: 'wheat', getProperties: () => ({ age: i < ripe ? 7 : 2 }) } : { name: 'air' }
  }
  bot.time.timeOfDay = 18000
  const calls: string[] = []
  runner.harvestPassing = async () => { calls.push('harvest') }
  runner.keepHerd = async () => { calls.push('upkeep') }
  await runner.afterTrip(new AbortController().signal)
  assert.deepEqual(calls, ['harvest', 'upkeep'])
  ripe = 1
  calls.length = 0
  await runner.afterTrip(new AbortController().signal)
  assert.deepEqual(calls, ['upkeep'])
})

test('each line of play\'s log is told as survivalLog too, after the log option has it (a recorder\'s)', async () => {
  const bot = fakeBot()
  const order: string[] = []
  bot.on('survivalLog', (line: string) => order.push(`event: ${line}`))
  const handlers = { wood: async () => { bot.give('wooden_pickaxe', 1); bot.give('crafting_table', 1) } }
  await new Runner(bot, { handlers, until: 'wood', log: line => order.push(`log: ${line}`) }).play()
  assert.ok(order.length >= 4, String(order))
  for (let i = 0; i < order.length; i += 2) {
    assert.match(order[i], /^log: /)
    assert.equal(order[i + 1], `event: ${order[i].slice('log: '.length)}`)
  }
  assert.ok(order.some(l => /^event: working on wood/.test(l)))
})
