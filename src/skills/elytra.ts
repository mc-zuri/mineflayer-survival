// Flying with an elytra: worn in the chest slot, a jump and a second press of jump in the air to start gliding
// (LocalPlayer.aiStep: a press of jump off the ground calls Player.tryToStartFallFlying and sends START_FALL_FLYING),
// firework rockets used while gliding for the boost (FireworkRocketItem.use spawns one attached to the player:
// FireworkRocketEntity.tick pulls the player's movement toward 1.5 blocks a tick along the look, for 10 x (1 + the
// flight duration) + 0..5 + 0..6 ticks), steered by the look's yaw and pitch (LivingEntity.updateFallFlyingMovement:
// a look down trades height for speed, a look up speed for height), and landed shallow (the fall distance is reset to
// 1 while the fall is slower than 0.5 a tick: LivingEntity.travelFallFlying). The elytra wears a point a second of
// gliding (LivingEntity.updateFallFlying) and stops working a point short of breaking (canGlideUsing:
// nextDamageWillBreak). mineflayer's elytra and rocket physics are vanilla's (the replay suite's f_elytra_* cases,
// rockets among them, on 1.21.11 and 26.3).
import type { Bot } from 'mineflayer'
import type { Item } from 'prismarine-item'
import { Vec3 } from 'vec3'
import { TaskError, throwIfAborted, waitTicks, type SkillOptions } from './combatUtil'
import { countItems, trace } from './util'

/** a rocket's boost lasts at least this many ticks (FireworkRocketEntity: 10 x (1 + 1) for a recipe's duration 1) */
export const ROCKET_MIN_TICKS = 20
/** the durability left at which a flight comes down (canGlideUsing stops it at 1) */
export const ELYTRA_LOW_DURABILITY = 20
/** how high over the ground (and the start and the target) a flight cruises */
export const CRUISE_HEIGHT = 24
/** the speed under which a rocket is used while cruising (a rocket's boost tends to 1.5 a tick) */
export const ROCKET_SPEED = 1.0
/** the fall that's no hurt on landing (travelFallFlying resets the fall distance above it) */
export const SAFE_SINK = 0.5

/** an elytra's durability left (its max less the damage component), 0 for none */
export function durabilityLeft (item: Pick<Item, 'maxDurability' | 'durabilityUsed'> | null | undefined): number {
  if (item == null) return 0
  return Math.max(0, (item.maxDurability ?? 432) - (item.durabilityUsed ?? 0))
}

/** the elytra worn (the chest slot, 6) or carried with the most left */
export function bestElytra (bot: Bot): Item | null {
  const worn = bot.inventory.slots[6]
  const all = [...(worn?.name === 'elytra' ? [worn] : []), ...bot.inventory.items().filter(i => i.name === 'elytra')]
  return all.sort((a, b) => durabilityLeft(b) - durabilityLeft(a))[0] ?? null
}

export function wearingElytra (bot: Bot): boolean {
  return bot.inventory.slots[6]?.name === 'elytra'
}

export function isGliding (bot: Bot): boolean {
  return (bot.entity as any).fallFlying === true || (bot.entity as any).elytraFlying === true
}

/** the elytra put on in the chest slot (the chestplate goes into the bag) */
export async function equipElytra (bot: Bot): Promise<Item> {
  const best = bestElytra(bot)
  if (best == null) throw new TaskError('MISSING_ITEMS', 'no elytra')
  if (durabilityLeft(best) <= ELYTRA_LOW_DURABILITY) throw new TaskError('MISSING_ITEMS', `the elytra is worn out (${durabilityLeft(best)} left)`)
  if (bot.inventory.slots[6] !== best) await bot.equip(best, 'torso')
  return best
}

/** the best chestplate carried put back on in the chest slot (after a flight) */
export async function equipChestplate (bot: Bot): Promise<void> {
  const order = ['netherite_chestplate', 'diamond_chestplate', 'iron_chestplate', 'chainmail_chestplate', 'golden_chestplate', 'copper_chestplate', 'leather_chestplate']
  const plate = bot.inventory.items().filter(i => order.includes(i.name)).sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name))[0]
  if (plate != null) await bot.equip(plate, 'torso')
}

