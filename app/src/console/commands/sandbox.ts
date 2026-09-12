/**
 * Sandbox commands (T9) — rejection as evidence. PolicyWallet.sol does NOT
 * revert on cap/allowlist violations: it emits `PolicyBlocked` and returns
 * (real rows in the subgraph — PER_TX_CAP, DAILY_CAP, NOT_ALLOWLISTED), so:
 *
 *   policy refusals        the REAL PolicyBlocked rows from the subgraph
 *   policy try-overspend   a labeled SIMULATED reach: the pure
 *                          checkWithdrawal mirror over LIVE contract caps
 *                          plus a keyless simulateContract as the wallet's
 *                          agent — no tx is ever sent
 *   sandbox stale          a staged built-to-fail job: the deliverable is
 *                          captured FIRST and the SLA floor is written one
 *                          block above its _meta.block (delivered + 1) —
 *                          precisely because a head-anchored floor was
 *                          live-observed to be overtaken on a caught-up
 *                          indexer. The hook's REAL SlaNotMet check is the
 *                          contract path the simulated complete() reverts
 *                          through; the staging is disclosed in the rows
 *                          and help. Then arm the refund claim.
 *   sandbox claim          executes claimRefund for real once the deadline
 *                          passes (no attester needed — the buyer reclaims)
 *
 * classifyRevert lives in act.ts (every act failure path needs it) and is
 * re-exported here — the T9 surfaces consume it, they do not re-implement it.
 */
import { keccak256, toBytes, type TransactionReceipt } from "viem";
import { CONFIG, defaultQueryFor } from "../../config";
import { env, hasGraphKey } from "../../env";
import { ensureArcChain } from "../../arc";
import { ADDR } from "../../data/addresses";
import { checkWithdrawal, readPolicy, simulateOverspend } from "../../data/policy";
import { fetchPolicyRefusals } from "../../data/subgraph";
import { truncateHash, usdc6 } from "../../format";
import { createEnsTextReader } from "../../../../mcp/src/ens";
import { gatewayQuery, stripMeta } from "../../../../mcp/src/gateway";
import {
  attestDelivery,
  claimTimeout,
  createJobWithSla,
  ERC8183_ABI,
  getJob,
  submitDeliverable,
  type Sla,
} from "../../../../agent/escrow";
import { reasonHash } from "../../../../mcp/src/escrow";
import { register, type Command, type KvRow } from "../registry";
import {
  classifyRevert,
  formatSendError,
  getActJob,
  isRecoveredActJob,
  resolveDatasetQuote,
  resolveSigner,
  setActJob,
  walkRevertData,
  type ActJob,
  type DatasetQuote,
} from "./act";

export { classifyRevert } from "./act";

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Value of a --flag that appears after the command name; undefined when absent. */
function flagValue(argv: string[], flag: string): string | undefined {
  const at = argv.indexOf(flag, 1);
  return at >= 0 ? argv[at + 1] : undefined;
}

// One reader for the console: live ENSv2 reads on Sepolia (same as inspect/act).
const SEPOLIA_ENS = createEnsTextReader({ rpcUrl: env.sepoliaRpc });

const ALLOWLIST_ABI = [
  {
    name: "allowlisted",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "address", name: "" }],
    outputs: [{ type: "bool", name: "" }],
  },
] as const;

/* ------------------------------------------------------- refund timing */

/**
 * Refund eligibility: the escrow releases funds at/after the job's expiredAt
 * (`block.timestamp < expiredAt` reverts WrongStatus — boundary pinned by
 * sandbox.test.ts: before → false, at → true, after → true).
 */
export function canClaimRefund(deadline: bigint, nowSec: number): boolean {
  return BigInt(nowSec) >= deadline;
}

/* ---------------------------------------------------- policy refusals */

