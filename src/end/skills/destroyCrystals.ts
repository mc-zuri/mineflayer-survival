import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import type { Pos } from '../../core/memory'
import type { Seed } from '../../worldgen/random'
import { shoot } from '../../skills/shoot'
import { type Entity, TaskError, type SkillOptions, throwIfAborted, waitTicks, eyePosition, distanceToBox } from '../../skills/combatUtil'
import { attackStrengthOf, bestMeleeWeapon } from '../../skills/weapons'
import { wornArmor, armorPiece, damageAfterArmor } from '../../skills/armor'
import { getSpikesForLevel, spikeCenters, type Box, type EndSpike } from '../spikes'
import { CRYSTAL_EXPLOSION_POWER, boxEntry, cellsOnLine, planCrystals, type CrystalTarget, type ShootSpot } from '../crystals'
import { dragonDangers, eatIfHurt, evadeDangers, inDanger, underDragonWatch } from './danger'
import { blockGetter, groundY, digDown, gotoBlock, holdOneOf, pillarUp, PICKAXES, VoidGuard, findPortalY, worldMinY, type BlockGetter } from './world'

// destroyCrystals: the end crystals on the obsidian spikes, by the crystal plan (src/end/crystals): the open ones shot
// from the ground, the caged ones by pillaring up beside the spike, breaking the bars on a shooting line and shooting
// from below (or, with no bow, hitting it from the pillar when the blast can be taken).

/**
 * The spikes as the world shows them: each of the 10 places on the circle read from the blocks (the bedrock cap's
 * height, the obsidian's radius, iron bars round the top), else from the world seed when given, else from a crystal
 * seen on it. Spikes it can't read at all are left out.
 */
export function readSpikes (get: BlockGetter, crystals: Pos[] = [], seed?: Seed): EndSpike[] {
  const fromSeed = seed != null ? getSpikesForLevel(seed) : null
  const out: EndSpike[] = []
  spikeCenters().forEach((c, index) => {
    const known = fromSeed?.[index]
    let height: number | null = null
    let loaded = true
    for (let y = 130; y >= 40; y--) {
      const b = get(new Vec3(c.x, y, c.z))
      if (b == null) { loaded = false; break }
      if (b.name === 'bedrock' || b.name === 'obsidian') { height = b.name === 'bedrock' ? y : y + 1; break }
    }
    if (!loaded || height == null) {
      if (known != null) { out.push(known); return }
      const crystal = crystals.find(p => Math.floor(p.x) === c.x && Math.floor(p.z) === c.z)
      if (crystal == null) return
      height = Math.floor(crystal.y) - 1
    }
    let radius = known?.radius ?? 2
    if (loaded) {
      radius = 0
      while (radius < 6 && get(new Vec3(c.x + radius + 1, height - 1, c.z))?.name === 'obsidian') radius++
    }
    const bar = get(new Vec3(c.x + 2, height + 1, c.z))
    const guarded = bar != null ? bar.name === 'iron_bars' : known?.guarded ?? false
    out.push({ index, centerX: c.x, centerZ: c.z, radius, height, guarded })
  })
  return out
}

/** the end crystals the bot sees on spikes, by spike index */
export function crystalsOnSpikes (bot: Bot, spikes: EndSpike[]): Map<number, Entity> {
  const out = new Map<number, Entity>()
  for (const e of Object.values(bot.entities)) {
    if (e.name !== 'end_crystal') continue
    const spike = spikes.find(s => Math.abs(e.position.x - (s.centerX + 0.5)) < 1.5 && Math.abs(e.position.z - (s.centerZ + 0.5)) < 1.5 && Math.abs(e.position.y - (s.height + 1)) < 2)
    if (spike != null) out.set(spike.index, e)
  }
  return out
}

/**
 * ServerExplosion.hurtEntities' damage to a player at `distance` from the blast with `exposure` (getSeenPercent),
 * after its armor (CombatRules.getDamageAfterAbsorb); blast protection and difficulty scaling left out.
 */
export function explosionDamage (power: number, distance: number, exposure = 1, armor = 0, toughness = 0): number {
  const radius = power * 2
  const d = distance / radius
  if (d > 1) return 0
  const impact = (1 - d) * exposure
  // ExplosionDamageCalculator.getEntityDamageAmount: not rounded (1.21.11 and 26.3)
  const raw = (impact * impact + impact) / 2 * 7 * radius + 1
  return damageAfterArmor(raw, armor, toughness)
}

