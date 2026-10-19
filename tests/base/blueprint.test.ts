import { test } from 'node:test'
import assert from 'node:assert'
import {
  BlockGetter, Placement, Vec, blockRegistry, clipBlocks, darkSpawnCells, generateBlueprint, planBuild, posKey, shapeGetter
} from '../../src/base'

const registry = blockRegistry()
const key = (p: Vec): string => posKey(p.x, p.y, p.z)
const NEIGHBOURS = [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]

/** Walks the placements in order: each must have its `against` block, or any neighbour, solid already. */
function assertBuildable (placements: Placement[], solidInWorld: (p: Vec) => boolean): void {
  const placed = new Set<string>()
  let previous: Placement | undefined
  for (const p of placements) {
    assert.notStrictEqual(p.unsupported, true, `${p.block} at ${key(p.pos)} has no support`)
    if (p.autoPlaced === true) {
      assert.ok(previous != null && previous.block === p.block, `${p.block} at ${key(p.pos)} follows its other half`)
    } else {
      const support = p.against != null ? [p.against] : NEIGHBOURS.map(([dx, dy, dz]) => ({ x: p.pos.x + dx, y: p.pos.y + dy, z: p.pos.z + dz }))
      assert.ok(support.some(s => placed.has(key(s)) || solidInWorld(s)), `${p.block} at ${key(p.pos)} has a solid neighbour`)
    }
    if (registry.isFullCube({ name: p.block, stateId: p.stateId })) placed.add(key(p.pos))
    previous = p
  }
}

test('the blueprint: a shell, 36 chests, a crafting table, furnaces, a bed, two doors, torches; nothing overlaps', () => {
  const bp = generateBlueprint({ origin: { x: 100, y: 20, z: -40 } })
  const positions = bp.placements.map(p => key(p.pos))
  assert.strictEqual(new Set(positions).size, positions.length)
  const dug = new Set(bp.dig.map(key))
  const count = (block: string): number => bp.placements.filter(p => p.block === block).length
  assert.strictEqual(bp.storage.length, 36)
  assert.strictEqual(count('chest'), 36)
  assert.strictEqual(count('crafting_table'), 1)
  assert.strictEqual(count('furnace'), 2)
  assert.strictEqual(count('white_bed'), 2)
  assert.strictEqual(count('oak_door'), 4)
  assert.ok(count('wall_torch') >= 1)
  // furniture stands in dug cells, the shell around them
  for (const p of bp.placements) assert.strictEqual(dug.has(key(p.pos)), p.stage === 'furniture', `${p.block} at ${key(p.pos)}`)
  // the stages come in order
  const stages = bp.placements.map(p => p.stage)
  assert.deepStrictEqual([...new Set(stages)], ['floor', 'walls', 'ceiling', 'furniture'])
  // the dig list starts at the outer door and covers the interior
  assert.deepStrictEqual(bp.dig[0], bp.entrance.outerDoor)
  assert.strictEqual(bp.dig.length, new Set(bp.dig.map(key)).size)
  const { min, max } = bp.interior
  assert.deepStrictEqual(min, { x: 100, y: 20, z: -40 })
  assert.strictEqual(bp.dig.filter(c => c.x >= min.x && c.x < max.x && c.y >= min.y && c.y < max.y && c.z >= min.z && c.z < max.z).length, 7 * 3 * 7)
  // the shell is 2 thick under the floor
  const world = bp.world()
  assert.strictEqual((world(min.x + 3, min.y - 1, min.z + 3) as any).name, 'cobblestone')
  assert.strictEqual((world(min.x + 3, min.y - 2, min.z + 3) as any).name, 'cobblestone')
  assert.strictEqual(world(min.x + 3, min.y - 3, min.z + 3), undefined)
})

test('the placement order is buildable on flat ground: every block has a solid neighbour placed before it', () => {
  const bp = generateBlueprint()
  const groundTop = bp.bounds.min.y
  assertBuildable(bp.placements, p => p.y < groundTop)
})

test('planBuild on real sites: solid stone keeps the shell; a cave gets filled from what holds it up', () => {
  const bp = generateBlueprint({ origin: { x: 0, y: 30, z: 0 } })
  const furniture = bp.placements.filter(p => p.stage === 'furniture').length
  // dug into solid stone: only furniture to place, every carved cell to dig
  const stone: BlockGetter = () => 'stone'
  const inStone = planBuild(bp, stone)
  assert.strictEqual(inStone.placements.length, furniture)
  assert.strictEqual(inStone.dig.length, bp.dig.length)
  // a cave through the north-west corner of the site, and dirt (too weak) in part of the floor
  const cave: BlockGetter = (x, y, z) => {
    if (x < 3 && z < 2 && y >= 27 && y < 36) return null
    if (y === 28 && x >= 3) return 'dirt'
    return 'stone'
  }
  const plan = planBuild(bp, cave)
  const carved = new Set(bp.dig.map(key))
  assert.ok(plan.placements.some(p => p.block === 'cobblestone' && p.pos.y === 28), 'the dirt is replaced')
  assert.ok(plan.placements.some(p => p.block === 'cobblestone' && p.pos.x < 3 && p.pos.z < 2), 'the cave is filled')
  // dirt placements still count as solid until dug: the builder digs a weak block and places right away
  assertBuildable(plan.placements, p => !carved.has(key(p)) && registry.isFullCube(cave(p.x, p.y, p.z)))
})

