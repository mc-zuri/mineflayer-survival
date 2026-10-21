// The sugar cane farm and the canes seen, without a server.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { WorldMemory } from '../../src/core/memory'
import { fakeBot, item } from '../reflexes/fakeBot'

/** grass at y 62, water at x 6 and 9; cane columns (x: height) on the grass at z 0 from y 63 */
function caneBot (columns: Record<number, number>): any {
  const cane = (p: Vec3): boolean => p.z === 0 && columns[p.x] != null && p.y >= 63 && p.y < 63 + columns[p.x]
  const bot = fakeBot({ position: new Vec3(0.5, 63, 0.5), world: p => cane(p) ? 'sugar_cane' : p.y > 62 ? 'air' : p.y === 62 && (p.x === 6 || p.x === 9) && p.z === 0 ? 'water' : 'grass_block' })
  bot.game.dimension = 'overworld'
  const all: Vec3[] = []
  for (const [x, h] of Object.entries(columns)) for (let y = 63; y < 63 + h; y++) all.push(new Vec3(Number(x), y, 0))
  bot.findBlocks = () => all.slice()
  return bot
}

test('rememberCanes: each column with a block to cut noted at its cut, a column of one not; the ones remembered with nothing to cut now forgotten', async () => {
  const { rememberCanes } = await import('../../src/skills/caneFarm')
  const bot = caneBot({ 5: 3, 8: 1, 10: 2 })
  const memory = new WorldMemory()
  // remembered before: a column since cut to its bottom (8), a cane gone (12), and one far off out of the chunks loaded
  memory.rememberBlock('sugar_cane', { x: 8, y: 64, z: 0 })
  memory.rememberBlock('sugar_cane', { x: 12, y: 64, z: 0 })
  memory.rememberBlock('sugar_cane', { x: 300, y: 64, z: 0 })
  const loaded = bot.blockAt
  bot.blockAt = (p: Vec3) => p.x > 200 ? null : loaded(p)
  assert.equal(rememberCanes(bot, memory, 400), 2)
  const known = memory.findBlocks('sugar_cane').map(b => `${b.x},${b.y}`).sort()
  assert.deepEqual(known, ['10,64', '300,64', '5,64'])
  // none noted out of the overworld
  bot.game.dimension = 'the_nether'
  assert.equal(rememberCanes(bot, new WorldMemory()), 0)
})

/** a world of grass at y 63 (dirt under it) with blocks set over it */
function flatWorld (set: Map<string, string> = new Map()): (p: Vec3) => { name: string } {
  return (p: Vec3) => ({ name: set.get(`${p.x},${p.y},${p.z}`) ?? (p.y > 63 ? 'air' : p.y === 63 ? 'grass_block' : 'dirt') })
}

test('caneChannelSite: a row of 9 in level grass with grass banks and solid ends, the nearest; none on stone, none through the avoided', async () => {
  const { caneChannelSite, CANE_CHANNEL_LENGTH } = await import('../../src/skills/caneFarm')
  const site = caneChannelSite(flatWorld(), new Vec3(0.5, 64, 0.5))
  assert.ok(site != null)
  assert.equal(site.cells.length, CANE_CHANNEL_LENGTH)
  assert.equal(site.banks.length, 2 * CANE_CHANNEL_LENGTH)
  assert.ok(site.cells.every(c => c.y === 63))
  // in a row, none under the bot
  const dx = site.cells[1].x - site.cells[0].x
  const dz = site.cells[1].z - site.cells[0].z
  assert.equal(Math.abs(dx) + Math.abs(dz), 1)
  assert.ok(site.cells.every(c => !(Math.abs(c.x) <= 1 && Math.abs(c.z) <= 1)))
  // banks beside the cells, not on them
  assert.ok(site.banks.every(b => !site.cells.some(c => c.equals(b)) && site.cells.some(c => c.distanceTo(b) === 1)))
  assert.equal(caneChannelSite((p: Vec3) => ({ name: p.y > 63 ? 'air' : 'stone' }), new Vec3(0, 64, 0)), null)
  // the avoided (the base's walls) left out
  const avoided = caneChannelSite(flatWorld(), new Vec3(0.5, 64, 0.5), { avoid: p => p.x > -10 })
  assert.ok(avoided != null && [...avoided.cells, ...avoided.banks].every(p => p.x <= -10))
})

