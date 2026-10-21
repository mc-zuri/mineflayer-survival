// The server's spawn protection learnt and kept out of (skills/spawnProtection): a bot in the browser on a server with
// spawn-protection 16 was stuck at 'survival: stone (step:kill 2 cow for 4 beef)', its digs and places by the spawn
// refused ('1, 67, 1 is under spawn protection') and put back, again and again.
import { test } from 'node:test'
import assert from 'node:assert'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import {
  SPAWN_INFER_RANGE, SPAWN_PROTECTION_COST, SPAWN_PROTECTION_RADIUS, installSpawnProtection, keepOffSpawnProtection,
  REFUSED_CELL_TICKS, REGION_RANGE, REGION_TICKS, breakRefused, inRefusedRegion, placeRefused,
  placeUnderSpawnProtection, spawnProtectionMessage, spawnProtectionState, underSpawnProtection, usableOutside,
  inSiteSquare, outOfSiteSquare, siteLookup, siteSquareRadius
} from '../../src/skills/spawnProtection'
import { dig, placeAgainst } from '../../src/core/actions'
import { collectBlock } from '../../src/skills/collectBlock'
import { placeBlock } from '../../src/skills/placeBlock'
import { stepProtect } from '../../src/executor/executor'
import { boxInSiteSquare } from '../../src/base/build'
import { fakeBot, item } from '../reflexes/fakeBot'

const STONE = { type: 1, stateId: 1, name: 'stone' }
const AIR = { type: 0, stateId: 0, name: 'air' }
const COBBLE = { type: 12, stateId: 14, name: 'cobblestone' }
const GRAVEL = { type: 40, stateId: 118, name: 'gravel' }
const at = (b: { type: number, stateId: number, name: string }, pos: Vec3): any => ({ ...b, position: pos })

function spawnBot (spawn = new Vec3(0, 64, 0)): any {
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5) })
  bot.spawnPoint = spawn
  bot._client = new EventEmitter()
  return bot
}

/** the 26.3 server's action bar message, as prismarine-chat has it */
const message = (text: string): any => ({ translate: 'build.spawn_protection', with: [{ text, toString: () => text }], toString: () => `${text} is under spawn protection` })

/** a dig the client predicted at `pos` and the server put back */
function refusedDig (bot: any, pos: Vec3, block = STONE): void {
  bot.targetDigBlock = at(block, pos)
  bot.emit('blockUpdate', at(block, pos), at(AIR, pos))
  bot.targetDigBlock = null
  bot.emit('blockUpdate', at(AIR, pos), at(block, pos))
}

/** a place the client predicted at `pos` and the server put back */
function refusedPlace (bot: any, pos: Vec3): void {
  bot.emit('blockPlaced', at(AIR, pos), at(COBBLE, pos))
  bot.emit('blockUpdate', at(COBBLE, pos), at(AIR, pos))
}

test('the refusal\'s message: the translatable build.spawn_protection with the block\'s "x, y, z", or its English text; no other', () => {
  assert.deepStrictEqual(spawnProtectionMessage(message('1, 67, 1')), new Vec3(1, 67, 1))
  assert.deepStrictEqual(spawnProtectionMessage({ text: '', extra: [message('-3, 70, -12')] }), new Vec3(-3, 70, -12))
  assert.deepStrictEqual(spawnProtectionMessage('1, 68, -1 is under spawn protection'), new Vec3(1, 68, -1))
  assert.strictEqual(spawnProtectionMessage({ translate: 'build.tooHigh', with: ['319'], toString: () => 'Height limit for building is 319' }), null)
  assert.strictEqual(spawnProtectionMessage('<steve> 1, 2, 3 go'), null)
})

test('the message learns the square: SPAWN_PROTECTION_RADIUS about the world spawn (max |dx|, |dz|), the places a block past it; a refusal further out widens it', () => {
  const bot = spawnBot(new Vec3(0, 64, 0))
  installSpawnProtection(bot, 'auto')
  assert.strictEqual(underSpawnProtection(bot, new Vec3(1, 67, 1)), false)
  bot.emit('message', message('1, 67, 1'), 'game_info')
  assert.strictEqual(spawnProtectionState(bot)?.radius, SPAWN_PROTECTION_RADIUS)
  assert.strictEqual(underSpawnProtection(bot, new Vec3(16, 10, -16)), true)
  assert.strictEqual(underSpawnProtection(bot, new Vec3(17, 64, 0)), false)
  // a block placed at 17 is placed against one at 16 (the server checks the block clicked)
  assert.strictEqual(placeUnderSpawnProtection(bot, new Vec3(17, 64, 0)), true)
  assert.strictEqual(placeUnderSpawnProtection(bot, new Vec3(18, 64, 0)), false)
  bot.emit('message', message('-20, 64, 3'), 'game_info')
  assert.strictEqual(spawnProtectionState(bot)?.radius, 20)
  // in another dimension than the spawn's: none
  bot.game.dimension = 'minecraft:the_nether'
  assert.strictEqual(underSpawnProtection(bot, new Vec3(1, 64, 1)), false)
})

