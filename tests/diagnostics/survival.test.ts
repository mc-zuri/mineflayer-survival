import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Vec3 } from 'vec3'
import { TaskRunner } from '../../src/core/taskRunner'
import { TaskError } from '../../src/core/errors'
import { WorldMemory } from '../../src/core/memory'
import { Executor } from '../../src/executor/executor'
import { SkillError } from '../../src/skills/errors'
import { Diagnostics, StallWatchdog, causeOf, diagnoseSurvival, plain, type SurvivalReport, type StepFacts } from '../../src/diagnostics'

/* eslint-disable @typescript-eslint/no-var-requires */
const registry = require('minecraft-data')('1.21.11')

test('the watchdog: no progress for stallTicks is a stall, again at twice that; progress starts the count over', () => {
  const w = new StallWatchdog({ stallTicks: 100 })
  w.reset(0)
  assert.equal(w.check(99), null)
  const t = w.check(100)
  assert.deepEqual(t, { rule: 'no_progress', key: '', count: 100, since: 0, tick: 100 })
  // not again each tick: at 200 since the progress
  assert.equal(w.check(150), null)
  assert.equal(w.check(200)?.count, 200)
  w.progress(250, 'more oak_log')
  assert.equal(w.check(349), null)
  assert.equal(w.check(350)?.since, 250)
  // a wait isn't a stall
  w.waiting = 'the night'
  assert.equal(w.check(5000), null)
  w.waiting = null
  assert.equal(w.check(5099), null)
})

test('the watchdog: the same step failing maxRepeats times in a row is a stall, a step done forgets its failures', () => {
  const w = new StallWatchdog({ maxRepeats: 3 })
  w.reset(0)
  assert.equal(w.stepFailed(10, 'smelt:iron_ingot'), null)
  assert.equal(w.stepFailed(20, 'smelt:iron_ingot'), null)
  assert.deepEqual(w.stepFailed(30, 'smelt:iron_ingot'), { rule: 'step_repeat', key: 'smelt:iron_ingot', count: 3, since: 10, tick: 30 })
  // then at 6, not 4 and 5
  assert.equal(w.stepFailed(40, 'smelt:iron_ingot'), null)
  assert.equal(w.stepFailed(50, 'smelt:iron_ingot'), null)
  assert.equal(w.stepFailed(60, 'smelt:iron_ingot')?.count, 6)
  // another step counts on its own
  assert.equal(w.failures('mine:coal'), 0)
  w.stepDone(70, 'smelt:iron_ingot', 0)
  assert.equal(w.failures('smelt:iron_ingot'), 0)
  // a step done with nothing gained isn't progress; with something it is
  assert.equal(w.lastProgress, 0)
  w.stepDone(80, 'mine:coal', 2)
  assert.equal(w.lastProgress, 80)
})

test('the watchdog: maxReplans plans with no progress between them is a stall', () => {
  const w = new StallWatchdog({ maxReplans: 4 })
  w.reset(100)
  for (let i = 0; i < 3; i++) assert.equal(w.replanned(200 + i, 'milestone nether'), null)
  assert.deepEqual(w.replanned(8100, 'milestone nether'), { rule: 'replan_loop', key: 'milestone nether', count: 4, since: 100, tick: 8100 })
  w.progress(9000, 'milestone nether')
  for (let i = 0; i < 3; i++) assert.equal(w.replanned(9100, 'milestone eyes'), null)
  assert.equal(w.replanned(9200, 'milestone eyes')?.since, 9000)
})

/** a report with the work and the bot as given, for the rules */
function report (over: Partial<SurvivalReport> & { inventory?: Array<{ name: string, count: number }> } = {}): SurvivalReport {
  const { inventory, ...rest } = over
  return {
    version: 1,
    kind: 'stall',
    time: '2026-10-19T00:00:00.000Z',
    tick: 9000,
    message: '',
    diagnosis: '',
    work: { milestone: null, plan: null, step: null, tasks: null, waiting: null, lastProgress: { tick: 0, what: 'start' } },
    bot: { username: 'b', version: '1.21.11', dimension: 'overworld', pos: [0, 64, 0], health: 20, food: 20, saturation: 5, xp: { level: 0, points: 0 }, time: { timeOfDay: 1000, day: 0 }, inventory: inventory ?? [], equipment: { hand: null, offhand: null, head: null, chest: null, legs: null, feet: null }, freeSlots: 30 },
    memory: { base: null, chests: [], pois: [], blocks: {}, needed: {}, death: null },
    errors: [],
    movement: [],
    ...rest
  }
}

