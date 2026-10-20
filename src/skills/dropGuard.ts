// No drop on a path the bot's health can't take: the pathfinder's maxDropDown held to what it can fall and live
// (LivingEntity.calculateFallDamage: the fall past the safe 3 blocks, rounded up, a jump's rise of 1.25 counted in),
// put back as the health comes back. A 26.3 bot starving at 1 health (normal difficulty stops starving there) walked an
// explore leg off a 4-block drop and "hit the ground too hard" (full-26.3-fresh-d).
import type { Bot } from 'mineflayer'

/** the pathfinder's own drop at full health (its default, a fall that does no harm) */
export const SAFE_DROP = 3
/** a jump's rise over the step it leaves, counted into a drop's fall (a parkour or a jump down) */
export const JUMP_RISE = 1.25

/** the most a path may drop at `health`: the fall's damage, ceil(drop + JUMP_RISE - 3), under the health */
export function dropForHealth (health: number, wanted = SAFE_DROP): number {
  let drop = wanted
  while (drop > 1 && Math.max(0, Math.ceil(drop + JUMP_RISE - SAFE_DROP)) >= health) drop--
  return drop
}

/**
 * Wraps the pathfinder's setMoveOptions so every set of move settings has its maxDropDown held to dropForHealth (the
 * drop asked for kept as survivalWantedDrop, so a setting put back keeps what was asked, not the cap), and sets them
 * again as the health changes
 */
export function capDropsByHealth (bot: Bot): void {
  const pf = bot.pathfinder as any
  if (pf?.setMoveOptions == null || pf.defaultMoveSettings == null || pf.survivalDropCap === true) return
  pf.survivalDropCap = true
  const set = pf.setMoveOptions.bind(pf)
  const apply = (settings: any): void => {
    const wanted = settings.survivalWantedDrop ?? settings.maxDropDown ?? SAFE_DROP
    set({ ...settings, survivalWantedDrop: wanted, maxDropDown: Math.min(wanted, dropForHealth(bot.health ?? 20, wanted)) })
  }
  pf.setMoveOptions = (settings: any) => apply(settings)
  let last = -1
  bot.on('health', () => {
    const cap = dropForHealth(bot.health ?? 20, pf.defaultMoveSettings?.survivalWantedDrop ?? SAFE_DROP)
    if (cap === last) return
    last = cap
    apply(pf.defaultMoveSettings)
  })
  apply(pf.defaultMoveSettings)
}
