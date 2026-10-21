import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { HEADWAY_TICKS, Headway, creeperKeepOff, deadlyStep, edgeAhead, fleeHeading, fleeRoute, fleeWay, jumpRoom, lineCost, stepCost, steerToward } from '../../src/skills/steer'
import { LS3B_CREEPER_1, LS3B_CREEPER_2, bodyGets, gridBlocks, gridWorld } from './fleeTerrain'
import { fakeBot } from '../reflexes/fakeBot'

test('fleeHeading runs away from the threat, around lava and walls', () => {
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5) })
  // a threat at -x: run toward +x (mineflayer yaw -pi/2 faces +x)
  const heading = fleeHeading(bot, new Vec3(-3, 64, 0.5))
  assert.ok(heading != null)
  assert.ok(-Math.sin(heading) > 0.9, `heading ${heading}`)
  // lava all along +x: not that way
  const lavaEast = (p: Vec3): string => p.x >= 1 && p.y === 63 ? 'lava' : p.y < 64 ? 'stone' : 'air'
  const bot2 = fakeBot({ position: new Vec3(0.5, 64, 0.5), world: lavaEast })
  const h2 = fleeHeading(bot2, new Vec3(-3, 64, 0.5))
  assert.ok(h2 != null)
  assert.ok(-Math.sin(h2) < 0.5, `ran into the lava: heading ${h2}`)
  assert.strictEqual(stepCost(bot2, new Vec3(3, 64, 0)), Infinity)
  // walled in: nowhere
  const box = (p: Vec3): string => (Math.abs(p.x) >= 1 || Math.abs(p.z) >= 1) ? 'stone' : p.y < 64 ? 'stone' : 'air'
  assert.strictEqual(fleeHeading(fakeBot({ position: new Vec3(0.5, 64, 0.5), world: box }), new Vec3(-3, 64, 0.5)), null)
})

test('deadlyStep: lava or fire at the feet, a fall into lava or past 3 blocks; not a wall, a step down, or water under', () => {
  // stone floor to y 63 west of x 2; east of it: a pocket of lava at y 62 (z < 0) and the void (z >= 0), a wall at x -2
  const world = (p: Vec3): string => {
    if (p.x <= -2) return p.y < 66 ? 'stone' : 'air'
    if (p.x < 2) return p.y < 64 ? 'stone' : 'air'
    if (p.z < 0) return p.y === 62 ? 'lava' : p.y < 62 ? 'stone' : 'air'
    if (p.z >= 4) return p.y === 60 ? 'water' : 'air'
    return 'air'
  }
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), world })
  assert.strictEqual(deadlyStep(bot, new Vec3(1, 64, 0)), false, 'level ground')
  assert.strictEqual(deadlyStep(bot, new Vec3(-2, 64, 0)), false, 'a wall')
  assert.strictEqual(deadlyStep(bot, new Vec3(2, 64, -1)), true, 'a lava pocket under a drop of 1')
  assert.strictEqual(deadlyStep(bot, new Vec3(2, 64, 1)), true, 'the void')
  assert.strictEqual(deadlyStep(bot, new Vec3(2, 64, 5)), false, 'water under a drop of 3')
})

test('steerToward with guard stops at a deadly edge (sneaking: the speed had doesn\'t carry it over), and walks on away from it', () => {
  // a ledge: ground to x < 1, the lava sea far under it east
  const world = (p: Vec3): string => p.x < 1 ? (p.y < 64 ? 'stone' : 'air') : (p.y === 31 ? 'lava' : 'air')
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), world })
  // east: over the edge
  assert.strictEqual(edgeAhead(bot, -Math.PI / 2), true)
  assert.strictEqual(steerToward(bot, new Vec3(5, 64, 0.5), { guard: true }), false)
  assert.strictEqual(bot.getControlState('forward'), false)
  assert.strictEqual(bot.getControlState('sprint'), false)
  assert.strictEqual(bot.getControlState('sneak'), true)
  // without the guard it walks on (an escape through lava wants that)
  assert.strictEqual(steerToward(bot, new Vec3(5, 64, 0.5)), true)
  assert.strictEqual(bot.getControlState('forward'), true)
  // west, along the ground: on it goes
  bot.clearControlStates()
  assert.strictEqual(edgeAhead(bot, Math.PI / 2), false)
  assert.strictEqual(steerToward(bot, new Vec3(-5, 64, 0.5), { guard: true, sprint: true }), true)
  assert.strictEqual(bot.getControlState('forward'), true)
  assert.strictEqual(bot.getControlState('sprint'), true)
  assert.strictEqual(bot.getControlState('sneak'), false)
  // two blocks from the edge it isn't one yet (the check reaches 1.2 blocks on)
  bot.entity.position = new Vec3(-1.5, 64, 0.5)
  assert.strictEqual(edgeAhead(bot, -Math.PI / 2), false)
})

