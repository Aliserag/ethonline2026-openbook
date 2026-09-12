/**
 * Inspect commands (T7) — one-shot live reads of every source the console
 * knows. Convention: a value is ALWAYS read live at dispatch time; a broken
 * source renders `✗ <reason>` in its row, never an invented figure (spec S9).
 * The console's header chips additionally poll arc head / subgraph lag / ENS
 * through useLiveValue so the always-visible panels carry live/stale/error
 * states with reasons (Console.tsx).
 *
 * The policy surface reads caps/spend from the CONTRACT (`readPolicy`) — the
 * subgraph's PolicyConfig entity is empty on our instance and is never used
 * (controller ruling, carry-ins).
 */
import { marketJobs } from "../../data/feed";
import { CONFIG, type DatasetConfig } from "../../config";
import { env } from "../../env";
import { hasGatewayAccess } from "../../data/api";
import { ADDR } from "../../data/addresses";
import { demoAddress } from "../../data/chain";
import { readPolicy } from "../../data/policy";
import { fetchJobEventsResilient, fetchJobsResilient, fetchLagResilient, scopedTotals, type JobEventView, type Resilient } from "../../data/subgraph";
import type { JobView } from "../../data/types";
import { cachedAsOfLabel } from "../../data/cache";
import { truncateHash, usdc6 } from "../../format";
import { createEnsTextReader, parsePriceToAmount6dec, parseSlaRecord } from "../../../../mcp/src/ens";
import { createDirectoryClient } from "../../../../mcp/src/directory";
import { namehash, parseAbi } from "viem";
import { walkRevertData } from "./act";
import { defaultChainHeadResolver } from "../../../../mcp/src/chainhead";
import { commands, find, register, type Command, type KvRow } from "../registry";
import { actJobStatusRow, getActJob, isRecoveredActJob } from "./act";

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Append the honest label when a command served the last-good cache. */
function cachedSuffix(out: { source: "live" | "cache"; at: number }): string {
  return out.source === "cache" ? ` · ${cachedAsOfLabel(out.at)}` : "";
}

/** Value of a --flag that appears after the command name; undefined when absent. */
function flagValue(argv: string[], flag: string): string | undefined {
  const at = argv.indexOf(flag, 1);
  return at >= 0 ? argv[at + 1] : undefined;
}

function parseDays(argv: string[]): { days: number } | { error: string } {
  const raw = flagValue(argv, "--days");
  if (raw === undefined) return { days: 30 };
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1) {
    return { error: `--days must be a whole number ≥ 1 · got "${raw}"` };
  }
  return { days };
}

function dayTime(ts: number): string {
  if (ts === 0) return "n/a";
  return new Date(ts * 1000).toLocaleString(undefined, { month: "short", day: "numeric" });
}

/** ENS read that reports resolution failures instead of throwing. */
type EnsProbe = { ok: true; value: string | null } | { ok: false; reason: string };

async function probeEns(name: string, key: string): Promise<EnsProbe> {
  try {
    return { ok: true, value: await SEPOLIA_ENS(name, key) };
  } catch (error) {
    return { ok: false, reason: reason(error) };
  }
}

/**
 * Resolve a record preferring the dataset subname over the storefront root
 * (mirrors App.quoteWithNamespace): a present subname record wins; a resolved
 * but unset record is "unset"; only when BOTH probes fail does the row report
 * an ENS failure.
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

// One reader for the console: live ENSv2 reads on Sepolia (same as App step 1).
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

const ALLOWLIST_ABI = [
  {
    name: "allowlisted",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "address", name: "" }],
    outputs: [{ type: "bool", name: "" }],
  },
] as const;

const STOREFRONT_KEYS = ["svc.menu", "svc.price", "svc.sla", "svc.payee", "svc.operator", "svc.pnl"] as const;
const HARD_FAIL_KEYS = ["svc.price", "svc.sla", "svc.payee"];

function jobTableRow(job: { jobId: bigint; state: string; amount: bigint; buyer: string; seller: string; timestamp: number; deadline?: bigint }): Record<string, string> {
  return {
    job: job.jobId.toString(),
    state: job.state === "open" && job.deadline !== undefined && job.deadline > 0n && Number(job.deadline) < Date.now() / 1000 ? "expired · refundable (claimRefund)" : job.state,
    amount: usdc6(job.amount),
    buyer: truncateHash(job.buyer),
    seller: truncateHash(job.seller),
    when: dayTime(job.timestamp),
  };
}

const JOB_COLUMNS = ["job", "state", "amount", "buyer", "seller", "when"];

/* ------------------------------------------------------------------ help */

