PGA on Arbitrum: tips finally do something
Runtime: 3.5–4 min (480 spoken words at 150 wpm, plus screen beats). Commands are real; run them with demo.sh on a PGA-enabled chain. Source: https://docs.arbitrum.io/how-arbitrum-works/priority-gas-auction/pga

0:00 Hook
SAY Arbitrum is replacing Timeboost with a new way to order transactions: priority gas auctions, or PGA. Ordering used to be first come, first served. Under PGA, your tip decides where you land. Let's prove it. Three wallets, three tips, sent at the same moment.

0:18 Setup
SAY All we need is Foundry's cast. If I send these one at a time, they can land in different rounds, and then arrival time decides the order, not the tip. So I sign everything first with cast mktx, which builds a signed transaction without sending it. Then I fire them all at once with cast publish.

SCREEN

export RPC=<pga-enabled rpc>  K1=0x...  K2=0x...  K3=0x...

cast mktx 0x...dEaD --value 0 --private-key $K1 \
  --gas-price 1gwei --priority-gas-price 0.001gwei --rpurl $RPC
0:45 Demo 1: three senders, three tips
SAY Three wallets. Tips of 0.001, 0.01 and 0.1 gwei. Signed, then sent together.

SCREEN

A=$(cast mktx ... --private-key $K1 --priority-gas-price 0.001gwei ...)
B=$(cast mktx ... --private-key $K2 --priority-gas-price 0.01gwei ...)
C=$(cast mktx ... --private-key $K3 --priority-gas-price 0.1gwei ...)

for tx in $A $B $C; do cast publish $tx --async --rpc-url $RPC & done; wait
SAY Here's what happens at the sequencer. New transactions land in an unordered waiting list. Every round, that whole list moves into a priority queue, sorted by tip. Then the sequencer drains the queue into the block, highest tip first, until the queue is empty, the block is full, or the round ends. On Arbitrum One, a block is 250 milliseconds with two rounds per block, so a new round starts every 125 milliseconds. And if two transactions have the same tip, the one that reached the sequencer first goes first.

"Tip" here means the effective tip, the standard EIP-1559 one:

SCREEN

priority_fee = min(maxPriorityFeePerGas, maxFeePerGas - baseFee)
baseFee = 0.01 gwei
tip 0.1 gwei, maxFee 1 gwei     -> min(0.1, 0.99) = 0.1  gwei
tip 0.1 gwei, maxFee 0.05 gwei  -> min(0.1, 0.04) = 0.04 gwei
SAY So a big tip with a low max fee gets capped. Now, where did mine land? cast keccak on the raw transaction gives me the hash.

SCREEN

cast receipt $(cast keccak $C) transactionIndex --rpc-url $RPC
./demo.sh 1 output (paste your real run):

block N  idx 1  from 0x3c44..  tip 0.1   gwei
block N  idx 2  from 0x7099..  tip 0.01  gwei
block N  idx 3  from 0xf39f..  tip 0.001 gwei
SAY Highest tip, first slot. Sent at the same moment, sorted by tip.

2:10 Demo 2: same sender, nonce wins
SAY So why three different wallets? Because inside one wallet, the nonce decides. Watch. One transaction from my wallet with a tiny tip, then a second with a tip a hundred times bigger.

SCREEN

N=$(cast nonce $(cast wallet address --private-key $K1) --rpc-url $RPC)
LO=$(cast mktx ... --nonce $N       --priority-gas-price 0.001gwei ...)
HI=$(cast mktx ... --nonce $((N+1)) --priority-gas-price 0.1gwei ...)
./demo.sh 2 output:

idx 1  nonce N    tip 0.001 gwei
idx 2  nonce N+1  tip 0.1   gwei
SAY Nonce N plus one isn't even valid until nonce N has executed. So tips only rank transactions across senders. Within one account, nonce order wins. Overpaying on the later transaction buys you nothing.

2:40 Demo 3: zero tip still gets in
SAY Last one. Zero tip, next to two paying transactions.

SCREEN

Z=$(cast mktx ... --priority-gas-price 0 ...)
./demo.sh 3 output:

idx 1  tip 0.1  gwei
idx 2  tip 0.01 gwei
idx 3  tip 0    gwei
SAY It lands last, but it lands. On a quiet chain that's easy. The queue empties every round. The real question is what happens under load. That's the anti-starvation boost.

SCREEN

at the end of every round where the queue isn't empty,
each tx still waiting gets:
  boost = p / (2K)
  p = tip of the last tx included in the previous round (0 if none)
  K = rounds per block (2 on Arbitrum One)
K = 2, marginal tip p stays flat
boost per round = p/4
after 4 rounds: 0 + 4 x p/4 = p
  -> ties a fresh tx tipping p, and wins on earlier arrival
4 rounds x 125ms = ~500ms
SAY The boost moves your place in the queue. It never changes what you pay. So under pressure, a zero tip waits a few rounds. It doesn't starve.

3:20 The catch + outro
SAY So, the catches. Your tip only competes with what's still in the queue. Once a transaction has been sequenced, no tip can jump it. Arriving late can cost you more than tipping low. The mempool stays private, so nobody sees your bid. You're bidding blind. And tips aren't refunded. On Arbitrum One, 97% go to the Arbitrum DAO treasury and 3% to the Arbitrum Developer Guild.

So to recap. Across senders, the highest tip goes first. Within a sender, nonce wins. And a zero tip still gets in, just later. Script's in the description. Go run it yourself. Let's learn.
