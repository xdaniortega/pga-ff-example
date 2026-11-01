# PGA + Fast Feed workshop

A hands-on workshop for two Arbitrum transaction-ordering features, with a local simulator so you can watch them on your laptop:

- **PGA (priority gas auction):** within a short round, the tip you pay decides your position, not only when you arrived. [Docs](https://docs.arbitrum.io/how-arbitrum-works/priority-gas-auction/pga)
- **Fast Feed:** a paid, authenticated WebSocket that publishes each transaction right after it is ordered, before its block is produced. [Docs](https://docs.arbitrum.io/how-arbitrum-works/priority-gas-auction/fast-feed)

Put together: **information gets you into the round; the tip wins the round.**

Every command takes `--local` (Anvil, a mock sequencer and a mock Fast Feed; nothing to pay for) or `--testnet` (Arbitrum Sepolia), except `sim` (local-only) and `key:new` (no network). The testnet stage is not available yet, so everything below uses `--local`.

> **Not production. Throwaway wallets only.**
> This is teaching code. Never use a wallet that holds real funds, never commit keys, and treat any key you paste into `.env` as burned. The local examples use Anvil's public dev keys, which anyone can spend from.

## Run the full demo

One command tells the whole story in 6 numbered chapters. You need Node >= 22 and Foundry ([setup](docs/setup.md)), then `npm ci` (or `npm install`).

**1. Presenting, with Enter between chapters.** On a terminal (unless `DEMO_SLOWMO=0` or you set a block time) the demo starts its own stack in slow motion (x100: blocks of 25s, rounds of 12.5s) so you can watch each block; it takes several minutes:

```bash
npm run demo -- --local --pause
```

**2. Hands-off.** The same story at the default speed; on a terminal it stops about 3 seconds after each chapter so the room can read it:

```bash
npm run demo -- --local
```

Both build the contracts, start the stack (or attach to a running `npm run sim`) and stop it with Ctrl-C, Anvil included.

| Chapter | What you see |
| --- | --- |
| 1. What is accelerated | the banner: every local value next to Arbitrum One's |
| 2. Wallets and a feed key | the demo's wallets and the key's hash |
| 3. A ticket | a Fast Feed ticket, bought and activated |
| 4. One block, two rounds: your tip goes first | round 1 of a block, then your 1 gwei tx at the top of round 2 of the same block, then the sealed block |
| 5. The race | a feed-driven claim with a bigger tip against a polling rival |
| 6. Recap | what the Fast Feed did, what PGA did, then `Mine: rank 1. Why: ...` |

- **Run time:** an activation wait of up to one ticket round (30s by default), then about 30s of chapters hands-off, several minutes with `--pause`.
- **Exit codes:** 0 every chapter matched; 1 a chapter failed (the output names it); 2 usage; 3 the race was inconclusive after its retry; 130 Ctrl-C.
- **`--testnet`** is refused for now.

Every option, an excerpt of the output and the per-chapter explanations are in [combo/README.md](combo/README.md#the-full-demo-walkthrough).

## Reading the output

Every command prints each kind of line in its own style, so a projector audience can follow it (colour only on a terminal):

| Kind | Style | Example |
| --- | --- | --- |
| Sequencer internals (`[sequencer]`, `[feed]`) | magenta | `[sequencer] round 2: drained order ...` |
| An action happening now (`==>` step) | cyan | `==> buying 1 ticket` |
| An important step | bold, inverse | `▶ CHAPTER 4/6: ...`, `YOUR TX: PGA put us first ...` |
| An explanation that is not an action | starts with `NOTE:`, yellow | `NOTE: a ticket bought in round N is active in round N+1 only` |
| A warning (a flag that will not be honoured, a risky override), on stdout | starts with `WARNING:`, bold yellow | `WARNING: you requested FIFO, but a simulator is already running with PGA ...` |
| Tables (feed rows, timelines, the matrix) | default colour; your own rows bold | `>> 0  0xf39F…2266 ...` |
| A result | bold green `PASS`, bold red `FAIL`, bold yellow `INCONCLUSIVE` | `Scenario 3: PASS - ...` |
| An error or refusal | red (stderr) | `401: no active ticket ...` |

The `NOTE:` and `WARNING:` prefixes are there with and without colour, so `grep NOTE:` finds every explanation. `pga/scripts/demo.sh` follows the same rules.

- **`NO_COLOR=<anything non-empty>`** turns colour off. **`FORCE_COLOR=1`** (anything non-empty except `0` and `false`) turns it on even when piped; `FORCE_COLOR=0` or `false` turns it off even on a terminal. `NO_COLOR` wins over `FORCE_COLOR`. Nothing is coloured when the output is not a terminal.
- **`DEMO_CHAPTER_DELAY_MS=<ms>`** sets the hands-off demo's pause after each chapter (default 3000 on a terminal; `0` disables it, and it also works off a terminal). A value that is not a non-negative integer is a usage error (exit 2). With `--pause`, Enter is the pause.

## Repository layout

```
shared/      config (the --local / --testnet presets), narration helpers (colours, NOTE:), layout test
sim/         the shared local stack: Anvil, mock sequencer and RPC proxy, deploy, traffic generator
fast-feed/   the Fast Feed alone: client/ (CLI, live view, tickets, keys) and mock/ (local feed and auth)
pga/         PGA alone: rules/ (the ordering, pure), bot/ (scenarios, flood, probe), scripts/demo.sh
combo/       both together: the race (S1-S3, matrix), the narrated demo, pga:slot
contracts/   Solidity: vendored Tickets, local TEST token, the Race contract (Foundry)
docs/        setup.md: install, .env, wallets, ports
```

**The dependency rule** (enforced by the layout test): `fast-feed/` and `pga/` never import each other; among the features only `combo/` imports both; `sim/` (the shared local stack) may import `pga/rules`, `fast-feed/mock`, `fast-feed/client/abi.ts` and `shared/`; nothing imports `combo/`; `shared/` imports no feature.

## Where next

Each feature README can be followed alone:

- [fast-feed/README.md](fast-feed/README.md): tickets, keys, the live view and the error table (needs no PGA knowledge).
- [pga/README.md](pga/README.md): tips, rounds, nonces, the zero tip and your own tip with `cast` (needs no ticket).
- [combo/README.md](combo/README.md): the race and the full demo walkthrough (read the two above first).
- [sim/README.md](sim/README.md): what `--local` models, and every assumption.
- [docs/setup.md](docs/setup.md): install, `.env`, wallets, ports.
