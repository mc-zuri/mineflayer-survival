// The enderman fight from under a two-high ceiling, the players' way: an enderman is 2.9 high (EntityType.ENDERMAN)
// and fits under no ceiling lower than three, and its reach is its box widened sideways only
// (Mob.getAttackBoundingBox: DEFAULT_ATTACK_REACH, sqrt(2.04) - 0.6, and nothing up or down), so a bot two cells
// into a two-high tunnel can't be hit by one stood at its mouth, while the bot's own reach (3, from its eyes to the
// box) gets it there. A hit from a player doesn't send it off (EnderMan.hurtServer teleports for a hurt with no living
// attacker only), and it doesn't come down the tunnel after the bot: it stands in the pit at the mouth till it dies.
//
// The cover is dug into flat ground: a stair down from the surface (each step a block lower, open to the sky), the
// pit at its foot (the endermen's: open three high), then the tunnel on, two cells long and two high, its ceiling a
// block no enderman takes (EndermanTakeBlockGoal: BlockTags.ENDERMAN_HOLDABLE, the warped nylium on top among them),
// walls of solid blocks round the bot's cell. The bot stares an enderman angry from the stair's top step (its eyes over
// the ground), walks down to its cell, and fights the one that comes into the pit from there, never stepping out.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { SkillError, isAbort, throwIfAborted } from '../skills/errors'
import { navigate, walkTo } from '../skills/navigate'
import { goals } from '@nxg-org/mineflayer-pathfinder'
import { countItems, trace, waitTicks, waitUntil, type Block } from '../skills/util'
import { type Entity, distanceToBox, entityBox, eyePosition, isAlive } from '../skills/combatUtil'
import { attackStrengthOf, bestMeleeWeapon } from '../skills/weapons'
import { nearbyDrops, pickupDrops } from '../skills/pickupDrops'
import { fight } from '../skills/fight'
import { shoot } from '../skills/shoot'
import { dig } from '../core/actions'
import type { BlockLookup, BlockView } from '../skills/placement'
import { STARE_TELEPORT, eyesInSight, isAngryEnderman, provokeEnderman } from './pearls'

/** BlockTags.ENDERMAN_HOLDABLE (26.3 and 1.21.11): what an enderman takes out of the world (EndermanTakeBlockGoal) */
export const ENDERMAN_HOLDABLE = /^(dirt|coarse_dirt|rooted_dirt|podzol|mycelium|grass_block|moss_block|pale_moss_block|mud|muddy_mangrove_roots|sand|red_sand|gravel|brown_mushroom|red_mushroom|tnt|cactus|cactus_flower|clay|pumpkin|carved_pumpkin|melon|crimson_fungus|crimson_nylium|crimson_roots|warped_fungus|warped_nylium|warped_roots|dandelion|poppy|blue_orchid|allium|azure_bluet|.*_tulip|oxeye_daisy|cornflower|lily_of_the_valley|wither_rose|torchflower|open_eyeblossom|closed_eyeblossom)$/
/** blocks that fall with nothing under them (FallingBlock): never a ceiling */
const FALLING = /^(sand|red_sand|gravel|suspicious_sand|suspicious_gravel|.*_concrete_powder|anvil|chipped_anvil|damaged_anvil|dragon_egg|pointed_dripstone|scaffolding)$/
const FLUIDS = /^(water|lava|bubble_column)$/
/** what the dig won't go through: the world's floor and what the bot can't break */
const UNBREAKABLE = /^(bedrock|barrier|end_portal_frame|end_portal|nether_portal|reinforced_deepslate|command_block|spawner|chest|trapped_chest|ender_chest|.*shulker_box)$/

const solid = (b: BlockView | null): boolean => b != null && b.boundingBox === 'block'
/** what the bot climbs, and doesn't fall through (LivingEntity.onClimbable: BlockTags.CLIMBABLE) */
const CLIMBABLE = /^(ladder|vine|scaffolding|weeping_vines|weeping_vines_plant|twisting_vines|twisting_vines_plant|cave_vines|cave_vines_plant)$/
const open = (b: BlockView | null): boolean => b != null && b.boundingBox === 'empty' && !FLUIDS.test(b.name) && !CLIMBABLE.test(b.name) && !/fire|cactus|berry|powder_snow|wither_rose/.test(b.name)
const fluid = (b: BlockView | null): boolean => b != null && FLUIDS.test(b.name)

export interface EndermanCover {
  /** the surface cell the stair goes down from */
  top: Vec3
  /** the stair's steps, the top one first, each a block under the one before */
  steps: Vec3[]
  /** the pit at the stair's foot, open three high: the endermen's */
  pit: Vec3
  /** the tunnel's cell by the pit, two high */
  front: Vec3
  /** the bot's cell, two cells from the pit, two high */
  stand: Vec3
  /** the way from the top to the stand */
  facing: Vec3
  /** the cells to dig out, in order */
  dig: Vec3[]
}

export interface CoverOptions {
  /** how far round `from` the stair's top is looked for (default 12) */
  radius?: number
  /** how far up and down (default 5) */
  dy?: number
  /** how deep the bot's cell goes under the stair's top at most (default 5; 0 is a tunnel into a hillside from the top) */
  maxDepth?: number
  /** stair tops not to take (a cover from which no enderman was seen) */
  exclude?: (top: Vec3) => boolean
}

/** the horizontal ways, a cell long */
const WAYS = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]

/**
 * The cover with its stair's top at `top`, going `facing`, the bot's cell `depth` under the surface (the top's feet
 * level), or null when the ground there won't hold one: the cells to dig open or breakable and dry, the floors solid,
 * the tunnel's ceiling a solid block that doesn't fall and no enderman takes, and the bot's cell walled round (its
 * eight neighbours at its feet and head solid, but the front: no cell an enderman can stand in within its reach).
 */
