/**
 * Shared external anchors for sla-subgraph-mcp (OpenBook Task 5).
 * Values are the plan's verified anchors (no secrets).
 */

/** The Graph Gateway base URL. */
export const GATEWAY_BASE = "https://gateway.thegraph.com";

/** Arc testnet RPC (chain 5042002). */
export const ARC_RPC_URL = "https://rpc.testnet.arc.io";

/** Arc block cadence used to derive SLA deadlines (~4s/block, plan DAY_BLOCKS=21600/24h). */
export const ARC_MS_PER_BLOCK = 4000;

/** ENSv2 UniversalResolverV2 on Sepolia (verified anchor). */
export const UNIVERSAL_RESOLVER_V2 = "0x4a1817D13e9CF196F471725176355c1234b63c70";
