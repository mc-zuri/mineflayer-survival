import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { baseDoor, chooseRefuge, refugeSituation, PILLAR_SAFE_FROM, type RefugeSituation } from '../../src/skills/refuge'
import { fleeHeading } from '../../src/skills/steer'
import { entity, fakeBot, item } from '../reflexes/fakeBot'
import type { BlockLookup } from '../../src/skills/placement'

const situation = (s: Partial<RefugeSituation> = {}): RefugeSituation => ({
  night: true, threats: [], armed: false, sheltered: false, base: null, bed: false, pillarBlocks: 0, dirtNear: false, hole: false, failed: new Set(), ...s
})
const mob = (distance: number, name = 'zombie'): { name: string, distance: number } => ({ name, distance })

test('chooseRefuge: nothing to get safe from armed, sheltered, or by day with nothing about; at night with no refuge, nothing', () => {
  assert.strictEqual(chooseRefuge(situation({ armed: true, threats: [mob(2)] })), null)
  assert.strictEqual(chooseRefuge(situation({ sheltered: true, threats: [mob(2)] })), null)
  assert.strictEqual(chooseRefuge(situation({ night: false, hole: true, dirtNear: true })), null)
  assert.strictEqual(chooseRefuge(situation()), null)
})

test('chooseRefuge (full-1.21.11-fresh-m: respawned bare by the base at night, a zombie 1.6 off): a run from it; then up a pillar of punched dirt, a hole, or in behind the base\'s door got to first', () => {
  // the zombie by the bot, the door 8 off: in behind it (the bot's sprint gets there first)
  assert.strictEqual(chooseRefuge(situation({ threats: [mob(1.6)], base: { distance: 8, threatDistance: 7 }, dirtNear: true, hole: true })), 'base')
  // the zombie by the door, between: not the base, no time to punch dirt or dig
  const there = situation({ threats: [mob(1.6)], base: { distance: 8, threatDistance: 3 }, dirtNear: true, hole: true })
  assert.strictEqual(chooseRefuge(there), 'flee')
  // run off 18: the pillar of punched dirt, the hole without dirt to punch, nothing to do with neither
  const away = { threats: [mob(18)], hole: true }
  assert.strictEqual(chooseRefuge(situation({ ...away, dirtNear: true })), 'pillar')
  assert.strictEqual(chooseRefuge(situation(away)), 'hole')
  assert.strictEqual(chooseRefuge(situation({ ...away, hole: false })), 'flee')
  // the base's door got to first (the bot's sprint against the zombie's walk): in behind it, ahead of all else
  assert.strictEqual(chooseRefuge(situation({ threats: [mob(3)], base: { distance: 4, threatDistance: 9 }, pillarBlocks: 64 })), 'base')
  assert.strictEqual(chooseRefuge(situation({ threats: [mob(3)], base: { distance: 4, threatDistance: 3 }, pillarBlocks: 64 })), 'pillar')
  assert.strictEqual(chooseRefuge(situation({ base: { distance: 30, threatDistance: Infinity }, hole: true })), 'base')
  // by the door already: in, whatever's about
  assert.strictEqual(chooseRefuge(situation({ threats: [mob(1)], base: { distance: 1.5, threatDistance: 1 } })), 'base')
  // the base failed (no way in): the next
  assert.strictEqual(chooseRefuge(situation({ threats: [mob(12)], base: { distance: 4, threatDistance: 12 }, hole: true, failed: new Set(['base']) })), 'hole')
})

test('chooseRefuge: the bed at night with nothing about, not with a zombie by; a pillar only from the melee mobs it is out of reach of, by day only for one near', () => {
  assert.strictEqual(chooseRefuge(situation({ bed: true, hole: true })), 'sleep')
  assert.strictEqual(chooseRefuge(situation({ bed: true, hole: true, threats: [mob(12)] })), 'hole')
  assert.strictEqual(chooseRefuge(situation({ bed: true, hole: true, failed: new Set(['sleep']) })), 'hole')
  // the blocks at hand: a pillar with a zombie 3 off, not 1 off (it hits as the bot climbs)
  assert.strictEqual(chooseRefuge(situation({ threats: [mob(3)], pillarBlocks: 3 })), 'pillar')
  assert.strictEqual(chooseRefuge(situation({ threats: [mob(1)], pillarBlocks: 3 })), 'flee')
  assert.strictEqual(chooseRefuge(situation({ threats: [mob(3)], pillarBlocks: 2 })), 'flee')
  // a skeleton shoots, a spider climbs, a creeper blows it up: the hole (with the time to dig it), else the run
  for (const name of ['skeleton', 'spider', 'creeper']) {
    assert.strictEqual(PILLAR_SAFE_FROM.has(name), false, name)
    assert.strictEqual(chooseRefuge(situation({ threats: [mob(3), mob(10, name)], pillarBlocks: 64, hole: true })), 'flee', name)
    assert.strictEqual(chooseRefuge(situation({ threats: [mob(10, name)], pillarBlocks: 64, hole: true })), 'hole', name)
  }
  // by day: a pillar for a zombie 5 off (in a tree's shade), a run from one 12 off; never a hole (the night's)
  assert.strictEqual(chooseRefuge(situation({ night: false, threats: [mob(5)], pillarBlocks: 3, hole: true })), 'pillar')
  assert.strictEqual(chooseRefuge(situation({ night: false, threats: [mob(12)], pillarBlocks: 3, hole: true })), 'flee')
  assert.strictEqual(chooseRefuge(situation({ night: false, threats: [mob(12)], failed: new Set(['flee']) })), null)
})

