// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Imported only so Foundry emits an artifact for TransparentUpgradeableProxy (out/TransparentUpgradeableProxy.sol/TransparentUpgradeableProxy.json),
// which sim/deploy.ts deploys in front of the vendored Tickets implementation.
import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
