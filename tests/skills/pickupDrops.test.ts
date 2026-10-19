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

test('tossAway throws behind the bot and remembers what it threw: no pickup goes back for it while it lies there (ITEM_LIFETIME)', async () => {
  // (26.3 seed 2: the cobblestone thrown away for room was picked up again down the mine, and the bag was full again)
  const { tossAway, nearbyDrops, pickupDrops, isThrownDrop, ITEM_LIFETIME } = await import('../../src/skills/pickupDrops')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const registry = require('minecraft-data')('1.21.11')
  const Item = require('prismarine-item')('1.21.11')
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [item('cobblestone', 64), item('andesite', 10)] })
  bot.inventory.inventoryStart = 9
  bot.inventory.inventoryEnd = 45
  bot._client = { on: () => {}, off: () => {} }
  bot.time = { age: 1000 }
  bot.entity.yaw = 0
  const looks: number[] = []
  bot.look = async (yaw: number) => { looks.push(yaw) }
  const drop = (id: number, name: string, pos: Vec3): any => ({ id, name: 'item', position: pos, getDroppedItem: () => new Item(registry.itemsByName[name].id, 1) })
  // the server drops the stack along the look: 3 blocks behind (yaw 0 looks to -z, behind is +z)
  bot.toss = async (type: number, _meta: unknown, n: number) => {
    const stack = bot.inventory.items().find((i: any) => i.type === type)
    stack.count -= n
    if (stack.count <= 0) bot.inventory.slots[stack.slot] = null
    setTimeout(() => { bot.entities[70] = drop(70, registry.items[type].name, new Vec3(0.5, 64, 3.5)) }, 3)
  }
  // a block's drop (not thrown) lies beside the bot
  bot.entities[71] = drop(71, 'cobblestone', new Vec3(-2.5, 64, 0.5))
  let trips = 0
  bot.pathfinder = { isPathing: false, goto: async () => { trips++ }, cancel: async () => {}, world: {} }
  const ticker = setInterval(() => bot.emit('physicsTick'), 1)
  try {
    assert.strictEqual(await tossAway(bot, 'cobblestone', 64), 64)
    assert.deepStrictEqual(looks, [Math.PI])
    assert.ok(isThrownDrop(bot, bot.entities[70]))
    assert.deepStrictEqual(nearbyDrops(bot, bot.entity.position, 8).map(e => e.id), [71])
    // a block's drop by it is not it
    bot.entities[72] = drop(72, 'cobblestone', new Vec3(0.9, 64, 4))
    bot.entities[73] = drop(73, 'andesite', new Vec3(0.9, 64, 4))
    assert.deepStrictEqual(nearbyDrops(bot, bot.entity.position, 8).map(e => e.id).sort(), [71, 72, 73])
    // with its entity gone and another id (its chunk loaded again), an item of its name where it lay is it; another
    // item isn't
    const thrownOne = bot.entities[70]
    delete bot.entities[70]
    assert.deepStrictEqual(nearbyDrops(bot, bot.entity.position, 8).map(e => e.id).sort(), [71, 73])
    bot.entities[70] = thrownOne
    delete bot.entities[72]
    // the pickups go for the block's drop and the andesite, not what was thrown
    delete bot.entities[71]
    delete bot.entities[73]
    await pickupDrops(bot, { near: bot.entity.position, radius: 8, waitTicks: 1 })
    assert.strictEqual(trips, 0)
    // it despawns after ITEM_LIFETIME: one there then is another
    bot.time.age += ITEM_LIFETIME
    assert.strictEqual(isThrownDrop(bot, bot.entities[70]), false)
  } finally {
    clearInterval(ticker)
  }
})

