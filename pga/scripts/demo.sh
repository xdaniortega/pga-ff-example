#!/usr/bin/env bash
# PGA demos (mirrors pga/video-script.md). Usage: ./pga/scripts/demo.sh 1|2|3
#   1  three senders, three tips: sent lowest tip first, they land highest tip first.
#   2  one sender: nonce N (tip 0.001) and N+1 (tip 0.1), N+1 sent FIRST. The nonce decides: N lands first.
#   3  three senders, tips 0.1 / 0.01 / 0, sent lowest first: the zero tip lands last, but lands.
#
# Environment:
#   RPC       endpoint that receives the signed txs (local: http://127.0.0.1:8547; testnet: the sequencer endpoint)
#   READ_RPC  endpoint used to read the chainId, nonces and receipts (defaults to RPC; testnet: the public RPC)
#   ALLOW_TESTNET=1  required to run on Arbitrum Sepolia (421614). Only 31337 and 421614 are allowed; never mainnet.
#   K1 K2 K3  private keys (demo 2 uses only K1) of three funded wallets. When the chainId is 31337 (--local) they default
#             to the PUBLIC Anvil dev accounts 0, 1 and 2 (anyone can spend from them: local only).
#             On any other chain they are required.
# Keys are never printed.
#
# Exit codes: 0 expected PGA order; 1 not the expected order (or an error);
#             3 inconclusive (the txs landed in different rounds: rerun); 2 usage.
# "One round": on chainId 31337 the same block AND the same pga_round (read with sim_boostTrace; the simulator puts K = 2
# rounds in a block, and the batch is sent right after a block starts, so it lands in round 1). On 421614 only the block is
# known (the receipt has no pga_round), so the same block is the best check there and the script says so.
set -euo pipefail

# Output styles, the same as the TypeScript commands (shared/narrate.ts): step cyan, NOTE yellow, PASS green,
# FAIL red, INCONCLUSIVE yellow, errors red, tables default. Colour is on only on a terminal; NO_COLOR (any non-empty value)
# turns it off and beats FORCE_COLOR: 0/false turn it off even on a terminal, any other non-empty value turns it on even when piped.
use_color() { # fd
  [ -z "${NO_COLOR:-}" ] || return 1
  local f; f=$(printf '%s' "${FORCE_COLOR:-}" | tr '[:upper:]' '[:lower:]') # case-insensitive, like colorEnabled
  case "$f" in 0|false) return 1 ;; '') ;; *) return 0 ;; esac
  [ -t "$1" ]
}
paint() { # fd, ANSI code, text: prints the text (no newline), coloured when fd is a colour terminal
  if use_color "$1"; then printf '\033[%sm%s\033[0m' "$2" "$3"; else printf '%s' "$3"; fi
}
step() { paint 1 36 "==> $*"; echo; }
note() { local m="$*"; m="${m#NOTE: }"; m="${m#Note: }"; paint 1 33 "NOTE: $m"; echo; }
pass() { paint 1 '1;32' "$*"; echo; }
fail() { paint 1 '1;31' "$*"; echo; }
inconclusive() { paint 1 '1;33' "$*"; echo; }
err() { paint 2 31 "$*" >&2; echo >&2; }

usage() {
  err "Usage: ./pga/scripts/demo.sh 1|2|3"
  err "  RPC=<sequencer endpoint> [READ_RPC=<read endpoint>] [K1= K2= K3=]  (keys default to Anvil dev accounts on chainId 31337)"
}

die() { err "Error: $*"; exit 1; }

DEAD=0x000000000000000000000000000000000000dEaD

