import { Transfer as TransferEvent } from "../generated/ArcUSDC/ERC20";

/**
 * OpenBook Task 0 spike handler — intentionally a no-op.
 * Purpose: prove the index/build/deploy/sync pipeline for network `arc-testnet`,
 * not the schema. Task 4 replaces this file with real freshness-ledger writes
 * (and mirrors to Sepolia behind MIRROR_TO_SEPOLIA when the Graph deploy gates).
 */
export function handleTransfer(event: TransferEvent): void {
  // no-op — entity writes are wired in Task 4
}
