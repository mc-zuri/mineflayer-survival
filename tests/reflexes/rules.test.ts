import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { armorReflex, creeperReflex, drowningReflex, eatReflex, emergencyEatReflex, hazardReflex, hostilesReflex, nightReflex, totemReflex } from '../../src/reflexes/rules'
import { ReflexEngine } from '../../src/reflexes/engine'
import { DEFAULT_REFLEX_CONFIG, type ReflexConfigInput } from '../../src/reflexes/config'
import type { Reflex } from '../../src/reflexes/types'
import { CREEPER_IGNITED_INDEX, CREEPER_SWELL_DIR_INDEX, creeperSwelling } from '../../src/skills/fight'
import { metadataIndex } from '../../src/skills/combatUtil'
import { rememberShelter, shelterToLeave } from '../../src/skills/shelter'
import { entity, fakeBot, item, type FakeBotInput } from './fakeBot'

const at = (x: number, y = 64, z = 0.5): Vec3 => new Vec3(0.5 + x, y, z)

function check (reflex: Reflex, input: FakeBotInput, config: ReflexConfigInput = {}, setup?: (engine: ReflexEngine) => void): string | null {
  const bot = fakeBot(input)
  const engine = new ReflexEngine(bot, { config, enabled: false })
  setup?.(engine)
  const task = reflex.check(engine.context())
  engine.stop()
  return task == null ? null : (task.detail ?? task.name)
}

test('the creeper\'s fuse fields on 1.21.11: swell_dir at 16, is_ignited at 18 (Creeper.DATA_SWELL_DIR, DATA_IS_IGNITED)', () => {
  const bot = fakeBot()
  assert.strictEqual(metadataIndex(bot, 'creeper', 'swell_dir', -1), 16)
  assert.strictEqual(metadataIndex(bot, 'creeper', 'is_ignited', -1), 18)
  assert.strictEqual(CREEPER_SWELL_DIR_INDEX, 16)
  assert.strictEqual(CREEPER_IGNITED_INDEX, 18)
  assert.strictEqual(creeperSwelling(bot, entity({ name: 'creeper', position: at(2), meta: { swell_dir: 1 } })), true)
  assert.strictEqual(creeperSwelling(bot, entity({ name: 'creeper', position: at(2), meta: { swell_dir: -1 } })), false)
  assert.strictEqual(creeperSwelling(bot, entity({ name: 'creeper', position: at(2), meta: { swell_dir: -1, is_ignited: true } })), true)
})

test('creeper reflex: a swelling creeper within the blast, or any within 3 blocks', () => {
  const creeper = (x: number, swell: number): any => entity({ name: 'creeper', position: at(x), meta: { swell_dir: swell } })
  assert.strictEqual(check(creeperReflex, { entities: [creeper(5, -1)] }), null)
  assert.strictEqual(check(creeperReflex, { entities: [creeper(5, 1)] }), 'evade creeper')
  assert.strictEqual(check(creeperReflex, { entities: [creeper(2.5, -1)] }), 'evade creeper')
  assert.strictEqual(check(creeperReflex, { entities: [creeper(9, 1)] }), null)
  // configurable
  assert.strictEqual(check(creeperReflex, { entities: [creeper(4, -1)] }, { creeper: { triggerDistance: 5 } }), 'evade creeper')
  assert.strictEqual(check(creeperReflex, { entities: [creeper(9, 1)] }, { creeper: { safeDistance: 10 } }), 'evade creeper')
  assert.strictEqual(check(creeperReflex, { entities: [creeper(2, 1)] }, { creeper: { enabled: false } }), null)
})

