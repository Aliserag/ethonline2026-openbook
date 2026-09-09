// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PolicyWallet} from "../src/PolicyWallet.sol";

/// @dev Minimal 6-decimal ERC-20 stand-in for Arc testnet USDC
///      (6 decimals — never 18: same balance, different view).
contract MockUSDC {
    string public constant name = "USD Coin";
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract PolicyWalletTest is Test {
    MockUSDC internal usdc;
    PolicyWallet internal wallet;

    address internal owner = makeAddr("owner"); // treasury admin (ENS name manager key)
    address internal agent = makeAddr("agent"); // agent key — may request withdrawals
    address internal spare = makeAddr("spare"); // allowlisted payee
    address internal stranger = makeAddr("stranger"); // NOT allowlisted

    uint256 internal constant PER_TX_CAP = 1_000_000; // 1 USDC (6-dec)
    uint256 internal constant DAILY_CAP = 10_000_000; // 10 USDC (6-dec)
    uint256 internal constant DAY_BLOCKS = 21_600; // ~24h at 4s blocks

    function setUp() public {
        usdc = new MockUSDC();
        vm.prank(owner);
        wallet = new PolicyWallet(address(usdc), agent, PER_TX_CAP, DAILY_CAP);
        usdc.mint(address(wallet), 10_000_000); // wallet holds 10 USDC
        vm.prank(owner);
        wallet.setAllowlist(spare, true);
    }

    /// @dev 2 USDC requested, perTxCap is 1 USDC → blocked, no money moves.
    function testOverCapEmitsPolicyBlocked() public {
        vm.prank(agent);
        vm.expectEmit(true, true, true, true);
        emit PolicyWallet.PolicyBlocked("PER_TX_CAP");
        wallet.requestWithdrawal(spare, 2_000_000);

        assertEq(usdc.balanceOf(spare), 0, "no USDC may move");
        assertEq(usdc.balanceOf(address(wallet)), 10_000_000, "wallet balance untouched");
    }

    /// @dev Within caps but payee not allowlisted → blocked, no money moves.
    function testAllowlistBlocksNonListed() public {
        vm.prank(agent);
        vm.expectEmit(true, true, true, true);
        emit PolicyWallet.PolicyBlocked("NOT_ALLOWLISTED");
        wallet.requestWithdrawal(stranger, 500_000);

        assertEq(usdc.balanceOf(stranger), 0, "no USDC may move");
        assertEq(usdc.balanceOf(address(wallet)), 10_000_000, "wallet balance untouched");
    }

    /// @dev 0.5 USDC within caps + allowlisted → executed, event emitted, balance moved.
    function testWithinCapExecutes() public {
        vm.prank(agent);
        vm.expectEmit(true, true, true, true);
        emit PolicyWallet.WithdrawalExecuted(spare, 500_000);
        wallet.requestWithdrawal(spare, 500_000);

        assertEq(usdc.balanceOf(spare), 500_000, "payee received 0.5 USDC");
        assertEq(usdc.balanceOf(address(wallet)), 9_500_000, "wallet debited by 0.5 USDC");
        assertEq(wallet.spentToday(), 500_000, "spend recorded in current day bucket");
    }

    /// @dev Arc reverts on transfers to address(0); the wallet must guard it,
    ///      not emit a PolicyBlocked event.
    function testZeroAddressReverts() public {
        vm.prank(agent);
        vm.expectRevert(bytes("to is zero"));
        wallet.requestWithdrawal(address(0), 500_000);
    }

    /// @dev Day buckets are block-number based (Arc block.timestamp is not
    ///      strictly increasing): after DAY_BLOCKS blocks the spend resets.
    function testDayBucketResets() public {
        vm.startPrank(owner);
        wallet.setPolicy(1_000_000, 1_000_000); // perTxCap = dailyCap = 1 USDC
        wallet.setAllowlist(spare, true);
        vm.stopPrank();

        // Day 1: spend the entire daily cap.
        vm.prank(agent);
        wallet.requestWithdrawal(spare, 1_000_000);
        assertEq(wallet.spentToday(), 1_000_000, "day-1 spend fills daily cap");

        // Same day: a further request trips DAILY_CAP.
        vm.prank(agent);
        vm.expectEmit(true, true, true, true);
        emit PolicyWallet.PolicyBlocked("DAILY_CAP");
        wallet.requestWithdrawal(spare, 500_000);
        assertEq(usdc.balanceOf(spare), 1_000_000, "blocked request moved no money");

        // Next day bucket: spend resets and the cap is available again.
        vm.roll(block.number + DAY_BLOCKS);
        vm.prank(agent);
        wallet.requestWithdrawal(spare, 1_000_000);
        assertEq(wallet.spentToday(), 1_000_000, "spend restarts in the new bucket");
        assertEq(usdc.balanceOf(spare), 2_000_000, "day-2 spend landed");
    }

    /// @dev A fresh wallet blocks everyone until setAllowlist flips, and the
    ///      getter defaults to false.
    function testAllowlistEmptyByDefault() public {
        PolicyWallet fresh = new PolicyWallet(address(usdc), agent, PER_TX_CAP, DAILY_CAP);
        assertFalse(fresh.allowlisted(agent), "agent not allowlisted by default");
        assertFalse(fresh.allowlisted(spare), "nobody allowlisted by default");

        usdc.mint(address(fresh), 1_000_000);
        vm.prank(agent);
        vm.expectEmit(true, true, true, true);
        emit PolicyWallet.PolicyBlocked("NOT_ALLOWLISTED");
        fresh.requestWithdrawal(spare, 100_000);
        assertEq(usdc.balanceOf(spare), 0, "no USDC may move on a fresh wallet");
    }

    /// @dev setAllowlist is owner-only; the agent cannot widen it.
    function testOnlyOwnerCanSetAllowlist() public {
        vm.prank(agent);
        vm.expectRevert("not owner");
        wallet.setAllowlist(stranger, true);
        assertFalse(wallet.allowlisted(stranger), "agent could not allowlist");
    }

    /// @dev requestWithdrawal is agent-or-owner only; bystanders are rejected.
    function testOnlyAgentOrOwnerCanWithdraw() public {
        vm.expectRevert("not agent");
        wallet.requestWithdrawal(spare, 100_000);
    }
}
