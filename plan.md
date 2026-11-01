# PGA + Fast Feed workshop repository

## Problem

There is no hands-on, runnable workshop showing developers how to use Arbitrum's two new ordering features.

- **PGA (priority gas auction):** the tip (`maxPriorityFeePerGas`) decides ordering across senders within a round.
- **Fast Feed:** a paid, authenticated WebSocket that publishes each transaction as soon as it is sequenced, before its block reaches the standard feed.

Evidence:

- `pga.md` is a video script with `cast` commands. It has no runnable `demo.sh`, and `pga.md:15` has the `--rpurl` typo.
- `feed-ticket-contracts/` is the Offchain Labs reference. It holds the `Tickets` contract and a long-running ticket-renewal bot. It has no feed client, no mock feed and no Sepolia config (Scout, verified).
- Neither Hardhat nor Anvil models PGA rounds, and no Nitro dev-node PGA flags are documented (Scout).
- Fast Feed on Sepolia needs TEST tokens that only Offchain Labs mints. Most attendees cannot touch it without a local alternative.

## Solution

A self-explanatory, non-production workshop repository. **One code path, two modes, selected per command:**

- **`--local`**
  - Builds the contracts if needed and starts (or attaches to) the local stack:
    - Anvil as a passive executor.
    - A mock sequencer that implements the documented PGA rules.
    - A mock Fast Feed that authenticates against a locally deployed copy of `Tickets`.
  - The terminal narrates what happens, including sequencer internals visible only locally (round queue, effective tips, boost).
- **`--testnet`**
  - Uses Arbitrum Sepolia (chainId 421614), the real sequencer endpoint and the real Fast Feed.
  - Uses the same commands, code and step messages, minus the sequencer internals, which cannot be observed on a real chain.

Requirements:

- **R1. Local stack (`--local`):**
  - Anvil plus a mock sequencer: rounds of B/K, ordering by effective tip, per-sender nonce gating, arrival tie-break, anti-starvation boost p/(2K), and a block-full cap.
  - A mock Fast Feed that emits the documented JSON and handles Bearer-key auth, 401, 429 and 1008.
  - Locally deployed `Tickets` (copied source), a TEST token and `Race`.
- **R2. Fast Feed (big phase A):**
  - Our own small ticket script: approve → deposit → `purchaseTickets(round, price, n, keccak(key))` → status / withdraw.
  - Our own feed client that connects with `Authorization: Bearer <key>` and prints decoded messages.
  - Explained error behaviour.
  - **Live rounds view** (`npm run feed -- --live`). During the ticket round your key is active for, it streams that round's transactions grouped by PGA round. Each row shows `tx_index`, `from`, `to`, the bid (`maxPriorityFeePerGas` / `maxFeePerGas` from `raw_tx`), the effective tip (`effective_gas_price − base_fee`), gas used and total fee. This lets the user see that, within a round, higher tips come first. This is the motivation for PGA.
  - **Timing made explicit.** For every message the live view prints:
    - when the tx was ordered (its `pga_round`);
    - when the Fast Feed delivered it;
    - when its block became visible on RPC, measured afterwards.

    The lead time is shown in ms. The user sees that **the Fast Feed comes after the tx is ordered and before the block is produced**.
- **R3. PGA (big phase B):**
  - `scripts/demo.sh 1|2|3` mirrors the three `pga.md` demos with `cast`.
  - A TypeScript PGA bot runs the same scenarios plus an anti-starvation scenario.
  - A testnet probe reports whether Sepolia ordering follows tips.
- **R4. Combination (big phase C):**
  - A `Race` contract and two bots, run as a scenario matrix: "information gets you into the round; the tip wins the round".
    - S1 (pure PGA): both bots read the feed and the higher tip wins.
    - S2 (speed beats tip): the feed with a low tip beats polling with a high tip.
    - S3 (headline): the feed plus a high tip.
- **R5. Final reconciled demo:**
  - `npm run demo -- --local` is fully narrated: tickets → live rounds view → we inject a transaction with a bigger PGA tip and watch it appear at the top of its round in the live view → race → explanation of why we won.
  - `npm run demo -- --testnet` is the same flow live on Arbitrum Sepolia.
- **R8. Acceleration transparency (`--local`):**
  - Every local parameter that differs from a real network is printed when the local stack starts, and next to the command it affects. Examples:
    - `LOCAL: ticket round = 60s (Arbitrum One: 24h)`
    - `LOCAL: block = 2000ms, K = 2 (Arbitrum One: 250ms, K = 2)`
  - The same parameters are documented once, in the parameters table in `docs/01-fast-feed.md` and `docs/simulator.md`.
- **R6. Docs written once:**
  - The README and `docs/` explain each concept a single time, with a short "`--local` vs `--testnet`" box only where behaviour differs.
  - They cover:
    - prerequisites
    - throwaway wallet creation (`cast wallet new`)
    - faucets
    - `.env`
    - every command with expected output
    - how the simulator differs from the real sequencer
- **R7. Inspectable by feature:** the code is organised so a reader can open "what PGA does" (`src/pga/`, `sim/pga-core.ts`) and "what Fast Feed does" (`src/fast-feed/`, `sim/feed.ts`) separately. Each rule is commented with a link to the doc it implements.

## Variables

| ID | Unknown / decision | Resolution | State |
|---|---|---|---|
| V1 | Toolchain | User: **Foundry + Anvil** (`cast` matches `pga.md`; Anvil supports `--no-mining --order fifo`). | closed |
| V2 | How to reuse the reference code | User: **copy `Tickets.sol` + `ITickets.sol` only**, keep the Apache header and record the source commit in `contracts/src/vendor/README.md`. Write our own ticket script instead of importing their bot: theirs is a renewal daemon, does not deposit, and would hide the four calls attendees need to see. Docs link to it for production-style renewals. | closed |
| V3 | Is PGA active on Arbitrum Sepolia? | Empirical: the B4 probe. The docs do not confirm it. | open (resolved by B4) |
| V4 | Number of Sepolia tickets | User: **two tickets**. Each bot gets its own feed connection on testnet, as locally. | closed |
| V5 | Run the ETH-only PGA probe on Sepolia before the ticket finale | Default accepted: yes, first slice of the testnet stage. | closed |
| V6 | How the local mock shows "Fast Feed after ordering, before the block" | **Superseded** (the user requires this order to be visible). Brain decision, which the user can veto:<br>- Each PGA round's ordered batch is executed as its own Anvil block, so receipts exist.<br>- The mock feed publishes those messages immediately.<br>- The mock RPC proxy hides the newest block (`eth_blockNumber`, `eth_getBlockBy*`, receipts, `eth_getLogs`) until the block boundary, plus a configurable `BLOCK_PUBLISH_DELAY_MS`.<br>So locally, as on Arbitrum, the feed message arrives before the block can be seen on RPC. Simplification: one round = one local block (on Arbitrum, K rounds share a block). Documented in `docs/simulator.md` and announced by the R8 banner. | closed (pending user veto) |
| V7 | Does the copied `Tickets` ABI match the deployed Sepolia proxy (`0x6f94…C879`)? | A5 reads every view used by our script on Sepolia and checks the results decode. A mismatch blocks A5. | open (resolved by A5) |
| V8 | How "transactions arriving within the same block" is shown locally | User (2026-10-28): **(b)**, K = 2 PGA rounds per local block, in slow motion (×100: 12.5 s rounds, 25 s blocks). Delivered by B6; replaces V6. | closed |
| V9 | Ticket round vs slow motion | User (2026-10-28): **adapt the ticket round to the block time and say so.** The local ticket round is `max(30 s, 4 × B)`, so 30 s on the slow and fast presets and 100 s with `--slowmo` (25 s blocks). When it is raised above 30 s, the banner and the demo print `NOTE: ticket round adapted from 30s to 100s so a purchase or renewal (visible only after its 25s block closes) has time to land in its round` *(wording softened in C5 review, 2026-10-28)*. An explicit `TICKET_ROUND_SECONDS` wins, with a warning if it is below 4 × B. Delivered in C5. | closed |
| V10 | How round 1 receipts exist before the block is mined (B6) | Oracle (2026-10-28), adopted by the brain after the user said "implement" without choosing: **snapshot and re-mine**. The sequencer sets every block's timestamp T explicitly, so the re-mine reuses T. Every provisionally mined block is reverted and re-mined at its last round, even when round 2 is empty. A read gate holds RPC and ticket-auth reads from `evm_revert` until the final mine finishes. Between rounds, `latest` sees round 1's effects, as before. A runtime receipt check logs `FEED RECEIPT MISMATCH` and counts it in `sim_info`. Anvil behaviour F1–F8 is confirmed empirically before coding. Defaults chosen by the brain: `MAX_TXS_PER_ROUND` stays a per-round cap (a block holds at most K×cap), and all rounds of a block share the block's timestamp (as on Arbitrum, where a block has one timestamp). Both are documented assumptions. B6 is split into **B6a** (the open-block skeleton behind a temporary `SIM_ROUNDS_IN_BLOCK` switch, set by `--slowmo`) and **B6b** (every consumer updated, the switch removed, all presets K rounds per block). | closed |

## Constraints/Invariants

- **Not production.**
  - Every README and doc says so.
  - Throwaway wallets only.
- **Networks:**
  - `--local` (Anvil, chainId 31337) and `--testnet` (Arbitrum Sepolia, 421614) only.
  - **No mainnet transactions or deployments.**
  - Sepolia transactions happen only in the testnet-stage slices B4, A5 and C4.
- **One code path.**
  - `--local` / `--testnet` select a preset in `src/config.ts` (RPC, send endpoint, feed URL, Tickets and TEST addresses).
  - Feature code never branches on network, except:
    - narration of sequencer internals, which is `--local` only;
    - minting TEST, which is `--local` only.
  - Commands run without either flag fail with a message explaining both flags.
- **`--local` is self-starting.** It runs `forge build` if artifacts are stale, and starts the local stack if it is not already running (`npm run sim` can also run it in its own terminal for exploration).
  - **Exception (decided in A2):** commands that change chain state for later use, such as `tickets:*`, attach to a running `npm run sim` and refuse with a clear message if none is running. A stack started by a short-lived command dies when the command exits, and the purchase would vanish with it. `feed --local` and other long-running viewers still self-start.
- **Docs once.** No concept is explained twice. Mode differences appear only in a marked "`--local` vs `--testnet`" box.
- **Secrets:**
  - `.env` is git-ignored. `.env.example` lists variable names only.
  - The raw fast-feed API key is never logged or committed; only its keccak hash goes on chain.
  - Private keys are never printed, except the well-known Anvil dev keys in local docs.
- **The PGA model is ours.**
  - It lives in one pure module, `sim/pga-core.ts`.
  - Every rule links to https://docs.arbitrum.io/how-arbitrum-works/priority-gas-auction/pga.
  - Every assumption is marked `ASSUMPTION:`.
- **The Fast Feed message format follows the "consume fast feed" docs exactly.**
  - Shape: `{version:1, timestamp_ms, pga_round?, transaction:{block_number, tx_index, raw_tx, tx_hash, receipt:{status, gas_used, gas_used_for_l1, cumulative_gas_used, effective_gas_price, base_fee, contract_address, logs[]}}}`.
  - Byte fields are hex. Each JSON object is sent as one binary frame.
  - The client sends only ping/pong.
  - The same client works against the mock and `wss://sepolia-rollup-txfeed.arbitrum.io`.
- **Timing.**
  - Integration tests use a slow-motion preset (e.g. B=2000ms, K=2).
  - They assert only order within a round, and that a feed message arrives before its block is visible on RPC. They never assert absolute wall-clock time.
- **Acceleration is never silent.**
  - Any `--local` parameter that differs from Arbitrum One is printed by the stack banner and by the command that uses it.
  - `--testnet` prints the values read from chain (e.g. `tickets:status`).
- **Docs list Arbitrum One and Arbitrum Sepolia only.** No other chain configurations.
- **Existing files are not modified:** `pga.md` and the `feed-ticket-contracts/` clone. The clone is git-ignored. *Superseded in round 2 by D1 (user decision, 2026-10-28): the clone is removed, and `pga.md` moves unchanged to `pga/video-script.md`.*

## Implementation Notes

**Verified facts** (Scout, from docs.arbitrum.io: priority-gas-auction `pga`, `fast-feed`, `use-fast-feed`, `consume-fast-feed`; `chain-info`):

- **PGA:**
  - Ordinary type-2 txs. Effective tip = `min(maxPriorityFee, maxFee − baseFee)`.
  - Each round, the waiting list moves into a priority queue. Ties are broken by arrival.
  - Round = B/K. On Arbitrum One, B=250ms and K=2.
  - A round ends when the queue is empty, the block is full, or time runs out.
  - Boost: p/(2K) after each round with a non-empty queue. It affects position only, never the price paid.
  - Private mempool. Ordinary `eth_sendRawTransaction`.
- **Fast Feed:**
  - Sepolia endpoint: `wss://sepolia-rollup-txfeed.arbitrum.io`.
  - Addresses:
    - Tickets proxy: `0x6f940179448e0a1C7BD8cfCB787555eb85cFC879`
    - TEST token: `0xca202b90454Db321256Cd84531Dd4929561d1e00`. Only Offchain Labs mints it (via Discord).
  - Rounds:
    - Sepolia rounds last 10 min and begin with a grandfather period.
    - Access starts when the purchase round ends.
    - Renew every round, or the connection is closed with 1008.
  - HTTP errors: 401, 429 and 426. Close codes: 1008, 1013 (lag > 2048), 1003 and 1011.
- **Sepolia endpoints:**
  - RPC: `https://sepolia-rollup.arbitrum.io/rpc`
  - Send endpoint (sequencer): `https://sepolia-rollup-sequencer.arbitrum.io/rpc`, which accepts raw txs only.
  - Explorer: https://sepolia.arbiscan.io. Faucets are listed on chain-info.

**Ticket and PGA parameters** (this table goes in `docs/01-fast-feed.md`; the PGA rows also go in `docs/simulator.md`):

| Parameter | Arbitrum One | Arbitrum Sepolia | `--local` (accelerated) |
|---|---|---|---|
| Round duration | 24 hours | 10 minutes (docs) | 60 seconds |
| Target tickets / round | 100 | read on chain (`tickets:status`) | 100 |
| Max tickets / round | 200 | read on chain | 200 |
| Minimum price / round | $17 (17000000, 6 decimals) | read on chain | 1 TEST |
| Price update fraction | 144 | read on chain | 144 |
| Grandfather period | ~0.5 (128/256) | read on chain | 0 (none) |
| Payment token | USDG | TEST (`0xca20…1e00`, minted by Offchain Labs) | TEST (local ERC20Mock, auto-minted) |
| Block time B / rounds per block K | 250ms / 2 | read empirically (B4) | 2000ms / 2 (slow motion for readability; `--preset fast` uses 250ms / 2) |

- The user provided the Arbitrum One column, and the Sepolia round duration comes from the docs. The Sepolia "read on chain" cells are filled in by A5, using `tickets:status -- --testnet`.
- The `--local` values are proposals. The executor keeps them in `src/config.ts` as the only source, and the banner prints them from there.

**Reference repository** (`feed-ticket-contracts/`, Scout, verified):

- `Tickets.sol` sits behind a TransparentUpgradeableProxy. Its constructor takes the token.
- The `TicketsPurchased(buyer, round, apiKeyHash, price, numTickets, numTicketsDesired)` event is what a sequencer indexes.
- Built with solc 0.8.34, `evm_version = "osaka"` and Foundry v1.8.3.
- Its anvil test harness deploys ERC20Mock + Tickets + Proxy from `out/` and pins the base fee with `anvil_setNextBlockBaseFeePerGas` (`bot/test/bot.test.ts:115-148, 348-350`). Our local deploy follows the same pattern.

**Accepted Oracle recommendations:**

1. **Anvil runs with `--no-mining --order fifo`, so our PGA ordering is the only ordering.** The base fee is pinned. The mock mines one Anvil block per PGA round and reveals it on RPC only at the block boundary (V6). The mock has three modules:
   - `pga-core` (pure, unit-tested)
   - `rpc` (intercepts `eth_sendRawTransaction` and returns `keccak(raw)`)
   - `feed` (the WebSocket server)

   Configurable: `B`, `K`, `MAX_TXS_PER_ROUND` (block-full stand-in, needed to show anti-starvation) and the slow-motion preset.
