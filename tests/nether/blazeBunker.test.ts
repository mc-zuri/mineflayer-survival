// The sealed bunker the first blaze rods are fought from (blazeFight's bunkerAround, planBlazeBunkers): its cell, sill,
// slit, roof and visor, what a blaze sees of it and what its fireballs meet, its sites at seed 2's two throne
// spawners (26.3 snapshots), and its drops' pickup and fetch.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as path from 'node:path'
import { Vec3 } from 'vec3'
import {
  BLAZE_EYE_HEIGHT, BUNKER, BUNKER_FETCH_HEALTH, BUNKER_MIN_VIEW, blazesAbout, bunkerAround, bunkerClear, bunkerDrops, bunkerFetchDue, clearLine, inPickupReach,
  inSpawnVolume, netherStepForbidden, openNook, planBlazeBunkers, shellAgain, sillDrops, sillPickupDue, spawnView, bunkerTurnWay, turnBunker,
  type NookLookup
} from '../../src/nether/blazeFight'
import { readNetherSnapshot } from './netherSnapshot'

const solid = (name: string): { name: string, boundingBox: string } => ({ name, boundingBox: 'block' })
const AIR = { name: 'air', boundingBox: 'empty' }
const UP = new Vec3(0, 1, 0)

/** open ground: nether bricks under y 64, the spawner at 0 64 0, and the cells put */
function world (): { lookup: NookLookup, put: (p: Vec3) => void } {
  const placed = new Set<string>()
  const lookup: NookLookup = p => {
    if (placed.has(p.toString())) return solid('cobblestone')
    if (p.x === 0 && p.y === 64 && p.z === 0) return solid('spawner')
    return p.y < 64 ? solid('nether_bricks') : AIR
  }
  return { lookup, put: p => placed.add(p.toString()) }
}

function snapshotLookup (file: string): NookLookup {
  const snap = readNetherSnapshot(path.join(__dirname, '..', 'fixtures', file))
  const mc = require('minecraft-data')(snap.version)
  const [x0, y0, z0] = snap.origin
  const [sx, sy, sz] = snap.size
  return p => {
    const x = p.x - x0; const y = p.y - y0; const z = p.z - z0
    if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) return null
    const b = mc.blocksByStateId[snap.ids[(x * sz + z) * sy + y]]
    return b == null ? null : { name: b.name, boundingBox: b.boundingBox }
  }
}

/** each block of the build has a solid neighbour by the time it goes in */
function assertPlaceable (lookup: NookLookup, build: Vec3[]): void {
  const put = new Set<string>()
  for (const p of build) {
    const n = [p.offset(0, -1, 0), p.offset(0, 1, 0), p.offset(1, 0, 0), p.offset(-1, 0, 0), p.offset(0, 0, 1), p.offset(0, 0, -1)]
    assert.ok(n.some(q => put.has(q.toString()) || lookup(q)?.boundingBox === 'block'), `${p.toString()} has nothing to go against`)
    put.add(p.toString())
  }
}

test('bunkerAround: the cell walled at the feet and the head but the slit, the sill under the slit, a block over the head and one over the slit; the slit the one cell open', () => {
  const { lookup } = world()
  const stand = new Vec3(0, 64, 5)
  const facing = new Vec3(0, 0, -1)
  const b = bunkerAround(lookup, stand, facing)
  assert.ok(b != null && b.bunker != null)
  assert.deepEqual(b.bunker.sill, new Vec3(0, 64, 4))
  assert.deepEqual(b.bunker.slit, new Vec3(0, 65, 4))
  assert.deepEqual(b.bunker.visor, new Vec3(0, 66, 4))
  assert.deepEqual(b.front, [b.bunker.slit])
  const walls = b.walls.map(String)
  for (const p of [new Vec3(0, 64, 6), new Vec3(0, 65, 6), new Vec3(1, 64, 5), new Vec3(-1, 65, 5), new Vec3(0, 66, 5), b.bunker.sill, b.bunker.visor]) {
    assert.ok(walls.includes(p.toString()), p.toString())
    assert.ok(b.build.some(q => q.equals(p)), `${p.toString()} built`)
  }
  for (const p of [stand, stand.plus(UP), b.bunker.slit]) assert.ok(!b.build.some(q => q.equals(p)), `${p.toString()} left open`)
  assertPlaceable(lookup, b.build)
  // without the visor, the cell over the slit is left
  const open = bunkerAround(lookup, stand, facing, false)
  assert.ok(open != null && open.bunker?.visor == null)
  assert.ok(!open.build.some(q => q.equals(new Vec3(0, 66, 4))))
  // no bunker with its slit in a wall
  const walled: NookLookup = p => p.equals(new Vec3(0, 65, 4)) ? solid('netherrack') : lookup(p)
  assert.equal(bunkerAround(walled, stand, facing), null)
})

