import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import {
  armorPoints, celestialAngle, defaultDigCost, findShelterSpot, isBrightOutside, isEnclosed, leaveAtDay, monstersPreventingRest, nightPlan, roomForBed, sealItem,
  shelterAt, skyDarken, undergroundAtWork, rockOverHead, inNarrowPassage, countRest, ticksSinceRest, setTicksSinceRest, shelter, shelterRunning
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

test('undergroundAtWork: 3 blocks of rock over the head and lit, in a dug passage, or 16 down; not a roof, an overhang or a wide dark cave near the surface', () => {
  // a staircase along +x through stone to y 80: the step at x, feet at 75 - x, open to feet + 2
  const stairs = (p: Vec3): string => p.z === 0 && p.x >= 0 && p.x <= 20 && p.y >= 75 - p.x && p.y <= 77 - p.x ? 'air' : p.y < 80 ? 'stone' : 'air'
  assert.strictEqual(rockOverHead(world(stairs), new Vec3(10, 65, 0)), 12)
  assert.strictEqual(inNarrowPassage(world(stairs), new Vec3(10, 65, 0)), true)
  assert.strictEqual(undergroundAtWork(world(stairs), new Vec3(10, 65, 0)), true)
  // its first step: 2 blocks over the head
  assert.strictEqual(undergroundAtWork(world(stairs), new Vec3(0, 75, 0)), false)
  // a 1x2 tunnel along x
  const tunnel = (p: Vec3): string => p.z === 0 && (p.y === 50 || p.y === 51) && Math.abs(p.x) <= 30 ? 'air' : p.y < 64 ? 'stone' : 'air'
  assert.strictEqual(undergroundAtWork(world(tunnel), new Vec3(0, 50, 0)), true)
  // a wide cave 5 under the surface, dark: not; lit (a torch's light), or 16 under: yes
  const cave = (top: number) => (p: Vec3): string => Math.abs(p.x) <= 10 && Math.abs(p.z) <= 10 && p.y >= 60 && p.y <= 70 ? 'air' : p.y < top ? 'stone' : 'air'
  assert.strictEqual(inNarrowPassage(world(cave(75)), new Vec3(0, 60, 0)), false)
  assert.strictEqual(undergroundAtWork(world(cave(75)), new Vec3(0, 60, 0)), false)
  assert.strictEqual(undergroundAtWork(world(cave(87)), new Vec3(0, 60, 0)), true)
  const lit: BlockLookup = (p) => ({ ...world(cave(75))(p) as any, light: p.y === 61 ? 9 : 0 })
  assert.strictEqual(undergroundAtWork(lit, new Vec3(0, 60, 0)), true)
  // under a house's roof or a tree's leaves on the surface: not
  const roof = (p: Vec3): string => p.y < 64 ? 'stone' : p.y === 67 ? 'cobblestone' : p.y >= 68 && p.y <= 72 ? 'oak_leaves' : 'air'
  assert.strictEqual(rockOverHead(world(roof), new Vec3(0, 64, 0)), 1)
  assert.strictEqual(undergroundAtWork(world(roof), new Vec3(0, 64, 0)), false)
})

test('ticksSinceRest: up a tick at a time while awake (Stats.TIME_SINCE_REST), back to 0 on lying down or a death', () => {
  const bot = fakeBot()
  assert.strictEqual(ticksSinceRest(bot), 0)
  countRest(bot)
  countRest(bot)
  for (let i = 0; i < 5; i++) bot.emit('physicsTick')
  assert.strictEqual(ticksSinceRest(bot), 5)
  bot.isSleeping = true
  bot.emit('physicsTick')
  assert.strictEqual(ticksSinceRest(bot), 5)
  bot.emit('sleep')
  assert.strictEqual(ticksSinceRest(bot), 0)
  bot.isSleeping = false
  setTicksSinceRest(bot, 50000)
  bot.emit('physicsTick')
  assert.strictEqual(ticksSinceRest(bot), 50001)
  bot.emit('death')
  assert.strictEqual(ticksSinceRest(bot), 0)
})

test('nightPlan: a bed means sleep; armor and a weapon that can fight, fight; else shelter', () => {
  assert.strictEqual(nightPlan(fakeBot({ items: [item('stone_sword')] })), 'shelter')
  assert.strictEqual(nightPlan(fakeBot({ items: [item('stone_sword'), item('red_bed')] })), 'sleep')
  assert.strictEqual(nightPlan(fakeBot({ items: [item('stone_sword')] }), { bedNearby: true }), 'sleep')
  // 26.3's straw bed sets no spawn and is gone once slept in: not a bed to sleep the night in
  assert.strictEqual(nightPlan(fakeBot({ version: '26.3', items: [item('stone_sword', 1, undefined, '26.3'), item('straw_bed', 1, undefined, '26.3')] })), 'shelter')
  const iron = { head: item('iron_helmet'), torso: item('iron_chestplate'), legs: item('iron_leggings'), feet: item('iron_boots') }
  assert.strictEqual(armorPoints(fakeBot({ armor: iron })), 15)
  assert.strictEqual(nightPlan(fakeBot({ armor: iron, items: [item('iron_sword')] })), 'fight')
  // carried armor counts (the armor reflex puts it on)
  assert.strictEqual(nightPlan(fakeBot({ items: [item('iron_sword'), item('iron_chestplate'), item('iron_leggings')] })), 'fight')
  assert.strictEqual(nightPlan(fakeBot({ armor: iron, items: [item('stone_sword')] })), 'shelter')
  assert.strictEqual(nightPlan(fakeBot({ armor: { torso: item('leather_chestplate') }, items: [item('diamond_sword')] })), 'shelter')
})

test('nightPlan: good gear at low health that does not come back (the food bar under 18, nothing to eat) shelters; with food, or a full bar, it fights (full-26.3-fresh-l: shot at 3 health exploring at midnight)', () => {
  const iron = () => ({ head: item('iron_helmet'), torso: item('iron_chestplate'), legs: item('iron_leggings'), feet: item('iron_boots') })
  assert.strictEqual(nightPlan(fakeBot({ armor: iron(), health: 3, food: 6, items: [item('diamond_sword'), item('wheat', 6)] })), 'shelter')
  assert.strictEqual(nightPlan(fakeBot({ armor: iron(), health: 3, food: 6, items: [item('diamond_sword'), item('cooked_beef', 2)] })), 'fight')
  assert.strictEqual(nightPlan(fakeBot({ armor: iron(), health: 3, food: 18, items: [item('diamond_sword')] })), 'fight')
  assert.strictEqual(nightPlan(fakeBot({ armor: iron(), health: 14, food: 6, items: [item('diamond_sword')] })), 'fight')
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

test('roomForBed: the nearest cell with two free cells in a line beside it, over solid ground', () => {
  // the bot boxed in by logs on three sides and its back; room two blocks off
  const boxed = (p: Vec3): string => {
    if (p.y < 64) return 'grass_block'
    if (p.y > 65) return 'air'
    if (Math.abs(p.x) <= 1 && Math.abs(p.z) <= 1 && !(p.x === 0 && p.z === 0)) return 'oak_log'
    return 'air'
  }
  const room = roomForBed(world(boxed), new Vec3(0.5, 64, 0.5), 6)
  assert.ok(room != null)
  assert.ok(room.distanceTo(new Vec3(0, 64, 0)) >= 2)
  assert.deepStrictEqual(roomForBed(world(plains), new Vec3(0.5, 64, 0.5), 6), new Vec3(0, 64, 0))
})

test('shelter: by day a bot not in a hole digs none (a "wait out the night" task resumed by day dug one 431 times, 26.3)', async () => {
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [item('dirt', 8)], world: plains })
  bot.time = { timeOfDay: 1000 }
  bot.dig = async () => { throw new Error('dug by day') }
  bot.placeBlock = async () => { throw new Error('placed by day') }
  const result = await shelter(bot, { torch: false })
  assert.deepStrictEqual({ dug: result.dug, ticks: result.ticks, left: result.left }, { dug: false, ticks: 0, left: false })
  assert.strictEqual(shelterRunning(bot), false)
})

test('shelterRunning: true while a shelter() runs, false once it is done', async () => {
  // a sealed hole: the feet at 61, the head at 62, dirt all round, over and under
  const hole = (p: Vec3): string => p.x === 0 && p.z === 0 && (p.y === 61 || p.y === 62) ? 'air' : plains(p)
  const bot = fakeBot({ position: new Vec3(0.5, 61, 0.5), items: [item('dirt', 3)], world: hole })
  bot.time = { timeOfDay: 13000 }
  const during: boolean[] = []
  const ticker = setInterval(() => bot.emit('physicsTick'), 1)
  try {
    await shelter(bot, { torch: false, leave: false, until: () => { during.push(shelterRunning(bot)); return during.length >= 2 } })
  } finally {
    clearInterval(ticker)
  }
  assert.deepStrictEqual(during, [true, true])
  assert.strictEqual(shelterRunning(bot), false)
})

test('findShelterSpot: no column with water within 2 of it, across or under its floor, nor one the caller avoids (a spot drowned at); another a way off (f1-26.3)', () => {
  // an aquifer's water at y 58, under the floor of the columns about x 0 (the floor at 60), x -2 to 2
  const wet = (p: Vec3): string => p.y === 58 && Math.abs(p.x) <= 2 && Math.abs(p.z) <= 2 ? 'water' : plains(p)
  const spot = findShelterSpot(world(wet), new Vec3(0.5, 64, 0.5))
  assert.ok(spot != null)
  assert.ok(Math.max(Math.abs(spot.surface.x), Math.abs(spot.surface.z)) >= 5, `the shelter at ${spot.surface.toString()}`)
  // a column the caller avoids (the drowning reflex's spot, 8 round it)
  const dry = findShelterSpot(world(plains), new Vec3(0.5, 64, 0.5), { avoid: p => Math.max(Math.abs(p.x), Math.abs(p.z)) <= 3 })
  assert.ok(dry != null && Math.max(Math.abs(dry.surface.x), Math.abs(dry.surface.z)) > 3)
})

test('shelter: a bot in the water goes ashore first (toShore), none dug from the water; no shore, NOT_FOUND; a dry bot not (f5-1.21.11: the drowning reflex after each shelter\'s start, 20 ticks apart)', async () => {
  const { shelter } = await import('../../src/skills/shelter')
  const { fakeBot } = await import('../reflexes/fakeBot')
  const explore = require('../../src/executor/explore')
  const real = explore.toShore
  let shore = 0
  explore.toShore = async () => { shore++; return false }
  try {
    // night, a lake: water from y 60 to 63 round the bot
    const wet = fakeBot({ position: new Vec3(0.5, 62, 0.5), world: (p: Vec3) => p.y >= 60 && p.y <= 63 ? 'water' : p.y < 60 ? 'stone' : 'air' })
    wet.time = { timeOfDay: 18000, isDay: false }
    await assert.rejects(shelter(wet), (err: any) => err.reason === 'NOT_FOUND' && /no shore/.test(err.message))
    assert.equal(shore, 1)
    // dry, on a bare floor of nothing to dig: no shore asked
    const dry = fakeBot({ position: new Vec3(0.5, 64, 0.5), world: (p: Vec3) => p.y < 64 ? 'bedrock' : 'air' })
    dry.time = { timeOfDay: 18000, isDay: false }
    await shelter(dry).catch(() => {})
    assert.equal(shore, 1)
  } finally {
    explore.toShore = real
  }
})

test('shelterAt: solid ground SHELTER_GROUND_DEPTH blocks under its floor, none over a cave; digDownHazard: no dig out of the column nor into a cave under it (f6-26.3: a fall from a high place 35 ticks into a night shelter)', async () => {
  const { SHELTER_GROUND_DEPTH, digDownHazard } = await import('../../src/skills/shelter')
  assert.equal(SHELTER_GROUND_DEPTH, 3)
  // dirt from y 50 to 63, air over 63
  const lookup = (p: Vec3): any => {
    const air = p.y >= 64 || p.y < 50
    return { name: air ? 'air' : 'dirt', boundingBox: air ? 'empty' : 'block', position: p }
  }
  const surface = new Vec3(1, 64, 0)
  const dig = defaultDigCost(true)
  assert.ok(shelterAt(lookup, surface, dig) != null)
  // the floor at 64 - SHELTER_DEPTH - 1 = 60, the cave 2 under it: no shelter there
  const lowCave = (p: Vec3): any => {
    const air = p.y >= 64 || (p.y >= 57 && p.y <= 58 && p.x >= 0 && p.x <= 3 && Math.abs(p.z) <= 2)
    return { name: air ? 'air' : 'dirt', boundingBox: air ? 'empty' : 'block', position: p }
  }
  assert.equal(shelterAt(lowCave, surface, dig), null)
  // the dig down: in the column with the ground under, fine; out of it, or the ground gone under the block to dig
  const toY = 61
  assert.equal(digDownHazard(lookup, new Vec3(5, 64, 0), { x: 5, z: 0 }, toY), null)
  assert.match(digDownHazard(lookup, new Vec3(6, 64, 0), { x: 5, z: 0 }, toY) ?? '', /out of the column/)
  const hollow = (p: Vec3): any => {
    const air = p.y >= 64 || (p.x === 5 && p.z === 0 && p.y <= 62)
    return { name: air ? 'air' : 'dirt', boundingBox: air ? 'empty' : 'block', position: p }
  }
  assert.match(digDownHazard(hollow, new Vec3(5, 64, 0), { x: 5, z: 0 }, toY) ?? '', /no ground under/)
})

test('findShelterSpot: no column with a block to dig or a seal the server refuses (the spawn\'s square, a claim); one in the square assumed about the spawn dearer (SHELTER_SQUARE_COST)', async () => {
  const { SHELTER_SQUARE_COST, columnRefused } = await import('../../src/skills/shelter')
  // the digs refused within 16 of the spawn at 0, 0 (max |dx|, |dz|), the places a block past it
  const square = (p: Vec3): boolean => Math.max(Math.abs(p.x), Math.abs(p.z)) <= 16
  const refusals = { dig: square, place: (p: Vec3) => Math.max(Math.abs(p.x), Math.abs(p.z)) <= 17 }
  assert.equal(findShelterSpot(world(plains), new Vec3(0.5, 64, 0.5), { refusals }), null)
  const edge = findShelterSpot(world(plains), new Vec3(12.5, 64, 0.5), { refusals })
  assert.ok(edge != null && edge.surface.x >= 18, `the shelter at ${String(edge?.surface)}`)
  // the seal alone refused: none there either
  assert.equal(shelterAt(world(plains), new Vec3(17, 64, 0), defaultDigCost(false), false, refusals), null)
  assert.ok(shelterAt(world(plains), new Vec3(18, 64, 0), defaultDigCost(false), false, refusals) != null)
  assert.equal(columnRefused({ surface: new Vec3(3, 64, 0), seal: new Vec3(3, 63, 0), feet: new Vec3(3, 61, 0), cost: 3 }, refusals), true)
  assert.equal(columnRefused({ surface: new Vec3(20, 64, 0), seal: new Vec3(20, 63, 0), feet: new Vec3(20, 61, 0), cost: 3 }, refusals), false)
  // the square assumed (its radius unknown): a column out of it a few blocks further first, one in it when none is out
  const surcharge = (s: Vec3): number => square(s) ? SHELTER_SQUARE_COST : 0
  const out = findShelterSpot(world(plains), new Vec3(14.5, 64, 0.5), { refusals: { surcharge } })
  assert.ok(out != null && out.surface.x >= 17, `the shelter at ${String(out?.surface)}`)
  assert.deepStrictEqual(findShelterSpot(world(plains), new Vec3(0.5, 64, 0.5), { refusals: { surcharge } })?.surface, new Vec3(0, 64, 0))
})

/**
 * A night's shelter() on plains about the world spawn at 0, 0 of a server with spawn-protection 16: a world the digs
 * and places change, the bot dropping into each block dug, navigate's walks taken at once; the server's refusal of a
 * dig in the square (`server`: 'silent' puts the block back, 1.21.11; 'message' says so on the action bar too, 26.3)
 */
async function shelterAtSpawn (option: number | 'auto', server: 'silent' | 'message'): Promise<{ result: any, dug: Vec3[], refused: Vec3[], bot: any }> {
  const { EventEmitter } = await import('node:events')
  const { installSpawnProtection, breakRefused } = await import('../../src/skills/spawnProtection')
  const { SkillError } = await import('../../src/skills/errors')
  const actions = require('../../src/core/actions')
  const nav = require('../../src/skills/navigate')
  const changed = new Map<string, string>()
  const name = (p: Vec3): string => changed.get(p.toString()) ?? plains(p)
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [item('dirt', 8)], world: name })
  bot.time = { timeOfDay: 18000 }
  bot.spawnPoint = new Vec3(0, 64, 0)
  bot._client = new EventEmitter()
  bot.equip = async () => {}
  bot.digTime = () => 10
  bot.placeBlock = async (against: any, face: Vec3) => { changed.set(against.position.plus(face).toString(), 'dirt') }
  installSpawnProtection(bot, option)
  const dug: Vec3[] = []
  const refused: Vec3[] = []
  const block = (n: string, pos: Vec3): any => ({ name: n, type: bot.registry.blocksByName[n].id, stateId: bot.registry.blocksByName[n].defaultState, position: pos })
  const realDig = actions.dig
  const realNavigate = nav.navigate
  actions.dig = async (b: any, target: any) => {
    // (core dig's check: none where the server refuses it)
    if (breakRefused(b, target.position)) throw new SkillError('REFUSED', `${String(target.position)} refused: not broken`)
    const pos = target.position as Vec3
    dug.push(pos)
    if (Math.max(Math.abs(pos.x), Math.abs(pos.z)) <= 16) {
      // the client's predicted break, and the server's block back
      refused.push(pos)
      if (server === 'message') bot.emit('message', { translate: 'build.spawn_protection', with: [`${pos.x}, ${pos.y}, ${pos.z}`], toString: () => `${pos.x}, ${pos.y}, ${pos.z} is under spawn protection` })
      bot.targetDigBlock = block(target.name, pos)
      bot.emit('blockUpdate', block(target.name, pos), block('air', pos))
      bot.targetDigBlock = null
      bot.emit('blockUpdate', block('air', pos), block(target.name, pos))
      return
    }
    changed.set(pos.toString(), 'air')
    bot.entity.position = bot.entity.position.offset(0, -1, 0)
  }
  nav.navigate = async (b: any, args: any) => {
    const g = args.goal
    b.entity.position = new Vec3(Math.floor(g.x) + 0.5, g.y ?? 64, Math.floor(g.z) + 0.5)
    return {}
  }
  const ticker = setInterval(() => bot.emit('physicsTick'), 1)
  try {
    const result = await shelter(bot, { torch: false, leave: false, until: () => true })
    return { result, dug, refused, bot }
  } finally {
    clearInterval(ticker)
    actions.dig = realDig
    nav.navigate = realNavigate
  }
}

