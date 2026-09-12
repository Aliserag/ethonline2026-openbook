/**
 * sla-subgraph-mcp — the OpenBook prize-entry MCP server (Task 5).
 *
 * Seven tools over StdioServerTransport:
 *   list_datasets   — catalog (config + ENS svc.menu)
 *   get_quote       — ENSv2-resolved price/SLA/payee (hard-fails without records)
 *   query_dataset   — Gateway query with _meta freshness gate (never charges stale)
 *   verify_delivery — deterministic APPROVE/REJECT + ERC-8183 settle/refund
 *   get_pnl         — Task 4 open-book subgraph P&L
 *
 * All external I/O (Gateway HTTP, ENS text, chain writes) goes through seams
 * (fetchImpl / readEnsText / injected clients) — production uses real services,
 * unit tests inject mocks. No mocks exist in production paths.
 *
 * Run:  bun mcp/src/server.ts --config mcp/config/openbook.json
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isAddress } from "viem";
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  toBytes,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  loadConfigFile,
  resolveGatewayKey,
  resolveOperatorKey,
  type OpenBookConfig,
} from "./datasets";
import { gatewayQuery, hostedQuery, type FetchLike, type GatewayMeta } from "./gateway";
import { defaultChainHeadResolver, type ChainHeadResolver } from "./chainhead";
import {
  createEnsTextReader,
  parsePriceToAmount6dec,
  parseSlaRecord,
  resolveDatasetRecords,
  resolveServiceRecords,
  type EnsTextReader,
} from "./ens";
import { verifyDelivery as verifyDeliveryCore } from "./escrow";
import { listSellers as listSellersLive, parseMenu, sellersForSchema, type SellerRef } from "./directory";
import { createSubgraphSearch, type SubgraphCandidate, type SubgraphSearch } from "./subgraph-mcp";
import { setEscrowAddress } from "../../agent/escrow";
import { ARC_MS_PER_BLOCK, ARC_RPC_URL } from "./constants";

// --- domain types ---------------------------------------------------------------

export interface DatasetListing {
  id: string;
  schema: string;
  /** display price, e.g. "0.10 USDC/query" (authoritative price comes from ENS) */
  price: string | null;
  priceUsdc: number | null;
  freshnessMaxAge: number | null;
  description: string;
  pinned: boolean;
  /** true when the dataset is also advertised on the ENS svc.menu record */
  onEnsMenu: boolean;
  /** where `price` came from: the live ENS record (authoritative) or the config (display only) */
  priceSource: "ENS" | "config";
}

export interface ListDatasetsResult {
  datasets: DatasetListing[];
}

export interface GetQuoteResult {
  datasetId: string;
  /** price in 6-decimal USDC units, resolved LIVE from the ENS svc.price record */
  amount: number;
  amountUsdc: string;
  /** SLA min block lag (blocks behind chain head the data must satisfy) */
  minBlockLag: number;
  /** escrow deadline in Arc blocks (derived from svc.sla maxLatencyMs) */
  deadlineBlocks: number;
  payee: string;
  sla: { maxBlockLag: number; maxLatencyMs: number };
  priceRecord: string;
  source: "ENS";
}

export interface Attestation {
  queryId: string;
  payloadHash: string;
  metaBlock: number;
  /** the exact signed payload: queryId|payloadHash|metaBlock */
  message: string;
  /** EIP-191 personal-signature by the operator key (deterministic) */
  signature: string;
  signer: string;
}

export type QueryDatasetResult =
  | {
      unavailable: true;
      reason: "STALE" | "NO_META" | "INDEXING_ERRORS";
      meta: GatewayMeta;
      freshnessMaxAge: number;
      detectedAt: string;
    }
  | {
      unavailable: false;
      result: unknown;
      meta: { block: number; hash: string };
      attestation: Attestation;
    };

export interface VerifyDeliveryResult {
  verdict: "APPROVE" | "REJECT";
  reason?: "STALE_DATA" | "INVALID_HASH";
  jobId?: string;
  minBlock: number;
  txHash?: string;
}

export interface PnlRow {
  id: string;
  revenue: string;
  costs: string;
  refunds: string;
  net: string;
}

