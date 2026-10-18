import { test } from 'node:test'
import assert from 'node:assert'
import minecraftData from 'minecraft-data'
import { SMELT_XP, XP_MOBS, XP_ORES, totalXpForLevel, xpNeededForNextLevel, xpToLevel } from '../../src/skills/xp'

const registry: any = minecraftData('1.21.11')

test('Player.getXpNeededForNextLevel and the totals: 1395 points to level 30', () => {
  assert.strictEqual(xpNeededForNextLevel(0), 7)
  assert.strictEqual(xpNeededForNextLevel(14), 35)
  assert.strictEqual(xpNeededForNextLevel(15), 37)
  assert.strictEqual(xpNeededForNextLevel(29), 107)
  assert.strictEqual(xpNeededForNextLevel(30), 112)
  assert.strictEqual(totalXpForLevel(15), 315)
  assert.strictEqual(totalXpForLevel(30), 1395)
  // from level 27 halfway to 28: (1395 - 1089) - half of 97, floored
  assert.strictEqual(totalXpForLevel(27), 1089)
  assert.strictEqual(xpToLevel(30, 27, 0.5), 306 - 48)
  assert.strictEqual(xpToLevel(30, 31), 0)
})

test('the experience sources name real 1.21.11 blocks, items and mobs', () => {
  for (const ore of Object.keys(XP_ORES)) assert.ok(registry.blocksByName[ore] != null, ore)
  for (const item of Object.keys(SMELT_XP)) assert.ok(registry.itemsByName[item] != null, item)
  for (const mob of XP_MOBS) assert.ok(registry.entitiesByName[mob] != null, mob)
  assert.ok(!XP_MOBS.includes('creeper'))
})