test('the option: a radius known from the start (0 none), the message widening it; \'auto\' none until a refusal', () => {
  const set = spawnBot()
  installSpawnProtection(set, 8)
  assert.strictEqual(underSpawnProtection(set, new Vec3(8, 64, 0)), true)
  assert.strictEqual(underSpawnProtection(set, new Vec3(9, 64, 0)), false)
  set.emit('message', message('5, 64, 5'), 'game_info')
  assert.strictEqual(spawnProtectionState(set)?.radius, 8)
  const none = spawnBot()
  installSpawnProtection(none, 0)
  assert.strictEqual(underSpawnProtection(none, new Vec3(0, 64, 0)), false)
})

test(`two digs the server put back within SPAWN_INFER_RANGE of the spawn are its protection (1.21.11 says nothing); one, a gravel's fall, or ones far off are not`, () => {
  const bot = spawnBot()
  installSpawnProtection(bot, 'auto')
  refusedDig(bot, new Vec3(1, 67, 1))
  assert.strictEqual(spawnProtectionState(bot)?.radius, null)
  // gravel falling into the cell it was dug from is no refusal
  refusedDig(bot, new Vec3(2, 66, 2), GRAVEL)
  refusedDig(bot, new Vec3(2, 66, 2), GRAVEL)
  assert.strictEqual(spawnProtectionState(bot)?.radius, null)
  // far off: whatever puts it back (an anticheat), it's not the spawn's
  refusedDig(bot, new Vec3(SPAWN_INFER_RANGE + 5, 60, 0))
  refusedDig(bot, new Vec3(SPAWN_INFER_RANGE + 5, 60, 0))
  assert.strictEqual(spawnProtectionState(bot)?.radius, null)
  // a dig that stays broken: none
  bot.targetDigBlock = at(STONE, new Vec3(3, 63, 3))
  bot.emit('blockUpdate', at(STONE, new Vec3(3, 63, 3)), at(AIR, new Vec3(3, 63, 3)))
  bot.targetDigBlock = null
  refusedDig(bot, new Vec3(1, 67, 1))
  assert.strictEqual(spawnProtectionState(bot)?.radius, SPAWN_PROTECTION_RADIUS)
})

test('the digs of two cells put back near the spawn, each once (a refused cell is not dug again), are its protection too; the radius the farther one has', () => {
  const bot = spawnBot()
  installSpawnProtection(bot, 'auto')
  refusedDig(bot, new Vec3(2, 64, 3))
  refusedDig(bot, new Vec3(-20, 60, 3))
  assert.strictEqual(spawnProtectionState(bot)?.radius, 20)
})

test('a place the server put back twice at a cell near the spawn is its protection; a block the bot placed and dug again is not', () => {
  const bot = spawnBot()
  installSpawnProtection(bot, 'auto')
  // placed, then dug by the bot itself
  for (let i = 0; i < 2; i++) {
    const p = new Vec3(4, 65, 4)
    bot.emit('blockPlaced', at(AIR, p), at(COBBLE, p))
    bot.targetDigBlock = at(COBBLE, p)
    bot.emit('blockUpdate', at(COBBLE, p), at(AIR, p))
    bot.targetDigBlock = null
  }
  assert.strictEqual(spawnProtectionState(bot)?.radius, null)
  refusedPlace(bot, new Vec3(-1, 70, 0))
  refusedPlace(bot, new Vec3(-1, 70, 0))
  assert.strictEqual(spawnProtectionState(bot)?.radius, SPAWN_PROTECTION_RADIUS)
})

test('an op (the server\'s entity event 24 + level) is never under it: no refusal counted; the message says otherwise', () => {
  const bot = spawnBot()
  installSpawnProtection(bot, 'auto')
  bot._client.emit('entity_status', { entityId: bot.entity.id, entityStatus: 28 })
  refusedDig(bot, new Vec3(1, 67, 1))
  refusedDig(bot, new Vec3(1, 67, 1))
  assert.strictEqual(spawnProtectionState(bot)?.radius, null)
  bot.emit('message', message('1, 67, 1'), 'game_info')
  assert.strictEqual(underSpawnProtection(bot, new Vec3(1, 67, 1)), true)
})

