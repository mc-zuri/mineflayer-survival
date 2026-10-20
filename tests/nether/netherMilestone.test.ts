// The nether milestone's fortress search without the seed: the axis walks taken in turn, one noted in memory per search.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { WorldMemory } from '../../src/core/memory'
import { TaskError } from '../../src/core/errors'
import { fortressRoute, fortressRoutes } from '../../src/milestones'

test('the fortress search walks findFortress\'s line first, then the other axis both ways, then back', () => {
  assert.deepEqual(fortressRoutes({ x: -40, z: 10 }), [
    { axis: 'x', direction: -1 }, { axis: 'z', direction: 1 }, { axis: 'z', direction: -1 }, { axis: 'x', direction: 1 }
  ])
  assert.deepEqual(fortressRoutes({ x: 3, z: -90 })[0], { axis: 'z', direction: -1 })
})

test('each search takes the next walk and notes it, so a search that found none isn\'t walked again', () => {
  const memory = new WorldMemory()
  const from = new Vec3(-40, 70, 10)
  const walks = [0, 1, 2, 3, 4].map(() => fortressRoute(memory, from))
  assert.deepEqual(walks.map(w => `${w.direction as number > 0 ? '+' : '-'}${String(w.axis)}`), ['-x', '+z', '-z', '+x', '-x'])
  assert.match(memory.getPois('fortress_search', { dimension: 'the_nether' })[0].note ?? '', /^searches=5;last=-x/)
})

test('eyesShort: out of eyes on the search or in the portal room is a trip back to the nether for more, not the end of the game', async () => {
  const { eyesShort } = await import('../../src/milestones')
  const inv = (items: Record<string, number>) => ({ count: (n: string) => items[n] ?? 0 })
  const memory = new WorldMemory()
  // the search still on: a frame's 12 and 2 for the throws
  assert.equal(eyesShort(inv({ ender_eye: 16 }), memory), 0)
  assert.equal(eyesShort(inv({ ender_eye: 9 }), memory), 5)
  assert.equal(eyesShort(inv({ ender_eye: 9, ender_pearl: 6, blaze_rod: 2 }), memory), 1)
  assert.equal(eyesShort(inv({}), memory), 14)
  // in the portal room: its empty frames
  memory.addPoi('end_portal', { x: 2351, y: -22, z: 1013 }, 'overworld', 'eyes=11')
  assert.equal(eyesShort(inv({ ender_eye: 9 }), memory), 2)
  assert.equal(eyesShort(inv({ ender_eye: 11 }), memory), 0)
})

test('the nether milestone with no lava near and no obsidian gets the frame\'s 10 obsidian first, then builds the portal', async () => {
  const { netherHandler } = await import('../../src/milestones')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const calls: string[] = []
  const executor: any = {
    memory: new WorldMemory(),
    tasks: { tick: 0 },
    obtain: async (reqs: any[]) => { calls.push(`obtain ${reqs.map(r => `${r.count} ${r.item}`).join(', ')}`) },
    task: async (name: string) => { calls.push(name); return { fortress: { center: { x: 0, y: 64, z: 0 } }, via: 'explore', ticks: 0 } }
  }
  const bot = fakeBot({ items: [item('water_bucket', 1), item('bucket', 2), item('diamond_pickaxe', 1), ...NETHER_GEAR()] })
  bot.game.dimension = 'overworld'
  bot.findBlocks = () => []
  await netherHandler({ bot, executor, signal: new AbortController().signal, log: () => {}, milestone: null as any, state: null as any })
  // (the legs for lava first: the fake bot never gets down to the deep lava)
  const { PORTAL_LEGS } = await import('../../src/milestones')
  const from = calls.indexOf('obtain 10 obsidian')
  assert.equal(calls[0], 'down to the deep lava')
  assert.equal(calls.slice(0, from).filter(c => c === 'a leg for lava').length, PORTAL_LEGS)
  // (the nether's kit got before the way in)
  assert.deepStrictEqual(calls.slice(from).filter(c => !/iron_sword|stone_sword|shield|glass_bottle|water bottles|80 arrow/.test(c)).slice(0, 4), ['obtain 10 obsidian', 'up to the surface', 'build a nether portal', 'into the nether'])
})

test('pearls in the nether: the endermen in sight hunted, else a leg on to find piglins or endermen, a few legs at most', async () => {
  const { pearlsInTheNether, PEARL_NETHER_LEGS, PEARL_NETHER_ROUNDS } = await import('../../src/milestones')
  const { fakeBot } = await import('../reflexes/fakeBot')
  const { Vec3 } = await import('vec3')
  const tasks: string[] = []
  const executor: any = { memory: new WorldMemory(), tasks: { tick: 0 }, task: async (name: string) => { tasks.push(name) } }
  const bot = fakeBot({ entities: [{ id: 7, name: 'enderman', position: new Vec3(10, 64, 0), metadata: [] }] })
  bot.game.dimension = 'the_nether'
  assert.equal(await pearlsInTheNether(bot, executor, 4, new AbortController().signal, () => {}), 0)
  // (the hunts aren't legs: as many as the rounds)
  assert.deepEqual(tasks, Array(PEARL_NETHER_ROUNDS).fill('endermen for pearls'))
  tasks.length = 0
  const alone = fakeBot()
  alone.game.dimension = 'the_nether'
  await pearlsInTheNether(alone, executor, 4, new AbortController().signal, () => {})
  assert.deepEqual(tasks, Array(PEARL_NETHER_LEGS).fill('a leg for pearls'))
})

test('a portal\'s frame from the obsidian in sight first (the caves\' lava met by water): mined, then placed', async () => {
  const { buildAPortal } = await import('../../src/milestones')
  const { fakeBot } = await import('../reflexes/fakeBot')
  const { Vec3 } = await import('vec3')
  const calls: string[] = []
  const { item } = await import('../reflexes/fakeBot')
  const bot = fakeBot({ position: new Vec3(0.5, -50, 0.5), items: [item('water_bucket', 1), item('diamond_pickaxe', 1), item('flint_and_steel', 1)] })
  bot.game.dimension = 'overworld'
  const obsidian = bot.registry.blocksByName.obsidian.id
  bot.findBlocks = (opts: any) => opts.matching === obsidian ? Array.from({ length: 12 }, (_, i) => new Vec3(i, -52, 3)) : []
  const executor: any = { memory: new WorldMemory(), tasks: { tick: 0 }, obtain: async () => { calls.push('obtain') }, task: async (name: string) => { calls.push(name) } }
  await buildAPortal(bot, executor, new AbortController().signal, () => {})
  assert.equal(calls[0], 'mine the obsidian')
})

test('a portal with no bucket gets one first; with no lava near to try it walks legs for lava, not five instant failures', async () => {
  const { buildAPortal, PORTAL_LEGS } = await import('../../src/milestones')
  const { fakeBot } = await import('../reflexes/fakeBot')
  const { Vec3 } = await import('vec3')
  const calls: string[] = []
  const bot = fakeBot({ position: new Vec3(0.5, -55, 0.5), items: [require('../reflexes/fakeBot').item('flint_and_steel', 1)] })
  bot.game.dimension = 'overworld'
  bot.findBlocks = () => []
  ;(bot as any).findBlock = () => null
  const executor: any = { memory: new WorldMemory(), tasks: { tick: 0 }, obtain: async (want: any[]) => { calls.push(`obtain ${want[0].item}`) }, task: async (name: string) => { calls.push(name) } }
  await buildAPortal(bot, executor, new AbortController().signal, () => {})
  assert.equal(calls[0], 'obtain bucket')
  assert.equal(calls.filter(c => c === 'a leg for lava').length, PORTAL_LEGS)
  assert.ok(calls.includes('obtain obsidian'))
})

test('the blaze rods wanted are fixed before the task: a restart with rods got meanwhile wants no more than the first', async () => {
  const { netherHandler } = await import('../../src/milestones')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const bot = fakeBot({ items: [item('ender_eye', 0)] })
  bot.game.dimension = 'the_nether'
  ;(bot as any).pathfinder = { defaultMoveSettings: {}, setMoveOptions: () => {} }
  let rods: any = null
  const executor: any = {
    memory: new WorldMemory(),
    tasks: { tick: 0 },
    obtain: async () => {},
    task: async (name: string, fn: (s: AbortSignal) => Promise<unknown>) => {
      if (name !== 'blaze rods') return { fortress: { center: { x: 0, y: 64, z: 0 } }, via: 'explore', ticks: 0 }
      // the restart: the rods the first run got are held when it runs again
      ;(bot.inventory as any).items = () => [{ name: 'blaze_rod', count: 8, type: bot.registry.itemsByName.blaze_rod.id }]
      rods = await fn(new AbortController().signal)
      throw new Error('stop here')
    }
  }
  await assert.rejects(netherHandler({ bot, executor, signal: new AbortController().signal, log: () => {}, milestone: null as any, state: null as any }), /stop here/)
  assert.deepEqual(rods, { rods: 8, kills: 0, ticks: 0 })
})

