import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { GoalTouch, restingY, touches } from '../../src/skills/pickupDrops'

test('touches: the player box inflated by 1 and 0.5 (Player.aiStep) meets the item box', () => {
  const bot = new Vec3(0.5, -60, 0.5)
  assert.strictEqual(touches(bot, new Vec3(1.5, -60, 0.5)), true)
  assert.strictEqual(touches(bot, new Vec3(1.9, -60, 1.9)), true)
  assert.strictEqual(touches(bot, new Vec3(2.0, -60, 0.5)), false)
  // up to 2.3 over the feet, 0.75 under them
  assert.strictEqual(touches(bot, new Vec3(0.5, -57.8, 0.5)), true)
  assert.strictEqual(touches(bot, new Vec3(0.5, -57.6, 0.5)), false)
  assert.strictEqual(touches(bot, new Vec3(0.5, -60.7, 0.5)), true)
  assert.strictEqual(touches(bot, new Vec3(0.5, -60.8, 0.5)), false)
})

test('GoalTouch: on the block of the item or next to it, not two blocks off', () => {
  const goal = new GoalTouch(new Vec3(5.5, -60, 5.5))
  assert.strictEqual(goal.isEnd({ x: 5, y: -60, z: 5 }), true)
  assert.strictEqual(goal.isEnd({ x: 4, y: -60, z: 6 }), true)
  assert.strictEqual(goal.isEnd({ x: 3, y: -60, z: 5 }), false)
  assert.strictEqual(goal.isEnd({ x: 5, y: -63, z: 5 }), false)
  assert.strictEqual(goal.distHeuristic({ x: 5, y: -60, z: 5 }), 0)
  assert.ok(goal.distHeuristic({ x: 9, y: -60, z: 5 }) > 2)
})

test('restingY: an item comes to rest on top of a dirt path or slab in its cell, on the floor of an empty one; the bot on the path touches it', () => {
  const path = { boundingBox: 'block', shapes: [[0, 0, 0, 1, 0.9375, 1]] }
  assert.strictEqual(restingY(() => path, new Vec3(-31, 66, -1)), 66.9375)
  assert.strictEqual(restingY(() => ({ boundingBox: 'block', shapes: [[0, 0, 0, 1, 0.5, 1]] }), new Vec3(0, 10, 0)), 10.5)
  assert.strictEqual(restingY(() => ({ boundingBox: 'empty', shapes: [] }), new Vec3(0, 10, 0)), 10)
  assert.strictEqual(restingY(() => null, new Vec3(0, 10, 0)), 10)
  // the bot standing on the path, the eye on it beside it
  assert.strictEqual(touches(new Vec3(-30.53, 66.9375, -0.33), new Vec3(-30.73, 66, -0.31)), false)
  assert.strictEqual(touches(new Vec3(-30.53, 66.9375, -0.33), new Vec3(-30.73, 66.9375, -0.31)), true)
})

test('pickupDrops: a drop the bot couldn\'t get to is passed over by the pickups after it while it lies there, for UNREACHABLE_DROP_TICKS', async () => {
  const { pickupDrops, UNREACHABLE_DROP_TICKS } = await import('../../src/skills/pickupDrops')
  const { fakeBot } = await import('../reflexes/fakeBot')
  const registry = require('minecraft-data')('1.21.11')
  const Item = require('prismarine-item')('1.21.11')
  const bot = fakeBot({ position: new Vec3(0.7, 64, 0.3), world: (pos: Vec3) => pos.y < 64 ? 'stone' : 'air' })
  bot.inventory.inventoryStart = 9
  bot.inventory.inventoryEnd = 45
  bot._client = { on: () => {}, off: () => {} }
  bot.time = { age: 1000 }
  // an item round a corner the bot doesn't get past: each trip ends where it started
  bot.entities[60] = { id: 60, name: 'item', position: new Vec3(2.4, 64, -0.9), getDroppedItem: () => new Item(registry.itemsByName.cobblestone.id, 1) }
  let trips = 0
  bot.pathfinder = { isPathing: false, goto: async () => { trips++ }, cancel: async () => {}, world: {} }
  bot.waitForTicks = async () => {}
  const ticker = setInterval(() => bot.emit('physicsTick'), 1)
  try {
    // the first pickup goes for it and gives up; the pickups after each block mined (collectBlock) went for it again
    await pickupDrops(bot, { near: new Vec3(1, 64, 0) })
    const perTry = trips
    assert.ok(perTry > 0)
    await pickupDrops(bot, { near: new Vec3(1, 64, 0) })
    await pickupDrops(bot, { near: new Vec3(1, 64, 0) })
    assert.strictEqual(trips, perTry)
    // once it moved (it fell, the water carried it) it's tried again
    bot.entities[60].position = new Vec3(2.4, 64, -2)
    await pickupDrops(bot, { near: new Vec3(1, 64, 0) })
    assert.strictEqual(trips, 2 * perTry)
    // and a minute on
    bot.time.age += UNREACHABLE_DROP_TICKS
    await pickupDrops(bot, { near: new Vec3(1, 64, 0) })
    assert.strictEqual(trips, 3 * perTry)
  } finally {
    clearInterval(ticker)
  }
})

test('nearbyDrops passes over an item entity whose item has not come yet (getDroppedItem throws)', async () => {
  const { nearbyDrops } = await import('../../src/skills/pickupDrops')
  const { fakeBot } = await import('../reflexes/fakeBot')
  const { Vec3 } = await import('vec3')
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5) })
  bot.entities[5] = { id: 5, name: 'item', position: new Vec3(1, 64, 0), getDroppedItem: () => { throw new TypeError("Cannot read properties of undefined (reading 'present')") } } as any
  bot.entities[6] = { id: 6, name: 'item', position: new Vec3(2, 64, 0), getDroppedItem: () => ({ name: 'ender_pearl' }) } as any
  const found = nearbyDrops(bot, bot.entity.position, 8, ['ender_pearl'])
  assert.deepEqual(found.map(e => e.id), [6])
})
