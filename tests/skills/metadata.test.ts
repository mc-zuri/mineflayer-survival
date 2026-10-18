// Entity metadata indices by name, from each version's minecraft-data metadataKeys: the ones the skills read are where
// the fallbacks say on both versions; 26.3 moved others (the age_locked it added after an ageable mob's baby).
import { test } from 'node:test'
import assert from 'node:assert'
import minecraftData from 'minecraft-data'
import { metadataIndex } from '../../src/skills/combatUtil'
import { CREEPER_IGNITED_INDEX, CREEPER_SWELL_DIR_INDEX } from '../../src/skills/fight'
import { DRAGON_PHASE_METADATA } from '../../src/end/dragon'
import { VERSIONS } from '../versions'

for (const version of VERSIONS) {
  test(`the metadata indices the skills read on ${version}`, () => {
    const bot = { registry: minecraftData(version) } as any
    assert.strictEqual(metadataIndex(bot, 'creeper', 'swell_dir', -1), CREEPER_SWELL_DIR_INDEX)
    assert.strictEqual(metadataIndex(bot, 'creeper', 'is_ignited', -1), CREEPER_IGNITED_INDEX)
    assert.strictEqual(metadataIndex(bot, 'ender_dragon', 'phase', -1), DRAGON_PHASE_METADATA)
    assert.strictEqual(metadataIndex(bot, 'skeleton', 'living_entity_flags', -1), 8)
    assert.strictEqual(metadataIndex(bot, 'blaze', 'flags', -1), 16)
    assert.strictEqual(metadataIndex(bot, 'zombie', 'health', -1), 9)
    assert.strictEqual(metadataIndex(bot, 'cow', 'baby', -1), 16)
    assert.strictEqual(metadataIndex(bot, 'area_effect_cloud', 'radius', -1), 8)
    // Slime.ID_SIZE: after 26.3's baby and age_locked
    assert.strictEqual(metadataIndex(bot, 'slime', 'size', -1), version === '26.3' ? 18 : 16)
  })
}