test('eat reflex: at food 14 out of combat, or at low health with no hostile in reach', () => {
  const bread = [item('bread', 5)]
  assert.strictEqual(check(eatReflex, { food: 14, items: bread }), 'eat')
  assert.strictEqual(check(eatReflex, { food: 15, items: bread }), null)
  assert.strictEqual(check(eatReflex, { food: 14, items: [] }), null)
  // a zombie in range: combat
  const zombie = entity({ name: 'zombie', position: at(5) })
  assert.strictEqual(check(eatReflex, { food: 10, items: bread, entities: [zombie] }), null)
  // hurt a moment ago: combat
  assert.strictEqual(check(eatReflex, { food: 10, items: bread }, {}, e => { (e as any).lastHurtTick = e.tick - 5 }), null)
  // low health: eat even in combat once nothing's within reach
  assert.strictEqual(check(eatReflex, { food: 18, health: 8, items: bread }), 'eat')
  assert.strictEqual(check(eatReflex, { food: 18, health: 8, items: bread, entities: [zombie] }), null)
  assert.strictEqual(check(eatReflex, { food: 18, health: 8, items: bread, entities: [entity({ name: 'zombie', position: at(12) })] }), 'eat')
  // only rotten flesh: not until starving
  assert.strictEqual(check(eatReflex, { food: 12, items: [item('rotten_flesh', 4)] }), null)
  assert.strictEqual(check(eatReflex, { food: 6, items: [item('rotten_flesh', 4)] }), 'eat')
  // configurable
  assert.strictEqual(check(eatReflex, { food: 12, items: bread }, { eat: { food: 10 } }), null)
  assert.strictEqual(check(eatReflex, { food: 19, health: 12, items: bread }, { eat: { health: 12 } }), 'eat')
})

test('hostiles reflex: fight the nearest, flee when hurt or outnumbered', () => {
  const zombie = (x: number, y = 64): any => entity({ name: 'zombie', position: at(x, y) })
  assert.strictEqual(check(hostilesReflex, { entities: [zombie(5)] }), 'fight zombie')
  assert.strictEqual(check(hostilesReflex, { entities: [zombie(10)] }), null)
  assert.strictEqual(check(hostilesReflex, { entities: [zombie(3, 70)] }), null)
  assert.strictEqual(check(hostilesReflex, { entities: [zombie(5)], health: 6 }), 'flee')
  assert.strictEqual(check(hostilesReflex, { entities: [zombie(3), zombie(4), zombie(5), zombie(6)] }), 'flee')
  assert.strictEqual(check(hostilesReflex, { entities: [zombie(3), zombie(4), zombie(5), zombie(6)] }, { hostiles: { maxFight: 5 } }), 'fight zombie')
  assert.strictEqual(check(hostilesReflex, { entities: [zombie(5)], health: 10 }, { hostiles: { fleeHealth: 10 } }), 'flee')
  assert.strictEqual(check(hostilesReflex, { entities: [zombie(5)] }, { hostiles: { fleeUnarmed: true } }), 'flee')
  assert.strictEqual(check(hostilesReflex, { entities: [zombie(5)], items: [item('iron_sword')] }, { hostiles: { fleeUnarmed: true } }), 'fight zombie')
  // neutral mobs and bosses aren't fought; passive ones aren't hostile
  assert.strictEqual(check(hostilesReflex, { entities: [entity({ name: 'enderman', position: at(3) }), entity({ name: 'cow', position: at(2) })] }), null)
  assert.strictEqual(check(hostilesReflex, { entities: [entity({ name: 'skeleton', position: at(7) })] }), 'fight skeleton')
})

test('hostiles reflex: creepers are shot from a distance, fought only with a shield, else fled', () => {
  const creeper = (x: number): any => entity({ name: 'creeper', position: at(x) })
  assert.strictEqual(check(hostilesReflex, { entities: [creeper(6)] }), 'flee')
  assert.strictEqual(check(hostilesReflex, { entities: [creeper(6)], items: [item('bow'), item('arrow', 16)] }), 'shoot creeper')
  assert.strictEqual(check(hostilesReflex, { entities: [creeper(4)], items: [item('bow'), item('arrow', 16)] }), 'flee')
  assert.strictEqual(check(hostilesReflex, { entities: [creeper(4), entity({ name: 'zombie', position: at(5) })] }), 'fight zombie')
  assert.strictEqual(check(hostilesReflex, { entities: [creeper(4)], offhand: item('shield') }), 'fight creeper')
})

