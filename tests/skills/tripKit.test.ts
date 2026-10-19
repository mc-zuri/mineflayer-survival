// The trip kit: what it takes from the bag, and the runner's way back to it after a death.
import { test } from 'node:test'
import assert from 'node:assert'
import { kitSpares, tripKitItems } from '../../src/skills/tripKit'

test('tripKitItems: the weapons but the best, half the arrows, food and blocks (64 at most), the armor carried', () => {
  const kit = tripKitItems([
    { name: 'diamond_sword', count: 1 }, { name: 'iron_sword', count: 1 }, { name: 'bow', count: 1 },
    { name: 'arrow', count: 64 }, { name: 'arrow', count: 64 }, { name: 'cooked_beef', count: 48 }, { name: 'bread', count: 4 },
    { name: 'cobblestone', count: 64 }, { name: 'cobblestone', count: 64 }, { name: 'cobblestone', count: 10 }, { name: 'andesite', count: 30 },
    { name: 'iron_helmet', count: 1 }, { name: 'golden_apple', count: 2 }, { name: 'ender_eye', count: 12 }
  ])
  const by = Object.fromEntries(kit.map(k => [k.name, k.count]))
  assert.deepStrictEqual(by, { iron_sword: 1, arrow: 64, cooked_beef: 24, cobblestone: 64, iron_helmet: 1, golden_apple: 1 })
  // nothing spare: nothing taken
  assert.deepStrictEqual(tripKitItems([{ name: 'diamond_sword', count: 1 }, { name: 'arrow', count: 20 }]), [])
  // a shield carried goes in (the one held is in the off hand, not the bag)
  assert.deepStrictEqual(tripKitItems([{ name: 'shield', count: 1 }, { name: 'iron_chestplate', count: 1 }]), [{ name: 'iron_chestplate', count: 1 }, { name: 'shield', count: 1 }])
})

test('kitSpares: an iron chestplate and leggings from 15 iron when no armor is carried spare, then a shield from an ingot left', () => {
  const worn = [{ name: 'diamond_chestplate', count: 1 }, { name: 'diamond_leggings', count: 1 }, { name: 'shield', count: 1 }]
  // the nether stage's 16 iron: both
  assert.deepStrictEqual(kitSpares([...worn, { name: 'iron_ingot', count: 16 }], [{ name: 'iron_ingot', count: 16 }]), [
    [{ item: 'iron_chestplate', count: 1 }, { item: 'iron_leggings', count: 1 }],
    [{ item: 'shield', count: 2 }]
  ])
  // 15: the armor alone; 14: the shield alone
  assert.deepStrictEqual(kitSpares([...worn, { name: 'iron_ingot', count: 15 }], [{ name: 'iron_ingot', count: 15 }]).map(g => g.map(r => r.item)), [['iron_chestplate', 'iron_leggings']])
  assert.deepStrictEqual(kitSpares([...worn, { name: 'iron_ingot', count: 14 }], [{ name: 'iron_ingot', count: 14 }]).map(g => g.map(r => r.item)), [['shield']])
  // spares carried already: none made; no iron: none
  const carried = [{ name: 'iron_helmet', count: 1 }, { name: 'shield', count: 1 }, { name: 'iron_ingot', count: 30 }]
  assert.deepStrictEqual(kitSpares([...worn, ...carried], carried), [])
  assert.deepStrictEqual(kitSpares(worn, []), [])
  // gold for the piglins: golden boots from 4 ingots, none with a golden piece carried spare or fewer ingots
  assert.deepStrictEqual(kitSpares([{ name: 'golden_boots', count: 1 }, { name: 'gold_ingot', count: 32 }], [{ name: 'gold_ingot', count: 32 }]), [[{ item: 'golden_boots', count: 2 }]])
  assert.deepStrictEqual(kitSpares([{ name: 'gold_ingot', count: 3 }], [{ name: 'gold_ingot', count: 3 }]), [])
  assert.deepStrictEqual(kitSpares([{ name: 'golden_helmet', count: 1 }, { name: 'gold_ingot', count: 9 }], [{ name: 'golden_helmet', count: 1 }, { name: 'gold_ingot', count: 9 }]), [])
  // an iron chestplate worn: the spare is one more than owned
  assert.deepStrictEqual(kitSpares([{ name: 'iron_chestplate', count: 1 }, { name: 'iron_ingot', count: 15 }], [{ name: 'iron_ingot', count: 15 }])[0], [{ item: 'iron_chestplate', count: 2 }, { item: 'iron_leggings', count: 1 }])
})