const refusalsCommand: Command = {
  name: "policy refusals",
  help: "real PolicyBlocked rows from the subgraph (PER_TX_CAP / DAILY_CAP / NOT_ALLOWLISTED)",
  kind: "sandbox",
  run: async () => {
    let refusals: Awaited<ReturnType<typeof fetchPolicyRefusals>>;
    try {
      refusals = await fetchPolicyRefusals();
    } catch (error) {
      return { render: "text", data: `policy refusals failed: ${reason(error)} — is the subgraph reachable? (try lag)` };
    }
    if (refusals.length === 0) {
      return {
        render: "text",
        data: "no PolicyBlocked events indexed — the policy wallet has never refused an intent onchain (blank, not zeroed)",
      };
    }
    const rows = refusals.map((r) => {
      const txHash = r.id.length >= 66 ? r.id.slice(0, 66) : r.id;
      return { reason: r.reason, tx: truncateHash(txHash) };
    });
    return {
      render: "table",
      data: {
        columns: ["reason", "tx"],
        rows,
        summary:
          `${refusals.length} policy refusal${refusals.length === 1 ? "" : "s"} onchain · ` +
          "PolicyWallet.sol emits PolicyBlocked instead of reverting — these events are the refusal evidence",
      },
    };
  },
};

/* --------------------------------------------------- try-overspend */

const tryOverspendCommand: Command = {
  name: "policy try-overspend",
  args: "<usdc>",
  help: "SIMULATED overspend: pure checkWithdrawal mirror over LIVE contract caps + keyless probe as the wallet agent — NO TX SENT",
  kind: "sandbox",
  run: async (ctx, argv) => {
    const raw = argv[2]; // argv[0..1] are the multi-word command name
    if (!raw) return { render: "text", data: "usage: policy try-overspend <usdc e.g. 1.50>" };
    const amount = Math.round(parseFloat(raw) * 1_000_000);
    if (!Number.isFinite(amount) || amount <= 0) {
      return { render: "text", data: `invalid amount "${raw}" — a positive USDC number` };
    }
    const rows: KvRow[] = [];
    try {
      const view = await readPolicy(ctx.publicClient);
      const [head, allowlisted] = await Promise.all([
        ctx.publicClient.getBlockNumber(),
        ctx.publicClient.readContract({
          address: ADDR.policy,
          abi: ALLOWLIST_ABI,
          functionName: "allowlisted",
          args: [ADDR.operator],
        }),
      ]);
      rows.push(["caps (live)", `perTx ${usdc6(view.perTxCap)} · daily ${usdc6(view.dailyCap)} · spentToday ${usdc6(view.spentToday)}`]);
      rows.push(["target", `requestWithdrawal(${truncateHash(ADDR.operator)}, ${usdc6(amount)})`]);
      const mirror = checkWithdrawal({
        to: ADDR.operator,
        amount: BigInt(amount),
        perTxCap: view.perTxCap,
        dailyCap: view.dailyCap,
        spentToday: view.spentToday,
        allowlisted: allowlisted as boolean,
        lastDayStart: view.lastDayStart,
        headBlock: head,
      });
      rows.push(["pure mirror", mirror.ok ? "ok — within per-tx cap, daily cap, allowlist" : `✗ ${mirror.reason}`]);
      const probe = await simulateOverspend(ctx.publicClient, BigInt(amount));
      rows.push(
        probe.reverted
          ? ["live probe", `reverted: ${probe.reason}`]
          : ["live probe", `no revert — ${probe.reason}`],
      );
      if (probe.data !== undefined) rows.push(["revert data", `${probe.data.slice(0, 10)}…`]);
      rows.push(["tx", "NONE — simulation only"]);
    } catch (error) {
      rows.push(["✗", reason(error)]);
    }
    return {
      render: "kv",
      data: {
        rows,
        note:
          "SIMULATED — caps/spend are LIVE contract reads (never the subgraph's empty PolicyConfig); PolicyWallet.sol answers cap hits by emitting PolicyBlocked, not by reverting",
      },
    };
  },
};

/* ------------------------------------------------------ sandbox stale */

export interface SandboxState {
  job: ActJob;
  /** the captured complete() revert name (SlaNotMet, or NotAttester before T13) */
  evidence: string | null;
  evidenceData?: `0x${string}`;
}

let sandboxState: SandboxState | null = null;

export function getSandboxState(): SandboxState | null {
  return sandboxState;
}

