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

test('provokeEnderman: a stare at its eyes from where the bot stands until it\'s angry; none within the 4 a stare teleports it from', async () => {
  const { provokeEnderman, eyesInSight, isAngryEnderman, STARE_TICKS } = await import('../../src/nether/pearls')
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5) })
  const man = entity({ name: 'enderman', position: new Vec3(12.5, 64, 0.5) })
  bot.entities[man.id] = man
  const looks: Vec3[] = []
  bot.lookAt = async (p: Vec3) => { looks.push(p) }
  const creepy = bot.registry.entitiesByName.enderman.metadataKeys.indexOf('creepy')
  // the server's goal takes the stare 5 ticks on: angry then
  const ticker = setInterval(() => { if (looks.length >= 5) man.metadata[creepy] = true; bot.emit('physicsTick') }, 1)
  try {
    assert.equal(await provokeEnderman(bot, man), true)
    assert.ok(isAngryEnderman(bot, man))
    assert.ok(looks.length >= 5 && looks.length < STARE_TICKS)
    assert.ok(looks.every(p => Math.abs(p.y - 66.55) < 1e-9 && p.x === 12.5), 'at its eyes')
    // one within 4: no stare (it would teleport off)
    const near = entity({ name: 'enderman', position: new Vec3(3, 64, 0.5) })
    bot.entities[near.id] = near
    looks.length = 0
    assert.equal(await provokeEnderman(bot, near), false)
    assert.equal(looks.length, 0)
  } finally {
    clearInterval(ticker)
  }
  // its eyes behind a block: not in sight (the stare wouldn't count)
  ;(bot as any).world = { raycast: (from: Vec3, dir: Vec3, range: number) => range > 5 ? { position: from.plus(dir.scaled(5)).floored() } : null }
  assert.equal(eyesInSight(bot, man), false)
  ;(bot as any).world = { raycast: () => null }
  assert.equal(eyesInSight(bot, man), true)
})

test('huntEndermen passes over an enderman it finds no way to (unless it comes), and says so', async () => {
  const { huntEndermen, huntable } = await import('../../src/nether/pearls')
  const bot = fakeBot({ position: new Vec3(0.5, 98, 0.5) })
  const below = entity({ name: 'enderman', position: new Vec3(2.5, 67, 3.5) })
  bot.entities[below.id] = below
  // (the fake bot has no pathfinder: every walk to it fails)
  const passOver = new Set<number>()
  await assert.rejects(huntEndermen(bot, { pearls: 1, range: 48, provoke: false, passOver }), /no enderman within 48 blocks the bot can get to/)
  assert.ok(passOver.has(below.id))
  assert.equal(huntable(bot, below, passOver), false)
  // angry, it comes: hunted again
  below.metadata[bot.registry.entitiesByName.enderman.metadataKeys.indexOf('creepy')] = true
  assert.equal(huntable(bot, below, passOver), true)
})
