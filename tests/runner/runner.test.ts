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
    stone: give({ stone_pickaxe: 1, stone_sword: 1, stone_axe: 1, furnace: 1 }),
    food: give({ cooked_beef: 8 }),
    base: async () => { worked.push('base'); bot.survival.memory.setBase({ x: 0, y: 40, z: 0 }) },
    iron: give({ iron_pickaxe: 1, iron_sword: 1, iron_helmet: 1, iron_chestplate: 1, iron_leggings: 1, iron_boots: 1, shield: 1, bucket: 1 }),
    diamonds: give({ diamond_pickaxe: 1, diamond_sword: 1 }),
    enchanting: async () => { worked.push('enchanting'); bot.survival.memory.addPoi('enchanting_table', { x: 1, y: 40, z: 1 }); enchantedPick.done = true }
  }
  const runner = new Runner(bot, { handlers, stopAt: 'nether', log: () => {} })
  // the enchanted check reads item.enchants: the fake's pickaxe gets one once the handler ran
  const items = bot.inventory.items
  bot.inventory.items = () => items().map((i: any) => i.name === 'diamond_pickaxe' && enchantedPick.done ? { ...i, enchants: [{ name: 'efficiency', lvl: 1 }] } : i)
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
      stone: async () => { bot.give('stone_pickaxe', 1); bot.give('stone_sword', 1); bot.give('stone_axe', 1); bot.give('furnace', 1) }
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
  const bot2 = fakeBot({ wooden_pickaxe: 1, crafting_table: 1, stone_pickaxe: 1, stone_sword: 1, stone_axe: 1, furnace: 1 })
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

test('netherNeeds: the rods and pearls still wanted for the eyes', async () => {
  const { netherNeeds } = await import('../../src/milestones')
  const inv = (items: Record<string, number>) => ({ count: (n: string) => items[n] ?? 0 })
  assert.deepEqual(netherNeeds(inv({})), { rods: 7, pearls: 14 })
  assert.deepEqual(netherNeeds(inv({ blaze_rod: 3, ender_pearl: 10, ender_eye: 2 })), { rods: 3, pearls: 2 })
  assert.deepEqual(netherNeeds(inv({ ender_eye: 14 })), { rods: 0, pearls: 0 })
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
    stone: give({ stone_pickaxe: 1, stone_sword: 1, stone_axe: 1, furnace: 1 }),
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
        bot.give('wooden_pickaxe', 1)
        bot.give('crafting_table', 1)
      }
    }
  })
  await runner.play()
  assert.deepEqual(lines.filter(l => l.startsWith('reflex')), ['reflex drowning', 'reflex drowning 4 times more', 'reflex eat'])
})

test('the death messages are told from the other system lines about the bot', async () => {
  const { isDeathMessage } = await import('../../src/runner')
  assert.equal(isDeathMessage('miner fell from a high place'), true)
  assert.equal(isDeathMessage('miner was slain by Zombie'), true)
  assert.equal(isDeathMessage('miner has made the advancement [Stone Age]'), false)
  assert.equal(isDeathMessage('miner joined the game'), false)
})

test('dusk cuts the day\'s work off for the night\'s mine, and the milestone goes on after', async () => {
  const bot = fakeBot({ wooden_pickaxe: 1, crafting_table: 1, stone_pickaxe: 1, stone_sword: 1, stone_axe: 1, furnace: 1, torch: 20, cooked_beef: 8, shield: 1, oak_log: 4, coal: 5 })
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
  const bot = fakeBot({ wooden_pickaxe: 1, cooked_beef: 8 })
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
  const bot = fakeBot({ wooden_pickaxe: 1, crafting_table: 1, stone_pickaxe: 1, stone_sword: 1, stone_axe: 1, furnace: 1, cooked_beef: 8 })
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