test('steerToward with guard and maxDrop 1 keeps a chase on its level: it stops at a step down of 2 or 3 (not deadly) and takes a step down of 1', () => {
  // stone to y 63 west of x 1; a step down of 1 east of it along z < 0, of 3 along z >= 0
  const world = (p: Vec3): string => p.x < 1 ? (p.y < 64 ? 'stone' : 'air') : (p.y < (p.z < 0 ? 63 : 61) ? 'stone' : 'air')
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), world })
  assert.strictEqual(deadlyStep(bot, new Vec3(1, 64, 0)), false, 'a drop of 3')
  assert.strictEqual(deadlyStep(bot, new Vec3(1, 64, 0), 1), true, 'a drop of 3, with 1 at most')
  assert.strictEqual(deadlyStep(bot, new Vec3(1, 64, -1), 1), false, 'a drop of 1, with 1 at most')
  assert.strictEqual(steerToward(bot, new Vec3(5, 64, 0.5), { guard: true }), true)
  bot.clearControlStates()
  assert.strictEqual(steerToward(bot, new Vec3(5, 64, 0.5), { guard: true, maxDrop: 1 }), false)
  assert.strictEqual(bot.getControlState('forward'), false)
  bot.entity.position = new Vec3(0.5, 64, -0.5)
  assert.strictEqual(steerToward(bot, new Vec3(5, 64, -0.5), { guard: true, maxDrop: 1 }), true)
  // a magma block's top is deadly at any drop (the hot floor)
  const magma = (p: Vec3): string => p.x === 1 && p.y === 63 ? 'magma_block' : p.y < 64 ? 'stone' : 'air'
  const onMagma = fakeBot({ position: new Vec3(0.5, 64, 0.5), world: magma })
  assert.strictEqual(edgeAhead(onMagma, -Math.PI / 2), true)
})

test('fleeHeading: in a tunnel shut behind the bot, the way at the threat is none (cornered), not the flee (nether-26.3-q3: fled into a creeper\'s blast)', () => {
  const tunnel = (p: Vec3): string => (p.z === 0 && (p.y === 64 || p.y === 65) && p.x >= 0 && p.x < 12) ? 'air' : 'stone'
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), world: tunnel })
  assert.equal(fleeHeading(bot, new Vec3(8.5, 64, 0.5)), null)
  // the creeper behind it the other way: on down the tunnel, away
  const bot2 = fakeBot({ position: new Vec3(4.5, 64, 0.5), world: tunnel })
  const h = fleeHeading(bot2, new Vec3(1.5, 64, 0.5))
  assert.ok(h != null && -Math.sin(h) > 0.9, String(h))
})

/** a fake bot on a grid's ground, its leaves and logs full blocks */
function gridBot (world: (p: Vec3) => string, position: Vec3): any {
  const bot = fakeBot({ position, world })
  bot.blockAt = gridBlocks(world)
  return bot
}

// ls3b-1.21.11's first creeper death (t327032): the bot up its pillar out of a cave at (159, 67, 322), the leaves over
// it there dug, by an oak's trunk at (157, 69..72, 321) and another oak's canopy low over z 322 on (y 70)
const SHAFT = { '159,68,322': 'air', '159,67,322': 'cobblestone', '159,70,322': 'air' }

test('fleeHeading takes the body\'s way, not its middle\'s: no line past a trunk\'s corner under low leaves, nor a step up under a canopy (ls3b-1.21.11, two creeper deaths)', () => {
  const w1 = gridWorld(LS3B_CREEPER_1, SHAFT)
  // where it died, pressed to the trunk, the creeper 2.5 off: the old line (west-southwest, between the trunk and the
  // leaves at the head) is none, nor any other away from it
  const wedged = gridBot(w1, new Vec3(158.3, 69, 321.68))
  const creeper = new Vec3(160.55, 69, 320.65)
  const wsw = 5 * Math.PI / 8
  assert.equal(bodyGets(gridBlocks(w1), wedged.entity.position, wsw, 2), false, 'the body gets past the corner')
  assert.equal(lineCost(wedged, new Vec3(158.3, 69, 321.68), -Math.sin(wsw), -Math.cos(wsw)), Infinity)
  assert.equal(fleeHeading(wedged, creeper), null)
  // a step back, on the pillar's top: north-west, a way the body gets along
  const atPillar = gridBot(w1, new Vec3(159.5, 69, 321.79))
  const h = fleeHeading(atPillar, creeper)
  assert.ok(h != null && bodyGets(gridBlocks(w1), atPillar.entity.position, h, 3), String(h))
  // the second (t439660): in a hollow under an oak's leaves at y 66, every step up out of it one its jump can't take
  const w2 = gridWorld(LS3B_CREEPER_2)
  const hollow = gridBot(w2, new Vec3(27.7, 64, 203.3))
  assert.equal(jumpRoom(hollow, hollow.entity.position), false)
  assert.equal(fleeHeading(hollow, new Vec3(26.44, 64, 205.82)), null)
  assert.equal(fleeHeading(hollow, new Vec3(22.1, 64, 205.5)), null)
  // and on open ground the way's straight on as before
  const open = gridBot(w2, new Vec3(30.5, 66, 196.5))
  assert.equal(jumpRoom(open, open.entity.position), true)
  const away = fleeHeading(open, new Vec3(27.5, 66, 196.5))
  assert.ok(away != null && -Math.sin(away) > 0.7, String(away))
})