test('the cane farm kept in the memory: its spots; an old one, the canes about its point', async () => {
  const { knownCaneFarm, rememberCaneFarm } = await import('../../src/skills/caneFarm')
  const memory = new WorldMemory()
  assert.equal(knownCaneFarm(memory), null)
  rememberCaneFarm(memory, [new Vec3(3, 63, 0), new Vec3(3, 63, 2)])
  const farm = knownCaneFarm(memory)
  assert.deepEqual(farm?.spots.map(s => s.toString()), ['(3, 63, 0)', '(3, 63, 2)'])
  assert.equal(memory.getPois('cane_farm').length, 1)
  // planted before the spots were kept (canes=2): the canes standing about it
  const old = new WorldMemory()
  old.addPoi('cane_farm', { x: 5, y: 64, z: 0 }, 'overworld', 'canes=2')
  const set = new Map([['5,64,0', 'sugar_cane'], ['7,64,0', 'sugar_cane'], ['7,65,0', 'sugar_cane']])
  assert.deepEqual(knownCaneFarm(old, flatWorld(set))?.spots.map(s => s.toString()).sort(), ['(5, 63, 0)', '(7, 63, 0)'])
})

test('grownCanes and emptyCaneSpots: the second block of each column of 2 or more, and the spots by water with none', async () => {
  const { grownCanes, emptyCaneSpots } = await import('../../src/skills/caneFarm')
  // water at x 4, z 0..2; spots at x 3: z 0 a column of 3, z 1 of 1, z 2 none
  const set = new Map([['4,63,0', 'water'], ['4,63,1', 'water'], ['4,63,2', 'water'], ['3,64,0', 'sugar_cane'], ['3,65,0', 'sugar_cane'], ['3,66,0', 'sugar_cane'], ['3,64,1', 'sugar_cane']])
  const farm = { at: new Vec3(3, 64, 0), spots: [new Vec3(3, 63, 0), new Vec3(3, 63, 1), new Vec3(3, 63, 2)] }
  assert.deepEqual(grownCanes(flatWorld(set), farm).map(p => p.toString()), ['(3, 65, 0)'])
  assert.deepEqual(emptyCaneSpots(flatWorld(set), farm).map(p => p.toString()), ['(3, 63, 2)'])
})

async function stubbed<T> (stubs: Array<[string, string, any]>, fn: () => Promise<T>): Promise<T> {
  const saved = stubs.map(([mod, name]) => [require(mod), name, require(mod)[name]] as const)
  for (const [mod, name, fake] of stubs) require(mod)[name] = fake
  try {
    return await fn()
  } finally {
    for (const [m, name, real] of saved) m[name] = real
  }
}

/** a fake bot on flat grass whose digs, pours and placings change its world */
function farmBot (items: any[]): { bot: any, set: Map<string, string>, poured: Vec3[] } {
  const set = new Map<string, string>()
  const world = flatWorld(set)
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), items, world: p => world(p).name })
  bot.game.dimension = 'overworld'
  const poured: Vec3[] = []
  let look: Vec3 | null = null
  bot.equip = async () => {}
  bot.lookAt = async (p: Vec3) => { look = p.floored() }
  // the water poured where the look went, and along the dug cells in a row from it (7 on the flat)
  bot.activateItem = () => {
    if (look == null) return
    const at = look
    poured.push(at)
    set.set(`${at.x},${at.y},${at.z}`, 'water')
    for (const d of [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]) {
      let p = at.plus(d)
      for (let i = 1; i <= 7 && set.get(`${p.x},${p.y},${p.z}`) === 'air'; i++, p = p.plus(d)) set.set(`${p.x},${p.y},${p.z}`, 'water')
    }
    const bucket = bot.inventory.items().find((i: any) => i.name === 'water_bucket')
    if (bucket != null) { const b = item('bucket'); b.slot = bucket.slot; bot.inventory.slots[bucket.slot] = b }
  }
  return { bot, set, poured }
}

const dig = (set: Map<string, string>) => async (_b: any, args: any): Promise<any> => {
  for (const p of args.positions) set.set(`${p.x},${p.y},${p.z}`, 'air')
  return { mined: args.positions.length, positions: args.positions, items: {}, count: 0 }
}
const place = (set: Map<string, string>, bot: any) => async (_b: any, args: any): Promise<any> => {
  set.set(`${args.pos.x},${args.pos.y},${args.pos.z}`, 'sugar_cane')
  const c = bot.inventory.items().find((i: any) => i.name === 'sugar_cane')
  if (--c.count === 0) bot.inventory.slots[c.slot] = null
  return { pos: args.pos, block: 'sugar_cane', placed: true }
}

test('plantSugarCane with no water near: a channel dug and the bucket poured in its middle, a cane on each bank spot, the farm kept', async () => {
  const { plantSugarCane, knownCaneFarm, CANE_CHANNEL_LENGTH } = await import('../../src/skills/caneFarm')
  const { bot, set, poured } = farmBot([item('water_bucket'), item('sugar_cane', 12)])
  const memory = new WorldMemory()
  const res = await stubbed([
    ['../../src/skills/collectBlock', 'collectBlock', dig(set)],
    ['../../src/skills/navigate', 'navigateNear', async () => {}],
    ['../../src/skills/placeBlock', 'placeBlock', place(set, bot)]
  ], async () => await plantSugarCane(bot, { count: 12, center: new Vec3(0.5, 64, 0.5), memory }))
  assert.equal(res.water.length, CANE_CHANNEL_LENGTH)
  assert.equal(poured.length, 1)
  assert.equal(res.planted.length, 12)
  assert.ok(res.planted.every(p => set.get(`${p.x},${p.y},${p.z}`) === 'sugar_cane'))
  assert.equal(knownCaneFarm(memory)?.spots.length, 12)
})