test('hazard reflex: in lava, or fire at the feet', () => {
  assert.strictEqual(check(hazardReflex, {}), null)
  assert.strictEqual(check(hazardReflex, { inLava: true }), 'hazard')
  assert.strictEqual(check(hazardReflex, { world: p => p.y === 64 ? 'fire' : p.y < 64 ? 'stone' : 'air' }), 'hazard')
  assert.strictEqual(check(hazardReflex, { world: p => p.y === 63 ? 'lava' : p.y < 63 ? 'stone' : 'air' }), null)
  assert.strictEqual(check(hazardReflex, { inLava: true }, { hazard: { enabled: false } }), null)
})

test('drowning reflex: surface when the air is low with the head under water', () => {
  const underwater = (p: Vec3): string => p.y < 60 ? 'stone' : p.y < 70 ? 'water' : 'air'
  assert.strictEqual(check(drowningReflex, { oxygen: 5, world: underwater }), 'drowning')
  assert.strictEqual(check(drowningReflex, { oxygen: 6, world: underwater }), 'drowning')
  assert.strictEqual(check(drowningReflex, { oxygen: 7, world: underwater }), null)
  assert.strictEqual(check(drowningReflex, { oxygen: 5 }), null)
  assert.strictEqual(check(drowningReflex, { oxygen: 10, world: underwater }, { drowning: { air: 12 } }), 'drowning')
})

test('armor reflex: when better armor comes into the inventory', () => {
  assert.strictEqual(check(armorReflex, { items: [item('iron_chestplate')] }), 'armor')
  assert.strictEqual(check(armorReflex, { items: [item('iron_chestplate')] }, {}, e => { (e as any).armorChanged = false }), null)
  assert.strictEqual(check(armorReflex, { items: [item('leather_chestplate')], armor: { torso: item('iron_chestplate') } }), null)
})

test('totem reflex: a totem goes to the off hand, unless the shield is up there', () => {
  const totem = [item('totem_of_undying')]
  assert.strictEqual(check(totemReflex, { items: totem }), 'totem')
  assert.strictEqual(check(totemReflex, { items: [] }), null)
  assert.strictEqual(check(totemReflex, { offhand: item('totem_of_undying') }), null)
  assert.strictEqual(check(totemReflex, { items: totem, offhand: item('shield'), usingHeldItem: true }), null)
  assert.strictEqual(check(totemReflex, { items: totem }, { totem: { always: false } }), null)
  assert.strictEqual(check(totemReflex, { items: totem, health: 8 }, { totem: { always: false } }), 'totem')
})

test('hostiles and creeper reflexes leave alone what has no line of sight to the bot (a wall, a shelter\'s roof)', () => {
  // a stone wall at x 2 from y 64 to 66, between the bot (x 0.5) and the mobs further along x
  const wall = (pos: Vec3): string => pos.y < 64 ? 'stone' : pos.x === 2 && pos.y <= 66 ? 'stone' : 'air'
  const zombie = entity({ name: 'zombie', position: at(4) })
  assert.strictEqual(check(hostilesReflex, { entities: [zombie] }), 'fight zombie')
  assert.strictEqual(check(hostilesReflex, { entities: [zombie], world: wall }), null)
  const creeper = (meta?: Record<string, unknown>): any => entity({ name: 'creeper', position: at(2.2), meta })
  assert.strictEqual(check(creeperReflex, { entities: [creeper()], world: (p) => p.y < 64 ? 'stone' : p.x === 1 && p.y <= 66 ? 'stone' : 'air' }), null)
  assert.strictEqual(check(creeperReflex, { entities: [creeper()] }), 'evade creeper')
  // swelling, it sees the bot (the server says so): evade whatever the client's blocks say
  assert.strictEqual(check(creeperReflex, { entities: [creeper({ swell_dir: 1 })], world: (p) => p.y < 64 ? 'stone' : p.x === 1 && p.y <= 66 ? 'stone' : 'air' }), 'evade creeper')
  // the bot in a hole three deep (feet at 61), sealed at 63; a zombie standing on the seal
  const hole = (p: Vec3): string => (p.x === 0 && p.z === 0 && (p.y === 61 || p.y === 62)) ? 'air' : p.y < 64 ? 'dirt' : 'air'
  const above = entity({ name: 'zombie', position: new Vec3(0.5, 64, 0.5) })
  assert.strictEqual(check(hostilesReflex, { position: new Vec3(0.5, 61, 0.5), entities: [above], world: hole }), null)
})

