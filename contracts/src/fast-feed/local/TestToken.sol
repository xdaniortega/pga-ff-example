// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice LOCAL-ONLY stand-in for the payment token (USDG on Arbitrum One; locally it is named USDGTest).
///         6 decimals like the real ones. `mint` is public so the workshop can fund any wallet.
///         Never deploy this anywhere that holds value.
contract TestToken is ERC20 {
    constructor() ERC20("USDGTest", "USDGTest") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