test('a blaze sees the bot in its bunker only through the slit (its face on the cell, half a block off the eyes: ahead within 45 degrees); a fireball from about the bot\'s height meets the sill, one from over it comes in at the slit toward the shield', () => {
  const w = world()
  const stand = new Vec3(0, 64, 5)
  const b = bunkerAround(w.lookup, stand, new Vec3(0, 0, -1))
  assert.ok(b != null)
  for (const p of b.build) w.put(p)
  const eye = stand.offset(0.5, 1.62, 0.5)
  const middle = stand.offset(0.5, 0.9, 0.5)
  /** a blaze's feet `d` off the bot's eye, `deg` off the slit's way, `up` over the bot's feet */
  const at = (deg: number, d: number, up = 0): Vec3 => {
    const a = -Math.PI / 2 + deg * Math.PI / 180
    return new Vec3(eye.x + Math.cos(a) * d, stand.y + up, eye.z + Math.sin(a) * d)
  }
  const sees = (feet: Vec3): boolean => clearLine(w.lookup, feet.offset(0, BLAZE_EYE_HEIGHT, 0), eye)
  for (const deg of [0, 20, -20, 35, -35]) assert.ok(sees(at(deg, 6)), `${deg} degrees off: seen`)
  for (const deg of [55, -55, 90, -90, 125, -145, 180]) assert.ok(!sees(at(deg, 6)), `${deg} degrees off: hidden`)
  // from over it: the roof and the visor
  for (const up of [4, 7]) assert.ok(!sees(at(0, 3, up)), `${up} over: hidden`)
  assert.ok(!clearLine(w.lookup, eye.offset(0.2, 6, 0.3), eye))
  // a small fireball (from the blaze's getY(0.5) + 0.5, at the target's getY(0.5)) from ahead at the bot's height: the sill
  const fireball = (feet: Vec3): boolean => clearLine(w.lookup, feet.offset(0, 0.9 + 0.5, 0), middle)
  for (const d of [3, 6, 10, 14]) assert.ok(!fireball(at(0, d)), `${d} off: into the sill`)
  // from 2 over it at 8 off: in at the slit (the shield, held toward it, takes it)
  assert.ok(fireball(at(0, 8, 2)))
  assert.ok(spawnView(w.lookup, new Vec3(0, 64, 0), b).seen >= BUNKER_MIN_VIEW)
})

test('planBlazeBunkers on open ground: a stand out of the spawn volume facing the spawner, BUNKER.standOff off, visored', () => {
  const { lookup } = world()
  const S = new Vec3(0, 64, 0)
  const list = planBlazeBunkers(lookup, S, { from: new Vec3(0.5, 64, 20.5) })
  assert.ok(list.length > 0)
  for (const b of list) {
    const h = Math.hypot(b.stand.x, b.stand.z)
    assert.ok(h >= BUNKER.minDistance && h <= BUNKER.maxDistance, b.stand.toString())
    assert.ok(!inSpawnVolume(S, b.stand), b.stand.toString())
    assert.ok(b.facing.dot(new Vec3(-b.stand.x, 0, -b.stand.z).scaled(1 / h)) > 0.8, `${b.stand.toString()} facing ${b.facing.toString()}`)
    assert.ok(spawnView(lookup, S, b).seen >= BUNKER_MIN_VIEW)
    assertPlaceable(lookup, b.build)
  }
  // the bot's side of it, 7 off, facing it
  assert.deepEqual(list[0].stand, new Vec3(0, 64, 7))
  assert.deepEqual(list[0].facing, new Vec3(0, 0, -1))
  assert.ok(list[0].bunker?.visor != null)
})

test('planBlazeBunkers leaves out a stand by lava or over magma (netherStepForbidden)', () => {
  const { lookup } = world()
  const lava: NookLookup = p => (p.x === 1 && p.y === 64 && p.z === 6) ? { name: 'lava', boundingBox: 'empty' } : p.equals(new Vec3(-1, 63, 5)) ? solid('magma_block') : lookup(p)
  const list = planBlazeBunkers(lava, new Vec3(0, 64, 0), { from: new Vec3(0.5, 64, 20.5) }, 40)
  assert.ok(list.length > 0)
  for (const b of list) assert.ok(!netherStepForbidden(lava, b.stand), b.stand.toString())
  assert.ok(!list.some(b => b.stand.equals(new Vec3(0, 64, 5)) || b.stand.equals(new Vec3(-1, 64, 5))))
})

