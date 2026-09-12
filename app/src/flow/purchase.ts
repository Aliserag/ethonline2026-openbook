/**
 * The keyless live purchase as a step-event runner. Fresh mode is the
 * console's buy → deliver → settle. Fail mode delivers first and then funds a
 * job whose freshness floor is one block above the delivered proof, so the
 * hook refuses complete() and the evaluator's reject() refunds the buyer in
 * the same click. All I/O is injected (PurchaseDeps) so the sequence is
 * unit-tested without a chain.
 */
import { keccak256, toBytes, type PublicClient, type WalletClient } from "viem";
import { CONFIG, defaultQueryFor, type DatasetConfig } from "../config";
import { env } from "../env";
import { attestViaApi, deliverViaApi, hasGatewayAccess } from "../data/api";
import { ADDR } from "../data/addresses";
import { getPublicClient } from "../data/chain";
import { feeSplitFromReceipt, platformFee } from "../data/escrow";
import type { FeeSplit } from "../data/types";
import { createJobWithSla, ERC8183_ABI, submitDeliverable } from "../../../agent/escrow";
import { reasonHash, verifyDelivery } from "../../../mcp/src/escrow";
import { defaultChainHeadResolver } from "../../../mcp/src/chainhead";
import { createEnsTextReader } from "../../../mcp/src/ens";
import {
  canBuy,
  classifyRevert,
  formatSendError,
  resolveDatasetQuote,
  resolveSigner,
  walkRevertData,
  type DatasetQuote,
  type Signer,
} from "../console/commands/act";
import { staleFloor } from "../console/commands/sandbox";

export type PurchaseStep = "quote" | "pay" | "deliver" | "verdict" | "settle" | "split";

export interface PurchaseEvent {
  step: PurchaseStep;
  status: "running" | "done" | "failed";
  detail?: string;
  txHash?: string;
  data?: Record<string, string>;
}

export interface PurchaseResult {
  ok: boolean;
  outcome?: "settled" | "refunded";
  jobId?: string;
  amount?: number;
  txHash?: string;
  failedStep?: PurchaseStep;
  reason?: string;
  refundReason?: string;
  metaBlock?: number;
  minBlock?: number;
}

export interface PurchaseDeps {
  quote(dataset: DatasetConfig): Promise<DatasetQuote>;
  signer: Signer | null;
  balance(address: `0x${string}`): Promise<bigint>;
  chainHead(chain: DatasetConfig["chain"]): Promise<number>;
  createJob(
    params: { minBlock: number; schemaHash: `0x${string}`; maxLatencyMs: number; amount: bigint },
    trace: string[],
  ): Promise<bigint>;
  query(dataset: DatasetConfig): Promise<{ payloadHash: `0x${string}`; metaBlock: number; preview?: string; proof: string }>;
  submit(jobId: bigint, payloadHash: `0x${string}`): Promise<`0x${string}`>;
  attest(jobId: bigint, payloadHash: `0x${string}`, metaBlock: number, minBlock: number, proof: string): Promise<`0x${string}`>;
  simulateComplete(jobId: bigint): Promise<{ reverted: boolean; reason?: string }>;
  verify(input: { jobId: string; payloadHash: `0x${string}`; metaBlock: number; minBlock: number }): Promise<{
    verdict: "APPROVE" | "REJECT";
    reason?: string;
    minBlock: number;
    txHash?: string;
  }>;
  split(txHash: `0x${string}`, provider: `0x${string}`): Promise<FeeSplit>;
  hasGatewayKey: boolean;
}

/** Wrap a wallet client so every writeContract hash lands in `trace`. */
export function tracedWallet(wallet: WalletClient, trace: string[]): WalletClient {
  const send = wallet.writeContract.bind(wallet) as (...args: unknown[]) => Promise<`0x${string}`>;
  const writeContract = (async (...args: unknown[]) => {
    const hash = await send(...args);
    trace.push(hash);
    return hash;
  }) as unknown as WalletClient["writeContract"];
  return { ...wallet, writeContract } as WalletClient;
}

const BALANCE_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "address", name: "account" }],
    outputs: [{ type: "uint256", name: "" }],
  },
] as const;

const SEPOLIA_ENS = createEnsTextReader({ rpcUrl: env.sepoliaRpc });

