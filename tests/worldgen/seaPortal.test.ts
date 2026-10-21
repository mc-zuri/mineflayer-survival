// A ruined portal in the sea isn't gone to for its obsidian (seaPortal, read from the seed's biomes): the ls4-26.3
// bot's trip to the one at (64, -400) took it to the sea's floor at y 46, among its magma and the drowned, and it died
// there in three games (t57447; resumed from its diamonds, t57350 and t56755).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SEA_BIOMES, seaPortal } from '../../src/milestones'
import { ruinedPortalCandidates } from '../../src/worldgen/placement'
import { openSeedBiomes } from '../../src/worldgen/seedBiomes'

const SEED = '7327079856905571232'

test('seaPortal: the ls4-26.3 ruined portal at (64, -400) is in the sea, read from the seed; a land one is none', async (t) => {
  const reader = await openSeedBiomes(SEED, '26.3')
  if (reader == null) { t.skip('no seed reader (minecraft-java-worldgen) for 26.3'); return }
  await reader.dispose()
  const near = ruinedPortalCandidates(SEED, { x: 16, z: -15 }).find(c => Math.abs(c.x - 64) <= 16 && Math.abs(c.z + 400) <= 16)
  assert.ok(near != null, 'the candidate at (64, -400)')
  const sea = await seaPortal(SEED, '26.3', near)
  assert.ok(sea != null && SEA_BIOMES.test(sea), String(sea))
  // the land about the game's base (16, -15) isn't sea
  assert.equal(await seaPortal(SEED, '26.3', { x: 8, z: -23 }), null)
})
