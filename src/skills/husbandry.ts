// Animals kept for what they give: let out of spawn eggs (SpawnEggItem.useOn: the mob on the block's face), and bred
// with their food (Animal.mobInteract: a food item fed to an adult not in love sets it in love, and two in love within
// 8 blocks of each other make a baby, BreedGoal; each parent waits 6000 ticks before the next, Animal.setAge), so the
// leather of the enchanting's books comes from cows the bot keeps by its base rather than the ones it can find.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { SkillError, isAbort, throwIfAborted } from './errors'
import { navigateNear } from './navigate'
import { countItems, findInventoryItem, trace, waitTicks, waitUntil } from './util'
import { type Entity, isAlive, metadataValue } from './combatUtil'

/** what each kept animal is bred with (Animal.isFood: the items tags of 1.21.11 and 26.3) */
export const BREEDING_FOOD: Readonly<Record<string, readonly string[]>> = {
  cow: ['wheat'],
  mooshroom: ['wheat'],
  sheep: ['wheat'],
  pig: ['carrot', 'potato', 'beetroot'],
  chicken: ['wheat_seeds', 'melon_seeds', 'pumpkin_seeds', 'beetroot_seeds', 'torchflower_seeds', 'pitcher_pod'],
  rabbit: ['carrot', 'golden_carrot', 'dandelion']
}

/** Animal.setAge(6000) after a baby: the ticks before a parent breeds again */
export const BREED_COOLDOWN_TICKS = 6000
/** BreedGoal: a partner in love within 8 blocks */
export const PARTNER_RANGE = 8

/** the ticks each animal was last fed, by entity id (per bot) */
const fedAt = new WeakMap<Bot, Map<number, number>>()
function fedTicks (bot: Bot): Map<number, number> {
  let m = fedAt.get(bot)
  if (m == null) { m = new Map(); fedAt.set(bot, m) }
  return m
}

/** whether an animal is an adult (AgeableMob's DATA_BABY_ID false) */
export function isAdult (bot: Bot, e: Entity): boolean {
  return metadataValue(bot, e, 'baby') !== true
}

/**
 * The animals to feed: adults of the kind not fed within the cooldown, in pairs that stand within PARTNER_RANGE of
 * each other, nearest the bot first; at most `pairs` pairs
 */
export function breedingPairs (animals: ReadonlyArray<{ id: number, position: Vec3, adult: boolean }>, fed: ReadonlyMap<number, number>, now: number, from: Vec3, pairs: number): Array<[number, number]> {
  const ready = animals
    .filter(a => a.adult && now - (fed.get(a.id) ?? -Infinity) >= BREED_COOLDOWN_TICKS)
    .sort((a, b) => a.position.distanceTo(from) - b.position.distanceTo(from))
  const used = new Set<number>()
  const out: Array<[number, number]> = []
  for (const a of ready) {
    if (out.length >= pairs) break
    if (used.has(a.id)) continue
    const b = ready.find(o => o.id !== a.id && !used.has(o.id) && o.position.distanceTo(a.position) <= PARTNER_RANGE)
    if (b == null) continue
    used.add(a.id)
    used.add(b.id)
    out.push([a.id, b.id])
  }
  return out
}

export interface BreedArgs {
  /** the kind (default cow) */
  mob?: string
  /** pairs to set in love (default 4) */
  pairs?: number
  /** how far from the bot to look for them (default 24) */
  radius?: number
}

/**
 * Feeds pairs of adults their food (BREEDING_FOOD) so each pair makes a baby: walks up to each, the food held, and
 * uses it on the animal (Animal.mobInteract), checked by the food used up. Resolves the animals fed; throws
 * MISSING_ITEMS without the food, NOT_FOUND without a pair to feed.
 */
