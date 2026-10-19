import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { exitPortal } from '../../src/end/spikes'
import { exitPortalOpen, findPortalY, groundY, isVoidColumn, voidDistance, voidExclusion, VoidGuard, type BlockGetter } from '../../src/end/skills/world'
import { endIsland, world } from './endWorld'

test('groundY, the void columns and voidDistance on the island\'s edge', () => {
  const get = world(endIsland([], 20))
  assert.strictEqual(groundY(get, 0.5, 10.5), 62)
  assert.strictEqual(groundY(get, 0.5, 30.5), null)
  assert.ok(!isVoidColumn(get, 0, 10, 70))
  assert.ok(isVoidColumn(get, 0, 25, 70))
  assert.strictEqual(voidDistance(get, { x: 0.5, y: 62, z: 0.5 }, 6), Infinity)
  // (1, 20) is the first column off the disc (1 + 400 > 400)
  assert.strictEqual(voidDistance(get, { x: 0.5, y: 62, z: 18.5 }, 6), Math.hypot(1, 2))
  const guard = new VoidGuard(get, 3)
  guard.update(new Vec3(0.5, 62, 10.5), true)
  assert.deepStrictEqual(guard.lastSafe, new Vec3(0.5, 62, 10.5))
  guard.update(new Vec3(0.5, 62, 19.5), true)
  assert.deepStrictEqual(guard.lastSafe, new Vec3(0.5, 62, 10.5), 'too near the edge to count as safe')
  guard.update(new Vec3(0.5, 66, 24.5), false)
  assert.ok(guard.overVoid)
  assert.ok(guard.risky({ x: 0.5, y: 62, z: 19.5 }))
  const exclude = voidExclusion(get)
  assert.strictEqual(exclude({ position: new Vec3(0, 62, 10) }), 0)
  assert.ok(exclude({ position: new Vec3(0, 62, 25) }) >= 1e6)
})

test('the exit portal: its y from the bedrock pillar, open once end_portal fills it', () => {
  const blocks = endIsland([], 30)
  const get = world(blocks)
  assert.strictEqual(findPortalY(get), 62)
  const portal = exitPortal(62)
  assert.ok(!exitPortalOpen(get, portal))
  for (const p of portal.portal) blocks.set(`${p.x},${p.y},${p.z}`, 'end_portal')
  assert.ok(exitPortalOpen(get, portal))
})

test('isVoidColumn: in the overworld under y 0 a column is not void (the scan starts below where it would end)', () => {
  const get: BlockGetter = (pos) => ({ name: pos.y < -61 ? 'stone' : 'air', boundingBox: pos.y < -61 ? 'block' : 'empty' })
  assert.ok(!isVoidColumn(get, 0, 0, -60, 0))
  assert.ok(!isVoidColumn(get, 0, 0, -60, -64))
  assert.ok(!voidExclusion(get, -64)({ position: new Vec3(0, -60, 0) }))
})

test('the pillars are built of any full block in the bag: deepslate, andesite, diorite, granite and the island\'s end stone count', async () => {
  const { SCAFFOLD_ITEMS, towerUp } = await import('../../src/end/skills/world')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  for (const n of ['cobblestone', 'cobbled_deepslate', 'andesite', 'diorite', 'granite', 'end_stone', 'dirt']) assert.ok(SCAFFOLD_ITEMS.includes(n), n)
  // 12 cobblestone and 42 of the rest: enough for 18 up (the count before the climb)
  const bot = fakeBot({ position: new (require('vec3').Vec3)(0.5, 64, 0.5), items: [item('cobblestone', 12), item('cobbled_deepslate', 19), item('andesite', 11), item('diorite', 5), item('granite', 7)] })
  await assert.rejects(towerUp(bot, 82), (err: any) => !/blocks to pillar up/.test(err.message))
  const poor = fakeBot({ position: new (require('vec3').Vec3)(0.5, 64, 0.5), items: [item('cobblestone', 12)] })
  await assert.rejects(towerUp(poor, 82), /18 blocks to pillar up, 12 in the inventory/)
})