test('planBlazeBunkers at seed 2\'s throne spawners (26.3): s2fortress\'s on the room\'s floor 5 off by the stairs, s2fortress2\'s open in its cave on its corridor\'s wall 7 off, 2 over the spawner; each out of the spawn volume, seeing its spawns through the slit', () => {
  const sites = [
    ['nether-seed2-s2fortress.json.gz', new Vec3(-277, 77, -159), new Vec3(-279, 77, -164)],
    ['nether-seed2-s2fortress2.json.gz', new Vec3(-290, 77, -209), new Vec3(-287, 79, -202)]
  ] as const
  for (const [file, spawner, first] of sites) {
    const lookup = snapshotLookup(file)
    assert.equal(lookup(spawner)?.name, 'spawner')
    const list = planBlazeBunkers(lookup, spawner, { from: new Vec3(-270.5, 61, -164.5) })
    assert.ok(list.length > 0, file)
    for (const b of list) {
      assert.ok(!inSpawnVolume(spawner, b.stand), b.stand.toString())
      assert.ok(!netherStepForbidden(lookup, b.stand), b.stand.toString())
      assert.ok(spawnView(lookup, spawner, b).seen >= 0.3, `${file} ${b.stand.toString()}`)
      assertPlaceable(lookup, b.build)
    }
    assert.deepEqual(list[0].stand, first, file)
    assert.deepEqual(list[0].facing, new Vec3(0, 0, Math.sign(spawner.z - list[0].stand.z)))
  }
})

test('shellAgain: a bunker\'s walls dug on the way in (a sill opened for a fetch) are its blocks to put again, the slit left open', () => {
  const w = world()
  const b = bunkerAround(w.lookup, new Vec3(0, 64, 5), new Vec3(0, 0, -1))
  assert.ok(b?.bunker != null)
  for (const p of b.build) if (!p.equals(b.bunker.sill)) w.put(p)
  const again = shellAgain(w.lookup, b)
  assert.ok(again != null)
  assert.deepEqual(again.build, [b.bunker.sill])
  assert.deepEqual(again.front, [b.bunker.slit])
})

test('inPickupReach (Player.aiStep: the box inflated 1 across, 0.5 up and down): an item on the bunker\'s sill, in the slit, comes to the bot; one on the floor past it does not', () => {
  const feet = new Vec3(0.5, 64, 5.5)
  // on the sill's top, the slit's middle and its far edge
  assert.ok(inPickupReach(feet, new Vec3(0.5, 65, 4.5)))
  assert.ok(inPickupReach(feet, new Vec3(0.5, 65, 4.15)))
  // on the floor past the sill, and to the side
  assert.ok(!inPickupReach(feet, new Vec3(0.5, 64, 3.5)))
  assert.ok(!inPickupReach(feet, new Vec3(2.5, 64, 5.5)))
  // under the floor, over the roof
  assert.ok(!inPickupReach(feet, new Vec3(0.5, 63, 5.5)))
  assert.ok(!inPickupReach(feet, new Vec3(0.5, 66.4, 5.5)))
})

test('bunkerDrops: the rods by the bunker out of its reach, to 12 off, nearest first; not one on the sill, nor a bone', async () => {
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const w = world()
  const b = bunkerAround(w.lookup, new Vec3(0, 64, 5), new Vec3(0, 0, -1))
  assert.ok(b != null)
  const onSill = { id: 71, name: 'item', position: new Vec3(0.5, 65, 4.5), getDroppedItem: () => item('blaze_rod') }
  const past = { id: 72, name: 'item', position: new Vec3(0.5, 64, 2.5), getDroppedItem: () => item('blaze_rod') }
  const throne = { id: 73, name: 'item', position: new Vec3(1.5, 65, -3.5), getDroppedItem: () => item('blaze_rod') }
  const far = { id: 75, name: 'item', position: new Vec3(0.5, 64, -9.5), getDroppedItem: () => item('blaze_rod') }
  const bones = { id: 74, name: 'item', position: new Vec3(1.5, 64, 2.5), getDroppedItem: () => item('bone') }
  const bot = fakeBot({ position: new Vec3(0.5, 64, 5.5) })
  for (const e of [onSill, past, throne, far, bones]) bot.entities[e.id] = e
  assert.deepEqual(bunkerDrops(bot, b).map(e => e.id), [72, 73])
})