export function setSandboxState(state: SandboxState | null): void {
  sandboxState = state;
}

/**
 * Escrow floor for a job deadline: the reference impl reverts `expiredAt <=
 * now + 5min` (ExpiryTooShort, Task 0-verified), so a requested deadline is
 * clamped to 360s (6 min: floor + mining slack). The brief's default 120s is
 * below the contract floor — the clamp is disclosed, never silent.
 */
export function clampDeadline(requested: number): number {
  return Math.max(requested, 360);
}

/**
 * The staleness floor for the sandbox job, anchored to the DELIVERED block:
 * floor = metaBlock + 1, so this exact deliverable can never clear it and the
 * hook must refuse completion. Head-anchored floors fail deterministically on
 * a caught-up indexer (live-observed 2026-09-12: a head+1 floor was overtaken
 * by the delivered metaBlock within seconds — arbitrum advances ~4 blocks/s
 * between the buy-time head read and the deliver-time gateway _meta).
 */
export function staleFloor(deliveredBlock: number): number {
  return deliveredBlock + 1;
}

function parseDeadline(argv: string[]): { seconds: number } | { error: string } {
  const raw = flagValue(argv, "--deadline");
  if (raw === undefined) return { seconds: 120 };
  const seconds = Number(raw);
  if (!Number.isInteger(seconds) || seconds < 1) {
    return { error: `--deadline must be a whole number of seconds ≥ 1 — got "${raw}"` };
  }
  return { seconds };
}

