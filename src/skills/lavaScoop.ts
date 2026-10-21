// lavaScoop: a lava source in the rock scooped from the bot's own tunnel. The source's top is opened from a stand
// beside the cell over it, never its side (lava flows sideways and down, never up), the bucket filled through that
// hole, and the hole closed again.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { goals } from '@nxg-org/mineflayer-pathfinder'
import { SkillError, isAbort, throwIfAborted } from './errors'
import { fillBucket } from './bucket'
import { tunnelTo } from './tunnel'
import { navigate } from './navigate'
import { placeBlock } from './placeBlock'
import { CARDINALS, countItems, settleInventory, trace, waitTicks } from './util'
import { dig } from '../core/actions'

type Lookup = (p: Vec3) => { name: string, boundingBox?: string } | null

const LIQUID = new Set(['lava', 'water', 'bubble_column'])
/** the blocks the hole over a scooped source is closed with */
export const SCOOP_FILLERS = ['cobblestone', 'cobbled_deepslate', 'stone', 'deepslate', 'dirt', 'netherrack']
/** the steps a tunnel to a scoop's stand takes at most */
export const SCOOP_TUNNEL_STEPS = 160

export interface ScoopStand {
  /** where the bot stands (its feet) */
  stand: Vec3
  /** the cell over the source, opened to look down at its top */
  opening: Vec3
}

/**
 * The stands a lava source is scooped from out of the rock: a cell beside the one over the source (`opening`) on a
 * solid floor (the block beside the source, no fluid), the stand, its head's cell and the opening with no fluid in or
 * against them but the source under the opening. From there the bot's look down through the opening reaches the
 * source's top, and with the opening dug the lava has nowhere to go (it doesn't flow up); a stand by the source's side
 * would open it to the tunnel. A source with lava over it has none. With `isCave` (a source by a cave, for a bot not fit
 * for the caves) the scoop is sealed in the rock: the opening, the stand and its head no cave's cells and none against
 * them, so the bot's dig never opens onto the cave (the cave rule's: the lava taken from the rock round it).
 */
export function scoopStands (get: Lookup, source: Vec3, isCave?: (p: Vec3) => boolean): ScoopStand[] {
  const name = (p: Vec3): string => get(p)?.name ?? 'unknown'
  const wet = (p: Vec3): boolean => LIQUID.has(name(p))
  const opening = source.offset(0, 1, 0)
  if (wet(opening)) return []
  // nothing wet against the opening but the source under it
  const around = (p: Vec3): Vec3[] => [p.offset(0, 1, 0), p.offset(0, -1, 0), ...CARDINALS.map(d => p.plus(d))]
  if (around(opening).some(p => !p.equals(source) && wet(p))) return []
  const caveBy = (p: Vec3): boolean => isCave != null && (isCave(p) || around(p).some(q => !q.equals(source) && isCave(q)))
  if (caveBy(opening)) return []
  const out: ScoopStand[] = []
  for (const d of CARDINALS) {
    const stand = opening.plus(d)
    const head = stand.offset(0, 1, 0)
    const floor = source.plus(d)
    if (get(floor)?.boundingBox !== 'block' || wet(floor)) continue
    if ([stand, head].some(p => wet(p) || around(p).some(q => wet(q)))) continue
    if (caveBy(stand) || caveBy(head)) continue
    out.push({ stand, opening })
  }
  return out
}

/**
 * Fills an empty bucket at a lava source no spot near sees (one in the rock, under a ledge): a tunnel dug to a stand
 * by it (scoopStands; tunnelTo's staircase, the cave rule's turns and sealed openings; the pathfinder's way for one
 * above the bot), the cell over the source opened, the bucket filled through it, and the cell closed again. A
 * 1.21.11 bot's casts at home went for sources at (-82, 46, 152) and (-111, 17, 174) in the rock, 'no spot found to
 * see' either from, and its portal frame went on to the pools far off and never got its obsidian (f3-1.21.11, t86275
 * to t268827).
 */
export async function scoopByTunnel (bot: Bot, source: Vec3, signal?: AbortSignal, isCave?: (p: Vec3) => boolean): Promise<void> {
  throwIfAborted(signal)
  if (countItems(bot, 'bucket') === 0) throw new SkillError('MISSING_ITEMS', 'no empty bucket in the inventory')
  const get: Lookup = p => bot.blockAt(p) as any
  const at = bot.entity.position
  const stands = scoopStands(get, source, isCave).sort((a, b) => a.stand.distanceTo(at) - b.stand.distanceTo(at))
  if (stands.length === 0) throw new SkillError('NO_PATH', `no stand to scoop the lava at ${source.toString()} from`)
  let lastErr: unknown = null
  for (const { stand, opening } of stands.slice(0, 2)) {
    try {
      const feet = bot.entity.position.floored()
      if (!feet.equals(stand)) {
        if (stand.y <= feet.y) await tunnelTo(bot, { target: stand, range: 0, maxSteps: SCOOP_TUNNEL_STEPS }, signal)
        else await navigate(bot, { goal: new goals.GoalBlock(stand.x, stand.y, stand.z) }, signal)
      }
      if (!bot.entity.position.floored().equals(stand)) throw new SkillError('NO_PATH', `not at the stand ${stand.toString()}`)
      // the scoop's own checks again, the world as it is now (a flow since)
      if (!scoopStands(get, source, isCave).some(s => s.stand.equals(stand))) throw new SkillError('NO_PATH', `the stand ${stand.toString()} is no longer safe`)
      const cover = bot.blockAt(opening)
      if (cover != null && cover.boundingBox === 'block') {
        bot.pathingUtil?.refresh?.()
        const tool = (bot as any).pathingUtil?.bestHarvestingTool?.(cover)
        if (tool != null && bot.heldItem?.slot !== tool.slot) { await settleInventory(bot, signal); await bot.equip(tool, 'hand') }
        await dig(bot, cover, { signal })
        await waitTicks(bot, 1, signal)
      }
      try {
        await fillBucket(bot, { fluid: 'lava', pos: source }, signal)
      } finally {
        await closeOpening(bot, opening, signal)
      }
      return
    } catch (err) {
      if (isAbort(err)) throw err
      trace('scoopByTunnel: the stand', stand.toString(), 'for', source.toString(), 'failed:', (err as Error).message)
      lastErr = err
    }
  }
  throw lastErr instanceof SkillError ? lastErr : new SkillError('NO_PATH', `no scoop of the lava at ${source.toString()}: ${(lastErr as Error)?.message ?? ''}`)
}

/** the hole over a scooped source closed (the lava that flows into its cell kept off the tunnel and the bot's feet) */
async function closeOpening (bot: Bot, opening: Vec3, signal?: AbortSignal): Promise<void> {
  if (bot.blockAt(opening)?.boundingBox === 'block') return
  const filler = SCOOP_FILLERS.find(f => countItems(bot, f) > 0)
  if (filler == null) return
  try {
    await placeBlock(bot, { pos: opening, item: filler }, signal)
  } catch (err) {
    if (isAbort(err)) throw err
    trace('scoopByTunnel: the opening', opening.toString(), 'not closed:', (err as Error).message)
  }
}