export async function liveDeps(publicClient: PublicClient = getPublicClient()): Promise<PurchaseDeps> {
  const signed = await resolveSigner();
  const signer = signed.ok ? signed.signer : null;
  const wallet = signer ? signer.wallet : null;
  const needWallet = (): WalletClient => {
    if (!wallet) throw new Error("no signer");
    return wallet;
  };
  return {
    quote: (dataset) => resolveDatasetQuote(dataset, SEPOLIA_ENS),
    signer,
    balance: (address) =>
      publicClient.readContract({
        address: ADDR.usdc,
        abi: BALANCE_ABI,
        functionName: "balanceOf",
        args: [address],
      }) as Promise<bigint>,
    chainHead: (chain) => defaultChainHeadResolver(undefined)(chain),
    createJob: async (p, trace) => {
      const w = tracedWallet(needWallet(), trace);
      return createJobWithSla(publicClient, {
        buyer: w,
        provider: w,
        evaluator: (signer as Signer).address,
        sla: { minBlock: p.minBlock, schemaHash: p.schemaHash, maxLatencyMs: p.maxLatencyMs },
        amount6dec: p.amount,
        expirySeconds: 3600,
        hook: ADDR.hook,
      });
    },
    query: async (dataset) => {
      const d = await deliverViaApi({ subgraphId: dataset.subgraphId, query: defaultQueryFor(dataset) });
      return { payloadHash: d.payloadHash, metaBlock: d.metaBlock, preview: previewOf(d.data), proof: d.proof };
    },
    submit: async (jobId, hash) => (await submitDeliverable(publicClient, needWallet(), jobId, hash)).transactionHash,
    // the attester key lives on the server; it verifies the job onchain first
    attest: (jobId, hash, metaBlock, minBlock, proof) =>
      attestViaApi({ jobId: jobId.toString(), deliverable: hash, metaBlock, minBlock, proof }),
    simulateComplete: async (jobId) => {
      if (!signer) return { reverted: false };
      try {
        await publicClient.simulateContract({
          address: ADDR.escrow,
          abi: ERC8183_ABI,
          functionName: "complete",
          args: [jobId, reasonHash("SLA_MET"), "0x"],
          account: signer.address,
        });
        return { reverted: false };
      } catch (error) {
        const hex = walkRevertData(error);
        return { reverted: true, reason: hex !== undefined && hex.length >= 10 ? classifyRevert(hex) : "reverted" };
      }
    },
    verify: async (input) => {
      const r = await verifyDelivery({ ...input, settle: true }, { publicClient, walletClient: needWallet() });
      return { verdict: r.verdict, reason: r.reason, minBlock: r.minBlock, txHash: r.txHash };
    },
    split: async (txHash, provider) => {
      const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
      const terms = await platformFee(publicClient);
      return feeSplitFromReceipt(receipt, terms.feeBP, provider);
    },
    hasGatewayKey: hasGatewayAccess(),
  };
}

