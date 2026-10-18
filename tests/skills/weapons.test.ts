import { test } from 'node:test'
import assert from 'node:assert'
import { EventEmitter } from 'node:events'
import { AttackStrength, attackStrengthDelay, bestMeleeWeapon, hitDamage, meleeDps, meleeStats } from '../../src/skills/weapons'
import { SwellCounter } from '../../src/skills/fight'
import { fakeBot, item } from '../reflexes/fakeBot'

const near = (a: number, b: number, eps = 1e-9): void => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`)

test('weapon stats are 1.21.11\'s (swords 1.6 a second, axes slower and harder)', () => {
  assert.deepStrictEqual(meleeStats('iron_sword'), { damage: 6, speed: 1.6 })
  assert.deepStrictEqual(meleeStats('netherite_sword'), { damage: 8, speed: 1.6 })
  assert.deepStrictEqual(meleeStats('copper_sword'), { damage: 5, speed: 1.6 })
  assert.deepStrictEqual(meleeStats('iron_axe'), { damage: 9, speed: 0.9 })
  assert.deepStrictEqual(meleeStats('diamond_pickaxe'), { damage: 5, speed: 1.2 })
  assert.deepStrictEqual(meleeStats('stick'), { damage: 1, speed: 4 })
  // Player.getCurrentItemAttackStrengthDelay
  near(attackStrengthDelay('iron_sword'), 12.5)
  near(attackStrengthDelay(undefined), 5)
  near(attackStrengthDelay('iron_axe'), 20 / 0.9)
})

test('bestMeleeWeapon by damage a second, sharpness and smite counted', () => {
  assert.strictEqual(bestMeleeWeapon(fakeBot({ items: [item('iron_axe'), item('iron_sword'), item('dirt', 64)] }))?.name, 'iron_sword')
  assert.strictEqual(bestMeleeWeapon(fakeBot({ items: [item('stone_sword'), item('diamond_axe')] }))?.name, 'diamond_axe')
  assert.strictEqual(bestMeleeWeapon(fakeBot({ items: [item('dirt')] })), null)
  near(hitDamage(item('iron_sword', 1, [{ name: 'sharpness', lvl: 5 }])), 9)
  const smite = item('iron_sword', 1, [{ name: 'smite', lvl: 5 }])
  near(meleeDps(smite, 'zombie'), (6 + 12.5) * 1.6)
  near(meleeDps(smite, 'spider'), 6 * 1.6)
  const bot = fakeBot({ items: [item('diamond_sword'), smite] })
  assert.strictEqual(bestMeleeWeapon(bot, 'zombie'), smite)
  assert.strictEqual(bestMeleeWeapon(bot, 'spider')?.name, 'diamond_sword')
})

test('AttackStrength: Player.getAttackStrengthScale over the held item delay, reset by a swing or another item', () => {
  const bot: any = Object.assign(new EventEmitter(), { heldItem: item('iron_sword'), attack: () => {} })
  const s = new AttackStrength(bot)
  bot.emit('physicsTick') // takes the sword: the ticker starts over
  assert.strictEqual(s.ticker, 0)
  for (let i = 0; i < 11; i++) bot.emit('physicsTick')
  near(s.scale(0.5), 11.5 / 12.5)
  assert.strictEqual(s.ticksToFull(), 1)
  bot.emit('physicsTick')
  assert.strictEqual(s.scale(0.5), 1)
  assert.strictEqual(s.ticksToFull(), 0)
  s.attack({})
  assert.strictEqual(s.ticker, 0)
  for (let i = 0; i < 5; i++) bot.emit('physicsTick')
  bot.heldItem = null
  bot.emit('physicsTick')
  assert.strictEqual(s.ticker, 0)
  for (let i = 0; i < 5; i++) bot.emit('physicsTick')
  assert.strictEqual(s.scale(0.5), 1) // a fist: 5 ticks
  s.detach()
})

test('SwellCounter: the swell of Creeper.tick, +1 a tick while swelling, -1 after, 0 - 30', () => {
  const c = new SwellCounter()
  for (let i = 0; i < 10; i++) c.update(true)
  assert.strictEqual(c.swell, 10)
  for (let i = 0; i < 4; i++) c.update(false)
  assert.strictEqual(c.swell, 6)
  for (let i = 0; i < 40; i++) c.update(true)
  assert.strictEqual(c.swell, 30)
  for (let i = 0; i < 40; i++) c.update(false)
  assert.strictEqual(c.swell, 0)
})
