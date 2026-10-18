// The foods come from each version's minecraft-data (foods.json): nutrition and saturation as the registry has them,
// without the fish buckets (a food component, no consumable one), with what the package adds (harmful).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import minecraftData from 'minecraft-data'
import { foodInfo, foodsOf, HARMFUL_FOODS, isSafeFood, NOT_EATEN } from '../../src/core/items'
import { chooseFood } from '../../src/skills/food'
import { VERSIONS } from '../versions'

for (const version of VERSIONS) {
  test(`the food lookup is ${version}'s registry.foods, less the fish buckets`, () => {
    const registry = minecraftData(version)
    const foods = foodsOf(registry)
    for (const food of registry.foodsArray) {
      if (NOT_EATEN.has(food.name)) {
        assert.equal(foodInfo(registry, food.name), null, food.name)
        continue
      }
      assert.deepEqual([foods[food.name].nutrition, foods[food.name].saturation], [food.foodPoints, food.saturation], food.name)
      assert.equal(foods[food.name].harmful === true, HARMFUL_FOODS.includes(food.name), food.name)
    }
    assert.equal(Object.keys(foods).length, registry.foodsArray.length - NOT_EATEN.size)
    for (const bucket of NOT_EATEN) assert.ok(registry.foodsByName[bucket] != null, `${bucket} is one of minecraft-data's foods`)
    assert.deepEqual(foodInfo(registry, 'cooked_beef'), { nutrition: 8, saturation: 12.8 })
    assert.ok(isSafeFood(registry, 'bread'))
    assert.ok(!isSafeFood(registry, 'spider_eye'))
    assert.ok(!isSafeFood(registry, 'stone'))
  })

  test(`chooseFood never picks a fish bucket (${version})`, () => {
    const registry = minecraftData(version)
    const pick = chooseFood([{ name: 'cod_bucket' }, { name: 'tropical_fish_bucket' }], registry.foodsByName as any, { food: 2, saturation: 0, health: 20 })
    assert.equal(pick, null)
  })
}
