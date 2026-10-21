// The bag's keeper (skills/bag.ts): room made at the skills' safe points while an executor task holds the bag.
import { test } from 'node:test'
import assert from 'node:assert'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { BAG_HOSTILE_DY, BAG_HOSTILE_RANGE, bagKeeper, bagShort, bagThreat, bagUnsafe, holdBag, keepRoom, unwantedDrop, type BagKeeper } from '../../src/skills/bag'
import { entity, fakeBot, item } from '../reflexes/fakeBot'

/** a fake bot whose 36 slots hold `stacks` stacks of cobblestone (the rest empty) */
function bagBot (stacks: number, extra: any[] = []): any {
  const items = [...extra]
  for (let i = 0; i < stacks; i++) items.push(item('cobblestone', 64))
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), items })
  bot.inventory.inventoryStart = 9
  bot.inventory.inventoryEnd = 45
  bot._client = { on: () => {}, off: () => {} }
  return bot
}

/** a keeper that frees `frees` slots each time it's asked (the bag's last cobblestone stacks emptied), counting */
function keeper (bot: any, opts: { minFree?: number, frees?: number, unwanted?: (name: string) => boolean } = {}): BagKeeper & { calls: AbortSignal[] } {
  const calls: AbortSignal[] = []
  return {
    calls,
    minFree: opts.minFree ?? 2,
    unwanted: opts.unwanted ?? (() => false),
    room: async (signal) => {
      calls.push(signal)
      let left = opts.frees ?? 2
      for (let s = 44; s >= 9 && left > 0; s--) {
        if (bot.inventory.slots[s]?.name === 'cobblestone') { bot.inventory.slots[s] = null; left-- }
      }
    }
  }
}

test('keepRoom: the keeper holding the bag makes room when fewer than its free slots are, with its task\'s signal; nothing with room enough, or no keeper', async () => {
  const bot = bagBot(35)
  // no keeper: nothing
  assert.strictEqual(await keepRoom(bot), false)
  assert.strictEqual(bagKeeper(bot), null)
  const k = keeper(bot)
  const task = new AbortController()
  const release = holdBag(bot, k, task.signal)
  assert.strictEqual(bagKeeper(bot), k)
  assert.strictEqual(bagShort(bot), true)
  assert.strictEqual(await keepRoom(bot), true)
  assert.strictEqual(k.calls.length, 1)
  assert.strictEqual(k.calls[0], task.signal)
  // 3 free now: room enough
  assert.strictEqual(bagShort(bot), false)
  assert.strictEqual(await keepRoom(bot), false)
  assert.strictEqual(k.calls.length, 1)
  release()
  assert.strictEqual(bagKeeper(bot), null)
})

test('keepRoom: not entered again from the room\'s own walks and digs; a preempted task\'s keeper (its signal aborted) makes no room for the reflex that runs meanwhile', async () => {
  const bot = bagBot(36)
  let nested: boolean | null = null
  const k: BagKeeper = {
    minFree: 2,
    unwanted: () => false,
    room: async () => { nested = await keepRoom(bot) }
  }
  const task = new AbortController()
  const release = holdBag(bot, k, task.signal)
  assert.strictEqual(await keepRoom(bot), true)
  assert.strictEqual(nested, false)
  // the task preempted: its hold is passed over
  task.abort()
  assert.strictEqual(bagKeeper(bot), null)
  assert.strictEqual(await keepRoom(bot), false)
  release()
  // an aborted caller's signal throws
  const live = new AbortController()
  holdBag(bot, keeper(bot), live.signal)
  const stopped = new AbortController()
  stopped.abort()
  await assert.rejects(keepRoom(bot, stopped.signal))
})

test('unwantedDrop: what the holding keeper says no to; nothing without one', () => {
  const bot = bagBot(0)
  assert.strictEqual(unwantedDrop(bot, 'cobblestone'), false)
  const task = new AbortController()
  const release = holdBag(bot, keeper(bot, { unwanted: n => n === 'cobblestone' }), task.signal)
  assert.strictEqual(unwantedDrop(bot, 'cobblestone'), true)
  assert.strictEqual(unwantedDrop(bot, 'obsidian'), false)
  release()
  assert.strictEqual(unwantedDrop(bot, 'cobblestone'), false)
})

/** a pickup rig: an item entity at `at`, walked onto by the pathfinder's goto (into the first empty slot) */
function pickupRig (bot: any, name: string, at: Vec3): { trips: () => number } {
  const registry = require('minecraft-data')('1.21.11')
  const Item = require('prismarine-item')('1.21.11')
  bot.time = { age: 1000 }
  bot.entities[70] = { id: 70, name: 'item', position: at, getDroppedItem: () => new Item(registry.itemsByName[name].id, 1) }
  let trips = 0
  bot.pathfinder = {
    isPathing: false,
    goto: async () => {
      trips++
      for (let s = 9; s < 45; s++) {
        if (bot.inventory.slots[s] == null) { bot.inventory.slots[s] = new Item(registry.itemsByName[name].id, 1); bot.inventory.slots[s].slot = s; delete bot.entities[70]; return }
      }
    },
    cancel: async () => {},
    world: {}
  }
  return { trips: () => trips }
}

