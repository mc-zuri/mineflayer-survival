import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import type { Seed } from '../../worldgen/random'
import { solveAim, arrowHits, bowArrowSpeed, type AimSolution } from '../../skills/arrow'
import { arrowStart, arrowWorld } from '../../skills/shoot'
import { motionTrackerOf } from '../../skills/motion'
import { attackStrengthOf } from '../../skills/weapons'
import { bestFoodInInventory } from '../../skills/eat'
import { steerToward } from '../../skills/steer'
import { type Entity, TaskError, type SkillOptions, throwIfAborted, waitTicks, metadataValue, eyePosition, yawPitchOf, distanceToBox } from '../../skills/combatUtil'
import { DragonPhaseTracker, headPosition, meleeSpots, vanillaYaw, MELEE_REACH, type DragonView, type MeleeWindow, DRAGON_PHASE_METADATA } from '../dragon'
import { exitPortal } from '../spikes'
import { destroyCrystals } from './destroyCrystals'
import { blockGetter, groundY, isOpenAt, VoidGuard, findPortalY, exitPortalOpen, worldMinY, type BlockGetter } from './world'
import { dragonDangers, eatIfHurt, inDanger, safeSpot, type Danger } from './danger'

// fightDragon: the Ender Dragon fought until it dies and the exit portal opens. While it sits on the fountain (the
// phase tracker's melee window) the bot stands outside the breath and hits the head with crits; while it flies the
// bot shoots it when an arc reaches, keeps out of the breath clouds and the fireballs' landing, steps aside from a
// charge, and keeps away from the island's edge (water bucket ready for a fall).

/** the head part's entity id: EnderDragon.setId gives the parts the ids after the dragon's, the head first */
export function dragonPartId (dragon: { id: number }, part: 'head' | 'neck' | 'body' = 'head'): number {
  return dragon.id + 1 + ['head', 'neck', 'body'].indexOf(part)
}

export interface MeleeChoice {
  spot: Vec3
  target: 'head' | 'body'
}

/**
 * The melee spot to stand at: meleeSpots for the ground levels round the podium (the end stone, and the bedrock rim
 * a block up), kept to the ones a body can actually stand at, out of every danger and the void's margin. A spot a
 * little short of full reach is preferred over the closest (the head and neck hurt what touches them: EnderDragon's
 * hurt(head box inflated 1)).
 */
export function chooseMeleeSpot (get: BlockGetter, view: DragonView, portalY: number, window: MeleeWindow, dangers: Danger[], guard: VoidGuard | null): MeleeChoice | null {
  const spots: Array<{ spot: Vec3, target: 'head' | 'body', score: number }> = []
  for (const g of [portalY, portalY + 1, portalY - 1]) {
    for (const s of meleeSpots(view, g, window.breath)) {
      const cell = new Vec3(Math.floor(s.x), g, Math.floor(s.z))
      if (groundY(get, s.x, s.z, g + 2, g - 2) !== g) continue
      if (!isOpenAt(get, cell) || !isOpenAt(get, cell.offset(0, 1, 0))) continue
      if (inDanger(s, dangers, 1) != null) continue
      if (guard?.risky(s) === true) continue
      const score = (s.target === 'head' ? 0 : 10) + Math.abs(s.reach - 2.2)
      spots.push({ spot: new Vec3(s.x, g, s.z), target: s.target, score })
    }
  }
  spots.sort((a, b) => a.score - b.score)
  return spots[0] ?? null
}

export interface FightDragonOptions extends SkillOptions {
  /** the world seed (the crystals' spikes, when their blocks aren't loaded) */
  seed?: Seed
  /** destroy the crystals left first, so they can't heal it (default true) */
  destroyCrystals?: boolean
  /** shoot it in flight (default true, with a bow and arrows) */
  bow?: boolean
  /** give up after this many ticks (default 48000) */
  maxTicks?: number
  /** eat below this health when the dragon is away (default 12) */
  eatBelowHealth?: number
  /** keep this far from the void (default 4) */
  voidMargin?: number
  /** stay within this distance of the podium while it flies (default 24) */
  homeRadius?: number
  /** progress lines */
  log?: (line: string) => void
}

export interface FightDragonResult {
  killed: boolean
  ticks: number
  meleeHits: number
  arrows: number
  /** the perches seen (melee windows opened) */
  perches: number
  /** the dragon's health when last seen */
  health: number
}

