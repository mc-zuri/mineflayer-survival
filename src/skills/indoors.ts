// indoors: in behind a door, shut, from the mobs that can't open one (a pillager patrol's crossbows, skeletons): a
// house or the base's airlock near the bot, the door between it and them.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { goals } from '@nxg-org/mineflayer-pathfinder'
import { SkillError, isAbort, throwIfAborted } from './errors'
import { navigate } from './navigate'
import { eat, bestFoodInInventory } from './eat'
import { isAlive, type Entity } from './combatUtil'
import { trace, waitTicks } from './util'
import type { BlockLookup } from './placement'
import { findBlocks } from '../core/findBlocks'

/** a door the bot can open by hand (DoorBlock's wooden doors and the copper ones: an iron door takes redstone) */
export function isHandDoor (name: string): boolean {
  return name.endsWith('_door') && name !== 'iron_door'
}

export interface DoorRefuge {
  /** the door's lower half */
  door: Vec3
  /** the cell to stand in behind the door (its feet) */
  inside: Vec3
  /** the cell in front of it */
  outside: Vec3
}

/** blocks over a cell's head that make it roofed */
export const ROOF_HEIGHT = 4

const FACINGS: Record<string, Vec3> = { north: new Vec3(0, 0, -1), south: new Vec3(0, 0, 1), west: new Vec3(-1, 0, 0), east: new Vec3(1, 0, 0) }

const standable = (lookup: BlockLookup, feet: Vec3): boolean => {
  const floor = lookup(feet.offset(0, -1, 0))
  const a = lookup(feet)
  const b = lookup(feet.offset(0, 1, 0))
  return floor?.boundingBox === 'block' && a?.boundingBox === 'empty' && b?.boundingBox === 'empty' &&
    !/water|lava|fire/.test(a.name) && !/water|lava|fire/.test(b.name)
}

const roofed = (lookup: BlockLookup, feet: Vec3): boolean => {
  for (let dy = 2; dy <= 1 + ROOF_HEIGHT; dy++) if (lookup(feet.offset(0, dy, 0))?.boundingBox === 'block') return true
  return false
}

/**
 * The door's two sides (along its facing, DoorBlock.FACING: the panel lies across it), each a cell to stand in; the
 * inside is a roofed one, the further from the threats when both are (the base's airlock), else null (no roof on
 * either side, or a side to stand in missing)
 */
export function doorRefuge (lookup: BlockLookup, door: Vec3, facing: string, threats: Vec3): DoorRefuge | null {
  const f = FACINGS[facing]
  if (f == null) return null
  const sides = [door.plus(f), door.minus(f)].filter(c => standable(lookup, c))
  if (sides.length < 2) return null
  const inside = sides.filter(c => roofed(lookup, c))
    .sort((a, b) => b.offset(0.5, 0, 0.5).distanceTo(threats) - a.offset(0.5, 0, 0.5).distanceTo(threats))[0]
  if (inside == null) return null
  const outside = sides.find(c => !c.equals(inside)) as Vec3
  return { door, inside, outside }
}

/**
 * The door to get in behind from the threats: of the hand doors within `maxDistance` (their lower halves), one with a
 * roofed side (doorRefuge) that the bot is nearer than the nearest threat is (it gets there first), the nearest first
 */
export function findDoorRefuge (bot: Bot, threats: Entity[], maxDistance = 32): DoorRefuge | null {
  if (threats.length === 0 || (typeof (bot.world as any)?.getColumn !== 'function' && typeof bot.findBlocks !== 'function')) return null
  const ids = (bot.registry.blocksArray as any[]).filter(b => isHandDoor(b.name)).map(b => b.id)
  if (ids.length === 0) return null
  const lookup: BlockLookup = (p) => bot.blockAt(p) as any
  const pos = bot.entity.position
  const centroid = threats.reduce((sum, e) => sum.plus(e.position), new Vec3(0, 0, 0)).scaled(1 / threats.length)
  let best: { refuge: DoorRefuge, d: number } | null = null
  for (const at of findBlocks(bot, { matching: ids, maxDistance, count: 16 })) {
    const block = bot.blockAt(at) as any
    const props = block?.getProperties?.() ?? {}
    if (props.half !== 'lower') continue
    const refuge = doorRefuge(lookup, at, String(props.facing), centroid)
    if (refuge == null) continue
    const c = refuge.inside.offset(0.5, 0, 0.5)
    const d = pos.distanceTo(c)
    const nearestThreat = Math.min(...threats.map(e => e.position.distanceTo(c)))
    if (d >= nearestThreat && d > 4) continue
    if (best == null || d < best.d) best = { refuge, d }
  }
  return best?.refuge ?? null
}

