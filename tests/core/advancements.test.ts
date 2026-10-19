// The advancements the server's packet says are made, and the dragon fight over once the bot is out of the End.
import { test } from 'node:test'
import assert from 'node:assert'
import { advancementsDone } from '../../src/core/advancements'

test('advancementsDone: every criterion obtained is an advancement made, by id without the namespace', () => {
  const done = advancementsDone({
    progressMapping: [
      { key: 'minecraft:end/kill_dragon', value: [{ criterionIdentifier: 'killed_dragon', criterionProgress: 1792370000000n }] },
      { key: 'minecraft:story/mine_stone', value: [{ criterionIdentifier: 'get_stone', criterionProgress: null }] },
      { key: 'minecraft:adventure/two_birds', value: [{ criterionIdentifier: 'a', criterionProgress: 5 }, { criterionIdentifier: 'b' }] },
      { key: 'minecraft:end/root', value: [] }
    ]
  })
  assert.deepStrictEqual(done, ['end/kill_dragon'])
  assert.deepStrictEqual(advancementsDone({}), [])
})

test('fightDragon out of the End: over, won as the server\'s kill_dragon says (the exit portal carried the bot out)', async () => {
  const { fightDragon } = await import('../../src/end/skills/fightDragon')
  const { fakeBot } = await import('../reflexes/fakeBot')
  const bot = fakeBot()
  bot.game.dimension = 'overworld'
  bot.survival = { advancements: new Set(['end/kill_dragon']) }
  assert.strictEqual((await fightDragon(bot)).killed, true)
  bot.survival.advancements.clear()
  assert.strictEqual((await fightDragon(bot)).killed, false)
})
