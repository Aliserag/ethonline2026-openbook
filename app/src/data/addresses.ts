import { CONFIG } from "../config";

const env = import.meta.env;

/** One world: every money surface in the app resolves through these. */
export const ADDR = {
  escrow: (env.VITE_ESCROW as `0x${string}` | undefined) ?? ("0x967e005154D0F62C33Eac8E2F44b44d4C4C07Dd5" as const),
  hook: (env.VITE_HOOK as `0x${string}` | undefined) ?? ("0x606075F3Cf9b5B66E7e4DD2ea369894374Ff0846" as const),
  policy: (env.VITE_POLICY_WALLET as `0x${string}` | undefined) ?? ("0x4e83eB15EE973A49E40D9A79aB2cA89a4Eb4894E" as const),
  usdc: (env.VITE_USDC_ADDRESS as `0x${string}` | undefined) ?? ("0x3600000000000000000000000000000000000000" as const),
  operator: (env.VITE_OPERATOR_ADDRESS as `0x${string}` | undefined) ?? ("0x64A78b6d5e99274d01D1d0A70B180A73AAEb8d21" as const),
  registry: (env.VITE_ERC8004_REGISTRY as `0x${string}` | undefined) ?? ("0x8004A818BFB912233c491871b3d84c89A494BD9e" as const),
  ens: CONFIG.ens,
} as const;

/** Addresses whose jobs are "ours" — scoping for books/theater. */
export const OUR_ADDRESSES: `0x${string}`[] = [
  ADDR.operator, // operator (seller) key — provider side of every OpenBook job
  "0xAC548CFEfe70bb3199ee214F39bC9730a8A754De", // historical CLI buyer / treasury admin — keeps README-cited jobs (e.g. 185853) in the books
  ...((env.VITE_DEMO_BUYER_ADDRESS as string | undefined)?.split(",").filter(Boolean) as `0x${string}`[] ?? []), // demo buyer key's address (comma-separated ok)
];
