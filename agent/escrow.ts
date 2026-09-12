/**
 * ERC-8183 seller/buyer settlement spine (OpenBook Task 3).
 *
 * Thin, verified viem helpers over Arc's official AgenticCommerce reference
 * deployment (`0x0747…4583`, proxy → verified impl `0xa316…351a`; paymentToken
 * = native USDC `0x3600…0000`, 6 decimals; platform/evaluator fees 0; hook
 * address(0) whitelisted — all verified in Task 0).
 *
 * Lifecycle (verified selectors + arg shapes from the ERC-8183 tutorial and the
 * 71-entry arcscan ABI at agent/abi/erc8183.json):
 *   client     createJob → approve(USDC) → fund
 *   provider   setBudget → submit(jobId, deliverableHash)
 *   evaluator  complete / reject                        (auto-refunds client)
 *   client     claimRefund after expiredAt              (timeout path)
 *
 * Arc runtime notes baked in:
 *  - `expiredAt` is a UNIX TIMESTAMP (verified: the reference impl reverts
 *    `expiredAt <= now + 5min` with `ExpiryTooShort`). The plan's sketch said
 *    "block.number + expiryBlocks" — that predates the verification and would
 *    revert; we therefore take `expirySeconds` from `block.timestamp`.
 *  - the mempool enforces a 20 Gwei `maxFeePerGas` floor (verified:
 *    baseFeePerGas is pinned at exactly 20 Gwei); the RPC's SUGGESTED price
 *    (eth_gasPrice) floats above it (25 Gwei observed 2026-09-09) — fees are
 *    read live via arcFees() rather than pinned, so a future base-fee move
 *    can never revert a write.
 *  - write() passes the ACCOUNT OBJECT (never a bare address) — a bare address
 *    is read as a JSON-RPC account and routes through eth_sendTransaction,
 *    which Arc's RPC does not serve (live failure: MethodNotFoundRpcError).
 *  - USDC amount6dec is ALWAYS the 6-decimal ERC-20 view — never the
 *    18-decimal native-gas view.
 */

