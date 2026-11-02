# The local simulator: what `--local` models

Not production. `--local` is a teaching model of Arbitrum's sequencer built from Anvil, a mock sequencer and a mock Fast Feed. This page is the **single place** where each difference from Nitro is stated, with its reason. Other docs link here instead of repeating it. Every value that differs from Arbitrum One is also printed by the banner (`npm run sim`, and any command that starts or attaches to the stack), taken from `shared/config.ts`.

Anything marked `ASSUMPTION:` is a choice of this simulator that the Arbitrum docs do not specify; the same marker is in the code.

**Where the code is.** `sim/cli.ts` is `npm run sim`; `sim/index.ts` starts the stack in-process or attaches to a running one (the starting process owns Anvil and kills it on exit). `sim/chain.ts` spawns Anvil (`--no-mining --order fifo`, internal on :8545); `sim/rpc.ts` is the JSON-RPC proxy on :8547 that every client talks to; `sim/sequencer.ts` is the round loop, applying the pure ordering in `pga/rules/pga-core.ts`; `sim/blocks.ts` holds the round and block arithmetic and the read gate; `fast-feed/mock/` is the mock feed (:9642) and its ticket check; `sim/deploy.ts` deploys USDGTest, the Tickets contract and `Race`; `sim/fund.ts` funds wallets; `sim/banner.ts` prints the banner; `sim/traffic.ts` is the background load.

## Commands and environment

```bash
npm run sim [-- --preset slow|fast] [--slowmo] [--block-ms MS] [--fifo] [--max-txs-per-round N]
```

The simulator runs in the foreground and prints the banner, the deployed addresses and each round's queue and drained order; Ctrl-C stops it, Anvil included. Commands that start their own stack read the same settings from environment variables (a flag beats its variable).

