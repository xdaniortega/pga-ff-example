// `npm run sim [-- --preset slow|fast] [--fifo] [--max-txs-per-round N] [--block-ms MS] [--slowmo]`: run the local stack in the foreground.
import { blockMsOverride, ConfigError, loadDotEnv, localPreset, parseMaxTxsFlag, parseSimPreset, slowmoRequested } from '../shared/config.ts'
import { error, note, setInternalVisible, step, warn } from '../shared/narrate.ts'
import { startOrAttach } from './index.ts'

async function main() {
  loadDotEnv()
  setInternalVisible(true)
  const argv = process.argv.slice(2)
  // --fifo (local probe tests): keep arrival order instead of PGA ordering. Same as SIM_ORDER=fifo.
  const maxTxs = parseMaxTxsFlag(argv) // --max-txs-per-round N, same as MAX_TXS_PER_ROUND=N (0 = no cap)
  const blockMs = blockMsOverride(argv, process.env) // --block-ms MS beats SIM_BLOCK_MS; invalid -> ConfigError (exit 2)
  const slowmo = slowmoRequested(argv, process.env) // --slowmo / SIM_SLOWMO=1; with a block time -> ConfigError (exit 2)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(blockMs !== undefined ? { SIM_BLOCK_MS: String(blockMs) } : {}),
    ...(slowmo ? { SIM_SLOWMO: '1' } : {}),
    ...(argv.includes('--fifo') ? { SIM_ORDER: 'fifo' } : {}),
    ...(maxTxs !== undefined ? { MAX_TXS_PER_ROUND: maxTxs } : {}),
  }
  const preset = localPreset(parseSimPreset(argv), env)
  const stack = await startOrAttach(preset.local!, preset.chainId, { build: true, ticks: true, signalHandlers: true })
  if (stack.attached) {
    const running = stack.params.ordering
    note(`running simulator ordering: ${running === 'fifo' ? 'FIFO (PGA disabled)' : 'PGA (effective tip, then arrival)'}`)
    const asked = argv.includes('--fifo') || (process.env.SIM_ORDER ?? '').trim() !== ''
    if (asked && running !== preset.local!.ordering) {
      warn(`you requested ${preset.local!.ordering === 'fifo' ? 'FIFO (--fifo / SIM_ORDER=fifo)' : 'PGA (SIM_ORDER)'}, but a simulator is already running with ${running}; the flag is ignored. Stop it and restart to change the ordering.`)
    }
    const askedCap = maxTxs !== undefined || (process.env.MAX_TXS_PER_ROUND ?? '').trim() !== ''
    if (askedCap && stack.params.maxTxsPerRound !== preset.local!.maxTxsPerRound) {
      warn(`you requested a block cap of ${preset.local!.maxTxsPerRound || 'none'}, but the running simulator has ${stack.params.maxTxsPerRound || 'none'}; the flag is ignored. Stop it and restart to change the cap.`)
    }
    const askedBlock = blockMs !== undefined || slowmo
    if (askedBlock && stack.params.blockMs !== preset.local!.blockMs) {
      warn(`you requested a block time of ${preset.local!.blockMs}ms${slowmo ? ' (--slowmo)' : ''}, but the running simulator has ${stack.params.blockMs}ms; the flag is ignored. Stop it and restart to change the block time.`)
    }
    note('Nothing to do: the simulator is already running elsewhere.')
    return
  }
  step('simulator running')
  note('Press Ctrl-C to stop.')
}

main().catch((e) => {
  error(`Error: ${(e as Error).message}`)
  process.exit(e instanceof ConfigError ? 2 : 1)
})