test('learnt: a dig under way in the square stopped, a path under way planned again, and a place the client predicted against the refused block put back at once (no ghost block to stand on)', () => {
  const bot = spawnBot()
  const blocks = new Map<string, any>()
  bot.blockAt = (p: Vec3) => blocks.get(p.floored().toString()) ?? at(AIR, p.floored())
  const updates: Array<[string, number]> = []
  bot._updateBlockState = (p: Vec3, stateId: number) => { updates.push([p.toString(), stateId]); blocks.delete(p.toString()) }
  let stopped = 0
  bot.stopDigging = () => { stopped++ }
  let resets = 0
  let settings: any = { exclusionAreasBreak: [], exclusionAreasPlace: [] }
  bot.pathfinder = { isPathing: true, reset: async () => { resets++ }, get defaultMoveSettings () { return settings }, setMoveOptions: (s: any) => { settings = s } }
  installSpawnProtection(bot, 'auto')
  // the pillar's place against (1, 66, 1): the block predicted at (1, 67, 1)
  const ghost = new Vec3(1, 67, 1)
  blocks.set(ghost.toString(), at(COBBLE, ghost))
  bot.emit('blockPlaced', at(AIR, ghost), at(COBBLE, ghost))
  bot.targetDigBlock = at(STONE, new Vec3(2, 66, 0))
  bot.emit('message', message('1, 66, 1'), 'game_info')
  assert.deepStrictEqual(updates, [[ghost.toString(), 0]])
  assert.strictEqual(stopped, 1)
  assert.strictEqual(resets, 1)
})

test('the pathfinder\'s rules: nothing broken in the square nor placed a block out of it once it\'s known, nothing before; added once', () => {
  const bot = spawnBot()
  let settings: any = { exclusionAreasBreak: [], exclusionAreasPlace: [] }
  bot.pathfinder = { get defaultMoveSettings () { return settings }, setMoveOptions: (s: any) => { settings = s } }
  installSpawnProtection(bot, 'auto')
  keepOffSpawnProtection(bot)
  assert.strictEqual(settings.exclusionAreasBreak.length, 1)
  assert.strictEqual(settings.exclusionAreasPlace.length, 1)
  const brk = settings.exclusionAreasBreak[0]
  const place = settings.exclusionAreasPlace[0]
  assert.strictEqual(brk({ position: new Vec3(1, 67, 1) }), 0)
  bot.emit('message', message('1, 67, 1'), 'game_info')
  assert.strictEqual(brk({ position: new Vec3(1, 67, 1) }), SPAWN_PROTECTION_COST)
  assert.strictEqual(brk({ position: new Vec3(17, 67, 1) }), 0)
  assert.strictEqual(place({ position: new Vec3(17, 67, 1) }), SPAWN_PROTECTION_COST)
  assert.strictEqual(place({ position: new Vec3(18, 67, 1) }), 0)
})

test('a dig that sets no targetDigBlock (mineflayer-mouse\'s) told by its diggingCompleted with the block broken, put back twice: the protection', () => {
  const bot = spawnBot()
  installSpawnProtection(bot, 'auto')
  for (let i = 0; i < 2; i++) {
    const p = new Vec3(0, 68, 1)
    bot.emit('diggingCompleted', at(STONE, p))
    bot.emit('blockUpdate', at(AIR, p), at(STONE, p))
  }
  assert.strictEqual(spawnProtectionState(bot)?.radius, SPAWN_PROTECTION_RADIUS)
})

// The skills pass the square over: no dig, no place, no use of a block in it.

/** a bot that knows the square: radius 16 about (0, 64, 0) */
function protectedBot (input: any = {}): any {
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), ...input })
  bot.spawnPoint = new Vec3(0, 64, 0)
  installSpawnProtection(bot, 16)
  return bot
}

test('a dig in the square is refused (REFUSED) before it starts; out of it, dug', async () => {
  const bot = protectedBot()
  let digs = 0
  bot.dig = async () => { digs++ }
  await assert.rejects(dig(bot, { name: 'stone', position: new Vec3(3, 63, 0) } as any), (err: any) => err.reason === 'REFUSED' && /spawn protection/.test(err.message))
  assert.strictEqual(digs, 0)
})

