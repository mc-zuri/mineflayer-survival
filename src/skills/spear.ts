// The spear's charge (26.x): a mob holding a spear (a zombie, a husk, mounted on a zombie horse or a camel) charges with
// it, the spear's kinetic_weapon (the 26.3 server's items report: delay_ticks 12, damage while the relative speed is
// min_relative_speed 4.6 or more over max_duration_ticks 225, knockback from 5.1, a dismount from 11; its reach,
// attack_range, min_reach 2 to max_reach 4.5). A mounted one's charge closes at a horse's speed: one hit took a 26.3 bot
// in an iron chestplate and leggings from 12.4 to 2.1 health from 2.8 off (f7-26.3, '(speared by Zombie)'). Met so: the
// shield up toward it while it's within SPEAR_GUARD (a shield takes the charge, Player.isDamageSourceBlocked), a swing at
// it or its mount as it passes in the sword's reach; with no shield, shut in with the blocks carried (sealIn), else a
// block put on its line to the bot (barrierCells) or a step aside out of its charge's line.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { type Entity, entityBox, distanceToBox, eyePosition, isAlive, throwIfAborted, yawPitchOf } from './combatUtil'
import { lowerShield, raiseShield, swingVictim } from './fight'
import { attackStrengthOf, bestMeleeWeapon } from './weapons'
import { waitTicks } from './util'
import { isAbort } from './errors'

/** how far a spear holder is watched from (a mount's charge covers it in a second or two) */
export const SPEAR_WATCH = 16
/** within this the shield's up toward it (its reach 4.5 and a mount's run of a few ticks) */
export const SPEAR_GUARD = 8
/** the sword's reach a swing at it or its mount is made from */
export const SPEAR_SWING_REACH = 2.9
/** ticks a guard lasts at most */
export const SPEAR_GUARD_TICKS = 400
/** ticks a bot with no shield stays shut in from a spear holder (sealIn's maxTicks) */
export const SPEAR_SEAL_TICKS = 600
/** the mounts a spear holder rides */
export const SPEAR_MOUNTS = new Set(['zombie_horse', 'skeleton_horse', 'horse', 'camel', 'camel_husk', 'zombie_nautilus'])

/** whether a mob holds a spear (its main hand's item: a *_spear) */
export function holdsSpear (e: Entity): boolean {
  const held = (e as any).heldItem ?? (e as any).equipment?.[0]
  return typeof held?.name === 'string' && held.name.endsWith('_spear')
}

/** the mount a mob rides: its vehicle, or a mount whose box its feet are on or in */
export function mountOf (bot: Bot, e: Entity): Entity | null {
  const v = (e as any).vehicle
  if (v != null && v.position != null) return v
  for (const m of Object.values(bot.entities)) {
    if (m === e || !SPEAR_MOUNTS.has(m.name ?? '')) continue
    if (Math.hypot(m.position.x - e.position.x, m.position.z - e.position.z) < 0.6 && e.position.y >= m.position.y && e.position.y - m.position.y < 2.2) return m
  }
  return null
}

/** the hostiles holding a spear alive within SPEAR_WATCH, nearest first (mounted ones are the worst: mountOf) */
export function spearThreats (bot: Bot): Entity[] {
  if (bot.entity == null) return []
  return Object.values(bot.entities)
    .filter(e => e !== bot.entity && holdsSpear(e) && isAlive(bot, e) && (bot.registry?.entitiesByName as any)?.[e.name ?? '']?.type === 'hostile' && e.position.distanceTo(bot.entity.position) <= SPEAR_WATCH)
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
}

function hasShield (bot: Bot): boolean {
  return bot.inventory.slots[45]?.name === 'shield' || bot.inventory.items().some(i => i.name === 'shield')
}

/**
 * The step aside from a charge: the point SIDESTEP blocks square to the line from the rider to the bot, on the side
 * the rider's run isn't heading (its velocity), else the side away from it; null with no line (on top of it)
 */
export function sidestepPoint (bot: Bot, rider: Entity, step = 3): Vec3 | null {
  const p = bot.entity.position
  const dx = p.x - rider.position.x
  const dz = p.z - rider.position.z
  const len = Math.hypot(dx, dz)
  if (len < 1e-6) return null
  // the two sides square to the line, the one the rider's velocity points less toward
  const sx = -dz / len
  const sz = dx / len
  const v = (rider as any).velocity ?? new Vec3(0, 0, 0)
  const side = v.x * sx + v.z * sz > 0 ? -1 : 1
  return new Vec3(p.x + sx * side * step, p.y, p.z + sz * side * step)
}

