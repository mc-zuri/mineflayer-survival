import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import type { Pos } from '../../src/core/memory'
import { checkPortalFrame, portalFrame, type BlockInfo } from '../../src/nether/portal'
import { choosePortalSite, frameBuildOrder, otherLavaSource, portalEntrance } from '../../src/nether/portalSkills'
import { portalLinkOf, portalNote } from '../../src/nether/portalTravel'

const k = (p: Pos): string => `${p.x},${p.y},${p.z}`

test('frameBuildOrder: every block has a solid neighbour placed before it (or the ground), 10 obsidian and 3 corners', () => {
  const frame = portalFrame({ x: 0, y: 64, z: 0 }, 'x')
  const order = frameBuildOrder(frame)
  assert.equal(order.filter(p => p.item === 'obsidian').length, 10)
  assert.equal(order.filter(p => p.item === 'filler').length, 3)
  const solid = new Set<string>()
  for (let x = -2; x <= 6; x++) solid.add(k({ x, y: 63, z: 0 }))
  for (const p of order) {
    const sides = [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]
    assert.ok(sides.some(([dx, dy, dz]) => solid.has(k({ x: p.pos.x + dx, y: p.pos.y + dy, z: p.pos.z + dz }))), `nothing to place ${k(p.pos)} against`)
    solid.add(k(p.pos))
  }
  // what's placed is a frame PortalShape takes
  const world = new Map<string, BlockInfo>(order.map(p => [k(p.pos), { name: p.item === 'obsidian' ? 'obsidian' : 'cobblestone' }]))
  assert.equal(checkPortalFrame(p => world.get(k(p)) ?? { name: 'air' }, frame).valid, true)
})

test('choosePortalSite: flat clear ground near the bot, not over a hole or into a wall', () => {
  // stone below y 64, a wall at x 3, a hole at (-3, 63, 0)
  const get = (p: Pos): BlockInfo => {
    if (p.x === 3 && p.y >= 64 && p.y < 70) return { name: 'stone' }
    if (p.x === -3 && p.y === 63 && p.z === 0) return { name: 'air' }
    return { name: p.y < 64 ? 'stone' : 'air' }
  }
  const site = choosePortalSite(get, { x: 0.5, y: 64, z: 0.5 }, { radius: 6 })
  assert.ok(site != null)
  const frame = portalFrame(site.origin, site.axis)
  for (const p of [...frame.obsidian, ...frame.corners, ...frame.interior]) {
    assert.equal(get(p).name, 'air', `${k(p)} in the frame is taken`)
    if (p.y === site.origin.y) assert.equal(get({ ...p, y: p.y - 1 }).name, 'stone', `${k(p)} isn't on the ground`)
  }
  assert.equal(site.origin.y, 64)
  // the entrance is the inside's bottom middle
  const e = portalEntrance(frame)
  assert.equal(e.y, 65)
})

test('otherLavaSource: a source outside the frame; a palette block (no position) matches on the block alone', () => {
  const source = (position?: Vec3): any => ({ name: 'lava', getProperties: () => ({ level: 0 }), position })
  const match = otherLavaSource(new Set(['1,2,3']))
  assert.equal(match(source()), true)
  assert.equal(match(source(new Vec3(1, 2, 3))), false)
  assert.equal(match(source(new Vec3(4, 2, 3))), true)
  assert.equal(match({ name: 'lava', getProperties: () => ({ level: 2 }) }), false)
})

test('portal notes keep the link to the other side', () => {
  const note = portalNote('built', { dimension: 'the_nether', pos: new Vec3(12.7, 64, -3.2) })
  assert.equal(note, 'built;link=the_nether:12,64,-4')
  assert.deepEqual(portalLinkOf({ note }), { dimension: 'the_nether', pos: new Vec3(12, 64, -4) })
  assert.equal(portalLinkOf({ note: 'arrival' }), null)
})