const ARROW_NAMES = ['arrow', 'spectral_arrow', 'tipped_arrow']

/**
 * Fights the Ender Dragon until it dies and the exit portal opens. Each tick it reads the dragon (phase from its
 * metadata into the DragonPhaseTracker, health), then in order: a water bucket for a fall, out of any danger (breath
 * clouds, a fireball's landing, a charge's line, the breath the tracker expects), melee while the window is open,
 * eat when hurt and the dragon is far, a bow shot while it flies, else back towards the podium. Throws TIMEOUT
 * after maxTicks, DIED with the bot.
 */
export async function fightDragon (bot: Bot, opts: FightDragonOptions = {}): Promise<FightDragonResult> {
  const signal = opts.signal
  const log = opts.log ?? (() => {})
  const get = blockGetter(bot)
  const maxTicks = opts.maxTicks ?? 48000
  const eatBelow = opts.eatBelowHealth ?? 12
  const homeRadius = opts.homeRadius ?? 24
  const portalY = findPortalY(get) ?? 64
  const portal = exitPortal(portalY)
  const home = new Vec3(0.5, portalY, 0.5)
  const guard = new VoidGuard(get, opts.voidMargin ?? 4, worldMinY(bot))
  const tracker = new DragonPhaseTracker(portal.perch)
  const motion = motionTrackerOf(bot)
  const strength = attackStrengthOf(bot)

  if (opts.destroyCrystals !== false && Object.values(bot.entities).some(e => e.name === 'end_crystal')) {
    log('crystals first')
    await destroyCrystals(bot, { signal, seed: opts.seed, log: opts.log })
  }

  let dragonId: number | null = null
  let killed = false
  let health = 200
  const onGone = (e: Entity): void => { if (e.id === dragonId) killed = killed || health <= 0 || tracker.phase === 'dying' }
  bot.on('entityGone', onGone)
  let tick = 0
  let meleeHits = 0
  let arrows = 0
  let perches = 0
  let wasOpen = false
  let drawing: number | null = null
  let jumpedAt = -100
  let water: Vec3 | null = null
  let wasRisky = false
  let wasOverVoid = false
  const hasArrows = (): boolean => bot.inventory.items().some(i => ARROW_NAMES.includes(i.name))
  const bow = (): boolean => opts.bow !== false && bot.inventory.items().some(i => i.name === 'bow') && hasArrows()
  const hold = async (name: string): Promise<boolean> => {
    if (bot.heldItem?.name === name) return true
    const item = bot.inventory.items().find(i => i.name === name)
    if (item == null) return false
    await bot.equip(item, 'hand')
    return true
  }
  const sword = (): string | null => {
    const order = ['netherite_sword', 'diamond_sword', 'iron_sword', 'netherite_axe', 'diamond_axe', 'stone_sword', 'iron_axe', 'wooden_sword']
    return order.find(n => bot.inventory.items().some(i => i.name === n) || bot.heldItem?.name === n) ?? null
  }
  const stopDraw = (): void => {
    if (drawing != null) { bot.deactivateItem(); drawing = null }
  }

  try {
    for (;;) {
      throwIfAborted(signal)
      if (tick++ > maxTicks) throw new TaskError('TIMEOUT', `the dragon is alive after ${maxTicks} ticks (health ${health})`)
      const dragon = Object.values(bot.entities).find(e => e.name === 'ender_dragon') ?? null
      if (dragon != null) {
        dragonId = dragon.id
        motion.track(dragon)
        const phase = (dragon.metadata as any)?.[DRAGON_PHASE_METADATA]
        const view = { position: dragon.position.clone(), yaw: vanillaYaw(dragon.yaw) }
        tracker.update({ tick, phase: typeof phase === 'number' ? phase : 0, ...view })
        const h = metadataValue(bot, dragon, 'health')
        if (typeof h === 'number') { health = h; tracker.updateHealth(h) }
        if (health <= 0 || tracker.phase === 'dying') killed = true
      }
      if (killed || (dragon == null && exitPortalOpen(get, portal))) {
        stopDraw()
        bot.clearControlStates()
        // EnderDragon.tickDeath: 200 ticks of dying, then the exit portal (EndDragonFight.setDragonKilled)
        for (let t = 0; t < 600 && !exitPortalOpen(get, portal); t++) await waitTicks(bot, 1, signal)
        if (!exitPortalOpen(get, portal)) throw new TaskError('TIMEOUT', 'the dragon died but the exit portal stayed shut')
        log(`dragon dead after ${tick} ticks: ${meleeHits} hits, ${arrows} arrows, ${perches} perches`)
        return { killed: true, ticks: tick, meleeHits, arrows, perches, health: 0 }
      }

      const me = bot.entity.position
      guard.update(me, bot.entity.onGround)

      // 1. falling: a water bucket under the landing (and picked back up once in it)
      if (water != null && bot.entity.onGround) {
        if (bot.blockAt(water)?.name === 'water' && await hold('bucket')) {
          await bot.lookAt(water.offset(0.5, 0.5, 0.5), true)
          bot.activateItem()
        }
        water = null
      }
      if (!bot.entity.onGround && bot.entity.velocity.y < -0.6) {
        const ground = groundY(get, me.x, me.z, me.y, me.y - 40)
        if (ground != null && me.y - ground < 3.5 && me.y - ground > 1 && bot.inventory.items().some(i => i.name === 'water_bucket')) {
          stopDraw()
          await hold('water_bucket')
          await bot.look(bot.entity.yaw, -Math.PI / 2, true)
          bot.activateItem()
          water = new Vec3(Math.floor(me.x), ground, Math.floor(me.z))
        }
        await waitTicks(bot, 1, signal)
        continue
      }

      // 2. dangers: the clouds on the ground, the breath the perched dragon is about to breathe, a fireball's landing, a charge
      const window = tracker.window(tick)
      if (window.open && !wasOpen) { perches++; log(`perched (${String(window.phase)}) at tick ${tick}, health ${health}`) }
      wasOpen = window.open
      const dangers = dragonDangers(bot, portalY)
      if (window.breath != null && (window.phase === 'sitting_flaming' || (window.phase === 'sitting_attacking' && window.phaseTicks > 10))) {
        dangers.push({ center: window.breath.center, y: portalY, radius: window.breath.radius, why: 'breath' })
      }
      const danger = inDanger(me, dangers)
      if (danger != null) {
        stopDraw()
        const to = safeSpot(get, me, dangers, guard, { home, homeRadius: homeRadius + 8 })
        if (to != null) steerToward(bot, to, { sprint: true })
        else bot.clearControlStates()
        await waitTicks(bot, 1, signal)
        continue
      }

      // knocked near the edge (the wings, a charge): back to where it last stood safe, or to the podium
      if (bot.entity.onGround && guard.risky(me)) {
        stopDraw()
        if (!wasRisky) log(`near the void at ${me.floored().toString()}: back to ${String(guard.lastSafe ?? home)}`)
        wasRisky = true
        steerToward(bot, guard.lastSafe ?? home, { sprint: false })
        await waitTicks(bot, 1, signal)
        continue
      }
      wasRisky = false
      if (guard.overVoid && !wasOverVoid) log(`over the void at ${me.floored().toString()}`)
      wasOverVoid = guard.overVoid

      // 3. the dragon on the fountain: to a melee spot, and hit the head
      if (window.open && dragon != null) {
        stopDraw()
        const view = { position: dragon.position, yaw: vanillaYaw(dragon.yaw) }
        const choice = chooseMeleeSpot(get, view, portalY, window, dangers, guard)
        const weapon = sword()
        if (weapon != null) await hold(weapon)
        const head = headPosition(view)
        const headBox = { min: new Vec3(head.x - 0.5, head.y, head.z - 0.5), max: new Vec3(head.x + 0.5, head.y + 1, head.z + 0.5) }
        const reach = distanceToBox(eyePosition(bot), headBox)
        const at = choice != null && Math.hypot(me.x - choice.spot.x, me.z - choice.spot.z) < 0.6
        if (choice != null && !at && reach > MELEE_REACH - 0.2) {
          steerToward(bot, choice.spot, { sprint: Math.hypot(me.x - choice.spot.x, me.z - choice.spot.z) > 4 })
          await waitTicks(bot, 1, signal)
          continue
        }
        bot.setControlState('forward', false)
        bot.setControlState('sprint', false)
        const target = choice?.target === 'body' && reach > MELEE_REACH ? 'body' : 'head'
        const aimAt = target === 'head' ? new Vec3(head.x, head.y + 0.5, head.z) : dragon.position.offset(0, 1.5, 0)
        const { yaw, pitch } = yawPitchOf(aimAt.minus(eyePosition(bot)))
        await bot.look(yaw, pitch, true)
        const airborne = tick - jumpedAt <= 14 && !bot.entity.onGround
        const falling = !bot.entity.onGround && bot.entity.velocity.y < 0
        if (bot.entity.onGround && !airborne && strength.ticksToFull() <= 5 && strength.ticksToFull() > 0) {
          // a jump peaks after about 6 ticks: the fall comes with a full swing (Player.attack's crit)
          bot.setControlState('jump', true)
          jumpedAt = tick
        } else {
          bot.setControlState('jump', false)
        }
        const inReach = target === 'head' ? reach <= MELEE_REACH : distanceToBox(eyePosition(bot), { min: dragon.position.offset(-2.5, 0, -2.5), max: dragon.position.offset(2.5, 3, 2.5) }) <= MELEE_REACH
        if (inReach && strength.scale(0.5) >= 1 && (falling || (bot.entity.onGround && tick - jumpedAt > 14))) {
          strength.attack({ id: dragonPartId(dragon, target) } as any)
          meleeHits++
        }
        await waitTicks(bot, 1, signal)
        continue
      }
      bot.setControlState('jump', false)

      // 4. eat while it's away
      const far = dragon == null || dragon.position.distanceTo(me) > 40
      if ((bot.health < eatBelow || bot.food < 14) && far && bestFoodInInventory(bot) != null && tracker.phase !== 'charging_player') {
        stopDraw()
        bot.clearControlStates()
        await eatIfHurt(bot, eatBelow, signal)
        continue
      }

      // 5. a bow shot while it flies (arrows are wasted on it sitting: AbstractDragonSittingPhase.onHurt)
      if (dragon != null && bow() && window.activity !== 'perched' && window.activity !== 'landing') {
        const solution = aimAtDragon(bot, dragon, drawing != null ? Math.max(1, 21 - (tick - drawing)) : 22)
        if (drawing == null) {
          if (solution != null && dragon.position.distanceTo(me) < 90) {
            await hold('bow')
            bot.clearControlStates()
            bot.activateItem()
            drawing = tick
          }
        } else {
          if (solution != null) await bot.look(solution.yaw, solution.pitch, true)
          if (tick - drawing >= 21 && solution != null) {
            bot.deactivateItem()
            drawing = null
            arrows++
          } else if (tick - drawing > 80) {
            stopDraw()
          }
        }
        await waitTicks(bot, 1, signal)
        continue
      }
      stopDraw()

      // 6. wait near the podium, out of the way
      const off = Math.hypot(me.x - home.x, me.z - home.z)
      if (off > homeRadius * 0.6 || off < 6) {
        const to = off < 6 ? me.plus(new Vec3(me.x - home.x, 0, me.z - home.z).normalize().scaled(4)) : home
        steerToward(bot, to, { sprint: false })
      } else {
        bot.clearControlStates()
      }
      await waitTicks(bot, 1, signal)
    }
  } finally {
    bot.off('entityGone', onGone)
    if (dragonId != null) motion.untrack({ id: dragonId } as any)
    stopDraw()
    bot.clearControlStates()
  }
}

/**
 * The bow's aim at the flying dragon: the middle of its body part (a 5×3 box at its position), led by its velocity
 * over the arrow's flight; null when no arc gets there before a block.
 */
export function aimAtDragon (bot: Bot, dragon: Entity, leadTicks: number): AimSolution | null {
  const start = arrowStart(bot)
  const point = dragon.position.offset(0, 1.5, 0)
  const velocity = motionTrackerOf(bot).velocity(dragon)
  // blocks only: the End's sky has no water to slow the arrow (and the water lookups each step are most of the cost)
  const world = { clip: arrowWorld(bot).clip }
  const common = { speed: bowArrowSpeed(20), targetVelocity: velocity, leadTicks, world }
  const solution = solveAim(start, point, { ...common, highArc: false })
  if (solution == null || solution.ticks > 60) return null
  const offset = solution.aimPoint.minus(point)
  const box = { min: dragon.position.offset(-2.5, 0, -2.5).plus(offset), max: dragon.position.offset(2.5, 3, 2.5).plus(offset) }
  return arrowHits(start, solution.yaw, solution.pitch, box, common).hit != null ? solution : null
}
