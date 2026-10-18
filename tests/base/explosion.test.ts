import { test } from 'node:test'
import assert from 'node:assert'
import {
  BlockGetter, EXPLOSION_SOURCES, LegacyRandomSource, RAY_COUNT, calculateExplodedPositions, explode, getSeenPercent,
  itemEntity, playerEntity, shapeGetter, sourceCenter, blockRegistry
} from '../../src/base'

const ground = (material: string): BlockGetter => (_x, y) => y < 0 ? material : null
const key = (p: { x: number, y: number, z: number }): string => `${p.x},${p.y},${p.z}`

test('the ray grid is the 16^3 cube surface: 1352 rays', () => {
  assert.strictEqual(RAY_COUNT, 16 ** 3 - 14 ** 3)
})

test('LegacyRandomSource draws as java.util.Random', () => {
  // new java.util.Random(42).nextFloat()
  assert.strictEqual(new LegacyRandomSource(42).nextFloat(), Math.fround(0.7275637))
})

test('a creeper on open stone ground breaks only the blocks it stands on', () => {
  const stone = ground('stone')
  // centered on a block: every downward ray's first stone sample is in the block below, the second dies
  assert.deepStrictEqual(calculateExplodedPositions(stone, { x: 0.5, y: 0, z: 0.5 }, 3).destroyed, [{ x: 0, y: -1, z: 0 }])
  // on a corner: the four blocks around it
  const corner = calculateExplodedPositions(stone, { x: 0, y: 0, z: 0 }, 3).destroyed.map(key).sort()
  assert.deepStrictEqual(corner, ['-1,-1,-1', '-1,-1,0', '0,-1,-1', '0,-1,0'])
  // anywhere on the block, even at the 1.3 maximum: one layer deep, at most the four touching blocks
  for (let x = 0; x <= 1; x += 0.25) {
    for (let z = 0; z <= 1; z += 0.25) {
      const destroyed = calculateExplodedPositions(stone, { x, y: 0, z }, 3).destroyed
      assert.ok(destroyed.length >= 1 && destroyed.length <= 4)
      assert.ok(destroyed.every(p => p.y === -1))
    }
  }
})

test('a creeper on grass leaves the familiar 5x5, 3 deep crater', () => {
  const destroyed = calculateExplodedPositions(ground('grass_block'), { x: 0.5, y: 0, z: 0.5 }, 3).destroyed
  const xs = destroyed.map(p => p.x)
  const zs = destroyed.map(p => p.z)
  const ys = destroyed.map(p => p.y)
  assert.deepStrictEqual([Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)], [-2, 2, -2, 2])
  assert.deepStrictEqual([Math.min(...ys), Math.max(...ys)], [-3, -1])
  // random draws destroy a subset of the worst case
  const worst = new Set(destroyed.map(key))
  for (const seed of [1, 2, 3, 4, 5]) {
    const seeded = calculateExplodedPositions(ground('grass_block'), { x: 0.5, y: 0, z: 0.5 }, 3, { random: seed }).destroyed
    assert.ok(seeded.every(p => worst.has(key(p))))
    assert.deepStrictEqual(seeded, calculateExplodedPositions(ground('grass_block'), { x: 0.5, y: 0, z: 0.5 }, 3, { random: seed }).destroyed)
  }
})

test('obsidian is never broken, not even by an end crystal at the maximum', () => {
  // a 3x3x3 air pocket in obsidian with the explosion in its middle
  const pocket: BlockGetter = (x, y, z) => Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) <= 1 ? null : 'obsidian'
  for (const source of ['creeper', 'chargedCreeper', 'tnt', 'endCrystal', 'bed'] as const) {
    const { destroyed, blown } = calculateExplodedPositions(pocket, { x: 0.5, y: 0.5, z: 0.5 }, EXPLOSION_SOURCES[source].power)
    assert.deepStrictEqual(destroyed, [], source)
    assert.ok(blown.length > 0)
  }
})