const smelt: StepFacts = { desc: 'smelt 3 iron_ingot', key: 'smelt:iron_ingot', kind: 'smelt', item: 'iron_ingot', count: 3, needs: [{ name: 'raw_iron', count: 3 }], fuel: [{ name: 'coal', count: 1 }] }
const mine: StepFacts = { desc: 'mine 1 diamond (1 diamond_ore)', key: 'mine:diamond', kind: 'mine', item: 'diamond', count: 1, block: 'diamond_ore', blocks: ['diamond_ore', 'deepslate_diamond_ore'] }
const craft: StepFacts = { desc: 'craft 1 enchanting_table', key: 'craft:enchanting_table', kind: 'craft', item: 'enchanting_table', count: 1, needs: [{ name: 'book', count: 1 }, { name: 'diamond', count: 2 }, { name: 'obsidian', count: 4 }] }

test('diagnosis: a smelt that failed 5 times with no fuel held', () => {
  const r = report({
    trigger: { rule: 'step_repeat', key: 'smelt:iron_ingot', count: 5, since: 1000, tick: 9000 },
    inventory: [{ name: 'raw_iron', count: 3 }],
    errors: [{ tick: 8900, what: smelt.desc, step: smelt, code: 'MISSING_ITEMS', reason: 'MISSING_ITEMS', message: 'MISSING_ITEMS: no fuel for the furnace', n: 2 }]
  })
  assert.equal(diagnoseSurvival(r), 'smelt iron_ingot failed 5× : no fuel reachable')
})

test('diagnosis: no progress on a mine step for a block the memory has none of', () => {
  const r = report({
    trigger: { rule: 'no_progress', key: '', count: 6000, since: 3000, tick: 9000 },
    work: { ...report().work, milestone: { id: 'diamonds', title: 'Diamonds', goals: ['1 diamond_pickaxe'], since: 3000, failures: 0 }, step: { ...mine, index: 0, since: 3000, start: [0, 64, 0], distance: 96 } },
    memory: { ...report().memory!, needed: { diamond_ore: { count: 0, nearest: [] }, deepslate_diamond_ore: { count: 0, nearest: [] } } }
  })
  assert.equal(diagnoseSurvival(r), 'milestone diamonds: no progress in 6000 ticks; mine diamond_ore: no known diamond_ore, explored 96 blocks')
  // one remembered: the rule doesn't hold
  const known = { ...r, memory: { ...r.memory!, needed: { diamond_ore: { count: 1, nearest: [[5, 12, 5] as [number, number, number]] } } } }
  assert.equal(causeOf(known, mine, null), 'no error yet')
})

test('diagnosis: a craft that threw short of an ingredient', () => {
  const r = report({
    kind: 'skill_failed',
    inventory: [{ name: 'book', count: 1 }, { name: 'diamond', count: 2 }, { name: 'obsidian', count: 2 }],
    skill: { name: 'step:craft 1 enchanting_table', step: craft, code: 'MISSING_ITEMS', reason: 'MISSING_ITEMS', message: 'MISSING_ITEMS: no enchanting_table recipe with what the inventory has', window: null, target: null }
  })
  assert.equal(diagnoseSurvival(r), 'craft enchanting_table failed: missing obsidian (have 2/4)')
})

test('diagnosis: a milestone planned again and again with no progress', () => {
  const r = report({
    trigger: { rule: 'replan_loop', key: 'milestone nether', count: 12, since: 1000, tick: 9000 },
    work: { ...report().work, milestone: { id: 'nether', title: 'Nether', goals: [], since: 1000, failures: 3 } }
  })
  assert.equal(diagnoseSurvival(r), 'milestone nether: re-planned 12× in 8000 ticks')
  // with the last failure's cause
  const failed = { ...r, errors: [{ tick: 8000, what: 'mine 4 obsidian (4 obsidian)', step: { ...mine, key: 'mine:obsidian', item: 'obsidian', block: 'obsidian', blocks: ['obsidian'], desc: 'mine 4 obsidian (4 obsidian)' }, code: 'NO_PATH', reason: 'STUCK', message: 'STUCK: no progress', diagnosis: 'enclosed by unbreakable bedrock: no way out' }] }
  assert.equal(diagnoseSurvival(failed), 'milestone nether: re-planned 12× in 8000 ticks; last failure: mine obsidian: no path: enclosed by unbreakable bedrock: no way out')
})

