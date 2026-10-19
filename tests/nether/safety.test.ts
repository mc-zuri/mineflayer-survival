import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { FORBID, fireballIncoming, lavaAgainst, lavaBeside, netherMoveSettings, overLava, wearingGold } from '../../src/nether/safety'
import { entity, fakeBot, item } from '../reflexes/fakeBot'

test('nether safety: lava beside the body, against a block to break, under a block to place', () => {
  const lava = new Set(['2,64,0', '0,60,5'])
  const isLava = (p: Vec3): boolean => lava.has(`${p.x},${p.y},${p.z}`)
  const isAir = (p: Vec3): boolean => !isLava(p) && p.y > 60
  assert.equal(lavaBeside(isLava, new Vec3(1, 64, 0), 1), true)
  assert.equal(lavaBeside(isLava, new Vec3(1, 63, 0), 1), true) // its head's level
  assert.equal(lavaBeside(isLava, new Vec3(0, 64, 0), 1), false)
  assert.equal(lavaBeside(isLava, new Vec3(0, 64, 0), 2), true)
  assert.equal(lavaAgainst(isLava, new Vec3(2, 63, 0)), true) // lava above
  assert.equal(lavaAgainst(isLava, new Vec3(3, 64, 0)), true) // beside
  assert.equal(lavaAgainst(isLava, new Vec3(2, 65, 0)), false) // below doesn't flow up
  assert.equal(overLava(isLava, isAir, new Vec3(0, 63, 5)), true)
  assert.equal(overLava(isLava, isAir, new Vec3(0, 66, 5)), false) // more than 4 down
})

test('netherMoveSettings: the exclusion areas forbid lava edges and piglin gold with a piglin near', () => {
  const bot = fakeBot({ entities: [entity({ name: 'piglin', position: new Vec3(5, 64, 0) })] })
  const reg = bot.registry
  const lavaAt = new Set(['4,64,0'])
  bot.world = {
    getBlockStateId: (p: Vec3) => lavaAt.has(`${p.x},${p.y},${p.z}`) ? reg.blocksByName.lava.defaultState : (p.y < 64 ? reg.blocksByName.netherrack.defaultState : reg.blocksByName.air.defaultState)
  }
  const s = netherMoveSettings(bot)
  const step = s.exclusionAreasStep?.[0] as any
  const brk = s.exclusionAreasBreak?.[0] as any
  const place = s.exclusionAreasPlace?.[0] as any
  assert.equal(step({ position: new Vec3(3, 64, 0), type: 0 }), FORBID)
  assert.equal(step({ position: new Vec3(0, 64, 0), type: 0 }), 0)
  assert.ok(step({ position: new Vec3(2, 64, 0), type: 0 }) > 0) // two off: a penalty
  assert.equal(brk({ position: new Vec3(0, 63, 0), type: reg.blocksByName.gold_block.id }), FORBID)
  assert.equal(brk({ position: new Vec3(0, 63, 0), type: reg.blocksByName.netherrack.id }), 0)
  assert.equal(brk({ position: new Vec3(4, 63, 0), type: reg.blocksByName.netherrack.id }), FORBID) // lava on top
  assert.equal(place({ position: new Vec3(4, 65, 0), type: 0 }), FORBID)
  assert.equal(place({ position: new Vec3(0, 64, 0), type: 0 }), 0)
})

test('fireballIncoming: a fireball heading for the bot, not one flying past or away', () => {
  const bot = fakeBot({ position: new Vec3(0, 64, 0) })
  const at = (pos: Vec3, v: Vec3): any => ({ ...entity({ name: 'fireball', position: pos }), velocity: v })
  assert.equal(fireballIncoming(bot, at(new Vec3(10, 65, 0), new Vec3(-0.5, 0, 0))), true)
  assert.equal(fireballIncoming(bot, at(new Vec3(10, 65, 0), new Vec3(0.5, 0, 0))), false)
  assert.equal(fireballIncoming(bot, at(new Vec3(10, 65, 6), new Vec3(-0.5, 0, 0))), false)
  assert.equal(fireballIncoming(bot, at(new Vec3(30, 65, 0), new Vec3(-0.5, 0, 0))), false) // out of range
})

test('wearingGold: a golden piece in an armor slot', () => {
  assert.equal(wearingGold(fakeBot({ armor: { feet: item('golden_boots') } })), true)
  assert.equal(wearingGold(fakeBot({ armor: { feet: item('iron_boots') }, items: [item('golden_helmet')] })), false)
})

test('PIGLIN_GUARDED is #guarded_by_piglins: the copper chests of every age, waxed or not, too', async () => {
  const { PIGLIN_GUARDED } = await import('../../src/nether/safety')
  for (const name of ['copper_chest', 'oxidized_copper_chest', 'waxed_weathered_copper_chest', 'chest', 'gold_block', 'red_shulker_box']) assert.ok(PIGLIN_GUARDED.has(name), name)
  assert.equal([...PIGLIN_GUARDED].filter(n => n.endsWith('copper_chest')).length, 8)
})

test('bridgeOverLava: a bridge with its rails takes 3 blocks a step, one without (over the void) 1', async () => {
  const { bridgeOverLava } = await import('../../src/nether/safety')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const { Vec3 } = await import('vec3')
  const mk = () => {
    const bot = fakeBot({ position: new Vec3(0.5, 49, 0.5), items: [item('cobblestone', 2)], world: (p: any) => p.y === 48 && p.x === 0 && p.z === 0 ? 'obsidian' : 'air' })
    bot.lookAt = async () => {}
    return bot
  }
  await assert.rejects(bridgeOverLava(mk(), { direction: new Vec3(-1, 0, 0), length: 1 }), /out of cobblestone/)
  // without rails the 2 blocks do for the floor: it gets as far as placing it (the fake places nothing)
  await assert.rejects(bridgeOverLava(mk(), { direction: new Vec3(-1, 0, 0), length: 1, rails: false }), (err: any) => !/out of cobblestone/.test(err.message))
})

