import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { CAVE_CELLS, CaveCells, caveCells, caveReady, caveUnreadiness, dugByBot, type CaveView } from '../../src/skills/caves'
import { fakeBot, item } from '../reflexes/fakeBot'

const SOLID = new Set(['stone', 'deepslate', 'cobblestone', 'dirt', 'oak_planks'])

/** stone up to y 70 (air over it), the cells given their blocks */
function view (cells: Record<string, string>, opts: { lit?: Set<string>, dug?: Set<string> } = {}): CaveView {
  return {
    block: (p: Vec3) => {
      const name = cells[`${p.x},${p.y},${p.z}`] ?? (p.y > 70 ? 'air' : 'stone')
      return { name, boundingBox: SOLID.has(name) ? 'block' : 'empty' }
    },
    light: (p: Vec3) => opts.lit?.has(`${p.x},${p.y},${p.z}`) === true ? 14 : 0,
    dug: (p: Vec3) => opts.dug?.has(`${p.x},${p.y},${p.z}`) === true
  }
}

/** the cells of a box from `a` to `b`, all of `name` */
function box (a: [number, number, number], b: [number, number, number], name = 'air'): Record<string, string> {
  const out: Record<string, string> = {}
  for (let x = a[0]; x <= b[0]; x++) for (let y = a[1]; y <= b[1]; y++) for (let z = a[2]; z <= b[2]; z++) out[`${x},${y},${z}`] = name
  return out
}

/** a dug tunnel's cells: 1 wide, 2 high, along x from x0 to x1 at y and z */
function tunnel (x0: number, x1: number, y = 20, z = 0): Record<string, string> {
  return box([x0, y, z], [x1, y + 1, z])
}

test('a cave (a room of plain air under the rock, the noise caves\') is one, its corner cells too; a tunnel and a staircase are not', () => {
  const cave = box([0, 20, 0], [6, 23, 6])
  const cells = new CaveCells(view(cave))
  assert.equal(cells.isCave(new Vec3(3, 21, 3)), true)
  // (a corner of it: the flood finds the rest within its reach)
  assert.equal(new CaveCells(view(cave)).isCave(new Vec3(0, 20, 0)), true)
  // a long tunnel the bot dug, and a crossing of two
  const t = new CaveCells(view({ ...tunnel(-30, 30), ...box([0, 20, -30], [0, 21, 30]) }))
  assert.equal(t.isCave(new Vec3(10, 20, 0)), false)
  assert.equal(t.isCave(new Vec3(0, 20, 0)), false)
  // a staircase down along x
  const stairs: Record<string, string> = {}
  for (let i = 0; i < 20; i++) Object.assign(stairs, box([i, 40 - i, 0], [i, 42 - i, 0]))
  assert.equal(new CaveCells(view(stairs)).isCave(new Vec3(10, 31, 0)), false)
  // solid rock is no cave
  assert.equal(cells.isCave(new Vec3(20, 20, 20)), false)
})

test('cave_air (the carvers\' caves and ravines, a mineshaft\'s corridor) is a cave\'s however small, and the cells joined to it', () => {
  const cells = new CaveCells(view({ '0,20,0': 'cave_air', '1,20,0': 'air', '2,20,0': 'air' }))
  assert.equal(cells.isCave(new Vec3(0, 20, 0)), true)
  assert.equal(cells.isCave(new Vec3(2, 20, 0)), true)
  // a mineshaft's corridor: rails and cobwebs are open cells
  const shaft = { ...box([0, 20, -1], [20, 22, 1]), '5,20,0': 'rail', '6,21,1': 'cobweb' }
  assert.equal(new CaveCells(view(shaft)).isCave(new Vec3(6, 21, 1)), true)
})

test('under the open sky, under a house\'s roof, lit or dug by the bot: no cave', () => {
  // a pit open to the sky (the column's top under the cells)
  const pit = box([0, 60, 0], [6, 70, 6])
  assert.equal(new CaveCells(view(pit)).isCave(new Vec3(3, 65, 3)), false)
  // a room under a roof 2 over its floor (a house's: the rock's top is the roof, under CAVE_ROOF)
  const house: Record<string, string> = { ...box([0, 71, 0], [6, 72, 6]), ...box([0, 73, 0], [6, 73, 6], 'oak_planks') }
  assert.equal(new CaveCells(view(house)).isCave(new Vec3(3, 71, 3)), false)
  // the same cave lit by torches (no spawning there) or dug out by the bot
  const cave = box([0, 20, 0], [6, 23, 6])
  const all = new Set(Object.keys(cave))
  assert.equal(new CaveCells(view(cave, { lit: all })).isCave(new Vec3(3, 21, 3)), false)
  assert.equal(new CaveCells(view(cave, { dug: all })).isCave(new Vec3(3, 21, 3)), false)
})

