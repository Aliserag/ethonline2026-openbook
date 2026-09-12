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
import { BaseError, keccak256, toBytes, type Address, type WalletClient } from "viem";
import { CONFIG, defaultQueryFor, type DatasetConfig } from "../../config";
import { env } from "../../env";
import { appGatewayQuery, attestViaApi, hasGatewayAccess } from "../../data/api";
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
import { stripMeta } from "../../../../mcp/src/gateway";
import { defaultChainHeadResolver } from "../../../../mcp/src/chainhead";
import {
  createJobWithSla,
  getJob,
  submitDeliverable,
  type Sla,
} from "../../../../agent/escrow";
import { verifyDelivery, type VerifyDeliveryResult } from "../../../../mcp/src/escrow";
import { register, type Command, type CommandResult, type KvRow } from "../registry";
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

/**
 * Trimmed 6dp display: raw 6-dec USDC units → no forced 2dp ("0.003", "0.15",
 * "1"). Mirrors agent/sell-cli.ts's `usdc6decToDisplay` for money surfaces
 * where usdc6's 2dp would read as a zero fee (treasury 3000 raw = 0.003, not
 * 0.00). sell-cli is not imported — its module drags node:fs/path/child_process
 * into the browser bundle; this 2-line twin is deliberate and pinned by test.
 */
export function usdcTrim(value: bigint | number | string): string {
  return (Number(value) / 1_000_000).toString();
}

/* ------------------------------------------------------------------ args */