const helpCommand: Command = {
  name: "help",
  args: "[cmd]",
  help: "list commands (help <cmd> for one line)",
  kind: "inspect",
  run: async (_ctx, argv) => {
    const all = commands();
    if (argv.length > 1) {
      // Longest-prefix match: "help sandbox stale" resolves "sandbox stale",
      // not the bare "sandbox" (which is not a command) — same as dispatch.
      const term = argv.slice(1).join(" ");
      const found = find(term);
      if (found) return { render: "text", data: `${found.name}${found.args ? ` ${found.args}` : ""} · ${found.help}` };
      // "help ens" lists every command in that group ("ens show", "ens set …")
      const group = all.filter((c) => c.name.startsWith(`${term} `) || c.name.startsWith(term));
      return {
        render: "text",
        data: group.length > 0 ? group.map((c) => `${c.name}${c.args ? ` ${c.args}` : ""} · ${c.help}`).join("\n") : `unknown command: ${term} · try help`,
      };
    }
    const lines = all.map((c) => `${c.name}${c.args ? ` ${c.args}` : ""} · ${c.help}`);
    return { render: "text", data: lines.join("\n") };
  },
};

function registerAll(...cmds: Command[]): void {
  for (const cmd of cmds) register(cmd);
}

/* ---------------------------------------------------------------- status */

const statusCommand: Command = {
  name: "status",
  help: "one-shot health: arc head, subgraph lag, ENS storefront, gateway key, demo wallet",
  kind: "inspect",
  run: async (ctx) => {
    const rows: KvRow[] = [];
    try {
      const head = await ctx.publicClient.getBlockNumber();
      rows.push(["arc head", `${head.toLocaleString("en-US")} (live)`]);
    } catch (error) {
      rows.push(["arc head", `✗ RPC unreachable: ${reason(error)}`]);
    }
    try {
      const lag = await fetchLagResilient();
      rows.push([
        "subgraph",
        lag.source === "cache"
          ? `indexed block ${lag.value.indexed.toLocaleString("en-US")} · ${lag.value.rows} rows proxied · ${cachedAsOfLabel(lag.at)}`
          : `indexed block ${lag.value.indexed.toLocaleString("en-US")} · ${lag.value.rows} rows proxied`,
      ]);
    } catch (error) {
      rows.push(["subgraph", `✗ subgraph unreachable: ${reason(error)}`]);
    }
    try {
      const price = await probeEns(CONFIG.ens, "svc.price");
      const sla = await probeEns(CONFIG.ens, "svc.sla");
      const payee = await probeEns(CONFIG.ens, "svc.payee");
      const missing = (
        [["svc.price", price], ["svc.sla", sla], ["svc.payee", payee]] as const
      ).filter(([, probe]) => probe.ok && probe.value === null);
      if (missing.length > 0) {
        rows.push(["ens", `✗ hard-fail · not set: ${missing.map(([k]) => k).join(", ")}`]);
      } else if (!price.ok || !sla.ok || !payee.ok) {
        const failed = [price, sla, payee].find((p) => !p.ok);
        rows.push(["ens", `✗ ENS unreachable: ${failed && !failed.ok ? failed.reason : "unknown"}`]);
      } else {
        rows.push([
          "ens",
          `ok · ${price.value} · sla ${sla.value} · payee ${truncateHash(payee.value ?? "")}`,
        ]);
      }
    } catch (error) {
      rows.push(["ens", `✗ ENS unreachable: ${reason(error)}`]);
    }
    rows.push([
      "gateway",
      hasGatewayAccess()
        ? "server route /api/deliver (key held server-side)"
        : "missing · no server route and no local key (delivery refused until then)",
    ]);
    const actJob = getActJob();
    if (actJob !== null) {
      const row = actJobStatusRow(actJob, isRecoveredActJob());
      rows.push([row.key, row.value]);
    }
    const demo = demoAddress();
    if (demo === null) {
      rows.push(["demo wallet", "unset · set VITE_DEMO_BUYER_KEY (act commands then degrade to wallet-connect)"]);
    } else {
      try {
        const balance = await ctx.publicClient.readContract({
          address: ADDR.usdc,
          abi: BALANCE_ABI,
          functionName: "balanceOf",
          args: [demo],
        });
        rows.push(["demo wallet", `${usdc6(balance)} USDC · ${truncateHash(demo)}`]);
      } catch (error) {
        rows.push(["demo wallet", `✗ balance read failed: ${reason(error)} · ${truncateHash(demo)}`]);
      }
    }
    return { render: "kv", data: { rows } };
  },
};

