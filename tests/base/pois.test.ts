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

test('keepBaseUnbroken: the step before the base\'s door and the ground under it kept from the pathfinder\'s digs (f9-1.21.11: dug out from beside them, the door over a hole)', async () => {
  const { keepBaseUnbroken } = await import('../../src/base/build')
  const { BASE_POI } = await import('../../src/base/pois')
  const { WorldMemory } = await import('../../src/core/memory')
  const { fakeBot } = await import('../reflexes/fakeBot')
  const { Vec3 } = await import('vec3')
  // f9-1.21.11's base: its entrance at (-547, 76, 36), outside its box's north wall
  const m = new WorldMemory()
  m.setBase({ x: -552, y: 76, z: 40 }, 'overworld')
  m.addPoi(BASE_POI.bounds, { x: -553, y: 75, z: 37 }, 'overworld', '-545,79,44')
  m.addPoi(BASE_POI.entrance, { x: -547, y: 76, z: 36 }, 'overworld')
  const bot = fakeBot({ world: (p: any) => p.y < 76 ? 'dirt' : 'air' })
  bot.pathfinder = { defaultMoveSettings: { exclusionAreasBreak: [] }, setMoveOptions (s: any) { this.defaultMoveSettings = s } }
  keepBaseUnbroken(bot, m)
  const areas = bot.pathfinder.defaultMoveSettings.exclusionAreasBreak
  const cost = (x: number, y: number, z: number): number => areas.reduce((n: number, f: any) => n + f({ position: new Vec3(x, y, z) }), 0)
  assert.ok(cost(-547, 75, 36) >= 1e9, 'the step')
  assert.ok(cost(-547, 74, 36) >= 1e9, 'the ground under it')
  assert.equal(cost(-546, 75, 36), 0, 'the ground beside it')
  assert.equal(cost(-547, 76, 36), 0, 'the entrance\'s cell')
})

for (const version of ['1.21.11', '26.3']) {
  test(`mendBaseStep: the step before the base's door put back with a block of the bag's when it's gone and the bot is by it; not when it's there, the bot far, or the bag has none (${version})`, async () => {
    const { mendBaseStep, STEP_MEND_RANGE } = await import('../../src/skills/refuge')
    const placeModule = require('../../src/skills/placeBlock')
    const { fakeBot, item } = await import('../reflexes/fakeBot')
    const { Vec3 } = await import('vec3')
    const base: any = { origin: { x: -552, y: 76, z: 40 }, entrance: { x: -547, y: 76, z: 36 }, table: null, furnaces: [], bed: null, chests: [], spareChests: [], bounds: { min: { x: -553, y: 75, z: 37 }, max: { x: -545, y: 79, z: 44 } } }
    let step = 'air'
    const world = (p: any): string => p.x === -547 && p.z === 36 && p.y === 75 ? step : p.x === -547 && p.z === 36 && p.y === 74 ? 'air' : p.y < 75 ? 'dirt' : 'air'
    const placed: string[] = []
    const real = placeModule.placeBlock
    placeModule.placeBlock = async (_b: unknown, args: any) => { placed.push(`${args.item} at ${args.pos.toString()}`); return { pos: args.pos, block: args.item, placed: true } }
    try {
      // f9-1.21.11 at t321633: by the hole, 4 dirt and 2 oak planks carried
      const bot = fakeBot({ position: new Vec3(-545.5, 75, 36.5), items: [item('oak_planks', 2, undefined, version), item('dirt', 4, undefined, version)], world, version })
      assert.equal(await mendBaseStep(bot, base), true)
      assert.deepEqual(placed, ['dirt at (-547, 75, 36)'])
      // planks when there's no scaffolding
      placed.length = 0
      assert.equal(await mendBaseStep(fakeBot({ position: new Vec3(-545.5, 75, 36.5), items: [item('oak_planks', 2, undefined, version)], world, version }), base), true)
      assert.deepEqual(placed, ['oak_planks at (-547, 75, 36)'])
      // none to place, too far, or the step there
      placed.length = 0
      assert.equal(await mendBaseStep(fakeBot({ position: new Vec3(-545.5, 75, 36.5), items: [item('wheat_seeds', 2, undefined, version)], world, version }), base), false)
      assert.equal(await mendBaseStep(fakeBot({ position: new Vec3(-547.5 + STEP_MEND_RANGE + 2, 75, 36.5), items: [item('dirt', 4, undefined, version)], world, version }), base), false)
      step = 'dirt'
      assert.equal(await mendBaseStep(fakeBot({ position: new Vec3(-545.5, 75, 36.5), items: [item('dirt', 4, undefined, version)], world, version }), base), false)
      assert.equal(await mendBaseStep(fakeBot({ position: new Vec3(-545.5, 75, 36.5), items: [item('dirt', 4, undefined, version)], world, version }), { ...base, entrance: null }), false)
      assert.deepEqual(placed, [])
    } finally {
      placeModule.placeBlock = real
    }
  })
}

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

test('baseBuilt: a base with its door missing is not built till its third build, however few of its blocks are missing (ls-1.21.11: 8 of 175 missing, no door)', async () => {
  const { baseBuilt, BASE_POI } = await import('../../src/base/pois')
  const { WorldMemory } = await import('../../src/core/memory')
  const m = new WorldMemory()
  m.setBase({ x: -8, y: 74, z: 120 }, 'overworld')
  m.addPoi(BASE_POI.build, { x: -8, y: 74, z: 120 }, 'overworld', '8/175/1/2')
  assert.equal(baseBuilt(m), false, 'no door: not built')
  m.addPoi(BASE_POI.build, { x: -8, y: 74, z: 120 }, 'overworld', '6/175/2/0')
  assert.equal(baseBuilt(m), true, 'the doors hung')
  m.addPoi(BASE_POI.build, { x: -8, y: 74, z: 120 }, 'overworld', '8/175/3/2')
  assert.equal(baseBuilt(m), true, 'the third build: taken as it is')
  m.addPoi(BASE_POI.build, { x: -8, y: 74, z: 120 }, 'overworld', '8/175/1')
  assert.equal(baseBuilt(m), true, 'a note from before the doors were counted')
})
