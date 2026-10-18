// Unit tests: every *.test.ts under tests/ except the ones that need a server (integration/, e2e/).
require('ts-node/register/transpile-only')

const { readdirSync } = require('node:fs')
const { join } = require('node:path')

const serverDirs = new Set(['integration', 'e2e', 'harness'])

function loadTests (dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!serverDirs.has(entry.name)) loadTests(fullPath)
      continue
    }
    if (entry.name.endsWith('.test.ts')) require(fullPath)
  }
}

loadTests(__dirname)