test('in the nether with few blocks the milestone mines netherrack for its bridges before the fortress', async () => {
  const { netherHandler, NETHER_BLOCKS } = await import('../../src/milestones')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const bot = fakeBot({ items: [item('cobblestone', 8)] })
  bot.game.dimension = 'the_nether'
  ;(bot as any).pathfinder = { defaultMoveSettings: {}, setMoveOptions: () => {} }
  const calls: string[] = []
  const executor: any = {
    memory: new WorldMemory(),
    tasks: { tick: 0 },
    obtain: async (reqs: any[]) => { calls.push(`obtain ${reqs[0].count} ${reqs[0].item}`) },
    task: async (name: string) => { calls.push(name); throw new Error('stop here') }
  }
  await assert.rejects(netherHandler({ bot, executor, signal: new AbortController().signal, log: () => {}, milestone: null as any, state: null as any }), /stop here/)
  assert.equal(calls[0], `obtain ${NETHER_BLOCKS - 8} netherrack`)
})

test('pearls in the nether: a warped forest in sight is gone to, and its endermen fought from cover there', async () => {
  const { pearlsInTheNether, pearlGround } = await import('../../src/milestones')
  const { fakeBot } = await import('../reflexes/fakeBot')
  const { Vec3 } = await import('vec3')
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [require('../reflexes/fakeBot').item('flint_and_steel', 1)] })
  bot.game.dimension = 'the_nether'
  const nylium = bot.registry.blocksByName.warped_nylium.id
  let forestAt = new Vec3(60, 63, 0)
  bot.findBlocks = (opts: any) => (Array.isArray(opts.matching) ? opts.matching : [opts.matching]).includes(nylium) ? Array.from({ length: 12 }, (_, i) => forestAt.offset(i, 0, 0)) : []
  assert.equal(pearlGround(bot, false)?.kind, 'warped forest')
  const tasks: string[] = []
  const executor: any = {
    memory: new WorldMemory(),
    tasks: { tick: 0 },
    task: async (name: string) => { tasks.push(name); if (name === 'a leg for pearls') bot.entity.position = new Vec3(60.5, 64, 0.5) }
  }
  await pearlsInTheNether(bot, executor, 4, new AbortController().signal, () => {})
  assert.equal(tasks[0], 'a leg for pearls')
  assert.equal(tasks[1], 'endermen from cover')
  forestAt = new Vec3(0, 0, 0)
})

test('a portal with no diamond pickaxe (a death lost it) gets one before the lakes', async () => {
  const { buildAPortal } = await import('../../src/milestones')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const { Vec3 } = await import('vec3')
  const calls: string[] = []
  const bot = fakeBot({ position: new Vec3(0.5, -55, 0.5), items: [item('water_bucket', 1), item('flint_and_steel', 1)] })
  bot.game.dimension = 'overworld'
  bot.findBlocks = () => []
  ;(bot as any).findBlock = () => null
  const executor: any = { memory: new WorldMemory(), tasks: { tick: 0 }, obtain: async (want: any[]) => { calls.push(`obtain ${want[0].item}`) }, task: async (name: string) => { calls.push(name) } }
  await buildAPortal(bot, executor, new AbortController().signal, () => {})
  assert.equal(calls[0], 'obtain diamond_pickaxe')
})

test('the night pearl hunt holds the night reflex off (nightWork) while it hunts, and lets it go after', async () => {
  const { pearlsByNight } = await import('../../src/milestones')
  const { fakeBot } = await import('../reflexes/fakeBot')
  const bot = fakeBot()
  bot.game.dimension = 'overworld'
  bot.time = { timeOfDay: 15000, day: 1 } as any
  ;(bot as any).survival = { nightWork: false }
  let tick = 0
  const seen: boolean[] = []
  const executor: any = {
    memory: new WorldMemory(),
    tasks: { get tick () { return tick } },
    task: async () => { seen.push((bot as any).survival.nightWork); tick += 1e6 }
  }
  await pearlsByNight(bot, executor, 4, new AbortController().signal, () => {})
  assert.ok(seen.length > 0 && seen.every(v => v === true))
  assert.equal((bot as any).survival.nightWork, false)
})

test('a pool the tunnel stops short of, within 8 blocks, is worked from there', async () => {
  const gridModule = require('../../src/skills/gridWalk')
  const tunnelModule = require('../../src/skills/tunnel')
  const { buildAPortal } = await import('../../src/milestones')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const { Vec3 } = await import('vec3')
  const bot = fakeBot({ position: new Vec3(0.5, 51, 0.5), items: [item('water_bucket', 1), item('diamond_pickaxe', 1)] })
  bot.game.dimension = 'overworld'
  const lava = bot.registry.blocksByName.lava.id
  // a pool of 12 lava sources 5 below and beside the bot
  bot.findBlocks = (opts: any) => opts.matching === lava ? Array.from({ length: 12 }, (_, i) => new Vec3(i % 4, 46, Math.floor(i / 4))) : []
  const realAt = bot.blockAt.bind(bot)
  bot.blockAt = ((p: any) => (p.y === 46 && p.x >= 0 && p.x < 4 && p.z >= 0 && p.z < 3) ? { ...realAt(p), name: 'lava', getProperties: () => ({ level: 0 }) } : realAt(p)) as any
  const calls: string[] = []
  const realMove = gridModule.moveNear
  const realTunnel = tunnelModule.tunnelTo
  gridModule.moveNear = async () => { throw new Error('NO_PATH: none') }
  tunnelModule.tunnelTo = async () => { throw new Error('NO_PATH: no safe step') }
  const executor: any = {
    memory: new WorldMemory(),
    tasks: { tick: 0 },
    obtain: async () => {},
    task: async (name: string, fn: any) => { calls.push(name); if (name === 'to the lava') return await fn(new AbortController().signal); if (name === 'build a nether portal') throw new Error('stop here') }
  }
  try {
    await assert.rejects(buildAPortal(bot, executor, new AbortController().signal, () => {}), /stop here/)
  } finally {
    gridModule.moveNear = realMove
    tunnelModule.tunnelTo = realTunnel
  }
  assert.equal(calls[calls.indexOf('to the lava') + 1], 'build a nether portal', calls.join(', '))
})

/** puts items in a fake bot's first empty bag slots */
function giveTo (bot: any, items: any[]): void {
  for (const it of items) {
    const slot = bot.inventory.slots.findIndex((s: any, i: number) => i >= 9 && i < 45 && s == null)
    bot.inventory.slots[slot] = it
  }
}

/** what netherGearNeeds asks for, so a test bot goes in */
function NETHER_GEAR (): any[] {
  const { item } = require('../reflexes/fakeBot')
  return [item('diamond_sword', 1), item('iron_chestplate', 1), item('iron_helmet', 1), item('iron_leggings', 1), item('golden_boots', 1), item('cooked_beef', 16), item('flint_and_steel', 1), item('shield', 1), item('bow', 1), item('arrow', 64)]
}

test('netherKit: the bot does not go in without a sword, armor, gold and food: got, else the milestone fails', async () => {
  const { netherKit, netherGearNeeds } = await import('../../src/milestones')
  const { ownedInventory } = await import('../../src/executor/executor')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const bare = fakeBot({ items: [item('dirt', 3)] })
  assert.deepStrictEqual(netherGearNeeds(ownedInventory(bare)).map(r => r.unit === 'nutrition' ? 'food' : r.item), ['stone_sword', 'iron_chestplate', 'iron_helmet', 'iron_leggings', 'golden_boots', 'shield', 'bow', 'arrow', 'food'])
  assert.deepStrictEqual(netherGearNeeds(ownedInventory(fakeBot({ items: NETHER_GEAR() }))), [])
  // 4 ingots do for the boots (made by the kit)
  assert.deepStrictEqual(netherGearNeeds(ownedInventory(fakeBot({ items: [item('iron_sword', 1), item('iron_chestplate', 1), item('iron_helmet', 1), item('iron_leggings', 1), item('gold_ingot', 4), item('bread', 24), item('shield', 1), item('bow', 1), item('arrow', 64)] }))), [])
  // a sword alone, no bow: the bow and its arrows asked for (a throne's blazes aren't fought with the sword alone)
  assert.deepStrictEqual(netherGearNeeds(ownedInventory(fakeBot({ items: [item('iron_sword', 1), item('iron_chestplate', 1), item('iron_helmet', 1), item('iron_leggings', 1), item('golden_boots', 1), item('cooked_beef', 16), item('shield', 1)] }))).map(r => r.item), ['bow', 'arrow'])
  // a bow with few arrows: the arrows asked for too
  assert.deepStrictEqual(netherGearNeeds(ownedInventory(fakeBot({ items: [item('iron_sword', 1), item('iron_chestplate', 1), item('iron_helmet', 1), item('iron_leggings', 1), item('golden_boots', 1), item('cooked_beef', 16), item('shield', 1), item('bow', 1), item('arrow', 16)] }))).map(r => r.item), ['arrow'])
  // 40 food points (the gate's before): more asked for
  assert.ok(netherGearNeeds(ownedInventory(fakeBot({ items: [item('iron_sword', 1), item('iron_chestplate', 1), item('iron_helmet', 1), item('iron_leggings', 1), item('golden_boots', 1), item('cooked_beef', 5), item('shield', 1), item('bow', 1), item('arrow', 64)] }))).some(r => r.unit === 'nutrition'))
  // nothing comes of the gathering: no going in
  const executor: any = { memory: new WorldMemory(), tasks: { tick: 0 }, obtain: async () => {}, task: async () => {} }
  await assert.rejects(netherKit(bare, executor, new AbortController().signal, () => {}), /not going into the nether without/)
  // the gathering gets it: in it goes
  const got = fakeBot({ items: [item('dirt', 3)] })
  executor.obtain = async (reqs: any[]) => { if (reqs.some(r => r.item === 'golden_boots')) giveTo(got, NETHER_GEAR()) }
  await netherKit(got, executor, new AbortController().signal, () => {})
})

