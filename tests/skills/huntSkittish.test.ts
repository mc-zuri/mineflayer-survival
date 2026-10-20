// The hunt of a skittish animal (a rabbit, which runs from a player near): the chase's lead, its settings, the
// tempting food, and a chase that gets no nearer given up after the way round, not 1200 ticks on.
import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { chaseLead, LEAD_BLOCKS } from '../../src/skills/fight'
import { SKITTISH, skittishFight, temptingFood } from '../../src/skills/hunt'
import { entity, fakeBot, item } from '../reflexes/fakeBot'

test('chaseLead: a fleeing animal led by its velocity over the ticks to get there, at most 4 blocks, on its level', () => {
  const from = new Vec3(0, 64, 0)
  const target = new Vec3(2.8, 64, 0)
  // 10 ticks to get there at a sprint, 0.2 a tick away: 2 blocks on
  const led = chaseLead(from, target, new Vec3(0.2, 0.3, 0))
  assert.ok(Math.abs(led.x - 4.8) < 1e-9 && led.y === 64 && led.z === 0, led.toString())
  // far off and fast: no more than LEAD_BLOCKS
  const far = chaseLead(from, new Vec3(20, 64, 0), new Vec3(0, 0, 0.6))
  assert.ok(Math.abs(far.z - LEAD_BLOCKS) < 1e-9, far.toString())
  // standing still: where it is
  assert.ok(chaseLead(from, target, new Vec3(0, 0, 0)).equals(target))
})

test('skittishFight: a rabbit chased on a lead with sprint jumps, a swing at once, given up sooner', () => {
  assert.ok(SKITTISH.has('rabbit'))
  const walk = async (): Promise<boolean> => true
  const o = skittishFight({}, walk)
  assert.strictEqual(o.lead, true)
  assert.strictEqual(o.sprintJump, true)
  assert.strictEqual(o.crits, false)
  assert.ok((o.maxTicks ?? 1200) < 1200)
  assert.ok(o.stuckTicks != null && o.onStuck === walk)
})

test('temptingFood: a carrot, a golden carrot or a dandelion held tempts a rabbit (ItemTags.RABBIT_FOOD)', () => {
  assert.strictEqual(temptingFood(fakeBot({ items: [item('dandelion', 2)] }), 'rabbit'), 'dandelion')
  assert.strictEqual(temptingFood(fakeBot({ items: [item('carrot', 1)] }), 'rabbit'), 'carrot')
  assert.strictEqual(temptingFood(fakeBot({ items: [item('wheat', 1)] }), 'rabbit'), null)
})

test('fight: a chase that gets no nearer tries the way round once, then gives up with NO_PATH (full-26.3-s31337-g: a rabbit chased 1200 ticks)', async () => {
  const { fight } = await import('../../src/skills/fight')
  const rabbit = entity({ id: 9, name: 'rabbit', position: new Vec3(8.5, 66, 0.5) })
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), entities: [rabbit] })
  bot.attack = () => {}
  let rerouted = 0
  const ticking = setInterval(() => bot.emit('physicsTick'), 1)
  let ticks = 0
  bot.on('physicsTick', () => { ticks++ })
  try {
    await assert.rejects(fight(bot, rabbit as any, { maxTicks: 1200, stuckTicks: 30, onStuck: async () => { rerouted++; return true } }), (err: any) => err.code === 'NO_PATH')
  } finally {
    clearInterval(ticking)
  }
  assert.strictEqual(rerouted, 1)
  assert.ok(ticks < 200, `${ticks} ticks`)
})
