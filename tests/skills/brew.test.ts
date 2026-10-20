import { test } from 'node:test'
import assert from 'node:assert'
import { BREWS, POTION, brewChain, isWaterBottle } from '../../src/skills/brew'
import { item } from '../reflexes/fakeBot'

const potion = (id: number): any => {
  const p = item('potion')
  p.componentMap = new Map([['potion_contents', { type: 'potion_contents', data: { potionId: id, customEffects: [] } }]])
  return p
}

test('brewChain: water, the nether wart\'s awkward potion, the magma cream\'s fire resistance, the redstone\'s long one (VanillaBrewingProvider); an ingredient that makes nothing of the bottle refused', () => {
  assert.deepStrictEqual(brewChain(['nether_wart', 'magma_cream']), [POTION.awkward, POTION.fire_resistance])
  assert.deepStrictEqual(brewChain(['nether_wart', 'magma_cream', 'redstone']), [3, 11, 12])
  assert.throws(() => brewChain(['magma_cream']), /brews nothing/)
  assert.strictEqual(BREWS.nether_wart.to, POTION.awkward)
})

test('isWaterBottle: a potion of water, not of fire resistance, not a glass bottle', () => {
  assert.strictEqual(isWaterBottle(potion(0)), true)
  assert.strictEqual(isWaterBottle(potion(11)), false)
  assert.strictEqual(isWaterBottle(item('glass_bottle')), false)
})