function armorTotals (bot: Bot): { armor: number, toughness: number } {
  let armor = 0
  let toughness = 0
  for (const item of Object.values(wornArmor(bot))) {
    const piece = item != null ? armorPiece(item.name) : null
    if (piece != null) { armor += piece.defense; toughness += piece.toughness }
  }
  return { armor, toughness }
}

function hasBow (bot: Bot): boolean {
  const items = bot.inventory.items()
  return items.some(i => i.name === 'bow') && items.some(i => ['arrow', 'spectral_arrow', 'tipped_arrow'].includes(i.name))
}

export interface DestroyCrystalsOptions extends SkillOptions {
  /** the world seed, for the spike layout where the blocks aren't loaded */
  seed?: Seed
  /** give up after this many ticks (default 24000) */
  maxTicks?: number
  /** called as each crystal goes (its spike's index) */
  onDestroyed?: (spikeIndex: number) => void
  /** with no bow, hit a caged crystal from the pillar only when its blast leaves this much health (default 4) */
  meleeHealthMargin?: number
  /** eat below this health between crystals (default 12) */
  eatBelowHealth?: number
  /** progress lines */
  log?: (line: string) => void
}

export interface DestroyCrystalsResult {
  /** spikes whose crystal went while the skill ran (entity removal) */
  destroyed: number[]
  /** spikes still holding a crystal (none when it succeeded) */
  remaining: number[]
  ticks: number
}

/**
 * Destroys every end crystal on the spikes. Each pass reads the spikes and the crystals left, plans the nearest one
 * (planCrystals), and does it: open ones shot from the planned spot (a short pillar first when the plan says),
 * caged ones by towering up beside the spike, breaking the bars on the shooting line, digging back down and
 * shooting. A crystal counts as destroyed when its entity is removed. Throws MISSING_ITEMS with no way to reach a
 * crystal (no bow and the blast too strong, no blocks to pillar with), TIMEOUT after maxTicks.
 */
