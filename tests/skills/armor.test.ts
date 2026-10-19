import { test } from 'node:test'
import assert from 'node:assert'
import { armorPiece, armorUpgrades, damageAfterArmor, damageThrough, requireGoldArmor } from '../../src/skills/armor'
import { fakeBot, item } from '../reflexes/fakeBot'

const near = (a: number, b: number, eps = 1e-9): void => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`)

test('armorPiece: ArmorMaterials\' defense and toughness by slot', () => {
  assert.deepStrictEqual(armorPiece('iron_chestplate'), { slot: 'torso', defense: 6, toughness: 0 })
  assert.deepStrictEqual(armorPiece('diamond_helmet'), { slot: 'head', defense: 3, toughness: 2 })
  assert.deepStrictEqual(armorPiece('netherite_boots'), { slot: 'feet', defense: 3, toughness: 3 })
  assert.deepStrictEqual(armorPiece('copper_leggings'), { slot: 'legs', defense: 3, toughness: 0 })
  assert.deepStrictEqual(armorPiece('turtle_helmet'), { slot: 'head', defense: 2, toughness: 0 })
  assert.strictEqual(armorPiece('elytra'), null)
  assert.strictEqual(armorPiece('carved_pumpkin'), null)
})

test('CombatRules.getDamageAfterAbsorb', () => {
  // full diamond (20 armor, 8 toughness) against 10: 20 - 10 / 4 = 17.5 -> 10 x (1 - 0.7)
  near(damageAfterArmor(10, 20, 8), 3)
  // full iron (15) against 4: 15 - 2 = 13 -> 4 x (1 - 0.52)
  near(damageAfterArmor(4, 15, 0), 1.92)
  // the floor: a fifth of the armor
  near(damageAfterArmor(100, 10, 0), 100 * (1 - 2 / 25))
  // protection IV on every piece: 16 points, 64%
  const prot = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'].map(n => item(n, 1, [{ name: 'protection', lvl: 4 }]))
  near(damageThrough(prot, 4), damageAfterArmor(4, 15, 0) * (1 - 16 / 25))
})

test('armorUpgrades: the better piece per slot, the worn one kept when it\'s better', () => {
  const bot = fakeBot({
    items: [item('iron_helmet'), item('leather_chestplate'), item('diamond_chestplate'), item('golden_leggings'), item('iron_boots', 1, [{ name: 'binding_curse', lvl: 1 }])],
    armor: { legs: item('iron_leggings') }
  })
  const up = armorUpgrades(bot)
  assert.strictEqual(up.head?.name, 'iron_helmet')
  assert.strictEqual(up.torso?.name, 'diamond_chestplate')
  assert.strictEqual(up.legs, undefined) // iron beats gold
  assert.strictEqual(up.feet, undefined) // never curse of binding
})

test('armorUpgrades: enchantments (item components on 1.21.11) and durability break ties', () => {
  const bot = fakeBot({ items: [item('iron_helmet'), item('iron_helmet', 1, [{ name: 'protection', lvl: 3 }])], armor: {} })
  assert.deepStrictEqual(armorUpgrades(bot).head?.enchants, [{ name: 'protection', lvl: 3 }])
  const worn = item('iron_helmet')
  worn.durabilityUsed = 100
  const bot2 = fakeBot({ items: [item('iron_helmet')], armor: { head: worn } })
  assert.strictEqual(armorUpgrades(bot2).head?.durabilityUsed, 0)
  const bot3 = fakeBot({ items: [worn], armor: { head: item('iron_helmet') } })
  assert.strictEqual(armorUpgrades(bot3).head, undefined)
})

test('gold armor: worn, and kept on by armorUpgrades once required', () => {
  const bot = fakeBot({ armor: { feet: item('golden_boots') }, items: [item('iron_boots'), item('iron_helmet')] })
  assert.deepEqual(Object.keys(armorUpgrades(bot)).sort(), ['feet', 'head'])
  requireGoldArmor(bot, true)
  assert.deepEqual(Object.keys(armorUpgrades(bot)), ['head'])
  requireGoldArmor(bot, false)
})

test('withArmorHeld: no upgrades offered while the armor is off on purpose (the table, the anvil), as before after', async () => {
  const { withArmorHeld } = await import('../../src/skills/armor')
  const bot = fakeBot({ items: [item('diamond_chestplate')], armor: {} })
  assert.strictEqual(armorUpgrades(bot).torso?.name, 'diamond_chestplate')
  await withArmorHeld(bot, async () => { assert.deepStrictEqual(armorUpgrades(bot), {}) })
  assert.strictEqual(armorUpgrades(bot).torso?.name, 'diamond_chestplate')
})