/* -------------------------------------------------------------- ens show */

const ensShowCommand: Command = {
  name: "ens show",
  help: "live storefront records of openbook.eth (svc.* table)",
  kind: "inspect",
  run: async () => {
    const probes = await Promise.all(STOREFRONT_KEYS.map((key) => probeEns(CONFIG.ens, key)));
    const rows = STOREFRONT_KEYS.map((key, i) => {
      const probe = probes[i];
      return {
        record: key,
        value: !probe.ok
          ? `✗ ${probe.reason}`
          : probe.value ?? (HARD_FAIL_KEYS.includes(key) ? "not set (hard fail)" : "not set"),
      };
    });
    return {
      render: "table",
      data: {
        columns: ["record", "value"],
        rows,
        summary:
          "live reads from sepolia ENSv2 · price/sla/payee unset hard-fails the quote (no hard-coded values)",
      },
    };
  },
};

const OPENBOOK_RESOLVER = "0x59d9d95e8dEC7745a3A4243dB45458bfE513b0a3" as const;
const RESOLVER_SET_TEXT_ABI = parseAbi(["function setText(bytes32 node, string key, string value)"]);
const EAC_UNAUTHORIZED = "0x4b27a133";

/**
 * "May this key edit this record on this name?" answered by the resolver itself:
 * an eth_call of setText from that address either passes or reverts
 * EACUnauthorizedAccountRoles. No transaction, no hard-coded role table.
 */
const ensCanEditCommand: Command = {
  name: "ens can-edit",
  args: "<name> <key> <address>",
  help: "ENSv2 access control, live: simulate setText from an address (EAC delegation check, no tx)",
  kind: "inspect",
  run: async (_ctx, argv) => {
    const [, name, key, address] = argv;
    if (!name || !key || !address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      return { render: "text", data: "usage: ens can-edit <name> <key> <0xaddress> · e.g. ens can-edit alpha.openbook.eth svc.price 0xe09C8F90931E97d0aEE998885b306DDF08CE08Cc" };
    }
    const client = createDirectoryClient(env.sepoliaRpc);
    const node = namehash(name);
    let verdict: string;
    let detail: string;
    try {
      await client.simulateContract({
        address: OPENBOOK_RESOLVER,
        abi: RESOLVER_SET_TEXT_ABI,
        functionName: "setText",
        args: [node, key, "probe"],
        account: address as `0x${string}`,
      });
      verdict = "allowed";
      detail = "the resolver accepts setText from this address for this key on this node (a real write would succeed)";
    } catch (error) {
      const hex = walkRevertData(error);
      if (hex !== undefined && hex.startsWith(EAC_UNAUTHORIZED)) {
        verdict = "refused · EACUnauthorizedAccountRoles";
        detail = "no text role for this key on this node (Enhanced Access Control); the parent owner can grant one with authorizeTextRoles";
      } else {
        verdict = `refused · ${hex !== undefined ? hex.slice(0, 10) : reason(error)}`;
        detail = "reverted for a reason other than access control";
      }
    }
    return {
      render: "kv",
      data: {
        rows: [
          ["name", name],
          ["node", node],
          ["key", key],
          ["address", address],
          ["verdict", verdict],
        ],
        note: `${detail} · resolver ${OPENBOOK_RESOLVER} (PermissionedResolver, Sepolia) · try scripts/ens/delegate.sh to grant`,
      },
    };
  },
};

