// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ChipVault} from "../src/ChipVault.sol";

contract ChipVaultTest is Test {
    ChipVault internal vault;

    address internal operator = makeAddr("operator");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    uint256 internal constant MIN_DEPOSIT = 0.01 ether;

    event Deposited(address indexed payer, bytes32 indexed intentId, uint256 amount);

    /// The signature this vault used to carry, kept only so the test below can
    /// prove it is gone.
    bytes4 internal constant OLD_PAYOUT = bytes4(keccak256("payout(address,uint256,bytes32)"));

    function setUp() public {
        vault = new ChipVault(operator, MIN_DEPOSIT);
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
    }

    function test_DepositEmitsEventAndHoldsFunds() public {
        bytes32 intent = keccak256("intent-1");

        vm.expectEmit(true, true, false, true);
        emit Deposited(alice, intent, 0.5 ether);

        vm.prank(alice);
        vault.deposit{value: 0.5 ether}(intent);

        assertEq(address(vault).balance, 0.5 ether);
        assertTrue(vault.intentUsed(intent));
    }

    function test_DepositRejectsReusedIntent() public {
        bytes32 intent = keccak256("intent-1");

        vm.prank(alice);
        vault.deposit{value: 0.5 ether}(intent);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(ChipVault.IntentAlreadyUsed.selector, intent));
        vault.deposit{value: 0.5 ether}(intent);
    }

    function test_DepositRejectsDust() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ChipVault.DepositTooSmall.selector, 1 wei, MIN_DEPOSIT));
        vault.deposit{value: 1 wei}(keccak256("dust"));
    }

    function test_DepositRejectedWhilePaused() public {
        vm.prank(operator);
        vault.setDepositsPaused(true);

        vm.prank(alice);
        vm.expectRevert(ChipVault.DepositsArePaused.selector);
        vault.deposit{value: 0.5 ether}(keccak256("intent-1"));
    }

    function test_BareTransferReverts() public {
        vm.prank(alice);
        (bool ok,) = address(vault).call{value: 0.5 ether}("");
        assertFalse(ok);
    }

    /// Chips are one-way, and this is where that stops being a promise.
    ///
    /// There is no player withdrawal function to call, so the check is that the
    /// selector finds nothing: with no matching function and no fallback, the
    /// call reverts whoever sends it. The operator is included on purpose,
    /// because "the operator chooses not to" is a policy and this is meant to be
    /// a property.
    function test_NoPayoutPathExists() public {
        vm.prank(alice);
        vault.deposit{value: 1 ether}(keccak256("intent-1"));

        bytes memory call = abi.encodeWithSelector(OLD_PAYOUT, alice, 0.95 ether, keccak256("redemption-1"));

        vm.prank(alice);
        (bool byPlayer,) = address(vault).call(call);
        assertFalse(byPlayer);

        vm.prank(operator);
        (bool byOperator,) = address(vault).call(call);
        assertFalse(byOperator);

        assertEq(address(vault).balance, 1 ether);
    }

    function test_SweepMovesFundsToOperator() public {
        vm.prank(alice);
        vault.deposit{value: 1 ether}(keccak256("intent-1"));

        vm.prank(operator);
        vault.sweep(operator, 0.05 ether);

        assertEq(operator.balance, 0.05 ether);
        assertEq(address(vault).balance, 0.95 ether);
    }

    function test_SweepOnlyOwner() public {
        vm.prank(alice);
        vault.deposit{value: 1 ether}(keccak256("intent-1"));

        vm.prank(alice);
        vm.expectRevert(ChipVault.NotOwner.selector);
        vault.sweep(alice, 0.5 ether);
    }

    function test_SweepRejectsOverBalance() public {
        vm.prank(alice);
        vault.deposit{value: 1 ether}(keccak256("intent-1"));

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(ChipVault.InsufficientBalance.selector, 2 ether, 1 ether));
        vault.sweep(operator, 2 ether);
    }

    function test_FundAcceptsTopUp() public {
        vm.prank(operator);
        vm.deal(operator, 1 ether);
        vault.fund{value: 1 ether}();
        assertEq(address(vault).balance, 1 ether);
    }

    function test_OwnershipIsTwoStep() public {
        vm.prank(operator);
        vault.transferOwnership(bob);
        assertEq(vault.owner(), operator);

        vm.prank(alice);
        vm.expectRevert(ChipVault.NotPendingOwner.selector);
        vault.acceptOwnership();

        vm.prank(bob);
        vault.acceptOwnership();
        assertEq(vault.owner(), bob);
        assertEq(vault.pendingOwner(), address(0));
    }

    function testFuzz_DepositAboveMinimumIsHeld(uint96 amount, bytes32 intent) public {
        amount = uint96(bound(amount, MIN_DEPOSIT, 5 ether));

        vm.prank(alice);
        vault.deposit{value: amount}(intent);

        assertEq(address(vault).balance, amount);
    }
}
