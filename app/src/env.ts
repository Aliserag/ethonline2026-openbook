/**
 * Env surface for the demo. Only VITE_-prefixed keys reach the client bundle
 * (Vite rule). All three are OPTIONAL at build time — each missing key degrades
 * only its own panel to an explicit, actionable notice ("key not set"), never
 * a hard-coded value.
 */
export const env = {
  /**
   * Sepolia RPC for ENSv2 reads. Deployed origins use the page's own /api/sepolia
   * proxy (the Alchemy URL stays server-side); public RPCs are the fallback
   * either way (mcp/src/ens.ts sepoliaTransport).
   */
  sepoliaRpc:
    (import.meta.env.VITE_SEPOLIA_RPC as string | undefined) ??
    (typeof location !== "undefined" && !["localhost", "127.0.0.1", "[::1]"].includes(location.hostname) ? `${location.origin}/api/sepolia` : undefined),
  /** Optional Arc testnet RPC; unset -> https://rpc.testnet.arc.io (public) */
  arcRpc: (import.meta.env.VITE_ARC_TESTNET_RPC as string | undefined) ?? undefined,
  /** Arc chain identity — override for mainnet (e.g. 5042) without code edits. */
  arcChainId: Number(import.meta.env.VITE_ARC_CHAIN_ID ?? "5042002"),
  arcChainName: (import.meta.env.VITE_ARC_CHAIN_NAME as string | undefined) ?? "Arc Testnet",
  arcExplorer: (import.meta.env.VITE_ARC_EXPLORER as string | undefined) ?? "https://testnet.arcscan.app",
  /** USDC ERC-20 on the active chain — override for mainnet. */
  usdcAddress: (import.meta.env.VITE_USDC_ADDRESS as string | undefined) ?? undefined,
  /** The Graph Studio key: gates the delivery query (the open-book P&L endpoint is public) */
  graphKey: (import.meta.env.VITE_GRAPH_GATEWAY_KEY as string | undefined) ?? "",
  /** Alchemy key: the freshness head reference (Gateway _meta has no
   * chainHeadBlock field — the head comes from the dataset's own chain) */
  alchemyKey: (import.meta.env.VITE_ALCHEMY_API_KEY as string | undefined) ?? "",
  /** Console ask mode: OpenAI-compatible chat-completions endpoint. The LLM
   * only PROPOSES a registry command + argv — it never emits data — and the
   * registry executes. No key -> the ask lane prints how to enable it and
   * every command keeps working (the chip row is static, keyless). */
  llmBaseUrl: (import.meta.env.VITE_LLM_BASE_URL as string | undefined) ?? "https://openrouter.ai/api/v1",
  llmApiKey: (import.meta.env.VITE_LLM_API_KEY as string | undefined) ?? "",
  llmModel: (import.meta.env.VITE_LLM_MODEL as string | undefined) ?? "deepseek/deepseek-chat",
};

export const hasGraphKey = env.graphKey.length > 0;
export const hasAlchemyKey = env.alchemyKey.length > 0;
export const hasLlmKey = env.llmApiKey.length > 0;