test('tripKitItems: the pickaxes but the best, and but the best spare too with three or more (the trip carries a spare)', () => {
  // two: the kit takes the spare
  assert.deepStrictEqual(tripKitItems([{ name: 'diamond_pickaxe', count: 1 }, { name: 'iron_pickaxe', count: 1 }]), [{ name: 'iron_pickaxe', count: 1 }])
  // three: the bag keeps the diamond and the best spare, the kit takes the worst
  assert.deepStrictEqual(tripKitItems([{ name: 'diamond_pickaxe', count: 1 }, { name: 'iron_pickaxe', count: 1 }, { name: 'stone_pickaxe', count: 1 }]), [{ name: 'stone_pickaxe', count: 1 }])
  assert.deepStrictEqual(tripKitItems([{ name: 'diamond_pickaxe', count: 1 }, { name: 'iron_pickaxe', count: 2 }]), [{ name: 'iron_pickaxe', count: 1 }])
  assert.deepStrictEqual(tripKitItems([{ name: 'diamond_pickaxe', count: 1 }]), [])
})

test('kitSpares: an iron pickaxe from 3 iron left when the bag has fewer than 3 pickaxes', () => {
  const worn = [{ name: 'diamond_chestplate', count: 1 }, { name: 'shield', count: 1 }]
  const bag = (iron: number, picks: Array<{ name: string, count: number }>): Array<{ name: string, count: number }> => [{ name: 'iron_helmet', count: 1 }, { name: 'shield', count: 1 }, { name: 'iron_ingot', count: iron }, ...picks]
  const one = bag(3, [{ name: 'diamond_pickaxe', count: 1 }])
  assert.deepStrictEqual(kitSpares([...worn, ...one], one), [[{ item: 'iron_pickaxe', count: 1 }]])
  const two = bag(5, [{ name: 'diamond_pickaxe', count: 1 }, { name: 'iron_pickaxe', count: 1 }])
  assert.deepStrictEqual(kitSpares([...worn, ...two], two), [[{ item: 'iron_pickaxe', count: 2 }]])
  // three carried, too little iron, or no pickaxe at all: none
  const three = bag(9, [{ name: 'diamond_pickaxe', count: 1 }, { name: 'iron_pickaxe', count: 2 }])
  assert.deepStrictEqual(kitSpares([...worn, ...three], three), [])
  const poor = bag(2, [{ name: 'diamond_pickaxe', count: 1 }])
  assert.deepStrictEqual(kitSpares([...worn, ...poor], poor), [])
  const none = bag(9, [])
  assert.deepStrictEqual(kitSpares([...worn, ...none], none), [])
  // after the armor (15) and the shield (1): the iron left
  const armor = [{ name: 'iron_ingot', count: 18 }, { name: 'diamond_pickaxe', count: 1 }]
  assert.deepStrictEqual(kitSpares([{ name: 'diamond_chestplate', count: 1 }, ...armor], armor).map(g => g.map(r => r.item)), [['iron_chestplate', 'iron_leggings'], ['shield']])
  const more = [{ name: 'iron_ingot', count: 19 }, { name: 'diamond_pickaxe', count: 1 }]
  assert.deepStrictEqual(kitSpares([{ name: 'diamond_chestplate', count: 1 }, ...more], more).map(g => g.map(r => r.item)), [['iron_chestplate', 'iron_leggings'], ['shield'], ['iron_pickaxe']])
})