/** whether the door at `pos` is open (its open state) */
export function doorOpen (bot: Bot, pos: Vec3): boolean {
  const props = (bot.blockAt(pos) as any)?.getProperties?.() ?? {}
  return props.open === true || props.open === 'true'
}

/** the door shut with a right click (DoorBlock.useWithoutItem), checked by its block update; whether it's shut */
export async function shutDoor (bot: Bot, pos: Vec3, signal?: AbortSignal): Promise<boolean> {
  for (let attempt = 0; attempt < 3 && doorOpen(bot, pos); attempt++) {
    throwIfAborted(signal)
    const block = bot.blockAt(pos)
    if (block == null) return false
    await bot.lookAt(pos.offset(0.5, 0.5, 0.5), true)
    await bot.activateBlock(block as any).catch(err => { if (isAbort(err)) throw err })
    for (let t = 0; t < 10 && doorOpen(bot, pos); t++) await waitTicks(bot, 1, signal)
  }
  return !doorOpen(bot, pos)
}

export interface RetreatIndoorsOptions {
  signal?: AbortSignal
  /** the threats now (the ones to wait out) */
  threats: () => Entity[]
  /** wait till none of them is within this distance (default 24) */
  clearDistance?: number
  /** ...for this many ticks running (default 100) */
  clearTicks?: number
  /** ticks to wait at most behind the door (default 2400) */
  maxTicks?: number
}

/**
 * In behind the door (the pathfinder opens it), shut it, and wait there (eating as needed, shutting it again if it's
 * opened) till the threats have gone off for a while, or maxTicks. A pillager outside a raid can't open a door
 * (Raider's OpenDoorGoal is a raid's) and a closed door is a wall to its line of sight (ClipContext.Block.COLLIDER): a
 * 26.3 bot back from a death bare fought a pillager patrol with its fists in the open, and died twice (full-26.3-m).
 */
export async function retreatIndoors (bot: Bot, refuge: DoorRefuge, opts: RetreatIndoorsOptions): Promise<{ ticks: number, shut: boolean }> {
  const signal = opts.signal
  const clearDistance = opts.clearDistance ?? 24
  const clearTicks = opts.clearTicks ?? 100
  const maxTicks = opts.maxTicks ?? 2400
  const { inside, door } = refuge
  await navigate(bot, { goal: new goals.GoalBlock(inside.x, inside.y, inside.z), maxTicks: 600 }, signal)
  if (!bot.entity.position.floored().equals(inside)) throw new SkillError('NO_PATH', `not in behind the door at ${door.toString()}`)
  bot.clearControlStates()
  let shut = await shutDoor(bot, door, signal)
  trace('retreatIndoors: behind the door at', door.toString(), shut ? 'shut' : 'NOT SHUT')
  let clear = 0
  let ticks = 0
  for (; ticks < maxTicks && clear < clearTicks; ticks++) {
    throwIfAborted(signal)
    const near = opts.threats().filter(e => isAlive(bot, e) && e.position.distanceTo(bot.entity.position) <= clearDistance)
    clear = near.length === 0 ? clear + 1 : 0
    if (doorOpen(bot, door)) shut = await shutDoor(bot, door, signal)
    if (bot.health < 20 && bot.food < 18 && bestFoodInInventory(bot) != null) {
      await eat(bot, { signal }).catch(err => { if (isAbort(err)) throw err })
    }
    await waitTicks(bot, 1, signal)
  }
  return { ticks, shut }
}
