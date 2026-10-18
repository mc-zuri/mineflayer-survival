import { test } from 'node:test'
import assert from 'node:assert'
import minecraftData from 'minecraft-data'
import { ANVIL_BLOCKS, repairMaterial } from '../../src/skills/anvil'

const registry: any = minecraftData('1.21.11')

test('repairMaterial: the material each tier repairs with, as the repair tags have it', () => {
  assert.strictEqual(repairMaterial('diamond_pickaxe'), 'diamond')
  assert.strictEqual(repairMaterial('netherite_chestplate'), 'netherite_ingot')
  assert.strictEqual(repairMaterial('iron_sword'), 'iron_ingot')
  assert.strictEqual(repairMaterial('chainmail_boots'), 'iron_ingot')
  assert.strictEqual(repairMaterial('golden_helmet'), 'gold_ingot')
  assert.strictEqual(repairMaterial('stone_axe'), 'cobblestone')
  assert.strictEqual(repairMaterial('elytra'), 'phantom_membrane')
  assert.strictEqual(repairMaterial('turtle_helmet'), 'turtle_scute')
  assert.strictEqual(repairMaterial('bow'), null)
  for (const name of ['diamond_pickaxe', 'iron_sword', 'golden_helmet', 'stone_axe', 'elytra', 'turtle_helmet', 'leather_boots', 'copper_pickaxe']) {
    const material = repairMaterial(name)
    assert.ok(material != null && registry.itemsByName[material] != null, `${name}: ${String(material)}`)
  }
  for (const block of ANVIL_BLOCKS) assert.ok(registry.blocksByName[block] != null, block)
})
