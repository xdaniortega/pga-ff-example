// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title Race
/// @notice WORKSHOP CODE, NOT PRODUCTION: a tiny "first claim wins" game used to show that, on Arbitrum, the
///         Fast Feed gets you into the right round and the tip then decides your rank inside it.
/// @dev The operator opens a race with `open(id)`. Anyone may then `claim(id)`: claims are ranked 1, 2, 3, ... in
///      the order the sequencer executes them, so rank 1 ("the winner") is the first claim in the block.
///
///      `claim` NEVER reverts, whatever the caller does, so a late bot pays no gas for a failed tx and the race
///      can be read back from events and views only:
///        - a claim on a race that is not open records nothing and emits `ClaimTooEarly`;
///        - a repeat claim by the same address in the same race is ignored and emits `AlreadyClaimed`;
///        - every other claim is recorded and emits `Claimed(id, claimer, rank)`.
contract Race {
    /// @notice The only address that may open races. Set once in the constructor.
    address public immutable operator;

    /// @dev race id => open?
    mapping(uint256 => bool) public isOpen;
    /// @dev race id => claimers in claim order (rank = index + 1)
    mapping(uint256 => address[]) private _claimers;
    /// @dev race id => claimer => rank (0 = has not claimed)
    mapping(uint256 => mapping(address => uint256)) private _rankOf;

    /// @notice A race was opened. Bots watch the Fast Feed for this event.
    event Opened(uint256 indexed id);
    /// @notice `claimer` got `rank` (1 = winner) in race `id`.
    event Claimed(uint256 indexed id, address indexed claimer, uint256 rank);
    /// @notice `claimer` had already claimed race `id`: ignored, nothing recorded.
    event AlreadyClaimed(uint256 indexed id, address indexed claimer);
    /// @notice `claimer` claimed race `id` before it was opened: nothing recorded.
    event ClaimTooEarly(uint256 indexed id, address indexed claimer);

    error NotOperator(address caller);
    error AlreadyOpen(uint256 id);

    constructor(address operator_) {
        operator = operator_;
    }

    /// @notice Open race `id`. Operator only; reverts for anyone else and for a race that is already open.
    function open(uint256 id) external {
        if (msg.sender != operator) revert NotOperator(msg.sender);
        if (isOpen[id]) revert AlreadyOpen(id);
        isOpen[id] = true;
        emit Opened(id);
    }

    /// @notice Claim race `id`. Never reverts (see the contract comment).
    function claim(uint256 id) external {
        if (!isOpen[id]) {
            emit ClaimTooEarly(id, msg.sender);
            return;
        }
        if (_rankOf[id][msg.sender] != 0) {
            emit AlreadyClaimed(id, msg.sender);
            return;
        }
        _claimers[id].push(msg.sender);
        uint256 rank = _claimers[id].length;
        _rankOf[id][msg.sender] = rank;
        emit Claimed(id, msg.sender, rank);
    }

    /// @notice The rank-1 claimer of race `id`, or the zero address when nobody has claimed it.
    function winner(uint256 id) external view returns (address) {
        return _claimers[id].length == 0 ? address(0) : _claimers[id][0];
    }

    /// @notice How many addresses claimed race `id`.
    function claimCount(uint256 id) external view returns (uint256) {
        return _claimers[id].length;
    }

    /// @notice The rank (1 = winner) of `who` in race `id`; 0 if `who` has not claimed.
    function rankOf(uint256 id, address who) external view returns (uint256) {
        return _rankOf[id][who];
    }
}
