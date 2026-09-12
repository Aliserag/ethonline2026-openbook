/**
 * Act commands (T8) — the keyless real purchase lifecycle over the demo
 * signer (VITE_DEMO_BUYER_KEY via walletForDemo, injected wallet fallback):
 *
 *   buy      quote + fund an ERC-8183 job at exactly the ENS price
 *            (subname-first `${dataset.id}.${CONFIG.ens}` over the parent,
 *            identical to `quote`). sla.minBlock = dataset-chain head − the
 *            live ENS maxBlockLag window; hook = ADDR.hook (our SlaHook).
 *   deliver  gateway query (existing step-3 path) capturing payloadHash +
 *            _meta.block, then SUBMIT the deliverable onchain — the SlaHook
 *            binds completion to the submitted hash, so submission is part of
 *            the real lifecycle (mirrors agent/buyer-cli.ts).
 *   settle   attestDelivery (hook freshness proof) → verifyDelivery(settle:
 *            true) → print the verdict, the settle/refund tx, and the
 *            receipt-derived fee split.
 *
 * Guard convention (spec S9): every failed source renders a per-row `✗
 * reason`, never an invented figure. Failure paths print the EXACT contract
 * revert reason via classifyRevert (naming SlaHook + PolicyWallet selectors;
 * the T9 sandbox re-exports it from here — act's own failure paths need it,
 * so it lives with them).
 */
import { keccak256, toBytes, type Address, type WalletClient } from "viem";
import { CONFIG, defaultQueryFor, type DatasetConfig } from "../../config";
import { env, hasGraphKey } from "../../env";
import { ADDR } from "../../data/addresses";
import { getProvider, arcWalletClient, ensureArcChain } from "../../arc";
import { walletForDemo } from "../../data/chain";
import { feeSplitFromReceipt, freshnessRuler, platformFee } from "../../data/escrow";
import { POLICY_REVERT_SELECTORS } from "../../data/policy";
import { truncateHash, usdc6 } from "../../format";
import {
  createEnsTextReader,
  parsePriceToAmount6dec,
  parseSlaRecord,
  type EnsTextReader,
} from "../../../../mcp/src/ens";
import { gatewayQuery, stripMeta } from "../../../../mcp/src/gateway";
import { defaultChainHeadResolver } from "../../../../mcp/src/chainhead";
import {
  attestDelivery,
  createJobWithSla,
  getJob,
  submitDeliverable,
  type Sla,
} from "../../../../agent/escrow";
import { verifyDelivery, type VerifyDeliveryResult } from "../../../../mcp/src/escrow";
import { register, type Command, type KvRow } from "../registry";
import type { SignerKind } from "../../data/types";

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Value of a --flag that appears after the command name; undefined when absent. */
function flagValue(argv: string[], flag: string): string | undefined {
  const at = argv.indexOf(flag, 1);
  return at >= 0 ? argv[at + 1] : undefined;
}

// One reader for the console: live ENSv2 reads on Sepolia (same as inspect).
const SEPOLIA_ENS = createEnsTextReader({ rpcUrl: env.sepoliaRpc });

const BALANCE_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "address", name: "account" }],
    outputs: [{ type: "uint256", name: "" }],
  },
] as const;

/* ------------------------------------------------------------------ args */

export interface BuyArgs {
  datasetId: string;
  /** 6-dec raw USDC units — exactly what `quote <id>` shows */
  amountUsdc: number;
}

export interface DatasetQuote {
  /** raw svc.price record (e.g. "0.10 USDC/query") */
  price: string;
  amountUsdc: number;
  maxBlockLag: number;
  maxLatencyMs: number;
}

/**
 * Subname-first svc record resolution (`<dataset>.openbook.eth` over the
 * parent storefront): a SET subname record wins; a subname that is unset or
 * failed falls back to the parent. M4 consolidation note: marketplace M4 adds
 * a shared `resolveDatasetRecords` to mcp/src/ens.ts — this local pure helper
 * is the console-side twin built to be replaced by it.
 */
export function resolveDatasetRecord(sub: string | null, parent: string | null): string | null {
  return sub ?? parent;
}

/**
 * Live quote for one dataset — price, amount and the SLA window, all from
 * ENSv2 with the subname-first resolution `quote` uses. A missing svc.price /
 * svc.sla hard-fails (no hard-coded values).
 */