export interface FlightState {
  pos: Vec3
  vel: Vec3
  target: Vec3
  /** the ground's feet height under the bot and ahead (the highest of the columns ahead within reach), null unknown */
  groundUnder: number | null
  groundAhead: number | null
  /** the cruise's height */
  cruiseY: number
  /** a rocket's boost is on */
  boosted: boolean
  rockets: number
  /** the elytra's durability left */
  durability: number
}

export interface FlightCommand {
  /** mineflayer's pitch (radians, up positive) and yaw */
  pitch: number
  yaw: number
  rocket: boolean
  phase: 'climb' | 'cruise' | 'descend' | 'flare'
}

const deg = (d: number): number => d * Math.PI / 180

/** the yaw toward a point (mineflayer's: 0 north, -z) */
export function yawToward (from: Vec3, to: Vec3): number {
  return Math.atan2(-(to.x - from.x), -(to.z - from.z))
}

/**
 * One tick's steering of a flight: the yaw toward the target, and the pitch and the rocket by the phase. Climb to the
 * cruise's height (a look up 30 degrees, rockets when the boost is off); cruise level (a rocket when slower than
 * ROCKET_SPEED, the look a little up under the boost, a little down without); descend once the target is within the
 * glide down's reach (some 3 blocks on for one down, a look down 20 degrees, no rockets), or the elytra or rockets
 * run low (glided down where the bot is); flare the last blocks over the ground (a look up to keep the sink under
 * SAFE_SINK). Over ground that comes up ahead, up first.
 */
export function steerFlight (s: FlightState): FlightCommand {
  const horiz = Math.hypot(s.target.x - s.pos.x, s.target.z - s.pos.z)
  const speed = Math.hypot(s.vel.x, s.vel.z)
  let yaw = yawToward(s.pos, s.target)
  const ground = s.groundUnder ?? Math.min(s.target.y, s.pos.y - CRUISE_HEIGHT)
  const height = s.pos.y - ground
  const low = s.durability <= ELYTRA_LOW_DURABILITY
  // close over the target but high: round it in a circle while coming down
  if (horiz < 12 && height > 8) yaw += Math.PI / 2
  const drop = s.pos.y - s.target.y
  const descending = low || horiz <= Math.max(0, drop) * 3 + 8
  if (s.groundAhead != null && s.groundAhead > s.pos.y - 6 && !(descending && horiz < 16)) {
    return { yaw, pitch: deg(35), rocket: !s.boosted && s.rockets > 0, phase: 'climb' }
  }
  if (descending) {
    if (height <= 6 || (horiz < 6 && height <= 10)) {
      // the sink under SAFE_SINK: up as it nears, level as it slows
      const pitch = s.vel.y < -SAFE_SINK ? deg(25) : s.vel.y < -0.25 ? deg(10) : deg(0)
      return { yaw, pitch, rocket: false, phase: 'flare' }
    }
    // down at 20 degrees, steeper when short of reaching (the glide's 3 to 1 too flat for the distance left)
    const pitch = horiz < drop * 1.5 ? -deg(35) : -deg(18)
    return { yaw, pitch, rocket: false, phase: 'descend' }
  }
  if (s.pos.y < s.cruiseY - 3) {
    return { yaw, pitch: deg(30), rocket: !s.boosted && s.rockets > 0 && (speed < 1.4 || s.vel.y < 0), phase: 'climb' }
  }
  if (s.boosted) return { yaw, pitch: s.pos.y > s.cruiseY + 4 ? deg(0) : deg(6), rocket: false, phase: 'cruise' }
  return { yaw, pitch: -deg(4), rocket: s.rockets > 0 && speed < ROCKET_SPEED, phase: 'cruise' }
}