export function coverAt (lookup: BlockLookup, top: Vec3, facing: Vec3, depth: number, reasons?: Map<string, number>): EndermanCover | null {
  const no = (why: string): null => { reasons?.set(why, (reasons.get(why) ?? 0) + 1); return null }
  const g = top.y
  const at = (i: number, y: number): Vec3 => new Vec3(top.x + facing.x * i, y, top.z + facing.z * i)
  // the top: a cell to stand in on the ground, no drop beside it (the lookout's fights knock the bot about: one off
  // the top into a hollow 10 under it, 26.3)
  if (!open(lookup(at(0, g))) || !open(lookup(at(0, g + 1))) || !solid(lookup(at(0, g - 1)))) return no('top')
  if (!firmAround(lookup, at(0, g), [at(1, g)])) return no('ledge')
  const steps: Vec3[] = []
  for (let i = 1; i < depth; i++) steps.push(at(i, g - i))
  const pit = at(depth, g - depth)
  const front = at(depth + 1, g - depth)
  const stand = at(depth + 2, g - depth)
  const dig: Vec3[] = []
  const toOpen = (p: Vec3): boolean => {
    const b = lookup(p)
    if (b == null || fluid(b) || UNBREAKABLE.test(b.name)) return false
    if (!open(b)) {
      // a block left in (a fungus, a fire) that isn't a full one or air: not dug through; a vine's broken (the bot
      // climbs one, and stood on the twisting vines in a stair's cell over its floor, 26.3)
      if (!solid(b) && !CLIMBABLE.test(b.name) && b.boundingBox !== 'empty') return false
      dig.push(p)
    }
    return true
  }
  // the stair's columns and the pit open from their floor to the surface (an enderman, 2.9 high, comes down it a
  // step at a time), and the walk over them open above the ground
  const columns = [...steps, pit]
  for (let i = 0; i < columns.length; i++) {
    const c = columns[i]
    if (!solid(lookup(c.offset(0, -1, 0)))) return no('step floor')
    for (let y = c.y; y < g; y++) if (!toOpen(new Vec3(c.x, y, c.z))) return no('step dig')
    // (over the ground too: a rise in the forest's floor, a stem, cut through)
    for (let y = g; y <= g + 2; y++) if (!toOpen(new Vec3(c.x, y, c.z))) return no('step over ground')
  }
  // the tunnel: two cells two high, a solid floor and a ceiling that stays
  for (const c of [front, stand]) {
    if (!solid(lookup(c.offset(0, -1, 0)))) return no('tunnel floor')
    const ceiling = lookup(c.offset(0, 2, 0))
    if (!solid(ceiling) || FALLING.test(ceiling?.name ?? '') || ENDERMAN_HOLDABLE.test(ceiling?.name ?? '')) return no('ceiling')
    if (!toOpen(c) || !toOpen(c.offset(0, 1, 0))) return no('tunnel dig')
  }
  // the bot's cell walled round at its feet and head (the front aside): an enderman stood in any of them would reach it
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (dx === 0 && dz === 0) continue
      const p = stand.offset(dx, 0, dz)
      if (p.equals(front)) continue
      if (!solid(lookup(p)) || !solid(lookup(p.offset(0, 1, 0)))) return no('walls')
    }
  }
  // no fluid beside a cell dug (it would come in)
  for (const p of dig) {
    for (const w of [...WAYS, new Vec3(0, 1, 0), new Vec3(0, -1, 0)]) if (fluid(lookup(p.plus(w)))) return no('fluid')
  }
  return { top, steps, pit, front, stand, facing, dig }
}

/**
 * No drop of more than 2 beside a cell the bot stands in (at `feet`): each of its 8 neighbours but `except` a wall
 * (solid at the feet) or with ground within 2 under them
 */
export function firmAround (lookup: BlockLookup, feet: Vec3, except: Vec3[] = []): boolean {
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (dx === 0 && dz === 0) continue
      const n = feet.offset(dx, 0, dz)
      if (except.some(e => e.x === n.x && e.z === n.z)) continue
      if (solid(lookup(n)) || [1, 2, 3].some(d => solid(lookup(n.offset(0, -d, 0))))) continue
      return false
    }
  }
  return true
}

/** the cover nearest `from` (the fewest blocks to dig, the shallowest, the nearest), or null */
export function planEndermanCover (lookup: BlockLookup, from: Vec3, opts: CoverOptions = {}, reasons?: Map<string, number>): EndermanCover | null {
  return planEndermanCovers(lookup, from, opts, reasons, 1)[0] ?? null
}

/** the `n` cheapest covers about `from` (planEndermanCover's), no two from the same top, cheapest first */
export function planEndermanCovers (lookup: BlockLookup, from: Vec3, opts: CoverOptions = {}, reasons?: Map<string, number>, n = 12): EndermanCover[] {
  const radius = opts.radius ?? 12
  const dy = opts.dy ?? 5
  const maxDepth = opts.maxDepth ?? 5
  const base = from.floored()
  const found: Array<{ cover: EndermanCover, cost: number }> = []
  for (let x = -radius; x <= radius; x++) {
    for (let z = -radius; z <= radius; z++) {
      const flat = Math.hypot(x, z)
      if (flat > radius) continue
      // (down further than up: a bot on a huge fungus's cap has the forest's floor 10 under it)
      for (let y = -dy - 8; y <= dy; y++) {
        const top = base.offset(x, y, z)
        if (!open(lookup(top)) || !solid(lookup(top.offset(0, -1, 0)))) continue
        if (opts.exclude?.(top) === true) continue
        let best: { cover: EndermanCover, cost: number } | null = null
        for (const facing of WAYS) {
          // (from 0: the tunnel dug into a hillside, its mouth on the ground, the stair none)
          for (let depth = 0; depth <= maxDepth; depth++) {
            const cover = coverAt(lookup, top, facing, depth, reasons)
            if (cover == null) continue
            const cost = cover.dig.length + depth * 2 + flat + Math.abs(y) * 2
            if (best == null || cost < best.cost) best = { cover, cost }
            break
          }
        }
        if (best != null) found.push(best)
      }
    }
  }
  return found.sort((a, b) => a.cost - b.cost).slice(0, n).map(f => f.cover)
}

