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

test('buildBase: a death on the way to the site ends the build (DIED), no digging or placing tried after it (ls-1.21.11 t32393)', async () => {
  const { buildBase, HOUSE_BLUEPRINT } = await import('../../src/base/build')
  const { TaskError } = await import('../../src/core/errors')
  const { fakeBot } = await import('../reflexes/fakeBot')
  const bot = fakeBot({ world: (p: any) => p.y < 76 ? 'stone' : 'air' })
  bot.pathfinder = { defaultMoveSettings: { exclusionAreasBreak: [], exclusionAreasPlace: [] }, setMoveOptions (s: any) { this.defaultMoveSettings = s } }
  const tasks: string[] = []
  const executor: any = {
    memory: new WorldMemory(),
    log: () => {},
    obtain: async () => ({ plans: 0, steps: 0 }),
    task: async (name: string) => {
      tasks.push(name)
      if (name === 'to the base site') throw new TaskError('DIED', 'the bot died')
      return false
    }
  }
  await assert.rejects(buildBase(bot, { blueprint: HOUSE_BLUEPRINT, origin: { x: -8, y: 74, z: 120 }, executor, gather: false }), (err: unknown) => TaskError.is(err, 'DIED'))
  assert.deepEqual(tasks, ['to the base site'])
  assert.equal(executor.memory.base, null, 'no base recorded')
})

test('inTheWay: the room\'s and the airlock\'s cells holding what the blueprint doesn\'t put there; buildBase digs them out once the blocks are placed, the doorway open with no door hung (ls-1.21.11)', async () => {
  const { buildBase, inTheWay, HOUSE_BLUEPRINT } = await import('../../src/base/build')
  const { TaskError } = await import('../../src/core/errors')
  const { fakeBot } = await import('../reflexes/fakeBot')
  const origin = { x: -8, y: 74, z: 120 }
  const bp = generateBlueprint({ ...HOUSE_BLUEPRINT, origin })
  const outer = bp.entrance.outerDoor
  const doorTop = { ...outer, y: outer.y + 1 }
  const key = (p: { x: number, y: number, z: number }): string => `${p.x},${p.y},${p.z}`
  // built but for the doors, the ground left in the outer doorway's upper cell
  const built = bp.world((x, y, z) => y <= 76 ? 'stone' : null)
  const world = (x: number, y: number, z: number): any => {
    if (key({ x, y, z }) === key(doorTop)) return 'dirt'
    const b = built(x, y, z)
    return b != null && typeof b !== 'string' && b.name.endsWith('_door') ? null : b
  }
  assert.deepEqual(inTheWay(bp, world), [doorTop])
  assert.deepEqual(inTheWay(bp, built), [], 'all built: nothing in the way')

  // the build: the digging fails at the doorway's top (the bot elsewhere), no door to hang
  const cells = new Map<string, string>([[key(doorTop), 'dirt']])
  for (const c of bp.dig) if (key(c) !== key(doorTop)) cells.set(key(c), 'stone')
  const bot = fakeBot({ world: (p: any) => cells.get(key(p)) ?? (p.y <= 76 ? 'stone' : 'air') })
  bot.pathfinder = { defaultMoveSettings: { exclusionAreasBreak: [], exclusionAreasPlace: [] }, setMoveOptions (s: any) { this.defaultMoveSettings = s } }
  const tasks: string[] = []
  let triedTop = 0
  const executor: any = {
    memory: new WorldMemory(),
    log: () => {},
    obtain: async () => ({ plans: 0, steps: 0 }),
    storeAtBase: async () => {},
    task: async (name: string) => {
      tasks.push(name)
      const dig = /^dig \((-?\d+), (-?\d+), (-?\d+)\)$/.exec(name)
      if (dig != null) {
        const at = `${dig[1]},${dig[2]},${dig[3]}`
        if (at === key(doorTop) && triedTop++ === 0) throw new TaskError('NO_PATH', 'no path to the goal')
        cells.set(at, 'air')
        return undefined
      }
      const place = /^place (\S+) (\S+)$/.exec(name)
      if (place != null) {
        if (place[1].endsWith('_door')) throw new TaskError('MISSING_ITEMS', `no ${place[1]} in the inventory`)
        cells.set(place[2], place[1])
        return true
      }
      return undefined
    }
  }
  const res = await buildBase(bot, { blueprint: HOUSE_BLUEPRINT, origin, executor, gather: false, chests: 2 })
  assert.equal(cells.get(key(doorTop)), 'air', 'the doorway dug out')
  assert.equal(tasks.filter(t => t === `dig (${outer.x}, ${outer.y + 1}, ${outer.z})`).length, 2, 'tried in the digging, then after the placing')
  assert.ok(res.missing.some(p => p.block.endsWith('_door')))
  assert.match(executor.memory.getPois('base_build')[0].note, /^\d+\/\d+\/1\/2$/, 'the two doors noted missing')
})