| Flag | Variable | Meaning |
| --- | --- | --- |
| `--preset slow\|fast` | `SIM_PRESET` | Block time 2000ms (default) or 250ms. |
| `--block-ms MS` | `SIM_BLOCK_MS` | Block time override ([below](#pga-parameters)). |
| `--slowmo` | `SIM_SLOWMO=1` | Arbitrum One's timing x100 ([below](#k-rounds-per-block)). |
| `--fifo` | `SIM_ORDER=fifo` | Arrival order instead of PGA ([FIFO mode](#fifo-mode)). |
| `--max-txs-per-round N` | `MAX_TXS_PER_ROUND` | The block-full stand-in ([below](#block-full-stand-in-max_txs_per_round)). |
| | `TICKET_ROUND_SECONDS` | Ticket round length ([below](#ticket-round-adaptive)). |
| | `GAP_HOLD_ROUNDS` | How long a nonce-gapped tx is held ([below](#the-gap-hold)). |
| | `BLOCK_PUBLISH_DELAY_MS` | The block-reveal delay ([below](#block-reveal-gating)). |
| | `FEED_AUTH=off` | Open feed, no ticket check ([fast-feed/README.md](../fast-feed/README.md#parameters)). |
| | `SIM_RPC_PORT`, `SIM_FEED_PORT`, `SIM_ANVIL_PORT` | Ports ([docs/setup.md](../docs/setup.md#port-conflicts)). |

Other commands (`feed`, `tickets:*`, `pga`, `race`, `demo`) start the stack themselves, or attach to a running `npm run sim`; `tickets:*` and `traffic` only attach (they need a running `npm run sim`). Their guides: [fast-feed](../fast-feed/README.md), [pga](../pga/README.md), [combo](../combo/README.md).

## PGA parameters

| Parameter | Arbitrum One | `--local` slow (default) | `--local --preset fast` | Where |
| --- | --- | --- | --- | --- |
| Block time B | 250ms | 2000ms | 250ms | banner `block =` |
| Rounds per block K | 2 | 2 | 2 | banner `K =` |
| Round = B/K | 125ms | 1000ms | 125ms | banner `round =` |
| Block cap | 32 Mgas or 95,000 bytes of calldata per block | none, or `MAX_TXS_PER_ROUND` txs | same | [below](#block-full-stand-in-max_txs_per_round) |
| Boost per round | p/(2K) | p/(2K) | p/(2K) | [below](#the-boost) |

The slow preset exists so a human can watch a round happen. `--preset slow|fast` or `SIM_PRESET` choose it, and only the command that starts the simulator uses it. Integration tests use the slow preset. At the fast preset's 125ms rounds, a batch of txs can split across rounds (or blocks); the demos, the PGA bot and the probe then report it honestly as inconclusive (exit 3) rather than as a pass or a fail, so the demos are reliable only on the slow preset.

`--block-ms <ms>` (or `SIM_BLOCK_MS`) overrides B of the chosen preset; K stays 2, so the round is B/2. It must be an even whole number from 250 (Arbitrum One's own block time) to 600000 (even, so that round = B/2 is a whole number of ms), otherwise the command exits 2 with a one-line explanation. The flag beats the env var, which beats the preset. `npm run sim -- --block-ms 20000` gives 10s rounds, slow enough to watch a transaction arrive mid-round ([demo 4](../pga/README.md#demo-4-a-late-bigger-tip-slots-in)). The banner prints `block = 20000ms, round = 10000ms (Arbitrum One: 250ms, 125ms)` and `sim_info` serves the values; commands that attach read them from the running stack. A command that starts its own stack must be given the same value (flag on `npm run sim`, env var elsewhere).

## Ticket round (adaptive)

On Arbitrum One a ticket round lasts 24 hours. Locally it is `max(30s, 4 x B)`: 30s with the default blocks, so a ticket expires within about a minute and `1008` can be watched. A purchase or renewal becomes visible only after its block closes, so with slow blocks a 30s round would be missed: with `--slowmo` (B = 25s) the round is raised to 100s and the banner prints `NOTE: ticket round adapted from 30s to 100s so a purchase or renewal (visible only after its 25s block closes) has time to land in its round`. `TICKET_ROUND_SECONDS` overrides the rule (tests use a few seconds); a value below 4 x B prints a `WARNING:` line that a purchase may miss its round. The banner prints the value in use and `sim_info` serves it. Used by: [tickets timing](../fast-feed/README.md#timing-buy-in-round-n-active-in-round-n1-only).

## K rounds per block

`ASSUMPTION:` K = 2 PGA rounds share one local Anvil block, like on Arbitrum One, in every preset (slow: B 2000ms, two 1000ms rounds; fast: B 250ms, two 125ms rounds, as on Arbitrum One; `--block-ms` changes B and the round stays B/2). A feed message carries `block_number` N and `pga_round` 1 or 2, so **"the same round" is the pair (`block_number`, `pga_round`)**, never the block alone: two txs in one block can be in different rounds, and round 1's txs are final before round 2 starts. `tx_index` counts block-wide, so a tx's position within its round is its `tx_index` minus the txs of earlier rounds of the block; the live view labels it `index 0 of round 2`. A block exists only when one of its rounds has txs, so block numbers are dense; a round with an empty waiting list, or whose every tx Anvil rejects at submit, adds nothing. Used by: the [PGA demos](../pga/README.md) (their "same round" verdicts), the [live view](../fast-feed/README.md#live-view), the [testnet probe](../pga/README.md#testnet-probe) (on a testnet only the block is known).

`npm run sim -- --slowmo` (or `SIM_SLOWMO=1`) runs Arbitrum One's 250ms block and its two 125ms rounds slowed down 100 times: B = 25000ms, K = 2, rounds of 12.5s. It conflicts with `--block-ms` / `SIM_BLOCK_MS` (exit 2). The banner says `slow motion ×100: round 12.5s (Arbitrum One: 125ms), block 25s (Arbitrum One: 250ms), 2 rounds per block`; every other preset says `block = 2000ms, K = 2 rounds of B/2 = 1000ms   (Arbitrum One: 250ms, two 125ms rounds)`; both add an indented line `transactions published in round 1 are final before round 2 starts; round 2 can only add after them.`

How it works (snapshot and re-mine): round 1 mines the block on Anvil provisionally, with an Anvil snapshot taken right before, and its feed messages (`block_number` N, `pga_round` 1) go out at once while block N is still hidden on the RPC. At each later round the sequencer reverts to the snapshot, drops Anvil's pool, resubmits the earlier rounds' txs followed by this round's, in that order, and mines block N again with the same timestamp and pinned base fee. The new round's feed messages (`pga_round` 2, the same `block_number`, `tx_index` continuing) are published after that, and block N becomes visible on the RPC `BLOCK_PUBLISH_DELAY_MS` after the final mine. Earlier rounds' txs are final: a later round can only add after them, so a higher tip in round 2 cannot overtake them. Re-executed txs are deterministic (Anvil keeps the same block number, timestamp and prevrandao), so every receipt published on the feed equals the final mined receipt. The sequencer checks this on every re-mine and prints `[sequencer] FEED RECEIPT MISMATCH ...` if it ever fails; `sim_info.receiptMismatches` and `sim_blockInfo.receiptMismatches` count the mismatches (must be 0). If a re-mine fails, the sequencer clears Anvil's pool and forgets the block's txs (their senders must resend), so a stale pool tx can never be mined or published twice.

The read gate: between `evm_revert` and the end of the final mine Anvil briefly shows a state that never existed on the feed, so every Anvil caller except the sequencer (the RPC proxy, including `eth_sendRawTransaction` checks, and the feed's ticket auth) waits on a gate for that window (tens of ms). Filters and subscriptions (`eth_newFilter`, `eth_subscribe`) are NOT gated. State reads at `latest` between the rounds already see round 1's effects (the same documented assumption as always), which is why a tx that depends on round 1 works in round 2.

`ASSUMPTION:` `MAX_TXS_PER_ROUND` is a per-round cap, so a block holds at most K times the cap (Arbitrum's block-full rule applies to the whole block). `ASSUMPTION:` all rounds of a block share one timestamp T (as on Arbitrum a block has one timestamp): the first round fixes `max(chain-clock seconds, parent timestamp)` (the chain clock is the wall clock unless the simulator was [paused or skipped](#pausing-and-skipping-the-clock)). So a round-2 tx runs with a `block.timestamp` up to one round older than the wall clock: near a ticket-round boundary a purchase can count for the earlier ticket round. Local-only RPC: `sim_msUntilNextBlock`, and `sim_blockInfo` (`block` open or next, `round` 1..K, `roundStartMs`, `blockStartMs`, `roundLeftMs`, `blockElapsedMs`, `paused`, `heldAt`, `k`, `roundMs`, `blockMs`, `receiptMismatches`); `sim_boostTrace`'s included entry carries `block` and `pgaRound`. `sim_arrivals(block, round)` returns `[{hash, from, arrivedAtMs, tipWei, txIndex}]` for the txs ordered in that round (`arrivedAtMs` = wall-clock ms the sequencer received the tx, `tipWei` a 0x quantity, `txIndex` the block-wide `tx_index`), in `tx_index` order; it keeps the last 32 blocks and answers `[]` for anything older or unknown. `ASSUMPTION:` Arbitrum does not publish arrival times: this is simulator-only data, used by the demo's chapter 4 to show the order a first-come-first-served sequencer would have used.

## Pausing and skipping the clock

`ASSUMPTION:` (local only; Arbitrum never pauses) the simulator can freeze its clock and skip it forward. The demo uses this so that `--pause` prompts cost no ticket time and chapter 3 does not make the room wait for the ticket to activate. It keeps two clocks, both derived from the wall clock:

- **Sim time** = wall clock minus the time spent paused. It drives the round schedule (rounds tick at `t0 + i x roundMs` of sim time), the block reveal times and `sim_msUntilNextRound` / `sim_msUntilNextBlock`. While paused it stands still.
- **Chain time** = sim time plus the forward skips. It is the time the chain sees: block timestamps, the `blockOverrides.time` of `eth_call` / `eth_estimateGas` at `latest`, the feed's ticket check and its round-rollover timer, and so the Tickets round. Clients compare ticket times with chain time (`shared/clock.ts`: wall clock plus the offset read from `sim_clock`; 0 on Arbitrum).

Wall-clock times stay wall-clock: a tx's `arrivedAtMs` (`sim_arrivals`), a feed message's `timestamp_ms` (order time) and a client's `receivedAt`. So `blockInfo`'s `roundStartMs` / `blockStartMs` are wall-clock instants, and its `roundLeftMs` is the figure to use for "how much of this round is left" (it stands still while paused).

A pause happens only between round ticks, never inside a round (the read gate and the snapshot / re-mine are untouched), and the proxy keeps accepting txs while paused: they wait in the queue. A block that was open when the pause started (round 1 published) stays open and is not revealed; after the resume its round 2 comes one round-length later in sim time, as if nothing had happened, in the same block with the same timestamp T.

| RPC (local only) | Meaning |
| --- | --- |
| `sim_pause({holder, at: "now"\|"afterRound1", leaseMs = 15000, heartbeat?})` | Freeze. `now` answers once a round that is executing has finished. `afterRound1` arms a hold that pauses right after the round-1 publish that opened a block and records `heldAt: {block, round: 2}`. The same holder again with `at: "now"` is idempotent while paused (it only refreshes the lease and starts no second pause). With `heartbeat: true` the call is a lease-only heartbeat: it extends the lease of a hold that exists (paused or armed) and never starts a pause or turns an armed `afterRound1` hold into one; with no hold (for example one that arrives after the resume) it does nothing. Another holder gets error -32000 `paused by <holder>`. `leaseMs` is at most 60000: the lease is wall time, and when it runs out the simulator resumes by itself (`PAUSE LEASE EXPIRED: resuming`), so a dead demo never leaves it frozen. |
| `sim_resume({holder})` | Idempotent (`resumed: false` when not paused). Returns `{resumed, pausedMs, chainNowMs}`. A different holder is refused. |
| `sim_skipTo({toSec, holder})` | Move the chain clock forward to `toSec` (forward only; a target already reached is a no-op; at most one ticket round + 60 s ahead). Applied only while no block is open, otherwise it stays pending until the open block's last round is mined. Returns `{status: "applied"\|"pending", ...sim_clock}` without blocking; poll `sim_clock`. |
| `sim_clock` | `{paused, holder, armed, heldAt, leaseLeftMs, pausedTotalMs, skippedMs, chainNowMs, pendingSkip}`; also in `sim_info`. `sim_blockInfo` adds `paused`, `heldAt`, `roundLeftMs` and `blockElapsedMs`. |

`npm run sim` logs `[sequencer] PAUSED by <holder> (block X round 2 held | between rounds; ticket round N, Ns left)`, `RESUMED after Ns (chain clock now Ms behind wall time)`, `CLOCK SKIP +Ns -> ticket round N, Ms left` and, always visible, `PAUSE LEASE EXPIRED: resuming`. A demo that started the simulator itself does not print the PAUSED / RESUMED / CLOCK SKIP lines (the demo shows no `[sequencer]` line in any chapter, and its clock skip is silent). A command that attaches to a simulator whose chain clock differs from the wall clock prints the lag once. `npm run traffic` follows `sim_clock`, so the background load stops and restarts with the simulator.

The demo's use: every `--pause` Enter prompt (the chapter prompts) holds the simulator frozen, with `heartbeat: true` calls every lease/3, until Enter; chapter 4's own prompt runs inside a hold armed with `at: "afterRound1"` (the block's round 2 is held open while the demo sends its competitors and your tx, then `sim_resume`); one `NOTE:` explains it the first time. Exception: while the demo's own background ticket purchase (mint, approve, deposit, purchase, then its renewal) is in flight the prompts do not freeze the simulator, because a frozen simulator mines nothing; a prompt that opened unfrozen freezes from the moment your ticket purchase and its renewal have settled, while it is still waiting. If the pause is refused (another holder) or the RPC is missing it prints a `NOTE:` and falls back to the old behaviour (the simulator keeps running and the demo renews the ticket after the pause). The skip to the ticket's activation time is silent (no `NOTE:`): the demo starts it as soon as the ticket purchase lands, when more than 1 s of the activation wait remains, and only on a simulator the demo started itself; an attached simulator is never skipped and the demo waits up to one ticket round. What remains on an owned simulator is the purchase landing, which needs about 4 mined blocks and cannot be skipped. Timing figures (chapter 4's timing table and the `FF lead` column) leave the paused time out.

## Block-reveal gating

A new block is hidden on the mock RPC (block number, blocks, receipts, transactions, logs) until the block is final (its last round, round K, is mined at a block boundary, a multiple of B since the stack started) plus `BLOCK_PUBLISH_DELAY_MS` (default 50ms; Arbitrum One: none, a block is visible when it is produced). The feed message is published before that, which makes "the feed announces a tx before its block is visible" observable. State reads at `latest` (`eth_call`, balances, estimates) are not gated, and filter methods are not gated. Used by: [fast-feed/README.md](../fast-feed/README.md) (the lead between a feed message and its block). Tests assert the order, never the size of the lead.

## The pinned base fee

`ASSUMPTION:` the base fee is constant at 0.01 gwei (the Arbitrum One floor; it moves with load there). Anvil's `--base-fee` and `anvil_setNextBlockBaseFeePerGas` pin it every block. Effective tips are `effectiveGasPrice - baseFee`, so the tips the tools print are exact. Used by: [the effective-tip examples](../pga/README.md#which-tip-the-effective-tip).

## Effective tip corner cases

`ASSUMPTION:` a legacy or type-1 tx's `gasPrice` counts as both `maxFeePerGas` and `maxPriorityFeePerGas`, so its tip is `gasPrice - baseFee`. A `maxFeePerGas` below the base fee gives a negative headroom; the tip is clamped to 0.

## `timestamp_ms` = order time

`ASSUMPTION:` a feed message's `timestamp_ms` is the moment the round was ordered, taken before Anvil executes it (the docs say only "when the Sequencer created the message"). So a client's receive time minus `timestamp_ms` is always above 0 and includes the mock's execution time. Used by: the timing line of the [live view](../fast-feed/README.md#live-view).

## `gas_used_for_l1 = 0`

`ASSUMPTION:` `gas_used_for_l1` is always 0: there is no L1 to pay for. The mock also emits receipt quantities as JSON numbers (the docs do not give the types); the feed client accepts numbers, decimal strings and hex. Used by: [fast-feed/README.md](../fast-feed/README.md).

## Block-full stand-in: `MAX_TXS_PER_ROUND`

"The transfer ends when the queue empties, the block fills, or the round runs out of time. Anything still queued waits for the next round." Without a cap the queue always empties, so only a gap-held tx can wait and be boosted. `MAX_TXS_PER_ROUND=N` (or `npm run sim -- --max-txs-per-round N`; default 0 = no cap) caps how many txs a round (half a local block) may include. The rest stay waiting for the next round.

`ASSUMPTION (simplification):` on Arbitrum One a block closes at 32 Mgas or 95,000 bytes of calldata, whichever comes first, so the real cap depends on what the txs cost. A tx **count** is a stand-in that makes the effect easy to produce and to read. Without a cap the banner prints `LOCAL: no block-full limit (...)`, so the difference is never silent. With one it prints `LOCAL: block-full stand-in = 3 txs per round (Arbitrum One: 32 Mgas / 95 kB calldata per block)`, and `sim_info.maxTxsPerRound` serves it (the bot reads it). The third end condition, "the round runs out of time", is not modelled: a local round is drained whole. Used by: the [flood scenario](../pga/README.md#run-the-flood-scenario).

## The boost

"At the end of every round in which the priority queue holds transactions, each transaction still waiting gains a priority boost of `p / (2K)`. Here `p` is the priority of the last transaction the previous round included, or zero if that round included none." The boost moves a tx's position in the queue and nothing else; it never changes the fee it pays, and it compounds across rounds. The queue key is `effective tip + accumulated boost`, and ties still break on the original arrival time ([docs](https://docs.arbitrum.io/how-arbitrum-works/priority-gas-auction/pga)). Our reading, where the docs are silent:

- `ASSUMPTION:` `p` is the queue priority (effective tip plus any boost it has gathered) of the **last tx the round just ended included**. A round that included no tx gives p = 0, and adds nothing.
- `ASSUMPTION:` the boost is added once per round to **every** tx still waiting at the end of that round, whether it waits because the block filled or because it is held for a nonce gap. This is the simplest consistent rule (waiting = boosted). It also means that, without a cap, only a gap-held tx can ever carry over and be boosted.
- The boost is integer wei, `p / (2K)` rounded down (exact for the 0.01 gwei tip the scenario uses).
- Side effect of boosting gap-held txs: a gap-held N+1 accumulates up to `GAP_HOLD_ROUNDS` x p/(2K) while it waits, and can then outrank paying txs once N arrives (it is still placed after N).
- Nonce gating is unchanged. N+1 joins the queue only after N was included, so a boosted N+1 is still never placed before its N. A tx that is only deferred by the cap behind its sender's N waits, and is boosted, like any other.
- Only the ordering key changes. Fees come from Anvil executing the tx with its own fields, which a test checks through the receipt (`effectiveGasPrice - baseFee`).

The sequencer narrates each round: queue size, included count, p, `boost: +p/(2K) = ...`, and the top waiting txs plus any zero-tip tx with their boosted priority. The local-only RPC method `sim_boostTrace(hash)` returns a tx's queue priority round by round. Used by: [part 3 of the PGA doc](../pga/README.md#pga-part-3-anti-starvation).

## The gap hold

`ASSUMPTION:` the docs do not say what happens to a tx whose nonce is above its sender's next nonce with no predecessor waiting. The simulator holds it in the waiting list (it is never sent to Anvil), prints `held: ... waiting for nonce N` each round, and drops it with a visible line after `GAP_HOLD_ROUNDS` rounds (default 10; a positive integer, 0 is rejected). While it is held, `eth_getTransactionCount` still reports the nonce that fills the gap. A tx that Anvil accepts but leaves out of the block (for example when the balance no longer covers it) is dropped at once and evicted from Anvil's pool. Used by: [nonce gaps](../pga/README.md#one-known-limit-nonce-gaps).

## Duplicate-nonce refusal

`ASSUMPTION:` a second tx with the same sender and nonce as one already queued is refused at submit (`a transaction from <sender> with nonce N is already queued`) and never replaced; a real node would replace it for a sufficiently higher fee. Without the refusal, Anvil would reject the extra at round time and a sender that sent several txs concurrently (all reading the same pending nonce) would wait forever for a receipt. Resubmitting the identical raw tx is idempotent. Used by: [the demos](../pga/README.md): send one at a time or use distinct nonces.

## `eth_sendTransaction` is rejected

The proxy accepts only signed raw transactions (`eth_sendRawTransaction`), like the real sequencer endpoint. `eth_sendTransaction` and `eth_sendUnsignedTransaction` would put a tx straight into Anvil's pool and bypass the queue and the ordering, so they are refused; use `--private-key`. Also, `eth_getTransactionCount` answers `latest` like `pending` (queued txs included), because locally a queued tx waits a whole round and `cast` would otherwise reuse a nonce.

## FIFO mode

`npm run sim -- --fifo` (or `SIM_ORDER=fifo`) turns PGA off: every tx ranks at 0, so arrival decides, while the nonce rule still holds. The banner says `ordering: FIFO (PGA disabled)` and `sim_info.ordering` serves it. It exists so the bot and the probe can prove they can fail: scenario 1 fails and the probe says `FCFS-consistent`. No boost is added (p = 0).

## Local wallet funding

The local chain has 20 public Anvil dev accounts, each with 10,000 ETH. Roles are fixed in one place, `ANVIL_ACCOUNT_MAP` in `shared/config.ts`: accounts 0-2 are users and demo wallets (0 is also the flood's zero-tip sender and 1 its later arrival), 3-8 are the flood's paying txs, `slotSenders` (accounts 0-3) are `pga:slot`'s senders, `demoCompetitors` (3-5) are the competitors in demo chapter 4, 9 is the Tickets admin, and 10-19 are the traffic generator. `npm run race` ([combo/README.md](../combo/README.md)) reuses accounts that are idle during a race: operator = 9, mine = 0, rival = 2 (only one scenario runs at a time). At start the simulator also gives 1000 ETH to your `PRIVATE_KEY` and `MY_ADDRESSES` wallets (only addresses are printed), so `--local` works even when `.env` holds a testnet key. On `--local` the PGA bot ignores `PGA_KEY_*`.