test('shelter: at the spawn of a server with spawn protection the bot walks out of the square and digs its hole there, none tried in it once the square is known (the bot in the browser stood the night at the spawn and died, its shelter\'s digs refused every 20 ticks)', async () => {
  const { SHELTER_LEAVE_MARGIN } = await import('../../src/skills/shelter')
  const { SPAWN_REFUSALS, underSpawnProtection } = await import('../../src/skills/spawnProtection')
  // the radius known (the option's): no dig in the square at all, out of it and down there
  const known = await shelterAtSpawn(16, 'silent')
  assert.equal(known.refused.length, 0)
  assert.ok(known.result.dug && known.result.feet.x >= 17 + SHELTER_LEAVE_MARGIN - 1, `the hole at ${String(known.result.feet)}`)
  assert.ok(isEnclosed((p) => known.bot.blockAt(p), known.result.feet))
  // 1.21.11 (no message, 'auto'): two digs put back by the spawn teach it the square (SPAWN_REFUSALS), then out
  const silent = await shelterAtSpawn('auto', 'silent')
  assert.ok(silent.refused.length <= SPAWN_REFUSALS, `${silent.refused.length} digs refused`)
  assert.ok(silent.result.dug && !underSpawnProtection(silent.bot, silent.result.feet), `the hole at ${String(silent.result.feet)}`)
  assert.ok(isEnclosed((p) => silent.bot.blockAt(p), silent.result.feet))
  // 26.3 (the action bar's 'is under spawn protection'): the first refusal teaches it
  const told = await shelterAtSpawn('auto', 'message')
  assert.equal(told.refused.length, 1)
  assert.ok(told.result.dug && !underSpawnProtection(told.bot, told.result.feet), `the hole at ${String(told.result.feet)}`)
})

