// `npm run feed -- --local|--testnet [--raw] [--reconnect] [--live] [--preset slow|fast]`
// Prints every Fast Feed message decoded, then how long after it the block became visible on RPC.
// --live prints one table per PGA round instead (fast-feed/client/live.ts, fast-feed/README.md "Live view").
// A refusal or close prints the code, its cause and its fix (fast-feed/client/client.ts, table in fast-feed/README.md).
// --reconnect retries with exponential backoff (1s doubling to 30s, with jitter) after 401, 429, 1008, 1011, 1013
// and a lost connection; never after 1003 (client bug) or 426 (not a WebSocket client). Without it the command
// exits non-zero on the first refusal or close.
import { ConfigError, feedApiKey, feedBackoffMaxMs, getPreset, loadDotEnv, resolvePreset, type Preset } from '../../shared/config.ts'
import { colorEnabled, error, note, plain, setInternalVisible, step } from '../../shared/narrate.ts'
import {
  backoffMs,
  closeLines,
  connectFeed,
  decodeFeedMessage,
  FeedRejectedError,
  rejectionLines,
  shouldReconnect,
  type FeedMessageJson,
} from './client.ts'
import { decodeLiveRow, formatHeader, LiveRounds, myAddresses, readHeader, waitBlockVisible } from './live.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Poll the RPC until block n exists; print how long after the feed message that happened. */
async function reportVisibility(preset: Preset, n: number, messageAt: number): Promise<void> {
  const seenAt = await waitBlockVisible(preset.rpcUrl, n)
  if (seenAt === undefined) plain(`    block ${n} not visible on RPC within 60s`)
  else plain(`    block ${n} visible on RPC +${seenAt - messageAt}ms after the feed message`)
}