test('choosePortalSite: rough ground near the bot, flat ground 12 blocks off found within 16 (buildPortal\'s second look)', () => {
  // rock up to y 70 for x < 10 (the bot in a cave mouth at x 0), level ground at y 64 from x 10 on
  const get = (p: Pos): BlockInfo => ({ name: p.x < 10 ? (p.y < 70 ? 'stone' : 'air') : (p.y < 64 ? 'stone' : 'air') })
  assert.equal(choosePortalSite(get, { x: 0.5, y: 64, z: 0.5 }), null)
  const site = choosePortalSite(get, { x: 0.5, y: 64, z: 0.5 }, { radius: 16 })
  assert.ok(site != null)
  assert.ok(site.origin.x >= 10)
})

test('portalSiteWork: the frame, its inside and a row each side dug, the ground under them filled', async () => {
  const { portalSiteWork } = await import('../../src/nether/portalSkills')
  // a cave: stone everywhere above y 64 but an air pocket, the floor at y 63 missing at x 1
  const get = (p: Pos): BlockInfo => ({ name: p.y < 64 ? (p.x === 1 && p.y === 63 ? 'air' : 'stone') : (p.y < 66 && p.x === 0 ? 'air' : 'stone') })
  const work = portalSiteWork(get, { x: 0, y: 64, z: 0 }, 'x')
  // 4 columns x 3 rows x 5 high, the air pocket at x 0, y 64 - 65 left out
  assert.equal(work.dig.length, 4 * 3 * 5 - 3 * 2)
  assert.deepEqual(work.fill.map(p => `${p.x},${p.y},${p.z}`).sort(), ['1,63,-1', '1,63,0', '1,63,1'])
})

test('chooseDigSite: the site with no liquid in it, the least work first', async () => {
  const { chooseDigSite } = await import('../../src/nether/portalSkills')
  // stone all round, water at z 2 - 4 (the first site's) 
  const get = (p: Pos): BlockInfo => ({ name: p.y < 64 ? 'stone' : (p.z >= 1 && p.z <= 4 && p.y < 67 ? 'water' : 'stone') })
  const site = chooseDigSite(get, new Vec3(0, 64, 0))
  assert.ok(site != null)
  assert.ok(!(site.axis === 'x' && site.origin.z === 2), JSON.stringify(site.origin))
  const wet = (p: Pos): BlockInfo => ({ name: p.y < 64 ? 'stone' : 'water' })
  assert.equal(chooseDigSite(wet, new Vec3(0, 64, 0)), null)
})

test('chooseDigSite for a cast by a deep pool: no site with lava beside or over a cell it digs (opened, the pool comes in); lava under one is none (f9-26.3, t347525: the site dug by the pool\'s side, the bot burned in it)', async () => {
  const { chooseDigSite, portalSiteWork } = await import('../../src/nether/portalSkills')
  // f9-26.3's deep pool: lava x -288 to -285, y -57 to -55, z -52 to -50, in deepslate; the bot by it at (-283, -59, -48)
  // in the room its work dug east of the pool (x -283 to -281, z -53 to -48, y -59 to -54), the pool's wall at x -284
  const pool = (p: Pos): boolean => p.x >= -288 && p.x <= -285 && p.y >= -57 && p.y <= -55 && p.z >= -52 && p.z <= -50
  const room = (p: Pos): boolean => p.x >= -283 && p.x <= -281 && p.z >= -53 && p.z <= -48 && p.y >= -59 && p.y <= -54
  const get = (p: Pos): BlockInfo => ({ name: pool(p) ? 'lava' : room(p) ? 'air' : 'deepslate' })
  const touches = (p: Pos): boolean => [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]].some(([dx, dy, dz]) => pool({ x: p.x + dx, y: p.y + dy, z: p.z + dz }))
  const feet = new Vec3(-283, -59, -48)
  // the site the dig took before, the least work (along x, 3 north: the room's and the wall at x -284, against the
  // pool's side at -285)
  const north = portalSiteWork(get, feet.offset(-1, 0, -3), 'x', true)
  assert.ok(north.dig.some(touches) && north.dig.length === 30, String(north.dig.length))
  const site = chooseDigSite(get, feet, true)
  assert.ok(site != null)
  assert.ok(!site.work.dig.some(touches), JSON.stringify(site.origin))
  // lava under the site's ground only: it stays there (no flow up)
  const under = (p: Pos): BlockInfo => ({ name: p.y < -60 ? 'lava' : 'deepslate' })
  assert.ok(chooseDigSite(under, new Vec3(0, -59, 0), true) != null)
})