export interface GetPnlResult {
  dailyPnLs: PnlRow[];
  metaBlock: number | null;
}

export interface SellerCandidate {
  name: string;
  priceUsdc: number | null;
  price: string | null;
  maxBlockLag: number | null;
  /** null when the index lag is unknown (keyless run) */
  deliverableNow: boolean | null;
  eligible: boolean;
  reason: string;
}

export interface ChooseSellerResult {
  datasetId: string;
  schema: string;
  prefer: "cheap" | "fresh";
  maxPriceUsdc: number | null;
  /** the live signal the decision used: the dataset's index lag right now */
  signal: { chainHead: number; metaBlock: number; lagBlocks: number } | null;
  candidates: SellerCandidate[];
  choice: SellerCandidate | null;
  rationale: string[];
}

export interface DiscoverResult {
  keyword: string;
  returned: number;
  candidates: (SubgraphCandidate & { alreadySold: boolean; configEntry: Record<string, unknown> })[];
  note: string;
}

export interface OpenBookApp {
  /** The ERC-8183 escrow this app boots against — config default, or OPENBOOK_ESCROW override when set. */
  escrowAnchor: `0x${string}`;
  listDatasets(): Promise<ListDatasetsResult>;
  getQuote(datasetId: string): Promise<GetQuoteResult>;
  /** Search The Graph's catalog (official Subgraph MCP) and return ready-to-paste dataset entries. */
  discoverDatasets(input: { keyword: string }): Promise<DiscoverResult>;
  /** Pick a seller for a dataset from live ENS terms and the dataset's current index lag. */
  chooseSeller(input: { datasetId: string; prefer?: "cheap" | "fresh"; maxPriceUsdc?: number }): Promise<ChooseSellerResult>;
  queryDataset(datasetId: string, graphql: string): Promise<QueryDatasetResult>;
  verifyDelivery(input: {
    jobId?: string;
    payloadHash?: string;
    metaBlock: number;
    minBlock?: number;
    settle?: boolean;
  }): Promise<VerifyDeliveryResult>;
  getPnl(): Promise<GetPnlResult>;
}

export interface AppDeps {
  env?: Record<string, string | undefined>;
  readEnsText?: EnsTextReader;
  fetchImpl?: FetchLike;
  /** freshness head resolver — defaults to Alchemy via chainhead.ts (the
   * Gateway's _meta has no chainHeadBlock field; live probe 2026-09-09) */
  chainHead?: ChainHeadResolver;
  /** seller enumeration seam (live: the ENSv2 subregistry walk in directory.ts) */
  listSellers?: (parentName: string) => Promise<SellerRef[]>;
  /** catalog search seam (live: The Graph's official Subgraph MCP over SSE) */
  searchSubgraphs?: SubgraphSearch;
}

// --- app construction -------------------------------------------------------------

/** Copy of the gateway data without the `_meta` selection (meta travels separately). */
function stripMeta(data: unknown): unknown {
  if (typeof data !== "object" || data === null) return data;
  const copy: Record<string, unknown> = { ...(data as Record<string, unknown>) };
  delete copy["_meta"];
  return copy;
}

const ESCROW_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Resolve the ERC-8183 escrow this MCP boots against: the config default
 * (already validated as an address by loadConfigFile) is the world; an
 * OPENBOOK_ESCROW override wins when set. The override is validated here so a
 * malformed value fails loudly at boot — never a silent fallback.
 */
function resolveEscrowAnchor(config: OpenBookConfig, env: Record<string, string | undefined>): `0x${string}` {
  const raw = env["OPENBOOK_ESCROW"];
  if (raw === undefined || raw === "") return config.escrow;
  if (!ESCROW_ADDRESS_RE.test(raw)) {
    throw new Error(
      `refusing to boot: OPENBOOK_ESCROW ${JSON.stringify(raw)} is not a valid ERC-8183 escrow address (expected 0x + 40 hex chars)`,
    );
  }
  return raw as `0x${string}`;
}

/**
 * Build the tool logic layer. All seams default to live services.
 */
