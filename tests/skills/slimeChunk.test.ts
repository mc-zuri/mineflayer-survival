// The night's mine in a slime chunk starts on dry ground: a 1.21.11 bot's was started in a lake over the chunk's middle,
// its smelt and craft sank it, the drowning reflex took it up three times and it drowned at (147, 57, -89) (grimls-2).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { dryColumnIn, toDryGroundIn } from '../../src/skills/slimeChunk'
import { fakeBot } from '../reflexes/fakeBot'

/** chunk (9, -6): x 144 to 159, z -96 to -81; a lake (water y 58 to 62) over x 144 to 152, dry stone ground east of it */
const lake = (p: Vec3): string => p.x <= 152 && p.y >= 58 && p.y <= 62 ? 'water' : p.y <= 62 ? 'stone' : 'air'

test('dryColumnIn: the chunk\'s dry column nearest the bot, none in a chunk all lake', () => {
  const lookup = (p: Vec3): any => { const name = lake(p); return { name, boundingBox: name === 'stone' ? 'block' : 'empty' } }
  const dry = dryColumnIn(lookup, 9, -6, new Vec3(147.5, 57, -88.5))
  assert.deepEqual(dry != null ? [dry.x, dry.z] : null, [153, -89])
  const allWater = (p: Vec3): any => ({ name: p.y >= 58 && p.y <= 62 ? 'water' : p.y < 58 ? 'stone' : 'air', boundingBox: p.y < 58 ? 'block' : 'empty' })
  assert.equal(dryColumnIn(allWater, 9, -6, new Vec3(147.5, 57, -88.5)), null)
})

test('toDryGroundIn: on dry ground already, nothing to do', async () => {
  const bot = fakeBot({ position: new Vec3(155.5, 63, -88.5), world: lake })
  assert.equal(await toDryGroundIn(bot, 9, -6), true)
})