test('netherKit: a sword (stone at least), a chestplate and a shield got when missing, and golden boots made, before the nether', async () => {
  const { netherKit } = await import('../../src/milestones')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const bot = fakeBot({ items: [item('stone_pickaxe', 1), item('gold_ingot', 8), item('cooked_beef', 16), item('bow', 1), item('arrow', 64)] })
  const calls: string[] = []
  const executor: any = {
    memory: new WorldMemory(),
    tasks: { tick: 0 },
    obtain: async (reqs: any[]) => {
      calls.push(`obtain ${reqs.map(r => r.item).join(',')}`)
      if (reqs.some(r => r.item === 'iron_chestplate')) giveTo(bot, [item('iron_chestplate', 1), item('iron_helmet', 1), item('iron_leggings', 1)])
      if (reqs.some(r => r.item === 'shield')) giveTo(bot, [item('shield', 1)])
      if (reqs.some(r => r.item === 'stone_sword')) giveTo(bot, [item('stone_sword', 1)])
      if (reqs.some(r => r.item === 'golden_boots')) giveTo(bot, [item('golden_boots', 1)])
    },
    task: async (name: string) => { calls.push(name) }
  }
  await netherKit(bot, executor, new AbortController().signal, () => {})
  // (then the brewing's bottles: brewKit)
  assert.deepStrictEqual(calls, ['obtain iron_sword,iron_chestplate,shield', 'obtain stone_sword', 'obtain golden_boots', 'obtain glass_bottle,crafting_table,cobblestone', 'fill the water bottles'])
  calls.length = 0
  const armed = fakeBot({ items: [item('diamond_sword', 1), item('diamond_chestplate', 1), item('diamond_helmet', 1), item('diamond_leggings', 1), item('shield', 1), item('golden_boots', 1), item('bread', 24), item('bow', 1), item('arrow', 64)] })
  await netherKit(armed, executor, new AbortController().signal, () => {})
  // (the bottles alone)
  assert.deepStrictEqual(calls, ['obtain glass_bottle,crafting_table,cobblestone', 'fill the water bottles'])
})

test('netherKit: short of the food, the farm grown by the base is harvested and baked before the gate\'s gathering is planned', async () => {
  const { netherKit } = await import('../../src/milestones')
  const { rememberFarm } = await import('../../src/skills/farm')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const { Vec3 } = await import('vec3')
  const gear = NETHER_GEAR().filter((i: any) => i.name !== 'cooked_beef')
  const bot = fakeBot({ items: gear })
  bot.game.dimension = 'overworld'
  bot.time = { age: 100000 }
  const memory = new WorldMemory()
  rememberFarm(memory, { crop: 'wheat', water: new Vec3(5, 63, 0), cells: [new Vec3(4, 63, 0), new Vec3(6, 63, 0)] } as any, 0)
  const calls: string[] = []
  const executor: any = {
    memory,
    tasks: { tick: 0 },
    farmCost: () => 0,
    runStep: async (step: any) => { calls.push(`${step.kind} ${step.crop}`); giveTo(bot, [item('wheat', 60)]) },
    obtain: async (reqs: any[]) => {
      calls.push(`obtain ${reqs.map(r => r.unit === 'nutrition' ? 'food' : r.item).join(',')}`)
      if (reqs.some(r => r.item === 'bread')) giveTo(bot, [item('bread', 24)])
    },
    task: async (name: string) => { calls.push(name) }
  }
  await netherKit(bot, executor, new AbortController().signal, () => {})
  // the bread covers the gate: nothing else gathered
  assert.deepStrictEqual(calls.filter(c => !/glass_bottle|water bottles/.test(c)), ['farm wheat', 'obtain bread'])
})

test('netherGate: 80 food points with a farm or a herd known, else 120, the play option over both; 16 arrows with 2 fire resistance potions, 32 once no chicken was found, else 64', async () => {
  const { netherGate, netherGearNeeds } = await import('../../src/milestones')
  const { rememberFarm } = await import('../../src/skills/farm')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const { ownedInventory } = await import('../../src/executor/executor')
  const { Vec3 } = await import('vec3')
  const memory = new WorldMemory()
  const bot = fakeBot({ items: [] })
  assert.deepStrictEqual(netherGate(bot, { memory }), { food: 120, arrows: 64, bow: true })
  rememberFarm(memory, { crop: 'wheat', water: new Vec3(5, 63, 0), cells: [new Vec3(4, 63, 0)] } as any, 0)
  assert.equal(netherGate(bot, { memory }).food, 80)
  bot.survival = { playOptions: { netherFood: 60 } }
  assert.equal(netherGate(bot, { memory }).food, 60)
  assert.equal(netherGate(bot, { memory, sightings: { misses: (n: string) => n === 'chicken' ? 1 : 0 } }).arrows, 32)
  // and so on, a chicken seen since (its miss cleared)
  assert.equal(netherGate(bot, { memory, sightings: { misses: () => 0 } }).arrows, 32)
  const potion = (id: number): any => Object.assign(item('potion', 1), { componentMap: new Map([['potion_contents', { data: { potionId: id } }]]) })
  const brewed = fakeBot({ items: [potion(11), potion(12)] })
  assert.equal(netherGate(brewed, { memory }).arrows, 16)
  assert.equal(netherGate(fakeBot({ items: [potion(11)] }), { memory }).arrows, 64)
  // the needs go by the gate: 80 points of bread are enough with a farm, 16 arrows with the potions
  const inv = ownedInventory(fakeBot({ items: [...NETHER_GEAR().filter((i: any) => i.name !== 'cooked_beef' && i.name !== 'arrow'), item('bread', 16), item('arrow', 16)] }))
  assert.deepStrictEqual(netherGearNeeds(inv, { food: 80, arrows: 16 }), [])
  assert.deepStrictEqual(netherGearNeeds(inv).map(r => r.unit === 'nutrition' ? 'food' : r.item), ['arrow', 'food'])
})

test('netherKit: the arrows are got on their own after the gear, and once the hunt for the feathers chickens missed the gate asks for fewer', async () => {
  const { netherKit } = await import('../../src/milestones')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const bot = fakeBot({ items: [...NETHER_GEAR().filter((i: any) => i.name !== 'arrow' && i.name !== 'iron_helmet'), item('arrow', 34)] })
  bot.game.dimension = 'overworld'
  const asked: string[] = []
  let misses = 0
  const executor: any = {
    memory: new WorldMemory(),
    tasks: { tick: 0 },
    sightings: { misses: (n: string) => n === 'chicken' ? misses : 0 },
    obtain: async (reqs: any[]) => {
      asked.push(reqs.map(r => r.item).join(','))
      if (reqs.some(r => r.item === 'iron_helmet')) giveTo(bot, [item('iron_helmet', 1)])
      // no chicken found for the feathers
      if (reqs.some(r => r.item === 'arrow')) misses++
    },
    task: async () => {}
  }
  await netherKit(bot, executor, new AbortController().signal, () => {})
  // (then the brewing's bottles: brewKit)
  assert.deepStrictEqual(asked, ['iron_helmet', 'arrow', 'glass_bottle,crafting_table,cobblestone'])
  // the arrows' obtain stopped by its budget, no miss of its own: the chickens noted missing, fewer asked for
  const timed = fakeBot({ items: [...NETHER_GEAR().filter((i: any) => i.name !== 'arrow'), item('arrow', 33)] })
  timed.game.dimension = 'overworld'
  const missed: string[] = []
  const stopped: any = {
    memory: new WorldMemory(),
    tasks: { tick: 0 },
    sightings: { misses: (n: string) => missed.filter(m => m === n).length, missing: (names: string[]) => missed.push(...names) },
    obtain: async (reqs: any[]) => { if (reqs.some(r => r.item === 'arrow')) throw new TaskError('TIMEOUT', 'over the budget of 12000 ticks') },
    task: async () => {}
  }
  await netherKit(timed, stopped, new AbortController().signal, () => {})
  assert.deepStrictEqual(missed, ['chicken'])
})

