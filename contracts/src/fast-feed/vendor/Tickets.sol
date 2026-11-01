// SPDX-License-Identifier: Apache-2.0

/*
 * Copyright 2026, Offchain Labs, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

pragma solidity ^0.8.20;

import {
    AccessControlEnumerableUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ITickets} from "./ITickets.sol";

contract Tickets is ITickets, AccessControlEnumerableUpgradeable {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    /// @notice Parameters passed to `initialize`. Bundled to avoid stack-too-deep at the call site.
    struct InitParams {
        address defaultAdmin;
        address beneficiarySetter;
        address marketParamsSetter;
        address beneficiary;
        uint24 roundDuration;
        uint16 targetTicketsPerRound;
        uint16 maxTicketsPerRound;
        uint64 minimumPrice;
        uint40 priceUpdateFraction;
        uint8 grandfatherPeriodFraction;
        uint40 firstRoundStart;
    }

    /// @dev Per-account state, packed into one slot. Ticket holdings are tracked in
    ///      parity-keyed variables so that during the grandfather phase we can read
    ///      the previous round's count from the opposite-parity vars and record this
    ///      round's count in the current-parity vars.
    struct UserData {
        uint16 evenTicketsHeld;
        uint16 oddTicketsHeld;
        uint40 lastEvenRoundPurchased;
        uint40 lastOddRoundPurchased;
        uint144 tokenBalance;
    }

    /// @notice Role that can set the beneficiary account.
    bytes32 public constant BENEFICIARY_SETTER = keccak256("BENEFICIARY_SETTER");
    /// @notice Role that can queue updates to market parameters.
    bytes32 public constant MARKET_PARAMS_SETTER = keccak256("MARKET_PARAMS_SETTER");

    /// @dev Sentinel for "no grandfather fraction queued". Inverted from the other queued params
    ///      (which use 0) because 0 is a valid grandfather fraction (no grandfather phase).
    uint8 constant GRANDFATHER_PERIOD_SENTINEL = type(uint8).max;

    /// @dev Sentinel for "no excess tickets override"
    uint56 constant EXCESS_TICKETS_SOLD_SENTINEL = type(uint56).max;

    /// @inheritdoc ITickets
    /// @dev Assumed to be a standard ERC-20: no fee-on-transfer, no rebasing, no transfer hooks.
    ///      `depositToken` credits the requested amount without measuring the actual balance delta.
    address public immutable token;

    // ----- Begin Slot 0 ----- //

    // -- Begin Hot Path Storage (Accessed Every Purchase) -- //

    /// @dev uint24 seconds - up to ~194 days.
    uint24 internal _roundDuration;

    /// @dev uint16 - up to 65,535.
    uint16 internal _maxTicketsPerRound;

    /// @dev uint72 wei - up to ~4722e18.
    ///      Caching price is cheaper than recomputing via Taylor series on each purchase.
    uint72 internal _currentPrice;

    /// @dev uint40 - at 1-second rounds, supports up to ~34,865 years
    uint40 internal _roundNumber;

    /// @dev uint40 seconds - Unix timestamps to year ~36800.
    uint40 internal _roundStart;

    /// @dev uint8 - length of the grandfather phase as a fraction of 256 of the round.
    ///      e.g. 128 = first half of the round.
    uint8 internal _grandfatherPeriodFraction;

    /// @dev Type matches maxTicketsPerRound.
    uint16 internal _ticketsSoldThisRound;

    // -- End Hot Path Storage -- //
    // -- Begin Warm Path Storage (Accessed on Round Change) -- //

    /// @dev uint40 - at target of 1, max of 2^16, the lowest max change we can support is
    ///      e^((2^16 - 2) / (2^40 - 1)) = 1.00000006
    uint40 internal _priceUpdateFraction;

    // ------ End Slot 0 ------ //
    // ----- Begin Slot 1 ----- //

    /// @dev uint64 wei - up to ~18.4e18.
    uint64 internal _minimumPrice;

    /// @dev Type matches maxTicketsPerRound.
    uint16 internal _targetTicketsPerRound;

    /// @dev uint56 - Up to 2^16 excess/round (uint16 cap) * 2^40 rounds (uint40 _roundNumber)
    ///      = 2^56 worst-case excess.
    uint56 internal _excessTicketsSold;

    /// @inheritdoc ITickets
    /// @dev Set by every queued admin setter, cleared by `_lazyUpdateRoundState` after the queued
    ///      values are committed.
    bool public isAdminUpdateQueued;

    /// @dev uint112 - accumulated token proceeds from rounds prior to the last lazy update,
    ///      minus distributions already made. Sized to fill the remainder of slot 1.
    uint112 internal _storedProceeds;

    // -- End Warm Path Storage -- //

    // ------ End Slot 1 ------ //

    /// @inheritdoc ITickets
    /// @dev Type matches roundDuration.
    uint24 public nextRoundDuration;

    /// @inheritdoc ITickets
    /// @dev Type matches targetTicketsPerRound.
    uint16 public nextTargetTicketsPerRound;

    /// @inheritdoc ITickets
    /// @dev Type matches maxTicketsPerRound.
    uint16 public nextMaxTicketsPerRound;

    /// @inheritdoc ITickets
    /// @dev Type matches priceUpdateFraction.
    uint40 public nextPriceUpdateFraction;

    /// @inheritdoc ITickets
    /// @dev Type matches grandfatherPeriodFraction.
    uint8 public nextGrandfatherPeriodFraction;

    /// @inheritdoc ITickets
    /// @dev Type matches minimumPrice.
    uint64 public nextMinimumPrice;

    /// @inheritdoc ITickets
    /// @dev Type matches excessTicketsSold.
    uint56 public excessTicketsSoldOverride;

    /// @inheritdoc ITickets
    address public beneficiary;

    mapping(address => UserData) internal _userData;

    constructor(address _token) {
        token = _token;
        _disableInitializers();
    }

    function initialize(InitParams calldata p) external initializer {
        if (p.roundDuration == 0) revert RoundDurationZero();
        if (p.targetTicketsPerRound == 0) revert TargetTicketsPerRoundZero();
        if (p.maxTicketsPerRound == 0) revert MaxTicketsPerRoundZero();
        if (p.minimumPrice == 0) revert MinimumPriceZero();
        if (p.priceUpdateFraction == 0) revert PriceUpdateFractionZero();
        if (p.grandfatherPeriodFraction == GRANDFATHER_PERIOD_SENTINEL) revert GrandfatherPeriodFractionReserved();
        // forge-lint: disable-next-line(block-timestamp)
        if (p.firstRoundStart <= block.timestamp) revert FirstRoundStartNotInFuture();

        __AccessControlEnumerable_init();
        _initRoles(p.defaultAdmin, p.beneficiarySetter, p.marketParamsSetter);

        beneficiary = p.beneficiary;
        _roundDuration = p.roundDuration;
        _targetTicketsPerRound = p.targetTicketsPerRound;
        _maxTicketsPerRound = p.maxTicketsPerRound;
        _minimumPrice = p.minimumPrice;
        _priceUpdateFraction = p.priceUpdateFraction;
        _grandfatherPeriodFraction = p.grandfatherPeriodFraction;

        _roundStart = p.firstRoundStart;
        _currentPrice = p.minimumPrice;

        nextGrandfatherPeriodFraction = GRANDFATHER_PERIOD_SENTINEL;
        excessTicketsSoldOverride = EXCESS_TICKETS_SOLD_SENTINEL;
    }

    /// @dev Grants the three admin roles. Called once from `initialize`.
    function _initRoles(address defaultAdmin, address beneficiarySetter, address marketParamsSetter) internal {
        _grantRole(DEFAULT_ADMIN_ROLE, defaultAdmin);
        _grantRole(BENEFICIARY_SETTER, beneficiarySetter);
        _grantRole(MARKET_PARAMS_SETTER, marketParamsSetter);
    }

    /// @inheritdoc ITickets
    function purchaseTickets(
        uint256 expectedRound,
        uint256 expectedPrice,
        uint256 numTicketsDesired,
        bytes32 apiKeyHash
    ) external {
        _lazyUpdateRoundState();

        if (numTicketsDesired == 0) revert ZeroTicketsRequested();
        if (expectedRound != _roundNumber) revert RoundNumberMismatch(expectedRound, _roundNumber);
        if (expectedPrice != _currentPrice) revert IncorrectTicketPrice(expectedPrice, _currentPrice);
        if (_ticketsSoldThisRound >= _maxTicketsPerRound) {
            revert MaxTicketsSold();
        }

        uint16 _numTicketsDesired = numTicketsDesired.toUint16();
        uint16 _numTickets = uint256(_ticketsSoldThisRound) + uint256(_numTicketsDesired) > _maxTicketsPerRound
            ? _maxTicketsPerRound - _ticketsSoldThisRound
            : _numTicketsDesired;
        uint256 cost = expectedPrice * uint256(_numTickets);

        UserData memory userDataMem = _userData[msg.sender];
        if (userDataMem.tokenBalance < cost) {
            revert InsufficientTokenBalance(userDataMem.tokenBalance, cost);
        }

        bool roundIsEven = _roundNumber % 2 == 0;

        // forge-lint: disable-start(block-timestamp)
        if (
            _roundNumber > 0
                && block.timestamp
                    < uint256(_roundStart) + (uint256(_roundDuration) * uint256(_grandfatherPeriodFraction)) / 256
        ) {
            uint16 grandfatherTickets = _ticketCount(userDataMem, _roundNumber - 1);
            if (grandfatherTickets < _numTickets) {
                revert NotEnoughGrandfatheredTickets(grandfatherTickets, _numTickets);
            }

            if (roundIsEven) userDataMem.oddTicketsHeld = grandfatherTickets - _numTickets;
            else userDataMem.evenTicketsHeld = grandfatherTickets - _numTickets;
        }
        // forge-lint: disable-end(block-timestamp)

        userDataMem.tokenBalance -= cost.toUint144();
        uint16 prevHeld = _ticketCount(userDataMem, _roundNumber);
        if (roundIsEven) {
            userDataMem.evenTicketsHeld = prevHeld + _numTickets;
            userDataMem.lastEvenRoundPurchased = _roundNumber;
        } else {
            userDataMem.oddTicketsHeld = prevHeld + _numTickets;
            userDataMem.lastOddRoundPurchased = _roundNumber;
        }

        _userData[msg.sender] = userDataMem;
        _ticketsSoldThisRound += _numTickets;

        emit TicketsPurchased(msg.sender, _roundNumber, apiKeyHash, expectedPrice, _numTickets, numTicketsDesired);
    }

    /// @inheritdoc ITickets
    function depositToken(uint256 amount) external {
        _userData[msg.sender].tokenBalance += amount.toUint144();
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit TokensDeposited(msg.sender, amount);
    }

    /// @inheritdoc ITickets
    function withdrawToken(uint256 amount) external {
        if (_userData[msg.sender].tokenBalance < amount) {
            revert InsufficientTokenBalance(_userData[msg.sender].tokenBalance, amount);
        }
        _userData[msg.sender].tokenBalance -= amount.toUint144();
        IERC20(token).safeTransfer(msg.sender, amount);
        emit TokensWithdrawn(msg.sender, amount);
    }

    /// @inheritdoc ITickets
    function distributeSaleProceeds() external {
        uint256 amount = _storedProceeds;
        _storedProceeds = 0;
        IERC20(token).safeTransfer(beneficiary, amount);
        emit ProceedsDistributed(beneficiary, amount);
    }

    /// @inheritdoc ITickets
    function commitRoundState() external {
        _lazyUpdateRoundState();
    }

    /// @inheritdoc ITickets
    function tokenBalance(address account) external view returns (uint256) {
        return _userData[account].tokenBalance;
    }

    /// @inheritdoc ITickets
    function grandfatherCount(address account) external view returns (uint256) {
        uint256 __roundNumber = roundNumber();
        if (__roundNumber == 0) return 0;
        return _ticketCount(_userData[account], __roundNumber - 1);
    }

    /// @inheritdoc ITickets
    function thisRoundTicketCount(address account) external view returns (uint256) {
        return _ticketCount(_userData[account], roundNumber());
    }

    /// @inheritdoc ITickets
    function roundsElapsedSinceStored() public view returns (uint256) {
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < _roundStart) revert BeforeFirstRoundStart();
        return (block.timestamp - uint256(_roundStart)) / uint256(_roundDuration);
    }

    /// @inheritdoc ITickets
    function roundNumber() public view returns (uint256) {
        return uint256(_roundNumber) + roundsElapsedSinceStored();
    }

    /// @inheritdoc ITickets
    function roundStart() public view returns (uint256) {
        return uint256(_roundStart) + roundsElapsedSinceStored() * uint256(_roundDuration);
    }

    /// @inheritdoc ITickets
    function roundEnd() external view returns (uint256) {
        return roundStart() + roundDuration();
    }

    /// @inheritdoc ITickets
    function grandfatherPeriodEnd() external view returns (uint256) {
        return roundStart() + (roundDuration() * grandfatherPeriodFraction()) / 256;
    }

    /// @inheritdoc ITickets
    function roundDuration() public view returns (uint256) {
        return _applyAdminUpdate(_roundDuration, nextRoundDuration, 0);
    }

    /// @inheritdoc ITickets
    function maxTicketsPerRound() external view returns (uint256) {
        return _applyAdminUpdate(_maxTicketsPerRound, nextMaxTicketsPerRound, 0);
    }

    /// @inheritdoc ITickets
    function minimumPrice() public view returns (uint256) {
        // since nextPriceUpdateFraction and nextMinimumPrice are set together,
        // we only check the sentinel for nextPriceUpdateFraction to save gas.
        return _applyAdminUpdate(_minimumPrice, nextPriceUpdateFraction != 0 ? nextMinimumPrice : 0, 0);
    }

    /// @inheritdoc ITickets
    function targetTicketsPerRound() external view returns (uint256) {
        return _applyAdminUpdate(_targetTicketsPerRound, nextTargetTicketsPerRound, 0);
    }

    /// @inheritdoc ITickets
    function priceUpdateFraction() public view returns (uint256) {
        return _applyAdminUpdate(_priceUpdateFraction, nextPriceUpdateFraction, 0);
    }

    /// @inheritdoc ITickets
    function grandfatherPeriodFraction() public view returns (uint256) {
        return _applyAdminUpdate(_grandfatherPeriodFraction, nextGrandfatherPeriodFraction, GRANDFATHER_PERIOD_SENTINEL);
    }

    function ticketsSoldThisRound() external view returns (uint256) {
        return roundsElapsedSinceStored() == 0 ? _ticketsSoldThisRound : 0;
    }

    /// @inheritdoc ITickets
    function excessTicketsSold() public view returns (uint256) {
        uint256 elapsed = roundsElapsedSinceStored();
        if (elapsed == 0) return _excessTicketsSold;

        if (isAdminUpdateQueued && excessTicketsSoldOverride != EXCESS_TICKETS_SOLD_SENTINEL) {
            return excessTicketsSoldOverride;
        }

        uint256 gross = uint256(_excessTicketsSold) + _ticketsSoldThisRound;
        uint256 consumed = elapsed * uint256(_targetTicketsPerRound);
        return gross > consumed ? gross - consumed : 0;
    }

    /// @inheritdoc ITickets
    function currentPrice() public view returns (uint256) {
        uint256 result = _fakeExponential(minimumPrice(), excessTicketsSold(), priceUpdateFraction());
        // forge-lint: disable-next-line(unsafe-typecast)
        return result > type(uint72).max ? type(uint72).max : uint72(result);
    }

    /// @inheritdoc ITickets
    function setBeneficiary(address newBeneficiary) external onlyRole(BENEFICIARY_SETTER) {
        beneficiary = newBeneficiary;
        emit BeneficiarySet(newBeneficiary);
    }

    /// @inheritdoc ITickets
    function setRoundDuration(uint24 newDuration) external onlyRole(MARKET_PARAMS_SETTER) {
        if (newDuration == 0) revert RoundDurationZero();
        _lazyUpdateRoundState();
        isAdminUpdateQueued = true;
        nextRoundDuration = newDuration;
        emit RoundDurationQueued(newDuration);
    }

    /// @inheritdoc ITickets
    function setMaxTicketsPerRound(uint16 newMax) external onlyRole(MARKET_PARAMS_SETTER) {
        if (newMax == 0) revert MaxTicketsPerRoundZero();
        _lazyUpdateRoundState();
        isAdminUpdateQueued = true;
        nextMaxTicketsPerRound = newMax;
        emit MaxTicketsPerRoundQueued(newMax);
    }

    /// @inheritdoc ITickets
    function setTargetTicketsPerRound(uint16 newTarget) external onlyRole(MARKET_PARAMS_SETTER) {
        if (newTarget == 0) revert TargetTicketsPerRoundZero();
        _lazyUpdateRoundState();
        isAdminUpdateQueued = true;
        nextTargetTicketsPerRound = newTarget;
        emit TargetTicketsPerRoundQueued(newTarget);
    }

    /// @inheritdoc ITickets
    function setPricingParams(
        uint64 newMinimumPrice,
        uint40 newPriceUpdateFraction,
        uint56 newExcessTicketsSoldOverride
    ) external onlyRole(MARKET_PARAMS_SETTER) {
        if (newMinimumPrice == 0) revert MinimumPriceZero();
        if (newPriceUpdateFraction == 0) revert PriceUpdateFractionZero();
        if (newExcessTicketsSoldOverride == EXCESS_TICKETS_SOLD_SENTINEL) revert ExcessTicketsSoldOverrideReserved();
        _lazyUpdateRoundState();
        isAdminUpdateQueued = true;
        nextMinimumPrice = newMinimumPrice;
        nextPriceUpdateFraction = newPriceUpdateFraction;
        excessTicketsSoldOverride = newExcessTicketsSoldOverride;
        emit PricingParamsQueued(newMinimumPrice, newPriceUpdateFraction, newExcessTicketsSoldOverride);
    }

    /// @inheritdoc ITickets
    function setGrandfatherPeriodFraction(uint8 newFraction) external onlyRole(MARKET_PARAMS_SETTER) {
        if (newFraction == GRANDFATHER_PERIOD_SENTINEL) revert GrandfatherPeriodFractionReserved();
        _lazyUpdateRoundState();
        isAdminUpdateQueued = true;
        nextGrandfatherPeriodFraction = newFraction;
        emit GrandfatherPeriodFractionQueued(newFraction);
    }

    function _ticketCount(UserData memory userDataMem, uint256 __roundNumber) internal pure returns (uint16) {
        bool isEvenRound = __roundNumber % 2 == 0;
        if (isEvenRound) {
            return userDataMem.lastEvenRoundPurchased == __roundNumber ? userDataMem.evenTicketsHeld : 0;
        } else {
            return userDataMem.lastOddRoundPurchased == __roundNumber ? userDataMem.oddTicketsHeld : 0;
        }
    }

    /// @dev On the first mutative call of a new round, rolls stored round state forward and
    ///      commits any queued admin updates. No-op within the same round.
    function _lazyUpdateRoundState() internal {
        if (roundsElapsedSinceStored() > 0) {
            _storedProceeds += uint112(_ticketsSoldThisRound) * _currentPrice;

            uint40 newRoundNumber = uint40(roundNumber());
            uint40 newRoundStart = uint40(roundStart());
            uint56 newExcessTicketsSold = uint56(excessTicketsSold());
            uint72 newCurrentPrice = uint72(currentPrice());

            _roundNumber = newRoundNumber;
            _roundStart = newRoundStart;
            _excessTicketsSold = newExcessTicketsSold;
            _currentPrice = newCurrentPrice;
            _ticketsSoldThisRound = 0;

            if (isAdminUpdateQueued) {
                if (nextRoundDuration != 0) {
                    _roundDuration = nextRoundDuration;
                    nextRoundDuration = 0;
                }
                if (nextTargetTicketsPerRound != 0) {
                    _targetTicketsPerRound = nextTargetTicketsPerRound;
                    nextTargetTicketsPerRound = 0;
                }
                if (nextMaxTicketsPerRound != 0) {
                    _maxTicketsPerRound = nextMaxTicketsPerRound;
                    nextMaxTicketsPerRound = 0;
                }
                if (nextGrandfatherPeriodFraction != GRANDFATHER_PERIOD_SENTINEL) {
                    _grandfatherPeriodFraction = nextGrandfatherPeriodFraction;
                    nextGrandfatherPeriodFraction = GRANDFATHER_PERIOD_SENTINEL;
                }
                if (nextPriceUpdateFraction != 0) {
                    _priceUpdateFraction = nextPriceUpdateFraction;
                    nextPriceUpdateFraction = 0;
                }
                if (nextMinimumPrice != 0) {
                    _minimumPrice = nextMinimumPrice;
                    nextMinimumPrice = 0;
                }

                // excessTicketsSoldOverride is applied in excessTicketsSold(), which has already been called
                if (excessTicketsSoldOverride != EXCESS_TICKETS_SOLD_SENTINEL) {
                    excessTicketsSoldOverride = EXCESS_TICKETS_SOLD_SENTINEL;
                }

                isAdminUpdateQueued = false;
            }

            emit RoundStateUpdated();
        }
    }

    /// @dev View-side queued-update helper
    function _applyAdminUpdate(uint256 currValue, uint256 nextValue, uint256 sentinelValue)
        internal
        view
        returns (uint256)
    {
        return roundsElapsedSinceStored() > 0 && nextValue != sentinelValue ? nextValue : currValue;
    }

    /// @notice Approximates `factor * e^(numerator / denominator)` via a Taylor series with
    ///         integer arithmetic.
    /// @dev    Reference: EIP-4844 `fake_exponential` - https://eips.ethereum.org/EIPS/eip-4844
    ///         See also go-ethereum's reference implementation:
    ///         https://github.com/ethereum/go-ethereum/blob/16a6531ac204c110ea4b51c7905b3f71595b8f0c/consensus/misc/eip4844/eip4844.go#L217
    ///
    ///         Modified to return max uint whenever an intermediate operation overflows.
    ///         This may cause the return value to be higher than the true value.
    function _fakeExponential(uint256 factor, uint256 numerator, uint256 denominator) internal pure returns (uint256) {
        uint256 i = 1;
        uint256 output = 0;

        (bool success, uint256 accum) = Math.tryMul(factor, denominator);
        if (!success) return type(uint256).max;

        while (accum > 0) {
            (success, output) = Math.tryAdd(accum, output);
            if (!success) return type(uint256).max;

            (success, accum) = Math.tryMul(accum, numerator);
            if (!success) return type(uint256).max;

            accum = accum / denominator;
            accum = accum / i;

            ++i; // no need to check overflow because OOG will occur first
        }

        return output / denominator;
    }
}
