// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title SlaHook — onchain SLA adjudication for ERC-8183 jobs (OpenBook).
/// @notice Enforces the delivery verdict IN the escrow contract's hook path:
///         once registered on a job, `complete()` can only succeed when the
///         attester has posted a freshness proof that (a) covers the exact
///         deliverable hash the provider submitted and (b) clears the SLA
///         block floor. A stale delivery cannot be completed — the only
///         remaining path is reject/refund. The verdict moves from client
///         convention to contract requirement.
///
/// Trust model, stated plainly: the attester (the operator) supplies the
/// freshness fact (`metaBlock`) — the hook makes that fact BINDING and
/// publicly checkable (stored onchain, compared to the submitted hash and
/// the floor at completion time). Anyone can read `attestations[jobId]`
/// and re-derive the check against the Graph Gateway.
///
/// Interface: EIP-8183 `IACPHook` (normative): beforeAction MAY revert to
/// block the action; afterAction runs post-state-change.
interface IACPHook {
    function beforeAction(uint256 jobId, bytes4 selector, bytes calldata data) external;
    function afterAction(uint256 jobId, bytes4 selector, bytes calldata data) external;
}

/// @dev Minimal view of the escrow: only what the hook reads back.
interface IACPJobView {
    function jobs(uint256 jobId)
        external
        view
        returns (
            uint256 id,
            address client,
            address provider,
            address evaluator,
            string memory description,
            uint256 budget,
            uint256 expiredAt,
            uint8 status,
            address hook
        );
}

contract SlaHook is IACPHook {
    /// @notice The escrow this hook serves (reads jobs back from it).
    address public immutable escrow;
    /// @notice The single key allowed to post freshness attestations.
    address public attester;

    struct Attestation {
        bytes32 deliverable; // the exact deliverable hash attested fresh
        uint256 metaBlock; // indexed block of the delivered payload
        uint256 minBlock; // the SLA floor it must clear
        uint256 attestedAt; // block timestamp of the attestation
    }

    /// @notice jobId => the attester's freshness proof for its delivery.
    mapping(uint256 => Attestation) public attestations;
    /// @notice jobId => deliverable hash captured from the escrow's submit call.
    mapping(uint256 => bytes32) public submitted;

    bytes4 public constant SUBMIT_SELECTOR = bytes4(keccak256("submit(uint256,bytes32,bytes)"));
    bytes4 public constant COMPLETE_SELECTOR = bytes4(keccak256("complete(uint256,bytes32,bytes)"));

    event Attested(uint256 indexed jobId, bytes32 deliverable, uint256 metaBlock, uint256 minBlock);
    event DeliverableCaptured(uint256 indexed jobId, bytes32 deliverable);
    event CompleteAllowed(uint256 indexed jobId, bytes32 deliverable, uint256 metaBlock, uint256 minBlock);
    event CompleteBlocked(uint256 indexed jobId, bytes32 deliverable, uint256 metaBlock, uint256 minBlock);

    error NotAttester();
    error NotEscrow();
    error MissingAttestation();
    error HashMismatch();
    error SlaNotMet(uint256 metaBlock, uint256 minBlock);
    error BadAttestation();

    modifier onlyAttester() {
        if (msg.sender != attester) revert NotAttester();
        _;
    }

    constructor(address escrow_, address attester_) {
        if (escrow_ == address(0) || attester_ == address(0)) revert BadAttestation();
        escrow = escrow_;
        attester = attester_;
    }

    function setAttester(address next) external onlyAttester {
        if (next == address(0)) revert BadAttestation();
        attester = next;
    }

    /// @notice Post the freshness proof for a job's delivery. The attester is
    ///         the operator: it observed the delivery and its `_meta.block`.
    function attest(uint256 jobId, bytes32 deliverable, uint256 metaBlock, uint256 minBlock)
        external
        onlyAttester
    {
        if (deliverable == bytes32(0)) revert BadAttestation();
        attestations[jobId] = Attestation({
            deliverable: deliverable,
            metaBlock: metaBlock,
            minBlock: minBlock,
            attestedAt: block.timestamp
        });
        emit Attested(jobId, deliverable, metaBlock, minBlock);
    }

    /// @notice ERC-165 — required by the escrow's hook gate
    ///         (`ERC165Checker.supportsInterface(hook, type(IACPHook).interfaceId)`,
    ///         which reverts InvalidJob when absent).
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IACPHook).interfaceId || interfaceId == 0x01ffc9a7;
    }

    /// @notice Hook callbacks — called by the escrow for the job's actions.
    function beforeAction(uint256 jobId, bytes4 selector, bytes calldata) external override {
        if (msg.sender != escrow) revert NotEscrow();
        if (selector != COMPLETE_SELECTOR) return;

        Attestation memory a = attestations[jobId];
        if (a.deliverable == bytes32(0)) revert MissingAttestation();
        bytes32 delivered = submitted[jobId];
        if (delivered == bytes32(0) || a.deliverable != delivered) revert HashMismatch();
        if (a.metaBlock < a.minBlock) {
            emit CompleteBlocked(jobId, a.deliverable, a.metaBlock, a.minBlock);
            revert SlaNotMet(a.metaBlock, a.minBlock);
        }
        emit CompleteAllowed(jobId, a.deliverable, a.metaBlock, a.minBlock);
    }

    /// @notice Capture the provider's submitted deliverable from the escrow's
    ///         submit call so completion can be bound to the exact bytes.
    function afterAction(uint256 jobId, bytes4 selector, bytes calldata data) external override {
        if (msg.sender != escrow) revert NotEscrow();
        if (selector != SUBMIT_SELECTOR) return;
        (, bytes32 deliverable,) = abi.decode(data, (address, bytes32, bytes));
        submitted[jobId] = deliverable;
        emit DeliverableCaptured(jobId, deliverable);
    }
}
