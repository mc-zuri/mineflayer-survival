// Death reports: how the bot died and what came of it. The server's death message (its system chat line about the
// bot: DeathMessageType's), the last 200 ticks of health and food, the hits taken (the damage_event's type and the
// entity that caused it), the reflexes that fired, where (position, dimension), the inventory and equipment it had
// (what dropped), and then the recovery: whether it went back to the death spot and what it picked up there, and the
// kit taken from the base.
import type { BotState } from './survival'

type XYZ = [number, number, number]

/** a system message about the player that isn't an advancement or a join: a death message (DeathMessageType's) */
export function isDeathMessage (message: string): boolean {
  return !/ has (made|completed|reached) the (advancement|challenge|goal)| joined the game| left the game/.test(message)
}

/** the ticks of health, hits and reflexes a death report goes back over */
export const DEATH_TICKS = 200

export interface HealthSample { tick: number, health: number, food: number }

export interface EntityFacts { id: number, name: string, type: string, pos: XYZ | null, distance: number | null }

export interface DamageSample {
  tick: number
  /** the damage type's id in the server's registry (damage_event's sourceTypeId) */
  type: number | null
  /** the entity that caused it (a skeleton for its arrow), and the one that hit (the arrow) */
  cause: EntityFacts | null
  direct: EntityFacts | null
  /** the health after the hit, when it came first */
  health: number | null
}

export interface ReflexSample { tick: number, name: string, failed?: string }

export interface Recovery {
  started: number
  /** went: back to the death spot; skipped: why not; failed: the error */
  deathSpot: string | null
  /** what the trip back picked up */
  picked: Record<string, number> | null
  /** what the kit took from the base's chests ('no base' when there's none) */
  kit: Record<string, number> | 'no base' | null
  done: number | null
}

export interface DeathFacts {
  /** the server's death message ("diagbot was slain by Zombie"), null when none came */
  message: string | null
  pos: XYZ | null
  dimension: string | null
  health: HealthSample[]
  damage: DamageSample[]
  /** the entities that hurt the bot in those ticks, by name, with the count of hits */
  attackers: Record<string, number>
  reflexes: ReflexSample[]
  /** the mobs and players within 16 blocks */
  near: EntityFacts[]
  /** the bot as it was when it died: what it held is what dropped (unless keepInventory) */
  had: BotState | null
  dropped: Array<{ name: string, count: number }>
  recovery: Recovery | null
}

const fmt = (p: XYZ | null): string => p == null ? '?' : `(${p.map(n => Math.floor(n)).join(', ')})`

/** the recovery in words: "back to the death spot (picked up 12 cobblestone, ...)", "kit: 1 iron_pickaxe, ..." */
export function describeRecovery (r: Recovery | null): string {
  if (r == null) return 'no recovery yet'
  const parts: string[] = []
  const items = (m: Record<string, number>): string => {
    const list = Object.entries(m).filter(([, n]) => n > 0)
    return list.length === 0 ? 'nothing' : list.slice(0, 6).map(([name, n]) => `${n} ${name}`).join(', ') + (list.length > 6 ? ', ...' : '')
  }
  if (r.deathSpot === 'went') parts.push(`back to the death spot (picked up ${items(r.picked ?? {})})`)
  else if (r.deathSpot != null) parts.push(`death spot ${r.deathSpot}`)
  if (r.kit === 'no base') parts.push('no base for a kit')
  else if (r.kit != null) parts.push(`kit: ${items(r.kit)}`)
  if (r.done == null) parts.push('under way')
  return parts.length > 0 ? parts.join(', ') : 'nothing to recover'
}

/** "died: diagbot was slain by Zombie at (12, -60, 3) in overworld; hits: zombie x3; recovery: ..." */
export function diagnoseDeath (d: DeathFacts): string {
  const hits = Object.entries(d.attackers).map(([name, n]) => `${name} x${n}`).join(', ')
  const untyped = d.damage.filter(h => h.cause == null).length
  const parts = [`died: ${d.message ?? 'no death message'} at ${fmt(d.pos)} in ${d.dimension ?? '?'}`]
  if (hits !== '' || untyped > 0) parts.push(`hits: ${[hits, untyped > 0 ? `${untyped} with no attacker` : ''].filter(s => s !== '').join(', ')}`)
  if (d.reflexes.length > 0) parts.push(`reflexes: ${[...new Set(d.reflexes.map(r => r.name))].join(', ')}`)
  parts.push(`recovery: ${describeRecovery(d.recovery)}`)
  return parts.join('; ')
}
