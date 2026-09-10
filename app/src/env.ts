/**
 * Env surface for the demo. Only VITE_-prefixed keys reach the client bundle
 * (Vite rule). All three are OPTIONAL at build time — each missing key degrades
 * only its own panel to an explicit, actionable notice ("key not set"), never
 * a hard-coded value.
 */
export const env = {
  /** Optional Sepolia RPC for ENSv2 reads; unset -> viem default public RPC */
  sepoliaRpc: (import.meta.env.VITE_SEPOLIA_RPC as string | undefined) ?? undefined,
  /** Optional Arc testnet RPC; unset -> https://rpc.testnet.arc.io (public) */
  arcRpc: (import.meta.env.VITE_ARC_TESTNET_RPC as string | undefined) ?? undefined,
  /** The Graph Studio key: gates the delivery query (the open-book P&L endpoint is public) */
  graphKey: (import.meta.env.VITE_GRAPH_GATEWAY_KEY as string | undefined) ?? "",
  /** Alchemy key: the freshness head reference (Gateway _meta has no
   * chainHeadBlock field — the head comes from the dataset's own chain) */
  alchemyKey: (import.meta.env.VITE_ALCHEMY_API_KEY as string | undefined) ?? "",
};

export const hasGraphKey = env.graphKey.length > 0;
export const hasAlchemyKey = env.alchemyKey.length > 0;