test('plain: a partial result as JSON, items and blocks by name, cut when long', () => {
  const item = { name: 'cobblestone', type: 35, count: 12, nbt: { big: true } }
  assert.deepEqual(plain({ moved: { cobblestone: 3 }, items: [item], at: new Vec3(1, 2, 3) }), { moved: { cobblestone: 3 }, items: [{ name: 'cobblestone', count: 12 }], at: { x: 1, y: 2, z: 3 } })
  assert.deepEqual(plain('x'.repeat(50), 10), { truncated: '"xxxxxxxxx' })
  const loop: any = { a: 1 }
  loop.self = loop
  assert.deepEqual(plain(loop), { a: 1, self: '[circular]' })
})

/** a bot with an inventory, a task runner and a memory (the executor tests' fakeBot) */
function fakeBot (items: Record<string, number> = {}): any {
  const bot: any = new EventEmitter()
  bot.registry = registry
  bot.username = 'diagbot'
  bot.version = '1.21.11'
  bot.health = 20
  bot.food = 20
  const counts = new Map(Object.entries(items))
  const slots = (): any[] => {
    const out: any[] = new Array(46).fill(null)
    let i = 9
    for (const [name, count] of counts) if (count > 0) out[i++] = { name, count, type: registry.itemsByName[name].id, slot: i - 1 }
    return out
  }
  bot.inventory = {
    get slots () { return slots() },
    inventoryStart: 9,
    inventoryEnd: 45,
    items: () => slots().slice(9, 45).filter(s => s != null),
    emptySlotCount: () => 36 - slots().slice(9, 45).filter(s => s != null).length
  }
  bot.give = (name: string, n: number) => counts.set(name, (counts.get(name) ?? 0) + n)
  bot.entity = { position: new Vec3(0, 64, 0) }
  bot.game = { dimension: 'overworld' }
  bot.time = { timeOfDay: 6000, day: 2 }
  bot.survival = { memory: new WorldMemory(), tasks: new TaskRunner(bot) }
  return bot
}