export interface BuyArgs {
  datasetId: string;
  /** 6-dec raw USDC units · exactly what `quote <id>` shows */
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

/** ENS read that reports resolution failures instead of throwing (probe style). */
type EnsProbe = { ok: true; value: string | null } | { ok: false; reason: string };

async function probeEns(
  readEnsText: EnsTextReader,
  name: string,
  key: string,
): Promise<EnsProbe> {
  try {
    return { ok: true, value: await readEnsText(name, key) };
  } catch (error) {
    return { ok: false, reason: reason(error) };
  }
}

/**
 * Subname-over-parent merge with the failure edge `quote` uses (inspect.ts's
 * firstNonNull semantics): a SET subname wins; a resolved-but-unset subname
 * falls back to the parent; a FAILED subname read falls back to the parent
 * too — the charge must equal the quote even when a record read fails; only
 * when BOTH fail is the resolution refused.
 */
function firstNonNull(
  primary: EnsProbe,
  fallback: EnsProbe,
): { value: string | null; failed?: string } {
  if (primary.ok && primary.value !== null) return { value: primary.value };
  if (fallback.ok && fallback.value !== null) return { value: fallback.value };
  if (primary.ok || fallback.ok) return { value: null };
  return { value: null, failed: primary.reason };
}

/**
 * Live quote for one dataset — price, amount and the SLA window, all from
 * ENSv2 with the subname-first resolution `quote` uses, INCLUDING the failure
 * edge: an unset record falls back to the parent and a failed read falls back
 * to the parent too (quote == charge); only when subname AND parent both fail
 * (or both are unset) is the buy refused — never a hard-coded value.
 */
export async function resolveDatasetQuote(
  dataset: DatasetConfig,
  readEnsText: EnsTextReader,
): Promise<DatasetQuote> {
  const sub = `${dataset.id}.${CONFIG.ens}`;
  const [subPrice, subSla, rootPrice, rootSla] = await Promise.all([
    probeEns(readEnsText, sub, "svc.price"),
    probeEns(readEnsText, sub, "svc.sla"),
    probeEns(readEnsText, CONFIG.ens, "svc.price"),
    probeEns(readEnsText, CONFIG.ens, "svc.sla"),
  ]);
  const price = firstNonNull(subPrice, rootPrice);
  if (price.failed) {
    throw new Error(`svc.price is unreachable (${price.failed}) · refusing to buy at a hard-coded price`);
  }
  if (price.value === null) {
    throw new Error(
      `svc.price is not set on ${sub} (nor ${CONFIG.ens}) · refusing to buy at a hard-coded price`,
    );
  }
  const sla = firstNonNull(subSla, rootSla);
  if (sla.failed) {
    throw new Error(`svc.sla is unreachable (${sla.failed}) · no freshness window to floor the SLA`);
  }
  if (sla.value === null) {
    throw new Error(
      `svc.sla is not set on ${sub} (nor ${CONFIG.ens}) · no freshness window to floor the SLA`,
    );
  }
  const amountUsdc = parsePriceToAmount6dec(price.value);
  const parsedSla = parseSlaRecord(sla.value);
  return {
    price: price.value,
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
  if (!id) throw new Error("usage: buy <dataset> [--amount <usdc>] · try datasets");
  const dataset = CONFIG.datasets.find((d) => d.id === id);
  if (!dataset) throw new Error(`unknown dataset: ${id} · try datasets`);
  const quote = await resolveDatasetQuote(dataset, readEnsText);
  const raw = flagValue(argv, "--amount");
  if (raw !== undefined) {
    const parsed = Math.round(parseFloat(raw) * 1_000_000);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`invalid --amount "${raw}" · a positive USDC number (e.g. 0.10)`);
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
    return { ok: false, reason: "no signer · connect a wallet or set VITE_DEMO_BUYER_KEY" };
  }
  if (input.balance < input.amount) {
    return {
      ok: false,
      reason:
        `low USDC balance (${usdc6(input.balance)} < ${usdc6(input.amount)}) · ` +
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
      reason: "browser wallet found but no connected account · connect it (Arc testnet) and retry",
    };
  }
  return { ok: false, reason: "no signer · connect a wallet or set VITE_DEMO_BUYER_KEY" };
}

/** Prepare an injected wallet's Arc chain (demo key writes go straight to the RPC). */
async function ensureChainFor(signer: Signer): Promise<void> {
  if (signer.kind === "injected") await ensureArcChain();
}

/* ------------------------------------------------------ shared job state */

/** A spent job's terminal lifecycle outcome — the record REMAINS, not erased. */
export type ActOutcome = "settled" | "refunded";

/** In-memory lifecycle state: `buy` → `deliver` → `settle` (and the T9 sandbox). */
export interface ActJob {
  datasetId: string;
  jobId: string;
  minBlock: number;
  amountUsdc: number;
  /** expiredAt in unix seconds (read back onchain · the truth) */
  deadline: bigint;
  payloadHash?: `0x${string}`;
  metaBlock?: number;
  /** unix seconds when the job was funded locally (recovery affordance) */
  createdAt: number;
  /** set once the job reached a terminal state (settle/refund executed) */
  outcome?: ActOutcome;
  /** the terminal tx hash (settle complete or refund), when known */
  txHash?: `0x${string}`;
}

let actJob: ActJob | null = null;
let actJobRecovered = false;

export function setActJob(job: ActJob | null): void {
  actJob = job;
  actJobRecovered = false;
  if (job === null) clearStoredActJob();
  else persistActJob(job);
}

export function getActJob(): ActJob | null {
  return actJob;
}

/** True when the current act job was rehydrated from localStorage after a reload. */
export function isRecoveredActJob(): boolean {
  return actJobRecovered;
}

/**
 * Clear the act slot after a terminal claim — ONLY when the claimed job IS
 * the slot's job AND the slot is not already terminal. A refund of one job
 * must never wipe a different, still-unsettled purchase's state or a spent
 * job's terminal recovery record.
 */
export function clearActJobIfClaimed(active: ActJob | null, claimedJobId: string): void {
  if (active?.jobId === claimedJobId && active.outcome === undefined) setActJob(null);
}

/**
 * A spent job's recovery row — the shared copy for `status` and the
 * deliver/settle/sandbox-claim refusals: the terminal record stays ON RECORD
 * ("last job 19 · settled · tx …"), never degraded to a bare "no active job".
 */
export function actJobStatusRow(job: ActJob, recovered: boolean): { key: string; value: string } {
  if (job.outcome !== undefined) {
    const tx = job.txHash !== undefined ? ` · tx ${job.txHash.slice(0, 10)}…${job.txHash.slice(-8)}` : "";
    return {
      key: "last job",
      value: `${job.jobId} · ${job.outcome}${tx} · run buy <dataset> to start a new one`,
    };
  }
  return {
    key: recovered ? "recovered job" : "active job",
    value: `${job.jobId} · run deliver / settle (or sandbox claim after its deadline)`,
  };
}

/** Refusal shared by deliver/settle/sandbox claim once the job is spent. */
export function terminalRefusal(job: ActJob, verb: string): CommandResult {
  return {
    render: "kv",
    data: {
      rows: [
        ["job", job.jobId],
        ["outcome", job.outcome === "settled" ? "settled" : "refunded"],
        ...(job.txHash !== undefined
          ? ([["tx", `${job.txHash.slice(0, 10)}…${job.txHash.slice(-8)}`]] as KvRow[])
          : []),
      ],
      note: `${verb}: nothing left to do · the job already ${
        job.outcome === "settled" ? "settled" : "refunded"
      } · run buy <dataset> to start a new one`,
    },
  };
}

/* -------------------------------------------- act-job persistence (v1) */

const ACT_JOB_STORAGE_KEY = "openbook.actjob.v1";

/** Pure serializer · deadline is bigint, stored as a decimal string. */
export function serializeActJob(job: ActJob): string {
  return JSON.stringify({ version: 1, ...job, deadline: job.deadline.toString() });
}

/**
 * Pure deserializer with shape validation. Returns null on ANY mismatch
 * (corrupt JSON, wrong version, missing/invalid fields) — never throws, so
 * the caller can clear the bad entry instead of crashing the console mount.
 */
export function deserializeActJob(raw: string): ActJob | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  if (p["version"] !== 1) return null;
  if (typeof p["datasetId"] !== "string" || p["datasetId"].length === 0) return null;
  if (typeof p["jobId"] !== "string" || !/^[0-9]+$/.test(p["jobId"])) return null;
  if (typeof p["minBlock"] !== "number" || !Number.isInteger(p["minBlock"])) return null;
  if (typeof p["amountUsdc"] !== "number" || !Number.isInteger(p["amountUsdc"])) return null;
  if (typeof p["createdAt"] !== "number" || !Number.isInteger(p["createdAt"])) return null;
  let deadline: bigint;
  try {
    deadline = BigInt(typeof p["deadline"] === "string" ? p["deadline"] : (p["deadline"] as number));
  } catch {
    return null;
  }
  if (deadline < 0n) return null;
  const job: ActJob = {
    datasetId: p["datasetId"] as string,
    jobId: p["jobId"] as string,
    minBlock: p["minBlock"] as number,
    amountUsdc: p["amountUsdc"] as number,
    createdAt: p["createdAt"] as number,
    deadline,
  };
  if (typeof p["payloadHash"] === "string" && /^0x[0-9a-fA-F]{64}$/.test(p["payloadHash"])) {
    job.payloadHash = p["payloadHash"] as `0x${string}`;
  }
  if (typeof p["metaBlock"] === "number" && Number.isInteger(p["metaBlock"])) {
    job.metaBlock = p["metaBlock"];
  }
  if (p["outcome"] === "settled" || p["outcome"] === "refunded") {
    job.outcome = p["outcome"];
  }
  if (typeof p["txHash"] === "string" && /^0x[0-9a-fA-F]{64}$/.test(p["txHash"])) {
    job.txHash = p["txHash"] as `0x${string}`;
  }
  return job;
}