export async function breedAnimals (bot: Bot, args: BreedArgs = {}, signal?: AbortSignal): Promise<{ fed: number, pairs: number }> {
  throwIfAborted(signal)
  const mob = args.mob ?? 'cow'
  const foods = BREEDING_FOOD[mob] ?? []
  const food = foods.find(f => countItems(bot, f) > 0)
  if (food == null) throw new SkillError('MISSING_ITEMS', `no ${foods.join(' or ')} to breed ${mob}s with`)
  const radius = args.radius ?? 24
  const now = (bot as any).survival?.tasks?.tick ?? 0
  const fed = fedTicks(bot)
  const animals = Object.values(bot.entities)
    .filter(e => e.name === mob && isAlive(bot, e) && e.position.distanceTo(bot.entity.position) <= radius)
  const pairs = breedingPairs(animals.map(e => ({ id: e.id, position: e.position, adult: isAdult(bot, e) })), fed, now, bot.entity.position, Math.min(args.pairs ?? 4, Math.floor(countItems(bot, food) / 2)))
  if (pairs.length === 0) throw new SkillError('NOT_FOUND', `no two adult ${mob}s ready to breed within ${radius} blocks`)
  let count = 0
  for (const pair of pairs) {
    for (const id of pair) {
      throwIfAborted(signal)
      const animal = bot.entities[id]
      if (animal == null || !isAlive(bot, animal)) continue
      if (animal.position.distanceTo(bot.entity.position) > 3) {
        try {
          await navigateNear(bot, animal.position, 2, signal)
        } catch (err) {
          if (isAbort(err)) throw err
          trace('breedAnimals: no way to the', mob, id, (err as Error).message)
          continue
        }
      }
      const item = findInventoryItem(bot, food)
      if (item == null) throw new SkillError('MISSING_ITEMS', `out of ${food}`)
      if (bot.heldItem?.name !== food) await bot.equip(item, 'hand')
      const before = countItems(bot, food)
      await bot.lookAt(animal.position.offset(0, (animal.height ?? 1.4) * 0.6, 0), true)
      await bot.activateEntity(animal as any)
      if (await waitUntil(bot, () => countItems(bot, food) < before, 10, signal)) {
        fed.set(id, now)
        count++
      } else {
        trace('breedAnimals: the', mob, id, 'took no', food)
      }
    }
  }
  // the pairs find each other and the babies come (BreedGoal: 60 ticks together)
  await waitTicks(bot, 80, signal)
  trace('breedAnimals: fed', count, mob + 's,', pairs.length, 'pairs')
  return { fed: count, pairs: pairs.length }
}

export interface ReleaseArgs {
  /** the spawn egg (default cow_spawn_egg) */
  egg?: string
  /** how many to let out (default all) */
  count?: number
}

/**
 * Lets animals out of spawn eggs on the ground by the bot (SpawnEggItem.useOn: the mob on the face used), checked by
 * the eggs used. Resolves how many came out.
 */
export async function releaseAnimals (bot: Bot, args: ReleaseArgs = {}, signal?: AbortSignal): Promise<number> {
  const egg = args.egg ?? 'cow_spawn_egg'
  const total = Math.min(countItems(bot, egg), args.count ?? Infinity)
  let released = 0
  const feet = bot.entity.position.floored()
  const spots = [[2, 0], [-2, 0], [0, 2], [0, -2], [2, 2], [-2, -2], [2, -2], [-2, 2]]
  for (let i = 0; i < total; i++) {
    throwIfAborted(signal)
    const [dx, dz] = spots[i % spots.length]
    const ground = bot.blockAt(feet.offset(dx, -1, dz))
    if (ground == null || ground.boundingBox !== 'block') continue
    const item = findInventoryItem(bot, egg)
    if (item == null) break
    if (bot.heldItem?.name !== egg) await bot.equip(item, 'hand')
    const before = countItems(bot, egg)
    await bot.lookAt(ground.position.offset(0.5, 1, 0.5), true)
    await bot.activateBlock(ground as any, new Vec3(0, 1, 0), new Vec3(0.5, 1, 0.5))
    if (await waitUntil(bot, () => countItems(bot, egg) < before, 10, signal)) released++
  }
  trace('releaseAnimals:', released, 'from', egg)
  return released
}
