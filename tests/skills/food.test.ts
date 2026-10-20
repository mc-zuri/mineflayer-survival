import { test } from 'node:test'
import assert from 'node:assert'
import { afterEating, canEat, chooseFood, foodScore } from '../../src/skills/food'
import { bestFoodInInventory } from '../../src/skills/eat'
import { fakeBot, item } from '../reflexes/fakeBot'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const foods = require('minecraft-data')('1.21.11').foodsByName
const items = (...names: string[]): Array<{ name: string }> => names.map(name => ({ name }))
const pick = (names: string[], food: number, saturation = 0, health = 20): string | undefined =>
  chooseFood(items(...names), foods, { food, saturation, health })?.name

test('afterEating caps the food at 20 and the saturation at the new food level (FoodData.eat)', () => {
  assert.deepStrictEqual(afterEating({ food: 10, saturation: 0, health: 20 }, foods.cooked_beef), { food: 18, saturation: 12.8 })
  assert.deepStrictEqual(afterEating({ food: 18, saturation: 5, health: 20 }, foods.cooked_beef), { food: 20, saturation: 17.8 })
  // saturation can't pass the food level
  assert.deepStrictEqual(afterEating({ food: 2, saturation: 0, health: 20 }, foods.golden_carrot), { food: 8, saturation: 8 })
})

test('chooseFood prefers the food that fills hunger and saturation most', () => {
  assert.strictEqual(pick(['bread', 'cooked_beef', 'apple'], 10), 'cooked_beef')
  assert.strictEqual(pick(['bread', 'cooked_porkchop', 'golden_carrot'], 4), 'cooked_porkchop')
  assert.strictEqual(pick(['bread', 'golden_carrot'], 4), 'golden_carrot')
  assert.strictEqual(pick(['cookie', 'bread'], 12), 'bread')
})

test('chooseFood weighs the nutrition wasted past 20', () => {
  // at 19 a cookie (2, 0.4) wastes 1, steak (8, 12.8) wastes 7 but brings saturation: the score says which
  const s = { food: 19, saturation: 19, health: 20 }
  assert.ok(foodScore(s, foods.cookie) > foodScore(s, foods.cooked_beef))
  assert.strictEqual(pick(['cookie', 'cooked_beef'], 19, 19), 'cookie')
})

test('rotten flesh and spider eyes only when starving', () => {
  assert.strictEqual(pick(['rotten_flesh', 'spider_eye'], 10), undefined)
  assert.strictEqual(pick(['rotten_flesh', 'bread'], 6), 'bread')
  assert.strictEqual(pick(['rotten_flesh'], 6), 'rotten_flesh')
  assert.strictEqual(pick(['spider_eye'], 3), 'spider_eye')
  assert.strictEqual(pick(['poisonous_potato', 'pufferfish', 'chicken'], 10), undefined)
  // the starving threshold is configurable
  assert.strictEqual(chooseFood(items('rotten_flesh'), foods, { food: 10, saturation: 0, health: 20 }, { starvingFood: 10 })?.name, 'rotten_flesh')
})

test('golden apples are kept for low health, and then come first', () => {
  assert.strictEqual(pick(['golden_apple'], 10), undefined)
  assert.strictEqual(pick(['golden_apple', 'cooked_beef'], 10), 'cooked_beef')
  assert.strictEqual(pick(['golden_apple', 'cooked_beef'], 10, 0, 6), 'golden_apple')
  // a golden apple can be eaten with a full bar (FoodProperties.canAlwaysEat), steak can't
  assert.strictEqual(pick(['golden_apple', 'cooked_beef'], 20, 5, 6), 'golden_apple')
  assert.strictEqual(pick(['cooked_beef'], 20, 5, 6), undefined)
})

test('chorus fruit is never chosen, nor anything that isn\'t food', () => {
  assert.strictEqual(pick(['chorus_fruit', 'stone', 'diamond_sword'], 2), undefined)
})

test('canEat: with a full bar only the can_always_eat foods (the golden apples, chorus fruit, honey, suspicious stew)', () => {
  const full = { food: 20, saturation: 5, health: 20 }
  for (const name of ['golden_apple', 'enchanted_golden_apple', 'chorus_fruit', 'honey_bottle', 'suspicious_stew']) assert.ok(canEat(full, name), name)
  assert.ok(!canEat(full, 'bread'))
  assert.ok(canEat({ ...full, food: 19 }, 'bread'))
})

test('the ominous bottle (the drop of a patrol captain) is never eaten or drunk, whatever a foods table says (its Bad Omen brings a raid)', () => {
  const state = { food: 2, saturation: 0, health: 4 }
  const foods: any = { ominous_bottle: { name: 'ominous_bottle', foodPoints: 4, saturation: 2 }, bread: { name: 'bread', foodPoints: 5, saturation: 6 } }
  assert.strictEqual(chooseFood([{ name: 'ominous_bottle' }], foods, state), null)
  assert.strictEqual(chooseFood([{ name: 'ominous_bottle' }, { name: 'bread' }], foods, state)?.name, 'bread')
  for (const version of ['1.21.11', '26.3']) {
    const bot = fakeBot({ version, food: 2, health: 4, items: [item('ominous_bottle', 1, undefined, version)] })
    assert.strictEqual(bestFoodInInventory(bot), null, version)
  }
})
