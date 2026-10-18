import { burnTicks, foodsOf, NON_FLAMMABLE_WOOD, parseTool, WOOD_TYPES, type ToolKind } from './items'
import { cachedPerRegistry, type RegistryLike } from './registry'

/**
 * Item groups, written `#name` wherever an item name is accepted. Most mirror vanilla item
 * tags (minecraft-data has none), built from the registry's item names so that every
 * variant of the version is in: #logs, #logs_that_burn, #planks, #wooden_slabs, #coals,
 * #wool, #saplings, #leaves, #stone_crafting_materials, #stone_tool_materials, #pickaxes,
 * #axes, #shovels, #hoes, #swords, #<wood>_logs (#crimson_stems, #warped_stems,
 * #bamboo_blocks), #<metal>_ores, #smelts_to_glass. Added here: #fuel (anything a furnace
 * burns), #food (anything safe to eat), #cooked_food and #raw_meat.
 */
export class ItemTags {
  private readonly groups = new Map<string, readonly string[]>()
  private readonly byItem = new Map<string, string[]>()

  constructor (registry: RegistryLike) {
    const names = registry.itemsArray.map(i => i.name)
    const known = new Set(names)
    const add = (tag: string, members: Iterable<string>): void => {
      const list = [...new Set(members)].filter(n => known.has(n))
      this.groups.set(tag, list)
      for (const m of list) {
        let tags = this.byItem.get(m)
        if (tags == null) this.byItem.set(m, tags = [])
        tags.push(tag)
      }
    }

    const logs: string[] = []
    for (const wood of WOOD_TYPES) {
      if (wood === 'bamboo') {
        add('bamboo_blocks', ['bamboo_block', 'stripped_bamboo_block'])
        continue
      }
      const nether = NON_FLAMMABLE_WOOD.includes(wood)
      const [log, wood2] = nether ? ['stem', 'hyphae'] : ['log', 'wood']
      const members = [`${wood}_${log}`, `${wood}_${wood2}`, `stripped_${wood}_${log}`, `stripped_${wood}_${wood2}`]
      add(nether ? `${wood}_stems` : `${wood}_logs`, members)
      logs.push(...members)
    }
    add('logs', logs)
    add('logs_that_burn', logs.filter(n => burnTicks(n) > 0))
    add('planks', names.filter(n => n.endsWith('_planks')))
    add('wooden_slabs', WOOD_TYPES.map(w => `${w}_slab`))
    add('coals', ['coal', 'charcoal'])
    add('wool', names.filter(n => n.endsWith('_wool')))
    add('saplings', [...names.filter(n => n.endsWith('_sapling')), 'mangrove_propagule', 'azalea', 'flowering_azalea'])
    add('leaves', names.filter(n => n.endsWith('_leaves')))
    add('stone_crafting_materials', ['cobblestone', 'blackstone', 'cobbled_deepslate'])
    add('stone_tool_materials', ['cobblestone', 'blackstone', 'cobbled_deepslate'])
    add('smelts_to_glass', ['sand', 'red_sand'])
    for (const ore of ['coal', 'iron', 'copper', 'gold', 'redstone', 'lapis', 'diamond', 'emerald']) {
      add(`${ore}_ores`, [`${ore}_ore`, `deepslate_${ore}_ore`])
    }
    const toolsOf = (kind: ToolKind): string[] => names.filter(n => parseTool(n)?.kind === kind)
    add('pickaxes', toolsOf('pickaxe'))
    add('axes', toolsOf('axe'))
    add('shovels', toolsOf('shovel'))
    add('hoes', toolsOf('hoe'))
    add('swords', toolsOf('sword'))
    add('fuel', names.filter(n => burnTicks(n) > 0))
    const foods = foodsOf(registry)
    add('food', Object.keys(foods).filter(n => foods[n].harmful !== true))
    add('cooked_food', ['cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken', 'cooked_rabbit', 'cooked_cod', 'cooked_salmon', 'bread', 'baked_potato', 'golden_carrot', 'pumpkin_pie'])
    add('raw_meat', ['beef', 'porkchop', 'mutton', 'chicken', 'rabbit', 'cod', 'salmon'])
  }

  /** the members of `#tag` (or of `tag`), empty for an unknown tag */
  members (tag: string): readonly string[] {
    return this.groups.get(tag.startsWith('#') ? tag.slice(1) : tag) ?? []
  }

  /** an item name stays itself, `#tag` becomes its members */
  resolve (nameOrTag: string): readonly string[] {
    return nameOrTag.startsWith('#') ? this.members(nameOrTag) : [nameOrTag]
  }

  /** whether `item` matches `nameOrTag` (an item name or `#tag`) */
  matches (nameOrTag: string, item: string): boolean {
    return nameOrTag.startsWith('#') ? this.tagsOf(item).includes(nameOrTag.slice(1)) : nameOrTag === item
  }

  /** the tags `item` belongs to */
  tagsOf (item: string): readonly string[] {
    return this.byItem.get(item) ?? []
  }

  get names (): string[] {
    return [...this.groups.keys()]
  }
}

/** the tags of a registry, built once */
export const itemTags = cachedPerRegistry(registry => new ItemTags(registry))
