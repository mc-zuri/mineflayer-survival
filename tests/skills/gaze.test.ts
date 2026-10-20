import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { allowStare, installGazeGuard, safePitch, viewOf } from '../../src/skills/gaze'
import { looksAtEnderman } from '../../src/nether/pearls'
import { yawPitchOf } from '../../src/skills/combatUtil'
import { entity, fakeBot } from '../reflexes/fakeBot'

test('safePitch: a look straight at a calm enderman\'s eyes 20 off goes out a little lower, off the stare\'s line (EnderMan.isLookingAtMe); one at none as it is', () => {
  const eye = new Vec3(0.5, 65.62, 0.5)
  const enderman = entity({ name: 'enderman', position: new Vec3(0.5, 64, -19.5) })
  const { yaw, pitch } = yawPitchOf(enderman.position.offset(0, 2.55, 0).minus(eye))
  assert.equal(looksAtEnderman(eye, viewOf(yaw, pitch), enderman as any), true)
  const p = safePitch(eye, yaw, pitch, [enderman as any])
  assert.ok(p < pitch && pitch - p < 0.2, `${pitch} -> ${p}`)
  assert.equal(looksAtEnderman(eye, viewOf(yaw, p), enderman as any), false)
  assert.equal(safePitch(eye, yaw + 1, pitch, [enderman as any]), pitch)
})

test('the gaze guard: bot.look at a calm enderman\'s eyes goes out off them, an angry one\'s or with allowStare as asked (full-26.3-fresh-d)', async () => {
  const enderman = entity({ name: 'enderman', position: new Vec3(0.5, 64, -19.5) })
  const bot = fakeBot({ entities: [enderman] })
  bot.entity.yaw = 0
  bot.entity.pitch = 0
  bot.look = async (yaw: number, pitch: number) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch }
  installGazeGuard(bot)
  const eye = bot.entity.position.offset(0, 1.62, 0)
  const { yaw, pitch } = yawPitchOf(enderman.position.offset(0, 2.55, 0).minus(eye))
  await bot.look(yaw, pitch, true)
  assert.equal(looksAtEnderman(eye, viewOf(bot.entity.yaw, bot.entity.pitch), enderman as any), false)
  await allowStare(bot, async () => { await bot.look(yaw, pitch, true) })
  assert.equal(bot.entity.pitch, pitch)
  // a look set straight on the entity is put right at the tick's end
  bot.emit('physicsTick')
  await new Promise(resolve => setImmediate(resolve))
  assert.notEqual(bot.entity.pitch, pitch)
  // angry (DATA_CREEPY): no guard
  const angry = entity({ name: 'enderman', position: new Vec3(0.5, 64, -19.5), meta: { creepy: true } })
  const bot2 = fakeBot({ entities: [angry] })
  bot2.look = async (y: number, p: number) => { bot2.entity.yaw = y; bot2.entity.pitch = p }
  installGazeGuard(bot2)
  await bot2.look(yaw, pitch, true)
  assert.equal(bot2.entity.pitch, pitch)
})
