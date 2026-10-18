import { test } from 'node:test'
import assert from 'node:assert'
import { BlockGetter, CHARGED_CREEPER, checkStorageSafety, explosionReach, thicknessTable } from '../../src/base'

test('explosion reach through air: 3.9 blocks for a creeper, 9 for a charged one, to a chest', () => {
  assert.ok(Math.abs(explosionReach(3, 2.5) - 3.9) < 1e-5)
  assert.ok(Math.abs(explosionReach(6, 2.5) - 9) < 1e-5)
})

test('flat-wall thickness per material: cobblestone needs 1 layer against a creeper and 2 against a charged one', () => {
  const table = thicknessTable(['cobblestone', 'obsidian', 'dirt'])
  assert.deepStrictEqual(table.map(t => [t.material, t.thickness.creeper, t.thickness['charged creeper']]), [
    ['cobblestone', 1, 2],
    ['obsidian', 1, 1],
    ['dirt', 2, 5]
  ])
})

test('an unsafe chest comes with the explosion and the ray that break it', () => {
  // one layer of cobblestone at x = 0 with a chest behind it, explosions in front
  const world: BlockGetter = (x, y, z) => x < 0 ? null : x === 1 && y === 0 && z === 0 ? 'chest' : 'cobblestone'
  const report = checkStorageSafety(world, [{ x: 1, y: 0, z: 0 }], { threats: [CHARGED_CREEPER], seeds: [{ x: -1, y: 0, z: 0 }] })
  assert.strictEqual(report.safe, false)
  const [unsafe] = report.unsafe
  assert.ok(unsafe.center.x < 0)
  assert.strictEqual(Math.fround(unsafe.remaining), Math.fround(0.16499996))
  assert.deepStrictEqual(unsafe.path.map(s => s.block), ['air', 'cobblestone', 'cobblestone', 'chest'])
  assert.strictEqual(unsafe.path[unsafe.path.length - 1].remaining, unsafe.remaining)
  assert.strictEqual(unsafe.shellBlocks, 2)
  // the same wall with the chest out of reach is safe
  const far: BlockGetter = (x, y, z) => x < 0 ? null : x === 9 && y === 0 && z === 0 ? 'chest' : x === 0 ? 'cobblestone' : null
  assert.strictEqual(checkStorageSafety(far, [{ x: 9, y: 0, z: 0 }], { threats: [CHARGED_CREEPER], seeds: [{ x: -1, y: 0, z: 0 }] }).safe, true)
})