/** Live ENS price cell for a dataset row: subname over root, `✗ …` when unset. */
function priceCell(dataset: DatasetConfig, probe: { value: string | null; failed?: string }): string {
  if (probe.failed) return `✗ ${probe.failed}`;
  if (probe.value === null) {
    return `✗ svc.price unset on ${dataset.id}.${CONFIG.ens} (nor ${CONFIG.ens})`;
  }
  return probe.value;
}

/** Live ENS SLA maxBlockLag cell: parse failures and unset records are `✗ …`. */
function slaCell(probe: { value: string | null; failed?: string }): string {
  if (probe.failed) return `✗ ${probe.failed}`;
  if (probe.value === null) return "✗ svc.sla unset";
  try {
    return String(parseSlaRecord(probe.value).maxBlockLag);
  } catch (error) {
    return `✗ invalid: ${reason(error)}`;
  }
}

/* ------------------------------------------------------------- datasets */

const datasetsCommand: Command = {
  name: "datasets",
  help: "the storefront menu: 5 datasets with live ENS prices + SLA windows",
  kind: "inspect",
  run: async () => {
    // Live data only: every row's price and maxBlockLag resolve from ENSv2 at
    // dispatch time (subname over root, exactly like quote) — the imported
    // config's priceUsdc/freshness fields are deployment defaults, never the
    // displayed figures. The root records are shared by all five datasets, so
    // they are read once; only the 10 unique subname probes fan out (the
    // public Sepolia RPC rate-limits broad parallel bursts).
    const [rootPrice, rootSla] = await Promise.all([
      probeEns(CONFIG.ens, "svc.price"),
      probeEns(CONFIG.ens, "svc.sla"),
    ]);
    const probes = await Promise.all(
      CONFIG.datasets.map(async (dataset) => {
        const sub = `${dataset.id}.${CONFIG.ens}`;
        const [subPrice, subSla] = await Promise.all([
          probeEns(sub, "svc.price"),
          probeEns(sub, "svc.sla"),
        ]);
        return { dataset, price: firstNonNull(subPrice, rootPrice), sla: firstNonNull(subSla, rootSla) };
      }),
    );
    const rows = probes.map(({ dataset, price, sla }) => ({
      id: dataset.id,
      schema: dataset.schema,
      price: priceCell(dataset, price),
      maxBlockLag: slaCell(sla),
      chain: dataset.chain,
    }));
    return {
      render: "table",
      data: {
        columns: ["id", "schema", "price", "maxBlockLag", "chain"],
        rows,
        summary: `${CONFIG.datasets.length} datasets · prices and SLA windows are LIVE ENS reads (subname over ${CONFIG.ens}), same resolution as quote <id>`,
      },
    };
  },
};

/* ---------------------------------------------------------------- quote */

