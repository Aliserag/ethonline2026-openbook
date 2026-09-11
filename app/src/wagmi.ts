import { createConfig, http, injected } from "wagmi";
import { arcTestnet } from "wagmi/chains";
import { defineChain } from "viem";
import { env } from "./env";

/**
 * The active Arc chain. Defaults to Arc testnet (5042002) from wagmi/chains;
 * set VITE_ARC_CHAIN_ID / VITE_ARC_CHAIN_NAME / VITE_ARC_EXPLORER /
 * VITE_ARC_TESTNET_RPC to target Arc mainnet once its anchors are published —
 * no code edit (ensureArcChain() and the UI both derive from this object).
 */
const arcChain =
  env.arcChainId === arcTestnet.id
    ? arcTestnet
    : defineChain({
        id: env.arcChainId,
        name: env.arcChainName,
        nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
        rpcUrls: { default: { http: [env.arcRpc ?? "https://rpc.testnet.arc.io"] } },
        blockExplorers: { default: { name: "ArcScan", url: env.arcExplorer } },
      });

export const wagmiConfig = createConfig({
  chains: [arcChain],
  transports: {
    [arcChain.id]: http(env.arcRpc),
  },
  connectors: [injected()],
});

export { arcChain };