test('netherKit: no bow got within its budget (no spider found for the string), the gate goes without the bow and its arrows and asks for the water bottles for fire resistance', async () => {
  const { netherKit, netherGate } = await import('../../src/milestones')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const gear = NETHER_GEAR().filter((i: any) => i.name !== 'bow' && i.name !== 'arrow')
  // a spider missed already: no bow asked for
  const memory = new WorldMemory()
  assert.equal(netherGate(fakeBot({ items: gear }), { memory, sightings: { misses: (n: string) => n === 'spider' ? 1 : 0 } }).bow, false)
  assert.equal(netherGate(fakeBot({ items: [...gear, item('bow', 1)] }), { memory, sightings: { misses: () => 1 } }).bow, true)
  const bot = fakeBot({ items: gear })
  bot.game.dimension = 'overworld'
  const missed: string[] = []
  const asked: string[] = []
  const executor: any = {
    memory,
    tasks: { tick: 0 },
    sightings: { misses: (n: string) => missed.filter(m => m === n).length, missing: (names: string[]) => missed.push(...names) },
    obtain: async (reqs: any[]) => {
      asked.push(reqs.map(r => r.item).join(','))
      if (reqs.some(r => r.item === 'bow')) throw new TaskError('NOT_FOUND', 'no spider found exploring')
    },
    task: async () => {}
  }
  const err: any = await netherKit(bot, executor, new AbortController().signal, () => {}).then(() => null, e => e)
  assert.deepStrictEqual(missed, ['spider'])
  assert.equal(asked[0], 'bow')
  // no arrows asked for after; the bottles (none to be had here) keep it out
  assert.ok(!asked.includes('arrow'), asked.join(' | '))
  assert.match(err?.message ?? '', /without a bow or 3 water bottles/)
  assert.equal(err?.notReady, true)
})

test('netherKit: short of only the food after its tries, the milestone is not ready with the food points banked (foodShort)', async () => {
  const { netherKit } = await import('../../src/milestones')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const bot = fakeBot({ items: [...NETHER_GEAR().filter((i: any) => i.name !== 'cooked_beef'), item('bread', 4)] })
  bot.game.dimension = 'overworld'
  const asked: string[] = []
  const executor: any = { memory: new WorldMemory(), tasks: { tick: 0 }, obtain: async (reqs: any[]) => { asked.push(reqs.map(r => r.unit === 'nutrition' ? 'food' : r.item).join(',')) }, task: async () => {} }
  const err: any = await netherKit(bot, executor, new AbortController().signal, () => {}).then(() => null, e => e)
  assert.equal(err?.notReady, true)
  assert.equal(err?.foodShort, true)
  assert.equal(err?.foodPoints, 20)
  assert.deepStrictEqual(asked, ['food'])
})

test('goldOnInTheNether: the golden piece put on once in the nether, not in the overworld', async () => {
  const { goldOnInTheNether } = await import('../../src/milestones')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const bot = fakeBot({ items: [item('golden_boots', 1)] })
  const calls: string[] = []
  const executor: any = { memory: new WorldMemory(), tasks: { tick: 0 }, task: async (name: string) => { calls.push(name) } }
  bot.game.dimension = 'overworld'
  await goldOnInTheNether(bot, executor, new AbortController().signal, () => {})
  assert.deepStrictEqual(calls, [])
  bot.game.dimension = 'the_nether'
  await goldOnInTheNether(bot, executor, new AbortController().signal, () => {})
  assert.deepStrictEqual(calls, ['gold on for the piglins'])
})

test('the nether pearl legs spiral out from where the search began, no point twice', async () => {
  const { pearlsInTheNether, PEARL_NETHER_LEGS } = await import('../../src/milestones')
  const { fakeBot } = await import('../reflexes/fakeBot')
  const { Vec3 } = await import('vec3')
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [require('../reflexes/fakeBot').item('flint_and_steel', 1)] })
  bot.game.dimension = 'the_nether'
  const lines: string[] = []
  const executor: any = { memory: new WorldMemory(), tasks: { tick: 0 }, task: async () => {} }
  await pearlsInTheNether(bot, executor, 4, new AbortController().signal, l => lines.push(l))
  const points = lines.map(l => /on to \(([^)]+)\)/.exec(l)?.[1]).filter(p => p != null)
  assert.equal(points.length, PEARL_NETHER_LEGS)
  assert.equal(new Set(points).size, points.length)
})

test('a way in through the remembered portal that fails makes another the milestone\'s way, then goes in', async () => {
  const { netherHandler } = await import('../../src/milestones')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const bot = fakeBot({ items: [item('obsidian', 10), ...NETHER_GEAR()] })
  bot.game.dimension = 'overworld'
  const memory = new WorldMemory()
  memory.addPoi('nether_portal', { x: 3, y: 64, z: 0 }, 'overworld', 'built')
  const calls: string[] = []
  let tries = 0
  const executor: any = {
    memory,
    tasks: { tick: 0 },
    plan: () => ({ ok: false }),
    obtain: async () => {},
    task: async (name: string) => {
      calls.push(name)
      if (name === 'into the nether' && tries++ === 0) throw new Error("NO_PATH: couldn't step into the portal")
      if (name === 'into the nether') throw new Error('stop here')
    }
  }
  await assert.rejects(netherHandler({ bot, executor, signal: new AbortController().signal, log: () => {}, milestone: null as any, state: null as any }), /stop here/)
  const first = calls.indexOf('into the nether')
  assert.deepStrictEqual(calls.slice(first, first + 4), ['into the nether', 'up to the surface', 'build a nether portal', 'into the nether'])
  assert.equal(memory.getPois('nether_portal', { dimension: 'overworld' }).length, 0)
})