test('after a death the runner goes to a trip kit that still holds something, and takes it', async () => {
  const { Runner } = await import('../../src/runner')
  const { EventEmitter } = await import('node:events')
  const { TaskRunner } = await import('../../src/core/taskRunner')
  const { WorldMemory } = await import('../../src/core/memory')
  const { Vec3 } = await import('vec3')
  const bot: any = new EventEmitter()
  bot.registry = require('minecraft-data')('1.21.11')
  bot.inventory = { slots: new Array(46).fill(null), items: () => [] }
  bot.entity = { position: new Vec3(2351, -22, 1016) }
  bot.game = { dimension: 'overworld' }
  bot.health = 20
  bot.time = { timeOfDay: 1000 }
  bot.survival = { memory: new WorldMemory(), tasks: new TaskRunner(bot), handlers: {}, advancements: new Set() }
  const runner = new Runner(bot, { log: () => {} })
  assert.strictEqual(await runner.tripRekit(), null)
  bot.survival.memory.addPoi('trip_kit', { x: 2352, y: -22, z: 1016 }, 'overworld', 'spare kit')
  bot.survival.memory.rememberChest({ x: 2352, y: -22, z: 1016 }, {}, 'overworld')
  assert.strictEqual(await runner.tripRekit(), null, 'an empty one is no kit')
  bot.survival.memory.rememberChest({ x: 2352, y: -22, z: 1016 }, { iron_sword: 1, arrow: 64 }, 'overworld')
  const tasks: string[] = []
  runner.executor.task = (async (name: string) => { tasks.push(name); return { iron_sword: 1, arrow: 64 } }) as any
  assert.deepStrictEqual(await runner.tripRekit(), { iron_sword: 1, arrow: 64 })
  assert.deepStrictEqual(tasks, ['the trip kit'])
})

test('leaveTripKit fills the kit\'s emptied chest again, making no new chest or bed', async () => {
  const { leaveTripKit } = await import('../../src/milestones')
  const { WorldMemory } = await import('../../src/core/memory')
  const { fakeBot } = await import('../reflexes/fakeBot')
  const { Vec3 } = await import('vec3')
  const bot = fakeBot({ position: new Vec3(2351.5, -22, 1016.5) })
  bot.game.dimension = 'overworld'
  const chest = new Vec3(2352, -22, 1016)
  const realAt = bot.blockAt.bind(bot)
  bot.blockAt = ((p: any) => p.equals?.(chest) ? { name: 'chest', position: chest } : realAt(p)) as any
  const memory = new WorldMemory()
  memory.addPoi('trip_kit', chest, 'overworld', 'spare kit')
  memory.rememberChest(chest, { arrow: 0 }, 'overworld')
  const calls: string[] = []
  const executor: any = {
    memory,
    plan: () => { calls.push('plan'); return { ok: true, cost: 0 } },
    obtain: async () => { calls.push('obtain') },
    task: async (name: string) => { calls.push(name); return { chest, stored: { arrow: 32 }, bed: null } }
  }
  await leaveTripKit(bot, executor, new AbortController().signal, () => {})
  assert.deepStrictEqual(calls, ['leave a trip kit'])
})

test('leaveTripKit: the chest and bed got, beforeStash (back to the portal room) runs before they are put down', async () => {
  const { leaveTripKit } = await import('../../src/milestones')
  const { WorldMemory } = await import('../../src/core/memory')
  const { fakeBot } = await import('../reflexes/fakeBot')
  const { Vec3 } = await import('vec3')
  const bot = fakeBot({ position: new Vec3(2320.5, 27, 936.5) })
  bot.game.dimension = 'overworld'
  const calls: string[] = []
  const executor: any = {
    memory: new WorldMemory(),
    plan: () => ({ ok: true, cost: 0 }),
    obtain: async (want: any) => { calls.push(`obtain ${String(want[0].item)}`) },
    task: async (name: string) => { calls.push(name); return { chest: new Vec3(2352, -22, 1016), stored: {}, bed: null } }
  }
  await leaveTripKit(bot, executor, new AbortController().signal, () => {}, async () => { calls.push('back to the room') })
  assert.deepStrictEqual(calls.filter(c => !c.startsWith('obtain')).slice(-2), ['back to the room', 'leave a trip kit'])
  assert.ok(calls.indexOf('obtain chest') < calls.indexOf('back to the room'))
})