import {
  keccak256,
  toBytes,
  type Abi,
  type Account,
  type Address,
  type Hash,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import { arcTestnet } from "viem/chains";
import erc8183AbiRaw from "./abi/erc8183.json";

/** Full 71-entry verified ABI of the AgenticCommerce reference (copied from scripts/spikes/abi/erc8183.json). */
export const ERC8183_ABI = erc8183AbiRaw as Abi;

/** ERC-8183 AgenticCommerce reference deployment on Arc testnet (Task 0-verified). */
export const ERC8183: Address = "0x0747EEf0706327138c69792bF28Cd525089e4583";

/**
 * The escrow this process writes to. Defaults to the shared reference
 * deployment; set via `setEscrowAddress` (buyer-cli reads OPENBOOK_ESCROW) to
 * target a dedicated instance — e.g. one whose admin can whitelist the
 * onchain SLA hook (`contracts/src/SlaHook.sol`). Reads and writes inside
 * this module go through `escrowAddress()` so a single override flips them all.
 */
let escrowOverride: Address | null = null;

export function setEscrowAddress(address: Address | null): void {
  escrowOverride = address;
}

export function escrowAddress(): Address {
  return escrowOverride ?? ERC8183;
}

/** USDC ERC-20 view on Arc testnet — 6 decimals, same balance as native gas (never sum the two views). */
export const USDC: Address = "0x3600000000000000000000000000000000000000";

/**
 * The USDC ERC-20 this process approves/reads. Defaults to the Arc testnet
 * predeploy; set via `setUsdcAddress` (buyer-cli reads OPENBOOK_USDC) when a
 * network uses a different USDC address — e.g. Arc mainnet. 6 decimals
 * either way; never the 18-decimal gas view.
 */
let usdcOverride: Address | null = null;

export function setUsdcAddress(address: Address | null): void {
  usdcOverride = address;
}

export function usdcAddress(): Address {
  return usdcOverride ?? USDC;
}

export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

/** Public Arc testnet RPC (chain 5042002). */
export const ARC_RPC_URL = "https://rpc.testnet.arc.io";

/** viem chain definition (built-in since viem ≥ 2.35). */
export const ARC_CHAIN = arcTestnet;

export const USDC_ABI = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "transfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const satisfies Abi;

/**
 * Arc fee model: the mempool enforces a 20 Gwei maxFeePerGas floor (verified:
 * baseFeePerGas is pinned at exactly 20 Gwei), while the RPC's SUGGESTED price
 * (eth_gasPrice, base+tip) floats (25 Gwei observed 2026-09-09). A fixed cap
 * stays valid only while the base fee holds — reading fees live via
 * estimateFeesPerGas keeps every write valid if the pin ever moves. arcFees()
 * is the single source.
 */
export async function arcFees(publicClient: PublicClient): Promise<{
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}> {
  const est = await publicClient.estimateFeesPerGas();
  const tip = est.maxPriorityFeePerGas ?? 1_000_000_000n;
  const floor = 20_000_000_000n + tip;
  const cap = est.maxFeePerGas > floor ? est.maxFeePerGas : floor;
  return { maxFeePerGas: cap, maxPriorityFeePerGas: tip };
}

/** SLA freshness terms packed into the job description (consumed by Tasks 5/6). */
export interface Sla {
  /** minimum freshness block the deliverable's _meta.block must satisfy */
  minBlock: number;
  /** identifier for the dataset schema (full 32-byte hash, 0x-prefixed) */
  schemaHash: `0x${string}`;
  /** maximum tolerated latency, ms */
  maxLatencyMs: number;
}

/**
 * Deterministic SLA packing: fixed key order → byte-identical JSON for the same
 * terms. Keeps the FULL hash (the plan's Step-1 expectation rendered it as
 * "0xabab…" display shorthand). Format: JSON.stringify({minBlock, schemaHash,
 * maxLatencyMs}) — the interface shared verbatim by Tasks 5 and 6.
 */
export function packSla(sla: Sla): string {
  return JSON.stringify({
    minBlock: sla.minBlock,
    schemaHash: sla.schemaHash,
    maxLatencyMs: sla.maxLatencyMs,
  });
}

/** Inverse of packSla with shape validation (throws on malformed input). */
export function parseSla(description: string): Sla {
  let parsed: unknown;
  try {
    parsed = JSON.parse(description);
  } catch {
    throw new Error(`invalid SLA description: not JSON (${description})`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("invalid SLA description: expected an object");
  }
  const p = parsed as Record<string, unknown>;
  if (
    typeof p.minBlock !== "number" ||
    typeof p.schemaHash !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(p.schemaHash) ||
    typeof p.maxLatencyMs !== "number"
  ) {
    throw new Error(
      "invalid SLA description: expected {minBlock: number, schemaHash: 0x + 64 hex, maxLatencyMs: number}",
    );
  }
  return {
    minBlock: p.minBlock,
    schemaHash: p.schemaHash as `0x${string}`,
    maxLatencyMs: p.maxLatencyMs,
  };
}

export interface JobView {
  id: bigint;
  client: Address;
  provider: Address;
  evaluator: Address;
  description: string;
  budget: bigint;
  expiredAt: bigint;
  status: number;
  hook: Address;
}

/** JobStatus enum of the reference impl (getJob().status). */
export const JOB_STATUS = ["Open", "Funded", "Submitted", "Completed", "Rejected", "Expired"] as const;

/** Onchain view of a job (getJob). Normalizes array vs struct decoding across viem versions. */
export async function getJob(publicClient: PublicClient, jobId: bigint): Promise<JobView> {
  const raw = (await publicClient.readContract({
    address: escrowAddress(),
    abi: ERC8183_ABI,
    functionName: "getJob",
    args: [jobId],
  })) as unknown as readonly unknown[] | Record<string, unknown>;
  const arr = Array.isArray(raw) ? raw : null;
  const obj = arr ? null : (raw as Record<string, unknown>);
  const field = (key: string, index: number): unknown =>
    arr ? arr[index] : obj?.[key];
  return {
    id: BigInt(field("id", 0) as bigint),
    client: field("client", 1) as Address,
    provider: field("provider", 2) as Address,
    evaluator: field("evaluator", 3) as Address,
    description: field("description", 4) as string,
    budget: BigInt(field("budget", 5) as bigint),
    expiredAt: BigInt(field("expiredAt", 6) as bigint),
    status: Number(field("status", 7) as bigint | number),
    hook: field("hook", 8) as Address,
  };
}

export interface CreateJobParams {
  /**
   * Buyer's wallet client. Signs createJob, the USDC approve and fund — the
   * BUYER pays the escrow. Its attached account is the job's client.
   */
  buyer: WalletClient;
  /**
   * Provider's wallet client. Signs setBudget — the reference impl only lets
   * the PROVIDER quote the budget (verified Task 0), so it cannot be signed by
   * the buyer's key. Its attached account is the job's provider. To run
   * single-key (one key plays buyer + provider + evaluator, legal per spec),
   * pass the SAME wallet client for buyer and provider.
   *
   * Marketplace mode may pass a bare ADDRESS (the chosen seller's serving
   * address, `svc.operator`): createJob/fund then carry that provider with no
   * signature from it, setBudget is SKIPPED (only the provider's own key may
   * quote the budget) — the job funds with budget 0 and the seller's own loop
   * signs setBudget/submit. The reference impl verified: fund() with an unset
   * budget moves no USDC and still emits JobFunded; submit() is valid on a
   * Funded job with any budget.
   */
  provider: WalletClient | Address;
  /** Evaluator address — settles via complete/reject; may equal buyer or provider. */
  evaluator: Address;
  sla: Sla;
  /** escrow amount in 6-decimal USDC units — NEVER the 18-decimal gas view */
  amount6dec: bigint;
  /**
   * Job deadline as seconds from `now`. Default 3600. The reference impl
   * compares `expiredAt` against block.timestamp and reverts below now+300s
   * (ExpiryTooShort, Task 0-verified).
   */
  expirySeconds?: number;
  /** optional ERC-8183 hook; default address(0) (whitelisted, verified) */
  hook?: Address;
}

/**
 * Full job-funding sequence with the buyer-paid role split:
 *   buyer    createJob(packed SLA) → approve(USDC) → fund
 *   provider setBudget (provider-only in the reference — MUST be their key)
 * Returns the fresh jobId parsed from our own JobCreated log (no jobCounter
 * race). Pass the same wallet client as buyer and provider for single-key
 * operation (one key playing buyer + provider + evaluator is legal per the
 * verified spec). Consumed by Tasks 5/6: buyer = the paying agent's wallet,
 * provider = the OpenBook seller key.
 */
export async function createJobWithSla(
  publicClient: PublicClient,
  params: CreateJobParams,
): Promise<bigint> {
  const { buyer, provider, evaluator, sla, amount6dec } = params;
  const hook = params.hook ?? ZERO_ADDRESS;
  const expirySeconds = params.expirySeconds ?? 3600;
  requireAccount(buyer); // early validation: the buyer signs createJob/approve/fund
  const providerAddress = typeof provider === "string" ? provider : requireAccount(provider).address;
  const providerSigner = typeof provider === "string" ? null : provider; // who may sign setBudget

  const { timestamp } = await publicClient.getBlock();
  const expiredAt = timestamp + BigInt(expirySeconds);

  // 1. BUYER creates the job — description carries the packed SLA; the
  // provider is a plain ADDRESS argument (no provider signature needed to
  // create a job for it — verified in contracts/reference/AgenticCommerce.sol)
  const createHash = await write(publicClient, buyer, {
    address: escrowAddress(),
    abi: ERC8183_ABI,
    functionName: "createJob",
    args: [providerAddress, evaluator, expiredAt, packSla(sla), hook],
  });
  const createReceipt = await publicClient.waitForTransactionReceipt({
    hash: createHash,
  });
  const jobLog = createReceipt.logs.find(
    (log) =>
      log.address.toLowerCase() === escrowAddress().toLowerCase() &&
      log.topics[0] === JOB_CREATED_TOPIC,
  );
  if (!jobLog?.topics[1]) {
    throw new Error("createJob succeeded but JobCreated log is missing from the receipt");
  }
  const jobId = BigInt(jobLog.topics[1]);

  // 2. PROVIDER quotes the budget — provider-only in the reference impl
  //    (sendAndConfirm serializes the legs: fund can NEVER land before budget
  //    on a different sender — the live failure mode was a raced revert).
  //    When the provider is a bare ADDRESS (marketplace mode, the seller's own
  //    loop runs elsewhere) the caller cannot sign for it — setBudget is
  //    skipped and the job funds with budget 0; the seller quotes + submits.
  if (providerSigner !== null) {
    await sendAndConfirm(publicClient, providerSigner, {
      address: escrowAddress(),
      abi: ERC8183_ABI,
      functionName: "setBudget",
      args: [jobId, amount6dec, "0x"],
    });
  }
  // 3. BUYER approves USDC — 6 decimals, never 18 (verified Task 0)
  await sendAndConfirm(publicClient, buyer, {
    address: usdcAddress(),
    abi: USDC_ABI,
    functionName: "approve",
    args: [escrowAddress(), amount6dec],
  });
  // 4. BUYER funds — job moves to Funded (status 1)
  await sendAndConfirm(publicClient, buyer, {
    address: escrowAddress(),
    abi: ERC8183_ABI,
    functionName: "fund",
    args: [jobId, "0x"],
  });

  return jobId;
}

/** Provider submits the deliverable hash → Submitted (status 2). */
/**
 * SlaHook (contracts/src/SlaHook.sol) — the onchain SLA adjudication hook.
 * `attest` posts the freshness proof the hook checks at complete(): the
 * completion is blocked unless the attestation covers the submitted
 * deliverable AND metaBlock >= minBlock.
 */
export const SLA_HOOK_ABI = [
  {
    name: "attest",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "jobId", type: "uint256" },
      { name: "deliverable", type: "bytes32" },
      { name: "metaBlock", type: "uint256" },
      { name: "minBlock", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

/** Post the freshness attestation the SlaHook binds completion to. */
export async function attestDelivery(
  publicClient: PublicClient,
  wallet: WalletClient,
  hook: Address,
  jobId: bigint,
  deliverable: `0x${string}`,
  metaBlock: number | bigint,
  minBlock: number | bigint,
): Promise<void> {
  await sendAndConfirm(publicClient, wallet, {
    address: hook,
    abi: SLA_HOOK_ABI as Abi,
    functionName: "attest",
    args: [jobId, deliverable, BigInt(metaBlock), BigInt(minBlock)],
  });
}

export async function submitDeliverable(
  publicClient: PublicClient,
  walletClient: WalletClient,
  jobId: bigint,
  deliverableHash: `0x${string}`,
): Promise<TransactionReceipt> {
  return sendAndConfirm(publicClient, walletClient, {
    address: escrowAddress(),
    abi: ERC8183_ABI,
    functionName: "submit",
    args: [jobId, deliverableHash, "0x"],
  });
}

/** Evaluator settles the job → USDC released to the provider; status 3. */
export async function complete(
  publicClient: PublicClient,
  walletClient: WalletClient,
  jobId: bigint,
  reasonHash: `0x${string}`,
): Promise<TransactionReceipt> {
  return sendAndConfirm(publicClient, walletClient, {
    address: escrowAddress(),
    abi: ERC8183_ABI,
    functionName: "complete",
    args: [jobId, reasonHash, "0x"],
  });
}

/** Evaluator rejects the deliverable → client auto-refunded (Refunded event); status 4. */
export async function rejectAndRefund(
  publicClient: PublicClient,
  walletClient: WalletClient,
  jobId: bigint,
  reasonHash: `0x${string}`,
): Promise<TransactionReceipt> {
  return sendAndConfirm(publicClient, walletClient, {
    address: escrowAddress(),
    abi: ERC8183_ABI,
    functionName: "reject",
    args: [jobId, reasonHash, "0x"],
  });
}

/** Client reclaims funds after expiredAt passes (JobExpired + Refunded); status 5. */
export async function claimTimeout(
  publicClient: PublicClient,
  walletClient: WalletClient,
  jobId: bigint,
): Promise<TransactionReceipt> {
  return sendAndConfirm(publicClient, walletClient, {
    address: escrowAddress(),
    abi: ERC8183_ABI,
    functionName: "claimRefund",
    args: [jobId],
  });
}

/** topic0 of JobCreated(uint256,address,address,address,uint256,address) — computed once. */
const JOB_CREATED_TOPIC: Hash = keccak256(
  toBytes("JobCreated(uint256,address,address,address,uint256,address)"),
);

interface WriteParams {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
}

/**
 * viem's writeContract is a generic overload set instantiated against
 * ABI-literal types; we pass the verified JSON ABI as runtime data, so the
 * boundary is a narrowed callable with the request shape we control.
 */
type WriteContractFn = (request: {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  account: Account;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}) => Promise<Hash>;

/**
 * Signed write through the caller's wallet client. The account must be the
 * ACCOUNT OBJECT (never a bare address): an address-only account is read by
 * viem as a JSON-RPC account and routed through eth_sendTransaction, which
 * Arc's RPC does not serve — the live failure was MethodNotFoundRpcError.
 * Fees are read live via arcFees (the doc's 20 Gwei floor floats).
 */
async function write(
  publicClient: PublicClient,
  walletClient: WalletClient,
  params: WriteParams,
): Promise<Hash> {
  const send = walletClient.writeContract as unknown as WriteContractFn;
  const fees = await arcFees(publicClient);
  return send({
    address: params.address,
    abi: params.abi,
    functionName: params.functionName,
    args: params.args,
    account: requireAccount(walletClient),
    ...fees,
  });
}

/**
 * Every write confirms its own receipt: viem sends return a hash as soon as
 * the node accepts the tx, but on a sub-second-finality chain the NEXT read
 * can still race the tx's inclusion — and a reverted write is invisible
 * without a status check. Live failure mode observed: fund() raced read-back,
 * job read as Open with budget unset. sendAndConfirm is the ONLY way helpers
 * write: it waits for the receipt and throws on revert.
 */
async function sendAndConfirm(
  publicClient: PublicClient,
  walletClient: WalletClient,
  params: WriteParams,
): Promise<TransactionReceipt> {
  const hash = await write(publicClient, walletClient, params);
  let receipt: TransactionReceipt;
  try {
    receipt = await publicClient.waitForTransactionReceipt({ hash });
  } catch (error) {
    throw new Error(
      `${params.functionName} failed onchain (tx ${hash}): ${(error as Error).message.slice(0, 300)}`,
    );
  }
  if (receipt.status !== "success") {
    throw new Error(`${params.functionName} reverted onchain (tx ${receipt.transactionHash})`);
  }
  return receipt;
}

function requireAccount(walletClient: WalletClient): Account {
  const account = walletClient.account;
  if (!account) {
    throw new Error(
      "escrow helpers need a wallet client with an attached account (createWalletClient({ account }))",
    );
  }
  return account;
}