export async function resolveDatasetQuote(
  dataset: DatasetConfig,
  readEnsText: EnsTextReader,
): Promise<DatasetQuote> {
  const sub = `${dataset.id}.${CONFIG.ens}`;
  const [subPrice, subSla, rootPrice, rootSla] = await Promise.all([
    readEnsText(sub, "svc.price"),
    readEnsText(sub, "svc.sla"),
    readEnsText(CONFIG.ens, "svc.price"),
    readEnsText(CONFIG.ens, "svc.sla"),
  ]);
  const price = resolveDatasetRecord(subPrice, rootPrice);
  if (price === null) {
    throw new Error(
      `svc.price is not set on ${sub} (nor ${CONFIG.ens}) — refusing to buy at a hard-coded price`,
    );
  }
  const sla = resolveDatasetRecord(subSla, rootSla);
  if (sla === null) {
    throw new Error(
      `svc.sla is not set on ${sub} (nor ${CONFIG.ens}) — no freshness window to floor the SLA`,
    );
  }
  const amountUsdc = parsePriceToAmount6dec(price);
  const parsedSla = parseSlaRecord(sla);
  return {
    price,
    amountUsdc,
    maxBlockLag: parsedSla.maxBlockLag,
    maxLatencyMs: parsedSla.maxLatencyMs,
  };
}

/**
 * Parse `<dataset> [--amount <usdc>]`. The amount DEFAULTS to the live ENS
 * price (subname-first, exactly what `quote` shows); `--amount` overrides it.
 * Unknown datasets and unreadable prices throw with the reason.
 */
export async function parseBuyArgs(
  argv: string[],
  readEnsText: EnsTextReader,
): Promise<BuyArgs> {
  const id = argv[1];
  if (!id) throw new Error("usage: buy <dataset> [--amount <usdc>] — try datasets");
  const dataset = CONFIG.datasets.find((d) => d.id === id);
  if (!dataset) throw new Error(`unknown dataset: ${id} — try datasets`);
  const quote = await resolveDatasetQuote(dataset, readEnsText);
  const raw = flagValue(argv, "--amount");
  if (raw !== undefined) {
    const parsed = Math.round(parseFloat(raw) * 1_000_000);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`invalid --amount "${raw}" — a positive USDC number (e.g. 0.10)`);
    }
    return { datasetId: dataset.id, amountUsdc: parsed };
  }
  return { datasetId: dataset.id, amountUsdc: quote.amountUsdc };
}

/* ------------------------------------------------------------------ buy */

/**
 * Pure buy guard: signer kind + USDC balance vs the charge. The copy is
 * pinned by act.test.ts — the demo key guidance (VITE_DEMO_BUYER_KEY) and
 * the faucet (faucet.circle.com) are the two actionable recovery paths.
 */
export function canBuy(input: {
  signer: SignerKind;
  balance: bigint;
  amount: bigint;
}): { ok: true } | { ok: false; reason: string } {
  if (input.signer === "none") {
    return { ok: false, reason: "no signer — connect a wallet or set VITE_DEMO_BUYER_KEY" };
  }
  if (input.balance < input.amount) {
    return {
      ok: false,
      reason:
        `low USDC balance (${usdc6(input.balance)} < ${usdc6(input.amount)}) — ` +
        "fund the buyer from faucet.circle.com (Arc testnet) and retry",
    };
  }
  return { ok: true };
}

export interface Signer {
  kind: SignerKind;
  wallet: WalletClient;
  address: Address;
}

/**
 * Keyless signer: the demo key (walletForDemo) wins, then a connected
 * injected wallet (Arc chain added on demand). The instructive error names
 * both recovery paths. Addresses come from the wallet itself, never guessed.
 */
export async function resolveSigner(): Promise<{ ok: true; signer: Signer } | { ok: false; reason: string }> {
  const demo = walletForDemo();
  if (demo?.account) {
    return { ok: true, signer: { kind: "demo", wallet: demo, address: demo.account.address } };
  }
  const provider = typeof window !== "undefined" ? getProvider() : undefined;
  if (provider) {
    try {
      const accounts = (await provider.request({ method: "eth_accounts" })) as string[] | null;
      if (accounts && accounts.length > 0) {
        const address = accounts[0] as Address;
        return { ok: true, signer: { kind: "injected", wallet: arcWalletClient(address), address } };
      }
    } catch {
      // provider present but unreadable — fall through to the connect notice
    }
    return {
      ok: false,
      reason: "browser wallet found but no connected account — connect it (Arc testnet) and retry",
    };
  }
  return { ok: false, reason: "no signer — connect a wallet or set VITE_DEMO_BUYER_KEY" };
}

