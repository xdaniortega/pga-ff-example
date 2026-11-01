# PGA, part 1: tips and rounds

Not production: teaching code, throwaway wallets only. This is the local teaching model of Arbitrum's priority gas auction (PGA). [Docs](https://docs.arbitrum.io/how-arbitrum-works/priority-gas-auction/pga) This page needs no ticket and no Fast Feed (except demo 4, `pga:slot`, which reads the Fast Feed and handles its own ticket), and can be followed alone (Node >= 22 and Foundry, see [docs/setup.md](../docs/setup.md); `cast` is in `~/.foundry/bin` if it is not on your `PATH`).

**Where the code is.** `pga/rules/pga-core.ts` is the ordering itself (pure: effective tip, priority queue, nonce rule, boost). The round loop that applies it is `sim/sequencer.ts`. `pga/bot/` has the bot (`bot.ts`: scenarios 1-3), `flood.ts` (anti-starvation), `probe.ts` (PGA or FCFS?) and `tx.ts` (pre-signed txs). `pga/scripts/demo.sh` is the `cast` version of demos 1-3.

**Commands in order** (details below; the full list is the [command reference](#command-reference)):

```bash
npm ci                                       # once: install
npm run sim                                  # terminal 1: the simulator (add -- --slowmo to watch rounds x100)
export RPC=http://127.0.0.1:8547 READ_RPC=$RPC  # terminal 2: where demo.sh sends and reads
./pga/scripts/demo.sh 1                      # terminal 2: demos 1, 2, 3 with cast
# cast send ... --priority-gas-price 0.05gwei  # your own tip, no code change: see "Your own tip"
npm run pga -- --local --scenario all        # the same scenarios as a viem bot
npm run pga:probe -- --local                 # does this chain order by tip or by arrival?
npm run pga -- --local --scenario flood      # needs: npm run sim -- --max-txs-per-round 3
npm run pga:slot -- --local                  # demo 4: needs: npm run sim -- --block-ms 20000
```

## The idea

On Arbitrum, the **tip** you pay decides your position, not only when you arrived. New transactions land in an unordered **waiting list**. Every **round**, that whole list moves into a **priority queue** sorted by tip, and the sequencer drains the queue into the block, highest tip first.

- **Round** = B / K. On Arbitrum One the block time B is 250ms and K = 2 rounds share a block, so a round is 125ms. Locally the slow preset uses B = 2000ms, K = 2 (round 1000ms); the banner prints it.
- **Tie-break:** two transactions with the same tip are ordered by arrival, the earlier first.

### Which tip? The effective tip

"Tip" is the standard EIP-1559 effective priority fee:

```
effective tip = min(maxPriorityFeePerGas, maxFeePerGas - baseFee)
baseFee = 0.01 gwei
tip 0.1 gwei, maxFee 1 gwei     -> min(0.1, 0.99) = 0.1  gwei
tip 0.1 gwei, maxFee 0.05 gwei  -> min(0.1, 0.04) = 0.04 gwei   (capped)
```

A big tip with a low max fee gets capped, so what you bid is not always what you pay. The ordering uses the effective tip. Locally the base fee is pinned at 0.01 gwei, the same as the example.

Our model's assumptions about legacy transactions and a max fee below the base fee are in [sim/README.md](../sim/README.md#effective-tip-corner-cases).

## Two rounds in one block (K = 2)

```text
On Arbitrum One a 250ms block holds two 125ms PGA rounds (here slowed x100: 25s / 12.5s):

  block N  ──────────────────────────────────────────────
    round 1 (0–125ms):   A, B, C   ordered + executed → feed publishes A, B, C
                                    you see C, react, send X
    round 2 (125–250ms): X, D, E   X competes here by tip
```

A, B and C are already final when the feed shows them: ordered and executed, and nothing you send can go before them or change their outcome. X is ranked in round 2 against D and E by effective tip, blind: you never see D or E before they are ordered; they reach the feed only after round 2 executes. Within a round PGA reorders by tip, but round 2 txs never move ahead of round 1 txs already published. The demo's [chapter 4](../combo/README.md#chapter-4-of-the-demo-one-block-two-rounds) shows this with real hashes.

Why does this matter? Under **first-come-first-served** (FCFS) the position would be decided by when your tx reached the sequencer: a latency race, won by being closer to it. Under PGA the tip decides, so a faster connection no longer wins the round by itself (information still gets you *into* a round; see [combo/README.md](../combo/README.md)). Arbitrum does not publish arrival times; the simulator does, only so the demo can show the FCFS order the same txs would have had.

## Demo 1: three wallets, three tips

Three wallets bid tips of 0.001, 0.01 and 0.1 gwei. The demo **signs all three first** (`cast mktx`) and then publishes them **one after another, lowest tip first** (`cast publish --async`), so the arrival order is 0.001, 0.01, 0.1. Why: first come, first served (FCFS) would predict that same order. PGA predicts the opposite, 0.1, 0.01, 0.001. If the result is the PGA order, the tips decided it, not the arrival time. What keeps the three in **one round** is the block-start sync below (the script sends right after a block starts, so the batch lands in its round 1, and the three publishes take a few milliseconds), not the pre-signing alone: pre-signing only removes the signing time between the sends.

Terminal 1:

```bash
npm run sim -- --preset slow      # B=2000ms, K=2, one tick per round
```

Terminal 2:

```bash
export RPC=http://127.0.0.1:8547 READ_RPC=$RPC
./pga/scripts/demo.sh 1
```

The keys K1, K2 and K3 default to the **public** Anvil dev accounts 0, 1 and 2 when the RPC's chainId is 31337. On any other chain you must export them (throwaway wallets only).

Expected output (your block number varies):

```
block 5  idx 0  from 0x3c44..  tip 0.1   gwei
block 5  idx 1  from 0x7099..  tip 0.01  gwei
block 5  idx 2  from 0xf39f..  tip 0.001 gwei

NOTE: All txs landed in block 5, pga_round 1.
Verdict: PGA order (highest tip first).
```

The tip printed is computed from the receipt (`effectiveGasPrice` minus the block's base fee), not from the bid. Before sending, the script asks the local simulator how long until the next block starts (`sim_msUntilNextBlock`, local test/demo tooling), waits for it and sends just after, so all three collect in round 1 of that block. It then reads each tx's `pga_round` from `sim_boostTrace`: "same round" is the same block and the same `pga_round` (K = 2 rounds share a block, so the same block alone proves nothing). If they still land in different rounds, the script says so ("landed in different blocks" or "share block N but not its round ... Rerun.") and gives no verdict. On Arbitrum Sepolia the receipt has no `pga_round`, so the script falls back to the block only and says so.

Exit codes: 0 PGA order, 1 not in tip order (or an error), 3 inconclusive (different rounds: rerun), 2 usage.

The simulator terminal shows the round's priority queue, then the drained order:

```
[sequencer] round 22: waiting list -> priority queue (3 tx)
[sequencer]   queue: 0xc92d3c98.. from 0xf39Fd6e5.. nonce 0 bid 0.001/1 gwei  effective tip 0.001 gwei  arrival #1
[sequencer]   queue: 0x52c0eeb7.. from 0x70997970.. nonce 0 bid 0.01/1 gwei  effective tip 0.01 gwei  arrival #2
[sequencer]   queue: 0xa5c85e7a.. from 0x3C44CdDd.. nonce 0 bid 0.1/1 gwei  effective tip 0.1 gwei  arrival #3
[sequencer] round 22: drained order (highest effective tip first, ties by arrival; a sender's next nonce only)
[sequencer]   1. 0xa5c85e7a.. from 0x3C44CdDd.. nonce 0 effective tip 0.1 gwei (arrival #3)
[sequencer]   2. 0x52c0eeb7.. from 0x70997970.. nonce 0 effective tip 0.01 gwei (arrival #2)
[sequencer]   3. 0xc92d3c98.. from 0xf39Fd6e5.. nonce 0 effective tip 0.001 gwei (arrival #1)
```

(`bid` is maxPriorityFee/maxFee in gwei.)

> **`--local` vs `--testnet`: transaction index**
> On Arbitrum a block's transaction index 0 is the ArbOS internal start-block transaction, so user transactions start at `idx 1` (as in the `pga/video-script.md` sample). Locally there is no internal transaction, so user transactions start at `idx 0`. The order is what matters, not the starting number.
> Safety: the script runs only on chainId 31337 and Arbitrum Sepolia (421614); any other chain (never mainnet) is refused, and 421614 additionally needs an explicit `ALLOW_TESTNET=1`. On a non-local chain K1, K2 and K3 must be exported, `RPC` is the sequencer endpoint and `READ_RPC` the public RPC.
> Also: "same round" means the same `block_number` and the same `pga_round`, locally and on Arbitrum alike: K = 2 rounds share a block ([why](../sim/README.md#k-rounds-per-block)). The demos send right after a block starts, so the batch lands in round 1.

Local-only behaviour you may hit while running the demos, each explained once in [sim/README.md](../sim/README.md): [`--fifo`](../sim/README.md#fifo-mode) turns PGA off so tests can prove the ordering comes from the tip; [`eth_sendTransaction` is rejected](../sim/README.md#eth_sendtransaction-is-rejected) (use `--private-key`); [a second tx with the same sender and nonce is refused](../sim/README.md#duplicate-nonce-refusal), so send one at a time or use distinct nonces.

## Your own tip: send one with `cast`

No code change: any wallet can bid. With the simulator running, send a transfer with a 0.05 gwei tip from Anvil dev account 0 (a public key, local only):

```bash
cast send 0x000000000000000000000000000000000000dEaD --value 1 \
  --gas-price 1gwei --priority-gas-price 0.05gwei \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  --rpc-url http://127.0.0.1:8547
```

`--priority-gas-price` is the tip you bid (`maxPriorityFeePerGas`); `--gas-price` is the max fee, given so the [effective tip](#which-tip-the-effective-tip) is not capped. Without it `cast` estimates a max fee itself, which can fall below your tip, and then it refuses (`max priority fee per gas ... cannot exceed max fee per gas`). `cast` waits for the receipt.

**Where did it land?** Two places show it.

1. The simulator terminal prints every round's queue and drained order. With background load (`npm run traffic -- --local --tps 5` in another terminal) a real excerpt looked like this, with the 0.05 gwei tx 4th of 6 in round 2 of block 20:

   ```
   [sequencer]   queue: 0x8ab6cebd.. from 0xf39Fd6e5.. nonce 2 bid 0.05/1 gwei  effective tip 0.05 gwei  arrival #3 (+364ms into its round)
   [sequencer] round 94: drained order (highest effective tip first, ties by arrival; a sender's next nonce only)
   [sequencer]   1. 0xe4540cba.. from 0xcd3B766C.. nonce 12 effective tip 0.098208984 gwei (arrival #5, +723ms into its round)
   [sequencer]   2. 0x83ba95af.. from 0xdF3e18d6.. nonce 12 effective tip 0.086755371 gwei (arrival #4, +519ms into its round)
   [sequencer]   3. 0xdfe9d08d.. from 0x1CBd3b27.. nonce 12 effective tip 0.084735518 gwei (arrival #2, +317ms into its round)
   [sequencer]   4. 0x8ab6cebd.. from 0xf39Fd6e5.. nonce 2 effective tip 0.05 gwei (arrival #3, +364ms into its round)
   [sequencer]   5. 0xf4b9673d.. from 0x2546BcD3.. nonce 12 effective tip 0.043996459 gwei (arrival #6, +926ms into its round)
   [sequencer]   6. 0x9a1397e2.. from 0xFABB0ac9.. nonce 12 effective tip 0.030847096 gwei (arrival #1, +121ms into its round)
   [sequencer] round 94 (pga_round 2 of block 20): ordered 6, dropped 0, re-mined behind 5 tx(s) from earlier round(s) of the block; ...
   ```

   Your tx arrived 3rd but was ranked 4th: three txs with a bigger tip went first, two with a smaller tip after it. On a quiet stack it is simply alone in its round.
2. `cast receipt <tx hash> transactionIndex blockNumber effectiveGasPrice --rpc-url http://127.0.0.1:8547` gives its position and what it paid. `transactionIndex` counts block-wide, so a round 2 tx comes after the txs of round 1 (above: round 1 had 5 txs, you were 4th of 6 in round 2, so index 5 + 3 = 8). The tip is `effectiveGasPrice` minus the block's base fee: here `60000000 - 10000000` wei = 0.05 gwei (`cast block <n> --field baseFeePerGas` gives the base fee; locally it is pinned at 0.01 gwei).

To see the tip decide between wallets, let [`demo.sh 1`](#demo-1-three-wallets-three-tips) send three txs into one round for you.

The bot (`npm run pga`) has no `--tip` flag: its tips are fixed by the scenarios. A configurable tip would be a code change and a possible follow-up; the `cast` command above is the no-code route.

## Demo 4: a late, bigger tip slots in

Demo 1 sent everything at once. Here the round is long enough to watch: three transactions arrive early, a fourth with a middle tip arrives later in the same round, and the order still follows the tip, not the arrival.

**Terminal 1**: a simulator with 10s rounds ([`--block-ms`](../sim/README.md#pga-parameters) 20000, so round = B/K = 10s):

```bash
npm run sim -- --block-ms 20000
```

**Terminal 2**:

```bash
npm run pga:slot -- --local
```

It sends tips 0.001, 0.01 and 0.1 gwei (lowest first) just after a block starts (round 1), waits `--late-after-ms` (default: half the round) and sends 0.05 gwei, then reads the Fast Feed (it buys a short-lived ticket first, unless the stack has `FEED_AUTH=off`). It refuses `--testnet` (it needs the block-start sync and long rounds) and rounds shorter than 2s. The code is `combo/slot.ts`, not `pga/`, because it also uses the Fast Feed. Sample output (times vary):

```
    feed: block 10 round 1 tx_index 0  0x5483dd8f…  early 3 (0.1 gwei)
    feed: block 10 round 1 tx_index 1  0xf1b637e2…  late (0.05 gwei)
    feed: block 10 round 1 tx_index 2  0x3def8db5…  early 2 (0.01 gwei)
    feed: block 10 round 1 tx_index 3  0x0bdb8131…  early 1 (0.001 gwei)

tx         tip (gwei)     sent    feed ts   waited tx_index
early 1         0.001   +0.00s     +9.95s    9.95s        3
early 2          0.01   +0.01s     +9.95s    9.93s        2
early 3           0.1   +0.03s     +9.95s    9.92s        0
late             0.05   +5.04s     +9.95s    4.91s        1

The earliest arrival (0.001 gwei) waited 9.95s and still came last; the late 0.05 gwei tx waited 4.91s and came second. Arrival time bought no position: the tip decided.
PASS: one round, tip order 0.1, 0.05, 0.01, 0.001, the late tx at tx_index 1
```

All four share one `timestamp_ms`: the moment the round was ordered. Terminal 1 prints a line as each transaction arrives, with its tentative rank in the still-open round, so the late one is seen slotting in before the round closes:

```
[sequencer] arrival 0x0bdb8131… from account 0 tip 0.001 gwei +75ms into round → rank 1 of 1
[sequencer] arrival 0x3def8db5… from account 1 tip 0.01 gwei +87ms into round → rank 1 of 2
[sequencer] arrival 0x5483dd8f… from account 2 tip 0.1 gwei +96ms into round → rank 1 of 3
[sequencer] arrival 0xf1b637e2… from account 3 tip 0.05 gwei +5107ms into round → rank 2 of 4
```

The Fast Feed publishes a tx only after its round is ordered and executed, so a tx already on the feed is final and can never be overtaken; "in the middle" is possible only while the round is still taking in transactions. On Arbitrum One the same happens within a 125 ms round; the slow block time only makes it visible to a person.

Exit codes: 0 the order matches; 1 wrong order (for example a [`--fifo`](../sim/README.md#fifo-mode) stack, where the late tx comes last) or an error; 3 the four txs did not share a round, also after one retry; 2 usage.

# PGA, part 2: nonces and the zero tip

Same stack and commands as part 1. Two rules the tip alone does not explain. [Docs](https://docs.arbitrum.io/how-arbitrum-works/priority-gas-auction/pga)

## The nonce rule (demo 2)

Within one sender the nonce decides. Nonce N+1 is not even valid until nonce N has executed, so tips only rank transactions **across senders**. The sequencer models this: only a sender's **next nonce** is eligible to enter the priority queue. The nonce comes from the chain at round time. The queue is drained highest effective tip first; once a sender's N is included, that sender's N+1 (if it is waiting) joins the queue at its own tip. Overpaying on the later transaction buys nothing.

Demo 2 uses one wallet (K1). It signs nonce N at tip 0.001 gwei and nonce N+1 at 0.1 gwei (100x), then sends **N+1 first** and N second after the block-start sync. A tip-only sort would put N+1 first, so if N lands first the nonce rule did it.

```bash
./pga/scripts/demo.sh 2
```

```
idx 0  nonce N    tip 0.001 gwei
idx 1  nonce N+1  tip 0.1   gwei

Verdict: nonce rule. Nonce N landed before N+1 although N+1 bid 100x the tip and was sent first:
NOTE: nonce N+1 isn't valid until nonce N has executed; tips only rank across senders.
```

The simulator shows the pair out of tip order and says why:

```
[sequencer] round 26: waiting list -> priority queue (2 tx)
[sequencer]   queue: 0xe76c60ef.. from 0xf39Fd6e5.. nonce 1 bid 0.1/1 gwei  effective tip 0.1 gwei  arrival #1
[sequencer]   queue: 0x505dc5b7.. from 0xf39Fd6e5.. nonce 0 bid 0.001/1 gwei  effective tip 0.001 gwei  arrival #2
[sequencer] round 26: drained order (highest effective tip first, ties by arrival; a sender's next nonce only)
[sequencer]   1. 0x505dc5b7.. from 0xf39Fd6e5.. nonce 0 effective tip 0.001 gwei (arrival #2)
[sequencer]   2. 0xe76c60ef.. from 0xf39Fd6e5.. nonce 1 effective tip 0.1 gwei (arrival #1)
[sequencer]   nonce rule: nonce 0 before nonce 1 for 0xf39Fd6e5.. (nonce 1 bids a higher tip, but it is not valid until nonce 0 has executed)
```

In `feed --live` the same pair appears as `out of tip order (nonce-gated)`, as opposed to `out of tip order (nonce-gated / boosted)`, which is the generic note for a row whose tip is above the row before it.

## The zero tip (demo 3)

A zero tip still gets in. On an uncongested stack the queue empties every round, so even the lowest bid lands, just last. Demo 3 sends tips 0 (first), 0.01 and 0.1 gwei (last) from three wallets (`--priority-gas-price 0`):

```bash
./pga/scripts/demo.sh 3
```

```
idx 0  tip 0.1  gwei
idx 1  tip 0.01 gwei
idx 2  tip 0    gwei

Verdict: the zero tip lands last, but lands (the queue empties every round on a quiet chain).
```

What happens under load is the anti-starvation part: [part 3](#pga-part-3-anti-starvation).

## The bot: all three scenarios with viem

`npm run pga` signs the transactions first with viem (explicit nonce, gas and fees; nothing is filled), waits for the start of a block on the local simulator (so the batch shares round 1) and sends them back to back. Scenario 1 is demo 1, scenario 2 is demo 2, scenario 3 is demo 3. Each is judged against the expected PGA order, with the tips read from the receipts.

```bash
npm run pga -- --local --scenario all      # or --scenario 1|2|3
```

```
Scenario                                  Expected order    Observed order    Tips (gwei, from receipts)  Result
----------------------------------------  ----------------  ----------------  --------------------------  ------
1: three senders, tips 0.001/0.01/0.1     0.1, 0.01, 0.001  0.1, 0.01, 0.001  0.1, 0.01, 0.001            PASS
2: same sender, N tip 0.001, N+1 tip 0.1  N, N+1            N, N+1            0.001, 0.1                  PASS
3: three senders, tips 0.1/0.01/0         0.1, 0.01, 0      0.1, 0.01, 0      0.1, 0.01, 0                PASS

Scenario 1: PASS - highest tip first although it was sent last: ...
```

The bot pre-signs everything and then sends **back to back, lowest tip first, one after another, not in parallel**, so that FIFO and PGA predict opposite orders (the same choice as `demo.sh`). Gas is estimated per transaction through the read RPC (on Arbitrum the gas limit includes the L1 cost). Exit 0 only if every scenario passes; 1 if one fails (for example against `npm run sim -- --fifo`, where scenario 1 comes out in arrival order); 3 if the transactions did not share a block (inconclusive). Scenarios 1 and 3 retry **once**, after a fresh block start, when the first attempt lands in different blocks, and say so (`retrying once after a fresh block start`); if the retry also splits, the result is inconclusive. "Different blocks" is always reported as inconclusive, which is stricter than "same or next block": for scenario 3 a zero tip that lands one block later is reported as landed but not as a PASS. `--scenario all` runs 1-3 only: the `flood` scenario below needs the block cap, so it is always asked for by name. Locally the wallets are always Anvil accounts 0-2 (chainId 31337 only; `PGA_KEY_*` is ignored there). The bot allows chainIds 31337 and 421614 only; `--testnet` needs `ALLOW_TESTNET=1` and your own `PGA_KEY_1`..`PGA_KEY_3`.

## One known limit: nonce gaps

The docs do not say what happens to a transaction whose nonce is above its sender's next nonce with no predecessor waiting. The local sequencer holds it and prints `held: ... waiting for nonce N` each round, then drops it with a visible line after `GAP_HOLD_ROUNDS` rounds. The rule and its reason are in [sim/README.md](../sim/README.md#the-gap-hold).

# PGA, part 3: anti-starvation

A zero tip still lands under load. [Docs](https://docs.arbitrum.io/how-arbitrum-works/priority-gas-auction/pga)

## The boost

A round's transfer from the priority queue into the block "ends when the queue empties, the block fills, or the round runs out of time. Anything still queued waits for the next round." Waiting would starve a zero tip while paying transactions keep coming, so:

At the end of every round each transaction still waiting gains a priority boost of `p / (2K)`. The exact wording and our reading of it live in one place: [sim/README.md](../sim/README.md#the-boost).

- The boost moves a transaction's **position in the queue and nothing else**. It never changes the fee it pays.
- It **compounds** across rounds: a transaction that pays no priority fee climbs until it outranks the marginal paying transaction.
- Ties still break on the original arrival time.

Worked example (`pga/video-script.md`): K = 2, and p stays flat. The boost per round is p/4, so after 4 rounds a zero-tip transaction has 0 + 4 x p/4 = p. It then ties a fresh transaction that tips p and wins on its earlier arrival. On Arbitrum One that is 4 rounds x 125ms, about half a second. The precise reading of "p" and of which transactions are boosted is in [sim/README.md](../sim/README.md#the-boost).

## Why a block cap

On an uncongested chain every round empties the queue, so nothing waits and nothing is boosted. The simulator therefore has a block-full stand-in: `MAX_TXS_PER_ROUND` (default 0 = no cap) limits how many transactions a round (half a local block) may include; the rest stay queued ([the stand-in and how it differs from Arbitrum One](../sim/README.md#block-full-stand-in-max_txs_per_round)). Without a cap the queue always empties, so only a gap-held tx can wait and be boosted.

## Run the flood scenario

Terminal 1, with the cap:

```bash
npm run sim -- --preset slow --max-txs-per-round 3      # or MAX_TXS_PER_ROUND=3 npm run sim
```

Terminal 2:

```bash
npm run pga -- --local --scenario flood
```

What it does (K = 2, cap 3, p = 0.01 gwei; every step is sent right after a round tick, the txs are signed first):

| Step (round) | Sent | What the sequencer does |
| --- | --- | --- |
| 0 (R) | a zero-tip tx from Anvil account 0, then 3 paying txs at tip p (flooders: accounts 3-8) | includes the 3 payers; the zero tip waits at priority 0 and gains p/4 |
| 1-3 (R+1..R+3) | 3 fresh paying txs each | includes the 3 payers; the zero tip goes p/4, p/2, 3p/4 |
| 4 (R+4 = 2K) | 3 fresh paying txs, then a **later arrival tipping exactly p** (account 1) | the zero tip is at p: it ties the fresh payers and wins on earlier arrival, so it is included first; the full block cuts the later arrival, which lands a round after it |

Expected output (round and block numbers vary):

```
NOTE: zero-tip tx, boosted priority per round (p = 0.01 gwei, boost = p/(2K) = 0.0025 gwei):
NOTE:   round 12: 0  ->  round 13: p/4  ->  round 14: p/2  ->  round 15: 3p/4  ->  round 16: p (included)
NOTE: later arrival (tip p): round 16: p  ->  round 17: 5p/4 (included)
NOTE: zero-tip tx landed in block 8 idx 0; effective tip from its receipt = 0 gwei
NOTE: later arrival landed in block 9 idx 1; effective tip = 0.01 gwei

  boost per round = p/(2K) = 0.0025 gwei: yes
  zero-tip tx included in round 5 after its arrival (limit 2K+1 = 5): yes
  zero-tip tx landed ahead of the later arrival that tips p (block 8 idx 0 vs block 9 idx 1): yes
  zero-tip receipt: effectiveGasPrice - baseFee = 0 gwei (expected 0): yes

Scenario flood: PASS - the zero-tip tx climbed 0 -> p by p/(2K) per round, landed in round 5 (within 2K+1 = 5) ahead of the later arrival tipping p, and paid no tip.
```

The later arrival carries 5p/4 into its round: it was cut once, so it gained a boost itself. The simulator terminal shows the same story each round (queue size, how many were included, p, the boost, and the zero-tip transaction's boosted priority):

```
[sequencer] round 12: queue 4 tx, included 3 (block-full stand-in: at most 3 per round), p = 0.01 gwei (priority of the last included tx)
[sequencer]   block full: 1 tx(s) carried over to the next round
[sequencer]   boost: +p/(2K) = +0.0025 gwei (p 0.01 / (2 x 2)) to 1 waiting txs; the boost moves their queue position only, never the fee
[sequencer]   waiting: 0xa30cc87b.. from 0xf39Fd6e5.. nonce 0 tip 0 gwei -> boosted priority 0.0025 gwei  (zero tip) (block full)
```

Result and exit codes: PASS (exit 0) needs all of: the boost is exactly p/(2K) each round, the zero tip is included within 2K+1 rounds of its arrival, it lands ahead of the later arrival, and its receipt shows effective tip 0 (`effectiveGasPrice - baseFee`: the boost never changed the fee). FAIL is exit 1 (this includes a boost that is not p/(2K), once the schedule is proven on time), INCONCLUSIVE (a step slipped into another round, or the zero tip never starved: rerun) is exit 3, and an INCONCLUSIVE attempt is **retried once** after a fresh round tick (the output says so). The bot also refuses, with an explanation and exit 1, a **FIFO** simulator (`--fifo`: no boost is ever added) and a block cap **above 6** (there are only 6 flooder wallets, Anvil accounts 3-8). Against a simulator with no cap the bot reads `sim_info`, says so, prints the restart command (`npm run sim -- --max-txs-per-round 3`) and exits 1. `--testnet` is refused with an explanation: it would spam a shared testnet, and the sequencer's queue and boost cannot be observed there. The boost trace comes from the local-only RPC method `sim_boostTrace(hash)`.

## Testnet probe

`npm run pga:probe` asks one question of a chain: does it order a round by tip (PGA) or by arrival (first come, first served)? Each trial pre-signs three transactions from three wallets, tips 0.001 / 0.01 / 0.1 gwei, and sends them lowest tip first (right after a block starts on `--local`). FCFS predicts the arrival order, PGA the opposite.

```bash
npm run pga:probe -- --local --trials 3
```

```
Trial  Block(s)          Same round     Landing order (tip, gwei)  Ordered by      Tips charged
-----  ----------------  -------------  -------------------------  --------------  ---------------------------------
1      10 (pga_round 1)  yes (counted)  0.1, 0.01, 0.001           tip (PGA-like)  yes (effectiveGasPrice > baseFee)
...
Verdict: PGA-consistent (3 of 3 trial(s) counted)
```

- Only trials whose three transactions landed in one **round** are **counted** (locally the same block and the same `pga_round`; on a testnet the same block, the best that is observable). For each counted trial the table says whether the order was by tip (PGA-like) or by arrival (FCFS-like), and whether tips were charged (`effectiveGasPrice > baseFee`, from the receipts).
- **PGA-consistent**: at least one counted trial and every counted trial is tip-ordered. **FCFS-consistent**: at least one counted trial and every counted trial is arrival-ordered (`npm run sim -- --fifo` shows it). **inconclusive**: anything else, including no counted trial.
- Exit codes: 0 for a verdict (either), 3 for inconclusive, 1 for an error or refusal, 2 for usage. Locally the wallets are Anvil accounts 0-2.
- On `--testnet` the same code sends to the preset's sequencer endpoint and reads from the public RPC. It is guarded like the bot: `ALLOW_TESTNET=1`, `PGA_KEY_1`..`PGA_KEY_3` that are three **distinct** wallets (the keys are never printed), and the chain allowlist (31337, 421614; never mainnet). There **same block is not the same round**: K = 2 rounds share a block, so a trial can look arrival-ordered although tips decided each round. The table says so, and more trials help. The Sepolia run itself comes in a later phase.

## Command reference

| Command | What it does |
| --- | --- |
| `npm run sim [-- --preset slow\|fast] [--slowmo] [--block-ms MS] [--fifo] [--max-txs-per-round N]` | The local stack ([flags](../sim/README.md#commands-and-environment)). `--slowmo` shows rounds of 12.5s; `--fifo` turns PGA off; the cap makes the flood scenario possible. |
| `./pga/scripts/demo.sh 1` | Demo 1. Needs `RPC` (and optionally `READ_RPC`); keys K1-K3 default to Anvil dev accounts 0-2 on chainId 31337. Signs three txs with tips 0.001, 0.01, 0.1 gwei, sends them lowest first and prints where each landed and a verdict. Expects the slow preset; on `--preset fast` it may report inconclusive (exit 3). |
| `./pga/scripts/demo.sh 2` | Demo 2 ([nonce rule](#the-nonce-rule-demo-2)): one wallet, nonce N at tip 0.001 and N+1 at tip 0.1, N+1 sent first; N lands first. |
| `./pga/scripts/demo.sh 3` | Demo 3 ([zero tip](#the-zero-tip-demo-3)): tips 0.1, 0.01, 0 from three wallets; the zero tip lands last, but lands. Exit codes of all three: 0 PGA order, 1 wrong order or error, 3 inconclusive, 2 usage. |
| `npm run pga -- --local\|--testnet [--scenario 1\|2\|3\|all\|flood]` | The [bot](#the-bot-all-three-scenarios-with-viem): pre-signed txs sent right after a block start, then one table and a reason per scenario. Exit 0 all PASS, 1 FAIL, 3 inconclusive, 2 usage. `all` runs 1-3 only. `--local` starts the stack or attaches, with Anvil accounts 0-2. `--testnet` needs `ALLOW_TESTNET=1` and `PGA_KEY_1`..`PGA_KEY_3`. |
| `npm run pga -- --local --scenario flood` | The [anti-starvation demo](#run-the-flood-scenario); needs a stack with `--max-txs-per-round 3` (up to 6). Refuses without a cap, on `--fifo` and on `--testnet`. |
| `npm run pga:probe -- --local\|--testnet [--trials N]` | The [probe](#testnet-probe): N trials (default 3); verdict `PGA-consistent`, `FCFS-consistent` or inconclusive (exit 0, 0, 3). |
| `npm run pga:slot -- --local [--late-after-ms N]` | [Demo 4](#demo-4-a-late-bigger-tip-slots-in): needs rounds of 2s or more (`npm run sim -- --block-ms 20000`). It reads the Fast Feed and buys its own short-lived ticket, so you do nothing extra. Exit 0 / 1 / 3 / 2. |
