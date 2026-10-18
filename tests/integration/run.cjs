// Integration tests: every *.test.ts under tests/integration/, each against a real server (tests/harness).
require('ts-node/register/transpile-only')

const { readdirSync } = require('node:fs')
const { join } = require('node:path')

for (const name of readdirSync(__dirname).sort()) {
  if (name.endsWith('.test.ts')) require(join(__dirname, name))
}