/** Prepare an injected wallet's Arc chain (demo key writes go straight to the RPC). */
async function ensureChainFor(signer: Signer): Promise<void> {
  if (signer.kind === "injected") await ensureArcChain();
}

/* ------------------------------------------------------ shared job state */

/** In-memory lifecycle state: `buy` → `deliver` → `settle` (and the T9 sandbox). */
export interface ActJob {
  datasetId: string;
  jobId: string;
  minBlock: number;
  amountUsdc: number;
  /** expiredAt in unix seconds (read back onchain — the truth) */
  deadline: bigint;
  payloadHash?: `0x${string}`;
  metaBlock?: number;
}

let actJob: ActJob | null = null;

export function setActJob(job: ActJob | null): void {
  actJob = job;
}

export function getActJob(): ActJob | null {
  return actJob;
}

/* ----------------------------------------------------------- revert copy */

const SLA_REVERT_SELECTORS = {
  // SlaNotMet(uint256 metaBlock, uint256 minBlock) — selector for the FULL
  // signature (Solidity computes it from the parameter types).
  slaNotMet: keccak256(toBytes("SlaNotMet(uint256,uint256)")).slice(0, 10),
  notAttester: keccak256(toBytes("NotAttester()")).slice(0, 10),
  missingAttestation: keccak256(toBytes("MissingAttestation()")).slice(0, 10),
  hashMismatch: keccak256(toBytes("HashMismatch()")).slice(0, 10),
} as const;

const ERROR_STRING_SELECTOR = "0x08c379a0";

function hexToUtf8(hex: string): string {
  let out = "";
  for (let i = 0; i + 1 < hex.length; i += 2) {
    out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  }
  return out;
}

/**
 * Name a contract revert from its raw 0x data: SlaHook errors (SlaNotMet,
 * NotAttester, MissingAttestation, HashMismatch), the PolicyWallet cap errors
 * (PerTxCapExceeded / DailyCapExceeded / NotAllowlisted), and the standard
 * Error(string) — PolicyWallet's onlyAgentOrOwner rejects with require(…,
 * "not agent"), decoded to its modifier name. Unknown data renders its hex
 * prefix, never a fabricated name.
 */
export function classifyRevert(data: `0x${string}`): string {
  const selector = data.slice(0, 10).toLowerCase();
  if (selector === SLA_REVERT_SELECTORS.slaNotMet) return "SlaNotMet";
  if (selector === SLA_REVERT_SELECTORS.notAttester) return "NotAttester";
  if (selector === SLA_REVERT_SELECTORS.missingAttestation) return "MissingAttestation";
  if (selector === SLA_REVERT_SELECTORS.hashMismatch) return "HashMismatch";
  if (selector === POLICY_REVERT_SELECTORS.perTxCapExceeded) return "PerTxCapExceeded";
  if (selector === POLICY_REVERT_SELECTORS.dailyCapExceeded) return "DailyCapExceeded";
  if (selector === POLICY_REVERT_SELECTORS.notAllowlisted) return "NotAllowlisted";
  if (selector === ERROR_STRING_SELECTOR) {
    try {
      const body = data.slice(10);
      const offset = parseInt(body.slice(0, 64) || "0", 16); // abi.encode(string) offset word
      if (offset !== 32) return "Error(string)"; // non-standard encoding — name only
      const len = parseInt(body.slice(64, 128) || "0", 16); // length word
      const text = hexToUtf8(body.slice(128, 128 + len * 2)); // data word
      return text === "not agent" ? "onlyAgentOrOwner" : `Error(string): ${text}`;
    } catch {
      return "Error(string)";
    }
  }
  if (data.length <= 2) return "empty revert data";
  return `unknown selector ${selector}`;
}