/** the clear sight lines from a stand's eyes (feet at `feet`): 16 ways round, level and a little up, each up to 32 */
export function coverView (feet: Vec3, raycast: Raycast): number {
  const eye = feet.offset(0.5, 1.62, 0.5)
  let sum = 0
  for (let i = 0; i < 16; i++) {
    const a = i * Math.PI / 8
    for (const up of [0, 0.15]) {
      const dir = new Vec3(Math.cos(a), up, Math.sin(a)).normalize()
      const hit: any = raycast(eye, dir, 32)
      sum += hit?.intersect != null ? Math.min(32, (hit.intersect as Vec3).distanceTo(eye)) : hit != null && hit.position != null ? Math.min(32, (hit.position as Vec3).offset(0.5, 0.5, 0.5).distanceTo(eye)) : 32
    }
  }
  return sum / 32
}

/**
 * What's wrong with the cover as it stands, or null when it's as dug: its cells open, the ceiling and the walls there
 * (an enderman took none, a creeper blew none)
 */
export function coverBreach (lookup: BlockLookup, cover: EndermanCover): string | null {
  const name = (p: Vec3): string => `${lookup(p)?.name ?? 'nothing'} at ${p.toString()}`
  for (const c of [cover.front, cover.stand]) {
    for (const p of [c, c.offset(0, 1, 0)]) if (!open(lookup(p))) return `${name(p)} in the tunnel`
    if (!solid(lookup(c.offset(0, 2, 0)))) return `${name(c.offset(0, 2, 0))} for the ceiling`
    if (!solid(lookup(c.offset(0, -1, 0)))) return `${name(c.offset(0, -1, 0))} for the floor`
  }
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const p = cover.stand.offset(dx, 0, dz)
      if ((dx === 0 && dz === 0) || p.equals(cover.front)) continue
      for (const w of [p, p.offset(0, 1, 0)]) if (!solid(lookup(w))) return `${name(w)} for a wall`
    }
  }
  return null
}

export function coverIntact (lookup: BlockLookup, cover: EndermanCover): boolean {
  return coverBreach(lookup, cover) == null
}

const centre = (p: Vec3): Vec3 => p.offset(0.5, 0, 0.5)

/** ticks with no enderman in sight from the cover's top before a spot near it is looked from */
export const SCAN_AFTER = 200
/** how far from the cover's top the spot to look from may be */
export const SCAN_RADIUS = 8

type Raycast = (from: Vec3, dir: Vec3, range: number) => unknown

/**
 * A cell to stand on within SCAN_RADIUS of the cover's top (the ground open, off the cover's line) whose eyes see an
 * enderman's (one of `endermen`, by its feet) from over STARE_TELEPORT off, the nearest to the top; null if none
 */
export function scanSpot (lookup: BlockLookup, cover: EndermanCover, endermen: Vec3[], raycast: Raycast, skip?: ReadonlySet<string>): Vec3 | null {
  if (endermen.length === 0) return null
  const line = new Set([cover.top, ...cover.steps, cover.pit, cover.front, cover.stand].map(c => `${c.x},${c.z}`))
  let best: { at: Vec3, d: number } | null = null
  for (let dx = -SCAN_RADIUS; dx <= SCAN_RADIUS; dx++) {
    for (let dz = -SCAN_RADIUS; dz <= SCAN_RADIUS; dz++) {
      const d = Math.hypot(dx, dz)
      if (d > SCAN_RADIUS || (best != null && d >= best.d)) continue
      for (let dy = -2; dy <= 2; dy++) {
        const at = cover.top.offset(dx, dy, dz)
        if (line.has(`${at.x},${at.z}`) || skip?.has(at.toString()) === true) continue
        if (!open(lookup(at)) || !open(lookup(at.offset(0, 1, 0))) || !solid(lookup(at.offset(0, -1, 0))) || !firmAround(lookup, at)) continue
        const eye = at.offset(0.5, 1.62, 0.5)
        const sees = endermen.some(e => {
          const to = e.offset(0, 2.55, 0).minus(eye)
          const len = to.norm()
          return len > STARE_TELEPORT && len <= 64 && raycast(eye, to.scaled(1 / len), len) == null
        })
        if (sees) { best = { at, d }; break }
      }
    }
  }
  return best?.at ?? null
}

/** the bot's feet in the cell */
function inCell (bot: Bot, cell: Vec3): boolean {
  const p = bot.entity.position
  return Math.floor(p.x) === cell.x && Math.floor(p.z) === cell.z && Math.abs(p.y - cell.y) < 0.6
}

/**
 * the cell along the cover's line the bot is over (0 the top, then the steps, the pit, the front, the stand), a
 * step's drop or climb under way or not, or -1
 */
function lineIndex (bot: Bot, cover: EndermanCover): number {
  const p = bot.entity.position
  const line = [cover.top, ...cover.steps, cover.pit, cover.front, cover.stand]
  return line.findIndex(c => Math.floor(p.x) === c.x && Math.floor(p.z) === c.z && p.y > c.y - 0.6 && p.y < c.y + 1.6)
}

