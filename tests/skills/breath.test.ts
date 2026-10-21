import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { UNDERWATER_STEP_COST, keepHeadAboveWater, underwaterStepCost } from '../../src/skills/breath'

test('underwaterStepCost: a flooded tunnel (water at the head, rock over it) and a lake\'s bottom cost more, short of a wall; swimming at the surface and wading stay', () => {
  // a lake from y 60 to 63 (air over it) at x < 0; a flooded tunnel at y 40..41 under rock at x >= 10
  const lookup = (p: Vec3): { name: string } => {
    if (p.x < 0 && p.y >= 60 && p.y <= 63) return { name: 'water' }
    if (p.x >= 10 && (p.y === 40 || p.y === 41)) return { name: 'water' }
    if (p.y >= 64) return { name: 'air' }
    return { name: 'stone' }
  }
  const cost = underwaterStepCost(lookup)
  assert.equal(cost({ position: new Vec3(-5, 60, 0) }), UNDERWATER_STEP_COST) // the lake's bottom
  assert.equal(cost({ position: new Vec3(-5, 62, 0) }), 0) // swimming at the surface: water at the head, air over it
  assert.equal(cost({ position: new Vec3(-5, 63, 0) }), 0) // wading: the head in air
  assert.equal(cost({ position: new Vec3(12, 40, 0) }), UNDERWATER_STEP_COST) // the flooded tunnel
  assert.equal(cost({ position: new Vec3(5, 64, 0) }), 0)
})

test('keepHeadAboveWater adds the cost to the pathfinder\'s step costs once', () => {
  const pf: any = { defaultMoveSettings: { exclusionAreasStep: [] }, setMoveOptions (s: any) { this.defaultMoveSettings = s } }
  const bot: any = { pathfinder: pf, blockAt: () => null }
  keepHeadAboveWater(bot)
  keepHeadAboveWater(bot)
  assert.equal(pf.defaultMoveSettings.exclusionAreasStep.length, 2)
  assert.equal(pf.defaultMoveSettings.exclusionAreasBreak.length, 1)
})

test('underwaterStepCost is dear but no wall: a bot already in a flooded cave still has a way out', async () => {
  const { UNDERWATER_STEP_COST } = await import('../../src/skills/breath')
  assert.ok(UNDERWATER_STEP_COST > 20 && UNDERWATER_STEP_COST < 1e6)
})

test('a spot the drowning reflex took the bot up from is kept off DROWNED_TICKS: the steps with the head in water near it cost DROWNED_STEP_COST, the dry ones nothing; a death forgets it', async () => {
  const { DROWNED_STEP_COST, DROWNED_TICKS, drownedNear, drownedStepCost, noteDrowning } = await import('../../src/skills/breath')
  const bot: any = new (require('node:events').EventEmitter)()
  bot.survival = { tasks: { tick: 1000 } }
  // a pond at y 55 to 58 by x 10 to 14
  const lookup = (p: Vec3): { name: string } => ({ name: p.x >= 10 && p.x <= 14 && p.y >= 55 && p.y <= 58 ? 'water' : p.y > 58 ? 'air' : 'stone' })
  const cost = drownedStepCost(bot, lookup)
  assert.equal(cost({ position: new Vec3(11, 56, 0) }), 0)
  noteDrowning(bot, new Vec3(11.5, 56.5, 0.5))
  assert.equal(drownedNear(bot, new Vec3(18, 56, 0)), true)
  assert.equal(drownedNear(bot, new Vec3(30, 56, 0)), false)
  assert.equal(cost({ position: new Vec3(13, 56, 0) }), DROWNED_STEP_COST)
  // dry ground by the pond, and swimming with the head over the water: no more
  assert.equal(cost({ position: new Vec3(16, 59, 0) }), 0)
  assert.equal(cost({ position: new Vec3(12, 58, 0) }), 0)
  bot.survival.tasks.tick += DROWNED_TICKS + 1
  assert.equal(cost({ position: new Vec3(13, 56, 0) }), 0)
  // (a death forgets them)
  const { clearDrownings } = await import('../../src/skills/breath')
  noteDrowning(bot, new Vec3(11.5, 56.5, 0.5))
  clearDrownings(bot)
  assert.equal(drownedNear(bot, new Vec3(11, 56, 0)), false)
})

