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

type RawItem = number | null | [number | null, number?] | { id: number | null, count?: number }

interface RawRecipe {
  result: RawItem
  inShape?: RawItem[][]
  outShape?: RawItem[][]
  ingredients?: RawItem[]
}

/**
 * vanilla tags that minecraft-data writes out as one recipe per member; recipes of the
 * same result that differ only by members of one of these merge into one with alternatives
 */
const MERGE_TAGS = ['planks', 'logs', 'stone_crafting_materials', 'coals', 'wool', 'wooden_slabs', 'smelts_to_glass']

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
 * planks are made from any member of their wood's log tag (#oak_logs, #crimson_stems,
 * #bamboo_blocks); minecraft-data only names the first member
 */
function widen (tags: ItemTags, result: string, item: string): string[] {
  if (!result.endsWith('_planks')) return [item]
  for (const tag of tags.tagsOf(item)) {
    if (tag.endsWith('_logs') || tag.endsWith('_stems') || tag === 'bamboo_blocks') {
      if (tag === 'logs' || tag === 'logs_that_burn') continue
      return [...tags.members(`#${tag}`)]
    }
  }
  return [item]
}

function merge (tags: ItemTags, group: Normalized[]): CraftRecipe {
  const first = group[0]
  // per cell: every item seen in that cell across the merged recipes
  const cellItems = first.cells.map((_, i) => {
    const seen = new Set<string>()
    for (const r of group) for (const it of widen(tags, r.result, r.cells[i])) seen.add(it)
    return [...seen]
  })
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
 * Every crafting recipe of the registry, by result item name, with minecraft-data's
 * one-recipe-per-tag-member entries merged back into vanilla's tag ingredients.
 */
export const craftingRecipes = cachedPerRegistry((registry): Map<string, CraftRecipe[]> => {
  const tags = itemTags(registry)
  const out = new Map<string, CraftRecipe[]>()
  for (const [, list] of Object.entries(registry.recipes)) {
    if (!Array.isArray(list)) continue
    const groups = new Map<string, Normalized[]>()
    for (const raw of list as RawRecipe[]) {
      const n = normalize(registry, tags, raw)
      if (n == null) continue
      let g = groups.get(n.skeleton)
      if (g == null) groups.set(n.skeleton, g = [])
      g.push(n)
    }
    for (const g of groups.values()) {
      const recipe = merge(tags, g)
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
