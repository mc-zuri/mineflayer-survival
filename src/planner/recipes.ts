import type { ItemCount } from '../core/inventory'
import { cachedPerRegistry, type RegistryLike } from '../core/registry'
import { itemTags, type ItemTags } from '../core/tags'

/** one input of a recipe: any of `items`, `count` of them per craft */
export interface Ingredient {
  items: string[]
  count: number
}

export interface CraftRecipe {
  result: string
  /** items made per craft */
  count: number
  ingredients: Ingredient[]
  /** needs the 3×3 grid of a crafting table */
  table: boolean
  /** items left in the grid after a craft (the buckets of a cake) */
  remainders: ItemCount[]
}

export type RawItem = number | null | [number | null, number?] | { id: number | null, count?: number }

export interface RawRecipe {
  result: RawItem
  inShape?: RawItem[][]
  outShape?: RawItem[][]
  ingredients?: RawItem[]
}

/**
 * vanilla tags that minecraft-data (or rawRecipes, for the planks) writes out as one recipe per member; recipes of the
 * same result that differ only by members of one of these merge into one with alternatives
 */
const MERGE_TAGS = ['planks', 'logs', 'bamboo_blocks', 'stone_crafting_materials', 'coals', 'wool', 'wooden_slabs', 'smelts_to_glass']

function rawId (item: RawItem): number | null {
  if (item == null) return null
  if (typeof item === 'number') return item
  if (Array.isArray(item)) return item[0] ?? null
  return item.id
}

function rawCount (item: RawItem): number {
  return item != null && typeof item === 'object' && !Array.isArray(item) ? item.count ?? 1 : 1
}

interface Normalized {
  result: string
  count: number
  table: boolean
  /** one entry per filled grid cell (shapeless: per ingredient), in grid order */
  cells: string[]
  remainders: ItemCount[]
  skeleton: string
}

function normalize (registry: RegistryLike, tags: ItemTags, raw: RawRecipe): Normalized | null {
  const resultId = rawId(raw.result)
  const result = resultId == null ? undefined : registry.items[resultId]?.name
  if (result == null) return null
  const name = (id: number | null): string | null => id == null ? null : registry.items[id]?.name ?? null
  let cells: string[]
  let layout: string
  let table: boolean
  if (raw.inShape != null) {
    const rows = raw.inShape
    const width = Math.max(...rows.map(r => r.length))
    table = rows.length > 2 || width > 2
    const grid = rows.map(r => r.map(c => name(rawId(c))))
    cells = grid.flat().filter((c): c is string => c != null)
    layout = JSON.stringify(grid.map(r => r.map(c => c == null ? null : groupKey(tags, c))))
  } else if (raw.ingredients != null) {
    const list = raw.ingredients.map(i => name(rawId(i)))
    if (list.some(i => i == null)) return null
    // sorted by group, so the cells of recipes that merge line up
    cells = (list as string[]).sort((a, b) => `${groupKey(tags, a)}|${a}`.localeCompare(`${groupKey(tags, b)}|${b}`))
    table = cells.length > 4
    layout = JSON.stringify(cells.map(c => groupKey(tags, c)).sort())
  } else {
    return null
  }
  if (cells.length === 0) return null
  const remainders: ItemCount[] = []
  for (const row of raw.outShape ?? []) {
    for (const c of row) {
      const n = name(rawId(c))
      if (n != null) remainders.push({ name: n, count: 1 })
    }
  }
  const count = rawCount(raw.result)
  return { result, count, table, cells, remainders, skeleton: `${count}|${String(table)}|${layout}` }
}

function groupKey (tags: ItemTags, item: string): string {
  for (const tag of MERGE_TAGS) if (tags.matches(`#${tag}`, item)) return `#${tag}`
  return item
}

/**
 * The wood tag a planks recipe's log is of (#oak_logs, #crimson_stems, #bamboo_blocks: vanilla's planksFromLogs and
 * planksFromLog take the tag, any of the wood's log, wood, stripped log and stripped wood), null for any other item
 */
