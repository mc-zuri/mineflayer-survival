import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { nearestOfType } from '../../src/skills/hunt'
import { entity, fakeBot } from '../reflexes/fakeBot'

test('nearestOfType skips the babies (they drop nothing)', () => {
  const calf = entity({ name: 'cow', position: new Vec3(2, 64, 0), meta: { baby: true } })
  const cow = entity({ name: 'cow', position: new Vec3(6, 64, 0), meta: { baby: false } })
  const pig = entity({ name: 'pig', position: new Vec3(1, 64, 0) })
  const bot = fakeBot({ position: new Vec3(0, 64, 0), entities: [calf, cow, pig] })
  assert.strictEqual(nearestOfType(bot, ['cow'], 64), cow)
  assert.strictEqual(nearestOfType(bot, ['cow', 'pig'], 64), pig)
  assert.strictEqual(nearestOfType(bot, ['cow'], 4), null)
})

test('hunt gives up with NO_PATH when the pathfinder makes no headway toward the animal (it used to wait forever)', async () => {
  const cow = entity({ name: 'cow', position: new Vec3(40, 64, 0), meta: { baby: false } })
  const bot = fakeBot({ position: new Vec3(0, 60, 0), entities: [cow] })
  let release: (() => void) | null = null
  bot.pathfinder = {
    isPathing: false,
    goto: async () => { bot.pathfinder.isPathing = true; await new Promise<void>(resolve => { release = resolve }); bot.pathfinder.isPathing = false },
    cancel: async () => { release?.() }
  }
  const { hunt } = await import('../../src/skills/hunt')
  const rejected = assert.rejects(hunt(bot, 'cow'), (err: any) => err.code === 'NO_PATH')
  // the pathfinder plans and plans, the bot stays in its hole
  for (let i = 0; i < 150; i++) { bot.emit('physicsTick'); await new Promise(resolve => setImmediate(resolve)) }
  await rejected
})

test('nearestOfType skips the dead (health 0, still there for the death animation)', () => {
  const dead = entity({ name: 'cow', position: new Vec3(2, 64, 0), meta: { baby: false, health: 0 } })
  const cow = entity({ name: 'cow', position: new Vec3(6, 64, 0), meta: { baby: false, health: 10 } })
  const bot = fakeBot({ position: new Vec3(0, 64, 0), entities: [dead, cow] })
  assert.strictEqual(nearestOfType(bot, ['cow'], 64), cow)
})