export interface FlyOptions extends SkillOptions {
  /** done within this many blocks of the target on x and z (default 6) */
  range?: number
  /** how high over the start and the target to cruise (default CRUISE_HEIGHT) */
  cruiseHeight?: number
  /** give up after this many ticks (default 40 a block, and 400) */
  maxTicks?: number
  /** put the chestplate back on after (default true) */
  rewearChestplate?: boolean
}

export interface FlyResult {
  /** where the bot landed */
  landed: Vec3
  ticks: number
  rockets: number
  /** blocks flown on x and z */
  distance: number
  /** the elytra's durability spent */
  wear: number
  /** health lost on the way */
  hurt: number
}

const ROCKETS = ['firework_rocket']

/** a trip this long or longer goes by air when it can (travel's fly) */
export const FLY_MIN_DISTANCE = 160
/** rockets a flight takes off with at the least */
export const FLY_MIN_ROCKETS = 4

/**
 * Whether the bot can fly from where it stands: an elytra with wear to spare, FLY_MIN_ROCKETS rockets, on the ground
 * out of water with the sky open over it (no block within 12 over the head)
 */
export function canFly (bot: Bot): boolean {
  const elytra = bestElytra(bot)
  if (elytra == null || durabilityLeft(elytra) <= ELYTRA_LOW_DURABILITY * 2) return false
  if (countItems(bot, ROCKETS) < FLY_MIN_ROCKETS) return false
  if (!bot.entity.onGround || (bot.entity as any).isInWater === true || bot.entity.vehicle != null) return false
  const feet = bot.entity.position.floored()
  for (let dy = 2; dy <= 12; dy++) {
    const b = bot.blockAt(feet.offset(0, dy, 0))
    if (b != null && b.boundingBox !== 'empty') return false
  }
  return true
}

/** the column's feet height at x, z from `fromY` down (null unloaded or none within 64) */
function groundAt (bot: Bot, x: number, z: number, fromY: number): number | null {
  for (let y = Math.floor(fromY); y > fromY - 64; y--) {
    const b = bot.blockAt(new Vec3(x, y, z))
    if (b == null) return null
    if (b.boundingBox === 'block' || b.name === 'water' || b.name === 'lava') return y + 1
  }
  return null
}

/** jump, and jump again off the ground: gliding (the elytra worn) */
export async function startGliding (bot: Bot, signal?: AbortSignal): Promise<void> {
  if (isGliding(bot)) return
  if (!wearingElytra(bot)) await equipElytra(bot)
  for (let attempt = 0; attempt < 3 && !isGliding(bot); attempt++) {
    throwIfAborted(signal)
    if (bot.entity.onGround) {
      bot.setControlState('jump', true)
      await waitTicks(bot, 1, signal)
      bot.setControlState('jump', false)
      // off the ground and on up
      for (let t = 0; t < 6 && bot.entity.onGround; t++) await waitTicks(bot, 1, signal)
      await waitTicks(bot, 2, signal)
    } else {
      bot.setControlState('jump', false)
      await waitTicks(bot, 1, signal)
    }
    bot.setControlState('jump', true)
    await waitTicks(bot, 1, signal)
    bot.setControlState('jump', false)
    for (let t = 0; t < 4 && !isGliding(bot); t++) await waitTicks(bot, 1, signal)
    if (!isGliding(bot)) for (let t = 0; t < 30 && !bot.entity.onGround; t++) await waitTicks(bot, 1, signal)
  }
  if (!isGliding(bot)) throw new TaskError('FAILED', 'the elytra never opened')
}

/** a rocket from the hand, gliding; resolves whether one went */
export async function useRocket (bot: Bot): Promise<boolean> {
  const rocket = bot.inventory.items().find(i => ROCKETS.includes(i.name))
  if (rocket == null) return false
  if (bot.heldItem?.name !== rocket.name) await bot.equip(rocket, 'hand')
  bot.activateItem()
  bot.deactivateItem()
  return true
}

