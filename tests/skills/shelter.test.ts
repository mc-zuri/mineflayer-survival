import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import {
  armorPoints, celestialAngle, defaultDigCost, findShelterSpot, isBrightOutside, isEnclosed, leaveAtDay, monstersPreventingRest, nightPlan, sealItem, shelterAt, skyDarken
} from '../../src/skills/shelter'
import type { BlockLookup } from '../../src/skills/placement'
import { entity, fakeBot, item } from '../reflexes/fakeBot'

const SOLID = new Set(['stone', 'dirt', 'grass_block', 'sand', 'oak_leaves', 'cobblestone', 'oak_log'])

/** a world from a function of the floored position to a block name */
function world (fn: (p: Vec3) => string): BlockLookup {
  return (pos) => {
    const name = fn(pos.floored())
    return { name, boundingBox: SOLID.has(name) ? 'block' : 'empty' }
  }
}

/** grass at y 63, dirt to 60, stone under; the surface cells at y 64 */
const plains = (p: Vec3): string => p.y >= 64 ? 'air' : p.y === 63 ? 'grass_block' : p.y >= 60 ? 'dirt' : 'stone'

test('findShelterSpot: straight down where the bot stands on plain ground, three blocks of dirt to dig', () => {
  const spot = findShelterSpot(world(plains), new Vec3(0.5, 64, 0.5))
  assert.ok(spot != null)
  assert.deepStrictEqual(spot.surface, new Vec3(0, 64, 0))
  assert.deepStrictEqual(spot.seal, new Vec3(0, 63, 0))
  assert.deepStrictEqual(spot.feet, new Vec3(0, 61, 0))
  assert.strictEqual(spot.cost, 3)
})

test('findShelterSpot: never next to water or lava, over a cave, or into stone without a pickaxe', () => {
  // water beside the column under the bot: the next column over is taken
  const wet = (p: Vec3): string => p.x === 1 && p.z === 0 && p.y === 62 ? 'water' : plains(p)
  const spot = findShelterSpot(world(wet), new Vec3(0.5, 64, 0.5))
  assert.ok(spot != null)
  for (const cell of [spot.seal, spot.seal.offset(0, -1, 0), spot.feet]) {
    for (const side of [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]) assert.notStrictEqual(wet(cell.plus(side)), 'water')
  }
  // a cave under the column: the hole would open into it
  const cave = (p: Vec3): string => p.y === 60 && Math.abs(p.x) <= 20 && Math.abs(p.z) <= 20 ? 'cave_air' : plains(p)
  assert.strictEqual(findShelterSpot(world(cave), new Vec3(0.5, 64, 0.5)), null)
  // bare stone: only with a pickaxe
  const rock = (p: Vec3): string => p.y >= 64 ? 'air' : 'stone'
  assert.strictEqual(findShelterSpot(world(rock), new Vec3(0.5, 64, 0.5)), null)
  const dug = findShelterSpot(world(rock), new Vec3(0.5, 64, 0.5), { digCost: defaultDigCost(true) })
  assert.strictEqual(dug?.cost, 12)
})

test('findShelterSpot: not from a tree top (leaves aren\'t ground), and the soft column beats a nearer stone one', () => {
  const tree = (p: Vec3): string => (p.x === 0 && p.z === 0 && p.y >= 64 && p.y < 68) ? 'oak_log' : (p.y === 68 && Math.abs(p.x) <= 1 && Math.abs(p.z) <= 1) ? 'oak_leaves' : plains(p)
  const spot = findShelterSpot(world(tree), new Vec3(0.5, 69, 0.5), { dy: 6 })
  assert.ok(spot != null)
  assert.strictEqual(spot.surface.y, 64)
  const patch = (p: Vec3): string => p.y < 64 && p.y >= 60 && !(p.x >= 3 && p.x <= 5 && p.z >= -1 && p.z <= 1) ? 'stone' : plains(p)
  const soft = findShelterSpot(world(patch), new Vec3(0.5, 64, 0.5), { digCost: defaultDigCost(true) })
  assert.deepStrictEqual(soft?.surface, new Vec3(3, 64, 0))
  assert.strictEqual(soft?.cost, 3)
})

test('shelterAt: a column half dug (the bot cut off before the seal) is still the shelter, at no cost for the open cells', () => {
  const half = (p: Vec3): string => p.x === 0 && p.z === 0 && (p.y === 63 || p.y === 62) ? 'air' : plains(p)
  const spot = shelterAt(world(half), new Vec3(0, 64, 0), defaultDigCost(false), true)
  assert.strictEqual(shelterAt(world(half), new Vec3(0, 64, 0), defaultDigCost(false)), null)
  assert.strictEqual(spot?.cost, 1)
})

test('isEnclosed: the body\'s two cells open (a torch is fine), solid over, under and all round', () => {
  const hole = (p: Vec3): string => p.x === 0 && p.z === 0 && (p.y === 61 || p.y === 62) ? (p.y === 62 ? 'wall_torch' : 'air') : plains(p)
  assert.strictEqual(isEnclosed(world(hole), new Vec3(0.5, 61, 0.5)), true)
  const open = (p: Vec3): string => p.x === 0 && p.z === 0 && p.y >= 61 ? 'air' : plains(p)
  assert.strictEqual(isEnclosed(world(open), new Vec3(0.5, 61, 0.5)), false)
  assert.strictEqual(isEnclosed(world(plains), new Vec3(0.5, 64, 0.5)), false)
})

