# Setup

## Prerequisites

- **Node.js >= 22.** Check with `node --version`.
- **Foundry** (`forge`, `anvil`, `cast`). Install, then open a new shell:

  ```bash
  curl -L https://foundry.paradigm.xyz | bash
  foundryup
  ```

  The workshop finds `anvil` and `forge` on your `PATH`, and falls back to `~/.foundry/bin`.

## Install

```bash
npm ci          # or npm install
```

The first command that starts the local stack also builds the contracts (`forge build`; see [Solidity libraries](#solidity-libraries)). If `cast` is not found, it is in `~/.foundry/bin`: add that to your `PATH`.

## Two modes

Every command except `sim` (local-only) and `key:new` (no network) needs exactly one of `--local` / `--testnet`. The flag only picks a preset (`shared/config.ts`); the code path is the same. With `--local`, the local commands (`sim`, `feed`, `tickets:*`) also accept `--preset slow|fast` (default `slow`, block 2000ms; `fast` is block 250ms like Arbitrum One). Only the command that starts the simulator uses it; a command that attaches to a running simulator uses that simulator's own speed.

| | `--local` | `--testnet` |
| --- | --- | --- |
| Chain | Anvil, chainId 31337 | Arbitrum Sepolia, chainId 421614 |
| Sequencer | our mock, `http://127.0.0.1:8547` | the real sequencer endpoint |
| Fast Feed | our mock, `ws://127.0.0.1:9642` | `wss://sepolia-rollup-txfeed.arbitrum.io` |
| Cost | free | needs testnet ETH and (later) TEST tokens |
| Timing | slowed down so you can see it (block 2000ms by default) | real (Arbitrum One uses 250ms blocks) |

`--local` prints a banner with every value that differs from Arbitrum One. The testnet quickstart arrives in a later phase.

Other things that differ locally (so you are not surprised):

- Tickets, the feed's key check and the accelerated ticket round are explained once, in [fast-feed/README.md](../fast-feed/README.md).
- Everything the local simulator models differently from Nitro (K = 2 rounds per block, slow motion, the adaptive ticket round, the read gate, `gas_used_for_l1`, the pinned base fee, the ordering and boost rules, the block cap, wallet funding) is listed once, with its reason, in [sim/README.md](../sim/README.md).

## Solidity libraries

The contracts (the vendored Fast Feed `Tickets` contract, a local TEST token) build against forge-std and OpenZeppelin v5.6.1, kept as git submodules in `lib/`. `npm run sim` (and every command that starts the stack) runs `forge build`, and first fetches `lib/` if it is empty (`git submodule update --init`, falling back to `forge install --no-git`). Do it by hand with:

```bash
git submodule update --init
forge build
```

## Port conflicts

The local stack uses `8547` (sequencer RPC), `9642` (feed) and an internal Anvil port `8545`. `8545` is the likeliest clash (another Anvil or a node). Override with `SIM_RPC_PORT`, `SIM_FEED_PORT` and `SIM_ANVIL_PORT`, e.g. `SIM_ANVIL_PORT=18545 npm run feed -- --local`.

## `.env`

```bash
cp .env.example .env
```

`.env` is git-ignored; `.env.example` lists variable names only. For `--local` you need nothing in it up front: `npm run key:new` creates `FEED_API_KEY` there. The key and wallet in it are secrets: commands name the file they read or write, and never print the values.

`ENV_FILE` points the commands at another env file (the tests use it). **A custom `ENV_FILE` inside the repo must be git-ignored**: `.gitignore` covers `.env` and `.env.*` (except the committed `.env.example`), so name it like `.env.demo`, or keep it outside the repo.

| Variable | Used for |
| --- | --- |
| `FEED_API_KEY` | The Fast Feed key (written by `npm run key:new`). [fast-feed/README.md](../fast-feed/README.md#tickets-and-keys) |
| `PRIVATE_KEY` | The CLI's wallet. If unset, the CLI uses the public Anvil account 0. |
| `MY_ADDRESSES` | Comma-separated addresses the live view highlights as yours. |
| `PGA_KEY_1`..`PGA_KEY_3` | Three funded throwaway wallets, needed only by `npm run pga -- --testnet`; locally the bot uses Anvil accounts 0-2 and ignores them. |
| `FEED_AUTH`, `TICKET_ROUND_SECONDS`, `FEED_BACKOFF_MAX_MS` | Local feed auth, the ticket round and the `feed --reconnect` backoff cap (default 30000ms): [fast-feed/README.md](../fast-feed/README.md#parameters), [sim/README.md](../sim/README.md#ticket-round-adaptive). |
| `GAP_HOLD_ROUNDS`, `MAX_TXS_PER_ROUND` and the other `SIM_*` settings | Simulator behaviour: [sim/README.md](../sim/README.md#commands-and-environment). |
| `NO_COLOR`, `FORCE_COLOR`, `DEMO_CHAPTER_DELAY_MS` | Output colour and the demo's pace: [README.md](../README.md#reading-the-output). |

**`PRIVATE_KEY` in `.env` is used for `--local` too**: when the simulator starts it derives that wallet's address and funds it (and every `MY_ADDRESSES` entry) with 1000 ETH on the local chain, printing only the address (`funded 0xabcd…1234 (your PRIVATE_KEY wallet) with 1000 ETH on the local chain`, never the key; a wallet that already has at least that is left alone and reported as such). So a testnet key works locally without being funded there.

## Local wallets (public, local-only)

Anvil ships with 20 well-known dev accounts, each with 10,000 ETH locally; their roles are in [sim/README.md](../sim/README.md#local-wallet-funding). The first one (account 0) is the one used in this workshop's local examples:

- private key: `0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80`
- address: `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266`

This key is public and anyone can spend from it on any real network. **Use it only with `--local`.**

## Throwaway wallets

For anything beyond `--local`, create a fresh wallet that never holds real value:

```bash
cast wallet new
```

Faucets and testnet funding come in a later phase.

## Check it works

```bash
forge build
npm run typecheck
forge test
npm test
```

`npm test` builds the contracts first if `out/` or `lib/` is missing (a `pretest` step, and each integration suite does it too), so it also works on a fresh clone.