function plankLogTag (tags: ItemTags, item: string): string | null {
  for (const tag of tags.tagsOf(item)) {
    if (tag === 'logs' || tag === 'logs_that_burn') continue
    if (tag.endsWith('_logs') || tag.endsWith('_stems') || tag === 'bamboo_blocks') return tag
  }
  return null
}

function withId (item: RawItem, id: number): RawItem {
  if (item == null || typeof item === 'number') return id
  if (Array.isArray(item)) return [id, ...item.slice(1)] as RawItem
  return { ...item, id }
}

/**
 * The crafting recipes of the registry as minecraft-data stores them (result item id → its recipes), with what it
 * leaves out: a planks recipe names the first member of its wood's log tag only (oak_planks from oak_log), where
 * vanilla's takes the whole tag (RecipeProvider.planksFromLogs: #oak_logs, oak_wood and the stripped ones too, 1.21.11
 * and 26.3), so each other member gets a recipe of its own. The planner (craftingRecipes) and the craft skill
 * (mineflayer-crafting-util's plans, bot.craft) both read this one table: a 1.21.11 bot with 32 oak_wood was planned
 * 'craft 8 oak_planks' by the planner, the skill found no recipe for it ('short of 8 oak_planks'), five times over.
 */
export const rawRecipes = cachedPerRegistry((registry): Map<number, RawRecipe[]> => {
  const tags = itemTags(registry)
  const out = new Map<number, RawRecipe[]>()
  for (const [key, list] of Object.entries(registry.recipes)) {
    if (!Array.isArray(list)) continue
    const id = Number(key)
    const recipes = [...list as RawRecipe[]]
    if (registry.items[id]?.name.endsWith('_planks') === true) {
      for (const raw of list as RawRecipe[]) {
        const log = raw.ingredients?.length === 1 ? rawId(raw.ingredients[0]) : null
        const tag = log == null ? null : plankLogTag(tags, registry.items[log]?.name ?? '')
        if (log == null || tag == null) continue
        for (const member of tags.members(`#${tag}`)) {
          const memberId = registry.itemsByName[member]?.id
          if (memberId == null || memberId === log) continue
          if (recipes.some(r => r.ingredients?.length === 1 && rawId(r.ingredients[0]) === memberId)) continue
          recipes.push({ ...raw, ingredients: [withId((raw.ingredients as RawItem[])[0], memberId)] })
        }
      }
    }
    out.set(id, recipes)
  }
  return out
})

function merge (group: Normalized[]): CraftRecipe {
  const first = group[0]
  // per cell: every item seen in that cell across the merged recipes
  const cellItems = first.cells.map((_, i) => [...new Set(group.map(r => r.cells[i]))])
  const byAlternatives = new Map<string, Ingredient>()
  for (const items of cellItems) {
    const key = [...items].sort().join(',')
    const ing = byAlternatives.get(key)
    if (ing != null) ing.count++
    else byAlternatives.set(key, { items, count: 1 })
  }
  return { result: first.result, count: first.count, table: first.table, ingredients: [...byAlternatives.values()], remainders: first.remainders }
}

/**
 * Every crafting recipe of the registry (rawRecipes: the planks of each member of their log tag), by result item name,
 * with minecraft-data's one-recipe-per-tag-member entries merged back into vanilla's tag ingredients.
 */
export const craftingRecipes = cachedPerRegistry((registry): Map<string, CraftRecipe[]> => {
  const tags = itemTags(registry)
  const out = new Map<string, CraftRecipe[]>()
  for (const list of rawRecipes(registry).values()) {
    const groups = new Map<string, Normalized[]>()
    for (const raw of list) {
      const n = normalize(registry, tags, raw)
      if (n == null) continue
      let g = groups.get(n.skeleton)
      if (g == null) groups.set(n.skeleton, g = [])
      g.push(n)
    }
    for (const g of groups.values()) {
      const recipe = merge(g)
      let forResult = out.get(recipe.result)
      if (forResult == null) out.set(recipe.result, forResult = [])
      forResult.push(recipe)
    }
  }
  return out
})

export function recipesFor (registry: RegistryLike, item: string): readonly CraftRecipe[] {
  return craftingRecipes(registry).get(item) ?? []
}
