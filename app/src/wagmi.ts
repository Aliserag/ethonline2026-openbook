import { createConfig, http, injected } from "wagmi";
import { arcTestnet } from "wagmi/chains";
import { env } from "./env";

/**
 * The whole demo lives on Arc testnet (5042002). HTTP transport only;
 * injected (MetaMask/Rabby) connector — WalletConnect has no Arc entry, so
 * per-user chain-add is handled by ensureArcChain() before any write.
 */
export const wagmiConfig = createConfig({
  chains: [arcTestnet],
  transports: {
    [arcTestnet.id]: http(env.arcRpc),
  },
  connectors: [injected()],
});

export { arcTestnet };