export function createApp(config: OpenBookConfig, deps: AppDeps = {}): OpenBookApp {
  const env = deps.env ?? {};
  const readEnsText = deps.readEnsText ?? createEnsTextReader({ rpcUrl: env["SEPOLIA_RPC"] });
  const fetchImpl = deps.fetchImpl;
  const chainHead = deps.chainHead ?? defaultChainHeadResolver(env["ALCHEMY_API_KEY"]);
  const listSellersDep = deps.listSellers ?? ((parent: string) => listSellersLive(parent, { readEnsText }));
  const operatorKey = resolveOperatorKey(config, env);
  const gatewayKey = resolveGatewayKey(config, env);
  const searchSubgraphs = deps.searchSubgraphs ?? (gatewayKey ? createSubgraphSearch(gatewayKey) : undefined);

  const arcRpc = env["ARC_TESTNET_RPC"] ?? ARC_RPC_URL;
  let arcPublic: PublicClient | undefined;
  const getPublicClient = (): PublicClient => {
    if (arcPublic === undefined) {
      arcPublic = createPublicClient({ chain: arcTestnet, transport: http(arcRpc) });
    }
    return arcPublic;
  };
  let arcWallet: WalletClient | undefined;
  const getWalletClient = (): WalletClient => {
    if (arcWallet !== undefined) return arcWallet;
    if (operatorKey === undefined) {
      throw new Error(
        "operator key not configured — set " +
          (config.operatorKey.length > 2 && !config.operatorKey.startsWith("0x")
            ? `${config.operatorKey} (or ARC_TESTNET_PK)`
            : "OPERATOR_PRIVATE_KEY") +
          " in the environment",
      );
    }
    const account = privateKeyToAccount(operatorKey);
    arcWallet = createWalletClient({ chain: arcTestnet, transport: http(arcRpc), account });
    return arcWallet;
  };

  // The escrow anchor: the config default (validated by loadConfigFile) is the
  // world this MCP boots against; OPENBOOK_ESCROW overrides it when set.
  const escrowAnchor = resolveEscrowAnchor(config, env);
  // Point every onchain operation in this process (verify_delivery settle,
  // job reads) at the resolved anchor — the agent layer's singleton seam,
  // same as buyer-cli/seller use. Without this, settle would still target the
  // shared reference deployment no matter which world the server booted on.
  setEscrowAddress(escrowAnchor);

  const displayPrice = (priceUsdc: number): string =>
    `${(priceUsdc / 1_000_000).toFixed(2)} USDC/query`;

  const listDatasets = async (): Promise<ListDatasetsResult> => {
    const datasets: DatasetListing[] = config.datasets.map((dataset) => ({
      id: dataset.id,
      schema: dataset.schema,
      price: displayPrice(dataset.priceUsdc),
      priceUsdc: dataset.priceUsdc,
      freshnessMaxAge: dataset.freshness.maxAge,
      description: dataset.description,
      pinned: dataset.pinned,
      onEnsMenu: false,
      priceSource: "config" as const,
    }));
    // The catalog quotes the live ENS price when the records resolve (the
    // subname record wins over the parent), so list_datasets never shows an
    // agent a number get_quote would contradict.
    await Promise.all(
      datasets.map(async (listing) => {
        try {
          const records = await resolveDatasetRecords(config.ens, listing.id, readEnsText);
          if (records.price !== null) {
            listing.price = records.price;
            listing.priceUsdc = parsePriceToAmount6dec(records.price);
            listing.priceSource = "ENS";
          }
        } catch {
          // keep the config display price, labeled as such
        }
      }),
    );
    // ENS merge is tolerant: the catalog must never disappear because Sepolia RPC
    // is down — only the quote (which needs records) hard-fails.
    try {
      const records = await resolveServiceRecords(config.ens, readEnsText);
      if (records.menu !== null) {
        let menuEntries: unknown[] = [];
        try {
          const parsed = JSON.parse(records.menu) as unknown;
          if (Array.isArray(parsed)) menuEntries = parsed;
        } catch {
          menuEntries = [];
        }
        for (const entry of menuEntries) {
          if (typeof entry !== "object" || entry === null) continue;
          const menuItem = entry as Record<string, unknown>;
          if (typeof menuItem["id"] !== "string") continue;
          const known = datasets.find((d) => d.id === menuItem["id"]);
          if (known !== undefined) {
            known.onEnsMenu = true;
          } else {
            datasets.push({
              id: menuItem["id"],
              schema: typeof menuItem["schema"] === "string" ? menuItem["schema"] : "unknown",
              price: null,
              priceUsdc: null,
              freshnessMaxAge: null,
              description: "advertised on ENS svc.menu (no local config — quote resolves via get_quote)",
              pinned: false,
              onEnsMenu: true,
            });
          }
        }
      }
    } catch {
      // ENS unreachable: serve the local catalog only
    }
    return { datasets };
  };

  const getQuote = async (datasetId: string): Promise<GetQuoteResult> => {
    const dataset = config.datasets.find((d) => d.id === datasetId);
    if (dataset === undefined) throw new Error(`unknown dataset: ${datasetId}`);
    // parent records + dataset-subname override — shared with the buyer CLI so
    // quote == charge everywhere (mcp/src/ens.ts resolveDatasetRecords)
    const records = await resolveDatasetRecords(config.ens, datasetId, readEnsText); // hard-fails ENS_RESOLUTION_FAILED
    const amount = parsePriceToAmount6dec(records.price as string);
    const sla = parseSlaRecord(records.sla as string);
    const deadlineBlocks = Math.max(1, Math.ceil(sla.maxLatencyMs / ARC_MS_PER_BLOCK));
    return {
      datasetId,
      amount,
      amountUsdc: (amount / 1_000_000).toFixed(2),
      minBlockLag: sla.maxBlockLag,
      deadlineBlocks,
      payee: records.payee as string,
      sla,
      priceRecord: records.price as string,
      source: "ENS",
    };
  };

  const queryDataset = async (datasetId: string, graphql: string): Promise<QueryDatasetResult> => {
    const dataset = config.datasets.find((d) => d.id === datasetId);
    if (dataset === undefined) throw new Error(`unknown dataset: ${datasetId}`);
    if (!gatewayKey) {
      throw new Error(
        "GRAPH_GATEWAY_KEY not set — create a free API key at https://thegraph.com/studio and export it (queries are key-gated, like every other The Graph path in OpenBook)",
      );
    }
    const { data, meta } = await gatewayQuery({
      key: gatewayKey,
      subgraphId: dataset.subgraphId,
      query: graphql,
      baseUrl: config.gateway.baseUrl,
      fetchImpl,
    });
    const freshnessMaxAge = dataset.freshness.maxAge;
    const block = meta.block;
    let head: number | null;
    try {
      head = block === null ? null : await chainHead(dataset.chain);
    } catch {
      head = null; // fail-closed: no reference head → unavailable, never charged
    }
    if (block === null || head === null) {
      return {
        unavailable: true,
        reason: "NO_META",
        meta,
        freshnessMaxAge,
        detectedAt: new Date().toISOString(),
      };
    }
    if (head - block > freshnessMaxAge) {
      return { unavailable: true, reason: "STALE", meta, freshnessMaxAge, detectedAt: new Date().toISOString() };
    }
    if (meta.hasIndexingErrors) {
      // a subgraph reporting indexing errors is not sold as fresh, whatever its block
      return { unavailable: true, reason: "INDEXING_ERRORS", meta, freshnessMaxAge, detectedAt: new Date().toISOString() };
    }

    // fresh: sign the deterministic attestation before returning (seller liability)
    if (operatorKey === undefined) {
      throw new Error(
        "operator key not configured — attestation signing requires the seller key (see config.operatorKey)",
      );
    }
    const payload = stripMeta(data);
    const payloadHash = keccak256(toBytes(JSON.stringify(payload)));
    const queryId = `${dataset.id}@${block}`;
    const message = `${queryId}|${payloadHash}|${block}`;
    const account = privateKeyToAccount(operatorKey);
    const signature = await account.signMessage({ message });
    return {
      unavailable: false,
      result: payload,
      meta: { block, hash: meta.hash as string },
      attestation: { queryId, payloadHash, metaBlock: block, message, signature, signer: account.address },
    };
  };

  const verifyDeliveryTool = async (input: {
    jobId?: string;
    payloadHash?: string;
    metaBlock: number;
    minBlock?: number;
    settle?: boolean;
  }): Promise<VerifyDeliveryResult> => {
    if (input.settle === true && operatorKey === undefined) {
      throw new Error(
        "verify_delivery(settle: true) requires the operator key — set OPERATOR_PRIVATE_KEY in the environment (the verdict itself is computed purely and needs no key)",
      );
    }
    const needsPublic = input.minBlock === undefined && input.jobId !== undefined;
    const publicClient = needsPublic || input.settle === true ? getPublicClient() : undefined;
    const walletClient = input.settle === true ? getWalletClient() : undefined;
    return verifyDeliveryCore(
      {
        jobId: input.jobId !== undefined ? input.jobId : undefined,
        payloadHash: input.payloadHash as `0x${string}` | undefined,
        metaBlock: input.metaBlock,
        minBlock: input.minBlock,
        settle: input.settle,
      },
      { publicClient, walletClient },
    );
  };

  const getPnl = async (): Promise<GetPnlResult> => {
    // The Studio query endpoint is account-scoped and public — no key required.
    // ({GRAPH_GATEWAY_KEY} interpolation kept for configs that still carry it.)
    const endpoint = config.pnl.endpoint.replace("{GRAPH_GATEWAY_KEY}", gatewayKey ?? "");
    const { data, meta } = await hostedQuery({ url: endpoint, query: config.pnl.query, fetchImpl });
    const rows: PnlRow[] = [];
    if (typeof data === "object" && data !== null) {
      const dailyRaw = (data as Record<string, unknown>)["dailyPnLs"];
      if (Array.isArray(dailyRaw)) {
        for (const entry of dailyRaw) {
          if (typeof entry !== "object" || entry === null) continue;
          const row = entry as Record<string, unknown>;
          rows.push({
            id: typeof row["id"] === "string" ? row["id"] : String(row["id"]),
            revenue: typeof row["revenue"] === "string" ? row["revenue"] : String(row["revenue"]),
            costs: typeof row["costs"] === "string" ? row["costs"] : String(row["costs"]),
            refunds: typeof row["refunds"] === "string" ? row["refunds"] : String(row["refunds"]),
            net: typeof row["net"] === "string" ? row["net"] : String(row["net"]),
          });
        }
      }
    }
    return { dailyPnLs: rows, metaBlock: meta.block };
  };

  /**
   * The buyer-side decision: which seller to buy this dataset from. Terms come
   * from each seller's live ENS records (price, freshness window); the signal
   * is the dataset's index lag right now (Gateway _meta vs the chain head). A
   * seller whose promised window the index cannot meet at this moment is not
   * eligible: buying from it would only end in a refund.
   */
  const chooseSeller = async (input: { datasetId: string; prefer?: "cheap" | "fresh"; maxPriceUsdc?: number }): Promise<ChooseSellerResult> => {
    const dataset = config.datasets.find((d) => d.id === input.datasetId);
    if (dataset === undefined) throw new Error(`unknown dataset: ${input.datasetId}`);
    const prefer = input.prefer ?? "cheap";
    const maxPriceUsdc = typeof input.maxPriceUsdc === "number" && input.maxPriceUsdc > 0 ? input.maxPriceUsdc : null;
    const rationale: string[] = [];

    const listed = await listSellersDep(config.ens);
    // the parent name is a seller too (its svc.menu lists the datasets it sells); the
    // directory walk only enumerates subnames, so add it here, priced the way a quote
    // would be: the dataset subname's record first, the parent's as the fallback
    if (!listed.some((s) => s.name === config.ens)) {
      const [menuRaw, parentPrice, parentSla, subPrice, subSla, payee, operator] = await Promise.all([
        readEnsText(config.ens, "svc.menu").catch(() => null),
        readEnsText(config.ens, "svc.price").catch(() => null),
        readEnsText(config.ens, "svc.sla").catch(() => null),
        readEnsText(`${dataset.id}.${config.ens}`, "svc.price").catch(() => null),
        readEnsText(`${dataset.id}.${config.ens}`, "svc.sla").catch(() => null),
        readEnsText(config.ens, "svc.payee").catch(() => null),
        readEnsText(config.ens, "svc.operator").catch(() => null),
      ]);
      const menu = parseMenu(menuRaw);
      if (menu !== null) {
        let sla: SellerRef["sla"] = null;
        const slaRaw = subSla ?? parentSla;
        if (slaRaw !== null) {
          try {
            sla = parseSlaRecord(slaRaw);
          } catch {
            sla = null;
          }
        }
        listed.push({
          name: config.ens,
          menu,
          price: subPrice ?? parentPrice,
          sla,
          payee: payee !== null && isAddress(payee) ? (payee as `0x${string}`) : null,
          operator: operator !== null && isAddress(operator) ? (operator as `0x${string}`) : null,
        });
      }
    }
    const sellers = sellersForSchema(listed, dataset.schema);
    rationale.push(`${sellers.length} seller(s) list ${dataset.schema} under ${config.ens} (read from ENSv2 just now)`);

    let signal: ChooseSellerResult["signal"] = null;
    if (gatewayKey) {
      try {
        const { meta } = await gatewayQuery({ key: gatewayKey, subgraphId: dataset.subgraphId, query: "{ _meta { block { number } } }", baseUrl: config.gateway.baseUrl, fetchImpl });
        const head = meta.block === null ? null : await chainHead(dataset.chain);
        if (meta.block !== null && head !== null) {
          signal = { chainHead: head, metaBlock: meta.block, lagBlocks: Math.max(0, head - meta.block) };
          rationale.push(`the ${dataset.id} index is ${signal.lagBlocks} block(s) behind the ${dataset.chain} head (${meta.block} vs ${head})`);
        }
      } catch (error) {
        rationale.push(`index lag unknown (${error instanceof Error ? error.message.slice(0, 80) : String(error)}); deciding on ENS terms alone`);
      }
    } else {
      rationale.push("no GRAPH_GATEWAY_KEY, so the index lag is unknown; deciding on ENS terms alone");
    }

    const candidates: SellerCandidate[] = sellers.map((seller) => {
      const m = seller.price?.match(/^([0-9]+(?:\.[0-9]+)?)\s*USDC/i);
      const priceUsdc = m ? Number(m[1]) : null;
      const maxBlockLag = seller.sla?.maxBlockLag ?? null;
      const deliverableNow = signal === null || maxBlockLag === null ? null : signal.lagBlocks <= maxBlockLag;
      let reason: string;
      let eligible = true;
      if (priceUsdc === null) {
        eligible = false;
        reason = "svc.price unreadable";
      } else if (maxBlockLag === null) {
        eligible = false;
        reason = "svc.sla unreadable";
      } else if (maxPriceUsdc !== null && priceUsdc > maxPriceUsdc) {
        eligible = false;
        reason = `${priceUsdc} USDC is over the ${maxPriceUsdc} USDC budget`;
      } else if (deliverableNow === false) {
        eligible = false;
        reason = `promises ≤${maxBlockLag} blocks but the index is ${signal!.lagBlocks} behind right now: a purchase would only be refunded`;
      } else {
        reason = deliverableNow === true ? `${priceUsdc} USDC, promises ≤${maxBlockLag} blocks, index lag ${signal!.lagBlocks}: deliverable now` : `${priceUsdc} USDC, promises ≤${maxBlockLag} blocks (lag unknown)`;
      }
      return { name: seller.name, priceUsdc, price: seller.price, maxBlockLag, deliverableNow, eligible, reason };
    });

    const eligible = candidates.filter((c) => c.eligible && c.priceUsdc !== null && c.maxBlockLag !== null);
    eligible.sort((a, b) =>
      prefer === "cheap"
        ? a.priceUsdc! - b.priceUsdc! || a.maxBlockLag! - b.maxBlockLag!
        : a.maxBlockLag! - b.maxBlockLag! || a.priceUsdc! - b.priceUsdc!,
    );
    const choice = eligible[0] ?? null;
    if (choice) {
      const verified = signal !== null ? "that can deliver" : "on ENS terms (deliverability unverified: no index lag reading)";
      rationale.push(prefer === "cheap" ? `chose ${choice.name}: the cheapest seller ${verified} (${choice.priceUsdc} USDC)` : `chose ${choice.name}: the tightest freshness promise ${verified} (≤${choice.maxBlockLag} blocks at ${choice.priceUsdc} USDC)`);
    } else {
      rationale.push("no seller is eligible right now: do not buy");
    }
    return { datasetId: dataset.id, schema: dataset.schema, prefer, maxPriceUsdc, signal, candidates, choice, rationale };
  };

  /**
   * Onboarding a dataset is one config entry; finding the subgraph is The Graph's
   * job. This asks the official Subgraph MCP (same Gateway key) and hands back an
   * entry you can paste into the config, marking anything this server already sells.
   */
  const discoverDatasets = async (input: { keyword: string }): Promise<DiscoverResult> => {
    const keyword = input.keyword.trim();
    if (keyword.length < 2) throw new Error("keyword must be at least 2 characters");
    if (!searchSubgraphs) {
      throw new Error("GRAPH_GATEWAY_KEY not set — the catalog search runs through The Graph's Subgraph MCP, which needs the same Studio key");
    }
    const found = await searchSubgraphs(keyword);
    const sold = new Set(config.datasets.map((d) => d.subgraphId));
    const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "dataset";
    const candidates = found.map((c) => ({
      ...c,
      alreadySold: sold.has(c.subgraphId),
      configEntry: {
        id: slug(c.name),
        subgraphId: c.subgraphId,
        chain: "arbitrum",
        schema: "custom/1.0.0",
        priceUsdc: 100000,
        freshness: { maxAge: 50 },
        description: `${c.name} (from The Graph catalog)`,
      },
    }));
    return {
      keyword,
      returned: candidates.length,
      candidates,
      note: "results from The Graph's Subgraph MCP (search_subgraphs_by_keyword); set chain and schema to match the subgraph, add the entry to mcp/config/*.json, and price it on ENS (svc.price on the dataset subname or the parent)",
    };
  };

  return { escrowAnchor, listDatasets, getQuote, chooseSeller, discoverDatasets, queryDataset, verifyDelivery: verifyDeliveryTool, getPnl };
}