test('night reflex: at night a bed means sleep, poor gear a shelter, good gear nothing (the hostiles reflex fights); not by day or underground', () => {
  const night = (input: FakeBotInput, time: number, setup?: (bot: any) => void): string | null => {
    const bot = fakeBot(input)
    bot.time = { timeOfDay: time }
    bot.game.dimension = 'overworld'
    setup?.(bot)
    const engine = new ReflexEngine(bot, { enabled: false })
    const task = nightReflex.check(engine.context())
    engine.stop()
    return task == null ? null : (task.detail ?? task.name)
  }
  const early = { items: [item('stone_sword'), item('bread', 4)] }
  assert.strictEqual(night(early, 13000), 'shelter')
  assert.strictEqual(night(early, 6000), null)
  assert.strictEqual(night(early, 23500), null)
  assert.strictEqual(night({ items: [...early.items, item('white_bed')] }, 13000), 'sleep')
  const iron = { head: item('iron_helmet'), torso: item('iron_chestplate'), legs: item('iron_leggings'), feet: item('iron_boots') }
  assert.strictEqual(night({ armor: iron, items: [item('iron_sword')] }, 13000), null)
  assert.strictEqual(night(early, 13000, bot => { bot.game.dimension = 'the_nether' }), null)
  // in a mine (rock over the head): not a night out; under a tree's leaves it is
  assert.strictEqual(night({ ...early, world: (p: Vec3) => p.y < 64 || p.y >= 70 ? 'stone' : 'air' }, 13000), null)
  assert.strictEqual(night({ ...early, world: (p: Vec3) => p.y < 64 ? 'stone' : p.y === 69 ? 'oak_leaves' : 'air' }, 13000), 'shelter')
  assert.strictEqual(night(early, 13000, bot => { bot.isSleeping = true }), null)
  assert.strictEqual(night(early, 13000), 'shelter')
  // the runner's night mining on its way down: no shelter
  assert.strictEqual(night(early, 13000, bot => { bot.survival = { ...bot.survival, nightWork: true } }), null)
  // turned off
  const bot = fakeBot(early)
  bot.time = { timeOfDay: 13000 }
  const engine = new ReflexEngine(bot, { enabled: false, config: { night: { shelter: false } } })
  assert.strictEqual(nightReflex.check(engine.context()), null)
  engine.stop()
})

test('hostiles reflex: a skeleton shooting from 12 blocks is taken on (the ones that shoot count to rangedRange, 16), a zombie there isn\'t', () => {
  assert.strictEqual(check(hostilesReflex, { entities: [entity({ name: 'skeleton', position: at(12) })] }), 'fight skeleton')
  assert.strictEqual(check(hostilesReflex, { entities: [entity({ name: 'pillager', position: at(14) })] }), 'fight pillager')
  assert.strictEqual(check(hostilesReflex, { entities: [entity({ name: 'zombie', position: at(12) })] }), null)
  assert.strictEqual(check(hostilesReflex, { entities: [entity({ name: 'skeleton', position: at(15) })] }, { hostiles: { rangedRange: 8 } }), null)
  const wall = (pos: Vec3): string => pos.y < 64 ? 'stone' : pos.x === 4 && pos.y <= 66 ? 'stone' : 'air'
  assert.strictEqual(check(hostilesReflex, { entities: [entity({ name: 'skeleton', position: at(12) })], world: wall }), null)
})

