// `npm run pretest`: make sure lib/ and out/ exist before the integration suites deploy from out/.
import { buildContracts } from './build.ts'
import { error } from '../shared/narrate.ts'

try {
  buildContracts()
} catch (e) {
  error(`Error: ${(e as Error).message}`)
  process.exit(1)
}