// --- MCP registration --------------------------------------------------------------

interface TextContent {
  type: "text";
  text: string;
}

interface ToolOk {
  content: TextContent[];
}

interface ToolError {
  content: TextContent[];
  isError: true;
}

function toolData(value: unknown): ToolOk {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function toolError(error: unknown): ToolError {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Shared error boundary for every tool: failures are surfaced as MCP errors. */
function wrap<Args>(fn: (args: Args) => Promise<unknown>): (args: Args) => Promise<ToolOk | ToolError> {
  return async (args: Args) => {
    try {
      return toolData(await fn(args));
    } catch (error) {
      return toolError(error);
    }
  };
}

/** Register the 7 tools on an SDK McpServer. */
export function createMcpServer(app: OpenBookApp): McpServer {
  const server = new McpServer({ name: "sla-subgraph-mcp", version: "0.1.0" });

  server.tool(
    "list_datasets",
    "List the datasets this server sells: pinned Start Fresh subgraphs plus the ENS svc.menu catalog. Returns id, schema, price, freshness and description per dataset.",
    {},
    wrap(async () => app.listDatasets()),
  );

  server.tool(
    "get_quote",
    "Resolve the live price/SLA/payee for a dataset from the ENSv2 svc.* records (Sepolia). Hard-fails (ENS_RESOLUTION_FAILED) when records are missing — never quotes hard-coded values.",
    { datasetId: z.string().min(1) },
    wrap(async (args: { datasetId: string }) => app.getQuote(args.datasetId)),
  );

  server.tool(
    "discover_datasets",
    "Find subgraphs to sell: searches The Graph's catalog through the official Subgraph MCP (same Gateway key) and returns candidates with a ready-to-paste dataset config entry, marking the ones this server already sells.",
    { keyword: z.string().min(2) },
    wrap(async (args: { keyword: string }) => app.discoverDatasets(args)),
  );

  server.tool(
    "choose_seller",
    "Decide which seller to buy a dataset from. Enumerates the sellers that list it on ENSv2, reads each one's live price and freshness window, measures the dataset's index lag right now (Gateway _meta vs chain head), drops sellers whose window the index cannot meet, and picks the cheapest (prefer=cheap) or tightest-window (prefer=fresh) seller within maxPriceUsdc. Returns candidates, the choice and the reasoning.",
    { datasetId: z.string().min(1), prefer: z.enum(["cheap", "fresh"]).optional(), maxPriceUsdc: z.number().positive().optional() },
    wrap(async (args: { datasetId: string; prefer?: "cheap" | "fresh"; maxPriceUsdc?: number }) => app.chooseSeller(args)),
  );

  server.tool(
    "query_dataset",
    "Query a dataset through The Graph Gateway with the _meta freshness gate. When chainHeadBlock - _meta.block > maxAge the result is marked unavailable (STALE) and is NEVER charged. Fresh results carry a signed attestation (queryId|payloadHash|metaBlock).",
    { datasetId: z.string().min(1), graphql: z.string().min(1) },
    wrap(async (args: { datasetId: string; graphql: string }) => app.queryDataset(args.datasetId, args.graphql)),
  );

  server.tool(
    "verify_delivery",
    "Deterministically verify a delivered query against its SLA: metaBlock >= minBlock (resolved from the onchain job description unless overridden) and a well-formed payloadHash -> APPROVE; otherwise REJECT (STALE_DATA/INVALID_HASH). Purely computes the verdict by default; pass settle:true to ALSO execute complete()/rejectAndRefund() on ERC-8183 (requires the operator key and a fundable Arc RPC).",
    {
      jobId: z.string().min(1),
      payloadHash: z.string(),
      metaBlock: z.number().int().nonnegative(),
      minBlock: z.number().int().nonnegative().optional(),
      settle: z.boolean().optional(),
    },
    wrap(async (args: { jobId: string; payloadHash: string; metaBlock: number; minBlock?: number; settle?: boolean }) =>
      app.verifyDelivery(args),
    ),
  );

  server.tool(
    "get_pnl",
    "Query the openbook-pnl subgraph on arc-testnet (Studio): dailyPnLs { id revenue costs refunds net } plus the indexing _meta block.",
    {},
    wrap(async () => app.getPnl()),
  );

  return server;
}

// --- CLI entry -----------------------------------------------------------------------

function parseCli(argv: string[]): { config: string } {
  const args = [...argv];
  let config: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--config" || args[i] === "-c") && i + 1 < args.length) {
      config = args[i + 1];
      i++;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(
        "sla-subgraph-mcp — OpenBook MCP server\n\n" +
          "Usage: sla-subgraph-mcp --config <config.json>\n\n" +
          "Env:  GRAPH_GATEWAY_KEY (required for queries), OPERATOR_PRIVATE_KEY (attestation/settlement),\n" +
          "      SEPOLIA_RPC (ENS reads; default public), ARC_TESTNET_RPC (default https://rpc.testnet.arc.io)\n",
      );
      process.exit(0);
    }
  }
  if (config === undefined) {
    console.error("usage: sla-subgraph-mcp --config <config.json>       (try --help)");
    process.exit(1);
  }
  return { config };
}

