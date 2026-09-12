/**
 * ERC-8004 identity reader: the agent's onchain identity NFT on Arc testnet
 * (registry 0x8004A818BFB912233c491871b3d84c89A494BD9e, agentId 894065 —
 * scripts/erc8004-register.sh). Standard ERC-721 views; ownerOf reverts for a
 * tokenId that was never minted, which reads as null.
 */
import { type Abi, type PublicClient } from "viem";
import { ADDR } from "./addresses";

const IDENTITY_ABI = [
  {
    name: "ownerOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "uint256", name: "tokenId" }],
    outputs: [{ type: "address", name: "" }],
  },
  {
    name: "tokenURI",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "uint256", name: "tokenId" }],
    outputs: [{ type: "string", name: "" }],
  },
] as const satisfies Abi;

/** Ownership + metadata URI of an ERC-8004 identity token; null when unminted. */
export async function readIdentity(
  publicClient: PublicClient,
  tokenId: bigint,
): Promise<{ owner: `0x${string}`; uri: string } | null> {
  try {
    const [owner, uri] = await Promise.all([
      publicClient.readContract({
        address: ADDR.registry,
        abi: IDENTITY_ABI,
        functionName: "ownerOf",
        args: [tokenId],
      }),
      publicClient.readContract({
        address: ADDR.registry,
        abi: IDENTITY_ABI,
        functionName: "tokenURI",
        args: [tokenId],
      }),
    ]);
    return { owner: owner as `0x${string}`, uri: uri as string };
  } catch {
    return null;
  }
}
