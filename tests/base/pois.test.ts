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
