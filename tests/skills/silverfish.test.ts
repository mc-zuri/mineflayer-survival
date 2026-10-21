import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { NEST_KEEP_OFF, fleeNest, nestAbout } from '../../src/skills/silverfish'
import { entity, fakeBot } from '../reflexes/fakeBot'

// Silverfish are fled: the bot goes more than 8 blocks off their nest, its infested blocks and its silverfish
// (f5-26.3: walled in among a nest, slain by 9 silverfish).

test('the nest about the bot is its infested blocks and its silverfish within NEST_KEEP_OFF (more than 8); none past it', () => {
  const fish = entity({ name: 'silverfish', position: new Vec3(3.5, 64, 0.5), meta: { health: 8 } })
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), entities: [fish] })
  bot.findBlocks = () => [new Vec3(4, 63, 0), new Vec3(4, 63, 1)]
  const nest = nestAbout(bot)
  assert.ok(nest != null)
  assert.ok(nest.center.x > 3 && nest.center.x < 5, nest.center.toString())
  assert.ok(NEST_KEEP_OFF > 8)
  bot.findBlocks = () => []
  fish.position = new Vec3(20.5, 64, 0.5)
  assert.strictEqual(nestAbout(bot), null)
})

test('fleeNest walks the bot off the nest with the pathfinder: a goal out of a sphere round its middle more than 8 wide', async () => {
  const fish = entity({ name: 'silverfish', position: new Vec3(3.5, 64, 0.5), meta: { health: 8 } })
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), entities: [fish] })
  let infested = [new Vec3(4, 63, 0)]
  bot.findBlocks = () => infested
  const goals: any[] = []
  bot.pathfinder = {
    goto: async (goal: any) => { goals.push(goal); bot.entity.position = new Vec3(-12.5, 64, 0.5); fish.position = new Vec3(3.5, 64, 0.5); infested = [] },
    cancel: async () => {},
    isPathing: false
  }
  await fleeNest(bot)
  assert.strictEqual(goals.length, 1)
  assert.strictEqual(goals[0].constructor.name, 'GoalInvert')
  const inner = goals[0].goal
  assert.strictEqual(inner.constructor.name, 'GoalNear')
  assert.ok(inner.distance > 8, `${inner.distance}`)
  assert.ok(new Vec3(inner.x, inner.y, inner.z).distanceTo(new Vec3(3.5, 63.5, 0.5)) < 2, `round ${inner.x}, ${inner.y}, ${inner.z}`)
})