test('bunkerFetchDue (fetchThreats): the blazes behind the walls of the bunker, seeing neither the bot nor the drop, let a fetch go; more than BUNKER_FETCH_SEEN in sight, one by the drop, a fireball near, or low, not', async () => {
  const { entity } = await import('../reflexes/fakeBot')
  const { fetchThreats, BUNKER_FETCH_SEEN } = await import('../../src/nether/blazeFight')
  const behind = [0.2, 0.5, 0.8].map(x => entity({ name: 'blaze', position: new Vec3(x, 64, 9.5), meta: { health: 20 } }))
  const ahead = entity({ name: 'blaze', position: new Vec3(0.5, 64, -6.5), meta: { health: 20 } })
  const { bot, b, restore } = await bunkerBot([...behind, ahead])
  try {
    const drop = new Vec3(0.5, 64, 2.5)
    assert.deepEqual(fetchThreats(bot, [drop.offset(0, 1.62, 0)]).map(e => e.id), [ahead.id])
    assert.equal(BUNKER_FETCH_SEEN, 1)
    assert.equal(bunkerFetchDue(bot, b, 20, () => true, false, drop), true)
    assert.equal(bunkerFetchDue(bot, b, BUNKER_FETCH_HEALTH - 0.5, () => true, false, drop), false)
    assert.equal(bunkerFetchDue(bot, b, 20, () => false, false, drop), false)
    // a second in sight
    behind[0].position = new Vec3(3.5, 64, -5.5)
    assert.equal(bunkerFetchDue(bot, b, 20, () => true, false, drop), false)
    behind[0].position = new Vec3(0.2, 64, 9.5)
    // one by the drop
    ahead.position = new Vec3(0.5, 64, -0.5)
    assert.equal(bunkerFetchDue(bot, b, 20, () => true, false, drop), false)
    ahead.position = new Vec3(0.5, 64, -6.5)
    // a fireball near
    bot.entities[90] = { id: 90, name: 'small_fireball', position: new Vec3(0.5, 65, -5), velocity: new Vec3(0, 0, 0.5) }
    assert.equal(bunkerFetchDue(bot, b, 20, () => true, false, drop), false)
    delete bot.entities[90]
    for (const z of [...behind, ahead]) z.position = new Vec3(0.5, 66, -40)
    assert.equal(bunkerClear(bot), true)
    assert.equal(blazesAbout(bot), 0)
  } finally {
    restore()
  }
})

test('openNook on a bunker shut in to heal opens the slit only, never the sill', async () => {
  const { fakeBot } = await import('../reflexes/fakeBot')
  const w = world()
  const b = bunkerAround(w.lookup, new Vec3(0, 64, 5), new Vec3(0, 0, -1))
  assert.ok(b?.bunker != null)
  const filled = new Set([...b.build, b.bunker.slit].map(String))
  const bot = fakeBot({ position: new Vec3(0.5, 64, 5.5), world: (p: Vec3) => filled.has(p.floored().toString()) ? 'cobblestone' : p.y < 64 ? 'stone' : 'air' })
  const dug: string[] = []
  bot.dig = async (block: any) => { dug.push(block.position.toString()); filled.delete(block.position.toString()) }
  await openNook(bot, b)
  assert.deepEqual(dug, [b.bunker.slit.toString()])
})

test('sillDrops and sillPickupDue: a rod 2 off past the sill (a blaze the sword killed at the slit) is a step out\'s, taken with no blaze within 3 of the sill\'s cell', async () => {
  const { fakeBot, entity, item } = await import('../reflexes/fakeBot')
  const w = world()
  const b = bunkerAround(w.lookup, new Vec3(0, 64, 5), new Vec3(0, 0, -1))
  assert.ok(b != null)
  const atSlit = { id: 81, name: 'item', position: new Vec3(0.6, 64, 3.6), getDroppedItem: () => item('blaze_rod') }
  const inReach = { id: 82, name: 'item', position: new Vec3(0.5, 65, 4.5), getDroppedItem: () => item('blaze_rod') }
  const farther = { id: 83, name: 'item', position: new Vec3(0.5, 64, 1.5), getDroppedItem: () => item('blaze_rod') }
  const blaze = entity({ name: 'blaze', position: new Vec3(0.5, 64, 2.2), meta: { health: 20 } })
  const bot = fakeBot({ position: new Vec3(0.5, 64, 5.5), entities: [blaze] })
  for (const e of [atSlit, inReach, farther]) bot.entities[e.id] = e
  assert.deepEqual(sillDrops(bot, b).map(e => e.id), [81])
  // a blaze 1.8 off the sill's cell: in
  assert.equal(sillPickupDue(bot, b, 20), false)
  blaze.position = new Vec3(0.5, 64, -1.5)
  assert.equal(sillPickupDue(bot, b, 20), true)
  assert.equal(sillPickupDue(bot, b, 20, () => false), false)
  assert.equal(sillPickupDue(bot, b, 12), false)
})

test('bunkerTurnWay: the way most of the blazes within 8 are, but the slit\'s own; none with none near', () => {
  const { lookup } = world()
  const b = bunkerAround(lookup, new Vec3(0, 64, 5), new Vec3(0, 0, -1))
  assert.ok(b != null)
  // two behind it (+z), one to its +x side, one far
  const blazes = [new Vec3(0.5, 66, 9), new Vec3(1.5, 65, 10), new Vec3(4.5, 64, 5.5), new Vec3(0.5, 64, 30)]
  assert.deepEqual(bunkerTurnWay(b, blazes), new Vec3(0, 0, 1))
  // ahead of the slit only: none
  assert.equal(bunkerTurnWay(b, [new Vec3(0.5, 64, 1)]), null)
  assert.equal(bunkerTurnWay(b, []), null)
})