const quoteCommand: Command = {
  name: "quote",
  args: "[dataset]",
  help: "ENS-priced quote + SLA floor (live reads, no tx); defaults to the first dataset",
  kind: "inspect",
  run: async (_ctx, argv) => {
    const id = argv[1] ?? CONFIG.datasets[0]?.id;
    if (!id) return { render: "text", data: "usage: quote <dataset> · try datasets" };
    const dataset = CONFIG.datasets.find((d) => d.id === id);
    if (!dataset) return { render: "text", data: `unknown dataset: ${id} · try datasets` };

    const sub = `${dataset.id}.${CONFIG.ens}`;
    const probes = await Promise.all([
      probeEns(sub, "svc.price"),
      probeEns(sub, "svc.sla"),
      probeEns(CONFIG.ens, "svc.price"),
      probeEns(CONFIG.ens, "svc.sla"),
    ]);
    const priceProbe = firstNonNull(probes[0], probes[2]);
    const slaProbe = firstNonNull(probes[1], probes[3]);

    const rows: KvRow[] = [
      ["dataset", dataset.id],
      ["chain", dataset.chain],
      ["ens name", `${sub} → ${CONFIG.ens}`],
    ];

    if (priceProbe.failed) {
      rows.push(["ens price", `✗ ENS unreachable: ${priceProbe.failed}`]);
    } else if (priceProbe.value === null) {
      rows.push([
        "ens price",
        `✗ svc.price not set on ${sub} (nor ${CONFIG.ens}) · refusing to quote a hard-coded value`,
      ]);
    } else {
      let amount: number | null = null;
      try {
        amount = parsePriceToAmount6dec(priceProbe.value);
        rows.push(["ens price", priceProbe.value]);
        rows.push(["amount", `${usdc6(amount)} USDC (6dp raw ${amount})`]);
      } catch (error) {
        rows.push(["ens price", `${priceProbe.value} · ✗ invalid: ${reason(error)}`]);
      }
    }

    let maxBlockLag: number | null = null;
    if (slaProbe.failed) {
      rows.push(["sla", `✗ ENS unreachable: ${slaProbe.failed}`]);
    } else if (slaProbe.value === null) {
      rows.push(["sla", `✗ svc.sla not set on ${sub} (nor ${CONFIG.ens}) · no freshness floor`]);
    } else {
      try {
        maxBlockLag = parseSlaRecord(slaProbe.value).maxBlockLag;
        rows.push(["sla maxBlockLag", String(maxBlockLag)]);
      } catch (error) {
        rows.push(["sla", `✗ invalid: ${reason(error)}`]);
      }
    }

    try {
      // Browser surface: the public-RPC branch of the resolver. The Alchemy-
      // keyed branch is for server contexts — an Alchemy app that does not
      // CORS-allow the browser origin would log net::ERR_FAILED on every
      // attempt (the resolver's own fallback), violating zero console errors.
      // Both branches return a live eth_blockNumber; truthfulness is equal.
      const head = await defaultChainHeadResolver(undefined)(dataset.chain);
      rows.push(["chain head", `${head.toLocaleString("en-US")} (${dataset.chain})`]);
      rows.push([
        "sla floor",
        maxBlockLag !== null
          ? `head − maxBlockLag = ${(head - maxBlockLag).toLocaleString("en-US")}`
          : "unknown · no SLA window to subtract",
      ]);
    } catch (error) {
      rows.push(["chain head", `✗ ${reason(error)} · floor unknown, quote refused`]);
    }

    return {
      render: "kv",
      data: {
        rows,
        note: "price/SLA resolve live from sepolia ENSv2; the floor is the dataset-chain head minus the SLA window (freshness gate)",
      },
    };
  },
};

/* ---------------------------------------------------------------- books */

const booksCommand: Command = {
  name: "books",
  args: "[--days n]",
  help: "scoped P&L: totals + rows over OUR_ADDRESSES (subgraph)",
  kind: "inspect",
  run: async (_ctx, argv) => {
    const days = parseDays(argv);
    if ("error" in days) return { render: "text", data: days.error };
    let out: Resilient<JobView[]>;
    try {
      out = await fetchJobsResilient();
    } catch (error) {
      return { render: "text", data: `books failed: ${reason(error)} · is the subgraph reachable? (try lag)` };
    }
    // the same scope as the page's books: jobs on the market escrow, funded ones only
    const jobs = marketJobs(out.value);
    const totals = scopedTotals(jobs);
    const cutoff = Math.floor(Date.now() / 1000) - days.days * 86_400;
    const rows = jobs
      .filter((j) => j.timestamp === 0 || j.timestamp >= cutoff)
      .map((j) => jobTableRow(j));
    if (rows.length === 0) {
      return {
        render: "text",
        data:
          "no scoped jobs in the subgraph yet · the ledger is blank, not zero: nothing indexed for our addresses (try lag)",
      };
    }
    return {
      render: "table",
      data: {
        columns: JOB_COLUMNS,
        rows,
        summary: `net ${usdc6(totals.net)} USDC · revenue ${usdc6(totals.revenue)} · refunds ${usdc6(totals.refunds)} · ${jobs.length} jobs, ${rows.length} in the ${days.days}d window${cachedSuffix(out)}`,
      },
    };
  },
};

