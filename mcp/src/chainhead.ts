/**
 * Chain-head resolver for the freshness gate (OpenBook Task 5 live-key fix).
 *
 * The Graph Gateway's `_meta` type has NO `chainHeadBlock` field (live probe,
 * 2026-09-09): requesting it errors the whole query. The freshness reference
 * therefore comes from the dataset's own chain — Alchemy's `eth_blockNumber`
 * on Arbitrum/Ethereum mainnets. Staleness math is unchanged:
 * head − _meta.block.number > dataset.freshness.maxAge → STALE.
 *
 * The resolver is injected in tests (never touched in production paths except
 * the default); the default is a viem publicClient per chain over Alchemy.
 */
import { createPublicClient, http, type PublicClient } from "viem";
import { arbitrum, mainnet } from "viem/chains";

export type DatasetChain = "arbitrum" | "ethereum";

export type ChainHeadResolver = (chain: DatasetChain) => Promise<number>;

/** Alchemy JSON-RPC base URLs per dataset chain (keyed override). */
export const CHAIN_RPC: Record<DatasetChain, (apiKey: string) => string> = {
  arbitrum: (apiKey) => `https://arb-mainnet.g.alchemy.com/v2/${apiKey}`,
  ethereum: (apiKey) => `https://eth-mainnet.g.alchemy.com/v2/${apiKey}`,
};

/** Keyless public RPCs (read-only eth_blockNumber; no account needed). */
export const PUBLIC_CHAIN_RPC: Record<DatasetChain, string> = {
  arbitrum: "https://arb1.arbitrum.io/rpc",
  ethereum: "https://eth.llamarpc.com",
};

const clients = new Map<string, PublicClient>();

function clientFor(chain: DatasetChain, apiKey: string | undefined): PublicClient {
  const url = apiKey ? CHAIN_RPC[chain](apiKey) : PUBLIC_CHAIN_RPC[chain];
  // cache by URL — an Alchemy-keyed client must never poison the public
  // fallback client for the same chain (live-found bug 2026-09-10)
  const cached = clients.get(url);
  if (cached) return cached;
  const client = createPublicClient({
    chain: chain === "arbitrum" ? arbitrum : mainnet,
    transport: http(url),
  });
  clients.set(url, client);
  return client;
}

/**
 * The default resolver: `eth_blockNumber` on the dataset's chain. Public RPCs
 * by default (arb1.arbitrum.io / eth.llamarpc.com — read-only, no key);
 * Alchemy when ALCHEMY_API_KEY is set AND its app has the network enabled —
 * a 2026-09-09 live probe returned "ARB_MAINNET is not enabled for this app"
 * for a present-but-unconfigured key, so Alchemy failures fall back to the
 * public RPC instead of fail-closing.
 */
export function defaultChainHeadResolver(apiKey: string | undefined): ChainHeadResolver {
  return async (chain) => {
    if (apiKey) {
      try {
        return Number(await clientFor(chain, apiKey).getBlockNumber());
      } catch {
        // fall through to the public RPC — a misconfigured Alchemy app must
        // never block the freshness gate
      }
    }
    return Number(await clientFor(chain, undefined).getBlockNumber());
  };
}
