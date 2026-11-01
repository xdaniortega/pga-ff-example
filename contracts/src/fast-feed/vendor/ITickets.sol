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

pragma solidity ^0.8.0;

/// @title  Tickets
/// @notice Sells and tracks feed tickets that grant holders access to a premium sequencer feed.
///         Up to a configurable cap of tickets are sold each round at a single price set by an
///         EIP-4844 style update rule. During a configurable grandfather phase at the start of
///         each round, a previous-round ticket holder may purchase up to the number of tickets
///         they held in the previous round; afterwards anyone may purchase. Tickets become
///         active once the round in which they were purchased ends.
interface ITickets {
    error RoundDurationZero();
    error TargetTicketsPerRoundZero();
    error MaxTicketsPerRoundZero();
    error MinimumPriceZero();
    error PriceUpdateFractionZero();

    /// @notice Thrown when an initializer or `setGrandfatherPeriodFraction` is called with
    ///         `type(uint8).max`, which is reserved as the "no update queued" sentinel.
    error GrandfatherPeriodFractionReserved();

    /// @notice Thrown when `setPricingParams` is called with `type(uint56).max` for the `excessTicketsSoldOverride`,
    ///         which is reserved as the "no override queued" sentinel.
    error ExcessTicketsSoldOverrideReserved();

    /// @notice Thrown when `initialize` is given a `firstRoundStart` that is not strictly in the future.
    error FirstRoundStartNotInFuture();

    /// @notice Thrown when `purchaseTickets` is called with an `expectedRound` that does not
    ///         match the current round.
    /// @param  expected The round the caller passed as `expectedRound`.
    /// @param  actual   The contract's current round.
    error RoundNumberMismatch(uint256 expected, uint256 actual);

    /// @notice Thrown when `purchaseTickets` is called with an `expectedPrice` that does not equal
    ///         the current price.
    /// @param  expected The price the caller passed as `expectedPrice`.
    /// @param  actual   The contract's current price.
    error IncorrectTicketPrice(uint256 expected, uint256 actual);

    /// @notice Thrown when `purchaseTickets` is called with `numTicketsDesired == 0`.
    error ZeroTicketsRequested();

    /// @notice Thrown when `purchaseTickets` is called for a round that is already sold out.
    ///         A request that merely exceeds the remaining room is partially filled rather than reverted.
    error MaxTicketsSold();

    /// @notice Thrown when `purchaseTickets` or `withdrawToken` is called by an account whose
    ///         deposited token balance is less than the amount required.
    /// @param  balance  The caller's current deposited token balance.
    /// @param  required The amount required to complete the operation.
    error InsufficientTokenBalance(uint256 balance, uint256 required);

    /// @notice Thrown when `purchaseTickets` is called during the grandfather phase and the caller
    ///         does not hold enough tickets from the previous round to cover the fill.
    /// @param  grandfatheredTickets Tickets the caller is grandfathered to redeem this round.
    /// @param  requestedTickets     Tickets that would be filled for the caller this round.
    error NotEnoughGrandfatheredTickets(uint256 grandfatheredTickets, uint256 requestedTickets);

    /// @notice Thrown by `roundsElapsedSinceStored` (and views that depend on it) when called
    ///         before `firstRoundStart`.
    error BeforeFirstRoundStart();

    /// @notice Emitted when tickets are purchased.
    /// @param  buyer       The account that purchased the tickets.
    /// @param  round       The round the tickets were purchased in.
    /// @param  apiKeyHash  The hash of the API key associated with the purchased tickets.
    /// @param  price       The per-ticket price paid.
    /// @param  numTickets  The number of tickets purchased in this call.
    /// @param  numTicketsDesired The number of tickets the buyer attempted to purchase.
    event TicketsPurchased(
        address indexed buyer,
        uint256 indexed round,
        bytes32 indexed apiKeyHash,
        uint256 price,
        uint256 numTickets,
        uint256 numTicketsDesired
    );

    /// @notice Emitted when accumulated sale proceeds are forwarded to the beneficiary.
    /// @param  beneficiary The account that received the proceeds.
    /// @param  amount      The amount forwarded.
    event ProceedsDistributed(address indexed beneficiary, uint256 amount);