test('the sky: bright (the undead burn, no sleeping) from about 23460 to 12540, dark between; rain darkens it', () => {
  assert.strictEqual(celestialAngle(6000), 0)
  assert.ok(Math.abs(celestialAngle(18000) - 0.5) < 1e-9)
  assert.strictEqual(isBrightOutside(6000), true)
  assert.strictEqual(isBrightOutside(12000), true)
  assert.strictEqual(isBrightOutside(12600), false)
  assert.strictEqual(isBrightOutside(18000), false)
  assert.strictEqual(isBrightOutside(23400), false)
  assert.strictEqual(isBrightOutside(23500), true)
  assert.strictEqual(skyDarken(18000), 11)
  assert.strictEqual(skyDarken(6000), 0)
  // BedBlock's "you can only sleep at night" is the other side of the same line (canSleepNow: 12541 to 23458)
  let firstDark = -1
  let lastDark = -1
  for (let t = 0; t < 24000; t++) {
    if (!isBrightOutside(t)) { if (firstDark < 0) firstDark = t; lastDark = t }
  }
  assert.ok(Math.abs(firstDark - 12541) <= 2, `dark from ${firstDark}`)
  assert.ok(Math.abs(lastDark - 23458) <= 2, `dark to ${lastDark}`)
  assert.strictEqual(isBrightOutside(11000, 1, 1), false)
})

test('nightPlan: a bed means sleep; armor and a weapon that can fight, fight; else shelter', () => {
  assert.strictEqual(nightPlan(fakeBot({ items: [item('stone_sword')] })), 'shelter')
  assert.strictEqual(nightPlan(fakeBot({ items: [item('stone_sword'), item('red_bed')] })), 'sleep')
  assert.strictEqual(nightPlan(fakeBot({ items: [item('stone_sword')] }), { bedNearby: true }), 'sleep')
  const iron = { head: item('iron_helmet'), torso: item('iron_chestplate'), legs: item('iron_leggings'), feet: item('iron_boots') }
  assert.strictEqual(armorPoints(fakeBot({ armor: iron })), 15)
  assert.strictEqual(nightPlan(fakeBot({ armor: iron, items: [item('iron_sword')] })), 'fight')
  // carried armor counts (the armor reflex puts it on)
  assert.strictEqual(nightPlan(fakeBot({ items: [item('iron_sword'), item('iron_chestplate'), item('iron_leggings')] })), 'fight')
  assert.strictEqual(nightPlan(fakeBot({ armor: iron, items: [item('stone_sword')] })), 'shelter')
  assert.strictEqual(nightPlan(fakeBot({ armor: { torso: item('leather_chestplate') }, items: [item('diamond_sword')] })), 'shelter')
})

test('sealItem: dirt or cobblestone first, never a block that falls or one with a use', () => {
  assert.strictEqual(sealItem(fakeBot({ items: [item('sand', 5), item('cobblestone', 2), item('dirt', 1)] })), 'dirt')
  assert.strictEqual(sealItem(fakeBot({ items: [item('sand', 5), item('gravel', 3), item('crafting_table')] })), null)
  assert.strictEqual(sealItem(fakeBot({ items: [item('oak_planks', 4)] })), 'oak_planks')
})

test('findShelterSpot: a column the bot couldn\'t get to is left out the next time', () => {
  const first = findShelterSpot(world(plains), new Vec3(0.5, 64, 0.5))
  assert.ok(first != null)
  const next = findShelterSpot(world(plains), new Vec3(0.5, 64, 0.5), { exclude: new Set([`${first.surface.x},${first.surface.y},${first.surface.z}`]) })
  assert.ok(next != null)
  assert.notDeepStrictEqual(next.surface, first.surface)
  assert.strictEqual(next.surface.distanceTo(first.surface), 1)
})

test('monstersPreventingRest: Player.startSleepInBed\'s box, 8 across and 5 up or down of the bed; the living ones, nearest first', () => {
  const zombie = (x: number, y: number, z: number, health = 20): any => entity({ name: 'zombie', position: new Vec3(x, y, z), meta: { health } })
  const near = zombie(3.5, 64, 0.5)
  const corner = zombie(8.4, 64, -7.4)
  const bot = fakeBot({ entities: [zombie(9.6, 64, 0.5), zombie(0.5, 70, 0.5), zombie(1.5, 64, 1.5, 0), corner, near, entity({ name: 'cow', position: new Vec3(1.5, 64, 0.5) })] })
  assert.deepStrictEqual(monstersPreventingRest(bot, new Vec3(0, 64, 0)).map(e => e.id), [near.id, corner.id])
})

test('leaveAtDay: out once bright with no hostile within 8 blocks (burning or not), or after 2400 ticks of daylight', () => {
  const zombie = entity({ name: 'zombie', position: new Vec3(2.5, 64, 0.5), meta: { health: 20, shared_flags: 1 } })
  const bot = fakeBot({ entities: [zombie] })
  bot.time = { timeOfDay: 20000 }
  const leave = leaveAtDay(bot)
  assert.strictEqual(leave(), false)
  bot.time.timeOfDay = 23600
  // a zombie burning on the roof still hits
  assert.strictEqual(leave(), false)
  bot.time.timeOfDay = 900
  assert.strictEqual(leave(), false)
  delete bot.entities[zombie.id]
  assert.strictEqual(leave(), true)
  bot.entities[zombie.id] = zombie
  bot.time.timeOfDay = 23600 + 2400 - 24000
  assert.strictEqual(leave(), true)
})
