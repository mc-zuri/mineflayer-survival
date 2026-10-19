// The carved pumpkin of the End: worn, it stays on there (the armor reflex leaves it), and a helmet goes back on elsewhere.
import { test } from 'node:test'
import assert from 'node:assert'
import { armorUpgrades } from '../../src/skills/armor'
import { carvePumpkin, wearingPumpkin } from '../../src/skills/pumpkin'
import { fakeBot, item } from '../reflexes/fakeBot'

test('a carved pumpkin worn in the End stays on (no helmet upgrade); out of it the diamond helmet is the upgrade', () => {
  const bot = fakeBot({ items: [item('diamond_helmet', 1)], armor: { head: item('carved_pumpkin', 1) } })
  assert.strictEqual(wearingPumpkin(bot), true)
  bot.game.dimension = 'the_end'
  assert.strictEqual(armorUpgrades(bot).head, undefined)
  bot.game.dimension = 'overworld'
  assert.strictEqual(armorUpgrades(bot).head?.name, 'diamond_helmet')
})

test('carvePumpkin: one held already is it; without a pumpkin and shears, MISSING_ITEMS', async () => {
  assert.strictEqual(await carvePumpkin(fakeBot({ items: [item('carved_pumpkin', 1)] })), 1)
  await assert.rejects(carvePumpkin(fakeBot({ items: [item('pumpkin', 1)] })), /no pumpkin and shears/)
})