2. **Ordering demos send the lowest tip first,** so FCFS and PGA predict opposite orders.
3. **`Race.claim(id)` never reverts.** It records and emits a `rank`. The operator wallet calls `open(id)`. Bots pre-sign their claim before the trigger.
4. **Reported tips are computed from receipts** as `effective_gas_price − base_fee`.
5. **Stack:** TypeScript + viem on Node 22, tested with `node:test` + `tsx`. A thin `scripts/demo.sh` mirrors `pga.md` (with `--rpc-url` fixed).

**Layout (by feature, for inspectability; round 1, superseded by the D1 layout in round 2):**

```text
README.md                    what/why, disclaimer, quickstart --local, quickstart --testnet, command reference
docs/00-setup.md             install (Node 22, Foundry), wallets (cast wallet new), faucets, .env, the two modes
docs/01-fast-feed.md         tickets, keys, connecting, message format, errors
docs/02-pga.md               tips, rounds, nonce rule, zero tip, anti-starvation, testnet probe
docs/03-combo.md             race scenarios S1–S3, final demo walkthrough (mermaid timeline)
docs/simulator.md            what --local models, assumptions, differences from Nitro
foundry.toml                 solc 0.8.34; src = contracts/src
contracts/src/vendor/        Tickets.sol, ITickets.sol (copied, Apache header) + README.md with source commit
contracts/src/Race.sol       + contracts/test/Race.t.sol
sim/                         --local only: chain.ts (anvil spawn/mine-per-round/basefee/deploy), pga-core.ts (PGA rules),
                             rpc.ts (send intercept + block reveal gating), feed.ts (mock Fast Feed + ticket auth),
                             traffic.ts (background txs with random tips), banner.ts (accelerated params), index.ts
src/config.ts                --local / --testnet presets (the only place networks differ; single source of params)
src/narrate.ts               step/explain/internal printers; "internal" lines only shown in --local
src/wallets.ts               new / fund / balances
src/fast-feed/               key.ts, tickets.ts (approve→deposit→purchase, status, withdraw), client.ts,
                             live.ts (live rounds view: per-round table, tips/fees, ordered→feed→block timing)
src/pga/                     tx.ts (pre-sign type-2 with tip), bot.ts (scenarios), probe.ts (testnet verdict)
src/combo/                   race.ts (watchers: fast feed / polling), scenarios.ts, demo.ts (final demo)
scripts/demo.sh              cast-based pga.md demos 1–3 (RPC + READ_RPC from env)
test/                        node:test unit + slow-preset integration tests
package.json, tsconfig.json, .env.example, .gitignore (.env, out/, cache/, node_modules/, feed-ticket-contracts/)
```

## Workflow

**Baseline:** `.crew/baseline.json`, captured before A1, excluding `plan.md`.

**Phases** are vertical slices *within* each big phase, as the user asked. Every slice runs from the real entry point (`npm run … -- --local|--testnet`, or `scripts/demo.sh`) through the simulator or Sepolia to the chain, and back to the narrated terminal output.

**Every slice:**

- implements both flags through the shared code path;
- is *verified* locally in the local stage;
- is verified on testnet in the testnet stage.

**Delivery order:**

