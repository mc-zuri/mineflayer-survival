import { test } from 'node:test'
import assert from 'node:assert/strict'
import { usesLeft, wornOutTools } from '../../src/executor/durability'

test('usesLeft: max damage less the damage; Infinity for what does not wear', () => {
  assert.equal(usesLeft({ name: 'iron_pickaxe', maxDurability: 250, durabilityUsed: 240 }), 10)
  assert.equal(usesLeft({ name: 'cobblestone' }), Infinity)
})

test('wornOutTools: the best tier of a kind about to break, unless another of the tier has uses left', () => {
  const worn = wornOutTools([
    { name: 'stone_pickaxe', maxDurability: 131, durabilityUsed: 125 },
    { name: 'wooden_pickaxe', maxDurability: 59, durabilityUsed: 0 },
    { name: 'iron_sword', maxDurability: 250, durabilityUsed: 245 },
    { name: 'iron_sword', maxDurability: 250, durabilityUsed: 10 },
    { name: 'stone_axe', maxDurability: 131, durabilityUsed: 130 }
  ], { minUses: 12 })
  assert.deepEqual(worn.map(w => [w.kind, w.material, w.uses]), [['pickaxe', 'stone', 6], ['axe', 'stone', 1]])
  assert.deepEqual(wornOutTools([{ name: 'stone_pickaxe', maxDurability: 131, durabilityUsed: 100 }]), [])
})