test('nearPortal: a cell 2 or fewer blocks from a portal\'s blocks is not for the kit', async () => {
  const { nearPortal } = await import('../../src/skills/tripKit')
  const { Vec3 } = await import('vec3')
  const world = (p: any) => ({ name: p.x === 0 && p.y >= 64 && p.y <= 66 && p.z === 0 ? 'nether_portal' : 'air' })
  assert.strictEqual(nearPortal(world, new Vec3(1, 64, 1)), true)
  assert.strictEqual(nearPortal(world, new Vec3(3, 64, 0)), false)
})

test('withTickBudget: the work is aborted once its ticks are gone', async () => {
  const { withTickBudget } = await import('../../src/milestones')
  const { fakeBot } = await import('../reflexes/fakeBot')
  const bot = fakeBot()
  const ticking = setInterval(() => bot.emit('physicsTick'), 1)
  try {
    const r = await withTickBudget(bot, 50, new AbortController().signal, async () => 'quick')
    assert.strictEqual(r, 'quick')
    await assert.rejects(withTickBudget(bot, 5, new AbortController().signal, async (s) => await new Promise((_resolve, reject) => s.addEventListener('abort', () => reject(s.reason)))), /budget of 5 ticks/)
  } finally {
    clearInterval(ticking)
  }
})

test('tripKitItems: the pickaxes but the best go in (a respawn with no pickaxe digs no way)', async () => {
  const { tripKitItems } = await import('../../src/skills/tripKit')
  const by = Object.fromEntries(tripKitItems([{ name: 'diamond_pickaxe', count: 1 }, { name: 'iron_pickaxe', count: 1 }]).map(k => [k.name, k.count]))
  assert.deepStrictEqual(by, { iron_pickaxe: 1 })
  assert.deepStrictEqual(tripKitItems([{ name: 'diamond_pickaxe', count: 1 }]), [])
})

test('a respawn far from the trip kit at night with no armor waits the night out first (waitOutNightFirst), then walks', async () => {
  const { Runner, waitOutNightFirst, NIGHT_WALK_DISTANCE } = await import('../../src/runner')
  assert.strictEqual(waitOutNightFirst(18000, NIGHT_WALK_DISTANCE + 1, 0), true)
  assert.strictEqual(waitOutNightFirst(6000, 2400, 0), false, 'by day it walks')
  assert.strictEqual(waitOutNightFirst(18000, 20, 0), false, 'the kit by: it goes')
  assert.strictEqual(waitOutNightFirst(18000, 2400, 15), false, 'with armor on it goes')
  const { EventEmitter } = await import('node:events')
  const { TaskRunner } = await import('../../src/core/taskRunner')
  const { WorldMemory } = await import('../../src/core/memory')
  const { Vec3 } = await import('vec3')
  const bot: any = new EventEmitter()
  bot.registry = require('minecraft-data')('1.21.11')
  bot.inventory = { slots: new Array(46).fill(null), items: () => [] }
  bot.entity = { position: new Vec3(0, 64, 0) }
  bot.game = { dimension: 'overworld' }
  bot.health = 20
  bot.time = { timeOfDay: 18000 }
  bot.survival = { memory: new WorldMemory(), tasks: new TaskRunner(bot), handlers: {}, advancements: new Set() }
  const runner = new Runner(bot, { log: () => {} })
  bot.survival.memory.addPoi('trip_kit', { x: 2352, y: -22, z: 1016 }, 'overworld', 'spare kit')
  bot.survival.memory.rememberChest({ x: 2352, y: -22, z: 1016 }, { iron_sword: 1 }, 'overworld')
  const tasks: string[] = []
  runner.executor.task = (async (name: string) => { tasks.push(name); return { iron_sword: 1 } }) as any
  await runner.tripRekit()
  assert.deepStrictEqual(tasks, ['wait out the night', 'to the trip kit', 'the trip kit'])
})