const staleCommand: Command = {
  name: "sandbox stale",
  args: "[--deadline <secs>]",
  help:
    "STAGED refusal for the demo: the SLA floor is written one block above the delivered proof so this job can never clear it (the hook's SlaNotMet check itself is real — the floor is ours; the same code path a real stale miss takes). Attest as the hook ATTESTER (role-play, spec §5.3b), capture the SlaNotMet revert from a simulated complete() as evidence, then arm the refund claim",
  kind: "sandbox",
  run: async (ctx, argv) => {
    const parsed = parseDeadline(argv);
    if ("error" in parsed) return { render: "text", data: `sandbox stale: ${parsed.error}` };
    const requested = parsed.seconds;
    if (!hasGraphKey) {
      return {
        render: "kv",
        data: {
          rows: [["gateway", "✗ delivery refused — VITE_GRAPH_GATEWAY_KEY is not set"]],
        },
      };
    }
    const signed = await resolveSigner();
    if (!signed.ok) {
      return {
        render: "kv",
        data: { rows: [["signer", `✗ ${signed.reason}`]] },
      };
    }
    const { signer } = signed;
    const dataset = CONFIG.datasets[0];
    if (!dataset) return { render: "text", data: "sandbox stale: no datasets in config" };

    const rows: KvRow[] = [["dataset", dataset.id]];
    let quote: DatasetQuote;
    try {
      quote = await resolveDatasetQuote(dataset, SEPOLIA_ENS);
      rows.push(["ens price", quote.price]);
      rows.push(["amount", `${usdc6(quote.amountUsdc)} USDC`]);
    } catch (error) {
      return { render: "kv", data: { rows: [...rows, ["ens price", `✗ ${reason(error)}`]] } };
    }

    // Capture the deliverable FIRST: its TRUE _meta.block becomes the floor
    // reference. The chain race is real and live-observed (2026-09-12): the
    // studio indexer sits at the arbitrum head, and the head advances ~4
    // blocks/s between buy and deliver — a head-anchored floor (even head+1)
    // is overtaken by the delivered metaBlock within seconds. Anchoring the
    // floor to the DELIVERED block (+1) makes the refusal deterministic: the
    // SLA is written so this exact deliverable cannot clear it.
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
      return { render: "kv", data: { rows: [...rows, ["delivery", `✗ query failed: ${reason(error)}`]] } };
    }

    const floor = staleFloor(metaBlock);
    const sla: Sla = {
      minBlock: floor,
      schemaHash: keccak256(toBytes(dataset.schema)),
      maxLatencyMs: quote.maxLatencyMs,
    };
    rows.push(["sla floor", `${floor.toLocaleString("en-US")} = delivered metaBlock + 1 — STAGED one block above the delivered proof (${metaBlock.toLocaleString("en-US")}): a deterministic refusal, the same code path a real miss takes; the hook's SlaNotMet check itself is real`]);

    const expirySeconds = clampDeadline(requested);
    if (requested !== expirySeconds) {
      rows.push(["deadline clamp", `${requested}s requested — clamped to ${expirySeconds}s (escrow floor 5 min, ExpiryTooShort)`]);
    }

    let jobId: bigint;
    try {
      if (signer.kind === "injected") await ensureArcChain();
      jobId = await createJobWithSla(ctx.publicClient, {
        buyer: signer.wallet,
        provider: signer.wallet,
        evaluator: signer.address,
        sla,
        amount6dec: BigInt(quote.amountUsdc),
        expirySeconds,
        hook: ADDR.hook,
      });
    } catch (error) {
      return {
        render: "kv",
        data: { rows: [...rows, ["fund", `✗ ${formatSendError(error)}`]] },
      };
    }
    rows.push(["job", jobId.toString()]);
    try {
      await submitDeliverable(ctx.publicClient, signer.wallet, jobId, payloadHash);
      rows.push(["submit", "onchain (job → Submitted)"]);
    } catch (error) {
      return { render: "kv", data: { rows: [...rows, ["submit", `✗ ${formatSendError(error)}`]] } };
    }

    // attest the TRUE below-floor metaBlock — the hook's own check refuses
    // completion. Attest is attester-gated: before T13 provisions the demo
    // key (setAttester via OPENBOOK_ATTESTER_PK) this reverts NotAttester —
    // that revert is rendered as the current evidence instead.
    let attested = false;
    try {
      await attestDelivery(ctx.publicClient, signer.wallet, ADDR.hook, jobId, payloadHash, metaBlock, sla.minBlock);
      attested = true;
      rows.push(["attest", `ok — posted metaBlock ${metaBlock}, minBlock ${sla.minBlock}`]);
    } catch (error) {
      rows.push(["attest", `✗ ${formatSendError(error)}`]);
    }

    let evidence: string | null = null;
    let evidenceData: `0x${string}` | undefined;
    if (attested) {
      // simulate the evaluator's complete() — the hook MUST revert
      // SlaNotMet (the floor is one block past the delivered metaBlock).
      // No tx is sent; the revert data is the evidence.
      try {
        await ctx.publicClient.simulateContract({
          address: ADDR.escrow,
          abi: ERC8183_ABI,
          functionName: "complete",
          args: [jobId, reasonHash("SLA_MET"), "0x"],
          account: signer.address,
        });
        rows.push(["simulate complete", "no revert — unexpected: the hook did not refuse a below-floor attestation"]);
      } catch (error) {
        // viem nests the raw revert hex on a cause-chain node
        // (ContractFunctionRevertedError.raw / RawContractError.data) — the
        // walker extracts it so the SlaNotMet evidence fires once the
        // attester key exists (T13).
        const hex = walkRevertData(error);
        if (hex !== undefined && hex.length >= 10) {
          evidence = classifyRevert(hex);
          evidenceData = hex;
          rows.push([
            "evidenced refusal",
            `complete() would revert ${evidence} (data ${hex.slice(0, 10)}…) — the protocol refuses the stale delivery, NO TX SENT`,
          ]);
        } else {
          rows.push(["simulate complete", `✗ simulate failed: ${reason(error)}`]);
        }
      }
    } else if (!attested) {
      rows.push(["evidenced refusal", "awaiting the attester key — T13 provisions the demo key as the hook attester (OPENBOOK_ATTESTER_PK)"]);
    }

    let deadline = 0n;
    try {
      deadline = (await getJob(ctx.publicClient, jobId)).expiredAt;
    } catch {
      deadline = 0n;
    }
    const job: ActJob = {
      datasetId: dataset.id,
      jobId: String(jobId),
      minBlock: sla.minBlock,
      amountUsdc: quote.amountUsdc,
      deadline,
      payloadHash,
      metaBlock,
      createdAt: Math.floor(Date.now() / 1000),
    };
    setActJob(job);
    setSandboxState({ job, evidence, evidenceData });
    const nowSec = Math.floor(Date.now() / 1000);
    rows.push(["deadline", deadline === 0n ? "unknown (read-back raced)" : `${deadline.toString()} (in ${Number(deadline) - nowSec}s)`]);
    return {
      render: "kv",
      data: {
        rows,
        note:
          "the floor was STAGED one block above the delivered proof — a deterministic refusal exercising the real SlaNotMet check; funds still in escrow — run `sandbox claim` after the deadline to execute claimRefund for real (buyer refund, no attester needed)",
      },
    };
  },
};

