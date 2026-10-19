// A synthetic bot for the reflex and skill unit tests: a version's registry (1.21.11 unless the test says another), an
// inventory, entities with metadata and a world of named blocks, without a server.
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'

/* eslint-disable @typescript-eslint/no-var-requires */
const FAKE_VERSION = '1.21.11'
const versions = new Map<string, { registry: any, Item: any }>()
function versionData (version: string): { registry: any, Item: any } {
  let data = versions.get(version)
  if (data == null) versions.set(version, data = { registry: require('minecraft-data')(version), Item: require('prismarine-item')(version) })
  return data
}

const SOLID = new Set(['stone', 'dirt', 'grass_block', 'bedrock', 'obsidian', 'cobblestone', 'magma_block', 'oak_planks'])

/** an item of the version (the fake bot's must be the same) */
export function item (name: string, count = 1, enchants?: Array<{ name: string, lvl: number }>, version = FAKE_VERSION): any {
  const { registry, Item } = versionData(version)
  const def = registry.itemsByName[name]
  if (def == null) throw new Error(`no item ${name} in ${version}`)
  const it = new Item(def.id, count)
  if (enchants != null) it.enchants = enchants
  return it
}

export interface FakeEntityInput {
  name: string
  position: Vec3
  /** metadata by field name (e.g. { swell_dir: 1 }) */
  meta?: Record<string, unknown>
  id?: number
  version?: string
}

let nextId = 100

export function entity (input: FakeEntityInput): any {
  const def = versionData(input.version ?? FAKE_VERSION).registry.entitiesByName[input.name]
  const metadata: any[] = []
  for (const [key, value] of Object.entries(input.meta ?? {})) {
    const i = def.metadataKeys.indexOf(key)
    if (i < 0) throw new Error(`${input.name} has no ${key}`)
    metadata[i] = value
  }
  return { id: input.id ?? nextId++, name: input.name, type: def.type, position: input.position, velocity: new Vec3(0, 0, 0), width: def.width, height: def.height, metadata }
}

export interface FakeBotInput {
  position?: Vec3
  food?: number
  saturation?: number
  health?: number
  oxygen?: number
  items?: any[]
  armor?: Partial<Record<'head' | 'torso' | 'legs' | 'feet', any>>
  offhand?: any
  entities?: any[]
  /** the block name at a position; default: stone below y 64, air from 64 */
  world?: (pos: Vec3) => string
  inLava?: boolean
  inWater?: boolean
  onGround?: boolean
  usingHeldItem?: boolean
  /** the registry's version (default 1.21.11): the items and entities given must be of it */
  version?: string
}

const DEST = { head: 5, torso: 6, legs: 7, feet: 8, 'off-hand': 45, hand: 36 } as const

export function fakeBot (input: FakeBotInput = {}): any {
  const bot: any = new EventEmitter()
  bot.registry = versionData(input.version ?? FAKE_VERSION).registry
  bot.version = input.version ?? FAKE_VERSION
  const slots: any[] = new Array(46).fill(null)
  let i = 9
  for (const it of input.items ?? []) { it.slot = i; slots[i++] = it }
  for (const [slot, it] of Object.entries(input.armor ?? {})) { if (it != null) { it.slot = (DEST as any)[slot]; slots[(DEST as any)[slot]] = it } }
  if (input.offhand != null) { input.offhand.slot = 45; slots[45] = input.offhand }
  bot.inventory = Object.assign(new EventEmitter(), {
    slots,
    items: () => slots.slice(9, 45).filter(s => s != null)
  })
  bot.getEquipmentDestSlot = (d: keyof typeof DEST) => DEST[d]
  bot.food = input.food ?? 20
  bot.foodSaturation = input.saturation ?? 5
  bot.health = input.health ?? 20
  bot.oxygenLevel = input.oxygen ?? 20
  bot.game = { gameMode: 'survival' }
  bot.heldItem = null
  bot.usingHeldItem = input.usingHeldItem ?? false
  bot.entity = {
    id: 1,
    name: 'player',
    type: 'player',
    position: input.position ?? new Vec3(0.5, 64, 0.5),
    velocity: new Vec3(0, 0, 0),
    onGround: input.onGround ?? true,
    eyeHeight: 1.62,
    isInLava: input.inLava ?? false,
    isInWater: input.inWater ?? false,
    metadata: [],
    height: 1.8,
    width: 0.6
  }
  bot.entities = { 1: bot.entity }
  for (const e of input.entities ?? []) bot.entities[e.id] = e
  const world = input.world ?? ((pos: Vec3) => pos.y < 64 ? 'stone' : 'air')
  bot.blockAt = (pos: Vec3) => {
    const p = pos.floored()
    const name = world(p)
    return { name, position: p, boundingBox: SOLID.has(name) ? 'block' : 'empty' }
  }
  bot.controls = {} as Record<string, boolean>
  bot.setControlState = (k: string, v: boolean) => { bot.controls[k] = v }
  bot.getControlState = (k: string) => bot.controls[k] === true
  bot.clearControlStates = () => { bot.controls = {} }
  bot.look = async () => {}
  bot.waitForTicks = async () => {}
  return bot
}
