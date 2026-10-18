// What happened to the bot in a scenario of the night tests: its deaths (the server's death message), the damage it
// took by source, the hostiles it killed, the reflexes that fired and the ticks and wall time the run took.
import { performance } from 'node:perf_hooks'
import type { Bot } from 'mineflayer'

type Entity = Bot['entities'][string]

export interface RunLog {
  ticks: number
  wallMs: number
  deaths: string[]
  /** the hit points lost, by the entity behind each hit (its name) or 'other' (falls, fire, drowning, starving) */
  damage: Record<string, number>
  damageTotal: number
  /** hostiles that died within 6 blocks of the bot or after it hit them */
  kills: Record<string, number>
  reflexes: Record<string, number>
  reflexFailures: string[]
  minHealth: number
}

// the 1.21.11 damage_type registry in the order the server sends it (the vanilla data pack's, by key)
const DAMAGE_TYPES = ['arrow', 'bad_respawn_point', 'cactus', 'campfire', 'cramming', 'dragon_breath', 'drown', 'dry_out', 'ender_pearl',
  'explosion', 'fall', 'falling_anvil', 'falling_block', 'falling_stalactite', 'fireball', 'fireworks', 'fly_into_wall', 'freeze', 'generic',
  'generic_kill', 'hot_floor', 'in_fire', 'in_wall', 'indirect_magic', 'lava', 'lightning_bolt', 'mace_smash', 'magic', 'mob_attack',
  'mob_attack_no_aggro', 'mob_projectile', 'on_fire', 'out_of_world', 'outside_border', 'player_attack', 'player_explosion', 'sonic_boom',
  'spear', 'spit', 'stalagmite', 'starve', 'sting', 'sweet_berry_bush', 'thorns', 'thrown', 'trident', 'unattributed_fireball', 'wind_charge',
  'wither', 'wither_skull']

const isHostile = (bot: Bot, e: Entity | undefined): boolean => e != null && (bot.registry.entitiesByName as any)[e.name ?? '']?.type === 'hostile'

export class NightLog {
  private readonly start = performance.now()
  private readonly startTick: number
  private readonly attacked = new Set<number>()
  private lastHealth: number
  private lastSource: string = 'other'
  private lastSourceEntity: Entity | undefined
  private lastSourceTick = -100
  private tick = 0
  readonly log: RunLog = { ticks: 0, wallMs: 0, deaths: [], damage: {}, damageTotal: 0, kills: {}, reflexes: {}, reflexFailures: [], minHealth: 20 }
  private readonly detach: Array<() => void> = []

  constructor (private readonly bot: Bot, private readonly verbose = process.env.NIGHT_VERBOSE != null) {
    this.startTick = bot.lockstep?.ticks ?? 0
    this.lastHealth = bot.health
    const on = (emitter: any, event: string, fn: (...args: any[]) => void): void => {
      emitter.on(event, fn)
      this.detach.push(() => emitter.off(event, fn))
    }
    on(bot, 'physicsTick', () => { this.tick++ })
    // the damage_event packet (1.19.4+): the damage type's registry id, and the entity behind it (ids + 1, 0 for none)
    on(bot._client, 'damage_event', (packet: any) => {
      if (packet.entityId !== bot.entity?.id) return
      const source = bot.entities[packet.sourceCauseId - 1] ?? bot.entities[packet.sourceDirectId - 1]
      this.lastSourceEntity = source
      this.lastSource = source?.name ?? `${DAMAGE_TYPES[packet.sourceTypeId] ?? 'damage type ' + String(packet.sourceTypeId)}`
      this.lastSourceTick = this.tick
    })
    on(bot, 'health', () => {
      const lost = this.lastHealth - bot.health
      if (lost > 0) {
        // the hurt event and the health come in the same tick; a source more than a tick old was an earlier hit
        const source = this.tick - this.lastSourceTick <= 1 ? this.lastSource : 'other'
        this.log.damage[source] = (this.log.damage[source] ?? 0) + lost
        this.log.damageTotal += lost
        const by = this.lastSourceEntity != null && this.tick - this.lastSourceTick <= 1 ? ` ${this.lastSourceEntity.position.distanceTo(bot.entity.position).toFixed(1)} away` : ''
        this.note(`-${lost.toFixed(1)} hp (${source}${by}), health ${bot.health.toFixed(1)}, food ${bot.food}, at ${bot.entity.position.floored().toString()}`)
      }
      if (bot.health > 0) this.log.minHealth = Math.min(this.log.minHealth, bot.health)
      this.lastHealth = bot.health
    })
    on(bot, 'entityDead', (e: Entity) => {
      if (!isHostile(bot, e)) return
      if (!this.attacked.has(e.id) && e.position.distanceTo(bot.entity.position) > 6) return
      this.log.kills[e.name ?? '?'] = (this.log.kills[e.name ?? '?'] ?? 0) + 1
      this.note(`killed ${e.name ?? '?'}`)
    })
    on(bot, 'messagestr', (message: string) => {
      if (message.startsWith(`${bot.username} `) && !/joined the game|left the game|has made the advancement|has reached the goal|has completed the challenge/.test(message)) {
        this.log.deaths.push(message)
        this.note(`DEATH: ${message}`)
      }
    })
    on(bot, 'reflex', (name: string) => {
      this.log.reflexes[name] = (this.log.reflexes[name] ?? 0) + 1
      this.note(`reflex ${name}`)
    })
    on(bot, 'reflexFailed', (name: string, err: Error) => {
      if (/PREEMPTED/.test(String((err as any)?.code ?? err?.message))) { this.note(`reflex ${name} preempted: ${err?.message ?? ''}`); return }
      this.log.reflexFailures.push(`${name}: ${err?.message ?? String(err)}`)
      this.note(`reflex ${name} failed: ${err?.message ?? String(err)}`)
    })
    const attack = bot.attack.bind(bot)
    bot.attack = (target: Entity, ...rest: any[]) => {
      this.attacked.add(target.id)
      return (attack as any)(target, ...rest)
    }
    this.detach.push(() => { bot.attack = attack })
  }

  note (line: string): void {
    if (this.verbose) console.log(`[t${this.tick} time ${this.bot.time?.timeOfDay ?? '?'}] ${line}`)
  }

  finish (): RunLog {
    for (const d of this.detach.splice(0)) d()
    this.log.ticks = (this.bot.lockstep?.ticks ?? this.tick) - this.startTick
    this.log.wallMs = performance.now() - this.start
    return this.log
  }
}

export function summary (log: RunLog): string {
  const fmt = (r: Record<string, number>): string => Object.entries(r).map(([k, v]) => `${k} ${Number.isInteger(v) ? v : v.toFixed(1)}`).join(', ') || 'none'
  return `${log.deaths.length === 0 ? 'alive' : `DIED (${log.deaths.join('; ')})`}, ${log.ticks} ticks in ${(log.wallMs / 1000).toFixed(1)} s, ` +
    `damage ${log.damageTotal.toFixed(1)} (${fmt(log.damage)}), min health ${log.minHealth.toFixed(1)}, kills: ${fmt(log.kills)}, reflexes: ${fmt(log.reflexes)}` +
    (log.reflexFailures.length > 0 ? `, failures: ${log.reflexFailures.slice(0, 5).join(' | ')}` : '')
}