export async function destroyCrystals (bot: Bot, opts: DestroyCrystalsOptions = {}): Promise<DestroyCrystalsResult> {
  const signal = opts.signal
  const maxTicks = opts.maxTicks ?? 24000
  const get = blockGetter(bot)
  const destroyed: number[] = []
  const ids = new Map<number, number>()
  const brokenBars: Pos[] = []
  const failures = new Map<number, number>()
  /** the last failure on each spike */
  const reasons = new Map<number, string>()
  /** caged spikes whose bars on the shooting line are broken: shot from there now */
  const opened = new Map<number, ShootSpot>()
  /** shooting spots whose line the world's own blocks stop (x,z) */
  const badSpots = new Set<string>()
  const ground = findPortalY(get) ?? 62
  const guard = new VoidGuard(get, 3, worldMinY(bot))
  let spikes = readSpikes(get, [], opts.seed)
  /** the pillar the bot is building or standing on, and the ground it went up from */
  const pillar: PillarState = { current: null }
  const onGone = (e: Entity): void => {
    const index = ids.get(e.id)
    if (index == null) return
    ids.delete(e.id)
    destroyed.push(index)
    opts.onDestroyed?.(index)
  }
  bot.on('entityGone', onGone)
  let ticks = 0
  const tickCounter = (): void => { ticks++ }
  bot.on('physicsTick', tickCounter)
  const remaining = (): Map<number, Entity> => {
    const crystals = Object.values(bot.entities).filter(e => e.name === 'end_crystal').map(e => e.position)
    spikes = readSpikes(get, crystals, opts.seed)
    const on = crystalsOnSpikes(bot, spikes)
    for (const [index, e] of on) ids.set(e.id, index)
    return on
  }
  try {
    for (;;) {
      throwIfAborted(signal)
      if (ticks > maxTicks) throw new TaskError('TIMEOUT', `crystals left after ${maxTicks} ticks`)
      const left = remaining()
      const todo = [...left.keys()].filter(i => (failures.get(i) ?? 0) < MAX_FAILURES)
      if (todo.length === 0) {
        if (left.size > 0) throw new TaskError('NO_PATH', `couldn't destroy the crystals on spikes ${[...left.keys()].map(i => `${i} (${reasons.get(i) ?? '?'})`).join(', ')}`)
        break
      }
      // the clouds on the ground now, with room for them to grow (a fireball's goes from 3 to 7 over 600 ticks)
      const clouds = dragonDangers(bot, ground).filter(d => d.why === 'cloud' || d.why === 'fireball').map(d => ({ ...d, radius: d.radius + 1.5 }))
      const avoid = (x: number, z: number): boolean => badSpots.has(`${Math.floor(x)},${Math.floor(z)}`) || inDanger({ x, y: ground, z }, clouds.map(d => ({ ...d, y: undefined })), 1) != null
      const plan = planCrystals(spikes, {
        avoid,
        groundY: cachedGround(get),
        bow: hasBow(bot),
        from: { x: bot.entity.position.x, z: bot.entity.position.z },
        destroyed: spikes.map(s => s.index).filter(i => !todo.includes(i)),
        brokenBars
      })
      if (plan.length === 0) break
      // a pillar's column under a cloud is no place to go: the next crystal, or a wait out of the clouds when every one's
      // is (a 26.3 bot went back to spike 4's column in a fireball's cloud 20 times and died in it)
      let target = plan.find(t => !pillarUnderCloud(t, avoid))
      if (target == null) {
        opts.log?.(`every crystal's pillar under a cloud: waiting it out`)
        await evadeDangers(bot, () => dragonDangers(bot, ground), guard, { signal, island: ground, maxTicks: 40 })
        await waitTicks(bot, 20, signal)
        continue
      }
      const open = opened.get(target.spike.index)
      if (open != null) target = { ...target, method: 'shoot', shootFrom: open }
      // the world's own blocks on the line from there (the shot's arrow world clips on them; the plan knows the spikes
      // only): that spot left out, and planned again (five 'no arc reaches the target' from one spot left a caged
      // crystal, and the dragon healed by it back to 200, 26.3)
      if (target.shootFrom != null && shotLineBlocked(get, target.shootFrom, target.crystal.box)) {
        badSpots.add(`${Math.floor(target.shootFrom.x)},${Math.floor(target.shootFrom.z)}`)
        opened.delete(target.spike.index)
        opts.log?.(`spike ${target.spike.index}: the line from ${target.shootFrom.x} ${target.shootFrom.y} ${target.shootFrom.z} is blocked: planned again`)
        continue
      }
      const crystal = left.get(target.spike.index) as Entity
      // up a pillar of a job cut short (a dodge, a cloud on it) and off to another: down it first, the way it went up
      // (a 1.21.11 bot left on spike 0's pillar 20 blocks up walked for spike 1's spot, 'stopped short' three times, and fell)
      const down = pillarToLeave(pillar, bot.entity.position, target)
      if (down != null) {
        opts.log?.(`down the pillar at ${down.column.x} ${down.column.z} to ${down.base} first`)
        const t = down
        await underDragonWatch(bot, ground, async (s) => await digDown(bot, t.base, { signal: s }), { signal, guard, eatBelowHealth: opts.eatBelowHealth, log: opts.log }).catch(async err => {
          if (!TaskError.is(err) || ['ABORTED', 'PREEMPTED', 'DIED'].includes(err.code)) throw err
          opts.log?.(`down the pillar: ${err.code} ${err.message}`)
          // a dig that fails at once fails again: counted (pillarToLeave lets go after MAX_DOWN_TRIES), and a moment let by
          down.downTries = (down.downTries ?? 0) + 1
          await waitTicks(bot, 10, signal)
        })
        if (Math.floor(bot.entity.position.y + 1e-6) <= down.base || !onColumn(bot.entity.position, down.column)) pillar.current = null
        continue
      }
      if (pillar.current != null && !onColumn(bot.entity.position, pillar.current.column)) pillar.current = null
      opts.log?.(`spike ${target.spike.index} (${target.spike.centerX}, ${target.spike.centerZ}, h ${target.spike.height}${target.spike.guarded ? ', caged' : ''}): ${target.method} from ${JSON.stringify(target.shootFrom != null ? { x: target.shootFrom.x, y: target.shootFrom.y, z: target.shootFrom.z, pillar: target.shootFrom.pillar } : null)}`)
      guard.update(bot.entity.position, bot.entity.onGround)
      await eatIfHurt(bot, opts.eatBelowHealth ?? 12, signal)
      try {
        const t = target
        const done = await underDragonWatch(bot, ground, async (s) => await destroyOne(bot, t, crystal, brokenBars, opened, { ...opts, signal: s }, (p) => avoid(p.x, p.z), pillar), { signal, guard, eatBelowHealth: opts.eatBelowHealth, log: opts.log })
        if (!done) opts.log?.(`spike ${target.spike.index}: out of the dragon's way first`)
      } catch (err) {
        if (!TaskError.is(err) || ['ABORTED', 'PREEMPTED', 'DIED'].includes(err.code)) throw err
        if (err.code === 'MISSING_ITEMS') throw err
        opts.log?.(`spike ${target.spike.index} failed: ${err.code} ${err.message}`)
        failures.set(target.spike.index, (failures.get(target.spike.index) ?? 0) + 1)
        // no arc from the spot the opened cage was planned to be shot from: planned again (with the bars broken so far),
        // up the pillar for the ones still on a line (five 'no arc reaches the target' from one spot, the crystal left
        // and the dragon healed by it back to 200, 26.3)
        if (open != null) opened.delete(target.spike.index)
        reasons.set(target.spike.index, err.message)
        // what failed at once (a walk the pathfinder gave up on) may well work a moment later
        await waitTicks(bot, 10, signal)
      }
      // the explosion and the entity removal arrive within a few ticks of the hit
      await waitTicks(bot, 2, signal)
    }
  } finally {
    bot.off('entityGone', onGone)
    bot.off('physicsTick', tickCounter)
    bot.clearControlStates()
  }
  return { destroyed, remaining: [...remaining().keys()], ticks }
}

