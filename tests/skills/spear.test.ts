// The spear's charge (skills/spear): the holders found, their mounts, the reflex's choice, the step aside.
import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { SPEAR_GUARD, holdsSpear, mountOf, sidestepPoint, spearThreats } from '../../src/skills/spear'
import { hostilesReflex } from '../../src/reflexes/rules'
import { ReflexEngine } from '../../src/reflexes/engine'
import { entity, fakeBot, item } from '../reflexes/fakeBot'

const V = '26.1'

function rider (x: number, mounted = true): { zombie: any, horse: any | null } {
  const zombie = entity({ name: 'zombie', position: new Vec3(0.5 + x, mounted ? 65.2 : 64, 0.5), version: V })
  zombie.heldItem = { name: 'iron_spear' }
  const horse = mounted ? entity({ name: 'zombie_horse', position: new Vec3(0.5 + x, 64, 0.5), version: V }) : null
  if (horse != null) zombie.vehicle = horse
  return { zombie, horse }
}

test('a spear holder found within SPEAR_WATCH, its mount by its vehicle or the box under it; none with a sword', () => {
  const { zombie, horse } = rider(6)
  assert.strictEqual(holdsSpear(zombie), true)
  const bot = fakeBot({ entities: [zombie, horse], version: V })
  assert.deepStrictEqual(spearThreats(bot).map(e => e.id), [zombie.id])
  assert.strictEqual(mountOf(bot, zombie)?.id, horse.id)
  delete zombie.vehicle
  assert.strictEqual(mountOf(bot, zombie)?.id, horse.id)
  const swordsman = entity({ name: 'zombie', position: new Vec3(3.5, 64, 0.5), version: V })
  swordsman.heldItem = { name: 'iron_sword' }
  assert.deepStrictEqual(spearThreats(fakeBot({ entities: [swordsman], version: V })), [])
})

test('hostiles reflex: a mounted spear zombie in sight within SPEAR_GUARD and 4 met first: the shield with one, a dodge without (f7-26.3: speared from 12.4 to 2.1 in one charge)', () => {
  const check = (input: any): string | null => {
    const bot = fakeBot({ version: V, ...input })
    const engine = new ReflexEngine(bot, { enabled: false })
    const task = hostilesReflex.check(engine.context())
    engine.stop()
    return task?.detail ?? null
  }
  const { zombie, horse } = rider(SPEAR_GUARD)
  assert.strictEqual(check({ items: [item('diamond_sword', 1, undefined, V)], offhand: item('shield', 1, undefined, V), entities: [zombie, horse] }), 'shield spear zombie')
  assert.strictEqual(check({ items: [item('diamond_sword', 1, undefined, V)], entities: [zombie, horse] }), 'dodge spear zombie')
  // far off: not yet
  const far = rider(SPEAR_GUARD + 7)
  assert.notStrictEqual(check({ items: [item('diamond_sword', 1, undefined, V)], entities: [far.zombie, far.horse] }), 'dodge spear zombie')
})

test('sidestepPoint: square to the rider\'s line, on the side its run isn\'t heading', () => {
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5) })
  const { zombie } = rider(6)
  zombie.velocity = new Vec3(-0.6, 0, 0.2)
  const p = sidestepPoint(bot, zombie)
  assert.ok(p != null)
  assert.ok(Math.abs(p.x - 0.5) < 1e-6, String(p))
  assert.ok(p.z < 0.5, `away from its drift +z: ${p.toString()}`)
})
