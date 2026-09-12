/**
 * Arc browser-side helpers: per-user chain add (WalletConnect has no Arc
 * testnet entry, so the wallet must learn the chain first — raw EIP-3085/3326
 * requests, no viem action dependency), and a wallet client factory over the
 * injected provider that traces every send — the fund-tx hashes shown in the
 * Pay panel come from that trace.
 */
import {
  createWalletClient,
  custom,
  type Address,
  type EIP1193Provider,
  type WalletClient,
} from "viem";
import { arcChain } from "./wagmi";

export function getProvider(): EIP1193Provider | undefined {
  return (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
}

/** EIP-3085 wallet_addEthereumChain params for the active Arc chain (per-user chain add). */
function arcChainParams(): Record<string, unknown> {
  return {
    chainId: `0x${arcChain.id.toString(16)}`,
    chainName: arcChain.name,
    nativeCurrency: arcChain.nativeCurrency,
    rpcUrls: [arcChain.rpcUrls.default.http[0]],
    blockExplorerUrls: arcChain.blockExplorers?.default !== undefined
      ? [arcChain.blockExplorers.default.url]
      : [],
  };
}

/**
 * Ensure the connected wallet knows the active Arc chain: switch, and add the chain
 * first when the wallet replies 4902 (WalletConnect and some injected wallets
 * have no Arc entry). Safe to call repeatedly.
 */
export async function ensureArcChain(): Promise<void> {
  const provider = getProvider();
  if (!provider) throw new Error("no injected wallet (MetaMask or Rabby). Install one and connect.");
  const request = provider.request as unknown as (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  try {
    await request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: `0x${arcChain.id.toString(16)}` }],
    });
  } catch {
    await request({ method: "wallet_addEthereumChain", params: [arcChainParams()] });
    await request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: `0x${arcChain.id.toString(16)}` }],
    });
  }
}

/** Custom transport that records every eth_sendTransaction hash it returns. */
export function tracingTransport(provider: EIP1193Provider, trace: string[]) {
  const request = provider.request as unknown as (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  return custom({
    async request(args: { method: string; params?: unknown[] }): Promise<unknown> {
      const result = (await request(args)) as unknown;
      if (args.method === "eth_sendTransaction" || args.method === "eth_sendRawTransaction") {
        trace.push(String(result));
      }
      return result;
    },
  });
}

/**
 * Wallet client for the connected address over the injected provider. Pass a
 * trace array to capture the tx hashes of every write the client signs.
 */
export function arcWalletClient(address: Address, trace?: string[]): WalletClient {
  const provider = getProvider();
  if (!provider) throw new Error("no injected wallet (MetaMask or Rabby). Install one and connect.");
  return createWalletClient({
    chain: arcChain,
    transport: trace ? tracingTransport(provider, trace) : custom(provider),
    account: address,
  });
}
