import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { WorldMemory } from '../../src/core/memory'
import { NETHER_DEATHS_KEPT, NETHER_DEATH_COST, nearDeath, rememberNetherDeath } from '../../src/nether/deaths'
import { netherMoveSettings } from '../../src/nether/safety'
import { gridPath, type GridCellView } from '../../src/skills/gridWalk'
import { fakeBot } from '../reflexes/fakeBot'

test('rememberNetherDeath keeps the last few deaths in the nether as points; nearDeath is within 8 sideways and 12 up or down', () => {
  const memory = new WorldMemory()
  for (let i = 0; i < NETHER_DEATHS_KEPT + 3; i++) {
    memory.now = 100 * i
    rememberNetherDeath(memory, { x: 100 * i + 0.7, y: 31.2, z: -5.5 })
  }
  const deaths = memory.getPois('nether_death', { dimension: 'the_nether' })
  assert.equal(deaths.length, NETHER_DEATHS_KEPT)
  assert.ok(deaths.every(d => d.x >= 300), 'the oldest are dropped')
  assert.deepEqual([deaths[0].y, deaths[0].z], [31, -6])
  assert.equal(nearDeath(deaths, { x: 1006, y: 40, z: -6 }), true)
  assert.equal(nearDeath(deaths, { x: 1009, y: 31, z: -6 }), false)
  assert.equal(nearDeath(deaths, { x: 1000, y: 44, z: -6 }), false)
})

test('netherMoveSettings: a cell near a death in the nether costs more; with avoidDeaths off, or none remembered, it doesn\'t', () => {
  const bot = fakeBot()
  const reg = bot.registry
  bot.world = { getBlockStateId: (p: Vec3) => (p.y < 64 ? reg.blocksByName.netherrack.defaultState : reg.blocksByName.air.defaultState) }
  const memory = new WorldMemory()
  bot.survival = { memory }
  assert.equal((netherMoveSettings(bot).exclusionAreasStep?.[0] as any)({ position: new Vec3(3, 64, 0), type: 0 }), 0)
  rememberNetherDeath(memory, { x: 0, y: 64, z: 0 })
  const step = netherMoveSettings(bot).exclusionAreasStep?.[0] as any
  assert.equal(step({ position: new Vec3(3, 64, 0), type: 0 }), NETHER_DEATH_COST)
  assert.equal(step({ position: new Vec3(20, 64, 0), type: 0 }), 0)
  assert.equal((netherMoveSettings(bot, { avoidDeaths: false }).exclusionAreasStep?.[0] as any)({ position: new Vec3(3, 64, 0), type: 0 }), 0)
})

test('gridPath: the walk goes round where the bot died (cellCost), not through it', () => {
  const solid = new Set<string>()
  for (let x = -20; x <= 40; x++) for (let z = -20; z <= 20; z++) solid.add(`${x},63,${z}`)
  const k = (p: Vec3): string => `${p.x},${p.y},${p.z}`
  const deaths = [{ x: 10, y: 64, z: 0 }]
  const view: GridCellView = { free: p => !solid.has(k(p)), floor: p => solid.has(k(p)), cellCost: c => nearDeath(deaths, c) ? 5 : 0 }
  const path = gridPath(view, new Vec3(0, 64, 0), c => c.x === 20 && c.z === 0, c => Math.abs(c.x - 20) + Math.abs(c.z))
  assert.ok(path != null)
  assert.ok(path.every(c => !nearDeath(deaths, c)), `the walk goes by the death: ${path.map(c => c.toString()).join(' ')}`)
})
