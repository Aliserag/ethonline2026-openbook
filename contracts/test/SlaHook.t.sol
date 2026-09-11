// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SlaHook} from "../src/SlaHook.sol";

/// @title SlaHook tests — the onchain adjudication contract.
/// @notice The hook is called BY the escrow; these tests call it as the
///         escrow (prank) to pin the enforcement contract:
///         submit captures the deliverable; complete is blocked unless the
///         attestation covers that exact hash AND clears the floor.
contract SlaHookTest is Test {
    SlaHook internal hook;
    address internal escrow = address(0xE5C0);
    address internal attester = address(0xA77E57);

    bytes4 internal constant SUBMIT_SELECTOR = bytes4(keccak256("submit(uint256,bytes32,bytes)"));
    bytes4 internal constant COMPLETE_SELECTOR = bytes4(keccak256("complete(uint256,bytes32,bytes)"));

    uint256 internal constant JOB = 42;
    bytes32 internal constant HASH = keccak256("deliverable-v1");

    event DeliverableCaptured(uint256 indexed jobId, bytes32 deliverable);
    event CompleteBlocked(uint256 indexed jobId, bytes32 deliverable, uint256 metaBlock, uint256 minBlock);

    function setUp() public {
        hook = new SlaHook(escrow, attester);
    }

    function _submit(uint256 jobId, bytes32 deliverable) internal {
        vm.prank(escrow);
        hook.afterAction(jobId, SUBMIT_SELECTOR, abi.encode(address(0xB0B), deliverable, bytes("")));
    }

    function _complete(uint256 jobId) internal {
        vm.prank(escrow);
        hook.beforeAction(jobId, COMPLETE_SELECTOR, abi.encode(address(0xB0B), bytes32("ok"), bytes("")));
    }

    // --- lifecycle happy path -------------------------------------------------

    function test_freshDelivery_completes() public {
        _submit(JOB, HASH);
        assertEq(hook.submitted(JOB), HASH, "deliverable captured from submit");

        vm.prank(attester);
        hook.attest(JOB, HASH, 1000, 950); // metaBlock 1000 >= floor 950

        _complete(JOB); // must not revert
    }

    function test_staleDelivery_complete_reverts() public {
        _submit(JOB, HASH);
        vm.prank(attester);
        hook.attest(JOB, HASH, 900, 950); // 900 < floor 950 — stale

        vm.expectRevert(abi.encodeWithSelector(SlaHook.SlaNotMet.selector, 900, 950));
        _complete(JOB);
    }

    function test_attestation_for_other_hash_reverts() public {
        _submit(JOB, HASH);
        vm.prank(attester);
        hook.attest(JOB, keccak256("different-payload"), 1000, 950);

        vm.expectRevert(SlaHook.HashMismatch.selector);
        _complete(JOB);
    }

    function test_missing_attestation_reverts() public {
        _submit(JOB, HASH);
        vm.expectRevert(SlaHook.MissingAttestation.selector);
        _complete(JOB);
    }

    function test_submit_without_capture_reverts() public {
        vm.prank(attester);
        hook.attest(JOB, HASH, 1000, 950);
        // no submit captured — completion must still be blocked
        vm.expectRevert(SlaHook.HashMismatch.selector);
        _complete(JOB);
    }

    function test_supports_erc165_and_hook_interface() public view {
        // the escrow's createJob gate: ERC165Checker.supportsInterface(hook, IACPHook.interfaceId)
        bytes4 hookId = bytes4(keccak256("beforeAction(uint256,bytes4,bytes)")) ^
            bytes4(keccak256("afterAction(uint256,bytes4,bytes)"));
        assertTrue(hook.supportsInterface(hookId), "IACPHook interfaceId");
        assertTrue(hook.supportsInterface(0x01ffc9a7), "ERC-165 itself");
        assertFalse(hook.supportsInterface(0xdeadbeef), "unknown interface");
    }

    // --- access control --------------------------------------------------------

    function test_attest_only_attester() public {
        vm.expectRevert(SlaHook.NotAttester.selector);
        hook.attest(JOB, HASH, 1000, 950);
    }

    function test_hook_callbacks_only_escrow() public {
        vm.expectRevert(SlaHook.NotEscrow.selector);
        hook.beforeAction(JOB, COMPLETE_SELECTOR, "");
        vm.expectRevert(SlaHook.NotEscrow.selector);
        hook.afterAction(JOB, SUBMIT_SELECTOR, "");
    }

    function test_non_complete_selectors_pass_through() public {
        // submit/fund/reject actions must never be blocked by the hook
        vm.prank(escrow);
        hook.beforeAction(JOB, SUBMIT_SELECTOR, "");
    }

    function test_attester_rotation() public {
        address next = address(0xF00D);
        vm.prank(attester);
        hook.setAttester(next);
        assertEq(hook.attester(), next);

        vm.prank(attester);
        vm.expectRevert(SlaHook.NotAttester.selector);
        hook.attest(JOB, HASH, 1000, 950);
    }

    // --- event trail ------------------------------------------------------------

    function test_blocked_completion_emits_event() public {
        _submit(JOB, HASH);
        vm.prank(attester);
        hook.attest(JOB, HASH, 900, 950);

        vm.expectEmit(true, false, false, true, address(hook));
        emit CompleteBlocked(JOB, HASH, 900, 950);
        vm.prank(escrow);
        vm.expectRevert(abi.encodeWithSelector(SlaHook.SlaNotMet.selector, 900, 950));
        hook.beforeAction(JOB, COMPLETE_SELECTOR, "");
    }
}