test('shelter: a column whose shelter failed (no way to it, its dig down unsafe) is left by the next try (SHELTER_FAIL_TICKS) and the dig goes on in the next best column: the night reflex\'s try 20 ticks after took the same column again', async () => {
  const { SkillError } = await import('../../src/skills/errors')
  const { SHELTER_FAIL_TICKS, shelterFailedAt } = await import('../../src/skills/shelter')
  assert.equal(SHELTER_FAIL_TICKS, 1200)
  const actions = require('../../src/core/actions')
  const nav = require('../../src/skills/navigate')
  const realDig = actions.dig
  const realNavigate = nav.navigate
  // a pad of stone under the bot (no pickaxe: no column there), plains about it
  const changed = new Map<string, string>()
  const ground = (p: Vec3): string => changed.get(p.toString()) ?? (Math.abs(p.x) <= 1 && Math.abs(p.z) <= 1 && p.y < 64 ? 'stone' : plains(p))
  const night = (): any => {
    const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [item('dirt', 8)], world: ground })
    bot.time = { timeOfDay: 18000 }
    bot.equip = async () => {}
    bot.digTime = () => 10
    bot.placeBlock = async (against: any, face: Vec3) => { changed.set(against.position.plus(face).toString(), 'dirt') }
    return bot
  }
  try {
    // no way to any column: three tried, then the next try three others
    const walks: string[] = []
    nav.navigate = async (_b: any, args: any) => { walks.push(`${String(args.goal.x)},${String(args.goal.z)}`); throw new SkillError('NO_PATH', 'no path') }
    const bot = night()
    await assert.rejects(shelter(bot, { torch: false, leave: false, until: () => true }), (err: any) => err.reason === 'NO_PATH')
    await assert.rejects(shelter(bot, { torch: false, leave: false, until: () => true }), (err: any) => err.reason === 'NO_PATH')
    assert.equal(walks.length, 6)
    assert.equal(new Set(walks).size, 6, walks.join(' '))
    // the first column's ground opens into a cave under its first block dug (digDownHazard): the next column dug
    nav.navigate = async (b: any, args: any) => { b.entity.position = new Vec3(args.goal.x + 0.5, 64, args.goal.z + 0.5); return {} }
    let first: Vec3 | null = null
    actions.dig = async (b: any, target: any) => {
      const pos = target.position as Vec3
      first = first ?? new Vec3(pos.x, 64, pos.z)
      changed.set(pos.toString(), 'air')
      if (pos.x === first.x && pos.z === first.z) for (const y of [60, 61]) changed.set(new Vec3(pos.x, y, pos.z).toString(), 'air')
      b.entity.position = b.entity.position.offset(0, -1, 0)
    }
    const dug = night()
    const physics = setInterval(() => dug.emit('physicsTick'), 1)
    try {
      const result = await shelter(dug, { torch: false, leave: false, until: () => true })
      assert.ok(first != null)
      assert.ok(result.dug && (result.feet.x !== (first as Vec3).x || result.feet.z !== (first as Vec3).z), `the hole at ${String(result.feet)}`)
      assert.ok(isEnclosed((p) => dug.blockAt(p), result.feet))
      assert.equal(shelterFailedAt(dug, first as Vec3), true)
    } finally {
      clearInterval(physics)
    }
  } finally {
    actions.dig = realDig
    nav.navigate = realNavigate
  }
})
