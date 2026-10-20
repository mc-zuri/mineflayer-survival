// The nether milestone's fortress search without the seed: the axis walks taken in turn, one noted in memory per search.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { WorldMemory } from '../../src/core/memory'
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
  assert.deepStrictEqual(calls.slice(from).filter(c => !/iron_sword|stone_sword|shield/.test(c)).slice(0, 4), ['obtain 10 obsidian', 'up to the surface', 'build a nether portal', 'into the nether'])
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
  const bot = fakeBot({ position: new Vec3(0.5, -50, 0.5), items: [item('water_bucket', 1), item('diamond_pickaxe', 1)] })
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
  const bot = fakeBot({ position: new Vec3(0.5, -55, 0.5) })
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

test('pearls in the nether: a warped forest in sight is gone to, and waited in for its endermen', async () => {
  const { pearlsInTheNether, pearlGround } = await import('../../src/milestones')
  const { fakeBot } = await import('../reflexes/fakeBot')
  const { Vec3 } = await import('vec3')
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5) })
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
  assert.equal(tasks[1], 'wait for endermen')
  forestAt = new Vec3(0, 0, 0)
})

test('a portal with no diamond pickaxe (a death lost it) gets one before the lakes', async () => {
  const { buildAPortal } = await import('../../src/milestones')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const { Vec3 } = await import('vec3')
  const calls: string[] = []
  const bot = fakeBot({ position: new Vec3(0.5, -55, 0.5), items: [item('water_bucket', 1)] })
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
  return [item('diamond_sword', 1), item('iron_chestplate', 1), item('golden_boots', 1), item('cooked_beef', 8)]
}

test('netherKit: the bot does not go in without a sword, armor, gold and food: got, else the milestone fails', async () => {
  const { netherKit, netherGearNeeds } = await import('../../src/milestones')
  const { ownedInventory } = await import('../../src/executor/executor')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const bare = fakeBot({ items: [item('dirt', 3)] })
  assert.deepStrictEqual(netherGearNeeds(ownedInventory(bare)).map(r => r.unit === 'nutrition' ? 'food' : r.item), ['stone_sword', 'iron_chestplate', 'golden_boots', 'food'])
  assert.deepStrictEqual(netherGearNeeds(ownedInventory(fakeBot({ items: NETHER_GEAR() }))), [])
  // 4 ingots do for the boots (made by the kit)
  assert.deepStrictEqual(netherGearNeeds(ownedInventory(fakeBot({ items: [item('iron_sword', 1), item('iron_chestplate', 1), item('gold_ingot', 4), item('bread', 6)] }))), [])
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
  const bot = fakeBot({ items: [item('stone_pickaxe', 1), item('gold_ingot', 8), item('cooked_beef', 8)] })
  const calls: string[] = []
  const executor: any = {
    memory: new WorldMemory(),
    tasks: { tick: 0 },
    obtain: async (reqs: any[]) => {
      calls.push(`obtain ${reqs.map(r => r.item).join(',')}`)
      if (reqs.some(r => r.item === 'iron_chestplate')) giveTo(bot, [item('iron_chestplate', 1)])
      if (reqs.some(r => r.item === 'stone_sword')) giveTo(bot, [item('stone_sword', 1)])
      if (reqs.some(r => r.item === 'golden_boots')) giveTo(bot, [item('golden_boots', 1)])
    },
    task: async (name: string) => { calls.push(name) }
  }
  await netherKit(bot, executor, new AbortController().signal, () => {})
  assert.deepStrictEqual(calls, ['obtain iron_sword,iron_chestplate,shield', 'obtain stone_sword', 'obtain golden_boots'])
  calls.length = 0
  const armed = fakeBot({ items: [item('diamond_sword', 1), item('diamond_chestplate', 1), item('shield', 1), item('golden_boots', 1), item('bread', 8)] })
  await netherKit(armed, executor, new AbortController().signal, () => {})
  assert.deepStrictEqual(calls, [])
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
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5) })
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
  const bot = fakeBot({ items: [item('ender_eye', 0)] })
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

test('pearls in the nether with the seed: legs to its nearest warped forest, waits in it for the endermen, another spot in one when none came', async () => {
  const { pearlsInTheNether, FOREST_IDLE, FOREST_WAIT } = await import('../../src/milestones')
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
      if (name === 'wait for endermen') executor.tasks.tick += FOREST_WAIT
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
  // in it: waits till FOREST_IDLE has gone with no enderman, then another spot of a warped forest
  assert.deepEqual(tasks.slice(1, 1 + FOREST_IDLE / FOREST_WAIT), Array(FOREST_IDLE / FOREST_WAIT).fill('wait for endermen'))
  assert.equal(tasks[1 + FOREST_IDLE / FOREST_WAIT], 'a leg for pearls')
  const points = legs.map(l => /on to \((-?\d+), -?\d+, (-?\d+)\)/.exec(l) as RegExpExecArray).map(m => ({ x: Number(m[1]), z: Number(m[2]) }))
  assert.ok(points.length >= 2)
  assert.equal(new Set(points.map(p => `${p.x},${p.z}`)).size, points.length, 'no spot twice')
  for (const p of points) assert.equal(biomes.biomeAt(p.x, p.z), 'warped_forest')
})

test('pearls by night: an enderman there\'s no way to is passed over for the night\'s legs, not hunted round after round', async () => {
  const { pearlsByNight } = await import('../../src/milestones')
  const { fakeBot, entity } = await import('../reflexes/fakeBot')
  const { Vec3 } = await import('vec3')
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5) })
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
    task: async (name: string, fn: (s: AbortSignal) => Promise<unknown>) => { tasks.push(name); executor.tasks.tick += 500; if (name === 'endermen for pearls') return await fn(new AbortController().signal) }
  }
  await pearlsByNight(bot, executor, 2, new AbortController().signal, () => {})
  assert.equal(tasks[0], 'endermen for pearls')
  assert.equal(tasks.filter(t => t === 'endermen for pearls').length, 1)
  assert.equal(tasks[1], 'a night leg for endermen')
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
