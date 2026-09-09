/**
 * Display helpers — USDC is ALWAYS the 6-decimal ERC-20 view (Arc trap: the
 * native-gas view is 18 decimals on the SAME balance; never sum the two).
 */
export function usdc6(value: bigint | number | string): string {
  return (Number(value) / 1_000_000).toFixed(2);
}

export function truncateHash(hash: string, head = 6, tail = 4): string {
  return hash.length <= head + tail ? hash : `${hash.slice(0, head)}…${hash.slice(-tail)}`;
}

export function explorerUrl(txHash: string): string {
  return `https://testnet.arcscan.app/tx/${txHash}`;
}