    /// @notice Emitted when an account deposits payment tokens to fund future ticket purchases.
    /// @param  depositor The account whose internal balance is credited.
    /// @param  amount    The amount of payment tokens transferred in.
    event TokensDeposited(address indexed depositor, uint256 amount);

    /// @notice Emitted when an account withdraws unused payment tokens from its internal balance.
    /// @param  withdrawer The account whose internal balance is debited.
    /// @param  amount     The amount of payment tokens transferred out.
    event TokensWithdrawn(address indexed withdrawer, uint256 amount);

    /// @notice Emitted when the beneficiary is updated. Takes effect immediately.
    /// @param  newBeneficiary The new account that will receive sale proceeds.
    event BeneficiarySet(address indexed newBeneficiary);

    /// @notice Emitted when a new round duration is queued. Takes effect next active round.
    /// @param  newDuration The duration of each round.
    event RoundDurationQueued(uint256 newDuration);

    /// @notice Emitted when a new max tickets per round is queued. Takes effect next active round.
    /// @param  newMax The maximum tickets that can be sold per round.
    event MaxTicketsPerRoundQueued(uint256 newMax);

    /// @notice Emitted when a new target tickets per round is queued. Takes effect next active round.
    /// @param  newTarget The targeted number of tickets to sell per round.
    event TargetTicketsPerRoundQueued(uint256 newTarget);

    /// @notice Emitted when new pricing parameters are queued. Takes effect next active round.
    /// @param  newMinimumPrice The minimum ticket price.
    /// @param  newPriceUpdateFraction The price update fraction.
    /// @param  newExcessTicketsSoldOverride The value to install as `excessTicketsSold` when the
    ///                                      queued pricing params are committed.
    event PricingParamsQueued(
        uint256 newMinimumPrice, uint256 newPriceUpdateFraction, uint256 newExcessTicketsSoldOverride
    );

    /// @notice Emitted when a new grandfather period fraction is queued. Takes effect next active round.
    /// @param  newFraction The new grandfather phase length as a fraction of 256 of the round.
    event GrandfatherPeriodFractionQueued(uint256 newFraction);

    /// @notice Emitted when stored round state is rolled forward by the lazy-update path.
    event RoundStateUpdated();

    /// @notice Purchase tickets for the current round. Fills up to `numTicketsDesired`, clamped to
    ///         the room remaining before `maxTicketsPerRound`, and debits `expectedPrice * filled`
    ///         from the caller's deposited token balance; the caller must have first funded that
    ///         balance via `depositToken`. Reverts if the round is already sold out.
    ///         During the grandfather phase at the start of a round, the caller may purchase up to
    ///         the number of tickets they held in the previous round.
    /// @dev    A buyer near the cap may receive (and pay for) fewer tickets than requested; the call only reverts if the round is already sold out.
    /// @param  expectedRound Round the caller expects to be current. Reverts if it does not match.
    /// @param  expectedPrice Price the caller expects. Reverts if the current price does not equal this value.
    /// @param  numTicketsDesired Maximum number of tickets to purchase. Must be non-zero.
    /// @param  apiKeyHash    The hash of the API key to associate with the ticket purchase.
    function purchaseTickets(
        uint256 expectedRound,
        uint256 expectedPrice,
        uint256 numTicketsDesired,
        bytes32 apiKeyHash
    ) external;

    /// @notice Forward accumulated sale proceeds (those already rolled over by a prior lazy
    ///         update) to the current beneficiary. Permissionless. Does not trigger lazy update,
    ///         so revenue from the in-flight round is not included until the next mutative call
    ///         (or an explicit `commitRoundState`) rolls the round over.
    function distributeSaleProceeds() external;

    /// @notice Roll stored round state forward and commit any queued admin updates. Permissionless.
    ///         No-op once the stored round matches the wall-clock round. Reverts with
    ///         `BeforeFirstRoundStart` if called before `firstRoundStart`.
    function commitRoundState() external;

    /// @notice Deposit payment tokens to the caller's internal balance to fund future ticket
    ///         purchases. The caller must have first approved this contract for at least `amount`.
    /// @param  amount Number of payment tokens to pull from the caller.
    function depositToken(uint256 amount) external;

