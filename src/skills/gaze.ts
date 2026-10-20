// No stare at an enderman by accident: the look the bot sends the server kept off a calm enderman's eyes
// (EnderMan.isLookingAtMe: the view within 1 - 0.025 / distance of the line to its eyes, a line of sight between, no
// carved pumpkin worn), unless a skill stares on purpose (allowStare: the pearl hunt's provokeEnderman). A 26.3 bot
// hunting a cow by day, an enderman by the cow, was set on by it at 7 a hit with no armor on, and died; going back for
// its items it angered it again and died again (full-26.3-fresh-d).
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { isAlive, type Entity } from './combatUtil'
import { isAngryEnderman, looksAtEnderman } from '../nether/pearls'

/** how far off an enderman takes a stare (EndermanLookForPlayerGoal: its follow range, 64) */
export const STARE_RANGE = 64
/** EnderMan's eye height */
const ENDERMAN_EYE = 2.55

/** the look's direction for a mineflayer yaw and pitch */
export function viewOf (yaw: number, pitch: number): Vec3 {
  const c = Math.cos(pitch)
  return new Vec3(-Math.sin(yaw) * c, Math.sin(pitch), -Math.cos(yaw) * c)
}

/**
 * The pitch to send instead of `pitch` so the look at `yaw` meets no calm enderman's eyes among `endermen` (the eyes
 * at `eye`): the pitch itself when it meets none, else the nearest one lower (then higher) that doesn't, in steps of
 * 0.05 rad; a look down by a little is far off a stare's line at any distance it counts.
 */
export function safePitch (eye: Vec3, yaw: number, pitch: number, endermen: readonly Entity[]): number {
  const stares = (p: number): boolean => endermen.some(e => looksAtEnderman(eye, viewOf(yaw, p), e))
  if (!stares(pitch)) return pitch
  for (let k = 1; k <= 30; k++) {
    for (const p of [pitch - 0.05 * k, pitch + 0.05 * k]) {
      if (p >= -Math.PI / 2 && p <= Math.PI / 2 && !stares(p)) return p
    }
  }
  return pitch
}

const allowed = new WeakMap<Bot, number>()

/** runs `fn` with the guard off: a stare on purpose (provokeEnderman) */
export async function allowStare<T> (bot: Bot, fn: () => Promise<T>): Promise<T> {
  allowed.set(bot, (allowed.get(bot) ?? 0) + 1)
  try {
    return await fn()
  } finally {
    const n = (allowed.get(bot) ?? 1) - 1
    if (n <= 0) allowed.delete(bot)
    else allowed.set(bot, n)
  }
}

/** the calm endermen within STARE_RANGE whose eyes the bot's eyes see (the ones a stare would anger) */
export function calmEndermen (bot: Bot): Entity[] {
  if (bot.entity == null || bot.inventory?.slots?.[5]?.name === 'carved_pumpkin') return []
  const eye = bot.entity.position.offset(0, 1.62, 0)
  const raycast = (bot.world as any)?.raycast
  return Object.values(bot.entities).filter(e => {
    if (e.name !== 'enderman' || !isAlive(bot, e) || isAngryEnderman(bot, e)) return false
    const to = e.position.offset(0, ENDERMAN_EYE, 0).minus(eye)
    const d = to.norm()
    if (d > STARE_RANGE || d < 1e-6) return false
    return typeof raycast !== 'function' || raycast.call(bot.world, eye, to.scaled(1 / d), d) == null
  })
}

/**
 * Keeps the bot's look off the calm endermen's eyes: each bot.look (and so lookAt) goes out with safePitch's pitch,
 * and at each tick's end the look held is put right (a look set straight on bot.entity), unless allowStare is on
 */
export function installGazeGuard (bot: Bot): void {
  if ((bot as any).survivalGazeGuard === true) return
  ;(bot as any).survivalGazeGuard = true
  const look = bot.look.bind(bot)
  const guarded = (yaw: number, pitch: number): number => {
    if ((allowed.get(bot) ?? 0) > 0) return pitch
    const endermen = calmEndermen(bot)
    return endermen.length === 0 ? pitch : safePitch(bot.entity.position.offset(0, 1.62, 0), yaw, pitch, endermen)
  }
  bot.look = async (yaw: number, pitch: number, force?: boolean) => await look(yaw, guarded(yaw, pitch), force)
  bot.on('physicsTick', () => {
    if (bot.entity == null) return
    const p = guarded(bot.entity.yaw, bot.entity.pitch)
    if (p !== bot.entity.pitch) void look(bot.entity.yaw, p, true)
  })
}
