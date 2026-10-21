#!/usr/bin/env node
// node tools/rec.cjs <file.rec> ...: a run's recording queried (src/recorder/cli.ts has the options)
require('ts-node/register/transpile-only')

require('../src/recorder/cli.ts').main(process.argv.slice(2)).catch(err => {
  console.error(err)
  process.exit(1)
})