setup() {
  command -v cast >/dev/null 2>&1 || {
    [ -x "$HOME/.foundry/bin/cast" ] && export PATH="$HOME/.foundry/bin:$PATH"
  }
  command -v cast >/dev/null 2>&1 || die "cast not found. Install Foundry: curl -L https://foundry.paradigm.xyz | bash && foundryup"
  [ -n "${RPC:-}" ] || die "RPC is not set. Example (local): export RPC=http://127.0.0.1:8547 READ_RPC=\$RPC"
  READ_RPC="${READ_RPC:-$RPC}"

  CHAIN_ID=$(cast chain-id --rpc-url "$READ_RPC") || die "cannot reach READ_RPC $READ_RPC (is 'npm run sim' running?)"
  local send_chain
  send_chain=$(cast chain-id --rpc-url "$RPC") || die "cannot reach RPC $RPC (is 'npm run sim' running?)"
  [ "$send_chain" = "$CHAIN_ID" ] || die "RPC is chainId $send_chain but READ_RPC is chainId $CHAIN_ID"
  case "$CHAIN_ID" in
    31337) NETWORK="local simulator (Anvil)" ;;
    421614)
      NETWORK="Arbitrum Sepolia"
      [ "${ALLOW_TESTNET:-}" = "1" ] || die "chainId 421614 (Arbitrum Sepolia) needs an explicit ALLOW_TESTNET=1 (the testnet stage sends real testnet transactions)"
      ;;
    *) die "unsupported chainId $CHAIN_ID: this demo runs on --local (31337) and Arbitrum Sepolia (421614) only; never mainnet" ;;
  esac
  step "chainId $CHAIN_ID: $NETWORK"
  if [ "$CHAIN_ID" = "31337" ]; then
    # Public Anvil dev accounts 0, 1, 2. LOCAL ONLY.
    K1="${K1:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
    K2="${K2:-0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d}"
    K3="${K3:-0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a}"
  else
    for v in K1 K2 K3; do
      [ -n "${!v:-}" ] || die "$v is not set. On chainId $CHAIN_ID the demo needs three funded throwaway wallets: export K1=0x... K2=0x... K3=0x... (never a wallet with real funds)"
    done
  fi
}

# gwei decimal string from wei, trailing zeros trimmed (0.100000000 -> 0.1)
gwei_of() {
  cast to-unit "$1" gwei | sed -E 's/(\.[0-9]*[1-9])0+$/\1/; s/\.0+$//'
}

sign() { # key, priority tip (e.g. 0.1gwei or 0), optional nonce. Reads the nonce from READ_RPC when none is given; nothing is sent.
  local nonce=()
  [ -z "${3:-}" ] || nonce=(--nonce "$3")
  cast mktx "$DEAD" --value 0 --gas-limit 21000 --private-key "$1" \
    --gas-price 1gwei --priority-gas-price "$2" --rpc-url "$READ_RPC" ${nonce[@]+"${nonce[@]}"}
}

