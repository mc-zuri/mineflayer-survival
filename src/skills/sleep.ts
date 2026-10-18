// sleep: in a bed nearby, or one the bot places, through the night.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { SkillError, throwIfAborted } from './errors'
import { collectBlock } from './collectBlock'
import { navigate } from './navigate'
import { placeBlock } from './placeBlock'
import { findBedPlacement } from './placement'
import { findInventoryItem, waitUntil, type Block } from './util'
import { goals } from '@nxg-org/mineflayer-pathfinder'

export interface SleepArgs {
  /** the bed to use (default: the nearest within `bedDistance`, else one from the inventory) */
  bed?: Vec3
  bedDistance?: number
  /** look for a bed standing nearby at all (default true; false: the one from the inventory) */
  nearby?: boolean
  /** break the bed the bot placed and take it back after waking (default false) */
  pickUpBed?: boolean
  /** ticks to wait asleep for the morning (default 1000: the night skips once every player has slept 100 ticks) */
  maxTicks?: number
}

export interface SleepResult {
  bed: Vec3
  placedBed: boolean
  /** ticks asleep */
  ticks: number
}

const isBedName = (name: string): boolean => name.endsWith('_bed')

/**
 * A block state's property by name, from minecraft-data's states (the last one varies fastest; a bool's values are
 * true then false, as BooleanProperty's).
 */
export function stateProperty (bot: Pick<Bot, 'registry'>, stateId: number, name: string): string | undefined {
  const def: any = (bot.registry as any).blocksByStateId[stateId]
  if (def?.states == null) return undefined
  let offset = stateId - def.minStateId
  for (let i = def.states.length - 1; i >= 0; i--) {
    const state = def.states[i]
    const index = offset % state.num_values
    offset = Math.floor(offset / state.num_values)
    if (state.name === name) return state.type === 'bool' ? String(index === 0) : state.values?.[index] ?? String(index)
  }
  return undefined
}

/** BedBlock.OCCUPIED: someone (a villager) is in it */
export function bedOccupied (bot: Pick<Bot, 'registry'>, block: { stateId?: number }): boolean {
  return block.stateId != null && stateProperty(bot, block.stateId, 'occupied') === 'true'
}

/** whether a bed works now: at night (the time of day 12541 to 23458) or in a thunderstorm, as bot.sleep checks it */
export function canSleepNow (timeOfDay: number, thundering: boolean): boolean {
  return thundering || (timeOfDay >= 12541 && timeOfDay <= 23458)
}

async function getBed (bot: Bot, args: SleepArgs, signal?: AbortSignal): Promise<{ bed: Block, placed: boolean }> {
  if (args.bed != null) {
    const block = bot.blockAt(args.bed)
    if (block == null || !bot.isABed(block)) throw new SkillError('NOT_FOUND', `no bed at ${args.bed.toString()}`)
    return { bed: block, placed: false }
  }
  // a bed standing nearby, not one taken (a villager's: BedBlock.OCCUPIED, "This bed is occupied")
  const found = args.nearby === false
    ? null
    : bot.findBlock({ matching: (block: any) => isBedName(block.name) && !bedOccupied(bot, block), useExtraInfo: true, maxDistance: args.bedDistance ?? 32 })
  if (found != null) return { bed: found, placed: false }

  const item = findInventoryItem(bot, item => isBedName(item.name))
  if (item == null) throw new SkillError('NOT_FOUND', 'no bed nearby and none in the inventory')
  const placement = findBedPlacement(pos => bot.blockAt(pos), bot.entity.position)
  if (placement == null) throw new SkillError('CANNOT_PLACE', 'no room next to the bot for a bed')
  // BedItem places the foot where clicked and the head the way the player faces: look along the bed first
  await bot.lookAt(placement.head.offset(0.5, 0, 0.5), true)
  await placeBlock(bot, { pos: placement.foot, item: item.name, against: placement.foot.offset(0, -1, 0) }, signal)
  // BedItem places both halves: wait for the head too (bot.sleep needs the whole bed)
  const whole = (): boolean => {
    const foot = bot.blockAt(placement.foot)
    if (foot == null || !bot.isABed(foot)) return false
    const head = bot.blockAt(placement.foot.plus((bot as any).parseBedMetadata(foot).headOffset))
    return head != null && bot.isABed(head)
  }
  if (!(await waitUntil(bot, whole, 20, signal))) throw new SkillError('VERIFY_FAILED', `no whole bed at ${placement.foot.toString()} after placing it`)
  return { bed: bot.blockAt(placement.foot) as Block, placed: true }
}

export async function sleep (bot: Bot, args: SleepArgs = {}, signal?: AbortSignal): Promise<SleepResult> {
  throwIfAborted(signal)
  const thundering = bot.isRaining && ((bot as any).thunderState ?? 0) > 0
  if (!canSleepNow(bot.time.timeOfDay, thundering)) throw new SkillError('NOT_NIGHT', `it's day (time of day ${bot.time.timeOfDay})`)

  const { bed, placed } = await getBed(bot, args, signal)
  // BedBlock.use: the bed within reach (mineflayer's bot.sleep asks for 2 blocks around the head)
  await navigate(bot, { goal: new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 1), reached: () => bot.entity.position.distanceTo(bed.position.offset(0.5, 0, 0.5)) <= 2.5 }, signal)

  try {
    await bot.sleep(bed)
  } catch (err) {
    const message = (err as Error).message
    const code = /not night|thunderstorm/.test(message) ? 'NOT_NIGHT' : /too far|cant click/.test(message) ? 'NO_PATH' : 'REFUSED'
    throw new SkillError(code, `sleeping failed: ${message}`, { bed: bed.position, placedBed: placed, ticks: 0 }, { cause: err })
  }

  let ticks = 0
  const woke = await waitUntil(bot, () => { ticks++; return !bot.isSleeping }, args.maxTicks ?? 1000, signal)
  const result: SleepResult = { bed: bed.position, placedBed: placed, ticks }
  if (!woke) throw new SkillError('TIMEOUT', `still asleep after ${ticks} ticks`, result)
  if (placed && args.pickUpBed === true) await collectBlock(bot, { positions: [bed.position] }, signal)
  return result
}