- **Local stage** (authorized): A1 → A2 → A3 → B1 → A4 → B2 → B3 → C1 → C2 → C3 (B1 runs before A4 because A4's tip-sorted live view needs B1's PGA ordering; user decision, 2026-10-27)
- **Round 2, local follow-ups** (requested 2026-10-28, needs authorization): D1 (feature-first layout, cleanup) → B5 (slow blocks, a late bigger tip slots into an open round) → B6 (K = 2 PGA rounds per local block, slow motion ×100) → C5 (30 s adaptive local ticket rounds) → C6 (color-coded output, `NOTE:`, highlighted steps, hands-off chapter stops) → C7 (in-place live panel, per-tx `FF lead` vs a direct sequencer read) → C8 (paused demo: inject into round 2 of an open block, timing and FCFS tables) → D2 (short root README, Fast Feed / PGA / combo READMEs; docs only)
- **Testnet stage** (a later round, after round 2; needs separate authorization): B4 (faucet ETH only) → A5 (user's TEST tokens, 2 tickets) → C4 (final testnet demo), each including the round-2 changes that apply on Sepolia

---

## Big phase A: Fast Feed

### A1: A developer watches their own transaction arrive on the local Fast Feed

- **Outcome:** A developer runs `npm run feed -- --local`, sends a transaction with `cast send`, and sees it printed as a decoded fast-feed message (`block_number`, `tx_index`, `tx_hash`, `from`, `tip`, `status`), with a one-line explanation of what the Fast Feed is.
- **Demo script:**
  1. `npm install`.
  2. `npm run feed -- --local`. Expected:
     - `forge build` runs.
     - The stack starts: Anvil, the sequencer on `http://127.0.0.1:8547`, the feed on `ws://127.0.0.1:9642`.
     - A banner prints every accelerated parameter next to its Arbitrum One value (R8).
     - The client prints a short explanation, "the Fast Feed shows a tx after it is ordered and before its block is produced", then `connected`.
  3. In a second terminal: `cast send 0x…dEaD --value 1 --private-key <anvil key 1> --rpc-url http://127.0.0.1:8547`. A receipt is returned.
  4. The feed terminal prints one message with the matching `tx_hash`, followed by a line `block N visible on RPC +<ms> after the feed message`. `--raw` shows the JSON.
  5. `npm run feed` with no flag fails, explaining `--local` and `--testnet`.
- **Stubbed or deferred:**
  - The sequencer is a FIFO passthrough. `pga-core` is an arrival-order stub.
  - No feed auth.
  - The `--testnet` preset exists for RPC and feed URL, but is not exercised.
- **Satisfies:** R1 (skeleton), R2 (client), R6 (setup), R7.
- **Scope:**
  - Included: the repo scaffold, `sim/` (chain, rpc, feed), `src/config.ts`, `src/narrate.ts`, `src/fast-feed/client.ts`, `docs/00-setup.md`, the README skeleton.
  - Excluded: tickets, PGA ordering, any Sepolia transactions.
- **Subtasks:**
  - [ ] **repo:**
    - `package.json` scripts: `sim`, `feed`, `test`, `typecheck`.
    - `tsconfig.json`, `foundry.toml`, `.gitignore`, `.env.example`.
  - [ ] **sim:**
    - `chain.ts`: spawns `anvil --no-mining --order fifo`, pins the base fee, and mines one block per round.
    - `rpc.ts`: the JSON-RPC proxy. It hides the newest block until the block boundary plus `BLOCK_PUBLISH_DELAY_MS` (V6).
    - `feed.ts`: emits documented JSON as binary frames with `pga_round`, immediately after the round executes.
    - `banner.ts`: accelerated parameters, read from `config.ts`.
    - `index.ts`: start or attach.
  - [ ] **cli:**
    - `config.ts`: flag parsing and presets.
    - `narrate.ts`: `step`, `explain`, and `internal` (internal is `--local` only).
    - `client.ts`: optional Bearer header, answers pings, decodes `raw_tx` with viem, recovers `from`.
  - [ ] **docs:**
    - `docs/00-setup.md`, including the "two modes" section.
    - README quickstart and a "not production" banner.
  - [ ] **checks:**
    - `test/feed.integration.test.ts`: slow preset, send a tx, assert exactly one message whose fields match the receipt and conform to the schema.
    - A unit test for flag parsing.
- **Depends on:** baseline. **Open decisions:** none.
- **Acceptance criteria:**
  1. `--local` builds, starts the stack, and attaches on a second invocation. Ctrl-C leaves no orphan Anvil.
  2. A tx sent through the mock is mined and reported. The message has every documented field, with byte fields in hex.
  3. The mock returns the same hash as `cast keccak <raw>`.
  4. A newcomer reaches step 4 using only the README and `docs/00-setup.md`.
  5. A feed message is received before its block is visible on the mock RPC. The integration test asserts this ordering.
  6. The startup banner lists every accelerated parameter with the corresponding Arbitrum One value.
- **Checks/evidence:** `npm run typecheck`, `npm test`, a manual demo log.
- **Regression coverage:** n/a.
- **Status:** accepted (2026-10-27)
- **Evidence:**
  - Reviewer PASS in r2, after REVISION_NEEDED in r1. Packets: `.crew/reviews/A1-r1.md` and `A1-r2.md`. Scope fingerprint `01a97f09…3e74e73`, verify MATCH.
  - Checks: `npm run typecheck` exit 0; `npm test` exit 0 (10 of 10 pass); `forge build` exit 0 ("Nothing to compile").
  - Manual demo: the feed message preceded block visibility by about 1050 ms; `cast keccak` matched the hash from `cast publish`; SIGINT left no Anvil running; with no flag, the command exits 1.
  - Deviation: `forge build` is skipped while `contracts/src` has no `.sol` files.
  - Open: `.env.example` content could not be verified, because a permission rule blocks reading it.

### A2: A ticket buyer buys a feed ticket and is let in only once it activates

- **Outcome:** A ticket buyer runs `npm run key:new` and `npm run tickets:buy -- --local --tickets 1`. They see each step (mint, approve, deposit, round and price read, purchase, activation time), each explained. Their feed connection is refused with 401 before activation and accepted after.
- **Demo script:**
  1. `npm run key:new`. Writes `FEED_API_KEY` to `.env` and prints only `keccak(key)`, with an explanation.
  2. With `npm run sim` running in another terminal, run `npm run tickets:buy -- --local --tickets 1`. The local stack has deployed TEST + Tickets with the accelerated parameters from the parameters table. The command first prints `LOCAL: ticket round = 60s (Arbitrum One: 24h), grandfather = 0 (Arbitrum One: ~0.5)`. The output then narrates:
     - mint (local only)
     - approve
     - `depositToken`
     - `roundNumber` and `currentPrice`
     - `purchaseTickets`
     - "access starts at <roundEnd>"
  3. `npm run feed -- --local` before activation prints `401 Unauthorized: no active ticket`, plus why.
  4. After the round ends, the same command prints `connected` and then messages.
  5. `npm run tickets:status -- --local` and `npm run tickets:withdraw -- --local` work.
- **Stubbed or deferred:** Expiry, 429 (A3), live view (A4), Sepolia (A5).
- **Satisfies:** R1 (auth), R2, R7.
- **Scope:**
  - Included:
    - Copy `Tickets.sol` + `ITickets.sol` into `contracts/src/vendor/` (with the source commit), plus their OpenZeppelin dependencies via `forge install`.
    - A local deploy of ERC20Mock "TEST" (6 decimals) + Tickets + Proxy.
    - `src/fast-feed/key.ts` and `tickets.ts`.
    - Feed auth that indexes `TicketsPurchased`.
    - `docs/01-fast-feed.md`.
  - Excluded: 429, 1008.
- **Subtasks:**
  - [ ] **contracts:** the vendored copy; OZ upgradeable + forge-std via `forge install`; the local deploy in `sim/chain.ts`.
  - [ ] **sim:** `feed.ts` auth. Hash the Bearer key and accept it only if it was bought in a round `< currentRound`. Otherwise return 401.
  - [ ] **cli:**
    - `tickets.ts`: one exported function per step, each commented with a doc link.
    - It reads round, price, `roundEnd`, `grandfatherPeriodEnd` and `grandfatherCount` right before buying.
    - During a grandfather period the buyer cannot use, it explains and exits cleanly.
  - [ ] **docs:** `docs/01-fast-feed.md`: tickets, keys, purchase steps, timing, the parameters table (Arbitrum One / Sepolia / `--local`), key hygiene, and a link to the official renewal bot.
  - [ ] **checks:**
    - Integration: buy → 401 → advance the round → connected with messages.
    - Unit: key hash equals `cast keccak`.
    - The revert on a stale round or price is printed readably.
- **Depends on:** A1. **Open decisions:** none.
- **Acceptance criteria:**
  1. 401 for an unknown key and for a not-yet-active key; connected after activation.
  2. A stale round or price gives a readable error, not a crash.
  3. The raw key never appears in stdout, logs or tests.
  4. `FEED_AUTH=off` keeps A1's open-feed behaviour for exploration.
- **Checks/evidence:** `forge build`, `npm test`, a manual demo.
- **Regression coverage:** the A1 tests.
- **Status:** accepted (2026-10-27)
- **Evidence:**
  - **Review:** reviewer PASS in r2 (r1 returned REVISION_NEEDED). Packets: `.crew/reviews/A2-r1.md`, `A2-r2.md`. Scope `0f6ca4f2…926680`, verify MATCH.
  - **Checks:**
    - `forge build` exit 0.
    - `npm run typecheck` exit 0.
    - `npm test` exit 0, two consecutive runs, 30/30 each.
    - The vendored contracts are `cmp`-identical to the reference.
  - **Manual demo:** `key:new` printed the hash only. `tickets:buy` narrated all six steps. `feed` returned 401 before activation (exit 1), then connected and showed the message after activation. `tickets:status` showed ACTIVE. No orphan processes were left.
  - **Deviation:** the `tickets:*` commands attach to a running `npm run sim` (see the exception under Constraints).
  - **Open:** `.env.example` needs a user update. The testnet `ticketsFromBlock` is a TODO for A5.

### A3: A ticket holder sees connection limits and ticket expiry explained

- **Outcome:** A holder of one ticket sees:
  - a second simultaneous connection refused with 429;
  - after an unrenewed round, their connection closed with 1008 and a readable explanation.

  When they renew, they reconnect, automatically with `--reconnect`.
- **Demo script:**
  1. Two `npm run feed -- --local` terminals. The second prints `429 … connections ≥ tickets`.
  2. Wait one round. The first prints `closed 1008 (ticket expired). Renew: npm run tickets:buy -- --local`.
  3. Renew, then `npm run feed -- --local --reconnect` connects after activation.
- **Stubbed or deferred:** 1013 and 1011 are explained by the client but not simulated.
- **Satisfies:** R2.
- **Scope:**
  - Included: per-key connection counting, expiry on round rollover, code→explanation maps, `--reconnect`, the error table in the docs.
- **Subtasks:**
  - [ ] **sim:** connection count vs tickets; close with 1008 on rollover.
  - [ ] **cli:** explanations for 401, 429 and 426, and for 1008, 1013, 1003 and 1011; reconnect with backoff.
  - [ ] **docs:** the error table.
  - [ ] **checks:** integration tests for 429 and 1008.
- **Depends on:** A2. **Open decisions:** none.
- **Acceptance criteria:**
  1. Connections beyond the ticket count get 429.
  2. An expired key is closed with 1008 within one round.
  3. Every documented code has a readable explanation.
- **Checks/evidence:** `npm test`.
- **Regression coverage:** the A1 and A2 tests.
- **Status:** accepted (2026-10-27)
- **Evidence:**
  - **Review:** reviewer PASS in r2 (r1 returned REVISION_NEEDED: the rollover `nextCheck` and 429 reservation leak). Packets: `.crew/reviews/A3-r1.md`, `A3-r2.md`. Scope `d3e3de7a…875b02`, verify MATCH.
  - **Checks:** `forge build` exit 0. `npm run typecheck` exit 0. `npm test` exit 0, 48/48.
  - **Behaviour covered:**
    - 429 with 1 and 2 tickets, including concurrent connects.
    - 1008 within one round, while a renewed key keeps its connection.
    - `--reconnect` goes from 401 to connected.
    - 426, 1003, 1011 and the local-only 503.
    - A test keeps the docs error table in sync with `FEED_CODES`.
  - **Scope change:** the active-ticket rule follows the docs (bought in N, active in N+1 only), replacing A2's "active forever" rule.

### A4: A ticket holder watches their ticket round's transactions live, round by round, with tips and fees

- **Outcome:** A ticket holder runs `npm run feed -- --local --live`. While background traffic with random tips flows, they see:
  - a header for the ticket round their key is active for (round number and time left);
  - then one table per PGA round, each row showing `tx_index`, `from`, `to`, the bid (`maxPriorityFee` / `maxFee`), the effective tip, gas used and fee paid;
  - a timing line per round: `ordered (round R) → Fast Feed +Xms → block N visible on RPC +Yms`.

  A footer explains: "within each round, rows are sorted by tip. That's PGA. You saw them before the block existed. That's the Fast Feed."
- **Demo script:**
  1. `npm run traffic -- --local --tps 5` sends background txs from several Anvil dev wallets, with tips drawn at random from 0 to 0.1 gwei. It prints its own rate.
  2. With an active ticket (A2), `npm run feed -- --local --live`. The header shows the ticket round, and per-round tables appear, sorted by tip.
  3. `cast send … --priority-gas-price 1gwei --rpc-url http://127.0.0.1:8547`. Our tx appears **highlighted** at the top of its round's table, labelled "yours, tip 1 gwei, index 0 of round R".
  4. When the ticket round ends without renewal, the view prints the A3 1008 explanation.
- **Stubbed or deferred:** Highlighting "yours" uses addresses from `.env`.
- **Satisfies:** R2 (live view, timing), R7, R8.
- **Scope:**
  - Included:
    - `src/fast-feed/live.ts`.
    - `sim/traffic.ts` (local only; refused on `--testnet` with an explanation).
    - `raw_tx` decoding for the bid fields.
    - The block-visible probe: poll `eth_getBlockByNumber` after each message to measure the lead time.
    - The "Live view" section of `docs/01-fast-feed.md`, including a diagram: tx sent → waiting list → round R ordered → Fast Feed → block produced → standard feed / RPC.
  - Excluded: injecting a tip from inside the demo (C3).
- **Subtasks:**
  - [ ] **cli:** `live.ts`: groups by `pga_round`, falling back to `block_number` when it is absent; renders the tables; highlights our own addresses; measures timing.
  - [ ] **sim:** `traffic.ts`.
  - [ ] **docs:** the live view section and diagram.
  - [ ] **checks:**
    - Unit: fee and tip computation from a fixture message.
    - Integration (slow preset): with traffic running, each round's rows are sorted by effective tip; an injected high-tip tx is row 0 of its round; every message's lead time is > 0.
- **Depends on:** A3, B1 (tip ordering in the sequencer). **Open decisions:** none.
- **Acceptance criteria:**
  1. Within each displayed round, rows are in `tx_index` order, and their effective tips do not increase down the table, except where a nonce-gated or boosted tx is annotated as such.
  2. Every row shows the bid, the effective tip and the fee paid, with units.
  3. Every message shows ordered → feed → block-visible timing with a positive lead.
- **Checks/evidence:** `npm test`, a manual demo transcript.
- **Regression coverage:** the A1–A3 tests.
- **Status:** accepted (2026-10-27)
- **Evidence:**
  - **Review:** PASS in r3. Earlier rounds returned REVISION_NEEDED:
    - r1: duplicate-nonce race, probe started at flush, integration race;
    - r2: the probe tests did not discriminate.
    - Packets: `.crew/reviews/A4-r1..r3.md`. Scope `ca5e046a…05c8f7`, verify MATCH.
  - **Checks:** `forge build` exit 0. `npm run typecheck` exit 0. `npm test` exit 0, 97/97. The executor reports three more consecutive runs at 97/97.
  - **Mutation evidence:** the probe-start and print-order tests fail under a flush-time probe and under a timing line printed from the probe.
  - **Manual run:** the injected 1 gwei tx showed at row 0 marked "yours", with descending tips below it. The timing line read `ordered → Fast Feed +16ms → block visible +2039ms`. The footer printed. Traffic ran at 3.8 tx/s, capped by one-in-flight per wallet.
  - **Deviations:**
    - `timestamp_ms` is the round's order time (ASSUMPTION).
    - The demo `cast send` needs `--gas-price 2gwei`.
    - Timing is per round, not per message.
    - The duplicate (sender, nonce) is refused at submit (ASSUMPTION). This also root-caused the A3 concurrent-send hang.
    - The A3 reconnect test is made deterministic with `FEED_BACKOFF_MAX_MS`.

---

## Big phase B: PGA bot

### B1: A presenter shows that the highest tip goes first, even when sent last

- **Outcome:** A presenter runs `./scripts/demo.sh 1` against `--local`. They see three wallets' txs, sent lowest tip first, land in one round ordered 0.1 → 0.01 → 0.001 gwei. The sequencer narration shows the round's priority queue. Locally one round is one block (V6).
- **Demo script:**
  1. `npm run sim -- --preset slow` (B=2000ms, K=2). Prints round ticks.
  2. `export RPC=http://127.0.0.1:8547 READ_RPC=$RPC`. Keys come from `.env.example` (Anvil dev keys).
  3. `./scripts/demo.sh 1`:
     - pre-signs with `cast mktx`;
     - runs `cast publish --async` in parallel;
     - prints `block N idx … from … tip …`.
  4. The sim terminal prints, per round: the queue (tx, effective tip, arrival) and the drained order.
- **Stubbed or deferred:** no nonce gating, no boost, no block cap.
- **Satisfies:** R1, R3, R7.
- **Scope:**
  - Included:
    - `sim/pga-core.ts`: effective tip; sort by tip descending, then by arrival.
    - The rounds loop.
    - `demo.sh 1`.
    - `docs/02-pga.md` part 1, including the capped-tip example from `pga.md`.
- **Subtasks:**
  - [ ] **sim:**
    - `selectRound(queue, baseFee)`, pure.
    - A rounds timer at B/K. Drained batches go to Anvil in order; blocks are mined at block boundaries.
    - Narration of internals.
  - [ ] **script:** `demo.sh 1`.
  - [ ] **docs:** `docs/02-pga.md` part 1.
  - [ ] **checks:**
    - Unit: effective tip, including the capped case (0.04, not 0.1); arrival tie-break.
    - Integration: three txs sent lowest tip first end up in one block, ordered by tip.
- **Depends on:** A1. **Open decisions:** none.
- **Acceptance criteria:**
  1. Within a round, txs are ordered by effective tip, highest first, with ties broken by arrival.
  2. The capped example yields 0.04 gwei.
  3. `demo.sh 1` output matches the `pga.md` table format.
- **Checks/evidence:** `npm test`, `bash -n scripts/demo.sh` (plus `shellcheck` if installed), a manual demo.
- **Regression coverage:** the A tests (the feed reports every tx under PGA ordering).
- **Status:** accepted (2026-10-27)
- **Evidence:**
  - **Review:** PASS in r3, after REVISION_NEEDED in r1 (parallel publish order, no chain allowlist) and r2 (empty-block wording). Packets: `.crew/reviews/B1-r1..r3.md`. Scope `f329bce5…e91a36`, verify MATCH.
  - **Checks:** `bash -n` passed; `forge build` and `npm run typecheck` exited 0; `npm test` exited 0 with 70/70 passing. shellcheck is not installed.
  - **Manual:** `demo.sh 1` put block 4 at idx 0/1/2 with tips 0.1/0.01/0.001 and printed "Verdict: PGA order". The sim log showed arrival lowest-first and the drained order highest-first.
  - **Deviations:**
    - demo.sh publishes sequentially after a round-tick sync rather than in parallel, so that arrival is provably lowest-first.
    - The keys default to the public Anvil accounts 0–2 only on chainId 31337, instead of coming from `.env.example`.
    - demo.sh refuses every chain except 31337, and 421614 with `ALLOW_TESTNET=1`.
    - Delivered before A4, by user decision.

### B2: A presenter shows "nonce wins within a sender" and "a zero tip still lands", from the shell and from the bot

- **Outcome:** A presenter runs `./scripts/demo.sh 2`, `./scripts/demo.sh 3` and `npm run pga -- --local --scenario all`. They see:
  - same-sender nonce N (low tip) landing before N+1 (100× tip);
  - a zero tip landing last but landing.

  Each scenario prints PASS or FAIL against the expected PGA order, with an explanation.
- **Demo script:**
  1. `./scripts/demo.sh 2` prints `idx 1 nonce N tip 0.001` then `idx 2 nonce N+1 tip 0.1`.
  2. `./scripts/demo.sh 3` prints tips 0.1, 0.01, 0.
  3. `npm run pga -- --local --scenario all` runs scenarios 1–3 with viem (pre-signed, concurrent) and prints a table plus the reason for each.
- **Stubbed or deferred:** boost and block cap (B3).
- **Satisfies:** R3, R7.
- **Scope:**
  - Included: nonce gating in `pga-core`, `src/pga/tx.ts` and `bot.ts`, `demo.sh 2|3`, `docs/02-pga.md` part 2.
- **Subtasks:**
  - [ ] **sim:**
    - Only a sender's next nonce is eligible.
    - Later nonces follow after inclusion.
    - An `ASSUMPTION:` note on gap handling.
  - [ ] **bot:**
    - `tx.ts`: `presign({to, data, tip, maxFee, nonce})`.
    - `bot.ts`: scenarios.
    - Tips taken from receipts.
    - Exit code non-zero on FAIL.
  - [ ] **script / docs:** `demo.sh 2|3`; `docs/02-pga.md` part 2.
  - [ ] **checks:** a nonce-gating unit test; an integration test for `pga --scenario all`.
- **Depends on:** B1. **Open decisions:** none.
- **Acceptance criteria:**
  1. N+1 is never placed before N.
  2. A zero tip is included in the same or the next block on an uncongested stack.
  3. The bot exits 0 only when every scenario matches.
- **Checks/evidence:** `npm test`, a manual demo.
- **Regression coverage:** the B1 and A tests.
- **Status:** accepted (2026-10-28)
- **Evidence:**
  - **Review:** PASS in r2, after r1 returned REVISION_NEEDED (`PGA_KEY_*` was used unfunded on the local chain). Packets: `.crew/reviews/B2-r1.md` and `.crew/reviews/B2-r2.md`. Scope `144f9476…dad9cc`, verify MATCH.
  - **Checks:** `bash -n`, `forge build` and `npm run typecheck` all exit 0. `npm test` exits 0 with 137/137 passing.
  - **Manual runs:**
    - `demo.sh 2`: idx 0 is nonce N at 0.001 and idx 1 is nonce N+1 at 0.1, with a "nonce rule" verdict.
    - `demo.sh 3`: tips 0.1, 0.01 and 0, with a "zero tip lands last, but lands" verdict.
    - `npm run pga -- --local --scenario all`: all three scenarios PASS, exit 0. Against a `--fifo` stack the bot FAILs (exit 1).
    - The local sim funded the user's `PRIVATE_KEY` wallet and printed only its address.
  - **Deviations:**
    - The bot pre-signs and sends back to back, lowest tip first, not concurrently.
    - "Different blocks" is reported as inconclusive (exit 3), which is stricter than "same or next block".
    - Nonce gaps are held for `GAP_HOLD_ROUNDS` (an assumption).
    - Out of scope but added: local funding of the `PRIVATE_KEY` and `MY_ADDRESSES` wallets, and the explicit-nonce fix for `eth_fillTransaction`.

### B3: A presenter shows anti-starvation under load

- **Outcome:** A presenter runs `npm run pga -- --local --scenario flood`. The narration shows a zero-tip tx's boosted priority growing by p/(2K) per round while paying txs flood the queue: 0 → p/4 → p/2 → 3p/4 → p. It lands after about 2K rounds, ahead of a later arrival that tips p, and the receipt confirms it paid no tip.
- **Demo script:**
  1. `npm run sim -- --preset slow --max-txs-per-round 3`.
  2. `npm run pga -- --local --scenario flood`.
  3. The sim prints per round: queue size, p, and the zero-tip tx's boosted priority.
  4. The bot prints the round in which it landed and its effective tip (0).
- **Stubbed or deferred:**
  - "Block full" is approximated by a tx-count cap (documented).
  - On `--testnet`, the flood scenario is refused with an explanation. It would spam a shared testnet, and internals are not observable there.
- **Satisfies:** R1, R3.
- **Scope:**
  - Included: boost and block cap in `pga-core`, carry-over, the flood scenario, `docs/simulator.md`, and the anti-starvation section of `docs/02-pga.md` using the worked example from `pga.md`.
- **Subtasks:**
  - [ ] **sim:** boost after each non-empty round, with p = priority of the last included tx. It affects ordering only.
  - [ ] **bot:** the flood scenario.
  - [ ] **docs:** `docs/simulator.md`, plus the anti-starvation section.
  - [ ] **checks:**
    - Pure unit test: K=2 with constant p reaches p after 4 rounds and wins the tie on arrival.
    - Slow-preset integration test of the flood scenario.
- **Depends on:** B2. **Open decisions:** none.
- **Acceptance criteria:**
  1. The boost is exactly p/(2K).
  2. The boost never changes the fee charged.
  3. Under a capped flood, the zero-tip tx is included within 2K+1 rounds.
- **Checks/evidence:** `npm test`, a manual demo.
- **Regression coverage:** the B1, B2 and A tests.
- **Status:** accepted (2026-10-28)
- **Evidence:**
  - **Review:** PASS in r3. r1 was REVISION_NEEDED because the flood could PASS without ever exercising the boost. r2 was REVISION_NEEDED because of the AGENTS.md import claim. Packets: `.crew/reviews/B3-r1..r3.md`. Scope `c52fc2bc…1a0e93`, verify MATCH.
  - **Checks:** `bash -n`, `forge build` and `npm run typecheck` exit 0. `npm test` exit 0, 175/175.
  - **Manual runs:**
    - `npm run sim -- --max-txs-per-round 3` with `pga --scenario flood`: PASS. Boost 0.0025 gwei per round. The zero-tip tx was included in round 5 (2K+1), at block 8 idx 0, ahead of the later p-tip arrival at block 9 idx 1. Receipt tip 0.
    - `pga:probe -- --local --trials 3`: PGA-consistent, 3/3.
    - Flood on a capped FIFO stack: refused, exit 1, no PASS.
  - **Built here from B4 (local part):** `pga:probe`, reporting PGA-consistent and FCFS-consistent. The testnet path is guarded and was not run.
  - **Assumptions:** p is the queue priority of the last included tx. Gap-held txs are boosted. The cap is a tx count standing in for 32 Mgas / 95 kB. These are documented in `docs/simulator.md`.

---

## Big phase C: Fast Feed + PGA, my transaction first

### C1: A bot operator uses the Fast Feed to react and outbids a rival with a higher tip (S1)

- **Outcome:** An operator runs `npm run race -- --local --scenario s1`.
  1. The operator wallet calls `Race.open(id)`.
  2. Two bots see `Opened` on the Fast Feed, each with its own ticket.
  3. The rival fires its pre-signed `claim` first, with a low tip. "Mine" fires later, with a high tip.
  4. The operator sees mine at rank 1 and the rival at rank 2, with a narrated timeline explaining that the tip decided it.
- **Demo script:**
  1. `npm run race -- --local --scenario s1`. This one command:
     - deploys `Race` if needed;
     - buys two local tickets if needed and waits for activation;
     - runs the scenario.
  2. Timeline output:
     - feed saw `Opened` at t0;
     - rival sent at t0+x (tip 0.001);
     - mine sent at t0+y, where y > x (tip 0.1);
     - block N: mine idx k (rank 1), rival idx k+1 (rank 2);
     - "same round → higher tip wins".
  3. `cast call <race> "winner(uint256)" <id> --rpc-url http://127.0.0.1:8547` returns my address.
- **Stubbed or deferred:** S2 and S3 (C2); the final demo (C3).
- **Satisfies:** R4, R7.
- **Scope:**
  - Included:
    - `contracts/src/Race.sol`: `open`, a never-reverting `claim` with `rank`, `Opened`/`Claimed` events, `winner`.
    - `Race.t.sol`.
    - `src/combo/race.ts`: the fast-feed watcher that filters `Opened` in `receipt.logs` and fires the pre-signed claim.
    - `scenarios.ts`.
    - `docs/03-combo.md` S1, including why the Fast Feed cannot jump a tx that is already sequenced but does get you into the next round.
- **Subtasks:**
  - [ ] **contracts:** `Race.sol` + forge tests. `evm_version` is set to one Arbitrum Sepolia accepts (≤ cancun; confirmed at C4 deploy).
  - [ ] **bots:** the watcher reuses `src/fast-feed/client.ts`; the claim reuses `src/pga/tx.ts`.
  - [ ] **runner:** orchestrates the operator, the rival and mine; prints the timeline; exits non-zero if the expected winner loses.
  - [ ] **docs:** `docs/03-combo.md` S1.
  - [ ] **checks:** `forge test`; slow-preset integration test of S1 asserting the ranks.
- **Depends on:** A3, B3. **Open decisions:** none.
- **Acceptance criteria:**
  1. Under S1 on the slow preset, mine gets rank 1 deterministically.
  2. `claim` never reverts for late claimers.
  3. The output names the deciding effect (the tip).
- **Checks/evidence:** `forge test`, `npm test`, a manual demo.
- **Regression coverage:** all A and B tests.
- **Status:** accepted (2026-10-28)
- **Evidence:**
  - **Review:** PASS in r1. Packet `.crew/reviews/C1-r1.md`. Scope `cc465ad1…f4c9b1`, verify MATCH.
  - **Checks:** `forge build` exit 0; `forge test` 9/9; `npm run typecheck` exit 0; `npm test` exit 0, 191/191.
  - **Manual run** of `race --local --scenario s1`:
    - The feed saw `Opened` for block 9. The rival was sent at t0+0ms with a tip of 0.001 gwei, and mine at t0+51ms with 0.1 gwei.
    - In block 10, mine landed at idx 0 (rank 1) and the rival at idx 1 (rank 2), giving "same round → higher tip wins" and PASS.
    - `cast call … winner(uint256)` returned mine's address.
    - On a FIFO stack the rival wins and the run exits 1.
  - **Deviations:**
    - Race roles reuse idle accounts: operator 9, mine 0, rival 2.
    - Race is deployed at stack start.
    - `cast` prints the address left-padded.

### C2: A bot operator sees that information beats tip, and that both together win (S2, S3, matrix)

- **Outcome:** An operator runs `npm run race -- --local --scenario matrix --trials 5` and sees a win-rate table for S1, S2 and S3, plus the takeaway: "information gets you into the round; the tip wins the round".
- **Demo script:**
  1. `--scenario s2`: the rival polls via RPC with a high tip; mine uses the feed with a low tip. Mine wins, and the narration shows the rival arriving one or more rounds later.
  2. `--scenario s3`: mine (feed + high tip) wins.
  3. `--scenario matrix --trials 5` prints one table.
- **Stubbed or deferred:** none locally.
- **Satisfies:** R4.
- **Scope:**
  - Included: the polling watcher (interval default 250ms), the matrix runner, the S2/S3 sections and mermaid timeline in `docs/03-combo.md`.
- **Subtasks:**
  - [ ] **bots:** the polling watcher.
  - [ ] **runner:** the matrix.
  - [ ] **docs:** S2/S3 and the timeline.
  - [ ] **checks:** integration tests for S2 and S3.
- **Depends on:** C1. **Open decisions:** none.
- **Acceptance criteria:**
  1. Mine wins S2 and S3 on every slow-preset test run.
  2. The matrix is one readable table.
- **Checks/evidence:** `npm test`, a manual demo.
- **Regression coverage:** all earlier tests.
- **Status:** accepted (2026-10-28)
- **Evidence:**
  - **Review:** PASS in r3. r1 was REVISION_NEEDED (FIFO credited as "both", the `whyLines` direction, visibility after the rival's sighting). r2 was REVISION_NEEDED (feed-line narration for the poller, and the 80-column claim). Packets: `.crew/reviews/C2-r1..r3.md`. Scope `a8938ac2…f88a9f`, verify MATCH.
  - **Checks:** `forge build` exit 0, `forge test` exit 0 (gas bound and claim-never-reverts fuzz), `npm run typecheck` exit 0, `npm test` exit 0 with 223/223.
  - **Manual:** `race --local --scenario matrix --trials 2` exited 0 with S1 2/2 (tip), S2 2/2 (information), S3 2/2 (both) and the takeaway line. Ticket renewal happened mid-run.
  - **Deviations:**
    - S3 is defined as mine on the feed with tip 0.2 against a rival polling with tip 0.1.
    - The matrix retries an INCONCLUSIVE trial once and counts it as one trial.
    - Single S2/S3 runs buy a ticket for mine only.

### C3: A workshop attendee runs the complete, narrated Fast Feed + PGA demo locally

- **Outcome:** An attendee runs `npm run demo -- --local` and, with one command, sees the whole story narrated step by step:
  1. The accelerated-parameters banner (R8).
  2. Their wallets and a feed key.
  3. A ticket bought and activated.
  4. Connected to the Fast Feed in the live rounds view, with background traffic. The explanation: ordered → Fast Feed → block.
  5. **Bigger tip:** the demo injects our transaction with a tip above everything else in the traffic. The live view updates and shows it highlighted at index 0 of its round, with its tip and fee next to the competitors'. Narration: "PGA put us first in round R. The Fast Feed showed it Xms before block N was visible."
  6. The race: a trigger seen on the feed, a pre-signed claim fired with a chosen tip, the sequencer's round queue (local internals), the result.
  7. A closing recap of what Fast Feed did and what PGA did.
- **Demo script:**
  1. `git clone … && npm install`.
  2. `npm run demo -- --local`. It:
     - builds;
     - starts the stack;
     - prints numbered chapters with explanation lines and `[sequencer]` internal lines;
     - ends with "Mine: rank 1. Why: Fast Feed got us into round R (rival polled, arrived in R+1); in R our tip 0.1 gwei beat 0.001".
  3. `npm run demo -- --local --pause` waits for Enter between chapters, for live presenting.
- **Stubbed or deferred:** none locally. The testnet run is C4.
- **Satisfies:** R5, R6, R7.
- **Scope:**
  - Included:
    - `src/combo/demo.ts`, which composes the existing functions only (no new feature logic).
    - `--pause`.
    - The README "Run the full demo" section, pointing to the docs for each concept.
- **Subtasks:**
  - [ ] **demo:** chapters that call `wallets`, `key`, `tickets`, `fast-feed/live`, `sim/traffic` (local), `pga/tx` (inject the bigger tip), `pga/bot` and `combo/scenarios`.
  - [ ] **docs:** a README walkthrough with a sample transcript.
  - [ ] **checks:** an integration test that runs `demo --local` on the slow preset and asserts:
    - it exits 0 and prints every chapter header;
    - the injected tx is index 0 of its round in the live view, with a positive feed lead;
    - mine is at rank 1 in the race.
- **Depends on:** C2. **Open decisions:** none.
- **Acceptance criteria:**
  1. One command from a fresh clone (after `npm install` and with Foundry installed) completes the narrated demo.
  2. Every concept is explained in the terminal and links to the single doc section that covers it.
  3. No new feature logic lives in `demo.ts`; it only composes existing modules.
- **Checks/evidence:** `npm test`, a manual run transcript.
- **Regression coverage:** the full suite.
- **Status:** accepted (2026-10-28)
- **Evidence:**
  - **Review:** PASS in r3. Earlier rounds returned REVISION_NEEDED:
    - r1: FIFO and solo rounds were credited as PGA, and `--pause` could outlast the ticket.
    - r2: the periodic PGA footer still printed on FIFO.
    - Packets: `.crew/reviews/C3-r1..r3.md`. Scope `12841e80…749855`, verify MATCH.
  - **Checks:** `forge build` exit 0, `forge test` exit 0, `npm run typecheck` exit 0, `npm test` exit 0 with 248/248.
  - **Manual runs:**
    - With the user's real `.env`: `npm run demo -- --local` exited 0 through all 7 chapters. The `PRIVATE_KEY` wallet was shown by address only. Chapter 5 put the injected 1 gwei tx at index 0 among competitors, with a feed lead of about 1070ms. Race S3 passed, and the closing line came from the observed result. No raw-key-shaped tokens appeared.
    - Ctrl-C at chapter 4 exited 130 with no Anvil left behind.
    - FIFO stack: chapter 5 fails by name, and the recap states that PGA was not observed.
  - **Deviations:** `--testnet` is refused until C4. A FIFO stack fails chapter 5 (exit 1).

---

## Round 2: local follow-ups (requested 2026-10-28)

Local mode first. Delivery order: **D1 → B5 → B6 → C5 → C6 → C7 → C8 → D2**. D1 settles the layout, so later phases add files in their final place. D2 documents the result. Paths inside B5–C8 are pre-D1 names (see D1).

### D1: A contributor finds each feature in its own folder, with no leftover code

- **Outcome:** A contributor opens the repository and finds the Fast Feed, PGA and their combination in separate top-level folders. Each has its code, its tests and its doc, and the shared local stack sits in `sim/`. Every `npm run …` command, flag and output behaves exactly as before; only paths change. Code and files the workshop no longer needs are gone.
- **Final layout (user request, 2026-10-28):**

  ```text
  README.md                 intro, run the demo (--pause, then hands-off), reading the output, layout, links, contributing
  AGENTS.md                 project knowledge for agents
  package.json  tsconfig.json  foundry.toml  foundry.lock  .env.example  .gitignore
  shared/                   config.ts (presets, the single source of parameters), narrate.ts (printers)
  sim/                      the local stack both features run on (--local only)
    README.md               what --local models (was docs/simulator.md)
    index.ts cli.ts chain.ts rpc.ts sequencer.ts banner.ts build.ts build-cli.ts deploy.ts fund.ts traffic.ts
    test/
  fast-feed/                use the Fast Feed on its own
    README.md               concepts, commands, errors (was docs/01-fast-feed.md)
    client/                 client.ts feed.ts live.ts key.ts tickets.ts tickets-cli.ts access.ts abi.ts
    mock/                   feed.ts auth.ts (the local mock Fast Feed and its ticket auth)
    test/
  pga/                      use PGA on its own
    README.md               tips, rounds, nonce rule, zero tip, anti-starvation, probe (was docs/02-pga.md)
    rules/                  pga-core.ts (pure ordering rules)
    bot/                    bot.ts tx.ts common.ts flood.ts probe.ts
    scripts/demo.sh         cast demos 1-3
    video-script.md         was pga.md (content unchanged)
    test/
  combo/                    Fast Feed + PGA together: race and the full demo
    README.md               (was docs/03-combo.md)
    race.ts scenarios.ts demo.ts
    test/
  contracts/                one Foundry tree (forge has a single src dir)
    src/fast-feed/vendor/   Tickets.sol ITickets.sol README.md (source repo + commit)
    src/fast-feed/local/    TestToken.sol Proxy.sol
    src/combo/Race.sol
    test/combo/Race.t.sol
  docs/setup.md             install, .env, wallets, ports (was docs/00-setup.md)
  lib/                      forge submodules
  ```

- **Dependency rule** (stated in the README and checked by a test):
  - `fast-feed/` and `pga/` never import each other;
  - `combo/` is the only code that imports both;
  - `sim/` imports `pga/rules`, `fast-feed/mock`, `fast-feed/client/abi.ts` (the deploy ABI) and `shared/`;
  - nothing imports `combo/`.
- **Cleanup:**
  - **The `feed-ticket-contracts/` reference clone is removed** (git-ignored, local only). `contracts/src/fast-feed/vendor/README.md` keeps the GitHub link and the source commit `7cd464fe`, and the docs link to the official renewal bot on GitHub instead of the clone. Its `.gitignore` entry goes.
  - **Dead code** is removed: exports with no importer (excluding tests' own helpers), unused files, and unused npm scripts. They are found with `tsc --noUnusedLocals --noUnusedParameters` (one-off, not kept in config) and an importer grep, and every removal is listed in the review packet.
  - The empty `src/`, `scripts/` and old `docs/` files go after the move.
  - `pga.md` moves to `pga/video-script.md` with its content unchanged. This replaces the earlier "pga.md is not modified" constraint (user decision, 2026-10-28).
- **Paths in later phases:** phases B5–C8 and the testnet phases were written with pre-D1 paths (`src/pga/…`, `src/fast-feed/…`, `sim/pga-core.ts`, `docs/0x-…`). They apply to the new locations in the table above, and the brain translates them when delegating.
- **Demo script:**
  1. `npm ci && forge build && npm run typecheck && forge test && npm test`: all green, with the same test count as before the move.
  2. `npm run demo -- --local`: the same chapters and verdicts as before.
  3. `tree -L 2` (or `ls`) matches the layout above, and there is no `feed-ticket-contracts/`.
- **Stubbed or deferred:** the README rewrite (D2). D1 only fixes links broken by the moves.
- **Satisfies:** R6, R7.
- **Scope:**
  - Included:
    - file moves (`git mv`, so history follows);
    - import path updates;
    - `package.json` scripts and the test glob;
    - `tsconfig.json` `include`;
    - `foundry.toml` (`src`/`test` stay `contracts/src`/`contracts/test`, with the new subfolders);
    - `sim/build.ts` artifact paths;
    - `.gitignore`;
    - every relative doc link;
    - `AGENTS.md` paths and constraints;
    - the dependency-rule test;
    - the cleanup above.
  - Excluded: any behavior change. CLI names, flags, output text and exit codes stay identical.
- **Subtasks:**
  - [ ] **move:** files into the layout; update imports, scripts, configs and links.
  - [ ] **cleanup:**
    - remove the clone;
    - remove dead code (listed);
    - remove empty folders.
  - [ ] **checks:**
    - all cumulative checks;
    - a new `shared/test/layout.test.ts` that enforces the dependency rule by scanning imports;
    - a link check of every `.md`;
    - `git status` showing moves as renames.
- **Depends on:** C3 (the local stage). Runs first in this round, so B5–C8 add their files in the new layout. **Open decisions:** none.
- **Acceptance criteria:**
  1. The repository matches the layout above.
  2. `npm ci`, `forge build`, `npm run typecheck`, `forge test` and `npm test` pass, with no fewer tests than before.
  3. Every `npm run` command keeps its name, flags, output and exit codes. `bash -n pga/scripts/demo.sh` passes.
  4. The layout test passes: `fast-feed/` and `pga/` do not import each other, and only `combo/` imports both.
  5. `feed-ticket-contracts/` is gone, and the vendored contracts keep their source link and commit.
  6. Every removed export or file is listed in the packet and unused at removal time.
  7. All relative links in `.md` files resolve.
- **Checks/evidence:** the cumulative checks, the layout test, the link check, and a `demo --local` run.
- **Regression coverage:** the whole local suite (A1–A4, B1–B3, C1–C3).
- **Status:** accepted (r3 PASS, MATCH f55dde17)
- **Evidence:** `.crew/reviews/D1-r{1,2,3}.md`; typecheck clean, forge 11 pass, npm test 255/255 (248 before + 7 layout tests), link check 0 broken, `pga/video-script.md` hash = baseline `pga.md`, `demo --local` exit 0. `shared/test/layout.test.ts` enforces the dependency rule and no stray backup files.

### B5: A presenter slows the blocks down and shows a late, bigger-tip transaction slotting into the middle of an open round, with timestamps

- **Outcome:** A presenter starts the simulator with a long block time (`npm run sim -- --block-ms 20000`, so each round lasts 10 s). In a second terminal, `npm run pga:slot -- --local` sends 3 txs early in one round (tips 0.1, 0.01 and 0.001 gwei, lowest first). A few seconds later, still in the same round, it sends a 4th tx with a 0.05 gwei tip. The presenter sees:
  - **the Fast Feed** delivering all 4 in one round as 0.1, **0.05**, 0.01, 0.001, so the late tx is at `tx_index` 1;
  - **a timeline** with each tx's send time, its feed `timestamp_ms` (when the round was ordered, the same for all 4) and how long it waited. For example, the 0.001 tx arrived first and waited about 10 s, yet still came last. The late 0.05 tx waited about 5 s and came second. Arrival time bought no position: the tip did;
  - **the sequencer log** printing a line as each tx arrives, with its current rank in the still-open round ("rank 2 of 4"), so the 4th is seen slotting in before the round closes.
- **Why this is honest:** the Fast Feed publishes a tx only after its round is ordered and executed, so a tx already on the feed can never be overtaken. "In the middle" is possible only while the round is still taking in transactions. The command and `docs/02-pga.md` say this in one sentence. They also say that on Arbitrum One the same thing happens within a 125 ms round, and the slow block time only makes it visible to a person.
- **Demo script:**
  1. Terminal 1: `npm run sim -- --block-ms 20000`. The banner shows `block = 20000ms, round = 10000ms (Arbitrum One: 250ms, 125ms)`.
  2. Terminal 2 (optional): `npm run feed -- --local --live` shows the same round as a table.
  3. Terminal 3: `npm run pga:slot -- --local`. It buys or reuses a feed ticket and waits for it to activate, then:
     - syncs to a round tick;
     - sends the 3 early txs;
     - waits `--late-after-ms` (default: half the round) and sends the 0.05 tx;
     - prints the feed messages as they arrive, then the timeline table and a verdict.
  4. Terminal 1 prints arrival lines with the live rank, then the round's queue and drained order, with arrival offsets.
- **Stubbed or deferred:**
  - local only (`--testnet` is refused with an explanation: it needs tick sync and long rounds);
  - no "sent just after the round closed" contrast run (a possible follow-up);
  - "one round = one local block" (V6) is replaced in B6, which re-checks this command (it syncs to a block's first round).
- **Satisfies:** R1, R3, R7, R8.
- **Scope:**
  - Included:
    - `src/config.ts`: `--block-ms <ms>` / `SIM_BLOCK_MS` overrides B of the chosen preset (K stays 2). It must be a positive integer of at least 250. `sim_info`, the banner and `docs/simulator.md` show it.
    - `sim/sequencer.ts`: record each tx's arrival wall-clock time. Narrate one `internal()` line per arrival with the tx, its effective tip, its offset into the round and its tentative rank among the round's waiting txs (from the pure `selectRound`). Add the arrival offset to the existing queue and drained-order lines.
    - `combo/slot.ts` plus the `pga:slot` npm script. *(Placed in `combo/`, not `pga/`, because it reads the Fast Feed and D1's dependency rule forbids `pga/` importing `fast-feed/`; brain decision at delegation, 2026-10-28.)* It uses Anvil accounts 0–3, presigned raw type-2 txs (`presign`), the round-tick sync, and the existing ticket and feed client machinery used by race and demo. It refuses when the round is shorter than 2 s, with a hint to restart the sim with `--block-ms`. It also refuses `--testnet`.
    - The pure judge `judgeSlot` and the timeline formatter, which fits 80 columns.
    - `docs/02-pga.md`: a new section, "Demo 4: a late, bigger tip slots in"; the README step-by-step gets one line that links to it.
- **Subtasks:**
  - [ ] **config/sim:**
    - `--block-ms` / `SIM_BLOCK_MS`, validated and shown in the banner and `sim_info`;
    - arrival timestamps;
    - live-rank arrival narration.
  - [ ] **command:** `pga:slot`, covering send timing, feed capture, the timeline and the verdict.
  - [ ] **docs:**
    - `docs/02-pga.md` demo 4, with the "already-published txs are final" sentence;
    - `docs/simulator.md`, for `--block-ms`;
    - a README line.
  - [ ] **checks:**
    - Unit:
      - `--block-ms` parsing (valid, below 250, not an integer, missing value, env var);
      - the live rank for an arrival;
      - `judgeSlot` (PASS, late tx not at index 1, split rounds, FIFO);
      - the timeline formatting (80 columns).
    - Integration (slow preset with a longer block on alternate ports): the 4th tx, sent after the 3 but within the same round, lands at index 1 of the same block. On a `--fifo` stack it lands at index 3 and the command exits 1.
- **Depends on:** B1, A4 (feed client and tickets), C3 (ticket session reuse). **Open decisions:** none.
- **Acceptance criteria:**
  1. `npm run sim -- --block-ms 20000` runs 10 s rounds, and the banner and `sim_info` show B = 20000 ms next to Arbitrum One's 250 ms. Invalid values exit 2 with a one-line explanation.
  2. `pga:slot --local` sends the 4th tx after the other 3 (its send time is visibly later) and in the same round. The feed shows the 4 in one round, ordered 0.1, 0.05, 0.01, 0.001, with the late tx at `tx_index` 1.
  3. The timeline shows, for each tx: tip, send offset, feed `timestamp_ms` offset, wait (`timestamp_ms` − send time) and `tx_index`. A closing line names the earliest arrival that came last and the late tx that came second, stating that the tip decided.
  4. The sequencer log prints one line per arrival with its tentative rank, and the 4th arrival shows rank 2.
  5. Exit codes: 0 when the observed order matches; 1 for a wrong order (FIFO stack) or an error; 3 when the 4 txs did not share a round (retried once, then reported honestly); 2 for usage, a round too short, or `--testnet`.
  6. Docs say once that a tx already on the feed is final, and that inserting in the middle works only before the round closes.
- **Checks/evidence:** `npm run typecheck`, `npm test`, `forge build`, and a manual run with `--block-ms 20000` (transcript in the review packet).
- **Regression coverage:** the B1–B3 ordering tests, A4 live view tests, C3 demo tests (the preset parsing they share).
- **Status:** accepted (r1 PASS, MATCH d8bef468)
- **Evidence:** `.crew/reviews/B5-r1.md`; typecheck clean; npm test 276/276; manual `sim --block-ms 20000` + `pga:slot --local` PASS (late 0.05 tx at tx_index 1, sent +5.04 s; sequencer "rank 2 of 4"); `--block-ms 12.5` exit 2.

### B6: A presenter sees two PGA rounds inside one block, in slow motion, on the Fast Feed

- **Outcome:** The local simulator models Arbitrum One's structure: **K = 2 PGA rounds inside one block**. A presenter starts the slow-motion stack with `npm run sim -- --slowmo`. The block lasts 25 s with two 12.5 s rounds: Arbitrum One's 250 ms block and 125 ms rounds slowed down ×100. The presenter sees:
  - round 1's transactions on the Fast Feed with `block_number` N, `pga_round` 1, while block N is **still open** (not visible on RPC);
  - 12.5 s later, round 2's transactions on the feed with the **same** `block_number` N, `pga_round` 2. Their `tx_index` continues after round 1's;
  - block N becoming visible on RPC only after round 2, at the block boundary + `BLOCK_PUBLISH_DELAY_MS`;
  - the banner saying once: `slow motion ×100: round 12.5s (Arbitrum One: 125ms), block 25s (Arbitrum One: 250ms), 2 rounds per block`, followed by a `NOTE:` that txs published in round 1 are final before round 2 starts. The full explainer is in C8.
- **Replaces V6** ("one round = one local block") with **V6′: K rounds per local block**. This was the user's decision on 2026-10-28, choosing option (b) of V8.
- **Execution approach (an oracle decision before delegation, recorded in V10):** the feed needs real receipts for round 1 before the block is mined. Candidates:
  - **(1) Snapshot and re-mine.** Mine round 1 as a hidden Anvil block to obtain receipts and publish them. At round 2, `evm_revert` to the pre-block snapshot and mine one block with round 1 + round 2 txs in the same order, with the same timestamp and base fee. The proxy never reveals the intermediate block.
  - **(2) Simulate, then mine once.** Compute each round's receipts with `eth_simulateV1` (or `debug_traceCall`) on the open block's state, and mine the whole block at the block boundary.

  Whichever is chosen, **a receipt published on the feed for round 1 must equal the final block's receipt** (status, gas_used, cumulative_gas_used, logs, tx_index). A test enforces it.
- **Demo script:**
  1. `npm run sim -- --slowmo`; the banner shows the ×100 slowdown.
  2. `npm run feed -- --local --live`: rows of block N round 1 appear, "block N not visible yet" ticks, then the round 2 rows of block N appear, then block N becomes visible.
  3. `cast block latest --rpc-url http://127.0.0.1:8547` shows block N only after round 2.
- **Stubbed or deferred:** the block-full rule stays the `MAX_TXS_PER_ROUND` tx-count stand-in (now per round, with the remaining block capacity shared across rounds).
- **Satisfies:** R1, R2, R3, R7, R8.
- **Scope:**
  - Included:
    - `src/config.ts`:
      - `--slowmo` (B = 25000 ms, K = 2), built on B5's `--block-ms`;
      - the existing presets switch to K rounds per block (slow: 2000 ms with two 1000 ms rounds; fast: 250 ms with two 125 ms rounds, matching Arbitrum One).
    - `sim/sequencer.ts` and `sim/pga-core.ts`:
      - rounds accumulate into an open block;
      - `pga_round` runs 1..K;
      - `tx_index` is continuous across the rounds of a block;
      - the boost, gap hold and deferral keep working per round.
    - `sim/feed.ts`: publish after each round, carrying `pga_round`.
    - `sim/rpc.ts`: reveal at the block boundary only; the pending-nonce and duplicate rules span the open block.
    - The local `sim_msUntilNextRound` stays; add `sim_msUntilNextBlock` and `sim_blockInfo` (current block, round, round start).
    - **Every consumer that assumed "same block = same round"** is re-checked and fixed: `scripts/demo.sh` (verdict per round), `src/pga/{bot,flood,probe}.ts`, `src/combo/race.ts`/`scenarios.ts` judges, `src/fast-feed/live.ts` grouping (already keyed by `(block, pga_round)`), and B5's `pga:slot`, which syncs to a block's first round.
    - **Docs:** `docs/simulator.md` ("one round = one block" becomes "K rounds per block"), `docs/02-pga.md`, `docs/01-fast-feed.md`, and the `AGENTS.md` architecture entries that encode V6.
- **Subtasks:**
  - [ ] **oracle:** choose the execution approach (V10) and confirm, before code, that it is feasible with the installed Anvil.
  - [ ] **sim:**
    - the open-block model;
    - per-round execution and receipts;
    - block-boundary reveal;
    - the slow-motion flag and banner line.
  - [ ] **consumers:** update every "same block = same round" assumption listed above.
  - [ ] **docs:** simulator.md, 01, 02, README.
  - [ ] **checks:**
    - Unit: the round/block arithmetic; tx_index continuity; the pga-core boost and gap hold across rounds of one block.
    - Integration (slow preset, alternate ports):
      - two rounds in one block on the feed (`pga_round` 1 then 2, same `block_number`);
      - round 1 published before the block is visible;
      - feed receipts equal final receipts;
      - a high-tip tx in round 2 is placed after round 1's txs.
    - Full regression: `npm test` and `forge test`, all green.
- **Depends on:** B5 (`--block-ms`, arrival times). **Open decisions:** V10 (execution approach, oracle).
- **Acceptance criteria:**
  1. Locally a block contains up to K = 2 PGA rounds. Feed messages carry `pga_round` 1..K and the same `block_number` for one block.
  2. Round 1's messages arrive before round 2's, and both arrive before the block is visible on RPC.
  3. For every tx, the receipt fields in its feed message equal the mined block's receipt.
  4. `--slowmo` gives 25 s blocks and 12.5 s rounds, and the banner states the ×100 slowdown against Arbitrum One's values.
  5. Every existing demo, bot, probe, race and test passes with K rounds per block, with its judges updated so "same round" is checked by `(block, pga_round)`.
  6. `docs/simulator.md` and `AGENTS.md` no longer state "one round = one local block".
- **Checks/evidence:** `forge build`, `npm run typecheck`, `forge test`, `npm test`, `bash -n scripts/demo.sh`, a manual `sim --slowmo` + `feed --live` run.
- **Regression coverage:** the whole local suite (A1–A4, B1–B5, C1–C3).
- **Status:** accepted: B6a (r1 PASS, MATCH 226b3026), B6b (r2 PASS, MATCH 8e852a28)
- **Delivery split (V10):**
  - **B6a:** a presenter sees two rounds inside one block in slow motion. It covers `--slowmo`, the open-block model with snapshot and re-mine, the read gate, the reveal at the block boundary, the feed's `pga_round`, `sim_msUntilNextBlock` and `sim_blockInfo`, `pgaRound` in `sim_boostTrace`, the receipt check, the banner line and NOTE, the live view label, and the B5 carry-overs: a warning when `--block-ms` differs from a running stack, and an upper bound and even-B rule for `--block-ms`. It runs behind `SIM_ROUNDS_IN_BLOCK=on` (set by `--slowmo`); without the switch the behaviour is unchanged. Acceptance criteria 1–4, with integration tests on new ports using the slow preset plus the switch.
  - **B6b:** every bot, probe, race, demo, `demo.sh` and `pga:slot` is correct with K rounds per block. It makes the switch the default for all presets and then removes it, and updates the judges to `(block, pga_round)`, syncs to the start of a block where a scenario needs one round, and updates docs and `AGENTS.md`. Acceptance criteria 5–6, plus the full regression.
- **Evidence:** B6a: `.crew/reviews/B6a-r1.md`; Anvil facts F1–F8 confirmed (identical re-mine, about 40 ms); npm test 296/296; manual `--slowmo` run: block 5 round 1 and round 2 on the feed before the block was visible, `receiptMismatches` 0. B6b: `.crew/reviews/B6b-r{1,2}.md`; npm test 319/319; every preset K = 2; manual `demo --local` exit 0 (ch5 index 0 of round 2; S3 PASS mine block 14 round 2 vs rival block 15 round 1), `npm run pga -- --local` 1–3 PASS, `demo.sh 1/2/3` exit 0 "pga_round 1", probe 3/3 PGA-consistent.

### C5: A presenter runs the paused local demo with 30-second ticket rounds and sees the ticket round on screen

- **Outcome:** A presenter runs `npm run demo -- --local --pause`. The local ticket round is 30 s instead of 60 s. The presenter sees the ticket round length and where the ticket stands:
  - **chapter 3** says `ticket round = 30s (Arbitrum One: 24h)` and when the ticket activates and expires;
  - **after every Enter**, one line gives the time left in the current ticket round and whether the ticket was kept, renewed or rebought.
  Activation waits are about half as long, and a pause longer than about 30 s visibly triggers a renewal or rebuy.
- **Adaptive round (V9, user decision 2026-10-28):** the local ticket round is `max(30 s, 4 × B)`, so a purchase or renewal, visible only after its block closes, can still land in the round it was meant for. With B6 `--slowmo` (B = 25 s) it becomes 100 s. Whenever it is raised, the sim banner and demo chapter 3 print one `NOTE:` explaining the adaptation and its reason. An explicit `TICKET_ROUND_SECONDS` is respected, with a `NOTE:` warning when it is below 4 × B.
- **Decision (brain default, user may veto):** 30 s becomes the local default for every command (`LOCAL_TICKET_DEFAULTS.roundSeconds`), not only for `demo --pause`. This keeps one source of local parameters and one banner value. `TICKET_ROUND_SECONDS` still overrides it.
  - Alternative: apply 30 s only when the demo starts its own stack with `--pause`. It is narrower, but a running `npm run sim` would still use 60 s, and the demo would have to explain the mismatch.
- **Demo script:**
  1. Run `npm run sim`. The banner shows `ticket round = 30s (Arbitrum One: 24h)`.
  2. Run `npm run demo -- --local --pause`, press Enter through the chapters, and wait over 30 s at one pause. The next chapter prints the renew or rebuy line, the live view reconnects, and the demo still ends with "Mine: rank 1".
- **Stubbed or deferred:** none.
- **Satisfies:** R5, R8.
- **Scope:**
  - Included:
    - `src/config.ts`: the default changes from 60 to 30; the pure `ticketRoundSeconds(blockMs, env)` returns `max(30, 4 × B)` unless overridden, and reports whether it adapted.
    - `src/combo/demo.ts`: the round-length line in chapter 3 and the time-left line after each real pause.
    - **Timing budget check:** the 30 s round must still hold each chapter's ticket need. `NEED_MS` is 25 s in chapter 4 and 15 s in chapters 5–6; `RENEW_THRESHOLD_MS` and `MIN_TICKET_REMAINING_MS` are 15 s. Lower these only where a test shows a 30 s round cannot satisfy them, and record any change.
    - **Docs that say 60 s:** `docs/01-fast-feed.md` ("a ticket expires after a minute"), `README.md` (run time) and `docs/03-combo.md`.
  - Excluded:
    - the testnet ticket round, which comes from the Sepolia contract;
    - the Tickets contract.
- **Subtasks:**
  - [ ] **config:** the 30 s default; the banner follows automatically.
  - [ ] **demo:**
    - the chapter 3 line;
    - the post-pause line (time left, kept / renewed / rebought), built by a pure formatter.
  - [ ] **docs:** replace every "60s / a minute" statement about the local ticket round.
  - [ ] **checks:**
    - Unit:
      - the default is 30 and the env override still works;
      - `ticketRoundSeconds`: 30 for B = 2000 / 250, 100 for B = 25000, the override wins with a warning below 4 × B;
      - the post-pause line formatter;
      - `postPauseTicketAction` and `renewDecision` with a 30 s round.
    - Integration: the demo integration still passes. Tests that set `TICKET_ROUND_SECONDS` explicitly are unaffected.
- **Depends on:** C3; the adaptation is exercised for real once B6 adds `--slowmo` (unit-tested with any B before that). **Open decisions:** the veto on the global default above.
- **Acceptance criteria:**
  1. Without `TICKET_ROUND_SECONDS`, `npm run sim` and `sim_info` report a 30 s ticket round, and the banner prints it next to Arbitrum One's 24 h.
  2. `demo --local --pause` prints the ticket round length in chapter 3, and after each real pause prints the time left and the action taken.
  3. A pause longer than one ticket round leads to a rebuy or renewal, and the demo still completes (manual TTY run, transcript recorded; non-TTY covered by the pure-function tests).
  4. No doc or narration still states a 60 s local ticket round.
  5. With B ≥ 7.5 s (e.g. `--block-ms 25000`) the ticket round is 4 × B. The banner and demo print the `NOTE:` explaining the adaptation, and a purchase made right after a pause still activates.
- **Checks/evidence:** `npm run typecheck`, `npm test`, a manual `demo --local --pause` run on a real terminal.
- **Regression coverage:** the A2/A3 ticket and feed-rule tests, C1–C3 race and demo tests.
- **Status:** accepted (r2 PASS, MATCH 7936ea84)
- **Evidence:** `.crew/reviews/C5-r{1,2}.md`; npm test 332/332. Paused-demo pty runs: at the default B a 75 s pause led to a rebuy; at B = 8000 (32 s adapted round) the NOTE printed, then a rebuy and renewals; both ended "Mine: rank 1". `combo/test/ticket-large-b.integration.test.ts`. Ticket decisions now scale with B.

### C6: A presenter reads color-coded output where notes and important steps stand out

- **Outcome:** Everywhere a presenter runs the workshop (`sim`, `feed`, `pga`, `race`, `tickets:*`, `demo`, `scripts/demo.sh`), each kind of output has its own color, so it is easy to read on a projector:

  | Kind | Style | Example |
  |---|---|---|
  | Sequencer internals (`[sequencer]`) | its own color (magenta) | `[sequencer] round 2: drained order ...` |
  | Action happening (`==>` step) | cyan | `==> buying 1 ticket` |
  | **Important step** | bold, highlighted (inverse or bright) | `▶ CHAPTER 5: a bigger tip`, `YOUR TX: idx 0` |
  | Explanation that is not an action | starts with `NOTE:`, dim/yellow | `NOTE: a ticket bought in round N is active in round N+1 only` |
  | Tables (feed rows, timelines, matrix) | default (white); "yours" rows bold | |
  | Result: pass / fail / inconclusive | green / red / yellow | `PASS`, `FAIL`, `INCONCLUSIVE` |
  | Errors and refusals | red | `401: no active ticket ...` |

- **Rule:** every explanatory line that does not describe an action now happening starts with `NOTE:`. This holds in color and without color.
- **Readable hands-off demo:** `npm run demo -- --local` (no `--pause`) stops briefly after each chapter so the text can be read: about 3 s on a TTY, and none on a non-TTY so tests and CI stay fast. `DEMO_CHAPTER_DELAY_MS` overrides it (0 disables it). `--pause` still waits for Enter.
- **No ANSI codes** when stdout is not a terminal, or when `NO_COLOR` is set. `FORCE_COLOR=1` forces color. Logs, pipes and tests stay plain text.
- **Demo script:**
  1. `npm run demo -- --local --pause`, in a real terminal: chapters stand out as highlighted headers, `[sequencer]` lines are magenta, notes start with `NOTE:`, and tables are white.
  2. `npm run demo -- --local | cat`: identical text, with no escape codes.
- **Stubbed or deferred:** no themes and no configuration beyond `NO_COLOR`/`FORCE_COLOR`.
- **Satisfies:** R5, R7, R8.
- **Scope:**
  - Included:
    - `src/narrate.ts` becomes the single palette and printer: `step`, `note`, `important`, `internal`, `result`, `error`, plus a `color` helper that knows about TTY, `NO_COLOR` and `FORCE_COLOR`. `explain` is renamed to, or prints through, `note` with the `NOTE:` prefix.
    - Every direct `console.log` of narration in `sim/`, `src/` and the CLIs is routed through it. The ad-hoc `BOLD` in `src/fast-feed/live.ts` moves into the palette.
    - `scripts/demo.sh`: the same categories via `tput` or ANSI, gated on `[ -t 1 ]` and `NO_COLOR`.
    - Docs: one short "Reading the output" section in the README with the table above.
    - `src/combo/demo.ts`: the chapter delay for the hands-off run (pure `chapterDelayMs(isTTY, pause, env)`).
- **Subtasks:**
  - [ ] **narrate:** the palette, the gating and the printers.
  - [ ] **call sites:**
    - route narration through the printers;
    - add the `NOTE:` prefix to explanations;
    - mark important steps: chapter headers, your transaction's result, verdicts.
  - [ ] **demo.sh:** colors with the same gating.
  - [ ] **docs:** README section; update doc sample outputs that now show `NOTE:`.
  - [ ] **checks:**
    - Unit:
      - the gating (TTY / non-TTY / `NO_COLOR` / `FORCE_COLOR`);
      - each printer's prefix;
      - `note()` always starts with `NOTE:`.
    - CLI smoke: piped output of sim, feed, pga and demo contains no `\x1b[`.
    - Existing tests that match output text are updated for `NOTE:` only.
- **Depends on:** C3 (the existing narration). Delivered before C7 and C8 so their new output uses the palette. **Open decisions:** none (exact colors may be tuned during review).
- **Acceptance criteria:**
  1. On a TTY the categories in the table are visually distinct, `[sequencer]` lines included.
  2. Every non-action explanation starts with `NOTE:`.
  3. Chapter headers, the user's own transaction result and verdicts are highlighted.
  4. Piped output and `NO_COLOR=1` contain no escape codes.
  5. `scripts/demo.sh` follows the same rules.
  6. The hands-off demo pauses about 3 s between chapters on a TTY, never on a non-TTY, and `DEMO_CHAPTER_DELAY_MS` overrides it.
- **Checks/evidence:** `npm run typecheck`, `npm test`, `bash -n scripts/demo.sh`, a manual TTY run (described in the packet).
- **Regression coverage:** every CLI smoke test and the output-matching integration tests.
- **Status:** accepted (r2 PASS, MATCH b0bacc60)
- **Evidence:** `.crew/reviews/C6-r{1,2}.md`; npm test 350/350. Pty demo showed the palette codes and about 3 s chapter delays. The piped demo had 0 escape bytes. A pty matrix run printed the notes in yellow. Real piped runs assert no escapes.

### C7: A presenter watches one live, in-place panel of the open block during the paused demo, with each transaction's Fast Feed lead over a direct sequencer read

- **Outcome:** During `npm run demo -- --local --pause` (chapter 4, on a terminal), the presenter sees a single panel redrawn in place. It shows the **open block** and the **previous, closed block**, nothing more. With B6's K rounds per block:
  - round 1's rows appear under the open block, then round 2's rows appear under **the same block**, each round labelled (`round 1/2`, `round 2/2`);
  - a ticking status line shows `block N: not visible on the sequencer RPC yet, +14.2s`;
  - when the block becomes visible on a **direct read of the sequencer RPC** (`eth_getBlockByNumber` polled on the sequencer endpoint), the block is marked closed and a final column, **`FF lead`**, fills in for every row. It is `blockVisibleAt − feedReceivedAt`, how much earlier the Fast Feed showed that transaction than reading the sequencer for the finalized block would. That is the Fast Feed's advantage. Round 1 rows show a larger lead than round 2 rows, which is the point;
  - the panel then rolls: the closed block becomes "previous" and the next block opens.
- **Demo script:**
  1. `npm run demo -- --local --pause`. The demo starts its own stack in slow motion (B6 `--slowmo`), or, when attached to a running `npm run sim`, prints its block and round times with a `NOTE:` hint to use `--slowmo`.
  2. Press Enter to chapter 4. The panel fills round 1, then round 2, of block N. The timer ticks. Block N closes, `FF lead` appears (e.g. `+26.1s` for round 1 rows, `+13.6s` for round 2 rows), and the panel rolls.
- **Stubbed or deferred:**
  - non-TTY output (CI, pipes, `--pause` ignored) keeps the scrolling tables, plus the `FF lead` column;
  - `feed --live` outside the demo keeps scrolling unless it later gets `--panel` (out of scope).
- **Satisfies:** R2, R5, R8.
- **Scope:**
  - Included:
    - `src/fast-feed/live.ts`:
      - row-level `onRow` events;
      - a per-block `blockVisibleAt` taken from the existing block-visible probe, which polls the sequencer RPC;
      - the per-row lead;
      - a pure `formatPanel(openBlock, previousBlock, nowMs)` within 80 columns, using C6's palette.
      - The 300 ms round-completion rule becomes block-aware: a block completes when it is visible, or when a later block's row arrives.
    - `src/combo/demo.ts`: the TTY panel with ANSI cursor redraws at most every 100 ms; Ctrl-C restores the cursor and exits 130 as today.
    - `docs/01-fast-feed.md`: the panel and the `FF lead` definition ("feed message vs direct sequencer read of the finalized block").
- **Subtasks:**
  - [ ] **live view:**
    - row events;
    - per-block grouping with round labels;
    - `blockVisibleAt` and the lead;
    - `formatPanel`.
  - [ ] **demo:**
    - the TTY panel renderer;
    - a non-TTY fallback;
    - cursor restore.
  - [ ] **docs:** the live-view section with a sample.
  - [ ] **checks:**
    - Unit: `formatPanel` (open block with round 1 only, then both rounds, closed with leads, roll, 80 columns, "not visible" fallback); lead ≥ 0; only two blocks kept.
    - Integration: on the slow preset, round 1 and round 2 rows of one block arrive before `blockVisibleAt`; round 1 leads exceed round 2 leads; the non-TTY demo still passes.
- **Depends on:** B6 (rounds inside a block), C5 (ticket timing), C6 (palette). **Open decisions:** none.
- **Acceptance criteria:**
  1. On a TTY the demo's live chapter shows at most two blocks, redrawn in place.
  2. Rows appear per round inside the open block, labelled with their round, while the not-visible timer runs.
  3. When the sequencer RPC returns the block, every row shows `FF lead` = block visible on a direct sequencer read − feed receipt, which is positive. Round 1 rows of a block show a larger lead than its round 2 rows.
  4. Non-TTY output stays line-based and includes `FF lead`.
  5. Ctrl-C leaves the terminal intact.
- **Checks/evidence:** `npm run typecheck`, `npm test`, a manual TTY run.
- **Regression coverage:** the A4 live-view tests and the C3 demo tests.
- **Status:** accepted (r3 PASS, MATCH 345b9135)
- **Evidence:** `.crew/reviews/C7-r{1,2,3}.md`; npm test 375/375. In the paused slow-motion pty demo, block 10 showed round 1 (10 txs), then round 2 (3 txs) with a running timer, then [closed] with FF lead +12.65 s for round 1 and +0.15 s for round 2, then the roll. Ctrl-C exited 130 with the cursor restored. The piped run had no escape bytes and printed FF lead lines. The plan's guessed values (+26.1 s / +13.6 s) were wrong: round 1 is published at the end of its round, and the block is revealed right after round 2.

### C8: In the paused demo, a presenter injects their tipped transaction into the second round of an open block and sees the FCFS order it would have had

- **Outcome:** In `npm run demo -- --local --pause`, chapter 5 now:
  1. **Waits for round 1 of a block** to show on the C7 panel. A `NOTE:` says that block N is still open and the Fast Feed already shows its ordered transactions.
  2. Prompts `Press Enter to send your 1 gwei-tip tx into round 2 of block N`. On Enter it sends the presigned tx timed into round 2 of the same block, using `sim_blockInfo`.
  3. **The presenter sees it appear on the panel** in round 2 of block N, first among round 2's txs, with its `tx_index` after round 1's, before block N is visible. Then `FF lead` fills in when the block closes.
  4. **An important highlighted line** names it: "your tx: block N, round 2, first in its round (tip 1 gwei)".
  5. **A timing table,** printed after the block closes, with one row per transaction of that block and three timestamps (offsets from round 1's start):
     - **arrived at sequencer:** simulator-only, hypothetical on Arbitrum, which does not publish it;
     - **seen on Fast Feed:** when our feed connection received the message;
     - **block finished:** when the block became visible on a direct sequencer RPC read, which is when a non-Fast-Feed reader learns about the tx.

     The table also shows the gaps between them: FF lead = block finished − seen on FF, and wait = seen on FF − arrived.
  6. **A hypothetical FCFS table,** next to the real PGA order for that round. It orders the same transactions by their **arrival time at the sequencer** and shows the gap between consecutive arrivals in ms. It also shows where your tx would have landed under first-come-first-served. A `NOTE:` explains that under FCFS position is decided by connection latency, a race you can only win by being closer to the sequencer, while under PGA the tip decides.
- **The "two rounds in one block" explainer (user request, 2026-10-28), printed so it is unmistakable.** Before the injection, chapter 5 prints this picture with the local slow-motion times. After block N closes it prints it again, filled with the real short hashes (A, B, C = round 1's txs; X = yours; D, E = the others in round 2):

  ```text
  On Arbitrum One a 250ms block holds two 125ms PGA rounds (here slowed x100: 25s / 12.5s):

    block N  ──────────────────────────────────────────────
      round 1 (0–125ms):   A, B, C   ordered + executed → feed publishes A,B,C
                                      you see C, react, send X
      round 2 (125–250ms): X, D, E   X competes here by tip
  ```

  It is followed by these lines, the second and third highlighted (C6):
  - `You saw A, B and C on the feed. You sent X, and it landed in round 2 of the same block: "in the middle of the block".`
  - `A, B and C were already final: ordered and executed. Nothing you send can go before them or change their outcome.`
  - `In round 2 you competed blind: X was ranked against D and E by effective tip. You never saw D or E before they were ordered; they reach the feed only after round 2 executes.`

  These lines are built from what was observed by a pure `formatTwoRoundsExplainer(observed)`. If X did not land in round 2 of block N, the picture shows where it did land, and the lines say so instead of claiming the ideal case. The same picture, with generic letters, opens the B6 section of `pga/README.md` and the paused demo walkthrough in `combo/README.md` (D2).
- **Honesty:**
  - Arrival times are **simulator-only** data (a local `sim_arrivals(block, round)` RPC built on B5's arrival timestamps). The table is labelled `hypothetical FCFS (local simulator data)`, and a `NOTE:` says Arbitrum does not publish arrival times.
  - Within a round PGA reorders by tip, but round 2 txs never move ahead of round 1 txs that are already published. The demo states this once.
- **Demo script:**
  1. `npm run demo -- --local --pause`; go to chapter 5.
  2. Watch round 1 of block N on the panel and press Enter. Your tx shows up in round 2 of block N, first in that round.
  3. The block closes, the leads fill in, and the PGA vs FCFS table prints. With FCFS your tx would be, for example, 4th because 3 traffic txs arrived earlier. With PGA it is 1st in its round.
- **Stubbed or deferred:**
  - non-TTY (no `--pause`): the injection is timed into round 2 automatically, with the same output;
  - testnet: no arrival data, so the FCFS table is local only.
- **Satisfies:** R3, R5, R8.
- **Scope:**
  - Included:
    - `sim/rpc.ts` + `sim/sequencer.ts`: `sim_arrivals` (local-only, documented in `docs/simulator.md`).
    - `src/combo/demo.ts`:
      - the round-2 injection;
      - the Enter prompt (TTY only);
      - the pure `judgeRound2Injection` replacing or extending `judgeBiggerTip`: it requires the same block, round 2, first in round 2 and a PGA stack, and fails FIFO by name.
    - The pure `formatTimingTable(rows, arrivals, feedReceivedAt, blockVisibleAt)` and `formatFcfsComparison(pgaRows, arrivals)`, each within 80 columns.
    - The recap line updated to match.
    - `docs/03-combo.md` / `docs/02-pga.md`: one paragraph on why FCFS is a latency race.
- **Subtasks:**
  - [ ] **sim:** `sim_arrivals`.
  - [ ] **demo:**
    - round-2 timing and prompt;
    - the judge;
    - the FCFS comparison;
    - the recap.
  - [ ] **docs:** the paragraph and the sample table.
  - [ ] **checks:**
    - Unit:
      - `judgeRound2Injection` (pass; round 1 instead of round 2; not first; FIFO);
      - `formatTwoRoundsExplainer` (the ideal case with real hashes; X in round 1 or in the next block, which must not claim round 2; no D/E in round 2; 80 columns);
      - `formatTimingTable` (three timestamps, arrival ≤ FF ≤ block finished, FF lead and wait, simulator-only label, 80 columns);
      - `formatFcfsComparison` (orders by arrival, marks yours, gaps in ms, 80 columns);
      - `sim_arrivals` shape.
    - Integration (slow preset, non-TTY): the injected tx lands in round 2 of the block whose round 1 was observed, first among round 2's txs, before block visibility. The FCFS table puts it behind the earlier-arriving traffic txs.
- **Depends on:** B5 (arrival times), B6 (rounds in a block), C5 (adaptive ticket round), C6 (palette), C7 (panel). **Open decisions:** none.
- **Acceptance criteria:**
  1. With `--pause` on a TTY, the demo shows round 1 of an open block, waits for Enter, and the tx lands in round 2 of that **same** block, first in its round, visible on the feed before the block closes.
  2. The highlighted line states block, round and position. The two-rounds explainer prints before the injection (template) and after the block closes, filled with the observed hashes. Its "A, B, C final / compete blind against D, E" lines match what happened, or say what differed.
  3. After the block closes, the timing table shows each tx's arrival at the sequencer (labelled simulator-only), its Fast Feed receipt and its block-finished time, with the FF lead and the wait. The PGA vs hypothetical FCFS table shows your tx's real position and its FCFS position by arrival, with arrival gaps. It is labelled as local simulator data, with the latency-race `NOTE:`.
  4. On a FIFO stack the chapter fails by name, and the recap says PGA was not observed.
  5. Without a TTY, the same flow runs without the prompt.
- **Checks/evidence:** `npm run typecheck`, `npm test`, a manual TTY run.
- **Regression coverage:** the C3 demo tests and the B1/B6 ordering tests.
- **Status:** accepted (r3 PASS, MATCH 935eae76)
- **Evidence:** `.crew/reviews/C8-r{1,2,3}.md`; npm test 398/398. Paused slow-motion pty demo: the template explainer printed first, then round 1 of block 12 on the panel and the prompt. After Enter, X was first in round 2 of block 12 before the block was visible. Then the YOUR TX line, the timing table, FCFS (position 1 of 14 under PGA vs 4 under FCFS) and the filled explainer, ending "Mine: rank 1". On FIFO the chapter fails by name and uses arrival wording. The competitors (accounts 3–5) were a brain decision. `sim_arrivals` keeps the last 32 blocks.

### D2: A newcomer reads a short root README, then uses the Fast Feed and PGA separately from their own READMEs

- **Outcome:** A newcomer opens `README.md` and reads, in order:
  1. **Intro:** what PGA and the Fast Feed are, in a few lines, plus the "not production, throwaway wallets" warning.
  2. **Run the demo:** first `npm run demo -- --local --pause` (presenting: Enter between chapters), then `npm run demo -- --local` (hands-off: it stops about 3 s after each chapter so it can be read, per C6). It includes the chapter table, run time and exit codes, kept short.
  3. **Reading the output:** the C6 color legend (sequencer, actions, important steps, `NOTE:`, tables, results, errors).
  4. **Repository layout:** the D1 tree, with one line per folder and the dependency rule.
  5. **Where next:** links to `fast-feed/README.md`, `pga/README.md`, `combo/README.md`, `sim/README.md` and `docs/setup.md`.
  6. **Contributing:**
     - setup and checks (`npm ci`, `forge build`, `npm run typecheck`, `forge test`, `npm test`);
     - the dependency rule;
     - print through `shared/narrate.ts` (colors, `NOTE:` for explanations);
     - every `--local` acceleration shown in the banner;
     - no secrets, `.env` git-ignored, throwaway wallets;
     - small PRs with tests.
- **Feature READMEs** (each self-contained: concepts, where the code is, commands in order, what you should see, its command reference):
  - **`fast-feed/README.md`, the Fast Feed alone.**
    - Code: `fast-feed/client/` (client, CLI, live view, tickets, key, access rule) and `fast-feed/mock/` (local mock feed and auth).
    - Commands: `npm run sim` → `npm run key:new` → `npm run tickets:buy -- --local` → `npm run feed -- --local` (then `--live`, `--reconnect`), plus `npm run traffic -- --local` for load. It includes the error table.
  - **`pga/README.md`, PGA alone, no ticket needed.**
    - Code: `pga/rules/pga-core.ts` (the ordering rules) and `pga/bot/`. The round loop is `sim/sequencer.ts`.
    - Commands: `pga/scripts/demo.sh 1|2|3`, `npm run pga -- --local --scenario 1|2|3|flood`, `npm run pga:probe -- --local`, `npm run pga:slot -- --local` (B5), and `npm run sim -- --slowmo` (B6).
    - **Your own tip, with no code change:** `cast send … --priority-gas-price 0.05gwei --rpc-url http://127.0.0.1:8547`, then its position in the sim log or `cast receipt`. The bot has no `--tip` flag; adding one would be a code change, offered as a follow-up.
  - **`combo/README.md`, both together:** the race (S1–S3, matrix) and the full demo walkthrough, including the C7 panel, the C8 round-2 injection and the timing and FCFS tables.
  - **`sim/README.md`:** what `--local` models and every assumption, including K rounds per block, slow motion and the adaptive ticket round.
- **No source code changes in this phase** (docs only).
- **Demo script:**
  1. Read the root README top to bottom and run both demo commands.
  2. Follow `fast-feed/README.md` alone in a fresh terminal; it ends at `feed --live`.
  3. Follow `pga/README.md` alone with no key or ticket; it ends at `demo.sh 1` and a `cast send` with a custom tip.
- **Stubbed or deferred:** the testnet sections, which the testnet stage fills in; a `--tip` flag (code).
- **Satisfies:** R5, R6, R7.
- **Scope:**
  - Included:
    - the root `README.md` rewrite (short);
    - `fast-feed/README.md`, `pga/README.md`, `combo/README.md`, `sim/README.md`, `docs/setup.md`, with content moved from the old README step-by-step and command reference so each concept is written once;
    - sample outputs updated for B5–C8 and the colors / `NOTE:` (C6).
  - Excluded: any `.ts`, `.sol` or `.sh` change.
- **Subtasks:**
  - [ ] **root README:** the six sections above.
  - [ ] **feature READMEs:** the tracks, each with its command reference.
  - [ ] **checks:**
    - every command shown exists in `package.json` or as a script;
    - every flag shown is accepted by its parser;
    - every path exists;
    - every relative link resolves;
    - a manual walk-through of both tracks.
- **Depends on:** D1 (layout) and B5–C8 (the features the READMEs describe). **Open decisions:** none.
- **Acceptance criteria:**
  1. The root README has exactly: intro, run the demo (`--pause` first, then hands-off, mentioning the chapter stops), reading the output (color legend), layout, links, contributing.
  2. `fast-feed/README.md` and `pga/README.md` can each be followed alone. The PGA track needs no ticket and shows a custom-tip `cast send`.
  3. Each concept is explained in one place; the others link to it.
  4. Every command, flag, path and link in the READMEs is valid.
  5. The scope diff contains only `.md` files.
- **Checks/evidence:** the command, flag, path and link checks; `npm test` unchanged and green; the manual walk-through.
- **Regression coverage:** n/a (docs only).
- **Status:** accepted (r2 PASS, MATCH 625adba6)
- **Evidence:** `.crew/reviews/D2-r{1,2}.md`; only .md files changed; link check 0 broken; the scripts and flags shown exist; the PGA track was run alone (sim, `demo.sh 1`, custom-tip `cast send`) and the Fast Feed track was run alone (key with a scratch env file, ticket, feed `--live`).

---

## Round 3: terminal QA of everything we demo (requested 2026-10-29)

User request: "create a plan to test in terminal the behaviour of the app in local. test the pause functionality and all that we're going to demo. if there are bugs fix it and re run until there are no bugs. after creating the plan execute it." Authorized in the same message.

**Method (all phases):**
- **Real terminals.** Each run goes through a real pseudo-terminal driven by `expect` (macOS `/usr/bin/expect`), which presses Enter, Ctrl-C and resizes the window like a presenter would. Piped runs are separate cases. Transcripts are kept in `.crew/qa/` (git-ignored), never in the repo.
- **No secrets.** Always `ENV_FILE=<scratch env>` or `/nonexistent`; `.env` is never read; `key:new` writes only to a scratch env file. No testnet.
- **Bug loop.** The brain runs every case and records `PASS`/`BUG`. A bug is: wrong or missing output against the docs (`README.md`, `combo/README.md`, feature READMEs) or `AGENTS.md`, a hang, a wrong exit code, a broken terminal after exit (cursor hidden, raw mode left on, echo off), a leaked process (Anvil, tsx) or an escape code where colour should be off. Each bug goes to `executor` with its transcript; the fix comes with a regression test where one is practical. The case and its phase are re-run until clean. The user asked to repeat until there are no bugs, so the two-round correction cap does not apply here; a bug that needs a product decision is stopped and asked.
- **Review.** A phase that changed source gets the normal review (scope, packet, reviewer PASS, MATCH). A phase with no source change is accepted on its transcripts.
- **Cumulative checks after any fix:** `npm run typecheck`, `forge test`, `ENV_FILE=/nonexistent npm test`, `bash -n pga/scripts/demo.sh`.

### Q1: A presenter runs the paused demo in a real terminal, from Enter to Enter, and every pause, prompt and panel behaves

- **Cases:**
  1. `npm run demo -- --local --pause` on a TTY, self-started (slow motion). Enter for each chapter. Expect:
     - the slow-motion banner;
     - one ticket line after every Enter;
     - the chapter 4 panel redrawn in place (open + previous block, `round R/K`, FF lead);
     - the chapter 5 Enter prompt inside the panel, then your tx first in round 2, the timing table and the FCFS comparison;
     - race S3 with mine at rank 1;
     - the recap;
     - exit 0, cursor visible, terminal sane (`stty` unchanged), no Anvil left.
  2. Ctrl-C at a chapter prompt and at the chapter-5 raw prompt: exit 130, cursor restored, `stty` unchanged, Anvil gone.
  3. A long pause before chapter 4/5/6 (longer than the ticket's life): the ticket line says renewed or rebought, and the live view still works.
  4. Late Enter at the chapter-5 prompt (round 2 has passed): the retarget path picks the next round 2, or the chapter says INCONCLUSIVE honestly.
- **Acceptance:** every case PASS on its latest run.

### Q2: A presenter runs the paused demo against the stack variants they may meet

- **Cases:**
  1. Attached to `npm run sim -- --slowmo`: no self-start, slow-motion times printed, the panel works, and exiting leaves the sim running.
  2. Attached to the default `npm run sim`: times printed, plus the `NOTE:` hint to restart with `--slowmo`.
  3. `DEMO_SLOWMO=0` self-start: default preset.
  4. `NO_COLOR=1` on a TTY: the panel still redraws in place, with no colour codes.
  5. A short terminal (e.g. 20 rows): the panel is cut, previous block first, with no scrolling garbage.
  6. `--pause` with stdin not a TTY: the note, no waiting.
  7. `--fifo` stack: chapter 5 fails by name; the recap says PGA was not observed.
- **Acceptance:** every case PASS on its latest run.

### Q3: An attendee runs the hands-off demo and sees the same story without pressing anything

- **Cases:**
  1. `npm run demo -- --local` on a TTY: about a 3 s stop after each chapter, the panel, exit 0.
  2. The same, piped to a file: no escape codes, `FF lead` lines, no delay, exit 0.
  3. `DEMO_CHAPTER_DELAY_MS=0` and an invalid value (exit 2).
- **Acceptance:** every case PASS on its latest run.

### Q4: A presenter runs every feature demo from the READMEs in a terminal

- **Cases:**
  1. **Fast Feed track** (`fast-feed/README.md`):
     - `npm run sim`;
     - `key:new` into a scratch env file;
     - `tickets:status`, `tickets:buy`;
     - `feed --local`: 401 before activation, connected after;
     - a second connection with one ticket → 429;
     - expiry → 1008;
     - `feed --local --live` with `traffic --local`, including the `round R/K` labels.
  2. **PGA track** (`pga/README.md`):
     - `pga/scripts/demo.sh 1|2|3`;
     - `npm run pga -- --local --scenario all`, then `flood` on a capped stack;
     - `pga:probe`;
     - `npm run sim -- --block-ms 20000` + `pga:slot`;
     - the custom-tip `cast send` from the README.
  3. **Race:**
     - `npm run race -- --local --scenario s1|s2|s3`;
     - `--scenario matrix --trials 3` on the default preset, and once on `--slowmo`.
  4. **Usage errors:** bad flags exit 2 with a readable message (`--block-ms 251`, `--slowmo --block-ms 2000`, `demo --testnet`).
- **Acceptance:** every case PASS on its latest run; any README command that fails is a bug (code or doc).

- **Depends on:** round 2 (accepted). **Open decisions:** none.
- **Status:** pending

---

## Round 4: demo storytelling (requested 2026-10-29)

User request (summarized): shorter chapters 1–3; no long ticket wait; chapter 4 tells one block's story (round 1, then our 1 gwei tx at the top of round 2 of the SAME block, then "block ordered and executed by the sequencer"); the simulator stops in the background while the presenter explains, and the ticket round continues where it was on resume. Round 3 QA fixes (unreviewed) are folded into the first phase's review; Round 3 QA (Q1–Q4) is re-run on the new chapters afterwards.

### E1: A presenter gets through chapters 1–3 in under a minute with only the lines worth saying

- **Chapter 1:** the accelerated configuration as one table (parameter · local · Arbitrum One) plus at most 4–5 lines of notes.
- **Chapter 2:** drop the `npm run key:new` note.
- **Chapter 3:**
  - drop the "ticket round N: …s left · no ticket yet" line and every `==> mined in block X` line (mint/approve/deposit/purchase are summarized in one or two lines);
  - the ticket purchase starts in the background at demo start, so chapter 3 mostly waits only for the activation (the ≤ 20 s cap comes with E2);
  - one NOTE: locally a ticket round is N s, on Arbitrum One 24 h.
- **Acceptance:** each chapter's line budget is met (pinned by tests); chapter 3 prints a waiting step when more than 20 s remain; `npm test` green. The ≤ 20 s cap on the chapter-3 wait moved to E2 (brain, 2026-10-29, after E1-r1): it needs E2's simulator clock to skip to the next ticket round, which the user's "max 20 seconds" request and the approved freeze design both cover.

### E2: A presenter pauses and the simulator freezes in the background; on Enter everything continues in the same ticket round

- **Design (to confirm):** a simulator clock with a pause offset.
  - `sim_pause`/`sim_resume` (local RPC) stop the round loop and traffic, and freeze the chain's notion of now.
  - These all read the simulator clock instead of `Date.now()`:
    - `withNow`;
    - the sequencer's round schedule and block timestamps;
    - the feed's ticket rollover check;
    - `sim_blockInfo` and `sim_msUntilNextBlock`.
  - After resume the ticket round has the same time left as at the pause.
- **The demo:** pauses the stack at every `--pause` Enter wait (owned or attached stack, with a NOTE); the post-pause renew/rebuy stays only as a fallback.
- **Design accepted (oracle ad13d3e0 + brain, 2026-10-29):** one `SimClock` (`sim/clock.ts`): `simNow = (pausedAt ?? wall) − pausedTotal`, `chainNow = simNow + skipped`; local RPC `sim_pause({holder, at:'now'|'afterRound1', leaseMs})` / `sim_resume` / `sim_skipTo` / `sim_clock`; pauses only between round ticks (snapshot/re-mine and RwGate untouched); wall time kept for arrival/order/receive times. Brain's choices on the oracle's open questions: 15 s heartbeat lease, auto-resume on expiry, another holder is refused (the demo falls back to today's renew/rebuy); clock skip only on a stack the demo owns; standalone `npm run traffic` follows pauses.
- **Clock skip:** `sim_skipTo` moves the chain clock forward to the next ticket round (forward only, at most one ticket round + 60 s, only when no block is open; narrated in the sim log). Demo chapter 3 uses it when more than 20 s of activation wait remain.
- **Acceptance:** a 5-minute pause leaves the ticket round's remaining time unchanged (±1 block); no 1008 during a pause; block timestamps stay monotonic; integration test with a pause longer than a ticket round; the chapter-3 wait is ≤ 20 s on the slow-motion and default presets (moved here from E1) once the background purchase has landed; in slow motion the purchase itself needs about 4 blocks (~100 s) of the presenter's chapters 1–2, during which the simulator keeps running (brain, 2026-10-29, after E2-r2: the only alternatives are a faster pre-chapter-4 clock or a pre-bought ticket, both outside the approved design; to be confirmed with the user).

### E3: A presenter shows one block: round 1, then their 1 gwei tx at the top of round 2 of the same block, then the sealed block

- **Chapter 4 (chapters 4 and 5 merged; the demo has 6 chapters):**
  1. "block X: round 1 (125 ms on Arbitrum One; here …)";
  2. round 1's txs;
  3. NOTE "Process slowed down for the demo: inserting a transaction with a bigger tip in round 2";
  4. our 1 gwei tx (plus the lower-tip competitors) shown at the top of round 2 of block X;
  5. "block X ordered and executed by the sequencer (250 ms on Arbitrum One; here …)";
  6. the simulator then pauses (E2) while the presenter explains.
- **Same block guaranteed:** the demo holds the open block's round 2 (via the E2 pause) until our tx is submitted, so it can never land in a later block.
- **Acceptance:** in 5/5 slow-motion and default runs, the tx is index 0 of round 2 of the block whose round 1 was shown; the FCFS comparison and timing table are kept (shortened).

- **Depends on:** Round 3 fixes. **Status:** authorized 2026-10-29 (E1 → E2 → E3). E3 accepted (E3-r3 PASS, MATCH 41e26bbb): 456/456 npm test, typecheck 0; 10/10 piped runs (5 default, 5 slow motion) put our tx first in round 2 of the story's block; pty `.crew/qa/e3-r3.log.txt`, `e3-c-r2` (Ctrl-C while held), `e3-short` (20 rows). E2 accepted (E2-r3 PASS, MATCH 0b59b943): 450/450 npm test, typecheck 0; pty `.crew/qa/e2-r5.log.txt` (300 s talk over chapter 1, ticket kept). E1 accepted (E1-r2 PASS, MATCH 1a56fb4c; with the Round 3 QA fixes): 415/415 npm test, typecheck 0, forge 0; pty transcripts `.crew/qa/e1-r2.log.txt`, `q1c34-r2`, `q2c34-r4`.

---

## Testnet stage (a later round, not in this round of coding)

Runs after round 2 and needs separate authorization. Delivery order: **B4 → A5 → C4**. Each phase carries the round-2 changes that apply on Sepolia.

### B4 (testnet stage): A user checks whether Arbitrum Sepolia orders by tip

- **Outcome:** A user with three funded throwaway wallets runs `npm run pga:probe -- --testnet --trials 10`. They see a per-trial table and a verdict: `PGA-consistent`, `FCFS-consistent` or `inconclusive`. `npm run pga -- --testnet --scenario all` and `demo.sh 1` also work against Sepolia.
- **Includes the round-2 changes (2026-10-28):** new paths (D1); colors and `NOTE:` (C6); the probe judges "same round" by `(block, pga_round)` (B6). `pga:slot` (B5) and `--slowmo` stay local only: Sepolia has real 250 ms blocks and no tick sync, and the README says so.
- **Demo script:**
  1. `npm run wallets:new` (wraps `cast wallet new` ×3; writes `.env` after confirmation), then faucet ETH, `npm run wallets:fund -- --testnet`, `npm run wallets:balances -- --testnet`.
  2. `npm run pga:probe -- --testnet --trials 10`:
     - pre-signs 3 txs and sends them lowest tip first to the sequencer endpoint;
     - counts only the trials that land in a single block;
     - reports `effectiveGasPrice > baseFee` (tips charged);
     - prints a verdict.
  3. `npm run pga -- --testnet --scenario all`.
  4. `RPC=https://sepolia-rollup-sequencer.arbitrum.io/rpc READ_RPC=https://sepolia-rollup.arbitrum.io/rpc ./scripts/demo.sh 1`.
- **Stubbed or deferred:** none.
- **Satisfies:** R3, R5 (prerequisite), R6 (wallets and faucets). Resolves V3.
- **Scope:**
  - Included: `src/wallets.ts`, `src/pga/probe.ts`, the Sepolia sections of the docs (as mode boxes, not duplicate pages).
  - Excluded: Fast Feed.
- **Subtasks:**
  - [ ] **wallets:** new, fund, balances. Never prints private keys.
  - [ ] **probe:** sends via the sequencer endpoint, reads via the public RPC.
  - [ ] **checks:**
    - The probe against `--local` reports `PGA-consistent`.
    - The probe against `--local --fifo` (sim passthrough) reports `FCFS-consistent`. Both are in `npm test`; this local part is built during the local stage, as part of B3 or right after it.
    - Live testnet run, logged.
- **Depends on:** B3 and testnet-stage authorization. **Open decisions:** V3.
- **Acceptance criteria:**
  1. Local classification is correct in both modes.
  2. The Sepolia run completes with real hashes and a verdict, recorded under V3.
  3. No private key is printed.
- **Checks/evidence:** `npm test`, the testnet run log.
- **Regression coverage:** the full local suite.
- **Status:** pending
- **Evidence:**

### A5 (testnet stage): A ticket holder buys real Sepolia tickets and watches live transactions

- **Outcome:** A user holding TEST tokens runs `npm run tickets:buy -- --testnet --tickets 2`, then `npm run feed -- --testnet --live`, and sees live sequenced Arbitrum Sepolia transactions in the same per-round tables, including `pga_round` if present. The lead over block visibility on the public RPC is measured live.
- **Includes the round-2 changes (2026-10-28):**
  - new paths (D1); colors and `NOTE:` (C6);
  - the C7 live panel with `FF lead` measured against a direct read of the Sepolia sequencer RPC: the real Fast Feed advantage;
  - the ticket round is the Sepolia contract's own, with no local adaptation (C5);
  - the carried final-review notes: `tickets:* --testnet` gets the `ALLOW_TESTNET=1` guard and separate read and send transports.
- **Demo script:**
  1. Funded wallet and TEST balance (`docs/00-setup.md`).
  2. `npm run tickets:status -- --testnet` shows the TEST balance, round, price, grandfather end and round end.
  3. `npm run tickets:buy -- --testnet --tickets 2` narrates the same steps as A2, minus the mint, with Arbiscan links.
  4. After activation (≤ ~20 min), `npm run feed -- --testnet --live` prints `connected`, then per-round tables with tips, fees and the ordered → feed → block timing.
  5. `npm run tickets:withdraw -- --testnet`.
- **Stubbed or deferred:** none.
- **Satisfies:** R2, R5 (prerequisite). Resolves V7.
- **Scope:**
  - Included:
    - The Sepolia preset values.
    - A balance check with a "request TEST on the Arbitrum Discord" message.
    - `--dry-run`.
    - Troubleshooting in `docs/01-fast-feed.md` (grandfather period, stale price, sold out, 401 before activation).
  - Excluded: mainnet.
- **Subtasks:**
  - [ ] **config:** Tickets `0x6f94…C879`, TEST `0xca20…1e00`, feed `wss://sepolia-rollup-txfeed.arbitrum.io`.
  - [ ] **checks:**
    - Read-only `tickets:status -- --testnet` (resolves V7). Fill the Sepolia "read on chain" cells of the parameters table with the values read.
    - Manual live run, logged: tx hashes, plus the first N messages with keys redacted.
- **Depends on:** A4, the user's TEST tokens, and testnet-stage authorization. **Open decisions:** V7.
- **Acceptance criteria:**
  1. Purchase txs are visible on Arbiscan.
  2. A feed message's `tx_hash` and `tx_index` match `cast receipt <hash> transactionIndex --rpc-url https://sepolia-rollup.arbitrum.io/rpc`.
  3. Withdraw returns the remaining deposit.
- **Checks/evidence:** the manual run log.
- **Regression coverage:** the full local `npm test`.
- **Status:** pending
- **Evidence:**

### C4 (testnet stage): A workshop attendee runs the same demo live on Arbitrum Sepolia

- **Outcome:** A user who has completed B4 (funded wallets) and A5 (2 active tickets) runs `npm run demo -- --testnet`. They see the same chapters live, with Arbiscan links in place of sequencer internals:
  - the live rounds view of real Sepolia traffic;
  - our bigger-tip tx appearing in its round, with its index, tip and fee next to the real competitors';
  - the race result.

  Then `npm run race -- --testnet --scenario matrix --trials 5` prints the win table.
- **Includes the round-2 changes (2026-10-28):**
  - the README order (`--pause` first, then hands-off with chapter stops);
  - colors and `NOTE:` (C6); the C7 panel with real `FF lead`;
  - the C8 round-2 injection, best effort: timed from the observed feed `pga_round`, reported honestly if it lands elsewhere. The two-rounds explainer prints with real 250 ms / 125 ms values and real hashes;
  - the C8 timing table without the "arrived at sequencer" column, and no FCFS table, each replaced by a `NOTE:` (Arbitrum publishes no arrival times);
  - new paths (D1).
- **Demo script:**
  1. `npm run race:deploy -- --testnet` deploys `Race`, writes `deployments/421614.json` and prints an Arbiscan link. `cast code` confirms it.
  2. `npm run demo -- --testnet`:
     - prints the same chapters;
     - skips the ticket purchase if the tickets are already active, otherwise explains the wait;
     - the race result includes links.
  3. `npm run race -- --testnet --scenario matrix --trials 5`. If B4 found Sepolia not PGA-consistent, S1 is reported as "tip ordering not observable on this network", not FAIL.
- **Stubbed or deferred:** none.
- **Satisfies:** R4, R5.
- **Scope:**
  - Included: the Sepolia deploy of `Race` (testnet only), the testnet chapter variants (links instead of internals), the README testnet section and troubleshooting.
  - Excluded: mainnet.
- **Subtasks:**
  - [ ] **deploy:** `race:deploy` for both flags (local auto-deploys).
  - [ ] **checks:** the manual live run, logged with hashes, links and the table.
- **Depends on:** C3, A5, B4, and testnet-stage authorization. **Open decisions:** V3 (affects how S1 is reported).
- **Acceptance criteria:**
  1. `Race` exists on Sepolia.
  2. The demo completes, and the S3 race shows mine at rank 1 with hashes resolving on Arbiscan.
  3. The injected bigger-tip tx is shown in the live view with its real `tx_index`, tip and fee, matching `cast receipt` on the public RPC.
  3. The matrix is reported honestly, including deviations from local results.
- **Checks/evidence:** the run log; `cast call <race> "winner(uint256)" <id> --rpc-url https://sepolia-rollup.arbitrum.io/rpc`.
- **Regression coverage:** the full local `npm test` + `forge test`.
- **Status:** pending
- **Evidence:**

---

### Phase boundary check

- [x] **Every phase can be demonstrated on its own,** from a real entry point, with narrated output.
- [x] **Outcomes use the actor / can / sees form.** No title names a layer.
- [x] **A1 touches every layer of the final product, at least thinly:**
  - the `--local` / `--testnet` flag parsing;
  - the stack (Anvil, sequencer, feed);
  - the client;
  - narration;
  - docs.

  Solidity first appears where it is needed: A2 (Tickets) and C1 (Race).
- [x] **No single-layer phases.**
- [x] **Usable if later phases are cancelled:**
  - after A4: a local Fast Feed workshop with the live rounds view;
  - after B3: plus PGA;
  - after C3: the full local workshop and narrated demo;
  - the testnet stage adds live proof.
- [x] **Requirement coverage:**

  | Requirement | Phases |
  |---|---|
  | R1 | A1, A2, B1, B3, B5, B6 |
  | R2 | A1–A5, B6, C7 |
  | R3 | B1–B6, C8 |
  | R4 | C1, C2, C4 |
  | R5 | C3, C4, C5–C8, D2 |
  | R6 | A1, A2, A4, B4, C3, D1, D2 |
  | R7 | A1, A2, A4, B1, B2, B5, B6, C1, C3, C6, D1, D2 |
  | R8 | A1, A2, A4, B5, B6, C3, C5–C8 |
- [x] **Dependencies run forward in the delivery order.** Each phase lists its regression coverage.

## Deliverables

- **The repository layout above,** with:
  - the README (what/why, disclaimer, two-mode quickstart, full demo, command reference);
  - `docs/00–03` and `docs/simulator.md`, each concept written once.
- **`--local` stack:** a PGA mock sequencer plus a mock Fast Feed with ticket auth, self-starting.
- **Commands (all take `--local | --testnet`):**
  - `feed` (`--live` for the per-round view)
  - `traffic` (local only)
  - `key:new`, `tickets:buy|status|withdraw`
  - `pga` (scenarios, flood is local-only), `pga:probe`, `pga:slot` (local only)
  - `race:deploy`, `race` (s1, s2, s3, matrix)
  - `demo`
  - `wallets:new|fund|balances`
  - plus `scripts/demo.sh 1|2|3` (cast, mirrors `pga.md`).
- **Contracts:**
  - `contracts/src/vendor/{Tickets,ITickets}.sol`, copied with the source commit;
  - `contracts/src/Race.sol`.
- **Tests:**
  - `forge test`;
  - `npm test` (`pga-core` units, plus feed / auth / ordering / flood / probe / race / demo integrations on the slow preset).
- **`AGENTS.md`** with the `## Project knowledge (maintained by /crew)` section, containing accepted durable decisions only.
- **Parameters table** (Arbitrum One / Arbitrum Sepolia / `--local`) in the docs, with the Sepolia cells filled in from on-chain reads.
- **Testnet evidence:** the B4 verdict (V3), the A5 live feed (V7), the C4 demo and matrix.

## Definition of Done

- **Local stage:** A1–A4, B1–B3 and C1–C3 are accepted with a reviewer PASS and a matching scope.
- **Testnet stage** (once authorized and the TEST tokens are received): B4, A5 and C4 are accepted, with the run logs recorded.
- **From a clean clone:** `npm ci`, `forge build`, `npm run typecheck`, `forge test` and `npm test` all pass.
- **Integrated review:** the whole change (baseline → final) gets a PASS. `AGENTS.md` holds accepted decisions only. No secrets in the repo, packets or logs.

## Validation

**Cumulative local checks:**

```bash
npm ci && forge build
npm run typecheck
forge test
npm test          # unit + slow-preset integration tests for every local slice, incl. demo --local
bash -n scripts/demo.sh
```

**Full end-to-end acceptance run** (manual, recorded in `.crew/reviews/final-*.md`):

1. **Fresh clone.** Follow the README from zero: install Node 22 and Foundry, `npm install`.
2. **Local, feature by feature:**
   - `feed --local`: 401 → buy → connected → 429 → 1008.
   - `traffic --local` + `feed --local --live`:
     - per-round tables sorted by tip;
     - a `cast send` with a 1 gwei tip shows up at index 0 of its round;
     - feed lead over block visibility > 0;
     - the accelerated-parameter banner is shown.
   - `./scripts/demo.sh 1|2|3`.
   - `sim -- --block-ms 20000` + `pga:slot --local`: the late 0.05 tx lands at index 1 with the timeline.
   - `pga --local --scenario all|flood`.
   - `race --local --scenario matrix --trials 5`: mine wins S1, S2 and S3.
3. **Local, reconciled:** `npm run demo -- --local`. The narrated run:
   - shows the live view;
   - injects the bigger-tip tx at index 0 of its round;
   - ends with mine at rank 1 and the "why".
4. **Testnet PGA:**
   - `wallets:new`, faucet, `wallets:fund -- --testnet`.
   - `pga:probe -- --testnet --trials 10` gives a verdict (V3).
   - `demo.sh 1` against the sequencer endpoint.
5. **Testnet Fast Feed** (2 tickets of TEST):
   - `tickets:status`, then `tickets:buy -- --testnet --tickets 2`.
   - After activation, `feed --testnet --live` shows per-round tables with tips, fees and the feed lead (V7).
   - Fill in the Sepolia cells of the parameters table.
6. **Testnet, reconciled:**
   - `race:deploy -- --testnet`.
   - `demo -- --testnet`.
   - `race -- --testnet --scenario matrix --trials 5`.
   - Record the transcript and Arbiscan links.
7. **Cleanup:** `tickets:withdraw -- --testnet`.

**Integrated review scope:** `.crew/final.scope.json`, built from `.crew/baseline.json`, with this plan as the criteria.