test('a spot drowned at twice within DROWNED_REPEAT_WINDOW, or died at by drowning, is left for good: DROWNED_REPEAT_TICKS, its underwater steps forbidden to a bot out of the water, dear to one in it (f1-26.3, f1-grim)', async () => {
  const { DROWNED_FORBID, DROWNED_REPEAT_TICKS, DROWNED_STEP_COST, DROWNED_TICKS, drownedForGoodNear, drownedNear, drownedStepCost, noteDrowning } = await import('../../src/skills/breath')
  const bot: any = new (require('node:events').EventEmitter)()
  bot.survival = { tasks: { tick: 1000 } }
  bot.entity = { position: new Vec3(20.5, 64, 0.5) }
  const lookup = (p: Vec3): { name: string } => ({ name: p.x >= 10 && p.x <= 14 && p.y >= 55 && p.y <= 58 ? 'water' : p.y > 58 ? 'air' : 'stone' })
  const cost = drownedStepCost(bot, lookup)
  assert.equal(noteDrowning(bot, new Vec3(11.5, 56.5, 0.5)), false)
  assert.equal(cost({ position: new Vec3(12, 56, 0) }), DROWNED_STEP_COST)
  bot.survival.tasks.tick += 400
  assert.equal(noteDrowning(bot, new Vec3(12.5, 56.5, 0.5)), true)
  assert.equal(drownedForGoodNear(bot, new Vec3(12, 56, 0)), true)
  // out of the water: no step under it there at all; in it, the way out
  assert.equal(cost({ position: new Vec3(12, 56, 0) }), DROWNED_FORBID)
  bot.entity.position = new Vec3(11.5, 56, 0.5)
  assert.equal(cost({ position: new Vec3(12, 56, 0) }), DROWNED_STEP_COST)
  // kept off past DROWNED_TICKS, up to DROWNED_REPEAT_TICKS
  bot.survival.tasks.tick += DROWNED_TICKS + 100
  assert.equal(drownedNear(bot, new Vec3(12, 56, 0)), true)
  bot.survival.tasks.tick += DROWNED_REPEAT_TICKS
  assert.equal(drownedNear(bot, new Vec3(12, 56, 0)), false)
  // a death by drowning: for good at once
  assert.equal(noteDrowning(bot, new Vec3(40.5, 56.5, 0.5), true), true)
  assert.equal(drownedForGoodNear(bot, new Vec3(40, 56, 0)), true)
})

test('noSneakInWater: a sneak held with the feet or the head in water let go of each tick, but for a dive meant (allowDive); on land kept (f1-grim, f2-1.21.11)', async () => {
  const { allowDive, noSneakInWater } = await import('../../src/skills/breath')
  const { fakeBot } = await import('../reflexes/fakeBot')
  const bot = fakeBot({ position: new Vec3(0.5, 60, 0.5), world: (p: Vec3) => p.y >= 58 && p.y <= 62 ? 'water' : p.y < 58 ? 'stone' : 'air' })
  noSneakInWater(bot)
  bot.setControlState('sneak', true)
  bot.setControlState('forward', true)
  bot.emit('physicsTickBegin')
  assert.equal(bot.getControlState('sneak'), false)
  assert.equal(bot.getControlState('forward'), true)
  const release = allowDive(bot)
  bot.setControlState('sneak', true)
  bot.emit('physicsTick')
  assert.equal(bot.getControlState('sneak'), true)
  release()
  bot.emit('physicsTick')
  assert.equal(bot.getControlState('sneak'), false)
  // on land: the edge's sneak kept
  bot.entity.position = new Vec3(0.5, 64, 0.5)
  bot.setControlState('sneak', true)
  bot.emit('physicsTick')
  assert.equal(bot.getControlState('sneak'), true)
})

test('waterUnderBreakCost: no block broken with water under it (a flooded cave\'s ceiling) by a bot out of the water; one in it digs its way out (f3-26.3)', async () => {
  const { WATER_UNDER_FORBID, waterUnderBreakCost } = await import('../../src/skills/breath')
  // a flooded cave at y 45 to 48 under a stone ceiling at 49; the bot on top at 50
  const lookup = (p: Vec3): { name: string } => ({ name: p.y >= 45 && p.y <= 48 ? 'water' : p.y <= 49 ? 'stone' : 'air' })
  const bot: any = { entity: { position: new Vec3(0.5, 50, 0.5) } }
  const cost = waterUnderBreakCost(bot, lookup)
  assert.equal(cost({ position: { x: 0, y: 49, z: 0 } }), WATER_UNDER_FORBID)
  assert.equal(cost({ position: { x: 0, y: 44, z: 0 } }), 0)
  bot.entity.position = new Vec3(0.5, 46, 0.5)
  assert.equal(cost({ position: { x: 0, y: 49, z: 0 } }), 0)
})

test('a death by drowning is kept in the memory (DROWNED_POI) DROWNED_DEATH_TICKS long, DROWNED_DEATH_RADIUS round: the flooded cave 12 off the first death kept off 29000 ticks on (f3-26.3)', async () => {
  const { DROWNED_DEATH_TICKS, drownedForGoodNear, noteDrowning, clearDrownings } = await import('../../src/skills/breath')
  const { WorldMemory } = await import('../../src/core/memory')
  const memory = new WorldMemory()
  const bot: any = new (require('node:events').EventEmitter)()
  bot.game = { dimension: 'overworld' }
  bot.survival = { tasks: { tick: 70031 }, memory }
  memory.now = 70031
  noteDrowning(bot, new Vec3(-15, 47, 119), true)
  // 29000 ticks on, a game resumed (the in-memory marks gone), 12 off
  clearDrownings(bot)
  bot.survival.tasks.tick += 29000
  memory.now += 29000
  assert.equal(drownedForGoodNear(bot, new Vec3(-27, 47, 108)), true)
  memory.now += DROWNED_DEATH_TICKS
  assert.equal(drownedForGoodNear(bot, new Vec3(-27, 47, 108)), false)
})