test('pickupDrops with a full bag has the keeper make room before it says NO_SPACE: obsidian by a 26.3 deep lake, the bag full of the walk\'s cobblestone', async () => {
  const { pickupDrops } = await import('../../src/skills/pickupDrops')
  {
    // no keeper: NO_SPACE as before
    const alone = bagBot(36)
    pickupRig(alone, 'obsidian', new Vec3(1.5, 64, 0.5))
    await assert.rejects(pickupDrops(alone, { near: new Vec3(1, 64, 0), names: ['obsidian'] }), (err: any) => err.reason === 'NO_SPACE')
    // a keeper: room made, the obsidian picked up
    const bot = bagBot(36)
    const rig = pickupRig(bot, 'obsidian', new Vec3(1.5, 64, 0.5))
    const k = keeper(bot)
    const task = new AbortController()
    const release = holdBag(bot, k, task.signal)
    const tick = setInterval(() => bot.emit('physicsTick'), 1)
    try {
      const res = await pickupDrops(bot, { near: new Vec3(1, 64, 0), names: ['obsidian'] }, task.signal)
      assert.deepStrictEqual(res.items.obsidian, 1)
      assert.strictEqual(k.calls.length >= 1, true)
      assert.ok(rig.trips() >= 1)
    } finally {
      clearInterval(tick)
      release()
    }
    // a keeper that can make none: asked once, then NO_SPACE (no loop)
    const stuck = bagBot(36)
    pickupRig(stuck, 'obsidian', new Vec3(1.5, 64, 0.5))
    const none = keeper(stuck, { frees: 0 })
    const t2 = new AbortController()
    const r2 = holdBag(stuck, none, t2.signal)
    try {
      await assert.rejects(pickupDrops(stuck, { near: new Vec3(1, 64, 0), names: ['obsidian'] }, t2.signal), (err: any) => err.reason === 'NO_SPACE')
      assert.strictEqual(none.calls.length, 1)
    } finally {
      r2()
    }
  }
})

test('pickupDrops: the route\'s stone the keeper says no to isn\'t gone for, unless the pickup names it', async () => {
  const { pickupDrops } = await import('../../src/skills/pickupDrops')
  const bot = bagBot(2)
  const rig = pickupRig(bot, 'cobblestone', new Vec3(1.5, 64, 0.5))
  const task = new AbortController()
  const release = holdBag(bot, keeper(bot, { unwanted: n => n === 'cobblestone' }), task.signal)
  const tick = setInterval(() => bot.emit('physicsTick'), 1)
  try {
    await pickupDrops(bot, { near: new Vec3(1, 64, 0) }, task.signal)
    assert.strictEqual(rig.trips(), 0)
    await pickupDrops(bot, { near: new Vec3(1, 64, 0), names: ['cobblestone'] }, task.signal)
    assert.strictEqual(rig.trips(), 1)
  } finally {
    clearInterval(tick)
    release()
  }
})

test('collectBlock with no room of its own has the keeper make room before each block it breaks', async () => {
  const { collectBlock } = await import('../../src/skills/collectBlock')
  const registry = require('minecraft-data')('1.21.11')
  const blocks = new Map<string, string>([['1,64,0', 'stone'], ['-1,64,0', 'stone']])
  const bot = bagBot(36)
  const blockAt = (pos: Vec3): any => { const p = pos.floored(); const name = blocks.get(`${p.x},${p.y},${p.z}`) ?? (p.y < 64 ? 'stone' : 'air'); return { name, position: p, boundingBox: name === 'air' ? 'empty' : 'block', type: registry.blocksByName[name].id, harvestTools: registry.blocksByName[name].harvestTools } }
  bot.blockAt = blockAt
  bot.pathingUtil = { refresh: () => {}, bestHarvestingTool: () => null }
  bot.dig = async (block: any) => { blocks.set(`${block.position.x},${block.position.y},${block.position.z}`, 'air') }
  // a keeper that frees one slot a time, with 3 to keep free: asked before each block
  const k = keeper(bot, { minFree: 3, frees: 1 })
  const task = new AbortController()
  const release = holdBag(bot, k, task.signal)
  const tick = setInterval(() => bot.emit('physicsTick'), 1)
  try {
    const res = await collectBlock(bot, { positions: [new Vec3(1, 64, 0), new Vec3(-1, 64, 0)], anyTool: true, pickup: false }, task.signal)
    assert.strictEqual(res.mined, 2)
  } finally {
    clearInterval(tick)
    release()
  }
  // before each of the two blocks, and once more before the loop's end check finds none left
  assert.ok(k.calls.length >= 2, `${k.calls.length} rooms`)
})

