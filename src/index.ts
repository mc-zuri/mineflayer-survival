import type { Bot } from 'mineflayer'
import { createPlugin as createPathfinder } from '@nxg-org/mineflayer-pathfinder'
import { TaskRunner } from './core/taskRunner'
import { WorldMemory, normalizeDimension } from './core/memory'
import { ReflexEngine, type ReflexEngineOptions } from './reflexes'
import { play, type MilestoneHandler, type PlayOptions, type PlayResult } from './runner'
import { keepHeadAboveWater, noSneakInWater, noteDrowning } from './skills/breath'
import { countRest } from './skills/shelter'
import { keepOffDripstone, keepOffLavaEdges, keepOffMagma, keepOutOfHazardsLeft } from './skills/hazardCells'
import { openSky } from './executor/explore'
import type { MilestoneId } from './planner/progression'
import { Diagnostics, type DiagnosticsOptions } from './diagnostics'
import { StockPolicy, type StockOptions } from './planner/stock'
import { advancementsDone, type AdvancementProgressPacket } from './core/advancements'
import { SCAFFOLD_ITEMS } from './executor/steps'
import { dropsDear, dropsWorthATrip, gearScore } from './executor/keep'
import { keepWayDown, wayDown } from './skills/wayDown'
import { installSculkAvoidance, watchDangers } from './skills/danger'
import { caveCells, keepOutOfCaves } from './skills/caves'
import { keepOutOfPortals } from './skills/tripKit'
import { watchArrivals } from './nether/portalTravel'
import { keepOffTridentZones } from './skills/tridentZone'
import { installGazeGuard } from './skills/gaze'
import { capDropsByHealth } from './skills/dropGuard'
import { guardEdges } from './skills/edgeGuard'
import { saveBetterPickaxes } from './skills/digTool'
import { rememberNetherDeath } from './nether/deaths'
import { keepNetherTrail, pruneTrail } from './nether/trail'

export * from './core'
export * from './planner'

export * as base from './base'
export * as reflexes from './reflexes'
export * as combat from './skills/combat'
export * as gather from './skills/gather'
export * as enchanting from './skills/enchanting'
export * as nether from './nether'
export * as end from './end'
export * as worldgen from './worldgen'
export * as diagnostics from './diagnostics'
export { Diagnostics } from './diagnostics'
export type { DiagnosticsOptions, StuckReport, ReportKind } from './diagnostics'
export * as executor from './executor'
export { Executor } from './executor/executor'
export type { ExecutorOptions, ObtainOutcome } from './executor/executor'
export { Runner, play, progressState, fileSaveStore, UNWIRED } from './runner'
export type { PlayOptions, PlayResult, MilestoneEvent, MilestoneHandler, MilestoneContext, SaveStore } from './runner'

export interface SurvivalOptions {
  /** load the pathfinder if the bot doesn't have it yet (default true) */
  loadPathfinder?: boolean
  /** the always-on reflexes (eat, fight or flee, creepers, lava and fire, drowning, armor, totem); false for none (default true) */
  reflexes?: boolean | ReflexEngineOptions
  /** the stuck reports (bot.survival.diagnostics): where they're written, how many kept */
  diagnostics?: DiagnosticsOptions
  /** the stock policy (planner/stock.ts): its marks, overrides and working set; false or enabled: false for none */
  stock?: StockOptions | false
}

export interface Survival {
  options: Required<SurvivalOptions>
  /** the foreground task queue; reflexes preempt the running task */
  tasks: TaskRunner
  /** what the bot has seen of the world */
  memory: WorldMemory
  /** the reflexes, handing their urgent tasks to `tasks` (null when turned off) */
  reflexes: ReflexEngine | null
  /**
   * Handlers for milestones play has none for (the nether, eyes and end ones until those skills are wired): play
   * stops at a milestone of UNWIRED without one.
   */
  handlers: Partial<Record<MilestoneId, MilestoneHandler>>
  /** advancements earned, by id without the namespace ('end/kill_dragon'), for the milestones that check one */
  advancements: Set<string>
  /** plays from where the bot is, milestone by milestone (see PlayOptions) */
  play: (options?: PlayOptions) => Promise<PlayResult>
  /** stuck reports: lastReports(), onReport(cb), dump() */
  diagnostics: Diagnostics
  /** what play keeps on hand beyond the milestones' needs (null when turned off) */
  stock: StockPolicy | null
}

/**
 * the pathfinder builds with the blocks the survival skills count and keep (SCAFFOLD_ITEMS, cheapest first): its
 * search's budget and its places; and no drop past maxDropDown into water however far down
 * (infiniteLiquidDropdownDistance off, the skills that want a drop into water ask for it): a 26.3 bot mining gold took
 * a ForwardDropDown of 12 blocks, then one of 42 toward a cave's water, and fell to its death on the way at y 29
 * (full-26.3-fresh-s); the other settings as they are
 */
