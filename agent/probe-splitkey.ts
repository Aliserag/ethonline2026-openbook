/** One-off probe: run the split-key createJobWithSla with receipt-status logging. */
import { createPublicClient, createWalletClient, http, keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import { createJobWithSla, getJob, ERC8183, packSla, arcFees } from "./escrow";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(".env", "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => {
    const i = l.indexOf("=");
    return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  }),
);

const RPC = "https://rpc.testnet.arc.io";
const buyer = privateKeyToAccount(env.ARC_TESTNET_PK as `0x${string}`);
const provider = privateKeyToAccount(env.ARC_RECIPIENT_PK as `0x${string}`);
const publicClient = createPublicClient({ chain: arcTestnet, transport: http(RPC) });

const bw = createWalletClient({ account: buyer, chain: arcTestnet, transport: http(RPC) });
const pw = createWalletClient({ account: provider, chain: arcTestnet, transport: http(RPC) });

const sla = {
  minBlock: Number(await publicClient.getBlockNumber()),
  schemaHash: keccak256(toBytes("probe-schema")),
  maxLatencyMs: 500,
};

console.log("packed SLA:", packSla(sla));

try {
  // wrap waitForTransactionReceipt to log each step's onchain outcome
  const origWait = publicClient.waitForTransactionReceipt.bind(publicClient);
  let n = 0;
  const waitOverride: typeof origWait = async (args) => {
    const receipt = await origWait(args);
    n += 1;
    console.log(`  step ${n}: status=${receipt.status} gasUsed=${receipt.gasUsed} hash=${receipt.transactionHash.slice(0, 14)}`);
    return receipt;
  };
  Object.assign(publicClient, { waitForTransactionReceipt: waitOverride });
  const jobId = await createJobWithSla(publicClient, {
    buyer: bw,
    provider: pw,
    evaluator: buyer.address,
    sla,
    amount6dec: 10_000n,
    expirySeconds: 3600,
  });
  console.log("jobId:", jobId);
  const job = await getJob(publicClient, jobId);
  console.log("status:", job.status, "budget:", job.budget?.toString());
} catch (error) {
  console.error("PROBE FAIL:", (error as Error).message.slice(0, 400));
  // simulate to get the revert reason
}