test('turnBunker: the head wall that way dug for the new slit, the old slit walled, a visor over the new one; never into the spawner', async () => {
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const placeModule = require('../../src/skills/placeBlock')
  const w = world()
  const b = bunkerAround(w.lookup, new Vec3(0, 64, 5), new Vec3(0, 0, -1))
  assert.ok(b?.bunker != null)
  const filled = new Set(b.build.map(String))
  const bot = fakeBot({ position: new Vec3(0.5, 64, 5.5), items: [item('cobblestone', 32), item('iron_pickaxe')], world: (p: Vec3) => filled.has(p.floored().toString()) ? 'cobblestone' : p.y < 64 ? 'nether_bricks' : 'air' })
  const dug: string[] = []
  bot.dig = async (block: any) => { dug.push(block.position.toString()); filled.delete(block.position.toString()) }
  const realPlace = placeModule.placeBlock
  placeModule.placeBlock = async (_b: unknown, a: any) => { filled.add(a.pos.toString()); return { pos: a.pos, block: a.item, placed: true } }
  try {
    const turned = await turnBunker(bot, b, new Vec3(1, 0, 0))
    assert.ok(turned?.bunker != null)
    assert.deepEqual(dug, ['(1, 65, 5)'])
    assert.deepEqual(turned.bunker.slit, new Vec3(1, 65, 5))
    assert.deepEqual(turned.front, [new Vec3(1, 65, 5)])
    // the old slit walled, the new visor put
    assert.ok(filled.has('(0, 65, 4)'))
    assert.ok(filled.has('(1, 66, 5)'))
    assert.ok(!filled.has('(1, 65, 5)'))
  } finally {
    placeModule.placeBlock = realPlace
  }
  // the spawner where the new slit would be: no turn
  const s = world()
  const by = bunkerAround(s.lookup, new Vec3(1, 63, 0), new Vec3(0, 0, -1))
  assert.ok(by != null)
  const bot2 = fakeBot({ position: new Vec3(1.5, 63, 0.5), items: [item('cobblestone', 32)], world: (p: Vec3) => p.x === 0 && p.y === 64 && p.z === 0 ? 'spawner' : p.y < 63 ? 'nether_bricks' : 'air' })
  bot2.dig = async () => { throw new Error('dug the spawner') }
  assert.equal(await turnBunker(bot2, by, new Vec3(-1, 0, 0)), null)
})

/** a fake bot in a built bunker at (0, 64, 5) facing -z, its blocks a set the placements and digs change */
async function bunkerBot (entities: any[], extra: any[] = [], blocks: Record<string, string> = {}): Promise<{ bot: any, b: any, filled: Set<string>, placed: string[], restore: () => void }> {
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const placeModule = require('../../src/skills/placeBlock')
  const w = world()
  const b = bunkerAround(w.lookup, new Vec3(0, 64, 5), new Vec3(0, 0, -1))
  assert.ok(b != null)
  const filled = new Set(b.build.map(String))
  const name = (p: Vec3): string => blocks[p.floored().toString()] ?? (filled.has(p.floored().toString()) ? 'cobblestone' : p.y < 64 ? 'netherrack' : 'air')
  const bot = fakeBot({ position: new Vec3(0.5, 64, 5.5), items: [item('diamond_sword'), item('cobblestone', 32), item('cooked_beef', 16), ...extra], offhand: item('shield'), entities, world: name })
  bot.world = {
    raycast: (from: Vec3, dir: Vec3, range: number) => {
      for (let t = 0; t <= range; t += 0.02) {
        const p = from.plus(dir.scaled(t))
        if (name(p) !== 'air' && name(p) !== 'fire') return { position: p.floored(), intersect: p, boundingBox: 'block', name: name(p) }
      }
      return null
    }
  }
  bot.equip = async (it: any, dest: string) => { if (dest === 'hand') bot.heldItem = it }
  bot.activateItem = () => { bot.usingHeldItem = true }
  bot.deactivateItem = () => { bot.usingHeldItem = false }
  bot.look = async () => {}
  bot.lookAt = async () => {}
  bot.attack = () => {}
  bot.dig = async (block: any) => { filled.delete(block.position.toString()) }
  bot.waitForTicks = async (n: number) => await new Promise<void>(resolve => { let k = 0; const f = (): void => { if (++k >= n) { bot.off('physicsTick', f); resolve() } }; bot.on('physicsTick', f) })
  bot.game.dimension = 'the_nether'
  const placed: string[] = []
  const realPlace = placeModule.placeBlock
  placeModule.placeBlock = async (_b: unknown, a: any) => { placed.push(a.pos.toString()); filled.add(a.pos.toString()); return { pos: a.pos, block: a.item, placed: true } }
  return { bot, b, filled, placed, restore: () => { placeModule.placeBlock = realPlace } }
}

