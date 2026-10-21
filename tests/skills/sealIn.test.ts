import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { cardinalToward, inBox, mobInCell, openCells, sealBox } from '../../src/skills/sealIn'
import { entity, fakeBot } from '../reflexes/fakeBot'

// a 1-wide tunnel along x, 2 high, in stone: the floor at y 63, the bot's feet at 64
const tunnel = (p: Vec3): string => p.z === 0 && p.y >= 64 && p.y <= 65 ? 'air' : 'stone'

test('sealBox: down a 1-wide tunnel the box is its two open ends, the front toward the zombie; in the open, the sides and the roof too', () => {
  const zombie = entity({ name: 'zombie', position: new Vec3(3.5, 64, 0.5) })
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), entities: [zombie], world: tunnel })
  const box = sealBox(bot, [zombie])
  assert.ok(box != null)
  assert.deepStrictEqual(box.facing, new Vec3(1, 0, 0))
  assert.deepStrictEqual(openCells(bot, box).map(String), ['(-1, 64, 0)', '(-1, 65, 0)', '(1, 64, 0)', '(1, 65, 0)'])
  // the front last
  assert.deepStrictEqual(box.front.map(String), ['(1, 64, 0)', '(1, 65, 0)'])
  // on open ground: the back and both sides at the feet and the head, a block over a wall for the roof to go
  // against, the roof, the front
  const open = fakeBot({ position: new Vec3(0.5, 64, 0.5), entities: [zombie] })
  const box2 = sealBox(open, [zombie])
  assert.ok(box2 != null)
  assert.strictEqual(openCells(open, box2).length, 10)
  // knocked a cell over: out of the box
  assert.strictEqual(inBox(bot, box), true)
  bot.entity.position = new Vec3(-0.4, 64, 0.5)
  assert.strictEqual(inBox(bot, box), false)
})

test('mobInCell: a zombie\'s box (0.6 wide) in the cell takes no block (Level.isUnobstructed); knocked back 0.9 it is out', () => {
  const cell = new Vec3(1, 64, 0)
  assert.strictEqual(mobInCell({ position: new Vec3(1.5, 64, 0.5), width: 0.6, height: 1.95 }, cell), true)
  assert.strictEqual(mobInCell({ position: new Vec3(2.2, 64, 0.5), width: 0.6, height: 1.95 }, cell), true)
  assert.strictEqual(mobInCell({ position: new Vec3(2.4, 64, 0.5), width: 0.6, height: 1.95 }, cell), false)
  assert.strictEqual(mobInCell({ position: new Vec3(1.5, 66, 0.5), width: 0.6, height: 1.95 }, cell), false)
  assert.deepStrictEqual(cardinalToward(new Vec3(0, 64, 0), new Vec3(0.2, 64, -3)), new Vec3(0, 0, -1))
})

test('sealBox: no box whose wall, roof or floor is an infested block (a fight in it wakes the nest: f5-26.3); the caves\' sealing and the hostiles\' wall-in take it so', () => {
  const zombie = entity({ name: 'zombie', position: new Vec3(3.5, 64, 0.5) })
  for (const cell of ['0,64,1', '0,66,0', '0,63,0', '-1,64,-1']) {
    const [x, y, z] = cell.split(',').map(Number)
    const world = (p: Vec3): string => p.x === x && p.y === y && p.z === z ? 'infested_stone' : tunnel(p)
    const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), entities: [zombie], world })
    const box = sealBox(bot, [zombie])
    // (a cell the box doesn't take in, beyond its back's corner, leaves it be)
    if (cell === '-1,64,-1') assert.ok(box != null, cell)
    else assert.strictEqual(box, null, `infested at ${cell}`)
  }
})