/** Minimal .env loader (only sets keys that are currently unset). No dependency. */
function loadDotEnv(env: Record<string, string | undefined>): void {
  let text = "";
  try {
    text = readFileSync(resolve(".env"), "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (env[key] === undefined || env[key] === "") env[key] = value;
  }
}

/** Try explicit --config, then ./openbook.json, then ./mcp/config/openbook.json. */
function findConfig(explicit: string): string {
  if (explicit !== undefined && explicit.length > 0) return resolve(explicit);
  const candidates = ["openbook.json", "mcp/config/openbook.json"];
  for (const candidate of candidates) {
    try {
      readFileSync(resolve(candidate), "utf8");
      return resolve(candidate);
    } catch {
      // keep looking
    }
  }
  throw new Error("no config found — pass --config <config.json>");
}

export async function main(argv: string[]): Promise<void> {
  const { config: explicit } = parseCli(argv);
  const configPath = findConfig(explicit);
  loadDotEnv(process.env);
  const config = loadConfigFile(configPath);
  const app = createApp(config, { env: process.env });
  const server = createMcpServer(app);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const IS_ENTRY =
  typeof import.meta.main === "boolean"
    ? import.meta.main
    : process.argv[1] !== undefined && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);

if (IS_ENTRY) {
  main(process.argv.slice(2)).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`sla-subgraph-mcp: ${message}`);
    process.exit(1);
  });
}