test('buildBase: the materials got without the bed, the bed only when its wool is near (bedIfNear: a plan within BED_NOW_TICKS, the unseen sheep and spiders dearer); else the base built without it (f3-26.3: the base\'s sheep explored for from t7458 to t28925, then spiders, built at t58427)', async () => {
  const { buildBase, bedIfNear, BED_NOW_TICKS, BED_UNSEEN_FACTOR, HOUSE_BLUEPRINT } = await import('../../src/base/build')
  const { TaskError } = await import('../../src/core/errors')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const make = (cost: number, ok = true, items: any[] = []): { bot: any, executor: any, obtained: any[][], planned: any[], lines: string[] } => {
    const bot = fakeBot({ world: (p: any) => p.y < 76 ? 'stone' : 'air', items })
    bot.pathfinder = { defaultMoveSettings: { exclusionAreasBreak: [], exclusionAreasPlace: [] }, setMoveOptions (s: any) { this.defaultMoveSettings = s } }
    const obtained: any[][] = []
    const planned: any[] = []
    const lines: string[] = []
    const executor: any = {
      memory: new WorldMemory(),
      log: () => {},
      plan: (requests: any[], _inv: unknown, opts: any) => { planned.push({ requests, opts }); return { ok, cost, steps: [] } },
      obtain: async (requests: any[]) => { obtained.push(requests.map(r => String(r.item).split(',')[0])); return { plans: 1, steps: 1 } },
      // (the build stops on the way to the site: only the materials matter here)
      task: async (name: string) => { if (name === 'to the base site') throw new TaskError('DIED', 'the bot died'); return false }
    }
    return { bot, executor, obtained, planned, lines }
  }
  // no sheep near: the materials, no bed asked for
  const far = make(BED_NOW_TICKS + 1)
  await assert.rejects(buildBase(far.bot, { blueprint: HOUSE_BLUEPRINT, origin: { x: -8, y: 74, z: 120 }, executor: far.executor, log: l => far.lines.push(l) }), (err: unknown) => TaskError.is(err, 'DIED'))
  assert.equal(far.obtained.length, 1)
  assert.ok(!far.obtained[0].some(n => n.endsWith('_bed')), far.obtained[0].join(', '))
  assert.ok(far.obtained[0].includes('chest'))
  assert.equal(far.planned.length, 1)
  assert.equal(far.planned[0].opts.unseenFactor, BED_UNSEEN_FACTOR)
  assert.ok(far.lines.some(l => l.startsWith(`no bed for now (${BED_NOW_TICKS + 1} ticks, over ${BED_NOW_TICKS})`)), far.lines.join('\n'))
  // a sheep in sight: the bed got too
  const near = make(600)
  await assert.rejects(buildBase(near.bot, { blueprint: HOUSE_BLUEPRINT, origin: { x: -8, y: 74, z: 120 }, executor: near.executor, log: l => near.lines.push(l) }))
  assert.equal(near.obtained.length, 2)
  assert.equal(near.obtained[1][0], 'white_bed')
  // a bed held: nothing planned for it; no plan: none
  const held = make(600, true, [item('red_bed', 1)])
  assert.equal(await bedIfNear(held.bot, held.executor, undefined, l => held.lines.push(l)), true)
  assert.equal(held.planned.length, 0)
  const none = make(0, false)
  assert.equal(await bedIfNear(none.bot, none.executor, undefined, l => none.lines.push(l)), false)
  assert.equal(none.obtained.length, 0)
})
