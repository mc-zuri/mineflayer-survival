// The bag's keeper: room kept in the inventory as a long task goes, not only between the executor's steps. The
// executor holds the bag for every task it runs (holdBag), and the skills that go on for long make room at their safe
// points (keepRoom): before each block collectBlock breaks, each step of a staircase or a tunnel, each trip navigate
// sets out on, and before a pickup with no slot free. A player's pickups can't be refused (Player.aiStep touches the
// items its box meets, ItemEntity.playerTouch takes them), so the bag is kept from filling instead: obsidian made from
// the 26.3 deep lakes went into a bag the walks there had filled with their stone, and every block's pickup failed
// 'the inventory is full' while 177 cobblestone, 36 diorite, 32 andesite and 18 granite filled it.
import type { Bot } from 'mineflayer'
import type { Vec3 } from 'vec3'
import { emptySlots } from './util'
import { throwIfAborted } from './errors'

/** how near a hostile keeps the bag as it is (bagUnsafe: the hostiles reflex's range) */
export const BAG_HOSTILE_RANGE = 8

/**
 * Whether no room is made now: a hostile within BAG_HOSTILE_RANGE, alive, or the reflexes in combat (one in range, or a
 * hit lately). A throw turns the bot from the mob, a walk off takes it 8 blocks among them: a 26.3 bot fighting four
 * zombies in a cave at y -58 threw its cobbled deepslate away 5 times in 50 ticks between its fights, walking off
 * each time, and was slain (ls4-26.3, t386611)
 */
export function bagUnsafe (bot: Bot): boolean {
  const engine = (bot as any).survival?.reflexes
  try {
    if (engine?.enabled === true && engine.context?.().inCombat === true) return true
  } catch {}
  const pos = bot.entity?.position
  if (pos == null) return false
  return Object.values(bot.entities ?? {}).some((e: any) => {
    if (e === bot.entity || e?.position == null) return false
    if ((bot.registry?.entitiesByName as any)?.[e.name ?? '']?.type !== 'hostile') return false
    const health = e.metadata?.[9]
    if (typeof health === 'number' && health <= 0) return false
    return e.position.distanceTo(pos) <= BAG_HOSTILE_RANGE
  })
}

export interface BagKeeper {
  /** slots kept free: room is made when fewer are */
  minFree: number
  /**
   * Makes room, straight in the running task (with its signal); throws only when stopped. `toward`: where the bot goes
   * next, when the caller knows (what it throws is put behind it, off its way)
   */
  room: (signal: AbortSignal, toward?: Vec3) => Promise<void>
  /** a drop not gone for (the route's stone the stock has enough of, once the bag carries what's kept of it) */
  unwanted: (name: string) => boolean
}

interface Hold { keeper: BagKeeper, signal: AbortSignal }

/** the keepers holding each bot's bag, the innermost last */
const holds = new WeakMap<Bot, Hold[]>()
/** the bots making room now (keepRoom isn't entered again from the room's own digs and walks) */
const busy = new WeakSet<Bot>()

/**
 * The keeper holds the bot's bag while `signal` (its task's) is live, until the release: a preempted task's signal is
 * aborted, so a reflex that runs meanwhile makes no room with it
 */
export function holdBag (bot: Bot, keeper: BagKeeper, signal: AbortSignal): () => void {
  let list = holds.get(bot)
  if (list == null) holds.set(bot, list = [])
  const hold: Hold = { keeper, signal }
  list.push(hold)
  return () => {
    const i = list.lastIndexOf(hold)
    if (i >= 0) list.splice(i, 1)
  }
}

/** the keeper holding the bag now (the innermost whose task is live), or null */
export function bagKeeper (bot: Bot): BagKeeper | null {
  return liveHold(bot)?.keeper ?? null
}

function liveHold (bot: Bot): Hold | null {
  const list = holds.get(bot)
  if (list == null) return null
  for (let i = list.length - 1; i >= 0; i--) if (!list[i].signal.aborted) return list[i]
  return null
}

/** whether the bag is short of its keeper's free slots (false with no keeper, or while room is being made) */
export function bagShort (bot: Bot): boolean {
  const hold = liveHold(bot)
  return hold != null && !busy.has(bot) && emptySlots(bot) < hold.keeper.minFree
}

/**
 * Room made when the bag is short of its keeper's free slots, at a skill's safe point (where the bot may turn, throw,
 * dig a pit beside it, put a chest down, and the skill goes on from wherever it then stands), `toward` where the bot
 * goes next when the skill knows (a trip's goal, the block to break). Resolves whether the keeper was asked; throws
 * only the abort of `signal` or of the keeper's task.
 */
export async function keepRoom (bot: Bot, signal?: AbortSignal, toward?: Vec3): Promise<boolean> {
  throwIfAborted(signal)
  const hold = liveHold(bot)
  if (hold == null || busy.has(bot) || emptySlots(bot) >= hold.keeper.minFree) return false
  // (none with hostiles about: bagUnsafe)
  if (bagUnsafe(bot)) return false
  busy.add(bot)
  try {
    await hold.keeper.room(hold.signal, toward)
  } finally {
    busy.delete(bot)
  }
  throwIfAborted(signal)
  return true
}

/** a drop the keeper says no to (none without a keeper) */
export function unwantedDrop (bot: Bot, name: string): boolean {
  const keeper = bagKeeper(bot)
  return keeper != null && keeper.unwanted(name)
}