test('portalSiteWork for a cast: 6 high and two rows each side (the mould behind, the pours before)', async () => {
  const { portalSiteWork } = await import('../../src/nether/portalSkills')
  const stone = (p: Pos): BlockInfo => ({ name: p.y < 64 ? 'stone' : 'stone' })
  const placed = portalSiteWork(stone, { x: 0, y: 64, z: 0 }, 'x')
  const cast = portalSiteWork(stone, { x: 0, y: 64, z: 0 }, 'x', true)
  assert.equal(placed.dig.length, 4 * 3 * 5)
  assert.equal(cast.dig.length, 4 * 5 * 6)
})

test('castFrame: a lava source the bucket finds no spot to reach is passed over for the pool\'s next nearest', async () => {
  const bucketModule = require('../../src/skills/bucket')
  const { SkillError } = await import('../../src/skills/errors')
  const { castFrame } = await import('../../src/nether/portalSkills')
  const { planLavaCast } = await import('../../src/nether/portal')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const bot: any = fakeBot({ position: new Vec3(0.5, 64, 2.5), items: [item('water_bucket', 1), item('bucket', 1), item('cobblestone', 64)] })
  const lavaAt = (p: any): boolean => p.y === 60 && p.x >= 20 && p.x < 24 && p.z >= 0 && p.z < 3
  const realAt = bot.blockAt.bind(bot)
  bot.blockAt = (p: any) => lavaAt(p) ? { ...realAt(p), position: new Vec3(p.x, p.y, p.z), name: 'lava', getProperties: () => ({ level: 0 }), metadata: 0 } : realAt(p)
  bot.findBlocks = (opts: any) => {
    const out: any[] = []
    for (let x = 20; x < 24; x++) for (let z = 0; z < 3; z++) { const p = new Vec3(x, 60, z); if (opts.matching(bot.blockAt(p))) out.push(p) }
    return out
  }
  const lava: Pos[] = []
  for (let x = 20; x < 24; x++) for (let z = 0; z < 3; z++) lava.push({ x, y: 60, z })
  const plan = planLavaCast((p: Pos) => { const b = bot.blockAt(new Vec3(p.x, p.y, p.z)); return b == null ? null : { name: b.name, properties: { level: 0 } } }, lava, { origin: { x: 0, y: 64, z: 0 }, axis: 'x' })
  // the plan's first fill alone (the rest is the cast's own tests')
  const first = plan?.steps.find(s => s.kind === 'fill_lava') as any
  assert.ok(first != null)
  const tried: string[] = []
  const real = bucketModule.fillBucket
  bucketModule.fillBucket = async (_b: unknown, a: any) => {
    tried.push(a.pos.toString())
    if (tried.length === 1) throw new SkillError('NO_PATH', 'no spot found to see it from')
    throw new Error('done')
  }
  try {
    await assert.rejects(castFrame(bot, { ...(plan as any), stand: [bot.entity.position.floored()], steps: [first] }), /done/)
  } finally {
    bucketModule.fillBucket = real
  }
  assert.equal(tried.length, 2)
  assert.equal(tried[0], new Vec3(first.pos.x, first.pos.y, first.pos.z).toString())
  assert.notEqual(tried[1], tried[0])
})