test('the nether pearl legs aim well over the lava sea, not at the bot\'s height by its shore', async () => {
  const { pearlsInTheNether, PEARL_LEG_Y } = await import('../../src/milestones')
  const { fakeBot } = await import('../reflexes/fakeBot')
  const { Vec3 } = await import('vec3')
  const bot = fakeBot({ position: new Vec3(0.5, 33, 0.5) })
  bot.game.dimension = 'the_nether'
  const lines: string[] = []
  const executor: any = { memory: new WorldMemory(), tasks: { tick: 0 }, task: async () => {} }
  await pearlsInTheNether(bot, executor, 4, new AbortController().signal, l => lines.push(l))
  const ys = lines.map(l => /on to \(-?\d+, (-?\d+),/.exec(l)?.[1]).filter(y => y != null).map(Number)
  assert.ok(ys.length > 0 && ys.every(y => y >= PEARL_LEG_Y), ys.join(','))
})

test('upFromLowGround: by the lava sea in the nether the bot pillars up 8, not higher up or out of the nether', async () => {
  const { upFromLowGround } = await import('../../src/milestones')
  const { fakeBot } = await import('../reflexes/fakeBot')
  const { Vec3 } = await import('vec3')
  const calls: string[] = []
  const executor: any = { memory: new WorldMemory(), tasks: { tick: 0 }, task: async (name: string) => { calls.push(name) } }
  const low = fakeBot({ position: new Vec3(0.5, 34, 0.5) })
  low.game.dimension = 'the_nether'
  await upFromLowGround(low, executor, new AbortController().signal, () => {})
  const high = fakeBot({ position: new Vec3(0.5, 70, 0.5) })
  high.game.dimension = 'the_nether'
  await upFromLowGround(high, executor, new AbortController().signal, () => {})
  const over = fakeBot({ position: new Vec3(0.5, 34, 0.5) })
  over.game.dimension = 'overworld'
  await upFromLowGround(over, executor, new AbortController().signal, () => {})
  assert.deepEqual(calls, ['up from the low ground'])
})

test('recoverNetherDrops: back to a nether death\'s drops off the lava sea, once', async () => {
  const { recoverNetherDrops } = await import('../../src/milestones')
  const { fakeBot } = await import('../reflexes/fakeBot')
  const { Vec3 } = await import('vec3')
  const bot = fakeBot()
  bot.game.dimension = 'the_nether'
  const memory = new WorldMemory()
  const calls: string[] = []
  const executor: any = { memory, tasks: { tick: 0 }, task: async (name: string) => { calls.push(name) } }
  memory.setDeath(new Vec3(60, 64, -530), 'the_nether')
  await recoverNetherDrops(bot, executor, new AbortController().signal, () => {})
  assert.deepEqual(calls, ['the nether drops'])
  assert.equal(memory.death, null)
  memory.setDeath(new Vec3(60, 31, -530), 'the_nether')
  await recoverNetherDrops(bot, executor, new AbortController().signal, () => {})
  assert.deepEqual(calls, ['the nether drops'])
})

test('a night hunt\'s legs go round the spiral\'s points in turn, again from the first after the last', async () => {
  const { nightLeg } = await import('../../src/milestones')
  const legs = Array.from({ length: 40 }, (_, i) => nightLeg({ x: 100, z: -50 }, i))
  assert.ok(legs.every(p => p != null && Number.isFinite(p.x) && Number.isFinite(p.z)), 'a leg with no point')
  const distinct = new Set(legs.map(p => `${p.x},${p.z}`)).size
  assert.ok(distinct >= 12 && distinct < 24, `${distinct} points`)
  assert.deepEqual(legs[distinct], legs[0])
  assert.ok(legs.every(p => Math.max(Math.abs(p.x - 100), Math.abs(p.z + 50)) <= 240))
})

test('the blaze rods: a spawner there\'s no way to is left for another of the fortress, and with none other found, another fortress', async () => {
  const { netherHandler } = await import('../../src/milestones')
  const fortressSkills = require('../../src/nether/fortressSkills')
  const { SkillError } = await import('../../src/skills/errors')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const bot = fakeBot({ items: [item('ender_eye', 0), item('bow', 1), item('arrow', 64)] })
  bot.game.dimension = 'the_nether'
  bot.findBlocks = () => []
  ;(bot as any).pathfinder = { defaultMoveSettings: {}, setMoveOptions: () => {} }
  const memory = new WorldMemory()
  ;(bot as any).survival = { memory }
  memory.addPoi('blaze_spawner', { x: 870, y: 76, z: 143 }, 'the_nether')
  const calls: string[] = []
  const real = { collect: fortressSkills.collectBlazeRods, find: fortressSkills.findFortress }
  let collects = 0
  fortressSkills.findFortress = async (_b: unknown, args: any) => {
    calls.push(`find a fortress, not ${(args.exclude ?? []).map((p: any) => `${p.x} ${p.z}`).join(';')}`)
    return { fortress: { center: { x: 300, y: 64, z: 40 } }, via: 'explore', ticks: 0 }
  }
  fortressSkills.collectBlazeRods = async (_b: unknown, args: any) => {
    collects++
    calls.push(`blaze rods at ${args.spawner == null ? 'one found' : `${args.spawner.x} ${args.spawner.z}`}, not ${(args.exclude ?? []).map((p: any) => `${p.x} ${p.z}`).join(';')}`)
    if (collects === 1) {
      fortressSkills.markSpawnerUnreachable(bot, args.spawner)
      throw new SkillError('NO_PATH', 'no way to the blaze spawner at (870, 76, 143)')
    }
    if (collects === 2) throw new SkillError('NOT_FOUND', 'no blaze spawner found in the fortress')
    throw new Error('stop here')
  }
  const executor: any = { memory, tasks: { tick: 0 }, obtain: async () => {}, task: async (_name: string, fn: (s: AbortSignal) => Promise<unknown>) => await fn(new AbortController().signal) }
  try {
    await assert.rejects(netherHandler({ bot, executor, signal: new AbortController().signal, log: () => {}, milestone: null as any, state: null as any }), /stop here/)
  } finally {
    fortressSkills.collectBlazeRods = real.collect
    fortressSkills.findFortress = real.find
  }
  assert.deepEqual(calls, [
    'blaze rods at 870 143, not ',
    // the fortress's other spawner looked for
    'blaze rods at one found, not 870 143',
    // none other: another fortress
    'find a fortress, not 870 143',
    'blaze rods at one found, not 870 143'
  ])
})

test('pearls in the nether with the seed: legs to its nearest warped forest, its endermen fought from cover there, another spot in one when none came', async () => {
  const { pearlsInTheNether, FOREST_IDLE } = await import('../../src/milestones')
  const { NetherBiomeSource } = await import('../../src/worldgen/netherBiomes')
  const { fakeBot } = await import('../reflexes/fakeBot')
  const { Vec3 } = await import('vec3')
  // by seed 2's spawn portal, in the nether wastes
  const bot = fakeBot({ position: new Vec3(2.5, 64, -1.5) })
  bot.game.dimension = 'the_nether'
  const lines: string[] = []
  const tasks: string[] = []
  const executor: any = {
    memory: new WorldMemory(),
    tasks: { tick: 0 },
    task: async (name: string) => {
      tasks.push(name)
      if (name === 'endermen from cover') {
        executor.tasks.tick += FOREST_IDLE
        return { pearls: 0, kills: 0, ticks: FOREST_IDLE, reason: 'idle' }
      }
      if (name === 'a leg for pearls') {
        executor.tasks.tick += 2000
        const m = /on to \((-?\d+), (-?\d+), (-?\d+)\)/.exec(lines[lines.length - 1]) as RegExpExecArray
        bot.entity.position = new Vec3(Number(m[1]) + 0.5, Number(m[2]), Number(m[3]) + 0.5)
      }
    }
  }
  await pearlsInTheNether(bot, executor, 4, new AbortController().signal, l => lines.push(l), '2')
  const legs = lines.filter(l => /on to/.test(l))
  // seed 2's nearest warped forest from the portal: south-west, 420 off (the server's biome at -224, 352)
  assert.match(legs[0], /on to \(-224, 64, 352\) for the seed's warped forest, 420 off/)
  const biomes = new NetherBiomeSource(2)
  // in it: the cover's fight till FOREST_IDLE has gone with no enderman, then another spot of a warped forest
  assert.deepEqual(tasks.slice(0, 4), ['a leg for pearls', 'endermen from cover', 'a leg for pearls', 'endermen from cover'])
  const points = legs.map(l => /on to \((-?\d+), -?\d+, (-?\d+)\)/.exec(l) as RegExpExecArray).map(m => ({ x: Number(m[1]), z: Number(m[2]) }))
  assert.ok(points.length >= 2)
  assert.equal(new Set(points.map(p => `${p.x},${p.z}`)).size, points.length, 'no spot twice')
  for (const p of points) assert.equal(biomes.biomeAt(p.x, p.z), 'warped_forest')
})

test('pearls in the nether: in a warped forest where the cover fails COVER_FAILS times, its endermen waited for and hunted as before', async () => {
  const { pearlsInTheNether, COVER_FAILS, FOREST_WAIT } = await import('../../src/milestones')
  const { fakeBot, entity } = await import('../reflexes/fakeBot')
  const { Vec3 } = await import('vec3')
  // in seed 2's south-western warped forest
  const bot = fakeBot({ position: new Vec3(-335.5, 64, 304.5) })
  bot.game.dimension = 'the_nether'
  const tasks: string[] = []
  const lines: string[] = []
  const executor: any = {
    memory: new WorldMemory(),
    tasks: { tick: 0 },
    task: async (name: string) => {
      tasks.push(name)
      executor.tasks.tick += name === 'wait for endermen' ? FOREST_WAIT : 100
      if (name === 'endermen from cover') throw new Error('VERIFY_FAILED: the cover was broken')
      // one come after the waits: hunted
      if (tasks.length === 2 * COVER_FAILS + 1) bot.entities[1000] = entity({ id: 1000, name: 'enderman', position: new Vec3(-325.5, 64, 304.5) })
      if (name === 'endermen for pearls') delete bot.entities[1000]
    }
  }
  await pearlsInTheNether(bot, executor, 4, new AbortController().signal, l => lines.push(l), '2')
  // each cover that failed: a wait as before; then no cover more, the waits and the hunt
  assert.deepEqual(tasks.slice(0, 2 * COVER_FAILS), Array(COVER_FAILS).fill(['endermen from cover', 'wait for endermen']).flat())
  assert.equal(tasks.filter(t => t === 'endermen from cover').length, COVER_FAILS)
  assert.deepEqual(tasks.slice(2 * COVER_FAILS, 2 * COVER_FAILS + 2), ['wait for endermen', 'endermen for pearls'])
  assert.match(lines[0], /the cover: VERIFY_FAILED: the cover was broken/)
})

test('pearls in the nether: no ground for a cover at a spot of the warped forest: on to another spot of it', async () => {
  const { pearlsInTheNether } = await import('../../src/milestones')
  const { fakeBot } = await import('../reflexes/fakeBot')
  const { Vec3 } = await import('vec3')
  const bot = fakeBot({ position: new Vec3(-335.5, 64, 304.5) })
  bot.game.dimension = 'the_nether'
  const tasks: string[] = []
  const lines: string[] = []
  const executor: any = {
    memory: new WorldMemory(),
    tasks: { tick: 0 },
    task: async (name: string) => {
      tasks.push(name)
      executor.tasks.tick += 100
      if (name === 'endermen from cover') throw new Error('NOT_FOUND: no ground for an enderman cover within 12 blocks')
      if (name === 'a leg for pearls') {
        const m = /on to ((-?d+), (-?d+), (-?d+))/.exec(lines[lines.length - 1]) as RegExpExecArray
        bot.entity.position = new Vec3(Number(m[1]) + 0.5, Number(m[2]), Number(m[3]) + 0.5)
      }
    }
  }
  await pearlsInTheNether(bot, executor, 4, new AbortController().signal, l => lines.push(l), '2')
  assert.deepEqual(tasks.slice(0, 4), ['endermen from cover', 'a leg for pearls', 'endermen from cover', 'a leg for pearls'])
  const legs = lines.filter(l => /on to/.test(l))
  assert.match(legs[0], /for the seed's warped forest/)
  assert.notEqual(legs[0], legs[1])
})

test('pearls by night: an enderman there\'s no way to is passed over for the night\'s legs, not hunted round after round', async () => {
  const { pearlsByNight } = await import('../../src/milestones')
  const { fakeBot, entity } = await import('../reflexes/fakeBot')
  const { Vec3 } = await import('vec3')
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [require('../reflexes/fakeBot').item('flint_and_steel', 1)] })
  bot.game.dimension = 'overworld'
  ;(bot as any).time = { timeOfDay: 18000 }
  const far = entity({ name: 'enderman', position: new Vec3(30.5, 90, 0.5) })
  bot.entities[far.id] = far
  // (behind the cliff: no stare)
  ;(bot as any).world = { raycast: () => ({ position: new Vec3(10, 70, 0) }) }
  const tasks: string[] = []
  const executor: any = {
    memory: new WorldMemory(),
    tasks: { tick: 0 },
    // the hunt itself runs (the fake bot has no pathfinder: no way to the enderman); the rest is noted
    // (no ground for a cover about: the open hunt after NIGHT_COVER_FAILS tries)
    task: async (name: string, fn: (s: AbortSignal) => Promise<unknown>) => {
      tasks.push(name)
      executor.tasks.tick += 500
      if (name === 'endermen from cover') throw new Error('NOT_FOUND: no ground for an enderman cover within 12 blocks')
      if (name === 'endermen for pearls') return await fn(new AbortController().signal)
    }
  }
  await pearlsByNight(bot, executor, 2, new AbortController().signal, () => {})
  const open = tasks.filter(t => t !== 'endermen from cover')
  assert.equal(open[0], 'endermen for pearls')
  assert.equal(open.filter(t => t === 'endermen for pearls').length, 1)
  assert.equal(open[1], 'a night leg for endermen')
})

test('pearls by night: the endermen fought from a cover (endermenFromCover), the open hunt where there is no ground for one, and for good after NIGHT_COVER_FAILS such (full-26.3-fresh-d)', async () => {
  const { pearlsByNight, NIGHT_COVER_FAILS } = await import('../../src/milestones')
  const { fakeBot, entity } = await import('../reflexes/fakeBot')
  const { Vec3 } = await import('vec3')
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5) })
  bot.game.dimension = 'overworld'
  ;(bot as any).time = { timeOfDay: 18000 }
  const e = entity({ name: 'enderman', position: new Vec3(10.5, 64, 0.5) })
  bot.entities[e.id] = e
  ;(bot as any).world = { raycast: () => null }
  const tasks: string[] = []
  let noGround = true
  const executor: any = {
    memory: new WorldMemory(),
    tasks: { tick: 0 },
    task: async (name: string) => {
      tasks.push(name)
      executor.tasks.tick += 500
      if (name === 'endermen from cover' && noGround) throw new Error('NOT_FOUND: no ground for an enderman cover within 12 blocks')
      if (tasks.length >= 8) executor.tasks.tick += 1e6
    }
  }
  await pearlsByNight(bot, executor, 2, new AbortController().signal, () => {})
  // each round with no ground the open hunt instead; NIGHT_COVER_FAILS of them, the cover no more
  assert.equal(tasks[0], 'endermen from cover')
  assert.equal(tasks.filter(t => t === 'endermen from cover').length, NIGHT_COVER_FAILS)
  assert.ok(tasks.slice(2 * NIGHT_COVER_FAILS).every(t => t === 'endermen for pearls'), tasks.join(' | '))
  tasks.length = 0
  noGround = false
  executor.tasks.tick = 0
  await pearlsByNight(bot, executor, 2, new AbortController().signal, () => {})
  assert.ok(tasks.length > 0 && tasks.every(t => t === 'endermen from cover'), tasks.join(' | '))
})