test('the executor\'s tasks hold the bag with its keeper (the route\'s stone over the stock unwanted), but a store\'s; none outside a task', async () => {
  const { Executor } = await import('../../src/executor/executor')
  const { WorldMemory } = await import('../../src/core/memory')
  const { TaskRunner } = await import('../../src/core/taskRunner')
  const registry = require('minecraft-data')('1.21.11')
  const bot: any = new EventEmitter()
  bot.registry = registry
  bot.entity = { position: new Vec3(0, 64, 0) }
  bot.game = { dimension: 'overworld' }
  const items = [item('cobblestone', 64), item('cobblestone', 64)]
  bot.inventory = { slots: [], inventoryStart: 9, inventoryEnd: 45, items: () => items }
  bot.survival = { memory: new WorldMemory(), tasks: new TaskRunner(bot) }
  const ex = new Executor(bot, { stocked: name => name === 'cobblestone' })
  assert.strictEqual(bagKeeper(bot), null)
  const inside = await ex.task('obsidian from the lava', async () => bagKeeper(bot))
  assert.strictEqual(inside, ex.bagKeeper)
  assert.strictEqual(inside?.minFree, 2)
  // 128 carried, 64 kept: no more of it picked up
  assert.strictEqual(inside?.unwanted('cobblestone'), true)
  assert.strictEqual(inside?.unwanted('obsidian'), false)
  assert.strictEqual(await ex.task('store cobblestone', async () => bagKeeper(bot), undefined, { room: false }), null)
  assert.strictEqual(bagKeeper(bot), null)
})

test('keepRoom: no room made with a hostile within BAG_HOSTILE_RANGE (bagUnsafe), made once it is gone (ls4-26.3, t386611: junk thrown 5 times in 50 ticks among four zombies)', async () => {
  const zombie = entity({ name: 'zombie', position: new Vec3(0.5 + BAG_HOSTILE_RANGE - 2, 64, 0.5) })
  const bot = bagBot(35)
  bot.entities[zombie.id] = zombie
  const k = keeper(bot)
  const release = holdBag(bot, k, new AbortController().signal)
  assert.strictEqual(bagUnsafe(bot), true)
  assert.strictEqual(await keepRoom(bot), false)
  assert.strictEqual(k.calls.length, 0)
  // a cow there is no threat; the zombie further off neither
  const cow = entity({ name: 'cow', position: new Vec3(2.5, 64, 0.5) })
  delete bot.entities[zombie.id]
  bot.entities[cow.id] = cow
  assert.strictEqual(bagUnsafe(bot), false)
  zombie.position = new Vec3(0.5 + BAG_HOSTILE_RANGE + 2, 64, 0.5)
  bot.entities[zombie.id] = zombie
  assert.strictEqual(bagUnsafe(bot), false)
  assert.strictEqual(await keepRoom(bot), true)
  assert.strictEqual(k.calls.length, 1)
  release()
})

test('bagUnsafe: only a hostile that sees the bot within BAG_HOSTILE_DY, or a hit lately; one through the rock, a cave under the bot or an enderman keeps no room from being made (f2b-grim: 6000 ticks of \'no room made: hostiles about\' at full health in a mine by day)', () => {
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), world: (pos: Vec3) => pos.x === 3 ? 'stone' : 'air' })
  const zombie = entity({ name: 'zombie', position: new Vec3(5.5, 64, 0.5) })
  bot.entities[zombie.id] = zombie
  // behind the wall at x 3
  assert.strictEqual(bagUnsafe(bot), false)
  assert.strictEqual(bagThreat(bot), null)
  // round it, in sight
  zombie.position = new Vec3(0.5, 64, 5.5)
  assert.strictEqual(bagUnsafe(bot), true)
  assert.strictEqual(bagThreat(bot), 'zombie 5.0 off (dy 0)')
  // in a cave under the bot (in sight, the air between), further down than the hostiles reflex fights
  zombie.position = new Vec3(0.5, 64 - BAG_HOSTILE_DY - 1, 2.5)
  assert.strictEqual(bagUnsafe(bot), false)
  // an enderman in sight lets the bot be
  delete bot.entities[zombie.id]
  const enderman = entity({ name: 'enderman', position: new Vec3(0.5, 64, 4.5) })
  bot.entities[enderman.id] = enderman
  assert.strictEqual(bagUnsafe(bot), false)
  // till it hits: the reflexes' hit lately
  bot.survival = { reflexes: { enabled: true, context: () => ({ ticksSinceHurt: 10, config: { combat: { hurtTicks: 60 } } }) } }
  assert.strictEqual(bagUnsafe(bot), true)
  assert.strictEqual(bagThreat(bot), 'a hit lately')
  bot.survival.reflexes.context = () => ({ ticksSinceHurt: 200, config: { combat: { hurtTicks: 60 } } })
  assert.strictEqual(bagUnsafe(bot), false)
})
