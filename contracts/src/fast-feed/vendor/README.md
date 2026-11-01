# Vendored: Fast Feed ticket contract

- Source: https://github.com/OffchainLabs/feed-ticket-contracts
- Commit: `7cd464fe32417d005ee054b7130f3c427b07465a` ("fix stale docs (#30)")
- Files: `Tickets.sol`, `ITickets.sol` (upstream `src/Tickets.sol`, `src/ITickets.sol`)
- License: Apache-2.0 (SPDX header and copyright notice kept in each file)
- Modifications: **none**. The files are byte-for-byte copies; imports resolve through the
  remappings in `foundry.toml` (`@openzeppelin/contracts` v5.6.1, `@openzeppelin/contracts-upgradeable` v5.6.1).

The workshop deploys this locally behind an OpenZeppelin `TransparentUpgradeableProxy`, with
accelerated parameters (see `fast-feed/README.md`). The reference build uses `evm_version = osaka`;
this repo compiles it with `cancun` (see `foundry.toml`).

For production-style ticket renewals use the official renewal bot, not this workshop's CLI:
https://github.com/OffchainLabs/feed-ticket-contracts/tree/main/bot