/* ----------------------------------------------------------------- jobs */

const jobsCommand: Command = {
  name: "jobs",
  args: "[--state settled|refunded|open]",
  help: "scoped job table from the subgraph",
  kind: "inspect",
  run: async (_ctx, argv) => {
    const stateArg = flagValue(argv, "--state");
    if (stateArg !== undefined && !["settled", "refunded", "open"].includes(stateArg)) {
      return { render: "text", data: `unknown job state: ${stateArg} · use settled|refunded|open` };
    }
    let out: Resilient<JobView[]>;
    try {
      out = await fetchJobsResilient();
    } catch (error) {
      return { render: "text", data: `jobs failed: ${reason(error)} · is the subgraph reachable? (try lag)` };
    }
    const jobs = out.value;
    const filtered = stateArg === undefined ? jobs : jobs.filter((j) => j.state === stateArg);
    if (filtered.length === 0) {
      return {
        render: "text",
        data:
          stateArg === undefined
            ? "no scoped jobs · nothing indexed for our addresses yet"
            : `no ${stateArg} jobs for our addresses`,
      };
    }
    return {
      render: "table",
      data: {
        columns: JOB_COLUMNS,
        rows: filtered.map((j) => jobTableRow(j)),
        summary: `${filtered.length} scoped job${filtered.length === 1 ? "" : "s"} (ours: buyer or seller in OUR_ADDRESSES)${cachedSuffix(out)}`,
      },
    };
  },
};

/* ------------------------------------------------------------------ job */

const jobCommand: Command = {
  name: "job",
  args: "<id>",
  help: "one job's onchain+indexed detail: paid → fulfilled → settled/refunded",
  kind: "inspect",
  run: async (_ctx, argv) => {
    const id = argv[1];
    if (!id) return { render: "text", data: "usage: job <id> · try jobs; replay <id> opens the theater" };
    try {
      BigInt(id);
    } catch {
      return { render: "text", data: `job: invalid id "${id}" · a numeric job id` };
    }
    let events: Resilient<JobEventView>;
    try {
      events = await fetchJobEventsResilient(BigInt(id));
    } catch (error) {
      return { render: "text", data: `job ${id} failed: ${reason(error)}` };
    }
    const rows: KvRow[] = [["job", id]];
    const ev = events.value;
    if (ev.paid) {
      const p = ev.paid;
      rows.push(
        ["paid.buyer", truncateHash(p.buyer)],
        ["paid.seller", truncateHash(p.seller)],
        ["paid.amount", usdc6(p.amount)],
        ["paid.minBlock", p.minBlock.toString()],
        ["paid.deadline", p.deadline.toString()],
        ["paid.blockNumber", p.blockNumber.toString()],
        ["paid.timestamp", dayTime(p.timestamp)],
      );
    } else {
      rows.push(["paid", "no queryPaid indexed for this job"]);
    }
    if (ev.fulfilled) {
      rows.push(
        ["fulfilled.payloadHash", truncateHash(ev.fulfilled.payloadHash, 12, 10)],
        ["fulfilled.metaBlock", String(ev.fulfilled.metaBlock)],
      );
    } else {
      rows.push(["fulfilled", "not delivered yet"]);
    }
    if (ev.settled) {
      rows.push(["settled", `${truncateHash(ev.settled.seller)} · ${usdc6(ev.settled.amount)} USDC`]);
    } else if (ev.refunded) {
      rows.push(["refunded", ev.refunded.reason]);
    } else {
      rows.push(["outcome", "open: neither settled nor refunded yet"]);
    }
    return {
      render: "kv",
      data: { rows, note: `replay ${id} opens the frame-by-frame theater; job 185853 is the cited refund${cachedSuffix(events)}` },
    };
  },
};

