/** SlaHook reads the page needs outside the purchase runner. */
import { parseAbi, type PublicClient } from "viem";
import { ADDR } from "./addresses";

const HOOK_ATTESTER_ABI = parseAbi(["function attester() view returns (address)"]);

/** The SlaHook's attester, read live: the only key whose freshness proofs the hook accepts, and the evaluator of every page purchase. */
export async function readHookAttester(publicClient: PublicClient): Promise<`0x${string}`> {
  return publicClient.readContract({ address: ADDR.hook, abi: HOOK_ATTESTER_ABI, functionName: "attester" }) as Promise<`0x${string}`>;
}
