/**
 * Chain clients + signer selection for the live surfaces (map, console,
 * theater). One public client (memoized) over the active arc chain, a demo
 * wallet client from VITE_DEMO_BUYER_KEY when present, and the injected
 * wallet client shared with the Pay panel (arc.ts). pickSigner is the pure
 * precedence rule the signer chores converge on.
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcChain } from "../wagmi";
import { env } from "../env";
import { arcWalletClient } from "../arc";
import type { SignerKind } from "./types";

const DEMO_KEY = import.meta.env.VITE_DEMO_BUYER_KEY as string | undefined;

let publicClient: PublicClient | undefined;

/** Memoized public client over the active Arc chain (env.arcRpc override honored). */
export function getPublicClient(): PublicClient {
  publicClient ??= createPublicClient({
    chain: arcChain,
    transport: http(env.arcRpc ?? arcChain.rpcUrls.default.http[0]),
  });
  return publicClient;
}

function demoAccount() {
  if (!DEMO_KEY || !/^0x[0-9a-fA-F]{64}$/.test(DEMO_KEY)) return null;
  try {
    return privateKeyToAccount(DEMO_KEY as `0x${string}`);
  } catch {
    return null; // malformed key — never hard-fail the demo surface
  }
}

/** Wallet client for the demo buyer key (VITE_DEMO_BUYER_KEY); null when absent/malformed. */
export function walletForDemo(): WalletClient | null {
  const account = demoAccount();
  if (!account) return null;
  return createWalletClient({
    chain: arcChain,
    transport: http(env.arcRpc ?? arcChain.rpcUrls.default.http[0]),
    account,
  });
}

/** Wallet client for the connected injected-wallet address (arc.ts factory). */
export function walletForInjected(address: Address): WalletClient {
  return arcWalletClient(address);
}

/** Pure signer precedence for the demo surfaces: demo key > injected > none. */
export function pickSigner(input: { demoKey?: string; injected?: `0x${string}` }): SignerKind {
  if (input.demoKey && input.demoKey.length > 0) return "demo";
  if (input.injected) return "injected";
  return "none";
}

/** The demo buyer's address, when VITE_DEMO_BUYER_KEY is set and valid. */
export function demoAddress(): `0x${string}` | null {
  return demoAccount()?.address ?? null;
}
