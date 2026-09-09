// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Minimal ERC-20 surface PolicyWallet interacts with.
///      Arc testnet USDC: 0x3600000000000000000000000000000000000000, 6 decimals.
interface IERC20 {
    function transfer(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @title PolicyWallet
/// @notice Onchain spending-policy wallet for the OpenBook agent.
///         Emits onchain `PolicyBlocked` events instead of silently skipping
///         payments (Circle agent-wallet policies are mainnet-only and emit no
///         onchain events — this contract is the testnet replacement).
/// @dev Caps are in 6-decimal USDC units. Day buckets are BLOCK-NUMBER based
///      (`block.timestamp` is not strictly increasing on Arc — verified trap).
///      Gas floor on Arc is 20 Gwei (verified: lower tips are silently dropped).
contract PolicyWallet {
    IERC20 public immutable usdc; // Arc testnet USDC (6 decimals)
    address public owner; // ENS name manager key (treasury admin)
    address public agent; // agent key — may request withdrawals
    uint256 public perTxCap; // 6-dec units, per single withdrawal
    uint256 public dailyCap; // 6-dec units, per day bucket
    uint256 public spentToday; // spent in the current day bucket
    uint256 public lastDayStart; // block number where the day bucket began
    uint256 public constant DAY_BLOCKS = 21_600; // ~24h at 4s blocks
    mapping(address => bool) public allowlisted;

    event WithdrawalExecuted(address indexed to, uint256 amount);
    event PolicyBlocked(string reason);
    event PolicySet(uint256 perTxCap, uint256 dailyCap);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier onlyAgentOrOwner() {
        require(msg.sender == agent || msg.sender == owner, "not agent");
        _;
    }

    constructor(address usdc_, address agent_, uint256 perTxCap_, uint256 dailyCap_) {
        usdc = IERC20(usdc_);
        owner = msg.sender;
        agent = agent_;
        perTxCap = perTxCap_;
        dailyCap = dailyCap_;
        lastDayStart = block.number;
    }

    /// @notice Attempt a withdrawal to `to`. Fails loud through `PolicyBlocked`
    ///         when a policy is violated; only a clean pass moves USDC.
    function requestWithdrawal(address to, uint256 amount) external onlyAgentOrOwner {
        require(amount > 0, "zero amount");
        // Arc reverts transfers to address(0); guard before any policy checks.
        require(to != address(0), "to is zero");

        // Roll the day bucket on block-number boundaries.
        if (block.number - lastDayStart >= DAY_BLOCKS) {
            spentToday = 0;
            lastDayStart = block.number;
        }

        if (amount > perTxCap) {
            emit PolicyBlocked("PER_TX_CAP");
            return;
        }
        if (spentToday + amount > dailyCap) {
            emit PolicyBlocked("DAILY_CAP");
            return;
        }
        if (!allowlisted[to]) {
            emit PolicyBlocked("NOT_ALLOWLISTED");
            return;
        }

        spentToday += amount;
        require(usdc.transfer(to, amount), "transfer failed");
        emit WithdrawalExecuted(to, amount);
    }

    function setPolicy(uint256 perTxCap_, uint256 dailyCap_) external onlyOwner {
        perTxCap = perTxCap_;
        dailyCap = dailyCap_;
        emit PolicySet(perTxCap_, dailyCap_);
    }

    function setAllowlist(address to, bool ok) external onlyOwner {
        allowlisted[to] = ok;
    }
}