/** the bot over the cover's line, a step's drop or climb under way or not */
function onCoverLine (bot: Bot, cover: EndermanCover): boolean {
  return lineIndex(bot, cover) >= 0
}

/** landed: on the ground three ticks in a row (a walk off a step's edge falls a tick or two after the walk ends) */
async function settle (bot: Bot, signal?: AbortSignal): Promise<void> {
  let ground = 0
  await waitUntil(bot, () => { ground = bot.entity.onGround ? ground + 1 : 0; return ground >= 3 }, 30, signal)
}

/** walks along the cover's line to its cell `to` (an index of the line), cell by cell */
async function walkLine (bot: Bot, cover: EndermanCover, to: number, signal?: AbortSignal, until?: () => boolean): Promise<boolean> {
  const line = [cover.top, ...cover.steps, cover.pit, cover.front, cover.stand]
  let from = lineIndex(bot, cover)
  if (from < 0) {
    // off the line: to its top first
    await navigate(bot, { goal: new goals.GoalBlock(cover.top.x, cover.top.y, cover.top.z) }, signal)
    from = 0
  }
  const way = Math.sign(to - from)
  for (let i = from + way; way !== 0 && (way > 0 ? i <= to : i >= to); i += way) {
    if (until?.() === true) return false
    await stepTo(bot, line[i], signal, until)
  }
  return inCell(bot, line[to])
}

/**
 * A step along the cover's line to the next cell: walked, and landed (a step down); the pathfinder's way when the walk
 * didn't get there (pushed off it by an enderman, caught on a corner)
 */
async function stepTo (bot: Bot, cell: Vec3, signal?: AbortSignal, until?: () => boolean): Promise<void> {
  await walkTo(bot, centre(cell), { within: 0.2, maxTicks: 30, until }, signal)
  await settle(bot, signal)
  if (inCell(bot, cell) || until?.() === true) return
  await navigate(bot, { goal: new goals.GoalBlock(cell.x, cell.y, cell.z) }, signal).catch(err => { if (isAbort(err)) throw err })
  await settle(bot, signal)
}

const toolFor = async (bot: Bot, block: Block): Promise<void> => {
  let best: any = null
  let bestTime = bot.digTime(block)
  for (const item of bot.inventory.items()) {
    if (!/_(shovel|pickaxe|axe)$/.test(item.name)) continue
    const t = (block as any).digTime(item.type, false, false, false, [], [])
    if (t < bestTime) { best = item; bestTime = t }
  }
  if (best != null && bot.heldItem?.type !== best.type) await bot.equip(best, 'hand')
}

/** the eyes within reach of a block's box from the bot's feet at `feet` (Player.isWithinBlockInteractionRange) */
function reachable (feet: Vec3, pos: Vec3, reach = 4.5): boolean {
  const eye = feet.offset(0.5, 1.62, 0.5)
  const dx = Math.max(pos.x - eye.x, 0, eye.x - (pos.x + 1))
  const dy = Math.max(pos.y - eye.y, 0, eye.y - (pos.y + 1))
  const dz = Math.max(pos.z - eye.z, 0, eye.z - (pos.z + 1))
  return dx * dx + dy * dy + dz * dz < reach * reach
}

/**
 * Digs the cover out: from the stair's top, then each step down, the cells in reach from there (never one of the
 * cells kept: the crosshair's way through to a cell isn't dug through the ceiling or the walls), then into the stand.
 */
export async function digCover (bot: Bot, cover: EndermanCover, signal?: AbortSignal): Promise<void> {
  const lookup: BlockLookup = (p) => bot.blockAt(p) as BlockView | null
  const toDig = new Set(cover.dig.map(p => p.toString()))
  const line = [cover.top, ...cover.steps, cover.pit]
  const keep = (b: Block): boolean => toDig.has(b.position.toString())
  for (let i = 0; i < line.length; i++) {
    throwIfAborted(signal)
    if (i === 0) {
      await walkLine(bot, cover, 0, signal)
      // (the pathfinder's goal taken as reached a cell short of it: the walk on into it)
      if (!inCell(bot, cover.top)) await stepTo(bot, cover.top, signal)
    }
    else await stepTo(bot, line[i], signal)
    if (!inCell(bot, line[i])) throw new SkillError('NO_PATH', `the cover's stair: not at ${line[i].toString()} (at ${bot.entity.position.floored().toString()})`)
    for (const p of cover.dig) {
      const b = bot.blockAt(p)
      if (b == null || open(b) || !reachable(line[i], p)) continue
      if (fluid(lookup(p))) throw new SkillError('VERIFY_FAILED', `fluid at ${p.toString()}`)
      await toolFor(bot, b)
      await dig(bot, b, { signal, digObstruction: keep })
      trace('digCover: dug', b.name, 'at', p.toString(), 'from', line[i].toString(), open(lookup(p)) ? '' : `(${bot.blockAt(p)?.name ?? '?'} still there)`)
    }
  }
  const left = cover.dig.filter(p => !open(lookup(p)))
  if (left.length > 0) throw new SkillError('VERIFY_FAILED', `the cover's ${left.length} cells not dug (${left[0].toString()})`)
  await walkTo(bot, centre(cover.front), { within: 0.2, maxTicks: 30 }, signal)
  await walkTo(bot, centre(cover.stand), { within: 0.2, maxTicks: 30 }, signal)
  const breach = coverBreach(lookup, cover)
  if (breach != null) throw new SkillError('VERIFY_FAILED', `the cover isn't as planned: ${breach}`)
}

export interface CoverFightOptions {
  /** pearls wanted (default 16) */
  pearls?: number
  /** ticks to give up after (default 6000) */
  maxTicks?: number
  /** ticks with no enderman in sight before it's given up (default 1500) */
  idleTicks?: number
  /** how far endermen are stared at from the lookout (default 64) */
  range?: number
  /** endermen not to stare at again (no way to them, one that never came), kept between fights */
  passOver?: Set<number>
}