test('nothing placed against a block in the square (REFUSED), nor placed in it by placeBlock', async () => {
  const bot = protectedBot()
  await assert.rejects(placeAgainst(bot, { name: 'stone', position: new Vec3(16, 63, 0) } as any, new Vec3(1, 0, 0)), (err: any) => err.reason === 'REFUSED')
  await assert.rejects(placeBlock(bot, { pos: new Vec3(2, 64, 0), item: 'crafting_table' }), (err: any) => err.reason === 'REFUSED' && /spawn protection/.test(err.message))
  await assert.rejects(placeBlock(bot, { pos: new Vec3(17, 64, 0), item: 'cobblestone', against: new Vec3(16, 64, 0) }), (err: any) => err.reason === 'REFUSED')
})

test('collectBlock breaks no block in the square: one asked for by its place is refused (REFUSED), nothing dug', async () => {
  const bot = protectedBot({ items: [item('stone_pickaxe')] })
  let digs = 0
  bot.dig = async () => { digs++ }
  await assert.rejects(collectBlock(bot, { positions: [new Vec3(2, 63, 0)], pickup: false, anyTool: true }), (err: any) => /spawn protection/.test(err.message))
  assert.strictEqual(digs, 0)
})

test('a crafting table or furnace found in the square is passed over for the nearest out of it (its use is refused), none when there\'s none', () => {
  const bot = protectedBot()
  const inside = bot.blockAt(new Vec3(3, 64, 0))
  const outside = bot.blockAt(new Vec3(-20, 64, 4))
  bot.findBlocks = () => [new Vec3(3, 64, 0), new Vec3(10, 64, 10), new Vec3(-20, 64, 4)]
  assert.deepStrictEqual(usableOutside(bot, inside, 1, 32)?.position, outside.position)
  assert.strictEqual(usableOutside(bot, outside, 1, 32), outside)
  bot.findBlocks = () => [new Vec3(3, 64, 0)]
  assert.strictEqual(usableOutside(bot, inside, 1, 32), null)
})

test('the mine steps leave the square (StepContext.protect: the base\'s box and the square)', () => {
  const bot = protectedBot()
  const inBase = (p: Vec3): boolean => p.x === 40
  const protect = stepProtect(bot, inBase)
  assert.strictEqual(protect(new Vec3(5, 60, -5)), true)
  assert.strictEqual(protect(new Vec3(40, 60, 0)), true)
  assert.strictEqual(protect(new Vec3(30, 60, 0)), false)
  assert.strictEqual(stepProtect(bot, undefined)(new Vec3(16, 60, 16)), true)
})

// Any server's refusals (a claim, a protected region, adventure mode), far from the spawn too: a bot in the browser
// walked into a block whose break was refused, still there, and was teleported back 25 to 82 times every 100 ticks.

test(`a dig refused once anywhere marks its cell: no dig of it for REFUSED_CELL_TICKS, the path under way planned again; a place refused, no place there`, () => {
  const bot = spawnBot()
  let resets = 0
  let settings: any = { exclusionAreasBreak: [], exclusionAreasPlace: [] }
  bot.pathfinder = { isPathing: true, reset: async () => { resets++ }, get defaultMoveSettings () { return settings }, setMoveOptions: (s: any) => { settings = s } }
  installSpawnProtection(bot, 'auto')
  const cell = new Vec3(300, 40, -200)
  refusedDig(bot, cell)
  assert.strictEqual(breakRefused(bot, cell), true)
  assert.strictEqual(placeRefused(bot, cell), false)
  assert.strictEqual(breakRefused(bot, cell.offset(1, 0, 0)), false)
  assert.strictEqual(settings.exclusionAreasBreak[0]({ position: cell }), SPAWN_PROTECTION_COST)
  assert.strictEqual(resets, 1)
  refusedPlace(bot, new Vec3(310, 41, -200))
  assert.strictEqual(placeRefused(bot, new Vec3(310, 41, -200)), true)
  assert.strictEqual(spawnProtectionState(bot)?.radius, null)
  for (let i = 0; i <= REFUSED_CELL_TICKS; i++) bot.emit('physicsTick')
  assert.strictEqual(breakRefused(bot, cell), false)
})