/**
 * Flies to the target with the elytra and rockets carried (steerFlight each tick) and lands: a takeoff from where the
 * bot stands (a jump and the elytra opened at its top, a rocket up), the cruise, the glide down and the flare. Throws
 * MISSING_ITEMS with no elytra (or one worn out), FAILED when it doesn't open, TIMEOUT over maxTicks.
 */
export async function flyTo (bot: Bot, target: Vec3, opts: FlyOptions = {}): Promise<FlyResult> {
  const signal = opts.signal
  const start = bot.entity.position.clone()
  const range = opts.range ?? 6
  const dist0 = Math.hypot(target.x - start.x, target.z - start.z)
  const maxTicks = opts.maxTicks ?? Math.ceil(dist0 * 40 + 400)
  const cruiseY = Math.max(start.y, target.y) + (opts.cruiseHeight ?? CRUISE_HEIGHT)
  const health0 = bot.health
  const elytra = await equipElytra(bot)
  const wear0 = elytra.durabilityUsed ?? 0
  let rockets = 0
  let boostUntil = -1
  let ticks = 0
  try {
    await startGliding(bot, signal)
    let grounded = 0
    for (; ticks < maxTicks; ticks++) {
      throwIfAborted(signal)
      const pos = bot.entity.position
      // on the ground is landed, whatever the gliding flag says: the client's is the server's (the shared flag 7 of
      // the entity's data, LivingEntity.updateFallFlying sets it on the server only) and comes a tick or more after
      grounded = bot.entity.onGround ? grounded + 1 : 0
      if (grounded >= 2 && ticks > 10) break
      if (!isGliding(bot)) {
        // down: on the ground (landed), or in water
        if (bot.entity.onGround || (bot.entity as any).isInWater === true) break
        // the elytra closed in the air (a wall, a stall): open it again
        bot.setControlState('jump', ticks % 2 === 0)
        await waitTicks(bot, 1, signal)
        continue
      }
      const yaw = yawToward(pos, target)
      const ahead = pos.offset(-Math.sin(yaw) * 16, 0, -Math.cos(yaw) * 16)
      const worn = bot.inventory.slots[6]
      const cmd = steerFlight({
        pos,
        vel: bot.entity.velocity,
        target,
        groundUnder: groundAt(bot, pos.x, pos.z, pos.y),
        groundAhead: groundAt(bot, ahead.x, ahead.z, pos.y + 16),
        cruiseY,
        boosted: ticks < boostUntil,
        rockets: countItems(bot, ROCKETS),
        durability: durabilityLeft(worn)
      })
      await bot.look(cmd.yaw, cmd.pitch, true)
      if (cmd.rocket && await useRocket(bot)) {
        rockets++
        boostUntil = ticks + ROCKET_MIN_TICKS
        trace('flyTo: rocket', rockets, 'at', pos.floored().toString(), cmd.phase)
      }
      await waitTicks(bot, 1, signal)
    }
    if (ticks >= maxTicks) throw new TaskError('TIMEOUT', `still in the air after ${ticks} ticks, ${Math.round(Math.hypot(target.x - bot.entity.position.x, target.z - bot.entity.position.z))} blocks short`)
    // the last of the way on foot
    for (let t = 0; t < 10 && !bot.entity.onGround; t++) await waitTicks(bot, 1, signal)
  } finally {
    bot.clearControlStates()
  }
  const landed = bot.entity.position.clone()
  const left = Math.hypot(target.x - landed.x, target.z - landed.z)
  if (opts.rewearChestplate !== false) await equipChestplate(bot).catch(() => {})
  const wear = (bestElytra(bot)?.durabilityUsed ?? wear0) - wear0
  trace('flyTo: landed at', landed.toString(), left.toFixed(1), 'off the target after', ticks, 'ticks and', rockets, 'rockets')
  if (left > Math.max(range, 48)) throw new TaskError('FAILED', `came down ${Math.round(left)} blocks short of ${target.floored().toString()}`)
  return { landed, ticks, rockets, distance: Math.hypot(landed.x - start.x, landed.z - start.z), wear, hurt: Math.max(0, health0 - bot.health) }
}