/**
 * A base's box from (0, 63, 0) to (6, 68, 6) (the max corner left out): cobblestone walls 1 thick round a room of
 * x 1..4, z 1..4, its floor at y 64, roof at 66; the ground stone below y 64 all about; the door at (3, 64, 0) in the
 * north wall, facing south (its sides z -1 and z 1)
 */
function boxWorld (p: Vec3): string {
  if (p.y < 64) return 'stone'
  const inX = p.x >= 0 && p.x <= 5
  const inZ = p.z >= 0 && p.z <= 5
  if (!inX || !inZ || p.y > 66) return 'air'
  if (p.y === 66) return 'cobblestone'
  if (p.x === 3 && p.z === 0 && p.y <= 65) return 'oak_door'
  if (p.x === 0 || p.x === 5 || p.z === 0 || p.z === 5) return 'cobblestone'
  return 'air'
}
const SOLID = new Set(['stone', 'cobblestone'])
const lookup: BlockLookup = (pos) => {
  const name = boxWorld(pos.floored())
  return { name, boundingBox: SOLID.has(name) ? 'block' : 'empty' } as any
}
const bounds = { min: { x: 0, y: 63, z: 0 }, max: { x: 6, y: 68, z: 6 } }

test('baseDoor: the door with a side in the base\'s box and one out of it, the box\'s side the inside; an inner door (both sides in) or one with no side to stand in, none', () => {
  const door = baseDoor(lookup, [{ pos: new Vec3(3, 64, 0), facing: 'south' }], { bounds, entrance: { x: 3, y: 64, z: -1 } })
  assert.deepStrictEqual(door && [door.door, door.inside, door.outside].map(v => v.toString()), [new Vec3(3, 64, 0), new Vec3(3, 64, 1), new Vec3(3, 64, -1)].map(v => v.toString()))
  // facing across the panel: its sides are the wall's cells
  assert.strictEqual(baseDoor(lookup, [{ pos: new Vec3(3, 64, 0), facing: 'east' }], { bounds, entrance: null }), null)
  // a door inside the room, both its sides in the box (the airlock's inner one)
  assert.strictEqual(baseDoor(lookup, [{ pos: new Vec3(2, 64, 2), facing: 'south' }], { bounds, entrance: null }), null)
})

test('refugeSituation: the hostiles within 16 (not the neutral ones), the night, the gear, a hole in soft ground; and the choice from it', () => {
  const zombie = entity({ name: 'zombie', position: new Vec3(3.5, 64, 0.5) })
  const enderman = entity({ name: 'enderman', position: new Vec3(-4.5, 64, 0.5) })
  const far = entity({ name: 'skeleton', position: new Vec3(30.5, 64, 0.5) })
  const dirt = (p: Vec3): string => p.y < 60 ? 'stone' : p.y < 64 ? 'dirt' : 'air'
  const bot = fakeBot({ entities: [zombie, enderman, far], world: dirt })
  bot.time = { timeOfDay: 18000 }
  bot.game.dimension = 'overworld'
  const s = refugeSituation(bot, { base: null, failed: new Set() })
  assert.strictEqual(s.night, true)
  assert.deepStrictEqual(s.threats.map(t => t.name), ['zombie'])
  assert.strictEqual(s.armed, false)
  assert.strictEqual(s.hole, true)
  // the zombie 3 off: run (no time to dig)
  assert.strictEqual(chooseRefuge(s), 'flee')
  // by day the same: run; with nothing about, nothing
  bot.time = { timeOfDay: 6000 }
  assert.strictEqual(refugeSituation(bot, { base: null, failed: new Set() }).hole, false)
  assert.strictEqual(chooseRefuge(refugeSituation(bot, { base: null, failed: new Set() })), 'flee')
  delete bot.entities[zombie.id]
  assert.strictEqual(chooseRefuge(refugeSituation(bot, { base: null, failed: new Set() })), null)
  // a sword and a chestplate: armed, the reflexes fight
  const kitted = fakeBot({ entities: [zombie], items: [item('stone_sword')], armor: { torso: item('iron_chestplate') } })
  kitted.time = { timeOfDay: 18000 }
  assert.strictEqual(refugeSituation(kitted, { base: null, failed: new Set() }).armed, true)
  // a sword alone: not
  const sword = fakeBot({ entities: [zombie], items: [item('stone_sword')] })
  sword.time = { timeOfDay: 18000 }
  assert.strictEqual(refugeSituation(sword, { base: null, failed: new Set() }).armed, false)
})

test('fleeHeading leans toward a place to run to (the base), never back at the threat', () => {
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5) })
  // the threat at -x: straight away is +x; the base off at +z leans the way toward it
  const plain = fleeHeading(bot, new Vec3(-3, 64, 0.5)) as number
  const lean = fleeHeading(bot, new Vec3(-3, 64, 0.5), 16, new Vec3(0.5, 64, 40)) as number
  const dir = (h: number): Vec3 => new Vec3(-Math.sin(h), 0, -Math.cos(h))
  assert.ok(dir(plain).z < 0.3, `plain ${plain}`)
  assert.ok(dir(lean).z > 0.3 && dir(lean).x > 0, `leaning ${lean}: ${dir(lean).toString()}`)
  // the base behind the threat: the way's still away from it
  const behind = fleeHeading(bot, new Vec3(-3, 64, 0.5), 16, new Vec3(-40, 64, 0.5)) as number
  assert.ok(dir(behind).x >= -0.25, `toward the threat: ${dir(behind).toString()}`)
})