/** a block of the world's (not a cage's bar) on the straight line from a shooting spot's eyes into the crystal's box */
export function shotLineBlocked (get: BlockGetter, spot: ShootSpot, box: Box): boolean {
  const eye = { x: spot.x, y: spot.y + 1.62, z: spot.z }
  return cellsOnLine(eye, boxEntry(eye, spot.aim, box)).some(c => {
    const b = get(new Vec3(c.x, c.y, c.z))
    return b != null && b.boundingBox === 'block' && b.name !== 'iron_bars'
  })
}

/** the target is a pillar job whose column is in ground to avoid (a cloud) */
export function pillarUnderCloud (target: CrystalTarget, avoid: (x: number, z: number) => boolean): boolean {
  return target.method === 'pillar' && target.pillar != null && avoid(target.pillar.column.x + 0.5, target.pillar.column.z + 0.5)
}

/** a pillar the bot went up for a caged crystal: its column and the feet height at its foot */
export interface PillarState {
  current: { column: { x: number, z: number }, base: number, downTries?: number } | null
}

/** failed tries at coming down a pillar before it is left be (the next job's walk takes the bot off it its own way) */
export const MAX_DOWN_TRIES = 2

function onColumn (pos: Pos, column: { x: number, z: number }): boolean {
  return Math.floor(pos.x) === column.x && Math.floor(pos.z) === column.z
}

/**
 * The pillar to come down before the next job: the bot is up the one it went up (on its column, over its foot) and the
 * next job isn't on up the same column
 */
export function pillarToLeave (pillar: PillarState, pos: Pos, next: CrystalTarget): NonNullable<PillarState['current']> | null {
  const p = pillar.current
  if (p == null || !onColumn(pos, p.column) || Math.floor(pos.y + 1e-6) <= p.base || (p.downTries ?? 0) >= MAX_DOWN_TRIES) return null
  if (next.method === 'pillar' && next.pillar != null && next.pillar.column.x === p.column.x && next.pillar.column.z === p.column.z) return null
  return p
}

/** tries at a crystal before it is left (a dodge of the dragon is not one) */
const MAX_FAILURES = 5

function cachedGround (get: BlockGetter): (x: number, z: number) => number {
  const cache = new Map<string, number>()
  return (x, z) => {
    const k = `${Math.floor(x)},${Math.floor(z)}`
    let y = cache.get(k)
    if (y == null) {
      y = groundY(get, x, z, 90) ?? 64
      cache.set(k, y)
    }
    return y
  }
}

