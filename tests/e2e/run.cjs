// pnpm e2e [--seed <s>] ...: the whole game under lockstep (tests/e2e/e2e.ts has the options)
require('ts-node/register/transpile-only')

process.env.E2E_MAIN = '1'
require('./e2e.ts')