test('pearls in the nether: PEARL_BARTERS barters at most, then the legs, a piglin in sight or not', async () => {
  const { pearlsInTheNether, PEARL_BARTERS } = await import('../../src/milestones')
  const { fakeBot, entity, item } = await import('../reflexes/fakeBot')
  const { Vec3 } = await import('vec3')
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [item('gold_ingot', 32)] })
  bot.game.dimension = 'the_nether'
  const piglin = entity({ name: 'piglin', position: new Vec3(5.5, 64, 0.5) })
  bot.entities[piglin.id] = piglin
  const tasks: string[] = []
  const executor: any = { memory: new WorldMemory(), tasks: { tick: 0 }, task: async (name: string) => { tasks.push(name); executor.tasks.tick += 1000; if (name === 'barter for pearls') throw new Error('TIMEOUT: 0 of 16 pearls') } }
  await pearlsInTheNether(bot, executor, 4, new AbortController().signal, () => {}, '2')
  assert.equal(tasks.filter(t => t === 'barter for pearls').length, PEARL_BARTERS)
  assert.equal(tasks[PEARL_BARTERS], 'a leg for pearls')
})

test('castNearSpot: a deep pool cast CAST_AWAY blocks past its sources on the bot side, at its height; none for a high pool', async () => {
  const { castNearSpot, CAST_AWAY, CAST_NEAR_Y } = await import('../../src/milestones')
  const lava = Array.from({ length: 12 }, (_, i) => ({ x: 100 + (i % 4), y: -55, z: -200 + Math.floor(i / 4) }))
  const spot = castNearSpot({ x: 90.5, y: -50, z: -199.5 }, lava)
  assert.ok(spot != null)
  assert.equal(spot.y, -50)
  // west of the pool (x 100 to 103), CAST_AWAY past its west edge
  assert.ok(spot.x <= 100 - CAST_AWAY + 1 && spot.x >= 100 - CAST_AWAY - 3, spot.toString())
  assert.ok(Math.abs(spot.z - -199) <= 1, spot.toString())
  assert.equal(castNearSpot({ x: 90.5, y: CAST_NEAR_Y, z: -199.5 }, lava), null)
})

test('a deep pool with no shore and no diamond pickaxe has its cast made near it, not carried up to the surface', async () => {
  const { SkillError } = await import('../../src/skills/errors')
  const gridModule = require('../../src/skills/gridWalk')
  const tunnelModule = require('../../src/skills/tunnel')
  const { buildAPortal } = await import('../../src/milestones')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const { Vec3 } = await import('vec3')
  const bot = fakeBot({ position: new Vec3(0.5, -50, 0.5), items: [item('water_bucket', 1), item('bucket', 1), item('cobblestone', 64)] })
  bot.game.dimension = 'overworld'
  const lava = bot.registry.blocksByName.lava.id
  // a pool of 12 lava sources under the bot's feet level beside it
  bot.findBlocks = (opts: any) => opts.matching === lava ? Array.from({ length: 12 }, (_, i) => new Vec3(2 + (i % 4), -55, Math.floor(i / 4))) : []
  const realAt = bot.blockAt.bind(bot)
  bot.blockAt = ((p: any) => (p.y === -55 && p.x >= 2 && p.x < 6 && p.z >= 0 && p.z < 3) ? { ...realAt(p), name: 'lava', getProperties: () => ({ level: 0 }) } : realAt(p)) as any
  const calls: string[] = []
  const realMove = gridModule.moveNear
  gridModule.moveNear = async () => {}
  const executor: any = {
    memory: new WorldMemory(),
    tasks: { tick: 0 },
    obtain: async (reqs: any[]) => { calls.push(`obtain ${String(reqs[0].item)}`); if (reqs[0].item === 'diamond_pickaxe' || reqs[0].item === 'bucket') throw new Error('MISSING_ITEMS: none') },
    task: async (name: string) => {
      calls.push(name)
      if (name === 'build a nether portal') throw new SkillError('CANNOT_PLACE', 'no site to cast a portal frame by the lava')
      if (name === 'obsidian from the lava') throw new SkillError('MISSING_ITEMS', 'no diamond pickaxe to mine obsidian with')
      if (name === 'cast a portal') throw new Error('stop here')
    }
  }
  try {
    // (the cast's failure is the pool's; the end, the obsidian's frame, fails on the stub too)
    await buildAPortal(bot, executor, new AbortController().signal, () => {}).catch(() => {})
  } finally {
    gridModule.moveNear = realMove
  }
  const from = calls.indexOf('obsidian from the lava')
  assert.deepEqual(calls.slice(from + 1, from + 3), ['off the lava', 'cast a portal'], calls.join(', '))
  assert.ok(!calls.slice(0, calls.indexOf('cast a portal')).includes('up to the surface'), calls.join(', '))
})

