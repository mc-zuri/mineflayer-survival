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

test('applyBooks: a book of protection goes on the helmet worn, taken off for the anvil and worn again after', async () => {
  const { applyBooks } = await import('../../src/skills/anvil')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const book = item('enchanted_book', 1)
  book.enchants = [{ name: 'projectile_protection', lvl: 1 }]
  const helmet = item('diamond_helmet', 1)
  const bot = fakeBot({ items: [book], armor: { head: helmet } })
  bot._client = new (require('node:events').EventEmitter)()
  bot.findBlock = () => null
  const calls: string[] = []
  bot.unequip = async (dest: string) => { calls.push(`unequip ${dest}`); bot.inventory.slots[5] = null; helmet.slot = 20; bot.inventory.slots[20] = helmet }
  bot.equip = async (it: any, dest: string) => { calls.push(`equip ${it.name} ${dest}`) }
  // no anvil about: the combine fails, and the helmet goes back on (the world ticks for the inventory's settling)
  const timer = setInterval(() => bot.emit('physicsTick'), 0)
  try {
    await assert.rejects(applyBooks(bot), /no anvil/)
  } finally {
    clearInterval(timer)
  }
  assert.deepStrictEqual(calls, ['unequip head', 'equip diamond_helmet head'])
})

test('kindsFor: a book goes to the gear in its order (the pickaxe before a hoe, the armor for protection), never a hoe', async () => {
  const { kindsFor } = await import('../../src/skills/anvil')
  assert.ok(!kindsFor('unbreaking').includes('hoe' as any))
  assert.equal(kindsFor('unbreaking')[0], 'pickaxe')
  assert.equal(kindsFor('protection')[0], 'chestplate')
  assert.equal(kindsFor('sharpness')[0], 'sword')
})

test('kindsFor: a book of mending goes on the pickaxe, then the armor (chestplate, leggings, helmet), then the sword (GEAR_ORDER)', async () => {
  const { kindsFor } = await import('../../src/skills/anvil')
  assert.deepEqual(kindsFor('mending').slice(0, 5), ['pickaxe', 'chestplate', 'leggings', 'helmet', 'sword'])
})
