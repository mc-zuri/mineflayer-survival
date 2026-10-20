import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { aim, arrowStart } from '../../src/skills/shoot'
import { arrowHits } from '../../src/skills/arrow'
import { entityBox } from '../../src/skills/combatUtil'
import { entity, fakeBot, item } from '../reflexes/fakeBot'

test('aim at an end crystal entity from the bot: from the eye less 0.1, the arc entering its box', () => {
  const crystal = entity({ name: 'end_crystal', position: new Vec3(20.5, 65, 0.5) })
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), entities: [crystal] })
  assert.ok(Math.abs(arrowStart(bot).y - 65.52) < 1e-9)
  const solution = aim(bot, crystal)
  assert.ok(solution != null)
  assert.ok(arrowHits(arrowStart(bot), solution.yaw, solution.pitch, entityBox(crystal)).hit != null)
})

test('a crystal whose middle is hidden behind its spike\'s rim is shot on the flat arc at the top of its box, not the high arc', async () => {
  const { cellsOnLine, boxEntry } = await import('../../src/end/crystals')
  const { spikeColumns } = await import('../../src/end/spikes')
  // seed endfight's spike 2 (12, 39, radius 3, bedrock at 91), from the ground at -15.5, 65, 24.5
  const spike = { index: 2, centerX: 12, centerZ: 39, radius: 3, height: 91, guarded: false }
  const solid = new Set(spikeColumns(spike).flatMap(c => [80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90].map(y => `${c.x},${y},${c.z}`)))
  solid.add('12,91,39')
  const world = {
    clip: (from: Vec3, to: Vec3) => {
      for (const c of [...cellsOnLine(from, to), { x: Math.floor(to.x), y: Math.floor(to.y), z: Math.floor(to.z) }]) {
        if (!solid.has(`${c.x},${c.y},${c.z}`)) continue
        const p = boxEntry(from, to, { minX: c.x, minY: c.y, minZ: c.z, maxX: c.x + 1, maxY: c.y + 1, maxZ: c.z + 1 })
        return new Vec3(p.x, p.y, p.z)
      }
      return null
    }
  }
  const crystal = entity({ name: 'end_crystal', position: new Vec3(12.5, 92, 39.5) })
  const bot = fakeBot({ position: new Vec3(-15.5, 65, 24.5), entities: [crystal] })
  const solution = aim(bot, crystal, { world })
  assert.ok(solution != null)
  assert.ok(solution.ticks < 30, `the high arc (${solution.ticks.toFixed(0)} ticks)`)
  assert.ok(solution.aimPoint.y > 93.5)
  assert.ok(arrowHits(arrowStart(bot), solution.yaw, solution.pitch, entityBox(crystal), { world }).hit != null)
})

test('sparedInLine: a zombified piglin by the arrow\'s way to a wither skeleton, or behind it where a miss flies on; not one off to the side, nor one fought (BLAZE_WITHER=fresh-x)', async () => {
  const { sparedInLine } = await import('../../src/skills/shoot')
  const skeleton = entity({ id: 8, name: 'wither_skeleton', position: new Vec3(10.5, 64, 0.5) })
  const piglin = entity({ id: 9, name: 'zombified_piglin', position: new Vec3(5.5, 64, 0.9) })
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), entities: [skeleton, piglin] })
  assert.strictEqual(sparedInLine(bot, skeleton as any)?.id, 9)
  piglin.position = new Vec3(14.5, 64, 0.5)
  assert.strictEqual(sparedInLine(bot, skeleton as any)?.id, 9)
  piglin.position = new Vec3(5.5, 64, 3.5)
  assert.strictEqual(sparedInLine(bot, skeleton as any), null)
  piglin.position = new Vec3(25.5, 64, 0.5)
  assert.strictEqual(sparedInLine(bot, skeleton as any), null)
  piglin.position = new Vec3(5.5, 64, 0.5)
  assert.strictEqual(sparedInLine(bot, piglin as any), null)
})

test('shoot: no draw with a zombified piglin in the arrow\'s way; one already drawn is put away unloosed (the slot changed and back), not let go', async () => {
  const { shoot, SPARED_HOLD_TICKS } = await import('../../src/skills/shoot')
  const skeleton = entity({ id: 8, name: 'wither_skeleton', position: new Vec3(10.5, 64, 0.5) })
  const piglin = entity({ id: 9, name: 'zombified_piglin', position: new Vec3(5.5, 64, 0.5) })
  const bot: any = fakeBot({ position: new Vec3(0.5, 64, 0.5), entities: [skeleton, piglin], items: [item('bow'), item('arrow', 16)] })
  bot.heldItem = bot.inventory.items()[0]
  bot.quickBarSlot = 0
  const events: string[] = []
  bot.activateItem = () => { events.push('draw') }
  bot.deactivateItem = () => { events.push('release') }
  bot.setQuickBarSlot = (n: number) => { events.push(`slot ${n}`) }
  bot.waitForTicks = async (n: number) => { for (let i = 0; i < n; i++) bot.emit('physicsTick') }
  bot.world = { ...(bot.world ?? {}), raycast: () => null }
  const r = await shoot(bot, skeleton as any, { maxShots: 1 })
  assert.strictEqual(r.shots, 0)
  assert.ok(!events.includes('draw'), events.join(' '))
  // in the way only once the draw is on: held SPARED_HOLD_TICKS, then put away
  piglin.position = new Vec3(5.5, 64, 6.5)
  events.length = 0
  let ticks = 0
  bot.on('physicsTick', () => { if (++ticks === 10) piglin.position = new Vec3(5.5, 64, 0.5) })
  const r2 = await shoot(bot, skeleton as any, { maxShots: 1 })
  assert.strictEqual(r2.shots, 0)
  assert.ok(events.includes('draw'))
  assert.deepStrictEqual(events.filter(e => e !== 'draw' && e !== 'release').slice(-2), ['slot 1', 'slot 0'])
  assert.ok(events.lastIndexOf('release') < events.lastIndexOf('draw'), events.join(' '))
  assert.ok(ticks >= 22 + SPARED_HOLD_TICKS - 2, `${ticks} ticks`)
})