test('castFrame keeps the mould\'s, the frame\'s and its inside\'s cells from the walks while it works (keepCastCells: none broken, stood in or built in), released after (tests/integration/portalSite: a hole in the mould where the bot climbed it, no face to pour the top\'s lava against)', async () => {
  const bucketModule = require('../../src/skills/bucket')
  const { castFrame, keepCastCells } = await import('../../src/nether/portalSkills')
  const { planLavaCast } = await import('../../src/nether/portal')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const bot: any = fakeBot({ position: new Vec3(0.5, 64, 2.5), items: [item('water_bucket', 1), item('bucket', 1), item('cobblestone', 64)] })
  let settings: any = { exclusionAreasBreak: [], exclusionAreasStep: [], exclusionAreasPlace: [] }
  bot.pathfinder = { get defaultMoveSettings () { return settings }, setMoveOptions: (s: any) => { settings = s } }
  const lavaAt = (p: any): boolean => p.y === 60 && p.x >= 20 && p.x < 24 && p.z >= 0 && p.z < 3
  const realAt = bot.blockAt.bind(bot)
  bot.blockAt = (p: any) => lavaAt(p) ? { ...realAt(p), position: new Vec3(p.x, p.y, p.z), name: 'lava', getProperties: () => ({ level: 0 }), metadata: 0 } : realAt(p)
  const lava: Pos[] = []
  for (let x = 20; x < 24; x++) for (let z = 0; z < 3; z++) lava.push({ x, y: 60, z })
  const plan = planLavaCast((p: Pos) => { const b = bot.blockAt(new Vec3(p.x, p.y, p.z)); return b == null ? null : { name: b.name, properties: { level: 0 } } }, lava, { origin: { x: 0, y: 64, z: 0 }, axis: 'x' })
  assert.ok(plan != null)
  const first = plan.steps.find(s => s.kind === 'fill_lava') as any
  const cost = (list: any[], p: Pos): number => list.reduce((n, f) => n + f({ position: p }), 0)
  const mould = plan.scaffold[3]
  const corner = plan.frame.obsidian[0]
  const inside = plan.frame.interior[0]
  const seen: number[] = []
  const real = bucketModule.fillBucket
  bucketModule.fillBucket = async () => {
    for (const p of [mould, corner, inside]) seen.push(cost(settings.exclusionAreasBreak, p), cost(settings.exclusionAreasStep, p), cost(settings.exclusionAreasPlace, p))
    // a cell in front of the frame, the bot's stand: free
    seen.push(cost(settings.exclusionAreasStep, { x: 1, y: 64, z: 2 }))
    throw new Error('done')
  }
  try {
    await assert.rejects(castFrame(bot, { ...(plan as any), stand: [bot.entity.position.floored()], steps: [first] }), /done/)
  } finally {
    bucketModule.fillBucket = real
  }
  assert.deepEqual(seen, [1e9, 1e9, 1e9, 1e9, 1e9, 1e9, 1e9, 1e9, 1e9, 0])
  // released
  assert.equal(settings.exclusionAreasBreak.length + settings.exclusionAreasStep.length + settings.exclusionAreasPlace.length, 0)
  // with no pathfinder, nothing
  assert.doesNotThrow(() => keepCastCells(fakeBot(), [new Vec3(0, 64, 0)])())
})

test('preparePortalSite makes a pickaxe from what is carried first when the bag has none', async () => {
  const exploreModule = require('../../src/executor/explore')
  const collectModule = require('../../src/skills/collectBlock')
  const { preparePortalSite } = await import('../../src/nether/portalSkills')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  // stone to y 67 (a cave's rock), the bot in a cell of air
  const bot: any = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [item('cobblestone', 16), item('stick', 2)], world: (p: Vec3) => (p.x === 0 && p.z === 0 && (p.y === 64 || p.y === 65)) ? 'air' : p.y <= 67 ? 'stone' : 'air' })
  const calls: string[] = []
  const real = [exploreModule.ensurePickaxe, collectModule.collectBlock]
  exploreModule.ensurePickaxe = async () => { calls.push('ensurePickaxe'); return 'stone_pickaxe' }
  collectModule.collectBlock = async () => { calls.push('collectBlock'); throw new Error('stop here') }
  try {
    await preparePortalSite(bot).catch(() => {})
  } finally {
    [exploreModule.ensurePickaxe, collectModule.collectBlock] = real
  }
  assert.deepEqual(calls.slice(0, 2), ['ensurePickaxe', 'collectBlock'])
})