test('netherMoveSettings: magma underfoot is no place to stand, and a ledge over a deadly fall costs 6 a side (edgeHazardCost)', () => {
  const bot = fakeBot()
  const reg = bot.registry
  bot.world = {
    getBlockStateId: (p: Vec3) => (p.x === 3 && p.y === 63 ? reg.blocksByName.magma_block.defaultState : (p.y < 64 ? reg.blocksByName.netherrack.defaultState : reg.blocksByName.air.defaultState))
  }
  const s = netherMoveSettings(bot)
  const step = s.exclusionAreasStep?.[0] as any
  assert.equal(step({ position: new Vec3(3, 64, 0), type: 0 }), FORBID)
  assert.equal(step({ position: new Vec3(0, 64, 0), type: 0 }), 0)
  assert.equal(s.edgeHazardCost, 6)
  assert.equal(netherMoveSettings(bot, { edgeCost: 10 }).edgeHazardCost, 10)
})

test('netherMoveSettings: a cell up in the rock under the nether roof (over y 100) costs 12 more, one at 100 or under none', async () => {
  const { NETHER_HIGH_Y } = await import('../../src/nether/safety')
  const bot = fakeBot()
  const reg = bot.registry
  bot.world = { getBlockStateId: (p: Vec3) => (p.y % 2 === 0 ? reg.blocksByName.air.defaultState : reg.blocksByName.netherrack.defaultState) }
  const step = netherMoveSettings(bot).exclusionAreasStep?.[0] as any
  assert.equal(step({ position: new Vec3(0, NETHER_HIGH_Y, 0), type: 0 }), 0)
  assert.equal(step({ position: new Vec3(0, NETHER_HIGH_Y + 2, 0), type: 0 }), 12)
  assert.equal((netherMoveSettings(bot, { highCost: 0 }).exclusionAreasStep?.[0] as any)({ position: new Vec3(0, NETHER_HIGH_Y + 2, 0), type: 0 }), 0)
})

test('withNetherSafety lays the nether settings over once (nested, as it is), and the executor\'s tasks in the nether have them', async () => {
  const { withNetherSafety, hasNetherSafety } = await import('../../src/nether/safety')
  const { Executor } = await import('../../src/executor/executor')
  const { WorldMemory } = await import('../../src/core/memory')
  const { TaskRunner } = await import('../../src/core/taskRunner')
  const bot = fakeBot()
  const reg = bot.registry
  bot.world = { getBlockStateId: (p: Vec3) => (p.y < 64 ? reg.blocksByName.netherrack.defaultState : reg.blocksByName.air.defaultState) }
  bot.pathfinder = { defaultMoveSettings: { exclusionAreasStep: [], exclusionAreasBreak: [], exclusionAreasPlace: [], edgeHazardCost: 4 }, setMoveOptions (s: any) { this.defaultMoveSettings = s } }
  const steps = (): number => bot.pathfinder.defaultMoveSettings.exclusionAreasStep.length
  assert.equal(hasNetherSafety(bot), false)
  await withNetherSafety(bot, async () => {
    assert.equal(hasNetherSafety(bot), true)
    assert.equal(steps(), 1)
    assert.equal(bot.pathfinder.defaultMoveSettings.edgeHazardCost, 6)
    await withNetherSafety(bot, async () => { assert.equal(steps(), 1) })
  })
  assert.equal(hasNetherSafety(bot), false)
  assert.equal(bot.pathfinder.defaultMoveSettings.edgeHazardCost, 4)
  // the executor's tasks: in the nether with them, in the overworld without
  bot.survival = { memory: new WorldMemory(), tasks: new TaskRunner(bot) }
  const ex = new Executor(bot, { log: () => {} })
  const ticker = setInterval(() => bot.emit('physicsTick'), 1)
  try {
    bot.game.dimension = 'the_nether'
    assert.equal(await ex.task('in the nether', async () => hasNetherSafety(bot)), true)
    bot.game.dimension = 'overworld'
    assert.equal(await ex.task('in the overworld', async () => hasNetherSafety(bot)), false)
  } finally {
    clearInterval(ticker)
    bot.survival.tasks.destroy?.()
  }
})

test('netherMoveSettings lavaBelow: no step onto a floor with lava under it (a lake\'s obsidian lid), only when asked', () => {
  const bot = fakeBot()
  const reg = bot.registry
  // a lid of obsidian at y 63 over lava at y 62 for x 0 - 3; netherrack elsewhere under y 64
  bot.world = {
    getBlockStateId: (p: Vec3) => p.y >= 64 ? reg.blocksByName.air.defaultState
      : (p.x >= 0 && p.x <= 3 && p.y === 63) ? reg.blocksByName.obsidian.defaultState
        : (p.x >= 0 && p.x <= 3 && p.y >= 60) ? reg.blocksByName.lava.defaultState : reg.blocksByName.netherrack.defaultState
  }
  const plain = netherMoveSettings(bot).exclusionAreasStep?.[0] as any
  const lid = netherMoveSettings(bot, { lavaBelow: 3 }).exclusionAreasStep?.[0] as any
  assert.equal(plain({ position: new Vec3(1, 64, 0), type: 0 }), 0)
  assert.equal(lid({ position: new Vec3(1, 64, 0), type: 0 }), FORBID)
  assert.equal(lid({ position: new Vec3(-3, 64, 0), type: 0 }), 0)
})
