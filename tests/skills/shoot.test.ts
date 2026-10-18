import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { aim, arrowStart } from '../../src/skills/shoot'
import { arrowHits } from '../../src/skills/arrow'
import { entityBox } from '../../src/skills/combatUtil'
import { entity, fakeBot } from '../reflexes/fakeBot'

test('aim at an end crystal entity from the bot: from the eye less 0.1, the arc entering its box', () => {
  const crystal = entity({ name: 'end_crystal', position: new Vec3(20.5, 65, 0.5) })
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), entities: [crystal] })
  assert.ok(Math.abs(arrowStart(bot).y - 65.52) < 1e-9)
  const solution = aim(bot, crystal)
  assert.ok(solution != null)
  assert.ok(arrowHits(arrowStart(bot), solution.yaw, solution.pitch, entityBox(crystal)).hit != null)
})