test('a deep pool cast with no empty bucket gets one first, then goes to the spot by the pool', async () => {
  const { SkillError } = await import('../../src/skills/errors')
  const gridModule = require('../../src/skills/gridWalk')
  const tunnelModule = require('../../src/skills/tunnel')
  const { buildAPortal } = await import('../../src/milestones')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const { Vec3 } = await import('vec3')
  const bot = fakeBot({ position: new Vec3(0.5, -50, 0.5), items: [item('water_bucket', 1), item('cobblestone', 64)] })
  bot.game.dimension = 'overworld'
  const lava = bot.registry.blocksByName.lava.id
  // a pool of 12 lava sources under the bot's feet level beside it
  bot.findBlocks = (opts: any) => opts.matching === lava ? Array.from({ length: 12 }, (_, i) => new Vec3(2 + (i % 4), -55, Math.floor(i / 4))) : []
  const realAt = bot.blockAt.bind(bot)
  bot.blockAt = ((p: any) => (p.y === -55 && p.x >= 2 && p.x < 6 && p.z >= 0 && p.z < 3) ? { ...realAt(p), name: 'lava', getProperties: () => ({ level: 0 }) } : realAt(p)) as any
  const calls: string[] = []
  const realMove = gridModule.moveNear
  gridModule.moveNear = async () => {}
  const executor: any = {
    memory: new WorldMemory(),
    tasks: { tick: 0 },
    obtain: async (reqs: any[]) => { calls.push(`obtain ${String(reqs[0].item)}`); if (reqs[0].item === 'diamond_pickaxe' || reqs[0].item === 'bucket') throw new Error('MISSING_ITEMS: none') },
    task: async (name: string) => {
      calls.push(name)
      if (name === 'build a nether portal') throw new SkillError('CANNOT_PLACE', 'no site to cast a portal frame by the lava')
      if (name === 'obsidian from the lava') throw new SkillError('MISSING_ITEMS', 'no diamond pickaxe to mine obsidian with')
      if (name === 'cast a portal') throw new Error('stop here')
    }
  }
  try {
    // (the cast's failure is the pool's; the end, the obsidian's frame, fails on the stub too)
    await buildAPortal(bot, executor, new AbortController().signal, () => {}).catch(() => {})
  } finally {
    gridModule.moveNear = realMove
  }
  const from = calls.indexOf('obsidian from the lava')
  assert.deepEqual(calls.slice(from + 1, from + 4), ['obtain bucket', 'off the lava', 'cast a portal'], calls.join(', '))
})

test('a portal with no flint and steel gets one (its iron mined) before the frame, from obsidian carried too', async () => {
  const { buildAPortal } = await import('../../src/milestones')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const bot = fakeBot({ items: [item('obsidian', 10)] })
  bot.game.dimension = 'overworld'
  const calls: string[] = []
  const executor: any = {
    memory: new WorldMemory(),
    tasks: { tick: 0 },
    obtain: async (reqs: any[]) => { calls.push(`obtain ${String(reqs[0].item)}`) },
    task: async (name: string) => { calls.push(name) }
  }
  await buildAPortal(bot, executor, new AbortController().signal, () => {})
  assert.deepStrictEqual(calls.slice(0, 3), ['obtain flint_and_steel', 'up to the surface', 'build a nether portal'])
})

test('inWarpedForest: the bot within FOREST_EDGE of the seed\'s warped forest counts as in it (out of it by a few blocks the search hunted instead, and walked into the lava sea), the wastes by the portal not', async () => {
  const { inWarpedForest, FOREST_EDGE } = await import('../../src/milestones')
  const { NetherBiomeSource } = await import('../../src/worldgen/netherBiomes')
  const { fakeBot } = await import('../reflexes/fakeBot')
  const { Vec3 } = await import('vec3')
  const biomes = new NetherBiomeSource(2)
  // out from seed 2's south-western warped forest along x to its edge
  let x = -336
  while (biomes.biomeAt(x, 304) === 'warped_forest') x++
  const edge = fakeBot({ position: new Vec3(x + FOREST_EDGE / 2, 64, 304) })
  assert.notEqual(biomes.biomeAt(x + FOREST_EDGE / 2, 304), 'warped_forest')
  assert.equal(inWarpedForest(edge, biomes), true)
  assert.equal(inWarpedForest(fakeBot({ position: new Vec3(2.5, 64, -1.5) }), biomes), false)
})

test('pearls in the nether: an enderman far under the bot is none to hunt for the search as for the hunt (the search took it for one, the hunt found none, 67 rounds in a tick)', async () => {
  const { pearlsInTheNether, PEARL_NETHER_LEGS } = await import('../../src/milestones')
  const { huntable } = await import('../../src/nether/pearls')
  const { fakeBot, entity } = await import('../reflexes/fakeBot')
  const { Vec3 } = await import('vec3')
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5) })
  bot.game.dimension = 'the_nether'
  const deep = entity({ name: 'enderman', position: new Vec3(5.5, 40, 0.5) })
  bot.entities[deep.id] = deep
  assert.equal(huntable(bot, deep), false)
  const tasks: string[] = []
  const executor: any = { memory: new WorldMemory(), tasks: { tick: 0 }, task: async (name: string) => { tasks.push(name); executor.tasks.tick += 100 } }
  await pearlsInTheNether(bot, executor, 4, new AbortController().signal, () => {})
  assert.equal(tasks.filter(t => t === 'endermen for pearls').length, 0)
  assert.deepEqual(tasks, Array(PEARL_NETHER_LEGS).fill('a leg for pearls'))
})

test('a portal with a diamond pickaxe and the seed known goes to the nearest ruined portal for its obsidian before any lava', async () => {
  const { buildAPortal, RUINED_PORTAL_TRIED } = await import('../../src/milestones')
  const { ruinedPortalCandidates } = await import('../../src/worldgen/placement')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const { Vec3 } = await import('vec3')
  const bot = fakeBot({ position: new Vec3(0.5, 70, 0.5), items: [item('water_bucket', 1), item('diamond_pickaxe', 1), item('flint_and_steel', 1)] })
  bot.game.dimension = 'overworld'
  bot.survival = { ...(bot.survival ?? {}), playOptions: { seed: '2' } }
  bot.findBlocks = () => []
  const calls: string[] = []
  const executor: any = {
    memory: new WorldMemory(),
    tasks: { tick: 0 },
    obtain: async () => { throw new Error('stop here') },
    task: async (name: string) => { calls.push(name) }
  }
  await buildAPortal(bot, executor, new AbortController().signal, () => {}).catch(() => {})
  const nearest = ruinedPortalCandidates('2', { x: 0.5, z: 0.5 })[0]
  assert.ok(calls.includes('to a ruined portal'), calls.join(', '))
  assert.ok(!calls.slice(0, calls.indexOf('to a ruined portal')).includes('to the lava'), calls.join(', '))
  // noted, and not gone to again
  assert.ok(executor.memory.getPois(RUINED_PORTAL_TRIED).some((p: any) => p.x === nearest.x && p.z === nearest.z))
  calls.length = 0
  await buildAPortal(bot, executor, new AbortController().signal, () => {}).catch(() => {})
  // the next time, the next candidate (the first is noted as gone to)
  const second = ruinedPortalCandidates('2', { x: 0.5, z: 0.5 })[1]
  assert.equal(calls.filter(c => c === 'to a ruined portal').length, 1, calls.join(', '))
  assert.ok(executor.memory.getPois(RUINED_PORTAL_TRIED).some((p: any) => p.x === second.x && p.z === second.z))
})

test('naturalObsidian passes over obsidian in water (an ocean ruined portal) or by lava', async () => {
  const { naturalObsidian } = await import('../../src/milestones')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const { Vec3 } = await import('vec3')
  // obsidian at x 3, 5 and 7 on the ground; water over the one at 5, lava beside the one at 7
  const world = (p: any): string => p.y === 63 && [3, 5, 7].includes(p.x) && p.z === 0 ? 'obsidian' : (p.x === 5 && p.y === 64 && p.z === 0) ? 'water' : (p.x === 8 && p.y === 63 && p.z === 0) ? 'lava' : p.y < 64 ? 'stone' : 'air'
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [item('diamond_pickaxe', 1)], world })
  bot.game.dimension = 'overworld'
  bot.findBlocks = () => [new Vec3(3, 63, 0), new Vec3(5, 63, 0), new Vec3(7, 63, 0)]
  const logs: string[] = []
  const executor: any = { memory: new WorldMemory(), tasks: { tick: 0 }, task: async () => {} }
  await naturalObsidian(bot, executor, 10, new AbortController().signal, (l: string) => logs.push(l))
  assert.ok(logs.some(l => /^obsidian: 1 in sight/.test(l)), logs.join('\n'))
})

test('naturalObsidian: a ruined portal that was in the sea is left for the shore, then where the trip began', async () => {
  const { naturalObsidian } = await import('../../src/milestones')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const { Vec3 } = await import('vec3')
  const bot = fakeBot({ position: new Vec3(0.5, 56, 0.5), items: [item('diamond_pickaxe', 1)], world: (p: any) => p.y < 50 ? 'stone' : p.y < 63 ? 'water' : 'air' })
  bot.game.dimension = 'overworld'
  bot.survival = { ...(bot.survival ?? {}), playOptions: { seed: '2' } }
  bot.findBlocks = () => []
  const calls: string[] = []
  const executor: any = { memory: new WorldMemory(), tasks: { tick: 0 }, task: async (name: string) => { calls.push(name) } }
  await naturalObsidian(bot, executor, 10, new AbortController().signal, () => {})
  assert.deepEqual(calls, ['to a ruined portal', 'to the shore', 'back from the sea'])
})