export interface CoverFightResult {
  pearls: number
  kills: number
  ticks: number
  /** why it ended: the pearls got, out of ticks, no enderman about for idleTicks */
  reason: 'pearls' | 'ticks' | 'idle' | 'blind'
}

/** the bot's reach for a swing (Player.entityInteractionRange 3, less a margin) */
export const COVER_REACH = 2.9
/** ticks an angry enderman is waited for at the stand before it's passed over (it stands off, out of reach) */
export const COVER_WAIT = 300
/** an angry enderman this near the bot off the stand, passed over or not, sends it to the stand */
export const COVER_NEAR = 10
/** ticks the stand is kept after that */
export const COVER_HOLD = 100
/** ticks with no kill from the cover before another is dug */
export const COVER_DRY = 3000
/** ticks with none to stare at from the cover before another is dug */
export const BLIND_TICKS = 1500
/** walks into the pit for a drop at most */
export const FETCH_TRIES = 3
/** arrows at an angry enderman stuck where it can't come (a hollow under the cover), each sending it off */
export const SHOOS = 2
/** an enderman is stared at from this far rather than nearer, when one is in sight */
export const STARE_FAR = 12
/** an angry enderman this near the bot off its stand is fought where it is (it would hit the bot's back on the way) */
export const COVER_THREAT = 2.5

/**
 * The aim at an enderman from the stand: low on its body (a look at its eyes is what angers the others, and within 4
 * of one sends it off: EndermanLookForPlayerGoal), the first point the eyes see without a block between
 */
function legPoint (bot: Bot, e: Entity): Vec3 | null {
  const eye = eyePosition(bot)
  for (const f of [0.3, 0.15, 0.45, 0.6, 0.05]) {
    const p = e.position.offset(0, 2.9 * f, 0)
    const d = p.minus(eye)
    const len = d.norm()
    if (len < 1e-6) return p
    const hit: any = (bot.world as any).raycast?.(eye, d.scaled(1 / len), len)
    if (hit == null) return p
  }
  return null
}

/**
 * Pearls from endermen fought from the cover: at its lookout (the stair's top, on the ground) an enderman in sight
 * stared angry (provokeEnderman; one past STARE_FAR first, and none in a hollow under the cover that can't come up),
 * from a spot near the top one is seen from when none is from the top (scanSpot), then down to the stand, where each
 * one that comes into the pit is hit low as the sword charges, and its pearls fetched from the front cell once no
 * angry one is by the pit. One angry COVER_WAIT that never came is passed over. The hostiles reflex leaves the
 * endermen to it (it went after them over the forest's ledges: knocked off one, a 26.3 bot died, run n2-d).
 */