test('eat reflex: hurt and out of combat, eat up to food 18, where the health comes back (FoodData.tick)', () => {
  const bread = [item('bread', 5)]
  assert.strictEqual(check(eatReflex, { food: 16, health: 14, items: bread }), 'eat')
  assert.strictEqual(check(eatReflex, { food: 17, health: 19, items: bread }), 'eat')
  // full health, or food 18 already: no need
  assert.strictEqual(check(eatReflex, { food: 16, health: 20, items: bread }), null)
  assert.strictEqual(check(eatReflex, { food: 18, health: 14, items: bread }), null)
  // not in a fight
  assert.strictEqual(check(eatReflex, { food: 16, health: 14, items: bread, entities: [entity({ name: 'zombie', position: at(5) })] }), null)
  assert.strictEqual(check(eatReflex, { food: 16, health: 14, items: bread }, { eat: { regenFood: 0 } }), null)
})

test('hostiles reflex: at low health an armored bot with a weapon fights on against one hostile, flees from two', () => {
  const zombie = (x: number): any => entity({ name: 'zombie', position: at(x) })
  const iron = { head: item('iron_helmet'), torso: item('iron_chestplate'), legs: item('iron_leggings'), feet: item('iron_boots') }
  assert.strictEqual(check(hostilesReflex, { entities: [zombie(4)], health: 5, armor: iron, items: [item('iron_sword')] }), 'fight zombie')
  assert.strictEqual(check(hostilesReflex, { entities: [zombie(4), zombie(6)], health: 5, armor: iron, items: [item('iron_sword')] }), 'flee')
  assert.strictEqual(check(hostilesReflex, { entities: [zombie(4)], health: 5, armor: iron }), 'flee')
  assert.strictEqual(check(hostilesReflex, { entities: [zombie(4)], health: 5, armor: { torso: item('leather_chestplate') }, items: [item('iron_sword')] }), 'flee')
  assert.strictEqual(check(hostilesReflex, { entities: [zombie(4)], health: 5, armor: iron, items: [item('iron_sword')] }, { hostiles: { fightOnArmor: 21 } }), 'flee')
})

test('night reflex: by day, a bot still down its shelter\'s column (cut off climbing out) is got out; out of it, nothing', () => {
  const bot = fakeBot({ position: new Vec3(0.5, 62, 0.5), items: [item('stone_sword'), item('dirt', 3)] })
  bot.time = { timeOfDay: 1000 }
  bot.game.dimension = 'overworld'
  const engine = new ReflexEngine(bot, { enabled: false })
  assert.strictEqual(nightReflex.check(engine.context()), null)
  rememberShelter(bot, new Vec3(0, 64, 0))
  assert.strictEqual(nightReflex.check(engine.context())?.detail, 'leave shelter')
  bot.entity.position = new Vec3(0.5, 64, 0.5)
  assert.strictEqual(nightReflex.check(engine.context()), null)
  // and forgotten once out
  bot.entity.position = new Vec3(0.5, 62, 0.5)
  assert.strictEqual(shelterToLeave(bot), null)
  engine.stop()
})

test('creeper reflex: leaves a creeper the hostiles reflex is fighting with a shield to the fight (it blocks the blast itself)', () => {
  const creeper = entity({ name: 'creeper', position: at(2.2) })
  const fighting = (e: ReflexEngine): void => { (e as any).running = { task: { name: 'hostiles', priority: 60, detail: 'fight creeper' }, cancel: () => {} } }
  assert.strictEqual(check(creeperReflex, { entities: [creeper], offhand: item('shield') }, {}, fighting), null)
  // no shield: run
  assert.strictEqual(check(creeperReflex, { entities: [creeper] }, {}, fighting), 'evade creeper')
  // not fighting it: run
  assert.strictEqual(check(creeperReflex, { entities: [creeper], offhand: item('shield') }), 'evade creeper')
})