test('preparePortalSite fills the ground holes its own digging walks made, not only those there before', async () => {
  const collectModule = require('../../src/skills/collectBlock')
  const placeModule = require('../../src/skills/placeBlock')
  const exploreModule = require('../../src/executor/explore')
  const { preparePortalSite } = await import('../../src/nether/portalSkills')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const air = new Set<string>()
  const world = (p: Vec3): string => air.has(p.toString()) ? 'air' : (p.x === 0 && p.z === 0 && (p.y === 64 || p.y === 65)) ? 'air' : p.y <= 69 ? 'stone' : 'air'
  const bot: any = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [item('stone_pickaxe', 1), item('cobblestone', 64)], world })
  const placed: string[] = []
  const real = [collectModule.collectBlock, placeModule.placeBlock, exploreModule.ensurePickaxe]
  let first: Vec3 | null = null
  collectModule.collectBlock = async (_b: unknown, a: any) => {
    for (const p of a.positions) air.add(p.toString())
    // the first dig's walk took a block of the ground under the cell dug
    if (first == null) { first = a.positions[0].offset(0, -1, 0); air.add(first.toString()) }
    while (first != null && first.y > 63 && air.has(first.toString())) { first = first.offset(0, -1, 0); air.add(first.toString()) }
    return { mined: a.positions.length }
  }
  placeModule.placeBlock = async (_b: unknown, a: any) => { placed.push(a.pos.toString()); air.delete(a.pos.toString()); return { pos: a.pos, placed: true } }
  exploreModule.ensurePickaxe = async () => 'stone_pickaxe'
  try {
    await preparePortalSite(bot, undefined, true).catch(() => {})
  } finally {
    [collectModule.collectBlock, placeModule.placeBlock, exploreModule.ensurePickaxe] = real
  }
  assert.ok(first != null)
  assert.ok(placed.length > 0, 'the hole the dig made filled')
})

test('castFrame: a deep pool\'s fill takes a source open to the air, not one under its top layer', async () => {
  const bucketModule = require('../../src/skills/bucket')
  const { castFrame } = await import('../../src/nether/portalSkills')
  const { planLavaCast } = await import('../../src/nether/portal')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const bot: any = fakeBot({ position: new Vec3(0.5, 64, 2.5), items: [item('water_bucket', 1), item('bucket', 1), item('cobblestone', 64)] })
  const lavaAt = (p: any): boolean => (p.y === 60 || p.y === 61) && p.x >= 20 && p.x < 24 && p.z >= 0 && p.z < 3
  const realAt = bot.blockAt.bind(bot)
  bot.blockAt = (p: any) => lavaAt(p) ? { ...realAt(p), position: new Vec3(p.x, p.y, p.z), name: 'lava', getProperties: () => ({ level: 0 }), metadata: 0 } : realAt(p)
  bot.findBlocks = (opts: any) => {
    const out: any[] = []
    for (let x = 20; x < 24; x++) for (let z = 0; z < 3; z++) for (const y of [60, 61]) { const p = new Vec3(x, y, z); if (opts.matching(bot.blockAt(p))) out.push(p) }
    return out
  }
  // the plan's sources the bottom layer's (as the nearest to the site might be)
  const bottom: Pos[] = []
  for (let x = 20; x < 24; x++) for (let z = 0; z < 3; z++) bottom.push({ x, y: 60, z })
  const plan = planLavaCast((p: Pos) => { const b = bot.blockAt(new Vec3(p.x, p.y, p.z)); return b == null ? null : { name: b.name, properties: { level: 0 } } }, bottom, { origin: { x: 0, y: 64, z: 0 }, axis: 'x' })
  const first = plan?.steps.find(s => s.kind === 'fill_lava') as any
  assert.ok(first != null && first.pos.y === 60)
  const tried: any[] = []
  const real = bucketModule.fillBucket
  bucketModule.fillBucket = async (_b: unknown, a: any) => { tried.push(a.pos); throw new Error('done') }
  try {
    await assert.rejects(castFrame(bot, { ...(plan as any), stand: [bot.entity.position.floored()], steps: [first] }), /done/)
  } finally {
    bucketModule.fillBucket = real
  }
  assert.equal(tried[0].y, 61)
})