/* ------------------------------------------------------ sandbox claim */

const claimCommand: Command = {
  name: "sandbox claim",
  help: "execute claimRefund on the expired sandbox job for real (refund tx); shows the countdown while the deadline has not passed",
  kind: "sandbox",
  run: async (ctx) => {
    // The claim works on the sandbox job OR any recovered act job (a page
    // reload strands the funded job — the sandbox evidence is session-only,
    // but jobId + deadline survive via the act-job persistence).
    const sandbox = getSandboxState();
    const active = getActJob();
    const state = sandbox ?? (active !== null ? { job: active, evidence: null } : null);
    if (!state) {
      return {
        render: "text",
        data: "sandbox claim: no act job to claim — run buy <dataset> (claimable after its deadline) or sandbox stale to stage one",
      };
    }
    const job = state.job;
    const rows: KvRow[] = [
      ["job", job.jobId],
      ["dataset", job.datasetId],
    ];
    if (state.evidence !== null) {
      rows.push(["protocol evidence", `complete() refused with ${state.evidence}${state.evidenceData ? ` (${state.evidenceData.slice(0, 10)}…)` : ""}`]);
    } else if (isRecoveredActJob()) {
      rows.push(["protocol evidence", "none captured (session restarted — the job was recovered; the refund path is unaffected)"]);
    } else {
      rows.push(["protocol evidence", "none captured (attestation or staleness did not land)"]);
    }
    if (job.deadline === 0n) {
      rows.push(["countdown", "✗ deadline unknown — the onchain read-back raced; rerun `sandbox stale`"]);
      return { render: "kv", data: { rows } };
    }
    const nowSec = Math.floor(Date.now() / 1000);
    if (!canClaimRefund(job.deadline, nowSec)) {
      const wait = Number(job.deadline) - nowSec;
      rows.push(["deadline", job.deadline.toString()]);
      rows.push(["countdown", `not eligible yet — the escrow releases the refund at the deadline (in ${wait}s)`]);
      return {
        render: "kv",
        data: { rows, note: "claimRefund opens at the deadline (WrongStatus before it) — anyone can poke it; the funds always return to the buyer" },
      };
    }
    const signed = await resolveSigner();
    if (!signed.ok) {
      return { render: "kv", data: { rows: [...rows, ["signer", `✗ ${signed.reason}`]] } };
    }
    let receipt: TransactionReceipt;
    try {
      if (signed.signer.kind === "injected") await ensureArcChain();
      receipt = await claimTimeout(ctx.publicClient, signed.signer.wallet, BigInt(job.jobId));
    } catch (error) {
      return {
        render: "kv",
        data: { rows: [...rows, ["claim", `✗ ${formatSendError(error)}`]] },
      };
    }
    // Terminal outcome (refunded) — no recovery affordance needed past this point.
    setActJob(null);
    setSandboxState(null);
    return {
      render: "tx",
      data: {
        hash: receipt.transactionHash,
        title: `refunded sandbox job ${job.jobId}`,
        kind: "refunded",
        rows: [...rows, ["claim", `claimRefund executed — job → Expired, buyer refunded`]],
        note: "the refund tx executed for real; the full amount returns to the buyer (claimRefund needs no attester)",
      },
    };
  },
};

register(refusalsCommand);
register(tryOverspendCommand);
register(staleCommand);
register(claimCommand);