test('the executor tells the diagnostics: a step failing over obtains makes a stall report, the skill a report of its own', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-'))
  try {
    const bot = fakeBot({ iron_pickaxe: 1 })
    const lines: string[] = []
    const diagnostics = new Diagnostics(bot, { dir, log: line => lines.push(line), watchdog: { maxRepeats: 5 } })
    bot.survival.diagnostics = diagnostics
    const ex = new Executor(bot, {
      maxStepFailures: 3,
      runners: { mine: async () => { throw new SkillError('NOT_FOUND', 'no diamond_ore found exploring', { explored: 4 }) } }
    })
    diagnostics.milestoneStarted('diamonds', 'Diamonds', ['1 diamond'])
    // the milestone tried twice: 6 failures of the step in a row
    for (let i = 0; i < 2; i++) await assert.rejects(ex.obtain([{ item: 'diamond', count: 1 }]), /no diamond_ore/)
    const reports = diagnostics.lastReports() as SurvivalReport[]
    const stall = reports.find(r => r.kind === 'stall')
    assert.ok(stall != null, reports.map(r => r.kind).join(', '))
    assert.equal(stall.trigger?.rule, 'step_repeat')
    assert.equal(stall.trigger?.count, 5)
    assert.match(stall.diagnosis, /^mine (deepslate_)?diamond_ore failed 5× : no known (deepslate_)?diamond_ore, explored 0 blocks$/)
    assert.equal(stall.work.milestone?.id, 'diamonds')
    assert.match(stall.work.plan?.steps.join() ?? '', /^mine 1 diamond \(1 (deepslate_)?diamond_ore\)$/)
    assert.equal(stall.work.plan?.n, 2)
    assert.equal(stall.errors.length, 5)
    assert.deepEqual(stall.errors[0].partial, { explored: 4 })
    assert.equal(stall.errors[0].reason, 'NOT_FOUND')
    assert.deepEqual(Object.keys(stall.memory?.needed ?? {}).sort(), ['deepslate_diamond_ore', 'diamond_ore'])
    assert.equal(stall.bot.time?.day, 2)
    // the skill's failures in the same tick: one report, the rest counted on it
    const skills = reports.filter(r => r.kind === 'skill_failed')
    assert.equal(skills.length, 1)
    assert.match(skills[0].skill?.name ?? '', /^step:mine 1 diamond/)
    assert.equal(skills[0].skill?.repeats, 5)
    assert.deepEqual(skills[0].skill?.partial, { explored: 4 })
    assert.match((skills[0].skill?.args as any)?.block, /diamond_ore/)
    assert.match(skills[0].diagnosis, /^mine (deepslate_)?diamond_ore failed: no known/)
    // a log line and a file for each
    assert.equal(lines.length, reports.length)
    for (const line of lines) assert.match(line, /^\[survival\] (stall|skill_failed) report: .+ \(.+\.json\)$/)
    assert.equal(fs.readdirSync(dir).length, reports.length)
    const onDisk = JSON.parse(fs.readFileSync(diagnostics.fileOf(stall)!, 'utf8'))
    assert.equal(onDisk.diagnosis, stall.diagnosis)
    // the summaries for the save
    assert.deepEqual(diagnostics.history.map(h => h.kind), reports.map(r => r.kind))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('no progress for stallTicks while armed is a stall report; nothing while not armed, nor for a death or an abort', async () => {
  const bot = fakeBot({ cobblestone: 3 })
  const diagnostics = new Diagnostics(bot, { dir: null, log: null, watchdog: { stallTicks: 100 } })
  bot.survival.diagnostics = diagnostics
  for (let i = 0; i < 200; i++) bot.emit('physicsTick')
  assert.equal(diagnostics.lastReports().length, 0)
  const disarm = diagnostics.arm()
  for (let i = 0; i < 60; i++) bot.emit('physicsTick')
  // more of an item is progress
  bot.give('cobblestone', 1)
  for (let i = 0; i < 60; i++) bot.emit('physicsTick')
  assert.equal(diagnostics.lastReports().length, 0)
  for (let i = 0; i < 80; i++) bot.emit('physicsTick')
  const [stall] = diagnostics.lastReports() as SurvivalReport[]
  assert.equal(stall?.kind, 'stall')
  assert.equal(stall.diagnosis, 'milestone none: no progress in 100 ticks')
  assert.equal(stall.work.lastProgress.what, 'more cobblestone')
  assert.deepEqual(stall.work.tasks, { current: null, queue: [], reflex: null })
  disarm()
  for (let i = 0; i < 1000; i++) bot.emit('physicsTick')
  assert.equal(diagnostics.lastReports().length, 1)
  // a task that was stopped or died isn't a skill failure
  const ex = new Executor(bot, {})
  await assert.rejects(ex.task('dig', async () => { throw new TaskError('DIED', 'the bot died') }))
  await assert.rejects(ex.task('dig', async () => { throw new TaskError('ABORTED', 'stopped') }))
  assert.equal(diagnostics.lastReports().length, 1)
  await assert.rejects(ex.task('store cobblestone', async () => { throw new SkillError('NO_SPACE', 'the chest is full', { moved: { cobblestone: 2 } }) }))
  const skill = diagnostics.lastReports()[1] as SurvivalReport
  assert.equal(skill.diagnosis, 'store cobblestone failed: inventory full (35 free slots): the chest is full')
})

test('the task runner snapshot marks a preempted task', async () => {
  const bot: any = new EventEmitter()
  const tasks = new TaskRunner(bot)
  let release!: () => void
  const low = tasks.enqueue({ name: 'step:mine', onPreempt: 'resume' }, async (ctx) => {
    if (ctx.attempt === 1) await new Promise((_resolve, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason)))
    await new Promise<void>(resolve => { release = resolve })
  })
  await new Promise(resolve => setImmediate(resolve))
  const high = tasks.enqueue({ name: 'reflex:eat', priority: 50 }, async () => { await new Promise(resolve => setImmediate(resolve)) })
  await new Promise(resolve => setImmediate(resolve))
  const snap = tasks.snapshot()
  assert.equal(snap.current?.name, 'reflex:eat')
  assert.deepEqual(snap.queue, [{ name: 'step:mine', priority: 0, attempt: 1, preempted: true }])
  await high.result
  await new Promise(resolve => setImmediate(resolve))
  release()
  await low.result
})

test('play tells the diagnostics: a milestone that keeps failing is a re-plan stall, with the milestone, its goals and play\'s tick', async () => {
  const { Runner } = await import('../../src/runner')
  const bot = fakeBot()
  bot.isRaining = false
  bot.time = { timeOfDay: 1000 }
  bot.survival.handlers = {}
  bot.survival.advancements = new Set()
  const diagnostics = new Diagnostics(bot, { dir: null, log: null })
  bot.survival.diagnostics = diagnostics
  const runner = new Runner(bot, {
    log: () => {},
    maxFailures: 4,
    watchdog: { maxReplans: 3 },
    handlers: { wood: async () => { bot.emit('physicsTick'); throw new SkillError('NO_PATH', 'no way to the trees') } }
  })
  const result = await runner.play()
  assert.equal(result.reason, 'failed')
  const stalls = diagnostics.lastReports().filter(r => r.kind === 'stall') as SurvivalReport[]
  assert.equal(stalls.length, 1)
  const [stall] = stalls
  assert.equal(stall.trigger?.rule, 'replan_loop')
  assert.equal(stall.work.milestone?.id, 'wood')
  assert.equal(stall.work.milestone?.failures, 3)
  assert.ok((stall.work.milestone?.goals.length ?? 0) > 0)
  assert.equal(stall.tick, 3)
  assert.equal(stall.diagnosis, 'milestone wood: re-planned 3× in 3 ticks; last failure: milestone wood: no path (no way to the trees)')
  // play's clock and the watchdog are off once it stopped
  assert.equal(diagnostics.watching, false)
  assert.equal(diagnostics.clock, null)
})

test('the reports go next to play\'s save (a stuck folder) when nothing chose a dir, and the save keeps their summaries for a resumed run', async () => {
  const { Runner } = await import('../../src/runner')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'save-'))
  try {
    const saveFile = path.join(dir, 'save.json')
    const game = (): any => {
      const bot = fakeBot()
      bot.isRaining = false
      bot.time = { timeOfDay: 1000 }
      bot.survival.handlers = {}
      bot.survival.advancements = new Set()
      bot.survival.diagnostics = new Diagnostics(bot, { log: null })
      return bot
    }
    const saved = process.env.SURVIVAL_STUCK_DIR
    delete process.env.SURVIVAL_STUCK_DIR
    let bot: any
    try {
      bot = game()
    } finally {
      if (saved != null) process.env.SURVIVAL_STUCK_DIR = saved
    }
    const fail = async (): Promise<void> => { bot.emit('physicsTick'); throw new SkillError('NO_PATH', 'no way to the trees') }
    await new Runner(bot, { saveFile, log: () => {}, maxFailures: 2, watchdog: { maxReplans: 2 }, handlers: { wood: fail } }).play()
    const diagnostics: Diagnostics = bot.survival.diagnostics
    assert.equal(diagnostics.dir, path.join(dir, 'stuck'))
    const [stall] = diagnostics.lastRecords()
    assert.ok(stall.file != null && fs.existsSync(stall.file) && path.dirname(stall.file) === path.join(dir, 'stuck'))
    const save = JSON.parse(fs.readFileSync(saveFile, 'utf8'))
    assert.deepEqual(save.reports.map((r: any) => [r.kind, r.file]), [['stall', stall.file]])
    // resumed: the earlier run's reports are in the history, before this run's
    const bot2 = game()
    bot = bot2
    const runner2 = new Runner(bot2, { saveFile, log: () => {}, until: 'wood' })
    runner2.load()
    assert.deepEqual(bot2.survival.diagnostics.history.map((r: any) => r.diagnosis), [stall.report.diagnosis])
    // an explicit null is nowhere
    const quiet = fakeBot()
    quiet.survival.diagnostics = new Diagnostics(quiet, { dir: null, log: null })
    new Runner(quiet, { saveFile, log: () => {} })
    assert.equal(quiet.survival.diagnostics.dir, null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