async function main() {
  loadDotEnv()
  const argv = process.argv.slice(2)
  const preset = getPreset(argv) // throws ConfigError when --local/--testnet is missing or ambiguous
  const raw = argv.includes('--raw')
  const reconnect = argv.includes('--reconnect')
  const live = argv.includes('--live')

  let feedAuthOn = true // testnet: the real feed always needs a ticket
  let localLines: string[] = []
  let roundsPerBlock: number | undefined // local: K of the running stack; testnet: unknown, labels say `round 1`
  let stop = async () => {}
  let closing = false // true once WE started shutting down (Ctrl-C / SIGTERM)
  let client: ReturnType<typeof connectFeed> | undefined
  let liveView: LiveRounds | undefined
  const onSignal = () => {
    closing = true
    void (async () => {
      await client?.close()
      await liveView?.finish()
      await stop()
      process.exit(0)
    })()
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  if (preset.mode === 'local') {
    setInternalVisible(true)
    const { startOrAttach } = await import('../../sim/index.ts') // sim code is local-only
    const stack = await startOrAttach(preset.local!, preset.chainId, { build: true })
    stop = stack.stop
    feedAuthOn = stack.params.feedAuth // the RUNNING stack decides
    roundsPerBlock = stack.params.k
    if (live) localLines = (await import('../../sim/banner.ts')).liveSummaryLines(stack.params)
  } else {
    step(`${preset.name}: ${preset.feedUrl}`)
  }

  note('The Fast Feed shows a tx after it is ordered and before its block is produced.')
  const apiKey = feedApiKey() // never printed
  if (!apiKey && feedAuthOn) {
    await stop()
    throw new Error(
      'FEED_API_KEY is not set, and the feed needs a ticket-backed key. ' +
        `Run \`npm run key:new\`, then \`npm run tickets:buy -- ${preset.mode === 'local' ? '--local' : '--testnet'}\`, then retry. ` +
        '(FEED_AUTH=off opens the local feed for exploration.)',
    )
  }
  const net = preset.mode === 'local' ? '--local' : '--testnet'
  if (live) {
    const header = await readHeader(preset.mode === 'local' ? await resolvePreset(preset) : preset, apiKey, feedAuthOn)
    for (const l of formatHeader(header)) note(l)
    for (const l of localLines) note(l)
    liveView = new LiveRounds({ rpcUrl: preset.rpcUrl, mine: myAddresses(preset), roundsPerBlock, bold: colorEnabled(process.stdout.isTTY) })
  }
  // Decode in arrival order (recovering the sender is async), then hand the row to the live view.
  let decoding: Promise<void> = Promise.resolve()
  const onMessage = (msg: FeedMessageJson, receivedAt: number) => {
    if (liveView) {
      const view = liveView
      decoding = decoding
        .then(async () => view.push(await decodeLiveRow(msg, receivedAt)))
        .catch((e: Error) => error(`error decoding message: ${e.message}`))
      return
    }
    void (async () => {
      const d = await decodeFeedMessage(msg)
      plain(`feed message:`)
      plain(`  block_number: ${d.block_number} (tentative)`)
      plain(`  tx_index:     ${d.tx_index}`)
      plain(`  tx_hash:      ${d.tx_hash}`)
      plain(`  from:         ${d.from}`)
      plain(`  tip:          ${d.tip} wei (effective_gas_price ${d.effective_gas_price} - base_fee ${d.base_fee})`)
      plain(`  status:       ${d.status} (${d.status === 1 ? 'success' : 'reverted'})`)
      if (raw) plain(JSON.stringify(msg))
      await reportVisibility(preset, d.block_number, receivedAt)
    })().catch((e: Error) => error(`error decoding message: ${e.message}`))
  }

  type Outcome =
    | { kind: 'rejected'; status: number; body: string; connected: false }
    | { kind: 'closed'; code: number; reason: string; connected: boolean }
    | { kind: 'failed'; message: string; connected: false }
  /** One connection attempt: resolves when it is refused, fails or closes. */
  const connectOnce = () =>
    new Promise<Outcome>((resolve) => {
      let connected = false
      const c = connectFeed({
        url: preset.feedUrl,
        apiKey,
        onMessage,
        onClose: (code, reason) => resolve({ kind: 'closed', code, reason, connected }),
        onError: (e) => {
          if (connected) error(`feed error: ${e.message}`) // before that, the outcome below reports it once
        },
      })
      client = c
      c.ready.then(
        () => {
          connected = true
          step('connected')
        },
        (e: unknown) => {
          if (e instanceof FeedRejectedError) resolve({ kind: 'rejected', status: e.status, body: e.body, connected: false })
          else resolve({ kind: 'failed', message: (e as Error).message, connected: false })
        },
      )
    })

  let attempt = 0
  for (;;) {
    const o = await connectOnce()
    if (closing) return
    await decoding
    liveView?.flush() // a round that was still collecting prints before the close explanation
    if (o.connected) attempt = 0 // it worked for a while: start the backoff over
    let code: number | undefined
    if (o.kind === 'rejected') {
      for (const l of rejectionLines(o.status, o.body, net)) error(l)
      code = o.status
    } else if (o.kind === 'closed') {
      for (const l of closeLines(o.code, o.reason, `npm run tickets:buy -- ${net}`)) error(l)
      code = o.code
    } else {
      error(`Error: could not connect to the feed: ${o.message}`)
    }
    if (!reconnect || !shouldReconnect(code)) {
      if (reconnect) error('Not reconnecting: retrying cannot fix this.')
      closing = true
      await liveView?.finish()
      await stop()
      process.exit(1)
    }
    const wait = backoffMs(attempt++, Math.random(), 1000, feedBackoffMaxMs())
    step(`reconnecting in ${(wait / 1000).toFixed(1)}s (attempt ${attempt}; Ctrl-C to stop)...`)
    await sleep(wait)
  }
}

main().catch((e) => {
  error(`Error: ${e instanceof ConfigError ? e.message : (e as Error).message}`)
  process.exit(1)
})
