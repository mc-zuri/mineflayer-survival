// A hunt's kill picks up its drops about the kill, then the ones flung further off (DROPS_RADIUS).
import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { DROPS_RADIUS } from '../../src/skills/hunt'
import { entity, fakeBot } from '../reflexes/fakeBot'

test('hunt: the drops of a kill flung past collectDropsNear\'s 4 blocks are gone for too (snowFood: a rabbit\'s meat left 12 blocks down a slope)', async () => {
  const rabbit = entity({ name: 'rabbit', position: new Vec3(3.5, 64, 0.5) })
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), entities: [rabbit] })
  const fightModule = require('../../src/skills/fight')
  const pickupModule = require('../../src/skills/pickupDrops')
  const real = { fight: fightModule.fight, pickupDrops: pickupModule.pickupDrops }
  const asked: any[] = []
  fightModule.fight = async () => ({ killed: true, hits: 1, ticks: 10, lastPosition: new Vec3(3.5, 64, 0.5) })
  pickupModule.pickupDrops = async (_b: any, args: any) => { asked.push(args); return { picked: 1, items: { rabbit: 1 } } }
  const ticking = setInterval(() => bot.emit('physicsTick'), 1)
  try {
    const { hunt } = await import('../../src/skills/hunt')
    const res = await hunt(bot, rabbit as any, { pathDistance: 64 })
    assert.strictEqual(res.killed, true)
    assert.deepStrictEqual(res.drops, { rabbit: 1 })
    assert.strictEqual(asked.length, 1)
    assert.strictEqual(asked[0].radius, DROPS_RADIUS)
    assert.ok(asked[0].near.equals(new Vec3(3.5, 64, 0.5)))
    // none asked for when it got away
    fightModule.fight = async () => ({ killed: false, hits: 0, ticks: 10, lastPosition: new Vec3(3.5, 64, 0.5) })
    await hunt(bot, rabbit as any, { pathDistance: 64 })
    assert.strictEqual(asked.length, 1)
  } finally {
    clearInterval(ticking)
    fightModule.fight = real.fight
    pickupModule.pickupDrops = real.pickupDrops
  }
})