test('tossAway with no pit throws the way with room at head height, behind first: a stack thrown at a wall falls at the bot\'s feet', async () => {
  const { tossYaw } = await import('../../src/skills/pickupDrops')
  const { fakeBot } = await import('../reflexes/fakeBot')
  // a dead end: the tunnel runs ahead of the bot (to -z, yaw 0), rock behind and at the sides
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), world: (pos: Vec3) => (pos.x === 0 && pos.z <= 0 && pos.y >= 64 && pos.y <= 65) ? 'air' : 'stone' })
  bot.entity.yaw = 0
  assert.ok(Math.abs(tossYaw(bot) - 0) < 1e-9)
  // open behind too: behind
  const open = fakeBot({ position: new Vec3(0.5, 64, 0.5) })
  open.entity.yaw = 0
  assert.ok(Math.abs(tossYaw(open) - Math.PI) < 1e-9)
})

test('tossAway into lava throws along the look given, and what it threw counts as thrown only while its entity is there (it burns: the blocks dug there after drop no thrown ones)', async () => {
  const { tossAway, isThrownDrop } = await import('../../src/skills/pickupDrops')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const registry = require('minecraft-data')('1.21.11')
  const Item = require('prismarine-item')('1.21.11')
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [item('cobblestone', 64)] })
  bot.inventory.inventoryStart = 9
  bot.inventory.inventoryEnd = 45
  bot._client = { on: () => {}, off: () => {} }
  bot.time = { age: 1000 }
  const looks: Array<[number, number]> = []
  bot.look = async (yaw: number, pitch: number) => { looks.push([yaw, pitch]) }
  const drop = (id: number, pos: Vec3): any => ({ id, name: 'item', position: pos, getDroppedItem: () => new Item(registry.itemsByName.cobblestone.id, 1) })
  bot.toss = async (_type: number, _meta: unknown, n: number) => {
    const stack = bot.inventory.items()[0]
    stack.count -= n
    if (stack.count <= 0) bot.inventory.slots[stack.slot] = null
    setTimeout(() => { bot.entities[80] = drop(80, new Vec3(0.5, 65.3, -0.5)) }, 3)
  }
  const ticker = setInterval(() => bot.emit('physicsTick'), 1)
  try {
    assert.strictEqual(await tossAway(bot, 'cobblestone', 64, undefined, { yaw: 1, pitch: -0.7 }), 64)
    assert.deepStrictEqual(looks, [[1, -0.7]])
    assert.ok(isThrownDrop(bot, bot.entities[80]))
    // burnt in the lava
    const burnt = bot.entities[80]
    delete bot.entities[80]
    bot.emit('entityGone', burnt)
    assert.strictEqual(isThrownDrop(bot, drop(81, new Vec3(0.5, 65, -0.5))), false)
  } finally {
    clearInterval(ticker)
  }
})

test('settlePickups: waits while an item lies in the bot\'s reach, till it comes in or PICKUP_SETTLE_TICKS are up; none farther off', async () => {
  const { EventEmitter } = await import('node:events')
  const { PICKUP_SETTLE_TICKS, settlePickups } = await import('../../src/skills/pickupDrops')
  const bot: any = new EventEmitter()
  bot.entity = { position: new Vec3(0.5, -60, 0.5) }
  bot.entities = { 1: bot.entity }
  let ticks = 0
  const tick = (): void => { ticks++; bot.emit('physicsTick') }
  const run = async (until: (n: number) => boolean): Promise<boolean> => {
    ticks = 0
    const timer = setInterval(() => { tick(); if (until(ticks)) delete bot.entities[2] }, 1)
    try { return await settlePickups(bot) } finally { clearInterval(timer) }
  }
  // none near: at once
  bot.entities[2] = { name: 'item', position: new Vec3(3.5, -60, 0.5) }
  assert.strictEqual(await run(() => false), true)
  assert.strictEqual(ticks, 0)
  // one at the feet, picked up 4 ticks on
  bot.entities[2] = { name: 'item', position: new Vec3(1.2, -60, 0.5) }
  assert.strictEqual(await run(n => n >= 4), true)
  assert.ok(ticks >= 4 && ticks < PICKUP_SETTLE_TICKS, String(ticks))
  // one that stays (a full bag): given up
  bot.entities[2] = { name: 'item', position: new Vec3(1.2, -60, 0.5) }
  assert.strictEqual(await run(() => false), false)
})