/**
 * Met a spear holder (mounted or not): the shield up toward it within SPEAR_GUARD, the sword's swing at it or its
 * mount once one's in reach and the swing charged; with no shield, a block put on its line to the body (barrierCells,
 * the blocks carried) or, with none to put, a step aside out of its charge's line (sidestepPoint). Ends with it dead,
 * out of SPEAR_WATCH, or after maxTicks.
 */
export async function guardSpear (bot: Bot, rider: Entity, opts: { signal?: AbortSignal, maxTicks?: number } = {}): Promise<{ ticks: number, hits: number }> {
  const signal = opts.signal
  const maxTicks = opts.maxTicks ?? SPEAR_GUARD_TICKS
  const strength = attackStrengthOf(bot)
  const weapon = bestMeleeWeapon(bot)
  if (weapon != null && bot.heldItem?.type !== weapon.type) await bot.equip(weapon, 'hand').catch(() => {})
  // (a shield in the bag to the off hand)
  if (bot.inventory.slots[45]?.name !== 'shield') {
    const shield = bot.inventory.items().find(i => i.name === 'shield')
    if (shield != null) await bot.equip(shield, 'off-hand').catch(() => {})
  }
  let blocking = false
  let sealTried = false
  let hits = 0
  let ticks = 0
  const failed = new Set<string>()
  try {
    for (; ticks < maxTicks; ticks++) {
      throwIfAborted(signal)
      if (!isAlive(bot, rider) || rider.position.distanceTo(bot.entity.position) > SPEAR_WATCH + 4) break
      const d = rider.position.distanceTo(bot.entity.position)
      const center = rider.position.offset(0, (rider.height ?? 1.95) * 0.7, 0)
      const { yaw, pitch } = yawPitchOf(center.minus(eyePosition(bot)))
      // a swing at it or its mount in reach, the swing charged (the shield down for it)
      const mount = mountOf(bot, rider)
      const victim = [rider, mount].filter((m): m is Entity => m != null && distanceToBox(eyePosition(bot), entityBox(m)) <= SPEAR_SWING_REACH)[0]
      if (victim != null && strength.scale(0.5) >= 1) {
        if (blocking) { lowerShield(bot); blocking = false }
        const at = victim.position.offset(0, (victim.height ?? 1.6) * 0.6, 0)
        const look = yawPitchOf(at.minus(eyePosition(bot)))
        await bot.look(look.yaw, look.pitch, true)
        const target = swingVictim(bot, victim) ?? victim
        if (strength.attack(target)) hits++
        await waitTicks(bot, 1, signal)
        continue
      }
      if (hasShield(bot)) {
        bot.clearControlStates()
        void bot.look(yaw, pitch, true)
        if (d <= SPEAR_GUARD && !blocking) blocking = await raiseShield(bot)
        if (d > SPEAR_GUARD && blocking) { lowerShield(bot); blocking = false }
        await waitTicks(bot, 1, signal)
        continue
      }
      // no shield: shut in where it stands with the blocks carried (sealIn: no charge reaches through them), else a
      // block on its line to the body, else a step aside
      const { sealItem } = await import('./shelter')
      const item = sealItem(bot)
      if (item != null && !sealTried) {
        sealTried = true
        const { sealIn, sealBox, openCells } = await import('./sealIn')
        const threats = (): Entity[] => [rider, mountOf(bot, rider)].filter((m): m is Entity => m != null && isAlive(bot, m))
        const box = sealBox(bot, threats())
        const { countItems } = await import('./util')
        if (box != null && countItems(bot, item) >= openCells(bot, box).length) {
          bot.clearControlStates()
          try {
            await sealIn(bot, { signal, threats, maxTicks: SPEAR_SEAL_TICKS })
            return { ticks, hits }
          } catch (err) {
            if (isAbort(err)) throw err
          }
        }
      }
      if (item != null && d <= SPEAR_GUARD) {
        const { barrierCells } = await import('./escape')
        const cell = barrierCells(bot, rider.position.offset(0, 1, 0), rider).find(c => !failed.has(c.toString()))
        if (cell != null) {
          const { placeBlock } = await import('./placeBlock')
          bot.clearControlStates()
          try {
            await placeBlock(bot, { pos: cell, item }, signal)
          } catch (err) {
            if (isAbort(err)) throw err
            failed.add(cell.toString())
          }
          continue
        }
      }
      const aside = d <= SPEAR_GUARD ? sidestepPoint(bot, rider) : null
      if (aside != null) {
        const { steerToward } = await import('./steer')
        steerToward(bot, aside, { sprint: true, guard: true })
      } else {
        bot.clearControlStates()
        void bot.look(yaw, pitch, true)
      }
      await waitTicks(bot, 1, signal)
    }
  } finally {
    if (blocking) lowerShield(bot)
    bot.clearControlStates()
  }
  return { ticks, hits }
}
