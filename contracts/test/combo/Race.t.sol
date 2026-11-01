// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {Race} from "../../src/combo/Race.sol";

contract RaceTest is Test {
    event Opened(uint256 indexed id);
    event Claimed(uint256 indexed id, address indexed claimer, uint256 rank);
    event AlreadyClaimed(uint256 indexed id, address indexed claimer);
    event ClaimTooEarly(uint256 indexed id, address indexed claimer);

    Race race;
    address operator = makeAddr("operator");
    address mine = makeAddr("mine");
    address rival = makeAddr("rival");
    address late = makeAddr("late");

    function setUp() public {
        race = new Race(operator);
    }

    function test_openEmitsOpened() public {
        vm.expectEmit(true, false, false, true);
        emit Opened(7);
        vm.prank(operator);
        race.open(7);
        assertTrue(race.isOpen(7));
    }

    function test_onlyOperatorCanOpen() public {
        vm.expectRevert(abi.encodeWithSelector(Race.NotOperator.selector, rival));
        vm.prank(rival);
        race.open(1);
        assertFalse(race.isOpen(1));
    }

    function test_repeatOpenReverts() public {
        vm.startPrank(operator);
        race.open(1);
        vm.expectRevert(abi.encodeWithSelector(Race.AlreadyOpen.selector, 1));
        race.open(1);
        vm.stopPrank();
    }

    function test_claimsGetRanksInOrderAndWinnerIsRankOne() public {
        vm.prank(operator);
        race.open(1);
        vm.expectEmit(true, true, false, true);
        emit Claimed(1, rival, 1);
        vm.prank(rival);
        race.claim(1);
        vm.expectEmit(true, true, false, true);
        emit Claimed(1, mine, 2);
        vm.prank(mine);
        race.claim(1);
        vm.expectEmit(true, true, false, true);
        emit Claimed(1, late, 3);
        vm.prank(late);
        race.claim(1);

        assertEq(race.rankOf(1, rival), 1);
        assertEq(race.rankOf(1, mine), 2);
        assertEq(race.rankOf(1, late), 3);
        assertEq(race.claimCount(1), 3);
        assertEq(race.winner(1), rival);
    }

    function test_winnerIsZeroWithoutClaims() public {
        assertEq(race.winner(1), address(0));
        vm.prank(operator);
        race.open(1);
        assertEq(race.winner(1), address(0));
    }

    function test_lateClaimerNeverReverts() public {
        vm.prank(operator);
        race.open(1);
        vm.prank(rival);
        race.claim(1);
        // Ten more claimers long after the winner: none reverts, ranks keep counting.
        for (uint256 i = 0; i < 10; i++) {
            vm.prank(address(uint160(0x1000 + i)));
            race.claim(1);
        }
        assertEq(race.claimCount(1), 11);
        assertEq(race.winner(1), rival);
    }

    function test_claimBeforeOpenDoesNotRevertAndRecordsNothing() public {
        vm.expectEmit(true, true, false, true);
        emit ClaimTooEarly(1, mine);
        vm.prank(mine);
        race.claim(1);
        assertEq(race.claimCount(1), 0);
        assertEq(race.rankOf(1, mine), 0);
        assertEq(race.winner(1), address(0));
        // And the same address can still claim once the race is open: the early claim did not use up its turn.
        vm.prank(operator);
        race.open(1);
        vm.prank(mine);
        race.claim(1);
        assertEq(race.winner(1), mine);
    }

    function test_repeatClaimBySameAddressIsIgnored() public {
        vm.prank(operator);
        race.open(1);
        vm.prank(mine);
        race.claim(1);
        vm.prank(rival);
        race.claim(1);
        vm.expectEmit(true, true, false, false);
        emit AlreadyClaimed(1, mine);
        vm.prank(mine);
        race.claim(1);
        assertEq(race.claimCount(1), 2);
        assertEq(race.rankOf(1, mine), 1);
        assertEq(race.rankOf(1, rival), 2);
    }

    function test_racesAreIndependent() public {
        vm.startPrank(operator);
        race.open(1);
        race.open(2);
        vm.stopPrank();
        vm.prank(mine);
        race.claim(1);
        vm.prank(rival);
        race.claim(2);
        assertEq(race.winner(1), mine);
        assertEq(race.winner(2), rival);
    }

    /// The bot pre-signs `claim` with gas = estimate(unopened race) * 1.1 + CLAIM_GAS_MARGIN (100_000, combo/race.ts).
    /// A first claim on an open race must cost no more than that margin over the cheap estimate, with cold storage.
    function test_gasOfAnOpenRaceFirstClaimStaysInsideTheBotsMargin() public {
        uint256 claimGasMargin = 100_000; // keep in sync with CLAIM_GAS_MARGIN in combo/race.ts
        // What the bot estimates: a claim on a race that is not open yet (ClaimTooEarly).
        vm.cool(address(race));
        vm.prank(mine);
        uint256 g0 = gasleft();
        race.claim(1);
        uint256 early = g0 - gasleft();

        vm.prank(operator);
        race.open(2);
        vm.cool(address(race));
        vm.prank(mine);
        uint256 g1 = gasleft();
        race.claim(2); // the first claim of an open race: three fresh storage slots and the Claimed event
        uint256 first = g1 - gasleft();

        assertEq(race.rankOf(2, mine), 1);
        assertLt(first, 120_000, "first claim of an open race");
        assertLt(first - early, claimGasMargin, "extra gas over the unopened estimate stays inside the pre-sign margin");
    }

    /// `claim` never reverts: any id, any caller, before or after open, any number of repeats.
    function testFuzz_claimNeverReverts(uint256 id, address caller, bool opened, uint8 repeats) public {
        if (opened) {
            vm.prank(operator);
            race.open(id);
        }
        for (uint256 i = 0; i <= repeats; i++) {
            vm.prank(caller);
            race.claim(id); // a revert here fails the test
        }
        if (opened) {
            assertEq(race.rankOf(id, caller), 1);
            assertEq(race.claimCount(id), 1);
            assertEq(race.winner(id), caller);
        } else {
            assertEq(race.rankOf(id, caller), 0);
            assertEq(race.claimCount(id), 0);
        }
    }
}