test('roomToDigNear: the bot walled in by its chest in a 1-wide tunnel digs the bed\'s room from a cell on the chest\'s other side', async () => {
  const { roomToDigNear } = await import('../../src/skills/tripKit')
  const { Vec3 } = await import('vec3')
  // stone all round; a tunnel along z at x 0, y 64-65, z -1 to 1; the chest at z 0, the bot at z 1 with bedrock round it
  const lookup = (p: any): any => {
    const k = `${p.x},${p.y},${p.z}`
    const name = k === '0,64,0' ? 'chest'
      : p.x === 0 && (p.y === 64 || p.y === 65) && p.z >= -1 && p.z <= 1 ? 'air'
        : ['1,64,1', '-1,64,1', '0,64,2'].includes(k) ? 'bedrock' : 'stone'
    return { name, boundingBox: name === 'air' ? 'empty' : 'block' }
  }
  const room = roomToDigNear(lookup, new Vec3(0.5, 64, 1.5), new Vec3(0, 64, 0), () => false)
  assert.ok(room != null)
  assert.deepStrictEqual(room.stand, new Vec3(0, 64, -1))
  assert.strictEqual(room.dig.length, 2)
  assert.ok(room.dig.every((c: any) => lookup(c).name === 'stone'))
})

test('unknownChestNear: the chest the kit\'s stash put down before a fight cut it off is found again; a remembered one is not it', async () => {
  const { unknownChestNear } = await import('../../src/skills/tripKit')
  const { WorldMemory } = await import('../../src/core/memory')
  const { fakeBot } = await import('../reflexes/fakeBot')
  const { Vec3 } = await import('vec3')
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), world: (p: any) => p.x === 2 && p.y === 64 && p.z === 1 ? 'chest' : p.y < 64 ? 'stone' : 'air' })
  const memory = new WorldMemory()
  assert.deepStrictEqual(unknownChestNear(bot, memory), new Vec3(2, 64, 1))
  memory.rememberChest({ x: 2, y: 64, z: 1 }, { cobblestone: 64 }, 'overworld')
  assert.strictEqual(unknownChestNear(bot, memory), null)
})

test('stashTripKit puts the chest where there is room over it (a chest under a block does not open)', async () => {
  const placeModule = require('../../src/skills/placeBlock')
  const chestModule = require('../../src/skills/chest')
  const { stashTripKit } = await import('../../src/skills/tripKit')
  const { WorldMemory } = await import('../../src/core/memory')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const { Vec3 } = await import('vec3')
  // a cave 1 high but for one cell 2 off: stone under y 64, over y 64 but at (2, 65, 0)
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [item('chest', 1), item('arrow', 64)], world: (p: any) => p.y < 64 ? 'stone' : p.y === 64 ? 'air' : (p.x === 2 && p.z === 0 && p.y === 65 ? 'air' : 'stone') })
  const placed: string[] = []
  const realPlace = placeModule.placeBlock
  const realStore = chestModule.storeItems
  placeModule.placeBlock = async (_b: unknown, a: any) => { placed.push(a.pos.toString()); return { placed: true } }
  chestModule.storeItems = async () => ({ moved: {} })
  try {
    await stashTripKit(bot, new WorldMemory())
  } finally {
    placeModule.placeBlock = realPlace
    chestModule.storeItems = realStore
  }
  assert.equal(placed[0], new Vec3(2, 64, 0).toString())
})

test('keepUnbroken: the kit\'s chest and the spawn bed are never broken by a path (the walk to the portal dug the bed, 1.21.11)', async () => {
  const { keepUnbroken } = await import('../../src/skills/tripKit')
  const { Vec3 } = await import('vec3')
  let settings: any = { exclusionAreasBreak: [() => 0], other: 1 }
  const bot: any = { pathfinder: { get defaultMoveSettings () { return settings }, setMoveOptions: (s: any) => { settings = s } } }
  keepUnbroken(bot, [new Vec3(2358, -24, 1015)])
  keepUnbroken(bot, [new Vec3(2359, -24, 1014), new Vec3(2359, -24, 1013)])
  const cost = (x: number, y: number, z: number): number => settings.exclusionAreasBreak.reduce((n: number, f: any) => n + f({ position: new Vec3(x, y, z) }), 0)
  assert.strictEqual(settings.exclusionAreasBreak.length, 2)
  assert.strictEqual(settings.other, 1)
  for (const p of [[2358, -24, 1015], [2359, -24, 1014], [2359, -24, 1013]]) assert.ok(cost(p[0], p[1], p[2]) >= 1e9, p.join(','))
  assert.strictEqual(cost(2360, -24, 1014), 0)
})