    /// @notice Withdraw unused payment tokens from the caller's internal balance.
    /// @param  amount Number of payment tokens to return to the caller. Reverts with
    ///                `InsufficientTokenBalance` if greater than the caller's balance.
    function withdrawToken(uint256 amount) external;

    /// @notice ERC-20 payment token accepted for ticket purchases. Set at construction; immutable.
    function token() external view returns (address);

    /// @notice Internal payment-token balance of `account`, available to be spent on ticket
    ///         purchases or withdrawn via `withdrawToken`.
    /// @param  account The account whose balance to read.
    function tokenBalance(address account) external view returns (uint256);

    /// @notice Tickets `account` can still claim under grandfather rules in the current round:
    ///         tickets purchased in the prior round that have not already been exercised this
    ///         round. Returns 0 in round 0, when `account` did not purchase in the prior round,
    ///         or once all such tickets have been grandfathered this round.
    /// @param  account The account whose grandfather count to read.
    function grandfatherCount(address account) external view returns (uint256);

    /// @notice Tickets `account` has purchased so far in the current round
    function thisRoundTicketCount(address account) external view returns (uint256);

    /// @notice Account that receives ticket sale proceeds.
    function beneficiary() external view returns (address);

    /// @notice Duration of a round, in seconds.
    function roundDuration() external view returns (uint256);

    /// @notice Targeted number of tickets to sell per round. Drives the pricing function.
    function targetTicketsPerRound() external view returns (uint256);

    /// @notice Hard cap on tickets sold per round.
    function maxTicketsPerRound() external view returns (uint256);

    /// @notice Minimum ticket price. Floor of the pricing function.
    function minimumPrice() external view returns (uint256);

    /// @notice Parameter controlling how quickly price moves per excess ticket sold.
    function priceUpdateFraction() external view returns (uint256);

    /// @notice Length of the grandfather phase at the start of each round, as a fraction of 256
    ///         of the round duration. During the grandfather phase a previous-round ticket holder
    ///         may purchase up to the number of tickets they held in the previous round.
    ///         e.g. 128 = first half of the round.
    function grandfatherPeriodFraction() external view returns (uint256);

    /// @notice True iff at least one queued admin update has not yet been committed by lazy update.
    ///         Cleared on the first mutative call of a later round.
    function isAdminUpdateQueued() external view returns (bool);

    /// @notice Queued round duration. Takes effect next active round; zero if none queued.
    function nextRoundDuration() external view returns (uint24);

    /// @notice Queued target tickets per round. Takes effect next active round; zero if none queued.
    function nextTargetTicketsPerRound() external view returns (uint16);

    /// @notice Queued max tickets per round. Takes effect next active round; zero if none queued.
    function nextMaxTicketsPerRound() external view returns (uint16);

    /// @notice Queued minimum price. Takes effect next active round; zero if none queued.
    function nextMinimumPrice() external view returns (uint64);

    /// @notice Queued price update fraction. Takes effect next active round; zero if none queued.
    function nextPriceUpdateFraction() external view returns (uint40);

    /// @notice Queued grandfather period fraction. Takes effect next active round; `type(uint8).max`
    ///         if none queued (since 0 is a valid grandfather fraction meaning "no grandfather phase").
    function nextGrandfatherPeriodFraction() external view returns (uint8);

    /// @notice Queued override for `excessTicketsSold()`, applied together with the next pricing
    ///         params so the admin can keep `currentPrice` relatively stable across a pricing-param change.
    ///         Reads `type(uint56).max` (the "no override queued" sentinel) when no override is queued,
    ///         so that 0 is a valid override value.
    function excessTicketsSoldOverride() external view returns (uint56);

    /// @notice Number of tickets sold in the current round.
    function ticketsSoldThisRound() external view returns (uint256);

    /// @notice Number of full rounds that have elapsed since the stored round start.
    function roundsElapsedSinceStored() external view returns (uint256);

    /// @notice Current round number. Tickets bought in `roundNumber() - 1` are active;
    ///         tickets bought in `roundNumber()` are still being sold.
    function roundNumber() external view returns (uint256);

