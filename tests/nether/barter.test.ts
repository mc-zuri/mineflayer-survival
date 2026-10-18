import { test } from 'node:test'
import assert from 'node:assert/strict'
import { goldForPearls, planBarter } from '../../src/nether/barter'
import { netherToOverworld, overworldToNether, portalDestination } from '../../src/nether/coords'

test('gold for pearls: the expected count, and more for a 90% chance', () => {
  // 10 / 469 × 3 pearls per ingot
  const p = goldForPearls(12)
  assert.equal(p.expectedIngots, Math.ceil(12 / (30 / 469)))
  assert.ok(p.ingots > p.expectedIngots)
  assert.ok(p.chance >= 0.9)
  // one ingot fewer misses the confidence
  const less = planBarter('ender_pearl', 12, { confidence: p.chance + 1e-12, maxIngots: p.ingots - 1 })
  assert.ok(less.chance < 0.9)
  assert.equal(goldForPearls(12, { piglins: 4 }).ticks, Math.ceil(p.ingots / 4) * 120)
  assert.throws(() => planBarter('diamond', 1))
})

test('a single sure item: obsidian needs about 469 / 40 ingots each', () => {
  const p = planBarter('obsidian', 1, { confidence: 0.5 })
  // P(no obsidian in n) = (1 - 40/469)^n ≤ 0.5 → n = 8
  assert.equal(p.ingots, 8)
})

test('overworld and nether coordinates scale by 8 in x and z', () => {
  assert.deepEqual(overworldToNether({ x: 800, y: 70, z: -164 }), { x: 100, y: 70, z: -20.5 })
  assert.deepEqual(netherToOverworld({ x: 100, y: 70, z: -20.5 }), { x: 800, y: 70, z: -164 })
  const d = portalDestination({ x: -13.7, y: 64, z: 100.2 }, 'minecraft:overworld', 'minecraft:the_nether')
  assert.deepEqual(d, { block: { x: -2, y: 64, z: 12 }, searchRadius: 16 })
  assert.equal(portalDestination({ x: 0, y: 64, z: 0 }, 'the_nether', 'overworld').searchRadius, 128)
})
