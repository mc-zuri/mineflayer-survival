// Lava about to flow into the bot's cells (skills/lavaFlow): advancingLavaAt, the block updates' mark, the hazard
// reflex firing before the lava touches the bot.
import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { LAVA_NEAR_UP, advancingLavaAt, lavaAdvancing, lavaLevel, lavaNear, watchAdvancingLava } from '../../src/skills/lavaFlow'
import { hazardReflex } from '../../src/reflexes/rules'
import { ReflexEngine } from '../../src/reflexes/engine'
import { fakeBot } from '../reflexes/fakeBot'

/** a bot on stone at (0.5, 64, 0.5), the lava cells `lava` (with their levels) about it */
function lavaBot (lava: Record<string, number>, dimension = 'overworld'): any {
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5) })
  bot.game.dimension = dimension
  bot.blockAt = (pos: Vec3) => {
    const p = pos.floored()
    const level = lava[p.toString()]
    if (level != null) return { name: 'lava', position: p, boundingBox: 'empty', stateId: 100 + level, getProperties: () => ({ level: String(level) }) }
    return p.y < 64 ? { name: 'stone', position: p, boundingBox: 'block', stateId: 1 } : { name: 'air', position: p, boundingBox: 'empty', stateId: 0 }
  }
  return bot
}

test('advancingLavaAt: a source beside the body flows in next, a flow at level 6 beside it does not in the overworld but does in the nether, a falling column or lava over the head always does (after mine-ai-mcp\'s lava-flow)', () => {
  assert.equal(lavaLevel({ getProperties: () => ({ level: '8' }) }), 8)
  assert.equal(advancingLavaAt(lavaBot({ '(1, 64, 0)': 0 })), true)
  assert.equal(advancingLavaAt(lavaBot({ '(1, 64, 0)': 4 })), true)
  assert.equal(advancingLavaAt(lavaBot({ '(1, 64, 0)': 6 })), false)
  assert.equal(advancingLavaAt(lavaBot({ '(1, 64, 0)': 6 }, 'minecraft:the_nether')), true)
  assert.equal(advancingLavaAt(lavaBot({ '(1, 65, 0)': 9 })), true)
  assert.equal(advancingLavaAt(lavaBot({ '(0, 66, 0)': 7 })), true)
  // two blocks off, or under the floor: not yet
  assert.equal(advancingLavaAt(lavaBot({ '(2, 64, 0)': 0 })), false)
  assert.equal(advancingLavaAt(lavaBot({ '(0, 63, 0)': 0 })), false)
  // a stand looked at instead of the bot's own cells
  const bot = lavaBot({ '(4, 64, 0)': 0 })
  assert.equal(advancingLavaAt(bot), false)
  assert.equal(advancingLavaAt(bot, new Vec3(3.5, 64, 0.5)), true)
})

test('the hazard reflex escapes lava a block update brought beside the bot before it flows in (lavaAdvancing); a still pool beside it is no mark, and the mark goes once the lava can\'t come', () => {
  const lava: Record<string, number> = {}
  const bot = lavaBot(lava)
  const engine = new ReflexEngine(bot, { enabled: false })
  watchAdvancingLava(bot)
  assert.equal(hazardReflex.check(engine.context()), null)
  // the flow come up to the bot: level 2 beside its feet
  lava['(1, 64, 0)'] = 2
  bot.emit('blockUpdate', { name: 'air', stateId: 0, position: new Vec3(1, 64, 0) }, bot.blockAt(new Vec3(1, 64, 0)))
  assert.equal(lavaAdvancing(bot), true)
  assert.equal(hazardReflex.check(engine.context())?.detail, 'advancing lava')
  // stepped away: the mark goes
  bot.entity.position = new Vec3(-3.5, 64, 0.5)
  assert.equal(lavaAdvancing(bot), false)
  assert.equal(hazardReflex.check(engine.context()), null)
  // a block update of lava too weak to come on (level 6) is none
  bot.entity.position = new Vec3(0.5, 64, 0.5)
  lava['(1, 64, 0)'] = 6
  bot.emit('blockUpdate', { name: 'lava', stateId: 102, position: new Vec3(1, 64, 0) }, bot.blockAt(new Vec3(1, 64, 0)))
  assert.equal(lavaAdvancing(bot), false)
  engine.stop()
})

test('lavaNear: a stand with lava beside it or over it up to LAVA_NEAR_UP is none the escape takes (a column coming down beside it)', () => {
  assert.equal(lavaNear(lavaBot({}), new Vec3(0, 64, 0)), false)
  assert.equal(lavaNear(lavaBot({ '(1, 66, 0)': 8 }), new Vec3(0, 64, 0)), true)
  assert.equal(lavaNear(lavaBot({ '(-1, 64, 1)': 0 }), new Vec3(0, 64, 0)), true)
  assert.equal(lavaNear(lavaBot({ [`(0, ${64 + LAVA_NEAR_UP + 1}, 0)`]: 0 }), new Vec3(0, 64, 0)), false)
  assert.equal(lavaNear(lavaBot({ '(2, 64, 0)': 0 }), new Vec3(0, 64, 0)), false)
})