test('light coverage: no dark floor cell inside, not even at the stricter pre-1.18 level', () => {
  const bp = generateBlueprint()
  const world = bp.world()
  assert.deepStrictEqual(darkSpawnCells(world, bp.airCells, { minLight: 1 }), [])
  assert.deepStrictEqual(darkSpawnCells(world, bp.airCells, { minLight: 8 }), [])
  // without its torches the room is dark
  const torches = new Set(bp.placements.filter(p => p.block === 'wall_torch').map(p => key(p.pos)))
  const unlit: BlockGetter = (x, y, z) => torches.has(posKey(x, y, z)) ? null : world(x, y, z)
  assert.ok(darkSpawnCells(unlit, bp.airCells).length > 0)
})

test('the airlock bends: no straight line from outside into the room, even with both doors open', () => {
  const bp = generateBlueprint()
  const built = bp.world()
  const doors = new Set(bp.placements.filter(p => p.block.endsWith('_door')).map(p => key(p.pos)))
  const open: BlockGetter = (x, y, z) => doors.has(posKey(x, y, z)) ? null : built(x, y, z)
  const shapes = shapeGetter(open)
  const outside = bp.entrance.outside
  const path = bp.entrance.path
  const tunnel = path.slice(0, path.findIndex(p => key(p) === key(bp.entrance.innerDoor)))
  const { min, max } = bp.interior
  let lines = 0
  for (const from of [outside, ...tunnel]) {
    for (let x = min.x; x < max.x; x++) {
      for (let z = min.z; z < max.z; z++) {
        for (const [fx, fz] of [[0.05, 0.05], [0.95, 0.05], [0.05, 0.95], [0.95, 0.95], [0.5, 0.5]]) {
          for (const [tx, tz] of [[0.05, 0.05], [0.95, 0.95], [0.05, 0.95], [0.95, 0.05], [0.5, 0.5]]) {
            lines++
            const a = { x: from.x + fx, y: from.y + 0.5, z: from.z + fz }
            const b = { x: x + tx, y: min.y + 0.5, z: z + tz }
            assert.ok(clipBlocks(shapes, a, b), `${key(from)} sees ${x},${z}`)
          }
        }
      }
    }
  }
  assert.ok(lines > 1000)
  // and the doors are where the path says: the outer one first
  assert.deepStrictEqual(path[0], bp.entrance.outerDoor)
  assert.ok(doors.has(key(bp.entrance.innerDoor)) && doors.has(key(bp.entrance.outerDoor)))
})

test('the house of day 1: the smallest room the furniture fits, one block of shell, a door, a table, a furnace, chests and light', async () => {
  const { HOUSE_BLUEPRINT } = await import('../../src/base/build')
  const bp = generateBlueprint(HOUSE_BLUEPRINT)
  const blocks = bp.placements.map(p => p.block)
  assert.ok(blocks.includes('crafting_table'))
  assert.ok(blocks.includes('furnace'))
  assert.ok(blocks.some(b => b.endsWith('_door')))
  assert.ok(blocks.includes('torch') || blocks.includes('wall_torch'))
  assert.ok(bp.storage.length >= 2)
  // a third of the blocks of the full base's shell
  const { BASE_BLUEPRINT } = await import('../../src/base/build')
  const shell = (b: typeof bp): number => b.placements.filter(p => p.stage !== 'furniture').length
  assert.ok(shell(bp) * 2 < shell(generateBlueprint(BASE_BLUEPRINT)), `${shell(bp)} vs ${shell(generateBlueprint(BASE_BLUEPRINT))}`)
})

test('every chest of the base and the house designs has air (or a chest) over it, so it opens', async () => {
  const { generateBlueprint } = await import('../../src/base/blueprint')
  const { BASE_BLUEPRINT, HOUSE_BLUEPRINT } = await import('../../src/base/build')
  for (const opts of [BASE_BLUEPRINT, HOUSE_BLUEPRINT, { ...BASE_BLUEPRINT, chestLayers: 2 }]) {
    const bp = generateBlueprint({ ...opts, origin: { x: 0, y: 64, z: 0 } })
    const world = bp.world()
    for (const c of bp.storage) {
      const above = world({ x: c.x, y: c.y + 1, z: c.z })
      assert.ok(above == null || above.name === 'air' || above.name === 'chest', `${JSON.stringify(c)}: ${above?.name ?? '?'} over it`)
    }
  }
})
