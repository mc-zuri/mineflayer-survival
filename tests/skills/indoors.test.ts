import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { doorRefuge, findDoorRefuge, isHandDoor } from '../../src/skills/indoors'
import { hostilesReflex } from '../../src/reflexes/rules'
import { ReflexEngine } from '../../src/reflexes/engine'
import { entity, fakeBot, item } from '../reflexes/fakeBot'
import type { BlockLookup } from '../../src/skills/placement'

const SOLID = new Set(['stone', 'cobblestone', 'oak_planks'])

/**
 * Stone ground (y 63 and under); a hut of planks from x 10 to 14, z -2 to 2, its floor cells at y 64 and 65 inside,
 * its roof at y 66; its door at (10, 64, 0), facing east (its sides x 9 and x 11)
 */
function hut (p: Vec3): string {
  if (p.y < 64) return 'stone'
  const inX = p.x >= 10 && p.x <= 14
  const inZ = p.z >= -2 && p.z <= 2
  if (!inX || !inZ || p.y > 66) return 'air'
  if (p.y === 66) return 'oak_planks'
  if (p.x === 10 && p.z === 0) return 'oak_door'
  if (p.x === 10 || p.x === 14 || p.z === -2 || p.z === 2) return 'oak_planks'
  return 'air'
}

const lookupOf = (world: (p: Vec3) => string): BlockLookup => (pos) => {
  const name = world(pos.floored())
  return { name, boundingBox: SOLID.has(name) ? 'block' : 'empty' }
}

/** a fake bot in the hut's world, the door's lower half's state (facing east, closed) and findBlocks over the box about */
function hutBot (input: Parameters<typeof fakeBot>[0]): any {
  const bot = fakeBot({ ...input, world: hut })
  const blockAt = bot.blockAt
  bot.blockAt = (pos: Vec3) => {
    const b = blockAt(pos)
    if (b.name === 'oak_door') b.getProperties = () => ({ half: b.position.y === 64 ? 'lower' : 'upper', facing: 'east', open: false })
    return b
  }
  bot.findBlocks = () => [new Vec3(10, 64, 0), new Vec3(10, 65, 0)]
  return bot
}

test('isHandDoor: the wooden and copper doors, not the iron one', () => {
  assert.strictEqual(isHandDoor('oak_door'), true)
  assert.strictEqual(isHandDoor('copper_door'), true)
  assert.strictEqual(isHandDoor('iron_door'), false)
  assert.strictEqual(isHandDoor('oak_trapdoor'), false)
})

test('doorRefuge: the roofed side of the door is the inside; no roof on either side, or no side to stand in, none', () => {
  const lookup = lookupOf(hut)
  const refuge = doorRefuge(lookup, new Vec3(10, 64, 0), 'east', new Vec3(0, 64, 0))
  assert.deepStrictEqual(refuge && { inside: refuge.inside.toString(), outside: refuge.outside.toString() }, { inside: new Vec3(11, 64, 0).toString(), outside: new Vec3(9, 64, 0).toString() })
  // the facing across the panel: north / south has no sides to stand in (walls)
  assert.strictEqual(doorRefuge(lookup, new Vec3(10, 64, 0), 'north', new Vec3(0, 64, 0)), null)
  // no roof
  const roofless = lookupOf(p => p.y === 66 ? 'air' : hut(p))
  assert.strictEqual(doorRefuge(roofless, new Vec3(10, 64, 0), 'east', new Vec3(0, 64, 0)), null)
  // both sides roofed (an airlock): the side away from the threats
  const airlock = lookupOf(p => p.y === 66 && p.x === 9 && p.z === 0 ? 'oak_planks' : hut(p))
  assert.strictEqual(doorRefuge(airlock, new Vec3(10, 64, 0), 'east', new Vec3(0, 64, 0))?.inside.toString(), new Vec3(11, 64, 0).toString())
  assert.strictEqual(doorRefuge(airlock, new Vec3(10, 64, 0), 'east', new Vec3(20, 64, 0))?.inside.toString(), new Vec3(9, 64, 0).toString())
})

test('findDoorRefuge: the hut\'s door when the bot gets there before the threats; not when they are between', () => {
  const pillager = (x: number): any => entity({ name: 'pillager', position: new Vec3(x, 64, 0.5) })
  const bot = hutBot({ position: new Vec3(5.5, 64, 0.5) })
  assert.strictEqual(findDoorRefuge(bot, [pillager(-5)])?.inside.toString(), new Vec3(11, 64, 0).toString())
  // a pillager by the door: the bot's not there first
  assert.strictEqual(findDoorRefuge(bot, [pillager(9)]), null)
  assert.strictEqual(findDoorRefuge(bot, []), null)
})

test('hostiles reflex: fled from with a door near, in behind it (retreat indoors); with none, the flee (26.3 full-26.3-m)', () => {
  const check = (bot: any): string | null => {
    const engine = new ReflexEngine(bot, { enabled: false })
    const task = hostilesReflex.check(engine.context())
    engine.stop()
    return task == null ? null : (task.detail ?? task.name)
  }
  const patrol = (): any[] => [-2, -3, -4].map(x => entity({ name: 'pillager', position: new Vec3(x, 64, 0.5) }))
  // bare, a patrol: in behind the hut's door
  assert.strictEqual(check(hutBot({ position: new Vec3(5.5, 64, 0.5), entities: patrol() })), 'retreat indoors')
  // armed and armored, three of them: fought
  const kit = { items: [item('iron_sword')], armor: { head: item('iron_helmet'), torso: item('iron_chestplate'), legs: item('iron_leggings'), feet: item('iron_boots') } }
  assert.strictEqual(check(hutBot({ position: new Vec3(5.5, 64, 0.5), entities: patrol(), ...kit })), 'fight pillager')
  // ... and low on health: in
  assert.strictEqual(check(hutBot({ position: new Vec3(5.5, 64, 0.5), entities: patrol(), health: 5, items: [item('iron_sword')] })), 'retreat indoors')
  // no door about: the flee; turned off: the flee
  const open = fakeBot({ position: new Vec3(5.5, 64, 0.5), entities: patrol() })
  open.findBlocks = () => []
  assert.strictEqual(check(open), 'flee')
  const engine = new ReflexEngine(hutBot({ position: new Vec3(5.5, 64, 0.5), entities: patrol() }), { enabled: false, config: { hostiles: { indoorsDistance: 0 } } })
  assert.strictEqual(hostilesReflex.check(engine.context())?.detail, 'flee')
  engine.stop()
})