test('fleeRoute: out of the hollow under the canopy along it, then up where the leaves end; none past a creeper\'s fuse (ls3b-1.21.11, t439660)', () => {
  const w2 = gridWorld(LS3B_CREEPER_2)
  const blocks = gridBlocks(w2)
  const from = new Vec3(27.7, 64, 203.3)
  // the first creeper west of it at (22.1, 64, 205.5): a step south-east along the hollow, then east out of it
  const route = fleeRoute(blocks, from, [new Vec3(22.1, 64, 205.5)], { keepOff: 2.5 })
  assert.ok(route != null && route.length > 2, JSON.stringify(route))
  const end = route[route.length - 1]
  assert.ok(Math.hypot(end.x + 0.5 - 22.1, end.z + 0.5 - 205.5) >= Math.hypot(27.7 - 22.1, 203.3 - 205.5) + 2)
  // each of its steps one the body takes (the cell's middle to the next's)
  let at = from
  for (const c of route) {
    const to = c.offset(0.5, 0, 0.5)
    const heading = Math.atan2(-(to.x - at.x), -(to.z - at.z))
    assert.ok(bodyGets(blocks, at, heading, Math.hypot(to.x - at.x, to.z - at.z)), `stuck from ${at.toString()} to ${to.toString()}`)
    at = to
  }
  // the bot steers along it (fleeWay's next cell), the straight lines none
  const bot = gridBot(w2, from)
  const way = fleeWay(bot, new Vec3(22.1, 64, 205.5), undefined, { keepOff: 2.5 })
  assert.ok(way != null && 'cell' in way && way.cell.equals(route[0]), JSON.stringify(way))
  // the second, 2.8 off to the south: the hollow's ways out all pass it within 2.5, no route (cornered)
  assert.equal(fleeRoute(blocks, from, [new Vec3(26.44, 64, 205.82)], { keepOff: 2.5 }), null)
  // in a tunnel shut behind the bot, none either
  const tunnel = (p: Vec3): string => (p.z === 0 && (p.y === 64 || p.y === 65) && p.x >= 0 && p.x < 12) ? 'air' : 'stone'
  assert.equal(fleeRoute(p => fakeBot({ world: tunnel }).blockAt(p), new Vec3(0.5, 64, 0.5), [new Vec3(8.5, 64, 0.5)]), null)
})

test('Headway: a run that got less than HEADWAY_BLOCKS across in HEADWAY_TICKS got nowhere', () => {
  const h = new Headway()
  // a sprint from a stand (its speed building up to 0.28 a tick)
  for (let t = 0; t <= HEADWAY_TICKS + 4; t++) assert.equal(h.update(new Vec3(Math.min(t, 6) * 0.05 * t, 64, 0)), false, `a sprint, tick ${t}`)
  h.reset()
  let stuck = false
  for (let t = 0; t <= HEADWAY_TICKS; t++) stuck = h.update(new Vec3(0.05 * (t % 2), 64, 0))
  assert.equal(stuck, true, 'jumping in place')
})

test('creeperKeepOff: a route away from a creeper never passes it nearer than the bot is now (a nook\'s mouth past it: 13 of damage, tests/integration/creeperTerrain \'nook\')', () => {
  // a nook a cell across at (0, 64, 0), open to the east only, on open stone ground; the creeper 5.8 off, its sword's
  // knockback back from the mouth
  const nook = (p: Vec3): string => {
    if (p.y < 64) return 'stone'
    if (p.y > 66) return 'air'
    if (p.x >= -1 && p.x <= 1 && p.z >= -1 && p.z <= 1) return (p.x === 0 && p.z === 0 && p.y < 66) || (p.x === 1 && p.z === 0 && p.y < 66) ? 'air' : 'stone'
    return 'air'
  }
  const blocks = (p: Vec3): any => fakeBot({ world: nook }).blockAt(p)
  const from = new Vec3(0.5, 64, 0.5)
  const creeper = new Vec3(6.3, 64, 0.5)
  // the plain route keeps 2.5 off: out of the mouth and past it, within its blast's reach
  assert.ok(fleeRoute(blocks, from, [creeper], { keepOff: 2.5 }) != null)
  // the creeper's: none (cornered: the sword from the nook, or its sight cut)
  assert.equal(creeperKeepOff(from, creeper), 5.8 - 0.5)
  assert.equal(fleeRoute(blocks, from, [creeper], { keepOff: creeperKeepOff(from, creeper) }), null)
  // nearer than FLEE_ROUTE_KEEP_OFF already: that much
  assert.equal(creeperKeepOff(from, new Vec3(2.5, 64, 0.5)), 2.5)
})