# Local simulator only: send right after a block STARTS, so the batch collects in the block's round 1 and cannot be split
# across its K rounds. THIS block-start sync, not the pre-signing alone, is what keeps them in one round. Only chainId 31337
# is asked for sim_msUntilNextBlock; any other chain just sends.
block_sync() {
  local ms
  # Only the local simulator (chainId 31337) has sim_msUntilNextBlock: never ask a real endpoint for it.
  [ "$CHAIN_ID" = "31337" ] || return 0
  if ms=$(cast rpc sim_msUntilNextBlock --rpc-url "$RPC" 2>/dev/null); then
    step "local simulator: waiting for the next block to start so the txs share round 1 of it"
    ms=${ms//\"/}
    sleep "$(awk -v ms="$((ms))" 'BEGIN { printf "%.3f", (ms + 60) / 1000 }')"
  fi
}

# Publish the signed txs one after another (no `&`), in the order given: that is the arrival order, and the few ms
# it takes keeps them in one round. Sets HASHES (same order).
publish_all() {
  local tx out
  HASHES=()
  for tx in "$@"; do
    out=$(cast publish "$tx" --async --rpc-url "$RPC" 2>&1) || die "cast publish failed: $out"
    HASHES+=("$(cast keccak "$tx")")
  done
}

# Wait for the receipts of HASHES (given order). Sets BLK[] IDX[] TIP[] (wei, from the receipt) FROM[] by position, and on
# the local simulator RND[] (the pga_round each tx was included in, from sim_boostTrace; empty elsewhere).
collect() {
  local h deadline=$((SECONDS + 60)) egp base
  BLK=(); IDX=(); TIP=(); FROM=(); RND=()
  step "waiting for the receipts"
  for h in "${HASHES[@]}"; do
    until cast receipt "$h" blockNumber --async --rpc-url "$READ_RPC" >/dev/null 2>&1; do
      [ "$SECONDS" -lt "$deadline" ] || die "no receipt for $h within 60s"
      sleep 0.2
    done
    BLK+=("$(cast receipt "$h" blockNumber --rpc-url "$READ_RPC")")
    IDX+=("$(cast receipt "$h" transactionIndex --rpc-url "$READ_RPC")")
    FROM+=("$(cast receipt "$h" from --rpc-url "$READ_RPC" | tr 'A-F' 'a-f')")
    egp=$(cast receipt "$h" effectiveGasPrice --rpc-url "$READ_RPC" | awk '{print $1}')
    base=$(cast block "${BLK[${#BLK[@]}-1]}" --field baseFeePerGas --rpc-url "$READ_RPC" | awk '{print $1}')
    if [ "$CHAIN_ID" = "31337" ]; then
      RND+=("$(cast rpc sim_boostTrace "$h" --rpc-url "$RPC" 2>/dev/null | grep -o '"pgaRound": *[0-9]*' | head -1 | grep -o '[0-9]*$' || true)")
    else
      RND+=("")
    fi
    # Tip from the receipt, not from the bid: effectiveGasPrice - block baseFee.
    TIP+=("$((egp - base))")
  done
}

# Positions 0..n-1 sorted by (block, idx), one per line.
landing_order() {
  local i
  for i in "${!HASHES[@]}"; do printf '%s\t%s\t%s\n' "${BLK[$i]}" "${IDX[$i]}" "$i"; done | sort -t$'\t' -k1,1n -k2,2n | cut -f3
}

# Exit 3 unless every tx landed in one round: the same block and, on the local simulator, the same pga_round.
require_one_round() {
  local i
  for i in "${!BLK[@]}"; do
    if [ "${BLK[$i]}" != "${BLK[0]}" ]; then
      inconclusive "Verdict: the txs landed in different blocks (so in different rounds); the order says nothing about the rule being shown. Rerun."
      exit 3
    fi
    if [ "$CHAIN_ID" = "31337" ] && [ -z "${RND[$i]}" ]; then
      inconclusive "Warning: the simulator gave no pga_round for tx $((i + 1)) (sim_boostTrace), so whether the txs shared a round is unknown; the order says nothing about the rule being shown. Rerun."
      exit 3
    fi
    if [ "$CHAIN_ID" = "31337" ] && [ "${RND[$i]}" != "${RND[0]}" ]; then
      inconclusive "Verdict: the txs share block ${BLK[0]} but not its round (pga_round ${RND[0]:-?} and ${RND[$i]:-?}); the order says nothing about the rule being shown. Rerun."
      exit 3
    fi
  done
  if [ "$CHAIN_ID" = "31337" ]; then
    note "All txs landed in block ${BLK[0]}, pga_round ${RND[0]:-?}."
  else
    note "On a real chain K rounds share a block and the receipt has no pga_round, so the same block does not prove the same round; this check is block-only."
  fi
  return 0
}

demo1() {
  step "Demo 1: three wallets, tips 0.001 / 0.01 / 0.1 gwei, sent lowest tip first"
  local A B C
  A=$(sign "$K1" 0.001gwei)
  B=$(sign "$K2" 0.01gwei)
  C=$(sign "$K3" 0.1gwei)
  block_sync
  publish_all "$A" "$B" "$C"
  collect

  echo
  local i
  for i in $(landing_order); do
    printf 'block %s  idx %s  from %s..  tip %-5s gwei\n' "${BLK[$i]}" "${IDX[$i]}" "${FROM[$i]:0:6}" "$(gwei_of "${TIP[$i]}")"
  done
  echo

  require_one_round
  local prev="" ok=1
  for i in $(landing_order); do
    if [ -n "$prev" ] && [ "${TIP[$i]}" -gt "$prev" ]; then ok=0; fi
    prev=${TIP[$i]}
  done
  if [ "$ok" = 1 ]; then
    pass "Verdict: PGA order (highest tip first)."
    exit 0
  else
    fail "Verdict: not in tip order (arrival order, or PGA ordering is off: was the simulator started with --fifo?)."
    exit 1
  fi
}

demo2() {
  step "Demo 2: one wallet, nonce N at tip 0.001 gwei and nonce N+1 at tip 0.1 gwei (100x), N+1 sent FIRST"
  local addr N LO HI
  addr=$(cast wallet address --private-key "$K1")
  N=$(cast nonce "$addr" --rpc-url "$READ_RPC") || die "cannot read the nonce of ${addr:0:6}.. from READ_RPC"
  LO=$(sign "$K1" 0.001gwei "$N")
  HI=$(sign "$K1" 0.1gwei "$((N + 1))")
  block_sync
  # High tip (N+1) first, then N: a tip-only sort would put N+1 first. The nonce rule must put N first.
  publish_all "$HI" "$LO"
  collect

  echo
  local i label
  for i in $(landing_order); do
    if [ "$i" = 0 ]; then label='nonce N+1'; else label='nonce N  '; fi
    printf 'idx %s  %s  tip %-5s gwei\n' "${IDX[$i]}" "$label" "$(gwei_of "${TIP[$i]}")"
  done
  echo

  require_one_round
  # Position 0 is N+1 (sent first), position 1 is N.
  if [ "${IDX[1]}" -lt "${IDX[0]}" ]; then
    pass "Verdict: nonce rule. Nonce N landed before N+1 although N+1 bid 100x the tip and was sent first:"
    note "nonce N+1 isn't valid until nonce N has executed; tips only rank across senders."
    exit 0
  else
    fail "Verdict: N+1 landed before N. That should be impossible (nonce N+1 isn't valid until nonce N has executed)."
    exit 1
  fi
}

demo3() {
  step "Demo 3: three wallets, tips 0.1 / 0.01 / 0 gwei, sent lowest tip first (the zero tip first)"
  local Z B A
  Z=$(sign "$K1" 0)
  B=$(sign "$K2" 0.01gwei)
  A=$(sign "$K3" 0.1gwei)
  block_sync
  publish_all "$Z" "$B" "$A"
  collect

  echo
  local i
  for i in $(landing_order); do
    printf 'idx %s  tip %-4s gwei\n' "${IDX[$i]}" "$(gwei_of "${TIP[$i]}")"
  done
  echo

  require_one_round
  local prev="" ok=1 last=""
  for i in $(landing_order); do
    if [ -n "$prev" ] && [ "${TIP[$i]}" -gt "$prev" ]; then ok=0; fi
    prev=${TIP[$i]}
    last=${TIP[$i]}
  done
  if [ "$ok" = 1 ] && [ "$last" = 0 ]; then
    pass "Verdict: the zero tip lands last, but lands (the queue empties every round on a quiet chain)."
    exit 0
  else
    fail "Verdict: not in tip order with the zero tip last (arrival order, or PGA ordering is off: was the simulator started with --fifo?)."
    exit 1
  fi
}

case "${1:-}" in
  1) setup; demo1 ;;
  2) setup; demo2 ;;
  3) setup; demo3 ;;
  *) usage; exit 2 ;;
esac
