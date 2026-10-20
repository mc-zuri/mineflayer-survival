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