test(`REGION_REFUSALS refusals within REGION_RANGE of each other lately are a protected region (no dig nor place in it for REGION_TICKS); spread out, or an op's, none`, () => {
  const bot = spawnBot()
  installSpawnProtection(bot, 'auto')
  refusedDig(bot, new Vec3(300, 40, -200))
  refusedDig(bot, new Vec3(303, 40, -198))
  assert.strictEqual(inRefusedRegion(bot, new Vec3(301, 60, -199)), false)
  refusedPlace(bot, new Vec3(305, 41, -201))
  // the refusals' square (300..305, -201..-198) about (302, -200) and REGION_MARGIN
  assert.strictEqual(inRefusedRegion(bot, new Vec3(302, 90, -200)), true)
  assert.strictEqual(breakRefused(bot, new Vec3(297, 40, -200)), true)
  assert.strictEqual(breakRefused(bot, new Vec3(308, 40, -200)), false)
  assert.strictEqual(placeRefused(bot, new Vec3(308, 40, -200)), true)
  for (let i = 0; i <= REGION_TICKS; i++) bot.emit('physicsTick')
  assert.strictEqual(inRefusedRegion(bot, new Vec3(302, 90, -200)), false)
  // spread out: none
  const spread = spawnBot()
  installSpawnProtection(spread, 'auto')
  for (const x of [300, 300 + REGION_RANGE + 1, 300 + 2 * (REGION_RANGE + 1)]) refusedDig(spread, new Vec3(x, 40, -200))
  assert.strictEqual(spawnProtectionState(spread)?.regions.length, 0)
  // an op's (an anticheat's refusals): none
  const op = spawnBot()
  installSpawnProtection(op, 'auto')
  op._client.emit('entity_status', { entityId: op.entity.id, entityStatus: 28 })
  for (const x of [300, 301, 302]) refusedDig(op, new Vec3(x, 40, -200))
  assert.strictEqual(spawnProtectionState(op)?.regions.length, 0)
  assert.strictEqual(breakRefused(op, new Vec3(301, 40, -200)), true)
})

// The lasting works (the base, the farm, the pen, the mine's way down) keep out of the square while its radius is
// unknown: the server never tells it, and a base planned at the spawn (build.ts' grid about it) was under it.

test('the lasting works\' square: the default assumed for a bot no op while none is known, none for an op, the option\'s number (0 none), the learnt radius once known', () => {
  const auto = spawnBot()
  installSpawnProtection(auto, 'auto')
  assert.strictEqual(siteSquareRadius(auto), SPAWN_PROTECTION_RADIUS)
  assert.strictEqual(inSiteSquare(auto, new Vec3(16, 0, -16)), true)
  assert.strictEqual(inSiteSquare(auto, new Vec3(17, 0, 0)), false)
  // (the digs aren't kept from it till a refusal says so)
  assert.strictEqual(underSpawnProtection(auto, new Vec3(1, 64, 1)), false)
  auto.emit('message', message('-30, 64, 2'), 'game_info')
  assert.strictEqual(siteSquareRadius(auto), 30)
  const op = spawnBot()
  installSpawnProtection(op, 'auto')
  op._client.emit('entity_status', { entityId: op.entity.id, entityStatus: 28 })
  assert.strictEqual(siteSquareRadius(op), null)
  const none = spawnBot()
  installSpawnProtection(none, 0)
  assert.strictEqual(siteSquareRadius(none), null)
  const set = spawnBot()
  installSpawnProtection(set, 5)
  assert.strictEqual(siteSquareRadius(set), 5)
  set.game.dimension = 'the_nether'
  assert.strictEqual(siteSquareRadius(set), null)
})

test('a home or a base\'s grid at the spawn moved out of the square, past its edge; one out of it already as it is; the site lookups see nothing in it; a base\'s box by it is in it', () => {
  const bot = spawnBot(new Vec3(0, 64, 0))
  installSpawnProtection(bot, 'auto')
  assert.deepStrictEqual(outOfSiteSquare(bot, new Vec3(0, 64, 0), 8), new Vec3(SPAWN_PROTECTION_RADIUS + 9, 64, 0))
  assert.deepStrictEqual(outOfSiteSquare(bot, new Vec3(3, 70, -10), 8), new Vec3(3, 70, -(SPAWN_PROTECTION_RADIUS + 9)))
  const far = new Vec3(60, 64, 60)
  assert.strictEqual(outOfSiteSquare(bot, far, 8), far)
  const lookup = siteLookup(bot, (p: Vec3) => ({ name: 'water', position: p }))
  assert.strictEqual(lookup(new Vec3(17, 63, 0)), null)
  assert.strictEqual(lookup(new Vec3(18, 63, 0))?.name, 'water')
  assert.strictEqual(boxInSiteSquare(bot, { min: { x: 17, y: 40, z: -3 }, max: { x: 25, y: 46, z: 5 } }), true)
  assert.strictEqual(boxInSiteSquare(bot, { min: { x: 18, y: 40, z: -3 }, max: { x: 25, y: 46, z: 5 } }), false)
  assert.strictEqual(boxInSiteSquare(bot, { min: { x: -40, y: 40, z: -40 }, max: { x: -20, y: 46, z: -18 } }), false)
})