/** One line of the delivered rows, so a judge sees what was bought. */
export function previewOf(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) return "";
  const entries = Object.entries(payload as Record<string, unknown>);
  const list = entries.find(([, v]) => Array.isArray(v) && v.length > 0);
  if (!list) return "";
  const [field, rows] = list as [string, Record<string, unknown>[]];
  const labelOf = (r: Record<string, unknown>): string => {
    const domain = r.domain as { name?: unknown } | undefined;
    const candidate = r.name ?? r.homeTeam ?? domain?.name ?? r.id ?? "row";
    return String(candidate).slice(0, 40);
  };
  const numberOf = (r: Record<string, unknown>): string => {
    const hit = Object.entries(r).find(
      ([k, v]) => k !== "id" && (typeof v === "number" || (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v))),
    );
    if (!hit) return "";
    return `${hit[0]} ${Number(hit[1]).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  };
  const items = rows.slice(0, 3).map((r) => {
    const value = numberOf(r);
    return `${labelOf(r)}${value ? ` (${value})` : ""}`;
  });
  return `${rows.length} ${field}: ${items.join(" · ")}`;
}

const FAUCET_HINT =
  "The demo wallet is out of testnet USDC. Top it up free at faucet.circle.com (Arc Testnet) and try again.";

function plainReason(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/insufficient funds|insufficient balance|exceeds balance/i.test(text)) return FAUCET_HINT;
  if (/nonce|replacement|already known|reverted onchain/i.test(text)) {
    return `${formatSendError(error)} · another run from the shared demo wallet was probably in flight at the same time; wait a few seconds and try again`;
  }
  return formatSendError(error);
}

function isFullDeps(deps: Partial<PurchaseDeps> | undefined): deps is PurchaseDeps {
  return deps !== undefined && "quote" in deps && "signer" in deps && "verify" in deps;
}

/** "0.10", "0.15", "0.098": two decimals minimum, more only when the value needs them. */
function usdcText(raw: bigint): string {
  const n = Number(raw) / 1_000_000;
  return Number.isInteger(n * 100) ? n.toFixed(2) : n.toString();
}

export async function runPurchase(
  opts: { datasetId: string; mode: "fresh" | "fail"; onEvent(e: PurchaseEvent): void },
  deps?: Partial<PurchaseDeps>,
): Promise<PurchaseResult> {
  const d: PurchaseDeps = isFullDeps(deps) ? deps : { ...(await liveDeps()), ...deps };
  const emit = (e: PurchaseEvent): void => opts.onEvent(e);
  const fail = (step: PurchaseStep, reason: string): PurchaseResult => {
    emit({ step, status: "failed", detail: reason });
    return { ok: false, failedStep: step, reason };
  };

  emit({ step: "quote", status: "running" });
  const dataset = CONFIG.datasets.find((x) => x.id === opts.datasetId);
  if (!dataset) return fail("quote", `Unknown dataset ${opts.datasetId}.`);
  let quote: DatasetQuote;
  try {
    quote = await d.quote(dataset);
  } catch (error) {
    return fail("quote", `The seller's price could not be read from ENS: ${plainReason(error)}`);
  }
  emit({
    step: "quote",
    status: "done",
    detail: `${quote.price.replace("/query", " per query")} · fresh within ${quote.maxBlockLag} blocks`,
    data: { price: quote.price, maxBlockLag: String(quote.maxBlockLag) },
  });

  const signer = d.signer;
  const schemaHash = keccak256(toBytes(dataset.schema));
  let delivered: { payloadHash: `0x${string}`; metaBlock: number; preview?: string; proof: string } | null = null;

  const deliver = async (): Promise<PurchaseResult | null> => {
    emit({ step: "deliver", status: "running" });
    if (!d.hasGatewayKey) {
      return fail("deliver", "Delivery runs through the deployed server (it holds the Graph key); local runs need VITE_API_BASE or VITE_GRAPH_GATEWAY_KEY.");
    }
    try {
      delivered = await d.query(dataset);
    } catch (error) {
      return fail("deliver", `The data query failed: ${plainReason(error)}`);
    }
    emit({
      step: "deliver",
      status: "done",
      detail: `indexed at block ${delivered.metaBlock.toLocaleString("en-US")}${delivered.preview ? ` · ${delivered.preview}` : ""}`,
      data: { metaBlock: String(delivered.metaBlock), payloadHash: delivered.payloadHash, ...(delivered.preview ? { rows: delivered.preview } : {}) },
    });
    return null;
  };

  // fail mode delivers first so the floor can sit one block above the proof
  if (opts.mode === "fail") {
    const r = await deliver();
    if (r) return r;
  }

  emit({ step: "pay", status: "running" });
  if (!signer) return fail("pay", "No demo wallet is configured on this deployment, and no browser wallet is connected.");
  let balance: bigint;
  try {
    balance = await d.balance(signer.address);
  } catch (error) {
    return fail("pay", `The demo wallet balance could not be read: ${plainReason(error)}`);
  }
  const gate = canBuy({ signer: signer.kind, balance, amount: BigInt(quote.amountUsdc) });
  if (!gate.ok) return fail("pay", FAUCET_HINT);
  let minBlock: number;
  if (opts.mode === "fail") {
    minBlock = staleFloor((delivered as unknown as { metaBlock: number }).metaBlock);
  } else {
    let head: number;
    try {
      head = await d.chainHead(dataset.chain);
    } catch (error) {
      return fail("pay", `The dataset chain head could not be read, so no freshness floor can be set: ${plainReason(error)}`);
    }
    minBlock = head - quote.maxBlockLag;
  }
  const trace: string[] = [];
  let jobId: bigint;
  try {
    jobId = await d.createJob({ minBlock, schemaHash, maxLatencyMs: quote.maxLatencyMs, amount: BigInt(quote.amountUsdc) }, trace);
  } catch (error) {
    return fail("pay", plainReason(error));
  }
  emit({
    step: "pay",
    status: "done",
    detail: opts.mode === "fail"
      ? `${usdcText(BigInt(quote.amountUsdc))} USDC locked in escrow · job ${jobId} · floor pinned at ${minBlock.toLocaleString("en-US")}, one block above the delivery, on purpose`
      : `${usdcText(BigInt(quote.amountUsdc))} USDC locked in escrow · job ${jobId} · floor ${minBlock.toLocaleString("en-US")}`,
    txHash: trace[trace.length - 1],
    data: { jobId: String(jobId), minBlock: String(minBlock), txs: trace.join(",") },
  });

  if (opts.mode === "fresh") {
    const r = await deliver();
    if (r) return r;
  }
  const dl = delivered as unknown as { payloadHash: `0x${string}`; metaBlock: number; preview?: string; proof: string };

  emit({ step: "verdict", status: "running" });
  let submitTx: `0x${string}`;
  try {
    submitTx = await d.submit(jobId, dl.payloadHash);
  } catch (error) {
    return fail("verdict", `The delivery could not be recorded onchain: ${plainReason(error)}`);
  }
  emit({
    step: "deliver",
    status: "done",
    detail: `indexed at block ${dl.metaBlock.toLocaleString("en-US")}${dl.preview ? ` · ${dl.preview}` : ""} · recorded onchain`,
    txHash: submitTx,
    data: { metaBlock: String(dl.metaBlock), payloadHash: dl.payloadHash, submitTx, ...(dl.preview ? { rows: dl.preview } : {}) },
  });
  let attestTx: `0x${string}`;
  try {
    attestTx = await d.attest(jobId, dl.payloadHash, dl.metaBlock, minBlock, dl.proof);
  } catch (error) {
    return fail("verdict", `The freshness proof could not be posted: ${plainReason(error)}`);
  }
  const fresh = dl.metaBlock >= minBlock;
  let verdictDetail = fresh
    ? `block ${dl.metaBlock.toLocaleString("en-US")} clears the floor ${minBlock.toLocaleString("en-US")}`
    : `block ${dl.metaBlock.toLocaleString("en-US")} is below the floor ${minBlock.toLocaleString("en-US")}`;
  if (!fresh) {
    const sim = await d.simulateComplete(jobId);
    if (sim.reverted) verdictDetail += ` · the contract refuses to pay: complete() reverts ${sim.reason ?? ""} (checked by simulation, no transaction)`;
  }
  emit({
    step: "verdict",
    status: "done",
    detail: verdictDetail,
    txHash: attestTx,
    data: { submitTx, attestTx, metaBlock: String(dl.metaBlock), minBlock: String(minBlock) },
  });

  emit({ step: "settle", status: "running" });
  let verdict: Awaited<ReturnType<PurchaseDeps["verify"]>>;
  try {
    verdict = await d.verify({ jobId: String(jobId), payloadHash: dl.payloadHash, metaBlock: dl.metaBlock, minBlock });
  } catch (error) {
    return fail("settle", plainReason(error));
  }
  const outcome: "settled" | "refunded" = verdict.verdict === "APPROVE" ? "settled" : "refunded";
  emit({
    step: "settle",
    status: "done",
    detail: outcome === "settled" ? "the seller is paid" : "the buyer is refunded in full",
    txHash: verdict.txHash,
    data: { verdict: verdict.verdict, reason: verdict.reason ?? "" },
  });
  const result: PurchaseResult = {
    ok: true,
    outcome,
    jobId: String(jobId),
    amount: quote.amountUsdc,
    txHash: verdict.txHash,
    refundReason: verdict.reason,
    metaBlock: dl.metaBlock,
    minBlock,
  };

  if (outcome === "settled" && verdict.txHash) {
    emit({ step: "split", status: "running" });
    try {
      const split = await d.split(verdict.txHash as `0x${string}`, signer.address);
      emit({
        step: "split",
        status: "done",
        detail: `${usdcText(split.seller)} USDC to the seller · ${usdcText(split.treasury)} USDC to the treasury (${split.feeBP / 100}%)`,
        data: { seller: split.seller.toString(), treasury: split.treasury.toString(), feeBP: String(split.feeBP) },
      });
    } catch (error) {
      emit({
        step: "split",
        status: "failed",
        detail: `settled, but the fee split could not be read from the receipt: ${plainReason(error)}`,
      });
    }
  }
  return result;
}