export async function fightFromCover (bot: Bot, cover: EndermanCover, opts: CoverFightOptions = {}, signal?: AbortSignal): Promise<CoverFightResult> {
  const wanted = opts.pearls ?? 16
  const maxTicks = opts.maxTicks ?? 6000
  const idleTicks = opts.idleTicks ?? 1500
  const range = opts.range ?? 64
  const passOver = opts.passOver ?? new Set<number>()
  const lookup: BlockLookup = (p) => bot.blockAt(p) as BlockView | null
  const start = countItems(bot, 'ender_pearl')
  // the stair's top: the eyes a block and a half over the ground (from the step under it, at the ground's height, the
  // forest's endermen were in sight none of the time, 26.3)
  const lookout = 0
  const standAt = cover.steps.length + 3
  let ticks = 0
  let kills = 0
  let lastSeen = 0
  // the tick each angry one was first seen angry: one that hasn't come in COVER_WAIT is passed over (its anger comes
  // and goes, and the walks down to the stand and back with it, 26.3: one 23 off, 40 times in 9000 ticks)
  const angrySince = new Map<number, number>()
  let lastInSight = 0
  // the last stare (or one to stare at seen)
  let lastStare = 0
  // the stand kept till then (one angry came near the bot off it)
  let holdUntil = -1
  // the stuck ones to send off with an arrow, and how many each has had
  const toShoo = new Set<number>()
  const shoos = new Map<number, number>()
  // the fetches of each drop by the pit
  const fetches = new Map<number, number>()
  const canShoot = (): boolean => countItems(bot, 'bow') > 0 && countItems(bot, ['arrow', 'spectral_arrow']) > 0
  // the spots looked from that showed none (a ray grazing a stem's edge), not gone to again for a while
  const badSpots = new Set<string>()
  let badSince = 0
  const comes = (e: Entity): boolean => e.position.y >= cover.top.y - 3 || e.position.distanceTo(bot.entity.position) > 16
  let lastTrace = -1000
  const onTick = (): void => { ticks++ }
  const dead = new Set<number>()
  let lastKill = 0
  const onDead = (e: Entity): void => { if (e.name === 'enderman' && !dead.has(e.id)) { dead.add(e.id); if (e.position.distanceTo(bot.entity.position) < 8) { kills++; lastKill = ticks } } }
  const onHurt = (e: Entity, source?: Entity): void => {
    if (e === bot.entity) trace('fightFromCover: hurt by', source?.name ?? '?', source?.position?.toString() ?? '', 'at', bot.entity.position.toString(), 'line cell', lineIndex(bot, cover))
  }
  bot.on('physicsTick', onTick)
  bot.on('entityDead', onDead)
  bot.on('entityHurt' as any, onHurt)
  const leave = (bot as any).survival?.reflexes?.leaveAlone?.(['enderman']) as (() => void) | undefined
  const strength = attackStrengthOf(bot)
  const result = (reason: CoverFightResult['reason']): CoverFightResult => ({ pearls: countItems(bot, 'ender_pearl') - start, kills, ticks, reason })
  const endermen = (): Entity[] => Object.values(bot.entities)
    .filter(e => e.name === 'enderman' && isAlive(bot, e) && !dead.has(e.id) && e.position.distanceTo(bot.entity.position) <= range)
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
  const angry = (): Entity[] => endermen().filter(e => isAngryEnderman(bot, e) && !passOver.has(e.id) && e.position.distanceTo(bot.entity.position) <= 32)
  // in reach and in sight: one on the ground over the stand is within 3 of the eyes, the ceiling between (a 26.3 bot
  // stood swinging at one through it, no swing going, 5800 ticks)
  const inReach = (e: Entity): boolean => distanceToBox(eyePosition(bot), entityBox({ position: e.position, width: 0.6, height: 2.9 })) <= COVER_REACH && legPoint(bot, e) != null
  try {
    while (countItems(bot, 'ender_pearl') - start < wanted) {
      throwIfAborted(signal)
      if (ticks > maxTicks) return result('ticks')
      if (bot.health <= 0) throw new SkillError('VERIFY_FAILED', 'the bot died in the cover')
      const breach = coverBreach(lookup, cover)
      if (breach != null) throw new SkillError('VERIFY_FAILED', `the cover was broken: ${breach}`)
      const all = endermen()
      if (all.length > 0) lastSeen = ticks
      else if (ticks - lastSeen > idleTicks) return result('idle')
      // stares and none come to the pit for COVER_DRY: a cover elsewhere (a 26.3 bot's covers low in seed 2's forest,
      // y 43, stared endermen angry for 18000 ticks and killed one, run p8)
      if (ticks - lastKill > COVER_DRY && !all.some(e => inReach(e))) return result('blind')
      for (const e of angry()) {
        if (!angrySince.has(e.id)) angrySince.set(e.id, ticks)
        // (one in a cave under the cover, come there by its teleport toward the bot, never gets out: let be sooner)
        const wait = e.position.y < cover.stand.y - 3 ? COVER_WAIT / 3 : COVER_WAIT
        if (ticks - (angrySince.get(e.id) as number) > wait && e.position.distanceTo(centre(cover.pit)) > 6) {
          angrySince.set(e.id, ticks)
          // stuck where it is: an arrow sends it off at random (EnderMan.hurtServer: a projectile, teleport), angry
          // still, and from over 16 off it teleports toward the bot (EndermanLookForPlayerGoal), SHOOS times
          // (one not in sight to shoot in a wait more: passed over, not waited for at the top for good, 26.3: 6000 ticks)
          if (!toShoo.has(e.id) && (shoos.get(e.id) ?? 0) < SHOOS && canShoot()) { toShoo.add(e.id); continue }
          passOver.add(e.id)
          toShoo.delete(e.id)
          trace('fightFromCover: passed over', e.id, 'at', e.position.toString(), e.position.distanceTo(bot.entity.position).toFixed(1), 'off (the bot at', bot.entity.position.floored().toString(), 'the pit', cover.pit.toString(), '), angry', COVER_WAIT, 'ticks and not come')
        }
      }
      const mad = angry()
      // one to send off with an arrow, in sight from where the bot stands (off the stand: the top's in view of more)
      const shoo = mad.find(e => toShoo.has(e.id) && e.position.distanceTo(bot.entity.position) > STARE_TELEPORT && eyesInSight(bot, e))
      if (shoo != null && !inCell(bot, cover.stand)) {
        toShoo.delete(shoo.id)
        shoos.set(shoo.id, (shoos.get(shoo.id) ?? 0) + 1)
        trace('fightFromCover: an arrow at', shoo.id, 'stuck at', shoo.position.floored().toString())
        await shoot(bot, shoo, { signal, maxShots: 1 }).catch(err => { if (isAbort(err)) throw err; trace('fightFromCover:', (err as Error).message) })
        continue
      }
      if (ticks - badSince > 2000) { badSpots.clear(); badSince = ticks }
      if (ticks - lastTrace >= 200) {
        lastTrace = ticks
        trace('fightFromCover: at', bot.entity.position.floored().toString(), 'tick', ticks, all.length, 'endermen,', all.filter(e => eyesInSight(bot, e)).length, 'in sight,', mad.length, 'angry; pearls', countItems(bot, 'ender_pearl') - start, 'kills', kills)
      }
      if (!inCell(bot, cover.stand)) {
        // on the cover's line, an angry one at its back: on down to the stand all the same (it follows into the pit:
        // fought on the stair's top, run after run took a dozen hits); off it (a spot looked from), fought there
        const onLine = onCoverLine(bot, cover)
        const threat = onLine ? undefined : mad.find(e => e.position.distanceTo(bot.entity.position) <= COVER_THREAT)
        if (threat != null) {
          const res = await fight(bot, threat, { signal, aimHeight: 0.3, maxTicks: 300, maxDistance: 8, maxDrop: 1, crits: false }).catch(err => { if (isAbort(err)) throw err; trace('fightFromCover:', (err as Error).message); return null })
          // its pearls where it died, unless another angry one is about
          if (res?.killed === true && !angry().some(e => e.position.distanceTo(bot.entity.position) <= 8)) {
            await pickupDrops(bot, { near: res.lastPosition, radius: 4, names: ['ender_pearl'], waitTicks: 15 }, signal).catch(err => { if (isAbort(err)) throw err })
          }
          continue
        }
        // one angry near the bot, passed over or not, at the cover's height: it comes at the bot off the stand (the
        // ones that never came to the pit hit a 26.3 bot 47 times at the top and the spots it looked from), so the
        // stand, and a while there
        const near = all.find(e => isAngryEnderman(bot, e) && e.position.distanceTo(bot.entity.position) <= COVER_NEAR && e.position.y >= cover.top.y - 3)
        if (near != null && !mad.some(e => !toShoo.has(e.id))) {
          trace('fightFromCover: to the stand,', near.id, 'angry at', near.position.distanceTo(bot.entity.position).toFixed(1))
          holdUntil = ticks + COVER_HOLD
          await walkLine(bot, cover, standAt, signal, onLine ? undefined : () => isAlive(bot, near) && near.position.distanceTo(bot.entity.position) <= COVER_THREAT)
          continue
        }
        if (mad.some(e => !toShoo.has(e.id))) {
          // to the stand: it comes
          trace('fightFromCover: to the stand for', mad.map(e => `${e.id} at ${e.position.distanceTo(bot.entity.position).toFixed(1)}`).join(', '))
          await walkLine(bot, cover, standAt, signal, onLine ? undefined : () => mad.some(e => isAlive(bot, e) && e.position.distanceTo(bot.entity.position) <= COVER_THREAT))
          continue
        }
        // at the lookout: the nearest one in sight stared at, from over STARE_TELEPORT off
        if (!inCell(bot, cover.top)) { await walkLine(bot, cover, lookout, signal); continue }
        // (the nearest past STARE_FAR, else the farthest: a near one, angry, runs at the bot faster than it walks down to the stand,
        // and hits it on the stair; one past 16 teleports toward it, and comes after)
        // (and none well under the cover within 16, which doesn't teleport and finds no way up out of its hollow: the
        // stares at those in a 26.3 run got 0 of 7 to the pit)
        const seen = all.filter(e => !isAngryEnderman(bot, e) && !passOver.has(e.id) && e.position.distanceTo(bot.entity.position) > STARE_TELEPORT && comes(e) && eyesInSight(bot, e))
        const calm = seen.find(e => e.position.distanceTo(bot.entity.position) >= STARE_FAR) ?? seen[seen.length - 1]
        if (calm != null) {
          lastInSight = ticks
          lastStare = ticks
          if (!await provokeEnderman(bot, calm, signal)) passOver.add(calm.id)
          continue
        }
        // (no spot off the line looked from with one angry about)
        if (ticks - lastInSight > SCAN_AFTER && !all.some(e => isAngryEnderman(bot, e) && e.position.distanceTo(bot.entity.position) <= 24 && e.position.y >= cover.top.y - 3)) {
          // none in sight from the top (the forest's fungi between): a spot near it one is seen from, the stare from
          // there, and back
          lastInSight = ticks
          const spot = scanSpot(lookup, cover, all.filter(e => !isAngryEnderman(bot, e) && !passOver.has(e.id) && comes(e)).map(e => e.position), (from, dir, len) => (bot.world as any).raycast?.(from, dir, len) ?? null, badSpots)
          if (spot != null) {
            badSpots.add(spot.toString())
            trace('fightFromCover: to', spot.toString(), 'for an enderman in sight')
            await navigate(bot, { goal: new goals.GoalBlock(spot.x, spot.y, spot.z) }, signal).catch(err => { if (isAbort(err)) throw err })
            const seen = endermen().find(e => !isAngryEnderman(bot, e) && !passOver.has(e.id) && e.position.distanceTo(bot.entity.position) > STARE_TELEPORT && comes(e) && eyesInSight(bot, e))
            if (seen != null) { badSpots.delete(spot.toString()); lastStare = ticks }
            if (seen != null && !await provokeEnderman(bot, seen, signal)) passOver.add(seen.id)
            if (seen == null || !isAngryEnderman(bot, seen)) await walkLine(bot, cover, lookout, signal)
            continue
          }
        }
        // none to stare at from here for BLIND_TICKS: a cover elsewhere (a 26.3 bot's cover in a hollow of the forest
        // had 20 endermen within 64 and none in sight for 42000 ticks)
        if (ticks - lastStare > BLIND_TICKS && mad.length === 0) return result('blind')
        await waitTicks(bot, 10, signal)
        continue
      }
      // at the stand
      const target = all.find(e => inReach(e))
      if (target != null) {
        angrySince.set(target.id, ticks)
        const sword = bestMeleeWeapon(bot, 'enderman')
        if (sword != null && bot.heldItem?.type !== sword.type) await bot.equip(sword, 'hand')
        await bot.lookAt(legPoint(bot, target) as Vec3, true)
        if (strength.scale(0.5) >= 1 && strength.attack(target)) trace('fightFromCover: hit', target.id, 'at', target.position.toString())
        await waitTicks(bot, 1, signal)
        continue
      }
      // the drops in and by the pit, fetched from the pit itself once no angry one is near it (from the front the
      // pickup's reach missed one on the pit's far side: 26.3, the walk there and back for 3000 ticks), each a few
      // times at most
      const drops = nearbyDrops(bot, centre(cover.pit).offset(0, 0.5, 0), 2.5, ['ender_pearl']).filter(d => (fetches.get(d.id) ?? 0) < FETCH_TRIES)
      if (drops.length > 0 && !mad.some(e => e.position.distanceTo(centre(cover.pit)) <= 6)) {
        trace('fightFromCover: the pearls by the pit fetched,', drops.length, 'of them')
        for (const d of drops) fetches.set(d.id, (fetches.get(d.id) ?? 0) + 1)
        const ids = new Set(drops.map(d => d.id))
        await walkTo(bot, centre(cover.front), { within: 0.25, maxTicks: 20 }, signal)
        await walkTo(bot, centre(cover.pit), { within: 0.25, maxTicks: 20, until: () => !drops.some(d => bot.entities[d.id] != null) }, signal)
        await waitUntil(bot, () => ![...ids].some(id => bot.entities[id] != null), 20, signal)
        await walkTo(bot, centre(cover.front), { within: 0.25, maxTicks: 20 }, signal)
        await walkTo(bot, centre(cover.stand), { within: 0.2, maxTicks: 20 }, signal)
        await settle(bot, signal)
        continue
      }
      // one in sight from the stand itself (a cover dug into a hillside looks out over the forest): stared at from
      // here, where it can't reach the bot
      const fromStand = all.find(e => !isAngryEnderman(bot, e) && !passOver.has(e.id) && e.position.distanceTo(bot.entity.position) > STARE_TELEPORT && comes(e) && eyesInSight(bot, e))
      if (fromStand != null) {
        lastStare = ticks
        if (!await provokeEnderman(bot, fromStand, signal)) passOver.add(fromStand.id)
        continue
      }
      if (mad.some(e => !toShoo.has(e.id)) || ticks < holdUntil) {
        await waitTicks(bot, 2, signal)
        continue
      }
      // none angry: up to the lookout for the next
      await walkLine(bot, cover, lookout, signal)
    }
    return result('pearls')
  } finally {
    leave?.()
    bot.off('physicsTick', onTick)
    bot.off('entityDead', onDead)
    bot.off('entityHurt' as any, onHurt)
  }
}

