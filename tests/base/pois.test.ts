import { test } from 'node:test'
import assert from 'node:assert/strict'

test('baseBuilt: a base with at most a fifth of its blocks missing is built; one with most missing is not, till its third build; a save from before the note is', async () => {
  const { baseBuilt, BASE_POI } = await import('../../src/base/pois')
  const { WorldMemory } = await import('../../src/core/memory')
  const m = new WorldMemory()
  assert.equal(baseBuilt(m), false)
  m.setBase({ x: 0, y: 60, z: 0 }, 'overworld')
  assert.equal(baseBuilt(m), true, 'no note: built')
  m.addPoi(BASE_POI.build, { x: 0, y: 60, z: 0 }, 'overworld', '175/240/1')
  assert.equal(baseBuilt(m), false)
  m.addPoi(BASE_POI.build, { x: 0, y: 60, z: 0 }, 'overworld', '40/240/2')
  assert.equal(baseBuilt(m), true)
  m.addPoi(BASE_POI.build, { x: 0, y: 60, z: 0 }, 'overworld', '175/240/3')
  assert.equal(baseBuilt(m), true, 'the third build: taken as it is')
})

test('keepBaseUnbroken: the base\'s bed (both halves), table and chests kept from the pathfinder\'s digs, from the memory (a resume)', async () => {
  const { keepBaseUnbroken } = await import('../../src/base/build')
  const { BASE_POI } = await import('../../src/base/pois')
  const { WorldMemory } = await import('../../src/core/memory')
  const { fakeBot } = await import('../reflexes/fakeBot')
  const { Vec3 } = await import('vec3')
  const m = new WorldMemory()
  m.setBase({ x: 0, y: 60, z: 0 }, 'overworld')
  m.addPoi(BASE_POI.bounds, { x: -5, y: 55, z: -5 }, 'overworld', '5,65,5')
  m.addPoi(BASE_POI.bed, { x: 1, y: 60, z: 1 }, 'overworld')
  m.addPoi(BASE_POI.table, { x: -1, y: 60, z: 1 }, 'overworld')
  m.rememberChest({ x: 2, y: 60, z: -2 }, {}, 'overworld')
  const bot = fakeBot({ world: (p: any) => (p.x === 1 && p.y === 60 && (p.z === 1 || p.z === 2)) ? 'white_bed' : p.y < 60 ? 'stone' : 'air' })
  bot.pathfinder = { defaultMoveSettings: { exclusionAreasBreak: [] }, setMoveOptions (s: any) { this.defaultMoveSettings = s } }
  keepBaseUnbroken(bot, m)
  const areas = bot.pathfinder.defaultMoveSettings.exclusionAreasBreak
  const cost = (x: number, y: number, z: number): number => areas.reduce((n: number, f: any) => n + f({ position: new Vec3(x, y, z) }), 0)
  assert.ok(cost(1, 60, 1) >= 1e9, 'the bed\'s foot')
  assert.ok(cost(1, 60, 2) >= 1e9, 'its head')
  assert.equal(cost(0, 60, 1), 0, 'the air by it')
  assert.ok(cost(-1, 60, 1) >= 1e9, 'the table')
  assert.ok(cost(2, 60, -2) >= 1e9, 'a chest')
  assert.equal(cost(3, 59, 3), 0)
})

test('protectBase: the shell and the blueprint\'s own blocks in the room kept from the pathfinder\'s digs; the ground left in a doorway not (ls-1.21.11: shut in by its own base)', async () => {
  const { protectBase, HOUSE_BLUEPRINT } = await import('../../src/base/build')
  const { generateBlueprint } = await import('../../src/base/blueprint')
  const { fakeBot } = await import('../reflexes/fakeBot')
  const { Vec3 } = await import('vec3')
  // ls-1.21.11's house at (-8, 74, 120): its outer door at (-3, 74, 117), the ground in its upper cell
  const bp = generateBlueprint({ ...HOUSE_BLUEPRINT, origin: { x: -8, y: 74, z: 120 } })
  const outer = bp.entrance.outerDoor
  assert.deepEqual(outer, { x: -3, y: 74, z: 117 })
  const chest = bp.storage[0]
  const table = bp.placements.find(p => p.block === 'crafting_table')!.pos
  const at = (p: { x: number, y: number, z: number }): string => `${p.x},${p.y},${p.z}`
  const world = new Map<string, string>([[at(chest), 'chest'], [at(table), 'crafting_table'], [at({ ...outer, y: outer.y + 1 }), 'dirt']])
  const bot = fakeBot({ world: (p: any) => world.get(at(p)) ?? 'air' })
  bot.pathfinder = { defaultMoveSettings: { exclusionAreasBreak: [], exclusionAreasPlace: [] }, setMoveOptions (s: any) { this.defaultMoveSettings = s } }
  protectBase(bot, bp)
  const areas = bot.pathfinder.defaultMoveSettings.exclusionAreasBreak
  const cost = (p: { x: number, y: number, z: number }): number => areas.reduce((n: number, f: any) => n + f({ position: new Vec3(p.x, p.y, p.z) }), 0)
  assert.ok(cost({ x: outer.x - 1, y: outer.y, z: outer.z }) >= 1e9, 'the shell by the door')
  assert.ok(cost({ x: bp.bounds.min.x, y: bp.bounds.min.y, z: bp.bounds.min.z }) >= 1e9, 'the shell\'s corner')
  assert.ok(cost(chest) >= 1e9, 'a chest')
  assert.ok(cost(table) >= 1e9, 'the table')
  assert.equal(cost({ ...outer, y: outer.y + 1 }), 0, 'the dirt in the doorway')
  assert.equal(cost({ x: outer.x, y: outer.y - 5, z: outer.z - 5 }), 0, 'outside the box')
  // the room's cells are still not built in
  const place = bot.pathfinder.defaultMoveSettings.exclusionAreasPlace
  assert.ok(place.reduce((n: number, f: any) => n + f({ position: new Vec3(outer.x, outer.y, outer.z) }), 0) >= 1e9)
})
