// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ArcProxy — minimal ERC-1967 proxy (OpenBook testnet use).
/// @notice Points at an already-deployed implementation and runs its
///         `initialize` once, so a fresh instance of the shared ERC-8183
///         reference escrow can be stood up where the deployer holds
///         ADMIN_ROLE (required to whitelist OpenBook's SlaHook — the shared
///         deployment's admin key is not ours). Not upgradeable by design:
///         one deployment, one purpose.
contract ArcProxy {
    /// @dev ERC-1967 implementation slot.
    bytes32 private constant IMPL_SLOT =
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    error InitializeFailed(bytes reason);

    constructor(address implementation, bytes memory initData) {
        assembly {
            sstore(IMPL_SLOT, implementation)
        }
        (bool ok, bytes memory ret) = implementation.delegatecall(initData);
        if (!ok) revert InitializeFailed(ret);
    }

    fallback() external payable {
        assembly {
            let impl := sload(IMPL_SLOT)
            calldatacopy(0, 0, calldatasize())
            let result := delegatecall(gas(), impl, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch result
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }

    receive() external payable {}
}
