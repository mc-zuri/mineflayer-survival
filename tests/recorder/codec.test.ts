import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { ByteReader, ByteWriter, joinTemplate, readValue, splitTemplate, unzigzag, writeValue, zigzag } from '../../src/recorder/codec'

test('varints and zigzag round-trip any safe integer; a small one takes a byte', () => {
  const w = new ByteWriter(4)
  const values = [0, 1, 127, 128, 300, 2 ** 31 - 1, 2 ** 31, 2 ** 40 + 5, Number.MAX_SAFE_INTEGER]
  for (const v of values) w.varint(v)
  const signed = [0, -1, 1, -64, 63, -65, -(2 ** 33), 2 ** 33, -(2 ** 51)]
  for (const v of signed) w.zigzag(v)
  const r = new ByteReader(w.view())
  for (const v of values) assert.equal(r.varint(), v)
  for (const v of signed) assert.equal(r.zigzag(), v)
  assert.equal(r.left, 0)
  assert.deepEqual([0, -1, 1, -2].map(zigzag), [0, 1, 2, 3])
  assert.equal(unzigzag(zigzag(-12345)), -12345)
  const one = new ByteWriter()
  one.zigzag(-50)
  assert.equal(one.length, 1)
})

test('strings: utf8 with their length, a long one\'s length taking two bytes', () => {
  const w = new ByteWriter(2)
  const long = 'é'.repeat(200)
  for (const s of ['', 'zombie', 'смерть ☠', long]) w.str(s)
  const r = new ByteReader(w.view())
  for (const s of ['', 'zombie', 'смерть ☠', long]) assert.equal(r.str(), s)
})

test('a line as its template and numbers comes back as it was; the same kind of line has the same template', () => {
  const lines = [
    'milestone wood reached at tick 1234 (5.2 s)',
    'died at -15 63 207',
    'food t223105 14 2.50 19.0 15',
    'version 1.21.11, seed 671229120248951486 (too many digits kept in the text)',
    'leading zeros 007 and -0 and 0.05 and 3-5 ranges',
    'no numbers at all',
    'a \u0000 placeholder in the line 42',
    ''
  ]
  for (const line of lines) {
    const { template, numbers } = splitTemplate(line)
    assert.equal(joinTemplate(template, numbers), line, line)
  }
  assert.equal(splitTemplate('milestone wood reached at tick 1234 (5.2 s)').template, splitTemplate('milestone wood reached at tick 99 (0.1 s)').template)
  assert.deepEqual(splitTemplate('a \u0000 placeholder 42').numbers, [])
  assert.match(splitTemplate('seed 671229120248951486').template, /671229120248951486/)
})

test('a value of no fixed shape: a Vec3 as {x, y, z}, bigints, short bytes kept, long ones as their length, no functions', () => {
  const strings: string[] = []
  const table = new Map<string, number>()
  const out = { ref: (s: string) => { let id = table.get(s); if (id == null) { id = strings.length; strings.push(s); table.set(s, id) } return id } }
  const w = new ByteWriter()
  const big = new Uint8Array(1000)
  const value = { pos: new Vec3(1.5, -60, 3), id: 12345678901234567890n, short: new Uint8Array([1, 2, 3]), chunk: big, f: () => 1, list: [1, 'two', null, true, 0.1, 2 ** 60], map: new Map([['a', 1]]), err: new Error('boom'), nested: { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } } }
  writeValue(w, value, out)
  const back = readValue(new ByteReader(w.view()), strings) as any
  assert.deepEqual(back.pos, { x: 1.5, y: -60, z: 3 })
  assert.equal(back.id, 12345678901234567890n)
  assert.deepEqual([...back.short], [1, 2, 3])
  assert.deepEqual(back.chunk, { bytes: 1000 })
  assert.equal('f' in back, false)
  assert.deepEqual(back.list, [1, 'two', null, true, 0.1, 2 ** 60])
  assert.deepEqual(back.map, { a: 1 })
  assert.deepEqual(back.err, { name: 'Error', message: 'boom' })
  assert.equal(back.nested.a.b.c.d.e, '…')
  // (inline strings, the header's)
  const h = new ByteWriter()
  writeValue(h, { mcVersion: '1.21.11', n: 1 }, { ref: () => null })
  assert.deepEqual(readValue(new ByteReader(h.view()), []), { mcVersion: '1.21.11', n: 1 })
})