const ticks = async (bot: any, n: number): Promise<void> => { for (let i = 0; i < n; i++) { bot.emit('physicsTick'); await new Promise(resolve => setImmediate(resolve)) } }

test('fightFromNook in a bunker: a blaze that sees it through the slit out of the sword\'s reach, no bow, no kill for BUNKER_LURE_AFTER: the slit shut a while to draw it in, then open again', async () => {
  const { entity } = await import('../reflexes/fakeBot')
  const { fightFromNook, BUNKER_LURE_AFTER } = await import('../../src/nether/blazeFight')
  const blaze = entity({ name: 'blaze', position: new Vec3(0.5, 64.2, 1.0), meta: { health: 20, flags: 0 } })
  const { bot, b, filled, placed, restore } = await bunkerBot([blaze])
  const ac = new AbortController()
  try {
    const done = fightFromNook(bot, b, { count: 1, spawner: new Vec3(0, 64, 0), maxTicks: 3000 }, ac.signal).catch(err => err)
    // (the slit's state each tick: shut, then open again)
    let opened = 0
    let wasShut = false
    bot.on('physicsTick', () => { const shut = filled.has(b.bunker.slit.toString()); if (wasShut && !shut) opened++; wasShut = shut })
    await ticks(bot, BUNKER_LURE_AFTER - 50)
    assert.deepEqual(placed, [])
    await ticks(bot, 100)
    // shut, then open again (the blaze out of its sight now), and shut again BUNKER_LURE_EVERY on while it doesn't come
    assert.deepEqual(placed, [b.bunker.slit.toString()])
    assert.equal(opened, 1)
    assert.ok(!filled.has(b.bunker.slit.toString()))
    await ticks(bot, 80)
    assert.ok(placed.length >= 2)
    ac.abort()
    await ticks(bot, 5)
    await done
  } finally {
    restore()
  }
})

test('fightFromNook in a bunker: with no blaze in its sight the errand (the spawner\'s lighting) is tried, and not while one sees it', async () => {
  const { entity } = await import('../reflexes/fakeBot')
  const { fightFromNook } = await import('../../src/nether/blazeFight')
  const blaze = entity({ name: 'blaze', position: new Vec3(0.5, 64.2, 1.0), meta: { health: 20, flags: 0 } })
  const { bot, b, restore } = await bunkerBot([blaze])
  const ac = new AbortController()
  let errands = 0
  try {
    const done = fightFromNook(bot, b, { count: 1, spawner: new Vec3(0, 64, 0), maxTicks: 3000, errand: async () => { errands++; return false } }, ac.signal).catch(err => err)
    await ticks(bot, 20)
    assert.equal(errands, 0)
    // gone round the wall, out of the slit's sight
    blaze.position = new Vec3(3.5, 64, 7.5)
    await ticks(bot, 20)
    assert.ok(errands > 0)
    ac.abort()
    await ticks(bot, 5)
    await done
  } finally {
    restore()
  }
})

test('fireballReaches: a small fireball from a blaze ahead at the bot\'s height meets the bunker\'s sill, one from over it comes in at the slit, one from beside it meets the wall', async () => {
  const { fireballReaches, FIREBALL_SPAWN_HEIGHT } = await import('../../src/nether/blazeFight')
  const { bot, restore } = await bunkerBot([])
  try {
    const from = (x: number, y: number, z: number): Vec3 => new Vec3(x, y + FIREBALL_SPAWN_HEIGHT, z)
    assert.equal(fireballReaches(bot, from(0.5, 64, -3)), false)
    assert.equal(fireballReaches(bot, from(0.5, 63, -5)), false)
    assert.equal(fireballReaches(bot, from(0.5, 66, -3)), true)
    assert.equal(fireballReaches(bot, from(6.5, 66, 5.5)), false)
  } finally {
    restore()
  }
})

test('fightFromNook in a bunker with its rods goes on till it\'s quiet to go out (bunkerDepartDue: BUNKER_FETCH_BLAZES about at the most)', async () => {
  const { entity } = await import('../reflexes/fakeBot')
  const { fightFromNook, BUNKER_FETCH_BLAZES } = await import('../../src/nether/blazeFight')
  // behind it, out of its slit's sight
  const blazes = [0, 1, 2].map(i => entity({ name: 'blaze', position: new Vec3(i - 1 + 0.5, 64, 9.5), meta: { health: 20, flags: 0 } }))
  assert.equal(blazes.length, BUNKER_FETCH_BLAZES + 1)
  const { bot, b, restore } = await bunkerBot(blazes)
  const ac = new AbortController()
  try {
    let done = false
    const fight = fightFromNook(bot, b, { count: 0, spawner: new Vec3(0, 64, 0), maxTicks: 3000 }, ac.signal).then(() => { done = true }, err => { done = true; return err })
    await ticks(bot, 30)
    assert.equal(done, false)
    blazes[2].position = new Vec3(0.5, 64, 40)
    await ticks(bot, 10)
    assert.equal(done, true)
    await fight
  } finally {
    ac.abort()
    restore()
  }
})

