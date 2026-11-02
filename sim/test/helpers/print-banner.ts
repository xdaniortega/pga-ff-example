// Test helper: prints the local banner and one line of every other kind, through the shared printers (no network).
import { localPreset } from '../../../shared/config.ts'
import { error, important, internal, note, plain, result, setInternalVisible, step, yours } from '../../../shared/narrate.ts'
import { printBanner } from '../../banner.ts'

printBanner(localPreset('slow', {}).local!)
setInternalVisible(true)
step('buying 1 ticket')
note('a ticket bought in round N is active in round N+1 only')
important('▶ CHAPTER 1/6: headline bar')
yours('YOUR TX: idx 0')
internal('round 2: drained order')
plain('a table row')
result('PASS', 'Scenario 1: PASS')
result('FAIL', 'Scenario 2: FAIL')
result('INCONCLUSIVE', 'Scenario 3: INCONCLUSIVE')
error('401: no active ticket')
