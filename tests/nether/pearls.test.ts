import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { isAdmiring, isAdultPiglin, ingotsForPearls, looksAtEnderman } from '../../src/nether/pearls'
import { entity, fakeBot, item } from '../reflexes/fakeBot'

test('piglins: adults barter, an admiring one holds gold in its off hand', () => {
  const bot = fakeBot()
  const adult = entity({ name: 'piglin', position: new Vec3(2, 64, 0) })
  const baby = entity({ name: 'piglin', position: new Vec3(2, 64, 1), meta: { baby: true } })
  bot.entities[adult.id] = adult
  bot.entities[baby.id] = baby
  assert.equal(isAdultPiglin(bot, adult), true)
  assert.equal(isAdultPiglin(bot, baby), false)
  assert.equal(isAdmiring(adult), false)
  adult.equipment = [null, item('gold_ingot')]
  assert.equal(isAdmiring(adult), true)
  // about 3 pearls per 47 ingots on average: 2 pearls at 90% take more than the mean
  assert.ok(ingotsForPearls(2) > 2 / (10 / 469 * 3))
})

test('looksAtEnderman: EnderMan.isLookingAtMe, the look within 0.025 / distance of its eyes', () => {
  const man = entity({ name: 'enderman', position: new Vec3(10, 64, 0) })
  const eye = new Vec3(0, 65.62, 0)
  const toEyes = new Vec3(10, 64 + 2.55, 0).minus(eye)
  assert.equal(looksAtEnderman(eye, toEyes, man), true)
  assert.equal(looksAtEnderman(eye, new Vec3(10, 64.5, 0).minus(eye), man), false) // at its legs
})