    /// @notice Start timestamp of the current round (inclusive).
    function roundStart() external view returns (uint256);

    /// @notice End timestamp of the current round (exclusive).
    function roundEnd() external view returns (uint256);

    /// @notice End timestamp of the grandfather phase of the current round (exclusive). Before this
    ///         time a previous-round ticket holder may purchase up to the number of tickets they
    ///         held in the previous round.
    function grandfatherPeriodEnd() external view returns (uint256);

    /// @notice Total tickets sold in excess of the cumulative target as of the end of last round.
    /// @dev    Within the active stored round (no rounds elapsed), returns the stored value directly.
    ///         Once a round has elapsed, this view returns either:
    ///         (a) `excessTicketsSoldOverride` if a pricing update is queued - lets the admin
    ///             avoid a price jump across the param change; or
    ///         (b) the stored value plus `_ticketsSoldThisRound`, minus elapsed
    ///             rounds' worth of target (saturated at zero).
    function excessTicketsSold() external view returns (uint256);

    /// @notice Ticket price for the current round, in wei.
    /// @dev    The price is `fake_exponential(minimumPrice(), excessTicketsSold(), priceUpdateFraction())`
    ///         (EIP-4844 style), clamped at `type(uint72).max` (~4722e18). If the formula would
    ///         exceed that cap, this returns `type(uint72).max` and tickets are sold at the cap
    ///         rather than at the higher formula price. An intermediate overflow inside
    ///         `fake_exponential` saturates to `type(uint256).max` instead of reverting, and is
    ///         likewise clamped to the cap.
    function currentPrice() external view returns (uint256);

    /// @notice Set the account that receives sale proceeds. Takes effect immediately.
    /// @param  newBeneficiary The new beneficiary.
    function setBeneficiary(address newBeneficiary) external;

    /// @notice Queue a new round duration. Takes effect next active round.
    /// @param  newDuration The new duration of each round.
    ///                     Must be greater than zero, which is reserved as the
    ///                     "no update queued" sentinel and is an invalid value.
    function setRoundDuration(uint24 newDuration) external;

    /// @notice Queue a new hard cap on tickets sold per round. Takes effect next active round.
    /// @param  newMax The new max tickets per round.
    ///                Must be greater than zero, which is reserved as the
    ///                "no update queued" sentinel and is an invalid value.
    function setMaxTicketsPerRound(uint16 newMax) external;

    /// @notice Queue a new target tickets per round. Takes effect next active round.
    /// @param  newTarget The new target tickets per round.
    ///                   Must be greater than zero, which is reserved as the
    ///                   "no update queued" sentinel and is an invalid value.
    function setTargetTicketsPerRound(uint16 newTarget) external;

    /// @notice Queue new pricing parameters. Takes effect next active round.
    ///         May cause a discontinuous jump in the current price.
    ///         The resulting price after the update takes effect will be
    ///         `min(fake_exponential(newMinimumPrice, excessTicketsSoldOverride, newPriceUpdateFraction), type(uint72).max)`.
    /// @param  newMinimumPrice              The new minimum ticket price.
    ///                                      Must be greater than zero, which is reserved as the
    ///                                      "no update queued" sentinel and is an invalid value.
    /// @param  newPriceUpdateFraction       The new price update fraction.
    ///                                      Must be greater than zero, which is reserved as the
    ///                                      "no update queued" sentinel and is an invalid value.
    /// @param  newExcessTicketsSoldOverride The value to install as `excessTicketsSold` when the
    ///                                      queued pricing params are committed.
    ///                                      Must not equal `type(uint56).max`, which is reserved as
    ///                                      the "no override queued" sentinel.
    function setPricingParams(
        uint64 newMinimumPrice,
        uint40 newPriceUpdateFraction,
        uint56 newExcessTicketsSoldOverride
    ) external;

    /// @notice Queue a new grandfather period fraction. Takes effect next active round.
    /// @param  newFraction The new grandfather phase length as a fraction of 256 of the round.
    ///                     Must not equal `type(uint8).max`, which is reserved as the
    ///                     "no update queued" sentinel; pass 0 to disable the grandfather phase.
    function setGrandfatherPeriodFraction(uint8 newFraction) external;
}
