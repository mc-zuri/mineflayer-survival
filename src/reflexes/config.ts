/** Every threshold the reflexes go by. */
export interface ReflexConfig {
  combat: {
    /** how far to look for hostiles (default 16) */
    scanRange: number
    /** a hostile this close means combat (default 8) */
    range: number
    /** ticks after a hit that still count as combat (default 60) */
    hurtTicks: number
  }
  eat: {
    enabled: boolean
    /** eat at or below this food level when not in combat (default 14) */
    food: number
    /** eat at or below this health even in combat, if no hostile is within reach (default 10) */
    health: number
    /** the reflex's priority (default 50) */
    priority: number
  }
  hostiles: {
    enabled: boolean
    /** fight or flee hostiles this close (default 8) */
    range: number
    /** and the ones that shoot from further (skeletons, pillagers, witches) this close, in sight (default 16) */
    rangedRange: number
    /** most height difference that counts (default 4) */
    maxDy: number
    /** flee instead at or below this health (default 6) */
    fleeHealth: number
    /** flee instead from more than this many hostiles in range (default 3) */
    maxFight: number
    /** flee until none is this close (default 16) */
    fleeDistance: number
    /** flee when there's no weapon (default false) */
    fleeUnarmed: boolean
    /** shoot creepers further than this when there's a bow and arrows (default 5) */
    shootCreepersFrom: number
    /** mobs never fought (neutral until provoked, or bosses with their own plans) */
    ignore: string[]
    /** ticks a fight may last (default 600) */
    fightTicks: number
    priority: number
  }
  creeper: {
    enabled: boolean
    /** evade a creeper this close, swelling or not (default 3: Creeper's SwellGoal starts under 3 blocks) */
    triggerDistance: number
    /** run until this far (default 7.5: SwellGoal stops past 7 blocks, and the blast's reach) */
    safeDistance: number
    /** block with the shield when the fuse is this far along and the creeper still this close (default 24, 5) */
    blockAtSwell: number
    blockDistance: number
    /** ticks to give up evading after (default 200) */
    maxTicks: number
    priority: number
  }
  hazard: {
    enabled: boolean
    /** how far to look for safe ground out of lava or fire (default 6) */
    searchRadius: number
    /** run to water within this distance when burning (default 6; 0 off) */
    waterRadius: number
    maxTicks: number
    priority: number
  }
  drowning: {
    enabled: boolean
    /** surface at or below this much air (bot.oxygenLevel, 0 - 20; default 6) */
    air: number
    /** stay up until the air is back to this (default 18) */
    recoverTo: number
    /** how far to look for air (default 8) */
    searchRadius: number
    maxTicks: number
    priority: number
  }
  armor: {
    enabled: boolean
    priority: number
  }
  fireball: {
    enabled: boolean
    /** hit back a ghast's fireball coming at the bot within this distance (default 12) */
    range: number
    priority: number
  }
  night: {
    enabled: boolean
    /** sleep in a bed from the inventory or one nearby (default true) */
    sleep: boolean
    /** dig in for the night without the gear to fight (default true) */
    shelter: boolean
    /** the gear to stay out and fight with: armor points worn or carried, and a weapon's hit (default 10 and 6) */
    minArmor: number
    minDamage: number
    /** how far to look for a bed standing (default 16) and for a column to dig the shelter in (default 8) */
    bedDistance: number
    shelterRadius: number
    /** below the eat (50) and hostiles reflexes: it waits for a fight or a meal to end (default 40) */
    priority: number
  }
  totem: {
    enabled: boolean
    /** keep a totem in the off hand whatever the health (default true); else only at or below `health` */
    always: boolean
    health: number
    priority: number
  }
  /** ticks before a reflex whose task failed may fire again (default 20) */
  retryCooldownTicks: number
}

export const DEFAULT_REFLEX_CONFIG: ReflexConfig = {
  combat: { scanRange: 16, range: 8, hurtTicks: 60 },
  eat: { enabled: true, food: 14, health: 10, priority: 50 },
  hostiles: {
    enabled: true,
    range: 8,
    rangedRange: 16,
    maxDy: 4,
    fleeHealth: 6,
    maxFight: 3,
    fleeDistance: 16,
    fleeUnarmed: false,
    shootCreepersFrom: 5,
    ignore: ['enderman', 'zombified_piglin', 'piglin', 'piglin_brute', 'ender_dragon', 'wither', 'warden', 'shulker', 'ghast', 'happy_ghast'],
    fightTicks: 600,
    priority: 60
  },
  creeper: { enabled: true, triggerDistance: 3, safeDistance: 7.5, blockAtSwell: 24, blockDistance: 5, maxTicks: 200, priority: 80 },
  hazard: { enabled: true, searchRadius: 6, waterRadius: 6, maxTicks: 200, priority: 90 },
  drowning: { enabled: true, air: 6, recoverTo: 18, searchRadius: 8, maxTicks: 300, priority: 85 },
  armor: { enabled: true, priority: 20 },
  fireball: { enabled: true, range: 12, priority: 92 },
  night: { enabled: true, sleep: true, shelter: true, minArmor: 10, minDamage: 6, bedDistance: 16, shelterRadius: 8, priority: 40 },
  totem: { enabled: true, always: true, health: 10, priority: 95 },
  retryCooldownTicks: 20
}

export type ReflexConfigInput = { [K in keyof ReflexConfig]?: ReflexConfig[K] extends object ? Partial<ReflexConfig[K]> : ReflexConfig[K] }

/** The defaults with the given sections' fields laid over them. */
export function reflexConfig (input: ReflexConfigInput = {}): ReflexConfig {
  const out: any = {}
  for (const key of Object.keys(DEFAULT_REFLEX_CONFIG) as Array<keyof ReflexConfig>) {
    const def = DEFAULT_REFLEX_CONFIG[key]
    const given = (input as any)[key]
    out[key] = typeof def === 'object' && !Array.isArray(def) ? { ...def, ...(given ?? {}) } : (given ?? def)
  }
  return out
}