async function destroyOne (bot: Bot, target: CrystalTarget, crystal: Entity, brokenBars: Pos[], opened: Map<number, ShootSpot>, opts: DestroyCrystalsOptions, avoid: (p: Vec3) => boolean, pillar: PillarState = { current: null }): Promise<void> {
  const signal = opts.signal
  const get = blockGetter(bot)
  if (target.method === 'pillar' && target.pillar != null) {
    const { column, topY, breakBars } = target.pillar
    // the foot of the pillar: where it went up from, when the bot is up it already
    const same = pillar.current != null && pillar.current.column.x === column.x && pillar.current.column.z === column.z
    const base = same ? (pillar.current as { base: number }).base : groundY(get, column.x, column.z, topY + 2)
    if (base != null) pillar.current = { column, base }
    await pillarUp(bot, column, topY, { signal, avoid })
    opts.log?.(`up the pillar at ${bot.entity.position.floored().toString()} (from ${String(base)}): ${breakBars.length} bars to break`)
    for (const bar of breakBars) {
      throwIfAborted(signal)
      const block = bot.blockAt(new Vec3(bar.x, bar.y, bar.z))
      // out of reach (Player.blockInteractionRange 4.5): left, the shot may still get through
      if (eyePosition(bot).distanceTo(new Vec3(bar.x + 0.5, bar.y + 0.5, bar.z + 0.5)) > 4.5) continue
      if (block != null && block.name === 'iron_bars') {
        // iron bars want a pickaxe (by hand they take 25 seconds and drop nothing)
        await holdOneOf(bot, PICKAXES)
        await bot.dig(block, true)
      }
      brokenBars.push(bar)
    }
    if (target.shootFrom != null) opened.set(target.spike.index, target.shootFrom)
    if (target.shootFrom == null) {
      await hitFromPillar(bot, crystal, opts)
      return
    }
    // down the way it came, digging the pillar out under the feet
    if (base != null) await digDown(bot, base, { signal })
    pillar.current = null
  }
  const spot = target.shootFrom
  if (spot == null) throw new TaskError('NO_PATH', `no spot to shoot spike ${target.spike.index}'s crystal from`)
  const ground = groundY(get, spot.x, spot.z, spot.y + 4) ?? spot.y - spot.pillar
  if (spot.pillar > 0) await pillarUp(bot, { x: Math.floor(spot.x), z: Math.floor(spot.z) }, ground + spot.pillar, { signal, avoid })
  else await gotoBlock(bot, { x: spot.x, y: ground, z: spot.z }, { signal, avoid })
  try {
    // at the point the plan found a clear line to (over the spike's rim, through the opened bars)
    const aimOffset = new Vec3(spot.aim.x - crystal.position.x, spot.aim.y - crystal.position.y, spot.aim.z - crystal.position.z)
    let result = await shoot(bot, crystal, { signal, maxShots: 3, aimOffset })
    if (!result.hit && bot.entities[crystal.id] === crystal) result = await shoot(bot, crystal, { signal, maxShots: 2 })
    if (!result.hit) throw new TaskError('NO_PATH', `the arrows missed spike ${target.spike.index}'s crystal`)
  } finally {
    if (spot.pillar > 0) await digDown(bot, ground, { signal }).catch(() => {})
  }
}

/**
 * With no bow: the crystal hit from the pillar at arm's length. Its blast (power 6) hits the bot nearly in full, so
 * it only swings when its health covers the damage the armor lets through, with a margin.
 */
async function hitFromPillar (bot: Bot, crystal: Entity, opts: DestroyCrystalsOptions): Promise<void> {
  const box = { min: crystal.position.offset(-1, 0, -1), max: crystal.position.offset(1, 2, 1) }
  const reach = distanceToBox(eyePosition(bot), box)
  if (reach > 3) throw new TaskError('NO_PATH', `the crystal is ${reach.toFixed(1)} blocks out of reach`)
  const { armor, toughness } = armorTotals(bot)
  const damage = explosionDamage(CRYSTAL_EXPLOSION_POWER, bot.entity.position.distanceTo(crystal.position), 1, armor, toughness)
  if (bot.health - damage < (opts.meleeHealthMargin ?? 4)) throw new TaskError('MISSING_ITEMS', `a bow is needed: the blast would deal ${damage.toFixed(0)}`)
  const weapon = bestMeleeWeapon(bot, 'end_crystal')
  if (weapon != null && bot.heldItem?.type !== weapon.type) await bot.equip(weapon, 'hand')
  await bot.lookAt(crystal.position.offset(0, 1, 0), true)
  attackStrengthOf(bot).attack(crystal)
}
