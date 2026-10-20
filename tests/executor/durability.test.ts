import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { replacementTiers, usesLeft, watchToolWear, wornOutTools } from '../../src/executor/durability'

test('usesLeft: max damage less the damage; Infinity for what does not wear', () => {
  assert.equal(usesLeft({ name: 'iron_pickaxe', maxDurability: 250, durabilityUsed: 240 }), 10)
  assert.equal(usesLeft({ name: 'cobblestone' }), Infinity)
})

test('wornOutTools: the best tier of a kind about to break, unless another of the tier has uses left', () => {
  const worn = wornOutTools([
    { name: 'stone_pickaxe', maxDurability: 131, durabilityUsed: 125 },
    { name: 'wooden_pickaxe', maxDurability: 59, durabilityUsed: 0 },
    { name: 'iron_sword', maxDurability: 250, durabilityUsed: 245 },
    { name: 'iron_sword', maxDurability: 250, durabilityUsed: 10 },
    { name: 'stone_axe', maxDurability: 131, durabilityUsed: 130 }
  ], { minUses: 12 })
  assert.deepEqual(worn.map(w => [w.kind, w.material, w.uses]), [['pickaxe', 'stone', 6], ['axe', 'stone', 1]])
  assert.deepEqual(wornOutTools([{ name: 'stone_pickaxe', maxDurability: 131, durabilityUsed: 100 }]), [])
})

/** a bot of the watch: a held tool and the bag, its ticks emitted by the test */
function wearBot (items: Array<{ name: string, maxDurability: number, durabilityUsed: number, slot: number }>): any {
  const bot: any = new EventEmitter()
  bot.items = items
  bot.heldItem = items[0]
  bot.inventory = { items: () => bot.items }
  return bot
}

test('watchToolWear stops the task once, as a use brings the held tool to the mark with no spare of its tier', () => {
  const pick = { name: 'diamond_pickaxe', maxDurability: 1561, durabilityUsed: 1530, slot: 36 }
  // a lower tier's spare is no spare of its tier
  const bot = wearBot([pick, { name: 'iron_pickaxe', maxDurability: 250, durabilityUsed: 0, slot: 37 }])
  const stops: any[] = []
  let active = true
  const unwatch = watchToolWear(bot, { minUses: 24, active: () => active, stop: w => stops.push(w) })
  bot.emit('physicsTick')
  // 31 uses left, then 25: no stop
  pick.durabilityUsed = 1536
  bot.emit('physicsTick')
  assert.equal(stops.length, 0)
  // a reflex holds the task: its wear isn't the task's
  active = false
  pick.durabilityUsed = 1537
  bot.emit('physicsTick')
  active = true
  bot.emit('physicsTick')
  assert.equal(stops.length, 0)
  pick.durabilityUsed = 1538
  bot.emit('physicsTick')
  assert.deepEqual(stops, [{ kind: 'pickaxe', material: 'diamond', name: 'diamond_pickaxe', uses: 23 }])
  pick.durabilityUsed = 1539
  bot.emit('physicsTick')
  assert.equal(stops.length, 1)
  unwatch()
})

test('watchToolWear lets be a tool carried worn but not worn further, one with a spare of its tier, and a muted one', () => {
  const pick = { name: 'iron_pickaxe', maxDurability: 250, durabilityUsed: 240, slot: 36 }
  const stops: any[] = []
  // worn at the start, held but not used: no stop
  const idle = wearBot([pick])
  watchToolWear(idle, { minUses: 24, active: () => true, stop: w => stops.push(w) })
  for (let i = 0; i < 5; i++) idle.emit('physicsTick')
  assert.equal(stops.length, 0)
  // another iron pickaxe in better shape: worn down, no stop
  const spare = wearBot([{ ...pick }, { name: 'iron_pickaxe', maxDurability: 250, durabilityUsed: 3, slot: 37 }])
  watchToolWear(spare, { minUses: 24, active: () => true, stop: w => stops.push(w) })
  spare.emit('physicsTick')
  spare.heldItem.durabilityUsed++
  spare.emit('physicsTick')
  assert.equal(stops.length, 0)
  // muted (its replacement failed a while ago): no stop
  const muted = wearBot([{ ...pick }])
  watchToolWear(muted, { minUses: 24, active: () => true, muted: w => w.kind === 'pickaxe' && w.material === 'iron', stop: w => stops.push(w) })
  muted.emit('physicsTick')
  muted.heldItem.durabilityUsed++
  muted.emit('physicsTick')
  assert.equal(stops.length, 0)
  // a sword the task swings: its own kind
  const sword = wearBot([{ name: 'stone_sword', maxDurability: 131, durabilityUsed: 120, slot: 36 }, { ...pick, slot: 37 }])
  watchToolWear(sword, { minUses: 24, active: () => true, stop: w => stops.push(w) })
  sword.emit('physicsTick')
  sword.heldItem.durabilityUsed++
  sword.emit('physicsTick')
  assert.deepEqual(stops.map(s => `${s.kind}:${s.material}:${s.uses}`), ['sword:stone:10'])
})

test('watchToolWear stops for a pickaxe or a sword only: a hoe (a nether forest\'s wart blocks) or a shovel worn down is used till it breaks', () => {
  const stops: any[] = []
  for (const name of ['wooden_hoe', 'stone_shovel', 'stone_axe']) {
    const bot = wearBot([{ name, maxDurability: 59, durabilityUsed: 40, slot: 36 }])
    watchToolWear(bot, { minUses: 24, active: () => true, stop: w => stops.push(w) })
    bot.emit('physicsTick')
    bot.heldItem.durabilityUsed++
    bot.emit('physicsTick')
  }
  assert.equal(stops.length, 0)
  // a task that asks for the hoe's wear to be watched (kinds)
  const hoe = wearBot([{ name: 'wooden_hoe', maxDurability: 59, durabilityUsed: 40, slot: 36 }])
  watchToolWear(hoe, { minUses: 24, active: () => true, kinds: ['hoe'], stop: w => stops.push(w) })
  hoe.emit('physicsTick')
  hoe.heldItem.durabilityUsed++
  hoe.emit('physicsTick')
  assert.deepEqual(stops.map(s => `${s.kind}:${s.material}`), ['hoe:wooden'])
})

test('replacementTiers: the worn tool\'s tier, then the lower ones down to stone', () => {
  assert.deepEqual(replacementTiers('diamond'), ['diamond', 'iron', 'stone'])
  assert.deepEqual(replacementTiers('iron'), ['iron', 'stone'])
  assert.deepEqual(replacementTiers('stone'), ['stone'])
  assert.deepEqual(replacementTiers('wooden'), ['wooden'])
})