function storage(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null; // privacy mode / sandboxed iframe · persistence degrades to session-only
  }
}

export function persistActJob(job: ActJob): void {
  const store = storage();
  if (store === null) return;
  try {
    store.setItem(ACT_JOB_STORAGE_KEY, serializeActJob(job));
  } catch {
    // quota/availability — the in-memory job still drives this session
  }
}

export function clearStoredActJob(): void {
  const store = storage();
  if (store === null) return;
  try {
    store.removeItem(ACT_JOB_STORAGE_KEY);
  } catch {
    // ignore — nothing to recover anyway
  }
}

/**
 * Read the persisted act job (injectable store for tests). A corrupt entry is
 * CLEARED and yields null — a reload must never crash the console. Runs at
 * module scope (console mount) so deliver/settle/sandbox claim keep working
 * after a page reload.
 */
export function rehydrateActJob(store?: Storage | null): ActJob | null {
  const target = store !== undefined ? store : storage();
  if (target === null) return null;
  let raw: string | null = null;
  try {
    raw = target.getItem(ACT_JOB_STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  const job = deserializeActJob(raw);
  if (job === null) {
    try {
      target.removeItem(ACT_JOB_STORAGE_KEY);
    } catch {
      // corrupt entry may not be removable — still yield null
    }
    return null;
  }
  return job;
}

// Console mount: rehydrate any stranded act job (a reload between buy and
// deliver/settle must not orphan the funded escrow).
{
  const recovered = rehydrateActJob();
  if (recovered !== null) {
    actJob = recovered;
    actJobRecovered = true;
  }
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
      if (offset !== 32) return "Error(string)"; // non-standard encoding · name only
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

/**
 * Extract contract revert bytes from a viem error by walking the cause chain.
 * viem 2.56.3 wraps reverts in BaseError subclasses and the raw hex lives on a
 * NESTED cause — ContractFunctionExecutionError → ContractFunctionRevertedError
 * (`.raw` is the raw hex; its `.data` is the DECODED object) → RawContractError
 * (`.data` is the hex). Reading `.data` off the top error alone is dead code.
 * Returns undefined when no node in the chain carries 0x revert data.
 */
export function walkRevertData(error: unknown): `0x${string}` | undefined {
  const hexOf = (value: unknown): `0x${string}` | undefined =>
    typeof value === "string" && value.startsWith("0x") ? (value as `0x${string}`) : undefined;
  if (!(error instanceof BaseError)) {
    // Bare non-viem payload (e.g. an RPC error surfaced through a custom
    // transport) that still carries the data field directly.
    return hexOf((error as { data?: unknown } | null | undefined)?.data);
  }
  const found = error.walk((e) => {
    const node = e as { raw?: unknown; data?: unknown };
    return typeof node.raw === "string" || typeof node.data === "string";
  }) as (Error & { raw?: unknown; data?: unknown }) | null;
  if (!found) return undefined;
  return hexOf(found.raw ?? found.data);
}

/** Failure-path formatter: name the revert when raw data is present, else the message. */
export function formatSendError(error: unknown): string {
  const hex = walkRevertData(error);
  if (hex !== undefined) {
    return `${classifyRevert(hex)} (revert data ${hex.slice(0, 10)}…)`;
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
        data: { rows: [...rows, ["signer", `✗ ${signed.reason}`], ["balance", "✗ not read · no signer"]] },
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
          rows: [...rows, ["chain head", `✗ ${reason(error)} · no SLA floor, buy refused`]],
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
      deadline = 0n; // job created but the read-back raced · deadline unknown
    }
    const job: ActJob = {
      datasetId: dataset.id,
      jobId: String(jobId),
      minBlock: sla.minBlock,
      amountUsdc: args.amountUsdc,
      deadline,
      createdAt: Math.floor(Date.now() / 1000),
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
        note: `funded · next: deliver ${dataset.id} (captures the payload + _meta), then settle ${dataset.id} (attest + complete)`,
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
    if (!job) return { render: "text", data: "deliver: no active job · run buy <dataset> first" };
    if (job.outcome !== undefined) return terminalRefusal(job, "deliver");
    const dataset = CONFIG.datasets.find((d) => d.id === (id ?? job.datasetId));
    if (!dataset) return { render: "text", data: `deliver: unknown dataset ${id ?? job.datasetId}` };
    if (!hasGatewayAccess()) {
      return {
        render: "kv",
        data: {
          rows: [["dataset", dataset.id], ["gateway", "✗ delivery refused · no server route (VITE_API_BASE) and no VITE_GRAPH_GATEWAY_KEY"]],
        },
      };
    }

    const rows: KvRow[] = [["dataset", dataset.id], ["job", job.jobId]];
    let payloadHash: `0x${string}`;
    let metaBlock: number;
    try {
      const { data, meta } = await appGatewayQuery({
        subgraphId: dataset.subgraphId,
        query: defaultQueryFor(dataset),
      });
      if (meta.block === null || meta.block === undefined) {
        return {
          render: "kv",
          data: {
            rows: [...rows, ["delivery", "✗ no _meta in the gateway payload · nothing to attest"]],
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
      rows.push(["freshness", "✗ chain head unreachable · freshness unknown"]);
    }

    const signed = await resolveSigner();
    if (!signed.ok) {
      setActJob({ ...job, payloadHash, metaBlock });
      return {
        render: "kv",
        data: {
          rows: [...rows, ["submit", `✗ ${signed.reason} · hash captured but not submitted onchain`]],
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
      data: { rows, note: `payload captured and submitted · next: settle ${dataset.id}` },
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
    if (!job) return { render: "text", data: "settle: no active job · run buy <dataset>, then deliver" };
    if (job.outcome !== undefined) return terminalRefusal(job, "settle");
    if (job.payloadHash === undefined || job.metaBlock === undefined) {
      return { render: "text", data: "settle: no delivery captured · run deliver <dataset> first" };
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
      await attestViaApi({ jobId: job.jobId, deliverable: job.payloadHash, metaBlock: job.metaBlock, minBlock: job.minBlock });
    } catch (error) {
      return {
        render: "kv",
        data: {
          rows: [
            ["job", job.jobId],
            ["attest", `✗ ${formatSendError(error)}`],
          ],
          note:
            "the SlaHook attester gates attest · T13 provisions the demo key (OPENBOOK_ATTESTER_PK) and calls setAttester; until then this revert is the expected state",
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
          // Trimmed 6dp: a 3000-raw treasury fee is 0.003, never "0.00" (usdc6
          // rounds to 2dp and would read as "no fee"); raw units stay visible.
          rows.push(["split", `seller ${usdcTrim(split.seller)} · treasury ${usdcTrim(split.treasury)} · total ${usdcTrim(split.total)} (fee ${split.feeBP} bp · raw ${split.seller}/${split.treasury}/${split.total})`]);
        } catch (error) {
          rows.push(["split", `✗ ${reason(error)}`]);
        }
      } else {
        rows.push(["refund", "client refunded · full amount, no fee row"]);
      }
      // Terminal outcome (settled or refunded) — the job is spent, but the
      // record REMAINS marked terminal (outcome + tx + amount) so the
      // recovery row keeps printing "last job 19 · settled · tx …" and the
      // tour's step chips stay DONE across reloads. A new buy or sandbox
      // stale replaces it.
      setActJob({
        ...job,
        outcome: result.verdict === "APPROVE" ? "settled" : "refunded",
        // verdict txHash is a plain string here; the record's field is typed
        txHash: result.txHash as `0x${string}`,
      });
    } else {
      rows.push(["tx", "none · decision was returned without settlement (no signer given)"]);
    }
    return {
      render: "kv",
      data: {
        rows,
        note: `verdict is ${result.verdict}: ${result.verdict === "APPROVE" ? "SLA met · the hook allowed complete()" : "stale or invalid · refunded instead"}; split is receipt-derived, never config`,
      },
    };
  },
};

register(buyCommand);
register(deliverCommand);
register(settleCommand);