test('a single layer of cobblestone next to a creeper breaks', () => {
  // a 1-thick wall at x = 0 with the creeper pressed against it (its center 0.3 from the face)
  const wall: BlockGetter = (x, y) => y < 0 ? 'stone' : x === 0 ? 'cobblestone' : null
  const destroyed = calculateExplodedPositions(wall, { x: -0.3, y: 0, z: 0.5 }, EXPLOSION_SOURCES.creeper.power).destroyed
  assert.ok(destroyed.some(p => p.x === 0 && p.y === 0 && p.z === 0), 'the wall block in front of it')
  // what's behind the wall survives a plain creeper
  assert.ok(destroyed.every(p => p.x <= 0))
})

test('water stops block damage', () => {
  // a creeper (or TNT) under water on a dirt floor breaks nothing: water's resistance is 100
  const lake: BlockGetter = (_x, y) => y < 0 ? 'dirt' : y < 4 ? 'water' : null
  assert.deepStrictEqual(calculateExplodedPositions(lake, { x: 0.5, y: 0, z: 0.5 }, 3).destroyed, [])
  assert.deepStrictEqual(calculateExplodedPositions(lake, sourceCenter('tnt', { x: 0.5, y: 0, z: 0.5 }), 4).destroyed, [])
  // a single water column between a creeper and a dirt wall shields the wall
  const shielded: BlockGetter = (x, y) => y < 0 ? 'bedrock' : x === 0 ? 'water' : x === 1 ? 'dirt' : null
  const destroyed = calculateExplodedPositions(shielded, { x: -0.3, y: 0, z: 0.5 }, 3).destroyed
  assert.ok(destroyed.every(p => p.x < 1), 'nothing past the water')
  // a waterlogged block counts as water
  const registry = blockRegistry()
  assert.strictEqual(registry.explosionResistance({ name: 'oak_slab', properties: { waterlogged: true } }), 100)
  assert.strictEqual(registry.explosionResistance('oak_slab'), 3)
  assert.strictEqual(registry.explosionResistance('air'), undefined)
  assert.strictEqual(registry.explosionResistance('torch'), 0)
})

test('entity damage: the vanilla maximum of 43 for a creeper and 85 for a charged one', () => {
  const open = ground('stone')
  const at = { x: 0.5, y: 0, z: 0.5 }
  assert.strictEqual(explode(open, at, 3, { entities: [playerEntity(at)] }).entities[0].damage, 43)
  assert.strictEqual(explode(open, at, 6, { entities: [playerEntity(at)] }).entities[0].damage, 85)
  // out of range (more than 2 * radius away) nothing happens
  assert.deepStrictEqual(explode(open, at, 3, { entities: [playerEntity({ x: 7, y: 0, z: 0.5 })] }).entities, [])
})

test('exposure: items in the open are destroyed, items behind a wall take 1 damage and survive', () => {
  // a 2-thick stone wall at x in [2, 4)
  const walled: BlockGetter = (x, y) => y < 0 ? 'stone' : x >= 2 && x < 4 ? 'stone' : null
  const center = { x: 0.5, y: 0, z: 0.5 }
  const near = itemEntity({ x: 1.5, y: 0, z: 0.5 })
  const behind = itemEntity({ x: 4.5, y: 0, z: 0.5 })
  const [a, b] = explode(walled, center, 3, { entities: [near, behind] }).entities
  assert.strictEqual(a.exposure, 1)
  assert.strictEqual(a.destroyed, true)
  assert.strictEqual(b.exposure, 0)
  assert.strictEqual(b.damage, 1)
  assert.strictEqual(b.destroyed, false)
  // getSeenPercent with nothing in the way is 1; half a box under the floor sees less
  const shapes = shapeGetter(walled)
  assert.strictEqual(getSeenPercent(shapes, center, { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }), 1)
  const half = getSeenPercent(shapes, { x: 0.5, y: 0.5, z: 0.5 }, { minX: 0, minY: -0.5, minZ: 0, maxX: 1, maxY: 0.5, maxZ: 1 })
  assert.ok(half > 0 && half < 1)
})