test('tendCaneFarm: the grown canes cut above their bottom blocks, the empty spots planted again from the canes beyond the kept', async () => {
  const { tendCaneFarm } = await import('../../src/skills/caneFarm')
  const { bot, set } = farmBot([item('sugar_cane', 3)])
  for (let z = 0; z < 4; z++) set.set(`4,63,${z}`, 'water')
  // z 0 a column of 3, z 1 of 2, z 2 and 3 empty
  for (const k of ['3,64,0', '3,65,0', '3,66,0', '3,64,1', '3,65,1']) set.set(k, 'sugar_cane')
  const farm = { at: new Vec3(3, 64, 0), spots: [0, 1, 2, 3].map(z => new Vec3(3, 63, z)) }
  const cut: string[] = []
  const harvest = async (b: any, args: any): Promise<any> => {
    for (const p of args.positions) {
      cut.push(p.toString())
      for (let y = p.y; set.get(`${p.x},${y},${p.z}`) === 'sugar_cane'; y++) set.set(`${p.x},${y},${p.z}`, 'air')
    }
    const c = b.inventory.items().find((i: any) => i.name === 'sugar_cane')
    c.count += 3
    return { mined: args.positions.length, positions: args.positions, items: { sugar_cane: 3 }, count: 3 }
  }
  const res = await stubbed([
    ['../../src/skills/collectBlock', 'collectBlock', harvest],
    ['../../src/skills/placeBlock', 'placeBlock', place(set, bot)]
  ], async () => await tendCaneFarm(bot, farm, { keep: 5 }))
  assert.deepEqual(cut.sort(), ['(3, 65, 0)', '(3, 65, 1)'])
  assert.equal(res.canes, 3)
  // 6 held, 5 kept: one spot planted again
  assert.equal(res.replanted, 1)
  assert.equal(set.get('3,64,0'), 'sugar_cane')
  assert.equal(set.get('3,64,1'), 'sugar_cane')
})

test('plantSugarCane plants the banks of the channel it dug first, out to its radius: a channel by the edge of the cane ground has all its banks planted', async () => {
  const { plantSugarCane, CANE_FARM_SPOTS } = await import('../../src/skills/caneFarm')
  const { bot, set } = farmBot([item('water_bucket'), item('sugar_cane', 32)])
  // stone at y 63 but for grass x 12 to 40: the channel's site at the edge of the radius
  const ground = bot.blockAt
  bot.blockAt = (p: Vec3) => {
    const b = ground(p)
    return p.y === 63 && b.name === 'grass_block' && (p.x < 12 || p.x > 40) ? { ...b, name: 'stone', boundingBox: 'block' } : b
  }
  const res = await stubbed([
    ['../../src/skills/collectBlock', 'collectBlock', dig(set)],
    ['../../src/skills/navigate', 'navigateNear', async () => {}],
    ['../../src/skills/placeBlock', 'placeBlock', place(set, bot)]
  ], async () => await plantSugarCane(bot, { count: CANE_FARM_SPOTS, center: new Vec3(0.5, 64, 0.5), radius: 16 }))
  assert.equal(res.planted.length, CANE_FARM_SPOTS, res.planted.map(p => p.toString()).join(' '))
})

test('plantSugarCane: where the level grass takes no channel of 9 (a strip 7 long), a channel of CANE_SHORT_CHANNEL', async () => {
  const { plantSugarCane, CANE_SHORT_CHANNEL } = await import('../../src/skills/caneFarm')
  const { bot, set } = farmBot([item('water_bucket'), item('sugar_cane', 32)])
  // grass only in x 4 to 10, z -3 to 3: stone about it
  const ground = bot.blockAt
  bot.blockAt = (p: Vec3) => {
    const b = ground(p)
    return p.y === 63 && b.name === 'grass_block' && (p.x < 4 || p.x > 10 || Math.abs(p.z) > 3) ? { ...b, name: 'stone', boundingBox: 'block' } : b
  }
  const res = await stubbed([
    ['../../src/skills/collectBlock', 'collectBlock', dig(set)],
    ['../../src/skills/navigate', 'navigateNear', async () => {}],
    ['../../src/skills/placeBlock', 'placeBlock', place(set, bot)]
  ], async () => await plantSugarCane(bot, { count: 10, center: new Vec3(0.5, 64, 0.5) }))
  assert.equal(res.water.length, CANE_SHORT_CHANNEL)
  assert.equal(res.planted.length, 10)
})