test('hostiles reflex: an enderman is let be until it hurts the bot, then fought back for a while; a warden never', () => {
  const enderman = entity({ name: 'enderman', position: at(3) })
  const warden = entity({ name: 'warden', position: at(3) })
  assert.strictEqual(check(hostilesReflex, { entities: [enderman], items: [item('stone_sword')] }), null)
  const hurtBy = (attacker: any) => (e: ReflexEngine): void => { (e as any).onHurt((e as any).bot.entity, attacker) }
  assert.strictEqual(check(hostilesReflex, { entities: [enderman], items: [item('stone_sword')] }, {}, hurtBy(enderman)), 'fight enderman')
  assert.strictEqual(check(hostilesReflex, { entities: [warden], items: [item('stone_sword')] }, {}, hurtBy(warden)), null)
  // long ago: let be again
  assert.strictEqual(check(hostilesReflex, { entities: [enderman], items: [item('stone_sword')] }, {}, (e) => { hurtBy(enderman)(e); (e as any).tick += 401 }), null)
})

test('night reflex: no ground to dig in about (the sea all round): tried again only after 200 ticks, twice as far out', async () => {
  const bot = fakeBot({ items: [item('stone_sword')], world: (p: Vec3) => p.y < 64 ? 'water' : 'air' })
  bot.time = { timeOfDay: 13000 }
  bot.game.dimension = 'overworld'
  const engine = new ReflexEngine(bot, { enabled: false })
  const ctx = engine.context()
  const task = nightReflex.check(ctx)
  assert.strictEqual(task?.detail, 'shelter')
  await assert.rejects(task!.run(new AbortController().signal), /NOT_FOUND/)
  assert.strictEqual(nightReflex.check({ ...ctx, tick: ctx.tick + 100 }), null)
  assert.strictEqual(nightReflex.check({ ...ctx, tick: ctx.tick + 200 })?.detail, 'shelter')
  engine.stop()
})

test('armor reflex: better armor in the bag goes on before the fight with the zombie at hand (it outranks the hostiles reflex)', () => {
  const bot = fakeBot({ entities: [entity({ name: 'zombie', position: at(3) })], items: [item('iron_sword'), item('iron_chestplate')] })
  const engine = new ReflexEngine(bot, { enabled: false })
  assert.strictEqual(engine.evaluate()?.name, 'armor')
  assert.ok(DEFAULT_REFLEX_CONFIG.armor.priority > DEFAULT_REFLEX_CONFIG.hostiles.priority)
  engine.stop()
})

test('hostiles reflex: a neutral animal that hurt the bot (a polar bear by its cub) is fought back; let be before', () => {
  const bear = entity({ name: 'polar_bear', position: at(2) })
  const hurtBy = (attacker: any) => (e: ReflexEngine): void => { (e as any).onHurt((e as any).bot.entity, attacker) }
  assert.strictEqual(check(hostilesReflex, { entities: [bear], items: [item('stone_sword')] }), null)
  assert.strictEqual(check(hostilesReflex, { entities: [bear], items: [item('stone_sword')] }, {}, hurtBy(bear)), 'fight polar_bear')
  // a cow is never fought, hurt or not (nothing hurts like that)
  const cow = entity({ name: 'cow', position: at(2) })
  assert.strictEqual(check(hostilesReflex, { entities: [cow], items: [item('stone_sword')] }, {}, hurtBy(cow)), null)
})

test('emergency eat: at 8 health or less a golden apple is eaten, two angry endermen hitting or not', () => {
  const enderman = (x: number): any => entity({ name: 'enderman', position: at(x) })
  assert.strictEqual(check(emergencyEatReflex, { health: 7, food: 20, items: [item('golden_apple', 2)], entities: [enderman(1), enderman(-1)] }), 'golden_apple')
  assert.strictEqual(check(emergencyEatReflex, { health: 7, items: [item('golden_apple', 1), item('enchanted_golden_apple', 1)] }), 'enchanted_golden_apple')
  assert.strictEqual(check(emergencyEatReflex, { health: 9, items: [item('golden_apple', 2)] }), null)
  assert.strictEqual(check(emergencyEatReflex, { health: 4, items: [item('bread', 5)] }), null)
})
