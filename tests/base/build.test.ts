import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BASE_BLUEPRINT, buildMaterials, chestsToPlace, placementItem } from '../../src/base/build'
import { checkStorageSafety, generateBlueprint, planBuild } from '../../src/base'
import { WorldMemory } from '../../src/core/memory'
import { BASE_POI, baseRecord } from '../../src/base/pois'

test('the first base: what it takes in the open (a superflat), and in stone', () => {
  const bp = generateBlueprint({ ...BASE_BLUEPRINT, origin: { x: 0, y: 0, z: 0 } })
  assert.equal(bp.storage.length, 11)
  const open = buildMaterials(planBuild(bp, () => null).placements, 4, 'cobblestone')
  assert.deepEqual(open, { cobblestone: 632, chest: 4, crafting_table: 1, furnace: 1, bed: 1, torch: 3, oak_door: 2 })
  // dug into stone, the shell is all there already
  const inStone = planBuild(bp, (x, y, z) => 'stone')
  assert.equal(inStone.dig.length, bp.dig.length)
  assert.deepEqual(buildMaterials(inStone.placements, 4, 'cobblestone'), { chest: 4, crafting_table: 1, furnace: 1, bed: 1, torch: 3, oak_door: 2 })
  // the first four chests are the west wall's two pairs
  const first = [...chestsToPlace(bp, 4)]
  assert.deepEqual(first, ['0,0,0', '0,0,1', '0,0,2', '0,0,3'])
})

test('the first base with four chests is safe from creepers and charged ones when built', () => {
  const bp = generateBlueprint({ ...BASE_BLUEPRINT, origin: { x: 0, y: 0, z: 0 } })
  const report = checkStorageSafety(bp.world(), bp.storage.slice(0, 4), { bounds: bp.bounds })
  assert.equal(report.safe, true)
})

test('placementItem: the torch for a wall torch, a held shell material, the bed only when held', () => {
  const bp = generateBlueprint({ ...BASE_BLUEPRINT, origin: { x: 0, y: 0, z: 0 } })
  const of = (block: string): any => bp.placements.find(p => p.block === block)
  const held = (items: Record<string, number>) => (name: string) => items[name] ?? 0
  assert.equal(placementItem(of('wall_torch'), held({}), 'cobblestone'), 'torch')
  assert.equal(placementItem(of('cobblestone'), held({ cobblestone: 3 }), 'cobblestone'), 'cobblestone')
  assert.equal(placementItem(of('cobblestone'), held({ cobbled_deepslate: 30, stone: 2 }), 'cobblestone'), 'cobbled_deepslate')
  assert.equal(placementItem(of('cobblestone'), held({}), 'cobblestone'), null)
  assert.equal(placementItem(of('white_bed'), held({ white_bed: 1 }), 'cobblestone'), 'white_bed')
  assert.equal(placementItem(of('white_bed'), held({}), 'cobblestone'), null)
  assert.equal(placementItem(of('chest'), held({}), 'cobblestone'), 'chest')
})

test('baseRecord reads the base back from the memory, through its JSON', () => {
  const mem = new WorldMemory()
  mem.setBase({ x: 10, y: 40, z: 10 })
  mem.addPoi(BASE_POI.entrance, { x: 15, y: 40, z: 4 })
  mem.addPoi(BASE_POI.table, { x: 12, y: 40, z: 10 })
  mem.addPoi(BASE_POI.furnace, { x: 13, y: 40, z: 10 })
  mem.addPoi(BASE_POI.bounds, { x: 8, y: 38, z: 5 }, 'overworld', '18,45,16')
  mem.rememberChest({ x: 10, y: 40, z: 11 }, { raw_iron: 5 })
  mem.rememberChest({ x: 100, y: 40, z: 11 }, { raw_iron: 5 })
  const back = new WorldMemory()
  back.restore(JSON.stringify(mem.toJSON()))
  const r = baseRecord(back)
  assert.ok(r != null)
  assert.deepEqual(r.entrance, { x: 15, y: 40, z: 4 })
  assert.deepEqual(r.table, { x: 12, y: 40, z: 10 })
  assert.deepEqual(r.furnaces, [{ x: 13, y: 40, z: 10 }])
  // only the chests in the base's box
  assert.deepEqual(r.chests, [{ x: 10, y: 40, z: 11 }])
  assert.deepEqual(r.bounds, { min: { x: 8, y: 38, z: 5 }, max: { x: 18, y: 45, z: 16 } })
  assert.equal(baseRecord(new WorldMemory()), null)
})

test('placementFacing: along a bed or a door, back at the player for a chest or a furnace, none for a wall torch', async () => {
  const { placementFacing } = await import('../../src/base/build')
  const { yawFor } = await import('../../src/skills/placeBlock')
  const bp = generateBlueprint({ ...BASE_BLUEPRINT, origin: { x: 0, y: 0, z: 0 } })
  const of = (block: string, facing?: string): any => bp.placements.find(p => p.block === block && (facing == null || p.state.facing === facing))
  assert.deepEqual(placementFacing(of('white_bed'))?.toArray(), [1, 0, 0])
  assert.deepEqual(placementFacing(of('oak_door', 'south'))?.toArray(), [0, 0, 1])
  // a chest facing east (on the west wall) is placed looking west
  assert.deepEqual(placementFacing(of('chest', 'east'))?.toArray(), [-1, 0, 0])
  assert.deepEqual(placementFacing(of('furnace'))?.toArray(), [0, 0, -1])
  assert.equal(placementFacing(of('wall_torch')), undefined)
  assert.equal(placementFacing(of('cobblestone')), undefined)
  // mineflayer's yaw: 0 to -z, pi/2 to -x, -pi/2 to +x
  assert.equal(yawFor(placementFacing(of('chest', 'east'))!), Math.PI / 2)
  assert.equal(Math.abs(yawFor(placementFacing(of('oak_door', 'south'))!)), Math.PI)
})