test('a tunnel dug into a cave: its own cells are no cave\'s, the cave\'s cells against its end are (beside)', () => {
  const t = tunnel(-10, -1)
  const cave = box([0, 20, -3], [6, 23, 3])
  const cells = new CaveCells(view({ ...t, ...cave }, { dug: new Set(Object.keys(t)) }))
  assert.equal(cells.isCave(new Vec3(-1, 20, 0)), false)
  const end = [new Vec3(-1, 20, 0), new Vec3(-1, 21, 0)]
  assert.deepEqual(cells.beside(end).map(p => p.toArray()), [[0, 20, 0], [0, 21, 0]])
  // a tunnel far from it: nothing beside
  assert.deepEqual(cells.beside([new Vec3(-8, 20, 0), new Vec3(-8, 21, 0)]), [])
})

test('a flood of fewer open cells than CAVE_CELLS (a pocket, a crack) is no cave; forget() lets a change in', () => {
  const pocket = box([0, 20, 0], [2, 21, 2])
  assert.ok(Object.keys(pocket).length < CAVE_CELLS)
  const world: Record<string, string> = { ...pocket }
  const cells = new CaveCells(view(world))
  assert.equal(cells.isCave(new Vec3(1, 20, 1)), false)
  Object.assign(world, box([3, 20, 0], [8, 23, 6]))
  assert.equal(cells.isCave(new Vec3(1, 20, 1)), false)
  cells.forget()
  assert.equal(cells.isCave(new Vec3(1, 20, 1)), true)
})

test('caveReady: four iron pieces worn, two enchanted, an enchanted iron sword, the bar at 18 and 40 points of cooked food', () => {
  const prot = [{ name: 'protection', lvl: 2 }]
  const kit = (over: { armor?: any, items?: any[], food?: number, health?: number } = {}): any => fakeBot({
    armor: over.armor ?? { head: item('iron_helmet', 1, prot), torso: item('iron_chestplate', 1, prot), legs: item('iron_leggings'), feet: item('iron_boots') },
    items: over.items ?? [item('iron_sword', 1, [{ name: 'sharpness', lvl: 1 }]), item('cooked_beef', 5)],
    food: over.food ?? 20,
    health: over.health ?? 20
  })
  assert.equal(caveUnreadiness(kit()), null)
  assert.equal(caveReady(kit()), true)
  // the early game's kit: plain iron, a stone sword
  assert.match(caveUnreadiness(kit({ armor: { head: item('iron_helmet'), torso: item('iron_chestplate'), legs: item('iron_leggings'), feet: item('iron_boots') } })) ?? '', /not enchanted/)
  assert.match(caveUnreadiness(kit({ items: [item('stone_sword', 1, [{ name: 'sharpness', lvl: 1 }]), item('cooked_beef', 5)] })) ?? '', /sword/)
  assert.match(caveUnreadiness(kit({ items: [item('iron_sword'), item('cooked_beef', 5)] })) ?? '', /sword/)
  // a piece missing, or leather
  assert.match(caveUnreadiness(kit({ armor: { head: item('iron_helmet', 1, prot), torso: item('iron_chestplate', 1, prot), legs: item('iron_leggings') } })) ?? '', /armor/)
  assert.match(caveUnreadiness(kit({ armor: { head: item('leather_helmet', 1, prot), torso: item('iron_chestplate', 1, prot), legs: item('iron_leggings'), feet: item('iron_boots') } })) ?? '', /armor/)
  // hungry, raw meat only, hurt
  assert.match(caveUnreadiness(kit({ food: 16 })) ?? '', /food 16/)
  assert.match(caveUnreadiness(kit({ items: [item('iron_sword', 1, [{ name: 'sharpness', lvl: 1 }]), item('beef', 20), item('cooked_beef', 2)] })) ?? '', /16 points/)
  assert.match(caveUnreadiness(kit({ health: 8 })) ?? '', /health/)
  // diamond counts as iron and better
  assert.equal(caveReady(kit({ armor: { head: item('diamond_helmet', 1, prot), torso: item('diamond_chestplate', 1, prot), legs: item('iron_leggings'), feet: item('netherite_boots') } })), true)
})

test('the bot\'s classifier notes the cells it digs as its own and forgets its verdicts as blocks change near it', () => {
  const bot = fakeBot({ position: new Vec3(0.5, 20, 0.5) })
  let cave = true
  bot.blockAt = (p: Vec3) => {
    const open = cave && p.y >= 20 && p.y <= 23 && Math.abs(p.x) <= 4 && Math.abs(p.z) <= 4
    const name = open ? 'air' : p.y > 70 ? 'air' : 'stone'
    return { name, position: p, boundingBox: name === 'air' ? 'empty' : 'block' }
  }
  const cells = caveCells(bot)
  assert.equal(cells.isCave(new Vec3(1, 21, 1)), true)
  bot.emit('diggingCompleted', { position: new Vec3(1, 21, 1) })
  assert.equal(dugByBot(bot, new Vec3(1, 21, 1)), true)
  assert.equal(cells.isCave(new Vec3(1, 21, 1)), false)
  assert.equal(cells.isCave(new Vec3(2, 21, 1)), true)
  // the cave filled in: the verdict goes with the block update by the bot
  cave = false
  bot.emit('blockUpdate', { name: 'air', boundingBox: 'empty', position: new Vec3(2, 21, 1) }, { name: 'stone', boundingBox: 'block', position: new Vec3(2, 21, 1) })
  assert.equal(cells.isCave(new Vec3(2, 21, 1)), false)
})