function useScaffoldItems (bot: Bot): void {
  const pf = bot.pathfinder as any
  if (pf?.setMoveOptions == null || pf.defaultMoveSettings == null) return
  pf.setMoveOptions({ ...pf.defaultMoveSettings, scaffoldingBlocks: [...SCAFFOLD_ITEMS], infiniteLiquidDropdownDistance: false })
}

/** ticks before a death the last mob to hurt the bot is taken for its killer */
export const KILLER_TICKS = 200
/** ticks between the looks at what the bot carries, and the most a look is taken for the drops of a death after it */
export const DEATH_CARRIED_TICKS = 20

export function createPlugin (opts: SurvivalOptions = {}): (bot: Bot) => void {
  const options: Required<SurvivalOptions> = { loadPathfinder: true, reflexes: true, diagnostics: {}, stock: {}, ...opts }
  return function (bot: Bot): void {
    if (options.loadPathfinder && bot.pathfinder == null) bot.loadPlugin(createPathfinder())
    useScaffoldItems(bot)
    // no drop on a path the health can't take (a fall at 1 health)
    capDropsByHealth(bot)
    // no walk off a ledge deeper than that, whatever walks the bot (the pathfinder's edge guard, on for every tick)
    guardEdges(bot)
    // the stone dug with a stone pickaxe, the iron one saved for the ores that need it (as players dig their mines)
    saveBetterPickaxes(bot)
    // no walk or swim with the head under water and no air over it (a flooded cave): the bot drowns on the way
    keepHeadAboveWater(bot)
    // no step back into a cell the hazard reflex just took the bot out of (a magma block it was walked back onto)
    keepOutOfHazardsLeft(bot)
    // no walk or drop onto a stalagmite (impaled, PointedDripstoneBlock.fallOn)
    keepOffDripstone(bot)
    // no walk onto a magma block (MagmaBlock.stepOn) when there's a way round
    keepOffMagma(bot)
    // nor to a stand by lava (the overworld's: the nether's rules have their own) when there's another
    keepOffLavaEdges(bot)
    // the deep dark's sculk seen kept off (its sensors and shriekers: the warden) and looked for every 100 ticks
    installSculkAvoidance(bot)
    watchDangers(bot)
    // no way through the caves, nor a dig opening into one, for a bot not fit for them (caveReady): its own tunnels
    keepOutOfCaves(bot)
    // no path through a nether portal's cells by chance (skills/tripKit keepOutOfPortals; enterPortal steps in by hand)
    keepOutOfPortals(bot)
    // the portal each change of dimension came out by remembered (nether/portalTravel watchArrivals)
    watchArrivals(bot)
    // (and the work's paths round a trident drowned's zone: skills/tridentZone)
    keepOffTridentZones(bot)
    // no stare at a calm enderman by accident (EnderMan.isLookingAtMe)
    installGazeGuard(bot)
    // the ticks since the bot last slept (Stats.TIME_SINCE_REST): the night below the surface is slept only when due
    countRest(bot)
    const tasks = new TaskRunner(bot)
    const memory = new WorldMemory()
    const reflexes = options.reflexes === false ? null : new ReflexEngine(bot, { sink: tasks, ...(options.reflexes === true ? {} : options.reflexes) })
    const diagnostics = new Diagnostics(bot, options.diagnostics)
    const stock = options.stock === false || options.stock.enabled === false ? null : new StockPolicy(options.stock)
    bot.survival = { options, tasks, memory, reflexes, handlers: {}, advancements: new Set(), play: async (playOptions) => await play(bot, playOptions), diagnostics, stock }
    bot.on('physicsTick', () => { memory.now = memory.tickBase + tasks.tick })
    // no sneak held in the water (it swims the bot down), the pathfinder's dives' and every other's, but a dive meant
    noSneakInWater(bot)
    // where the bot walks the nether, to go that way again (travel by trailRoute)
    keepNetherTrail(bot, memory)
    // the way down a cave or a mine from the open sky (a death there gone back to by it)
    keepWayDown(bot)
    // the advancements as the server tells them: the End milestone's check is the dragon's minecraft:end/kill_dragon
    ;(bot as any)._client?.on?.('advancements', (packet: AdvancementProgressPacket) => {
      for (const id of advancementsDone(packet)) bot.survival.advancements.add(id)
    })
    // the last mob to hurt the bot, and when: the death's killer (the death spot's trip judged by it)
    let lastAttacker: { name: string, tick: number } | null = null
    // and each of the mobs that hurt it lately (the death's killers: one zombie or four)
    const attackers = new Map<number, number>()
    bot.on('entityHurt', (entity: any, source?: any) => {
      if (entity === bot.entity && source != null && source !== bot.entity && typeof source.name === 'string') {
        lastAttacker = { name: source.name, tick: tasks.tick }
        if (typeof source.id === 'number' && source.type !== 'player') attackers.set(source.id, tasks.tick)
      }
    })
    // what the bot carries, worn too (null with no inventory to look at)
    const carried = (): string[] | null => {
      const inventory: any = bot.inventory
      return typeof inventory?.items === 'function'
        ? [...inventory.items(), ...[5, 6, 7, 8, 45].map(s => inventory.slots?.[s])].filter(i => i != null).map(i => (i as any).name as string)
        : null
    }
    // ...as it was when the server said the bot was killed (ServerPlayer.die sends the combat kill before it drops
    // everything, and the emptied slots come before the health of 0: the menu's changes are broadcast ahead of the
    // health in ServerPlayer.doTick), and every DEATH_CARRIED_TICKS before: the death's drops (the death report's
    // killedState, the same)
    let carriedAt: { tick: number, names: string[] } | null = null
    ;(bot as any)._client?.on?.('death_combat_event', (p: any) => {
      const names = carried()
      if (p?.playerId === bot.entity?.id && names != null && names.length > 0) carriedAt = { tick: tasks.tick, names }
    })
    let lastCarried: string[] | null = null
    bot.on('physicsTick', () => {
      if (tasks.tick % DEATH_CARRIED_TICKS !== 0 || bot.health <= 0) return
      const names = carried()
      if (names != null && names.length > 0) lastCarried = names
    })
    bot.on('death', () => {
      // the running and queued tasks can't go on; the death spot is where the items are
      if (bot.entity != null) {
        // (in the overworld: the nether's roof is over everything)
        const dimension = normalizeDimension(bot.game?.dimension)
        const lookup = (p: any): any => bot.blockAt(p)
        // (what it dropped: unknown with no inventory to look at, and gone back for; the slots emptied already, what
        // it had a moment before)
        const now = carried()
        const recently = carriedAt != null && tasks.tick - carriedAt.tick <= DEATH_CARRIED_TICKS ? carriedAt.names : lastCarried
        const dropped = now != null && now.length === 0 && recently != null ? recently : now
        carriedAt = null
        lastCarried = null
        const killer = lastAttacker != null && tasks.tick - lastAttacker.tick <= KILLER_TICKS ? lastAttacker.name : undefined
        const killers = [...attackers.values()].filter(t => tasks.tick - t <= KILLER_TICKS).length
        attackers.clear()
        const pos = bot.entity.position
        const underground = dimension === 'overworld' ? !openSky(lookup, pos.floored()) : undefined
        const way = underground === true ? wayDown(bot) : null
        const cells = underground === true ? caveCells(bot) : null
        const cave = cells == null ? undefined : (cells.isCave(pos) || cells.isCave(pos.offset(0, 1, 0)) || (way ?? []).some(p => cells.isCave(p)))
        const inWater = typeof pos.offset === 'function' && [pos, pos.offset(0, 1, 0)].some(p => bot.blockAt(p)?.name === 'water')
        // drowned (in the water with no air left): the spot left for good a while (skills/breath), its drops not gone
        // back for under the water (deathSpotSkip)
        const drowned = inWater && Number(bot.oxygenLevel ?? 20) <= 1
        if (drowned && typeof pos.floored === 'function') noteDrowning(bot, pos, true)
        memory.setDeath(bot.entity.position, dimension, underground, dropped == null ? undefined : dropsWorthATrip(dropped, bot.registry as any), killer, {
          dear: dropped == null ? undefined : dropsDear(dropped),
          way,
          killers: killer != null ? Math.max(1, killers) : undefined,
          gear: dropped == null ? undefined : gearScore(dropped),
          inWater: inWater ? true : undefined,
          cave,
          drowned: drowned ? true : undefined
        })
        if (dimension === 'the_nether') {
          rememberNetherDeath(memory, bot.entity.position)
          pruneTrail(memory, bot.entity.position)
        }
      }
      tasks.cancelAll('DIED', 'the bot died')
    })
    bot.once('end', () => {
      reflexes?.stop()
      tasks.destroy()
    })
  }
}

declare module 'mineflayer' {
  interface Bot {
    survival: Survival
  }
}

export { enableLockstep, createLockstepBot } from './lockstep'
export type { Lockstep, LockstepOptions, LockstepMode } from './lockstep'