test('lightFromBunker: out by the sill, the planned torches put (LIGHT_TRIP_TORCHES at the most), back in and the sill put again; with more than LIGHT_TRIP_BLAZES blazes about, none put, back in at once', async () => {
  const { entity } = await import('../reflexes/fakeBot')
  const { lightFromBunker, LIGHT_TRIP_TORCHES, LIGHT_TRIP_BLAZES } = await import('../../src/nether/spawnerLight')
  const { item } = await import('../reflexes/fakeBot')
  const run = async (blazes: number): Promise<{ placed: string[], torches: number, sillBack: boolean }> => {
    const far = Array.from({ length: blazes }, (_, i) => entity({ name: 'blaze', position: new Vec3(i, 66, -8), meta: { health: 20 } }))
    const { bot, b, filled, placed, restore } = await bunkerBot(far, [item('torch', 16)])
    const ticking = setInterval(() => { for (let k = 0; k < 20; k++) bot.emit('physicsTick') }, 1)
    try {
      await lightFromBunker(bot, b, new Vec3(0, 64, 0), 16)
    } finally {
      clearInterval(ticking)
      restore()
    }
    return { placed, torches: placed.filter(p => !b.walls.some((w: Vec3) => w.toString() === p)).length, sillBack: filled.has(b.bunker.sill.toString()) }
  }
  const quiet = await run(0)
  assert.ok(quiet.torches > 0 && quiet.torches <= LIGHT_TRIP_TORCHES, quiet.placed.join(' '))
  assert.equal(quiet.sillBack, true)
  const busy = await run(LIGHT_TRIP_BLAZES + 1)
  assert.equal(busy.torches, 0, busy.placed.join(' '))
  assert.equal(busy.sillBack, true)
})

test('bunkerFires: the fires in front of the slit within reach that the eyes see, nearest first; not one under the sill, behind a wall of the bunker nor one out of reach', async () => {
  const { bunkerFires } = await import('../../src/nether/blazeFight')
  // (one on the floor just past the sill is under its line of sight: the sill hides it)
  const fires = { '(0, 64, 3)': 'fire', '(1, 64, 2)': 'fire', '(0, 64, 1)': 'fire', '(0, 64, 7)': 'fire', '(0, 64, -3)': 'fire' }
  const { bot, b, restore } = await bunkerBot([], [], fires)
  try {
    assert.deepEqual(bunkerFires(bot, b).map(String), ['(1, 64, 2)', '(0, 64, 1)'])
  } finally {
    restore()
  }
})

test('fightFromNook in a bunker: a charged blaze whose shot line reaches the bot is a danger though the ray to its eyes says it sees nothing (a fence in the way): the shield up, no errand out', async () => {
  const { entity } = await import('../reflexes/fakeBot')
  const { fightFromNook, blazeSeesBot } = await import('../../src/nether/blazeFight')
  const blaze = entity({ name: 'blaze', position: new Vec3(0.5, 66.5, -3.5), meta: { health: 20, flags: 1 } })
  const { bot, b, restore } = await bunkerBot([blaze])
  // the ray from its eyes (feet + 1.53) taken as blocked, its fireball's (feet + 1.4) not
  const ray = bot.world.raycast
  bot.world.raycast = (from: Vec3, dir: Vec3, range: number) => Math.abs(from.y - (blaze.position.y + 1.53)) < 1e-6 ? { position: from.floored(), intersect: from.plus(dir.scaled(0.5)), boundingBox: 'block', name: 'nether_brick_fence' } : ray(from, dir, range)
  let errands = 0
  const ac = new AbortController()
  try {
    assert.equal(blazeSeesBot(bot, blaze), false)
    const done = fightFromNook(bot, b, { count: 1, spawner: new Vec3(0, 64, 0), maxTicks: 3000, errand: async () => { errands++; return false } }, ac.signal).catch(err => err)
    await ticks(bot, 20)
    assert.equal(errands, 0)
    assert.equal(bot.usingHeldItem, true)
    ac.abort()
    await ticks(bot, 5)
    await done
  } finally {
    restore()
  }
})