/** the cover each bot dug last, used again while it holds and the bot is near it */
const covers = new WeakMap<Bot, { cover: EndermanCover, dug: boolean }>()

/**
 * Pearls from the endermen about (the warped forest's, the overworld's at night) from a cover: the last one dug if it's
 * within 24 and holds, else one planned and dug nearby (planEndermanCover); NOT_FOUND when the ground about won't take
 * one
 */
export async function endermenFromCover (bot: Bot, opts: CoverFightOptions & CoverOptions = {}, signal?: AbortSignal): Promise<CoverFightResult> {
  const lookup: BlockLookup = (p) => bot.blockAt(p) as BlockView | null
  const kept = covers.get(bot)
  let cover: EndermanCover | null = null
  if (kept != null && kept.cover.stand.distanceTo(bot.entity.position) <= 24) {
    // the one dug, if it holds; one planned and dug in part (the task cut off by a reflex: an enderman's fight),
    // the rest of it, the ground there still taking it
    if (kept.dug) cover = coverBreach(lookup, kept.cover) == null ? kept.cover : null
    else cover = coverAt(lookup, kept.cover.top, kept.cover.facing, kept.cover.steps.length + 1)
  }
  const blind = blindTops.get(bot) ?? []
  blindTops.set(bot, blind)
  const total: CoverFightResult = { pearls: 0, kills: 0, ticks: 0, reason: 'ticks' }
  const maxTicks = opts.maxTicks ?? 6000
  for (let n = 0; ; n++) {
    if (cover == null || covers.get(bot)?.dug !== true) {
      if (cover == null) {
        const reasons = new Map<string, number>()
        // the cheap ones about, the one with the widest view of the forest of them (its endermen seen to be stared
        // at), none near a top no enderman was seen from
        const raycast: Raycast = (from, dir, len) => (bot.world as any).raycast?.(from, dir, len) ?? null
        const options = planEndermanCovers(lookup, bot.entity.position, { ...opts, exclude: top => blind.some(b => b.distanceTo(top) < BLIND_APART) || opts.exclude?.(top) === true }, reasons, COVER_CHOICES)
        cover = options.map((c, i) => ({ c, score: coverView(c.top, raycast) - i })).sort((a, b) => b.score - a.score)[0]?.c ?? null
        if (cover == null) trace('endermenFromCover: no cover about', bot.entity.position.floored().toString(), JSON.stringify([...reasons]))
        if (cover == null) throw new SkillError('NOT_FOUND', `no ground for an enderman cover within ${opts.radius ?? 12} blocks`)
      }
      covers.set(bot, { cover, dug: false })
      trace('endermenFromCover: a cover from', cover.top.toString(), 'facing', cover.facing.toString(), 'the stand', cover.stand.toString(), cover.dig.length, 'blocks to dig')
      // (one that couldn't be dug isn't planned again: the same stair's top failed ten times over, 26.3)
      const failed = cover
      await digCover(bot, cover, signal).catch(err => { if (!isAbort(err)) { forgetCover(bot); blind.push(failed.top) } throw err })
      covers.set(bot, { cover, dug: true })
    }
    // no way to it (a stair's top the pathfinder found no way back to, 2475 ticks): another cover the next time
    const res = await fightFromCover(bot, cover, { ...opts, pearls: (opts.pearls ?? 16) - total.pearls, maxTicks: maxTicks - total.ticks }, signal)
      .catch(err => { if (!isAbort(err) && /NO_PATH|broken/.test(String((err as Error).message ?? err))) forgetCover(bot); throw err })
    total.pearls += res.pearls
    total.kills += res.kills
    total.ticks += res.ticks
    total.reason = res.reason
    if (res.reason !== 'blind') return total
    // none seen to stare at: another cover, away from this one
    trace('endermenFromCover: none to stare at from', cover.top.toString(), 'for', BLIND_TICKS, 'ticks: another cover')
    blind.push(cover.top)
    forgetCover(bot)
    cover = null
    if (n + 1 >= COVER_MOVES || total.ticks >= maxTicks) return total
  }
}

/** the stair tops each bot saw no enderman from or failed to dig a cover from, and how far from them another goes */
const blindTops = new WeakMap<Bot, Vec3[]>()
export const BLIND_APART = 10
/** covers dug in a row for one with endermen in sight, at most */
export const COVER_MOVES = 3
/** the cheapest covers about the one with the widest view is chosen from */
export const COVER_CHOICES = 8

export function forgetCover (bot: Bot): void {
  covers.delete(bot)
}