test('placeFrame: a block left inside the frame (cobblestone) dug out after the obsidian is placed (f3-1.21.11: \'the frame isn\'t ready\', cobblestone inside, three times)', async () => {
  const { placeFrame } = await import('../../src/nether/portalSkills')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const place = require('../../src/skills/placeBlock')
  const collect = require('../../src/skills/collectBlock')
  const frame = portalFrame({ x: 0, y: 64, z: 0 }, 'x')
  const cells = new Map<string, string>()
  const key = (p: any): string => `${p.x},${p.y},${p.z}`
  const inside = frame.interior[1]
  cells.set(key(inside), 'cobblestone')
  const bot = fakeBot({ position: new Vec3(0.5, 64, 2.5), items: [item('obsidian', 10), item('cobblestone', 16)], world: p => cells.get(key(p)) ?? (p.y < 64 ? 'stone' : 'air') })
  const real = { place: place.placeBlock, collect: collect.collectBlock }
  const dug: string[] = []
  place.placeBlock = async (_b: any, args: any) => { cells.set(key(args.pos), args.item) }
  collect.collectBlock = async (_b: any, args: any) => { for (const p of args.positions) { dug.push(key(p)); cells.set(key(p), 'air') } }
  try {
    await placeFrame(bot, frame)
  } finally {
    place.placeBlock = real.place
    collect.collectBlock = real.collect
  }
  assert.deepEqual(dug, [key(inside)])
  const getBlock = (p: Pos): BlockInfo | null => { const n = cells.get(key(p)) ?? (p.y < 64 ? 'stone' : 'air'); return { name: n, boundingBox: n === 'air' ? 'empty' : 'block' } as any }
  assert.equal(checkPortalFrame(getBlock, frame).valid, true)
})

test('fillerSolid: a filler\'s or a mould\'s place that left another solid block there serves; obsidian, a fluid or air there, or another error, not (f3-1.21.11: \'andesite is at (-77, 66, 136) after placing cobblestone\')', async () => {
  const { fillerSolid } = await import('../../src/nether/portalSkills')
  const { SkillError } = await import('../../src/skills/errors')
  const verify = new SkillError('VERIFY_FAILED', 'andesite is at (-77, 66, 136) after placing cobblestone')
  assert.equal(fillerSolid(verify, { name: 'andesite', boundingBox: 'block' } as any), true)
  assert.equal(fillerSolid(verify, { name: 'air', boundingBox: 'empty' } as any), false)
  assert.equal(fillerSolid(verify, { name: 'obsidian', boundingBox: 'block' } as any), false)
  assert.equal(fillerSolid(new SkillError('CANNOT_PLACE', 'no face'), { name: 'andesite', boundingBox: 'block' } as any), false)
})

test('placeFrame: a corner whose cobblestone came down as andesite goes on (the frame built)', async () => {
  const { placeFrame } = await import('../../src/nether/portalSkills')
  const { SkillError } = await import('../../src/skills/errors')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const place = require('../../src/skills/placeBlock')
  const frame = portalFrame({ x: 0, y: 64, z: 0 }, 'x')
  const cells = new Map<string, string>()
  const key = (p: any): string => `${p.x},${p.y},${p.z}`
  const bot = fakeBot({ position: new Vec3(0.5, 64, 2.5), items: [item('obsidian', 10), item('cobblestone', 16)], world: p => cells.get(key(p)) ?? (p.y < 64 ? 'stone' : 'air') })
  const real = place.placeBlock
  let wrong = 0
  place.placeBlock = async (_b: any, args: any) => {
    if (args.item === 'cobblestone' && wrong === 0) { wrong++; cells.set(key(args.pos), 'andesite'); throw new SkillError('VERIFY_FAILED', `andesite is at ${args.pos} after placing cobblestone`) }
    cells.set(key(args.pos), args.item)
  }
  try {
    await placeFrame(bot, frame)
  } finally {
    place.placeBlock = real
  }
  assert.equal(wrong, 1)
  assert.ok(frame.obsidian.every(p => cells.get(key(p)) === 'obsidian'))
})