test('fightFromNook in a bunker: a charged blaze whose shot line reaches the bot is a danger though the ray to its eyes says it sees nothing (a fence in the way): the shield up, no errand out', async () => {
  const { entity } = await import('../reflexes/fakeBot')
  const { fightFromNook, blazeSeesBot } = await import('../../src/nether/blazeFight')
  const blaze = entity({ name: 'blaze', position: new Vec3(0.5, 66.5, -3.5), meta: { health: 20, flags: 1 } })
  const { bot, b, restore } = await bunkerBot([blaze])
  // the ray from its eyes (feet + 1.53) taken as blocked, its fireball's (feet + 1.4) not
  const ray = bot.world.raycast
  bot.world.raycast = (from: Vec3, dir: Vec3, range: number) => Math.abs(from.y - (blaze.position.y + 1.53)) < 1e-6 ? { position: from.floored(), intersect: from.plus(dir.scaled(0.5)), boundingBox: 'block', name: 'nether_brick_fence' } : ray(from, dir, range)
  let errands = 0
  const ac = new AbortController()
  try {
    assert.equal(blazeSeesBot(bot, blaze), false)
    const done = fightFromNook(bot, b, { count: 1, spawner: new Vec3(0, 64, 0), maxTicks: 3000, errand: async () => { errands++; return false } }, ac.signal).catch(err => err)
    await ticks(bot, 20)
    assert.equal(errands, 0)
    assert.equal(bot.usingHeldItem, true)
    ac.abort()
    await ticks(bot, 5)
    await done
  } finally {
    restore()
  }
})

test('rodFloor: a blaze over the floor by the bunker drops its rod where the fetch goes; over a drop deeper than ROD_FALL, on lava, or out of BUNKER_DROP_REACH, nowhere', async () => {
  const { rodFloor, ROD_FALL } = await import('../../src/nether/blazeFight')
  const hole: Record<string, string> = {}
  for (let y = 63; y >= 63 - ROD_FALL - 2; y--) hole[`(3, ${y}, -2)`] = 'air'
  hole['(-3, 63, -2)'] = 'lava'
  const { bot, b, restore } = await bunkerBot([], [], hole)
  try {
    assert.deepEqual(rodFloor(bot, b, new Vec3(0.5, 66.2, -1.5)), new Vec3(0, 64, -2))
    assert.equal(rodFloor(bot, b, new Vec3(3.5, 65, -1.5)), null)
    assert.equal(rodFloor(bot, b, new Vec3(-2.5, 64, -1.5)), null)
    assert.equal(rodFloor(bot, b, new Vec3(0.5, 64, -9.5)), null)
  } finally {
    restore()
  }
})

test('walkDanger: a charged blaze that sees the bot, one at its side, or a fireball coming stops the walk into the bunker; a calm one off, or a charged one behind a wall, not', async () => {
  const { entity } = await import('../reflexes/fakeBot')
  const { walkDanger } = await import('../../src/nether/blazeFight')
  const blaze = entity({ name: 'blaze', position: new Vec3(0.5, 64, -6.5), meta: { health: 20, flags: 0 } })
  const { bot, restore } = await bunkerBot([blaze])
  try {
    assert.equal(walkDanger(bot), false)
    blaze.metadata[16] = 1
    assert.equal(walkDanger(bot), true)
    // behind the bunker's back wall
    blaze.position = new Vec3(0.5, 64, 9.5)
    assert.equal(walkDanger(bot), false)
    // calm, at its side through the slit's opening: within 2.5 and seeing it
    blaze.metadata[16] = 0
    blaze.position = new Vec3(0.5, 64.5, 3.4)
    assert.equal(walkDanger(bot), true)
  } finally {
    restore()
  }
})

test('fightFromNook in a bunker: a hole in its walls (a side wall gone) is put again, nothing about to shoot', async () => {
  const { fightFromNook } = await import('../../src/nether/blazeFight')
  const { bot, b, filled, placed, restore } = await bunkerBot([])
  const ac = new AbortController()
  try {
    filled.delete('(1, 65, 5)')
    const done = fightFromNook(bot, b, { count: 1, spawner: new Vec3(0, 64, 0), maxTicks: 3000 }, ac.signal).catch(err => err)
    await ticks(bot, 30)
    assert.deepEqual(placed, ['(1, 65, 5)'])
    ac.abort()
    await ticks(bot, 5)
    await done
  } finally {
    restore()
  }
})

test('bunkerFetchDue: a drop in the spawn volume is fetched with no blaze in sight at all; one out of it with one', async () => {
  const { entity } = await import('../reflexes/fakeBot')
  const ahead = entity({ name: 'blaze', position: new Vec3(0.5, 64, -6.5), meta: { health: 20 } })
  const { bot, b, restore } = await bunkerBot([ahead])
  try {
    const spawner = new Vec3(0, 64, -2)
    // (0.5, 64, 2.5): 4 off the spawner across, in its volume; with the spawner further, out of it
    assert.equal(bunkerFetchDue(bot, b, 20, () => true, false, new Vec3(0.5, 64, 2.5), spawner), false)
    assert.equal(bunkerFetchDue(bot, b, 20, () => true, false, new Vec3(0.5, 64, 2.5), new Vec3(0, 64, -10)), true)
    ahead.position = new Vec3(0.5, 66, -40)
    assert.equal(bunkerFetchDue(bot, b, 20, () => true, false, new Vec3(0.5, 64, 2.5), spawner), true)
  } finally {
    restore()
  }
})