/* ------------------------------------------------------------------ lag */

const lagCommand: Command = {
  name: "lag",
  help: "arc head vs subgraph indexed block (freshness ruler)",
  kind: "inspect",
  run: async (ctx) => {
    let head: bigint;
    try {
      head = await ctx.publicClient.getBlockNumber();
    } catch (error) {
      return { render: "text", data: `lag failed: arc RPC unreachable · ${reason(error)}` };
    }
    let lagv: Resilient<{ indexed: number; rows: number }>;
    try {
      lagv = await fetchLagResilient();
    } catch (error) {
      return { render: "text", data: `lag failed: subgraph unreachable · ${reason(error)}` };
    }
    const delta = Number(head) - lagv.value.indexed;
    const note =
      delta >= 0
        ? `${delta} block${delta === 1 ? "" : "s"} behind arc head · ${lagv.value.rows} rows indexed (head probe proxy)${cachedSuffix(lagv)}`
        : `indexed ${-delta} blocks AHEAD of arc head (staged subgraph?) · ${lagv.value.rows} rows${cachedSuffix(lagv)}`;
    return {
      render: "ruler",
      data: { delivered: lagv.value.indexed, head: Number(head), label: "subgraph indexed vs arc head", note },
    };
  },
};

/* ---------------------------------------------------------- policy show */

const policyShowCommand: Command = {
  name: "policy show",
  help: "PolicyWallet caps/spend + allowlist, read LIVE from the contract",
  kind: "inspect",
  run: async (ctx) => {
    let view: Awaited<ReturnType<typeof readPolicy>>;
    try {
      view = await readPolicy(ctx.publicClient);
    } catch (error) {
      return { render: "text", data: `policy show failed: ${reason(error)}` };
    }
    const rows: KvRow[] = [
      ["owner", truncateHash(view.owner)],
      ["agent", truncateHash(view.agent)],
      ["perTxCap", usdc6(view.perTxCap)],
      ["dailyCap", usdc6(view.dailyCap)],
      ["spentToday", usdc6(view.spentToday)],
      ["remainingToday", usdc6(view.dailyCap - view.spentToday)],
      ["lastDayStart", view.lastDayStart.toString()],
    ];
    for (const [label, address] of [["allowlisted.owner", view.owner], ["allowlisted.agent", view.agent]] as const) {
      try {
        const yes = await ctx.publicClient.readContract({
          address: ADDR.policy,
          abi: ALLOWLIST_ABI,
          functionName: "allowlisted",
          args: [address],
        });
        rows.push([label, yes ? "yes" : "no"]);
      } catch (error) {
        rows.push([label, `✗ ${reason(error)}`]);
      }
    }
    return {
      render: "kv",
      data: {
        rows,
        note: "caps/spend are LIVE contract reads (PolicyWallet 0x4e83…) · the subgraph PolicyConfig entity is empty on our instance and is not used",
      },
    };
  },
};

/* ---------------------------------------------------------------- replay */

const replayCommand: Command = {
  name: "replay",
  args: "<jobId>",
  help: "open the replay theater for a job (frame-by-frame, T10)",
  kind: "replay",
  run: async (ctx, argv) => {
    const jobId = argv[1];
    if (!jobId) return { render: "text", data: "usage: replay <jobId> · try jobs" };
    ctx.navigate(`#theater/${jobId}`);
    return { render: "frames", data: { jobId } };
  },
};

registerAll(
  helpCommand,
  statusCommand,
  ensShowCommand,
  ensCanEditCommand,
  datasetsCommand,
  quoteCommand,
  booksCommand,
  jobsCommand,
  jobCommand,
  lagCommand,
  policyShowCommand,
  replayCommand,
);