/** Failure-path formatter: name the revert when raw data is present, else the message. */
export function formatSendError(error: unknown): string {
  const data = (error as { data?: unknown } | undefined)?.data;
  if (typeof data === "string" && data.startsWith("0x") && data.length >= 10) {
    return `${classifyRevert(data as `0x${string}`)} (revert data ${data.slice(0, 10)}…)`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}

/* ------------------------------------------------------------------ buy */

const buyCommand: Command = {
  name: "buy",
  args: "<dataset> [--amount <usdc>]",
  help: "fund an ERC-8183 job at the live ENS price (demo key or connected wallet)",
  kind: "act",
  run: async (ctx, argv) => {
    const rows: KvRow[] = [];
    let args: BuyArgs;
    try {
      args = await parseBuyArgs(argv, SEPOLIA_ENS);
    } catch (error) {
      return { render: "text", data: `buy: ${reason(error)}` };
    }
    const dataset = CONFIG.datasets.find((d) => d.id === args.datasetId);
    if (!dataset) return { render: "text", data: `buy: unknown dataset ${args.datasetId}` };
    rows.push(["dataset", dataset.id]);

    // The charge is the ENS quote — resolve it for the rows so the receipt
    // line matches what `quote <id>` would print.
    let quote: DatasetQuote;
    try {
      quote = await resolveDatasetQuote(dataset, SEPOLIA_ENS);
      rows.push(["ens price", quote.price]);
      rows.push(["amount", `${usdc6(args.amountUsdc)} USDC (6dp raw ${args.amountUsdc})`]);
    } catch (error) {
      return { render: "kv", data: { rows: [...rows, ["ens price", `✗ ${reason(error)}`]] } };
    }

    const signed = await resolveSigner();
    if (!signed.ok) {
      return {
        render: "kv",
        data: { rows: [...rows, ["signer", `✗ ${signed.reason}`], ["balance", "✗ not read — no signer"]] },
      };
    }
    const { signer } = signed;
    rows.push(["signer", signer.kind === "demo" ? `demo ${truncateHash(signer.address)}` : `injected ${truncateHash(signer.address)}`]);

    let balance: bigint;
    try {
      balance = (await ctx.publicClient.readContract({
        address: ADDR.usdc,
        abi: BALANCE_ABI,
        functionName: "balanceOf",
        args: [signer.address],
      })) as bigint;
      rows.push(["balance", `${usdc6(balance)} USDC`]);
    } catch (error) {
      return { render: "kv", data: { rows: [...rows, ["balance", `✗ balance read failed: ${reason(error)}`]] } };
    }
    const gate = canBuy({ signer: signer.kind, balance, amount: BigInt(args.amountUsdc) });
    if (!gate.ok) {
      return { render: "kv", data: { rows: [...rows, ["gate", `✗ ${gate.reason}`]] } };
    }

    // The SLA floor is a block on the DATASET's chain (data lives on
    // Arbitrum/Ethereum); the public-RPC branch avoids browser-CORS failures
    // from a keyed Alchemy app (same choice as `quote`).
    let head = 0;
    try {
      head = await defaultChainHeadResolver(undefined)(dataset.chain);
      rows.push(["chain head", `${head.toLocaleString("en-US")} (${dataset.chain})`]);
    } catch (error) {
      return {
        render: "kv",
        data: {
          rows: [...rows, ["chain head", `✗ ${reason(error)} — no SLA floor, buy refused`]],
        },
      };
    }
    const sla: Sla = {
      minBlock: head - quote.maxBlockLag,
      schemaHash: keccak256(toBytes(dataset.schema)),
      maxLatencyMs: quote.maxLatencyMs,
    };
    rows.push(["sla floor", `${sla.minBlock.toLocaleString("en-US")} = head − ${quote.maxBlockLag}`]);

    let jobId: bigint;
    try {
      await ensureChainFor(signer);
      jobId = await createJobWithSla(ctx.publicClient, {
        buyer: signer.wallet,
        provider: signer.wallet,
        evaluator: signer.address,
        sla,
        amount6dec: BigInt(args.amountUsdc),
        expirySeconds: 3600,
        hook: ADDR.hook,
      });
    } catch (error) {
      return {
        render: "kv",
        data: {
          rows: [...rows, ["fund", `✗ ${formatSendError(error)}`]],
          note: "the job funds via createJob → setBudget → approve → fund; a revert here names the exact onchain reason",
        },
      };
    }

    let deadline = 0n;
    try {
      deadline = (await getJob(ctx.publicClient, jobId)).expiredAt;
    } catch {
      deadline = 0n; // job created but the read-back raced — deadline unknown
    }
    const job: ActJob = {
      datasetId: dataset.id,
      jobId: String(jobId),
      minBlock: sla.minBlock,
      amountUsdc: args.amountUsdc,
      deadline,
    };
    setActJob(job);
    return {
      render: "kv",
      data: {
        rows: [
          ...rows,
          ["job", job.jobId],
          ["deadline", deadline === 0n ? "unknown (read-back raced)" : job.deadline.toString()],
        ],
        note: `funded — next: deliver ${dataset.id} (captures the payload + _meta), then settle ${dataset.id} (attest + complete)`,
      },
    };
  },
};

/* -------------------------------------------------------------- deliver */

const deliverCommand: Command = {
  name: "deliver",
  args: "[dataset]",
  help: "capture the gateway payload hash + _meta.block and SUBMIT it onchain (SlaHook binds completion to it)",
  kind: "act",
  run: async (ctx, argv) => {
    const id = argv[1];
    const job = getActJob();
    if (!job) return { render: "text", data: "deliver: no active job — run buy <dataset> first" };
    const dataset = CONFIG.datasets.find((d) => d.id === (id ?? job.datasetId));
    if (!dataset) return { render: "text", data: `deliver: unknown dataset ${id ?? job.datasetId}` };
    if (!hasGraphKey) {
      return {
        render: "kv",
        data: {
          rows: [["dataset", dataset.id], ["gateway", "✗ delivery refused — VITE_GRAPH_GATEWAY_KEY is not set"]],
        },
      };
    }

    const rows: KvRow[] = [["dataset", dataset.id], ["job", job.jobId]];
    let payloadHash: `0x${string}`;
    let metaBlock: number;
    try {
      const { data, meta } = await gatewayQuery({
        key: env.graphKey,
        subgraphId: dataset.subgraphId,
        query: defaultQueryFor(dataset),
      });
      if (meta.block === null || meta.block === undefined) {
        return {
          render: "kv",
          data: {
            rows: [...rows, ["delivery", "✗ no _meta in the gateway payload — nothing to attest"]],
          },
        };
      }
      payloadHash = keccak256(toBytes(JSON.stringify(stripMeta(data))));
      metaBlock = meta.block;
      rows.push(["payloadHash", truncateHash(payloadHash, 12, 10)]);
      rows.push(["metaBlock", metaBlock.toLocaleString("en-US")]);
    } catch (error) {
      return {
        render: "kv",
        data: { rows: [...rows, ["delivery", `✗ query failed: ${reason(error)}`]] },
      };
    }

    // Freshness ruler against the SLA floor (dataset-chain head).
    try {
      const head = await defaultChainHeadResolver(undefined)(dataset.chain);
      const fresh = freshnessRuler(metaBlock, BigInt(job.minBlock), BigInt(head));
      rows.push(["freshness", fresh.ok ? `fresh (metaBlock ≥ floor)` : `stale (metaBlock < floor, delta ${fresh.delta} blocks)`]);
    } catch {
      rows.push(["freshness", "✗ chain head unreachable — freshness unknown"]);
    }

    const signed = await resolveSigner();
    if (!signed.ok) {
      setActJob({ ...job, payloadHash, metaBlock });
      return {
        render: "kv",
        data: {
          rows: [...rows, ["submit", `✗ ${signed.reason} — hash captured but not submitted onchain`]],
          note: "settle needs the submitted hash onchain (SlaHook HashMismatch otherwise); set VITE_DEMO_BUYER_KEY or connect, then rerun deliver",
        },
      };
    }
    try {
      await ensureChainFor(signed.signer);
      const receipt = await submitDeliverable(
        ctx.publicClient,
        signed.signer.wallet,
        BigInt(job.jobId),
        payloadHash,
      );
      rows.push(["submit", `tx ${receipt.transactionHash.slice(0, 10)}…${receipt.transactionHash.slice(-8)} (job → Submitted)`]);
    } catch (error) {
      return {
        render: "kv",
        data: { rows: [...rows, ["submit", `✗ ${formatSendError(error)}`]] },
      };
    }
    setActJob({ ...job, payloadHash, metaBlock });
    return {
      render: "kv",
      data: { rows, note: `payload captured and submitted — next: settle ${dataset.id}` },
    };
  },
};

/* --------------------------------------------------------------- settle */

const settleCommand: Command = {
  name: "settle",
  help: "attest the delivery (hook), verify + settle onchain, print the verdict and the receipt-derived fee split",
  kind: "act",
  run: async (ctx) => {
    const job = getActJob();
    if (!job) return { render: "text", data: "settle: no active job — run buy <dataset>, then deliver" };
    if (job.payloadHash === undefined || job.metaBlock === undefined) {
      return { render: "text", data: "settle: no delivery captured — run deliver <dataset> first" };
    }
    const dataset = CONFIG.datasets.find((d) => d.id === job.datasetId);
    if (!dataset) return { render: "text", data: `settle: unknown dataset ${job.datasetId}` };
    const signed = await resolveSigner();
    if (!signed.ok) {
      return {
        render: "kv",
        data: {
          rows: [["signer", `✗ ${signed.reason}`]],
          note: "attest and complete both need a signer; the demo key is the planned hook attester (living-protocol T13)",
        },
      };
    }
    const { signer } = signed;

    // 1. Hook freshness proof. Until T13 sets the demo key as the hook's
    // attester, this reverts NotAttester — rendered as the exact revert
    // reason, never glossed over.
    try {
      await ensureChainFor(signer);
      await attestDelivery(
        ctx.publicClient,
        signer.wallet,
        ADDR.hook,
        BigInt(job.jobId),
        job.payloadHash,
        job.metaBlock,
        job.minBlock,
      );
    } catch (error) {
      return {
        render: "kv",
        data: {
          rows: [
            ["job", job.jobId],
            ["attest", `✗ ${formatSendError(error)}`],
          ],
          note:
            "the SlaHook attester gates attest — T13 provisions the demo key (OPENBOOK_ATTESTER_PK) and calls setAttester; until then this revert is the expected state",
        },
      };
    }

    let result: VerifyDeliveryResult;
    try {
      await ensureChainFor(signer);
      result = await verifyDelivery(
        {
          jobId: job.jobId,
          payloadHash: job.payloadHash,
          metaBlock: job.metaBlock,
          minBlock: job.minBlock,
          settle: true,
        },
        { publicClient: ctx.publicClient, walletClient: signer.wallet },
      );
    } catch (error) {
      return {
        render: "kv",
        data: {
          rows: [
            ["job", job.jobId],
            ["attest", "ok"],
            ["settle", `✗ ${formatSendError(error)}`],
          ],
        },
      };
    }

    const rows: KvRow[] = [
      ["job", job.jobId],
      ["verdict", result.verdict],
    ];
    if (result.reason !== undefined) rows.push(["reason", result.reason]);
    rows.push(["minBlock", result.minBlock.toLocaleString("en-US")]);

    if (result.txHash !== undefined) {
      rows.push(["tx", `${result.txHash.slice(0, 10)}…${result.txHash.slice(-8)}`]);
      if (result.verdict === "APPROVE") {
        try {
          const receipt = await ctx.publicClient.getTransactionReceipt({ hash: result.txHash as `0x${string}` });
          const terms = await platformFee(ctx.publicClient);
          // Single-key operation: the signer is buyer, provider and evaluator
          // (legal per the verified spec) — the seller side of the split is
          // the same address that funded the job.
          const split = feeSplitFromReceipt(receipt, terms.feeBP, signer.address);
          rows.push(["split", `seller ${usdc6(split.seller)} · treasury ${usdc6(split.treasury)} · total ${usdc6(split.total)} (fee ${split.feeBP} bp)`]);
        } catch (error) {
          rows.push(["split", `✗ ${reason(error)}`]);
        }
      } else {
        rows.push(["refund", "client refunded — full amount, no fee row"]);
      }
    } else {
      rows.push(["tx", "none — decision was returned without settlement (no signer given)"]);
    }
    return {
      render: "kv",
      data: {
        rows,
        note: `verdict is ${result.verdict}: ${result.verdict === "APPROVE" ? "SLA met — the hook allowed complete()" : "stale or invalid — refunded instead"}; split is receipt-derived, never config`,
      },
    };
  },
};

register(buyCommand);
register(deliverCommand);
register(settleCommand);
