import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { facingDir, liquidAround, oreLevel, spiralWaypoints, staircaseStep, tunnelStep, unsafeStep } from '../../src/executor/explore'

const SOLID = new Set(['stone', 'deepslate', 'cobblestone', 'dirt'])
const world = (blocks: Record<string, string>, fill = 'stone') => (pos: Vec3) => {
  const name = blocks[`${pos.x},${pos.y},${pos.z}`] ?? fill
  return { name, boundingBox: SOLID.has(name) ? 'block' : 'empty' }
}

test('ore levels as 1.21.11 places them: iron at 16, diamonds at -58, the deepest of several', () => {
  assert.equal(oreLevel(['iron_ore', 'deepslate_iron_ore']), 16)
  assert.equal(oreLevel(['diamond_ore', 'deepslate_diamond_ore']), -58)
  assert.equal(oreLevel(['iron_ore', 'diamond_ore']), -58)
  assert.equal(oreLevel(['oak_log']), null)
})

test('the spiral goes out leg by leg, each pair of legs a step longer, within the radius', () => {
  const wps = spiralWaypoints({ x: 0, z: 0 }, 10, 30)
  assert.deepEqual(wps.slice(0, 6), [{ x: 10, z: 0 }, { x: 10, z: 10 }, { x: -10, z: 10 }, { x: -10, z: -10 }, { x: 20, z: -10 }, { x: 20, z: 20 }])
  for (const w of wps) assert.ok(Math.max(Math.abs(w.x), Math.abs(w.z)) <= 30)
})

test('a staircase step opens the head room, the walk-through and the new feet a block down; a tunnel step two cells', () => {
  const feet = new Vec3(0, 20, 0)
  const s = staircaseStep(feet, new Vec3(1, 0, 0))
  assert.deepEqual(s.open.map(p => p.toArray()), [[1, 21, 0], [1, 20, 0], [1, 19, 0]])
  assert.deepEqual(s.next.toArray(), [1, 19, 0])
  assert.deepEqual(s.floor.toArray(), [1, 18, 0])
  const t = tunnelStep(feet, new Vec3(0, 0, -1))
  assert.deepEqual(t.open.map(p => p.toArray()), [[0, 20, -1], [0, 21, -1]])
})

test('a step next to lava or water is unsafe, and so is one over lava under the floor', () => {
  const feet = new Vec3(0, 20, 0)
  const step = tunnelStep(feet, new Vec3(1, 0, 0))
  assert.equal(unsafeStep(world({}), step), null)
  assert.match(unsafeStep(world({ '2,21,0': 'lava' }), step) ?? '', /^lava at \(2, 21, 0\)/)
  assert.match(liquidAround(world({ '1,22,0': 'water' }), new Vec3(1, 21, 0)) ?? '', /^water/)
  // lava two under the floor, air between: a dug-out floor drops the bot in
  assert.match(unsafeStep(world({ '1,19,0': 'air', '1,18,0': 'air', '1,17,0': 'lava' }), { open: [], floor: new Vec3(1, 19, 0) }) ?? '', /lava under/)
  // lava under solid stone is fine
  assert.equal(unsafeStep(world({ '1,18,0': 'lava' }), { open: [], floor: new Vec3(1, 19, 0) }), null)
})

test('facingDir snaps mineflayer\'s yaw to a cardinal', () => {
  assert.deepEqual(facingDir(0).toArray(), [0, 0, -1])
  assert.deepEqual(facingDir(Math.PI / 2).toArray(), [-1, 0, 0])
  assert.deepEqual(facingDir(Math.PI).toArray().map(Math.round), [0, 0, 1])
  assert.deepEqual(facingDir(-Math.PI / 2 + 0.2).toArray(), [1, 0, 0])
})

test('openSky: nothing over the cell but trees; GoalSurface ends there and leads up', async () => {
  const { openSky, GoalSurface } = await import('../../src/executor/explore')
  // stone up to y 70, a shaft at x 0 z 0 from 60 up; an oak over (5, 71, 5)
  const lookup = (pos: Vec3) => {
    const shaft = pos.x === 0 && pos.z === 0 && pos.y >= 60
    const name = pos.y > 75 ? 'air' : pos.x === 5 && pos.z === 5 && pos.y === 73 ? 'oak_leaves' : pos.y <= 70 && !shaft ? 'stone' : 'air'
    return { name, boundingBox: name === 'air' ? 'empty' : 'block' }
  }
  assert.equal(openSky(lookup, new Vec3(0, 60, 0)), true)
  assert.equal(openSky(lookup, new Vec3(1, 60, 0)), false)
  assert.equal(openSky(lookup, new Vec3(5, 71, 5)), true)
  const goal = new GoalSurface(lookup)
  assert.equal(goal.isEnd({ x: 3, y: 71, z: 3 }), true)
  assert.equal(goal.isEnd({ x: 3, y: 65, z: 3 }), false)
  // the climb left: up to over the column's top
  assert.equal(goal.distHeuristic({ x: 3, y: 65, z: 3 }), 6)
})

test('blockSubstitutes and mobSubstitutes: another wood, deepslate for stone, another meat animal', async () => {
  const { blockSubstitutes, mobSubstitutes } = await import('../../src/executor/steps')
  assert.ok(blockSubstitutes({ block: 'oak_log', blocks: ['oak_log'] }).includes('birch_log'))
  assert.ok(!blockSubstitutes({ block: 'oak_log', blocks: ['oak_log'] }).includes('oak_log'))
  assert.deepEqual(blockSubstitutes({ block: 'stone', blocks: ['stone'] }), ['deepslate'])
  assert.deepEqual(blockSubstitutes({ block: 'iron_ore', blocks: ['iron_ore', 'deepslate_iron_ore'] }), [])
  assert.deepEqual(mobSubstitutes({ mob: 'cow', item: 'beef' }), ['pig', 'sheep', 'chicken', 'rabbit'])
  assert.deepEqual(mobSubstitutes({ mob: 'blaze', item: 'blaze_rod' }), [])
})