test('the last way to a frame\'s obsidian (the planner\'s mine of any) is held to OBSIDIAN_OBTAIN_TICKS', async () => {
  const { buildAPortal, OBSIDIAN_OBTAIN_TICKS } = await import('../../src/milestones')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const { Vec3 } = await import('vec3')
  const bot = fakeBot({ position: new Vec3(0.5, -55, 0.5), items: [item('water_bucket', 1), item('diamond_pickaxe', 1), item('flint_and_steel', 1)] })
  bot.game.dimension = 'overworld'
  bot.findBlocks = () => []
  let budgeted = false
  const executor: any = {
    memory: new WorldMemory(),
    tasks: { tick: 0 },
    task: async () => {},
    obtain: async (reqs: any[], signal: AbortSignal) => {
      if (reqs[0].item !== 'obsidian') return
      // an explore that never ends but for its signal
      for (let i = 0; i <= OBSIDIAN_OBTAIN_TICKS; i++) bot.emit('physicsTick')
      budgeted = signal.aborted
      throw signal.reason ?? new Error('not stopped')
    }
  }
  await assert.rejects(buildAPortal(bot, executor, new AbortController().signal, () => {}))
  assert.equal(budgeted, true)
})

test('a cast away takes the pool\'s lava round the pool, wherever the bot has got to', async () => {
  const { SkillError } = await import('../../src/skills/errors')
  const skillsModule = require('../../src/nether/portalSkills')
  const gridModule = require('../../src/skills/gridWalk')
  const { buildAPortal } = await import('../../src/milestones')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const { Vec3 } = await import('vec3')
  const bot = fakeBot({ position: new Vec3(0.5, -50, 0.5), items: [item('water_bucket', 1), item('bucket', 1), item('cobblestone', 64), item('flint_and_steel', 1)] })
  bot.game.dimension = 'overworld'
  const lava = bot.registry.blocksByName.lava.id
  bot.findBlocks = (opts: any) => opts.matching === lava ? Array.from({ length: 12 }, (_, i) => new Vec3(2 + (i % 4), -55, Math.floor(i / 4))) : []
  const realAt = bot.blockAt.bind(bot)
  bot.blockAt = ((p: any) => (p.y === -55 && p.x >= 2 && p.x < 6 && p.z >= 0 && p.z < 3) ? { ...realAt(p), name: 'lava', getProperties: () => ({ level: 0 }) } : realAt(p)) as any
  let given: number | null = null
  const realCast = skillsModule.castPortalAway
  const realMove = gridModule.moveNear
  gridModule.moveNear = async () => {}
  skillsModule.castPortalAway = async (_b: unknown, l: any[]) => { given = l.length; throw new Error('stop here') }
  const executor: any = {
    memory: new WorldMemory(),
    tasks: { tick: 0 },
    obtain: async () => { throw new Error('MISSING_ITEMS: none') },
    task: async (name: string, fn: any) => {
      if (name === 'build a nether portal') throw new SkillError('CANNOT_PLACE', 'no site to cast a portal frame by the lava')
      // the obsidian tries walked the bot 40 blocks off the pool
      if (name === 'obsidian from the lava') { bot.entity.position = new Vec3(40.5, -50, 40.5); throw new SkillError('MISSING_ITEMS', 'no diamond pickaxe to mine obsidian with') }
      if (name === 'cast a portal') return await fn(new AbortController().signal)
    }
  }
  try {
    await buildAPortal(bot, executor, new AbortController().signal, () => {}).catch(() => {})
  } finally {
    skillsModule.castPortalAway = realCast
    gridModule.moveNear = realMove
  }
  assert.equal(given, 12)
})

test('brewKit: before the nether, 3 glass bottles, a crafting table and 3 cobblestone got and the bottles filled with water; with 3 water bottles, nothing; a failure no reason not to go in', async () => {
  const { brewKit } = await import('../../src/milestones')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const water = (): any => { const p = item('potion'); p.componentMap = new Map([['potion_contents', { type: 'potion_contents', data: { potionId: 0, customEffects: [] } }]]); return p }
  const bot = fakeBot({ items: [item('cobblestone', 20)] })
  const calls: string[] = []
  const executor: any = {
    memory: new WorldMemory(),
    tasks: { tick: 0 },
    obtain: async (reqs: any[]) => { calls.push(`obtain ${reqs.map(r => `${r.count} ${r.item}`).join(', ')}`); giveTo(bot, [item('glass_bottle', 3), item('crafting_table', 1), item('cobblestone', 12)]) },
    task: async (name: string) => { calls.push(name); giveTo(bot, [water(), water(), water()]) }
  }
  const lines: string[] = []
  await brewKit(bot, executor, new AbortController().signal, l => lines.push(l))
  assert.deepStrictEqual(calls, ['obtain 3 glass_bottle, 1 crafting_table, 32 cobblestone', 'fill the water bottles'])
  assert.match(lines.join(' | '), /3 water bottles for fire resistance/)
  calls.length = 0
  await brewKit(bot, executor, new AbortController().signal, () => {})
  assert.deepStrictEqual(calls, [])
  const dry = fakeBot({ items: [] })
  executor.obtain = async () => { throw new Error('no sand found') }
  await brewKit(dry, executor, new AbortController().signal, l => lines.push(l))
  assert.match(lines.join(' | '), /no water bottles: no sand found/)
})

test('the blaze rods with no bow and no fire resistance to be had (blazeRodsWithBrew: noFireResistance): back to the overworld, the milestone not ready, no fight (full-1.21.11-fresh-e: the sword alone at a throne, burned)', async () => {
  const { netherHandler } = await import('../../src/milestones')
  const fortressSkills = require('../../src/nether/fortressSkills')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const bot = fakeBot({ items: [item('ender_eye', 0), item('diamond_sword', 1)] })
  bot.game.dimension = 'the_nether'
  bot.findBlocks = () => []
  ;(bot as any).pathfinder = { defaultMoveSettings: {}, setMoveOptions: () => {} }
  const memory = new WorldMemory()
  ;(bot as any).survival = { memory }
  memory.addPoi('blaze_spawner', { x: 870, y: 76, z: 143 }, 'the_nether')
  const real = fortressSkills.collectBlazeRods
  const tasks: string[] = []
  const lines: string[] = []
  fortressSkills.collectBlazeRods = async () => { tasks.push('fight'); return { rods: 0, kills: 0, ticks: 0 } }
  const executor: any = { memory, tasks: { tick: 0 }, obtain: async () => {}, task: async (name: string, fn: (s: AbortSignal) => Promise<unknown>) => { tasks.push(name); if (name === 'back to the overworld') return; return await fn(new AbortController().signal) } }
  let err: any = null
  try {
    err = await netherHandler({ bot, executor, signal: new AbortController().signal, log: (l: string) => lines.push(l), milestone: null as any, state: null as any }).then(() => null, e => e)
  } finally {
    fortressSkills.collectBlazeRods = real
  }
  assert.equal(err?.notReady, true, String(err))
  assert.deepEqual(tasks, ['blaze rods', 'back to the overworld'])
  assert.ok(lines.some(l => /fire resistance: no bow and none of it: no fight/.test(l)), lines.join(' | '))
})

test('netherKit: no bow to be had, the water bottles held: ready with no slime ball nor magma cream (the cubes of the nether give the cream; asking for a ball kept full-1.21.11-fresh-g out for good), not ready without the bottles', async () => {
  const { netherKit } = await import('../../src/milestones')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const water = (): any => { const p = item('potion'); p.componentMap = new Map([['potion_contents', { type: 'potion_contents', data: { potionId: 0, customEffects: [] } }]]); return p }
  const bare = NETHER_GEAR().filter((i: any) => i.name !== 'bow' && i.name !== 'arrow')
  const memory = new WorldMemory()
  const executor: any = { memory, tasks: { tick: 0 }, sightings: { misses: (n: string) => n === 'spider' ? 1 : 0, missing: () => {} }, obtain: async () => {}, task: async () => {} }
  const bot = fakeBot({ items: [...bare, water(), water(), water()] })
  bot.game.dimension = 'overworld'
  assert.equal(await netherKit(bot, executor, new AbortController().signal, () => {}).then(() => null, e => e), null)
  const dry = fakeBot({ items: bare })
  dry.game.dimension = 'overworld'
  const err: any = await netherKit(dry, executor, new AbortController().signal, () => {}).then(() => null, e => e)
  assert.equal(err?.notReady, true)
  assert.match(err?.message ?? '', /water bottles/)
})

test('brewKit: its tries spent, it tries no more unless the gate requires the bottles (no bow to be had)', async () => {
  const { brewKit, BREW_KIT_TRIES } = await import('../../src/milestones')
  const { fakeBot } = await import('../reflexes/fakeBot')
  const bot = fakeBot({ items: [] })
  bot.game.dimension = 'overworld'
  let obtains = 0
  const executor: any = { memory: new WorldMemory(), tasks: { tick: 0 }, obtain: async () => { obtains++ }, task: async () => {} }
  for (let i = 0; i < BREW_KIT_TRIES + 2; i++) await brewKit(bot, executor, new AbortController().signal, () => {})
  assert.equal(obtains, BREW_KIT_TRIES)
  await brewKit(bot, executor, new AbortController().signal, () => {}, true)
  assert.equal(obtains, BREW_KIT_TRIES + 1)
})
