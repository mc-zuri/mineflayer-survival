import { test } from 'node:test'
import assert from 'node:assert'
import {
  BlockGetter, CHARGED_CREEPER, CREEPER, DEFAULT_SHELL_MATERIAL, DEFAULT_SHELL_THICKNESS, SHELL_MATERIALS, blockRegistry,
  checkStorageSafety, generateBlueprint, minimumShellThickness, posKey
} from '../../src/base'

test('the default blueprint keeps every chest from a creeper and a charged creeper; one layer less does not', () => {
  const results = minimumShellThickness((thickness, material) => {
    const bp = generateBlueprint({ thickness, material })
    return { world: bp.world(), storage: bp.storage, bounds: bp.bounds }
  }, [DEFAULT_SHELL_MATERIAL])
  assert.strictEqual(results[0].thickness, DEFAULT_SHELL_THICKNESS)
  const report = results[0].report!
  assert.strictEqual(report.safe, true)
  assert.deepStrictEqual(report.byThreat.map(b => [b.threat.name, b.unsafe.length]), [['charged creeper', 0], ['creeper', 0]])
  assert.ok(report.candidateCells > 1000, 'explosions all around the shell were tried')
  // the four shell materials share one blast resistance, so the answer holds for all of them
  const registry = blockRegistry()
  assert.deepStrictEqual(SHELL_MATERIALS.map(m => registry.explosionResistance(m)), [6, 6, 6, 6])
})

// one explosion center per cell is enough to show a design unsafe (any explosion found is a real one)
const ONE_SAMPLE = [{ x: 0.5, y: 0, z: 0.5 }]

test('a 1-thick dirt shell is reported unsafe, with the reason', () => {
  const bp = generateBlueprint({ thickness: 1, material: 'dirt' })
  const report = checkStorageSafety(bp.world(), bp.storage, { bounds: bp.bounds, sampleOffsets: ONE_SAMPLE })
  assert.strictEqual(report.safe, false)
  const byThreat = Object.fromEntries(report.byThreat.map(b => [b.threat.name, b.unsafe.length]))
  assert.ok(byThreat.creeper > 0 && byThreat['charged creeper'] > 0)
  const unsafe = report.unsafe.find(u => u.threat === CREEPER)!
  assert.strictEqual(unsafe.block, 'chest')
  assert.ok(unsafe.remaining > 0)
  assert.ok(unsafe.path.some(step => step.block === 'dirt'))
  assert.match(unsafe.reason, /^chest at \(.*\) is destroyed by a creeper \(power 3\) at .*: the ray crosses \d+ dirt.* and reaches it with [\d.]+ intensity left$/)
})

test('a creeper that can walk in reaches every chest: doors removed, or both airlock doors open', () => {
  const bp = generateBlueprint()
  const doors = new Set(bp.placements.filter(p => p.block.endsWith('_door')).map(p => posKey(p.pos.x, p.pos.y, p.pos.z)))
  const built = bp.world()
  const open: BlockGetter = (x, y, z) => doors.has(posKey(x, y, z)) ? null : built(x, y, z)
  const doorless = checkStorageSafety(open, bp.storage, { bounds: bp.bounds, threats: [CREEPER], sampleOffsets: ONE_SAMPLE })
  assert.strictEqual(doorless.safe, false)
  const bothOpen = checkStorageSafety(built, bp.storage, { bounds: bp.bounds, threats: [CHARGED_CREEPER], openDoors: 2, sampleOffsets: ONE_SAMPLE })
  assert.strictEqual(bothOpen.safe, false)
  // with no way in and no air outside (the room sealed in stone), nothing is reachable
  const inStone: BlockGetter = (x, y, z) => { const b = built(x, y, z); return b === undefined ? 'stone' : b }
  const sealed = checkStorageSafety(inStone, bp.storage, { bounds: bp.bounds, seeds: [] })
  assert.strictEqual(sealed.safe, true)
  assert.strictEqual(sealed.candidateCells, 0)
})
