/**
 * Live system map (T11) — a paper/ink SVG topology of the OpenBook system.
 * Every node polls its own live reader through useLiveValue (truthful
 * live/stale/error chips with reasons — spec S9) and opens a Drawer with the
 * node's detail rows + a primary console action dispatched through the
 * registry (zero duplicate logic).
 *
 * Live reads reuse the frozen readers — readIdentity/readPolicy
 * (data/identity.ts, data/policy.ts), fetchJobs/fetchLag/scopedTotals
 * (data/subgraph.ts), the ENSv2 text reader and the keyless chain-head
 * resolver (mcp) — plus two map-local getters that data/* does not carry: the
 * SlaHook escrow/attester pair and the PolicyWallet allowlist checks (the
 * same pattern console/commands/inspect.ts already uses for allowlisted).
 *
 * The agent node reads ERC-8004 tokenId 894065 (carry-in: our identity token —
 * never token 1, which belongs to a stranger). The policy node reads caps from
 * the CONTRACT — the subgraph's PolicyConfig row is empty and never used.
 * Edges pulse when the subgraph's indexed head advances between polls.
 */
import { useEffect, useRef, useState, type JSX } from "react";
import { parseAbi, type Abi } from "viem";
import { CONFIG } from "../config";
import { env } from "../env";
import { ADDR } from "../data/addresses";
import { getPublicClient } from "../data/chain";
import { readIdentity } from "../data/identity";
import { readPolicy } from "../data/policy";
import { fetchJobsShared, fetchLagShared, scopedTotals } from "../data/subgraph";
import { STUDIO_GATE } from "../data/cache";
import { useLiveValue } from "../ui/useLiveValue";
import { createEnsTextReader, parseSlaRecord } from "../../../mcp/src/ens";
import { defaultChainHeadResolver } from "../../../mcp/src/chainhead";
import { truncateHash, usdc6 } from "../format";
import { EDGES, NODES, edgeTarget, type NodeLive, type NodeLiveData } from "./nodes";
import { Drawer } from "./Drawer";

const MAP_POLL_MS = 30_000;
const MAP_STALE_MS = 90_000;

/**
 * Stagger each node's poll schedule: the public Arc RPC rate-limits broad
 * simultaneous bursts (observed 429s when all 8 nodes read at once), so the
 * first read is delayed per node and every poll cadence is offset a little.
 */
function nodeOpts(index: number): { pollMs: number; staleAfterMs: number } {
  return {
    pollMs: MAP_POLL_MS + index * 1_000,
    staleAfterMs: MAP_STALE_MS + index * 1_000,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Short-TTL shared probe: several nodes read the SAME slow-moving config
 * (PolicyWallet caps, ENS storefront records). A small TTL keeps the public
 * RPCs — which rate-limit browser bursts — from being hit once per node per
 * poll: ens+mcp share one storefront read, agent+policy share one readPolicy.
 * A failed read evicts itself so the next node poll retries.
 *
 * Freshness note: the TTL (12-15s) is the node's effective freshness budget —
 * the Drawer's "records read Ns ago" age label derives from the read's
 * RESOLUTION time, so for a cache hit it may under-report the value's true age
 * by up to that window. That is well inside the node's 90s staleAfterMs and the
 * values are slow-moving config, so the chip still reads honestly.
 */
function ttl<T>(read: () => Promise<T>, ttlMs: number): () => Promise<T> {
  let at = 0;
  let value: Promise<T> | null = null;
  return () => {
    const now = Date.now();
    if (value !== null && now - at < ttlMs) return value;
    at = now;
    value = read().catch((error) => {
      value = null;
      throw error;
    });
    return value;
  };
}

/** Our ERC-8004 identity token (carry-in, verified live) — never token 1. */
const AGENT_TOKEN_ID = 894065n;

const ALLOWLIST_ABI = [
  {
    name: "allowlisted",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "address", name: "" }],
    outputs: [{ type: "bool", name: "" }],
  },
] as const satisfies Abi;

/** SlaHook.sol getters (contracts/src/SlaHook.sol) — the map's only local reader. */
const HOOK_ABI = parseAbi([
  "function escrow() view returns (address)",
  "function attester() view returns (address)",
]);

interface StorefrontRecords {
  price: string | null;
  sla: string | null;
  payee: string | null;
  menu: string | null;
  maxBlockLag: number | null;
}

/** One ENSv2 storefront probe set, shared by the ens, mcp (and theater-adjacent) nodes. */
const storefrontCached = ttl(async (): Promise<StorefrontRecords> => {
  const reader = createEnsTextReader({ rpcUrl: env.sepoliaRpc });
  const [price, sla, payee, menu] = await Promise.all([
    reader(CONFIG.ens, "svc.price").catch(() => null),
    reader(CONFIG.ens, "svc.sla").catch(() => null),
    reader(CONFIG.ens, "svc.payee").catch(() => null),
    reader(CONFIG.ens, "svc.menu").catch(() => null),
  ]);
  let maxBlockLag: number | null = null;
  if (sla !== null) {
    try {
      maxBlockLag = parseSlaRecord(sla).maxBlockLag;
    } catch {
      // unreadable record — shown as "—", never an invented figure
    }
  }
  return { price, sla, payee, menu, maxBlockLag };
}, 12_000);

/** PolicyWallet caps/spend, shared by the agent + policy nodes (15s TTL). */
const policyCached = ttl(() => readPolicy(getPublicClient()), 15_000);

/** The owner+agent allowlist check, one round for both consumers. */
const allowlistCached = ttl(async (): Promise<number> => {
  const client = getPublicClient();
  const view = await policyCached();
  const [ownerOk, agentOk] = await Promise.all([
    client.readContract({ address: ADDR.policy, abi: ALLOWLIST_ABI, functionName: "allowlisted", args: [view.owner] }),
    client.readContract({ address: ADDR.policy, abi: ALLOWLIST_ABI, functionName: "allowlisted", args: [view.agent] }),
  ]);
  return (ownerOk ? 1 : 0) + (agentOk ? 1 : 0);
}, 15_000);

async function readEnsNode(): Promise<NodeLiveData> {
  const records = await storefrontCached();
  return {
    summary: records.price ?? "✗ svc.price",
    rows: [
      ["name", CONFIG.ens],
      ["svc.price", records.price ?? "✗ unset"],
      ["svc.sla", records.sla ?? "✗ unset"],
      ["maxBlockLag", records.maxBlockLag !== null ? `${records.maxBlockLag} blocks` : "·"],
      ["svc.payee", records.payee ?? "✗ unset"],
    ],
  };
}

async function readAgentNode(): Promise<NodeLiveData> {
  const client = getPublicClient();
  const [identity, policy, allowed] = await Promise.all([
    readIdentity(client, AGENT_TOKEN_ID),
    policyCached(),
    allowlistCached(),
  ]);
  return {
    summary: `#${AGENT_TOKEN_ID} · ${truncateHash(identity?.owner ?? "0x0")} · spent ${usdc6(policy.spentToday)}`,
    rows: [
      ["registry", ADDR.registry],
      ["tokenId", AGENT_TOKEN_ID.toString()],
      ["owner (operator)", identity?.owner ?? "✗ unreadable"],
      ["tokenURI", identity?.uri ?? "✗ unreadable"],
      ["policy.perTxCap", `${usdc6(policy.perTxCap)} USDC`],
      ["policy.dailyCap", `${usdc6(policy.dailyCap)} USDC`],
      ["policy.spentToday", `${usdc6(policy.spentToday)} USDC`],
      ["allowlist", `${allowed}/2 allowed`],
    ],
  };
}

async function readPolicyNode(): Promise<NodeLiveData> {
  const [view, allowed] = await Promise.all([policyCached(), allowlistCached()]);
  return {
    summary: `perTx ${usdc6(view.perTxCap)} · daily ${usdc6(view.dailyCap)} · spent ${usdc6(view.spentToday)}`,
    rows: [
      ["address", ADDR.policy],
      ["owner", view.owner],
      ["agent", view.agent],
      ["perTxCap", `${usdc6(view.perTxCap)} USDC`],
      ["dailyCap", `${usdc6(view.dailyCap)} USDC`],
      ["spentToday", `${usdc6(view.spentToday)} USDC`],
      ["remainingToday", `${usdc6(view.dailyCap - view.spentToday)} USDC`],
      ["lastDayStart", view.lastDayStart.toString()],
      ["allowlist", `${allowed}/2 allowed`],
    ],
  };
}

async function readMcpNode(): Promise<NodeLiveData> {
  const [records, head] = await Promise.all([
    storefrontCached(),
    defaultChainHeadResolver(undefined)("arbitrum").catch(() => null),
  ]);
  const menuCell =
    records.menu === null ? "✗ unreadable" : records.menu.length > 52 ? `${records.menu.slice(0, 52)}…` : records.menu;
  return {
    summary: `${records.price ?? "✗ price"} · arb ${head !== null ? head.toLocaleString("en-US") : "✗"}`,
    rows: [
      ["name", "sla-subgraph-mcp"],
      ["menu", menuCell],
      ["ens price", records.price ?? "✗ unreadable"],
      ["sla", records.sla ?? "✗ unreadable"],
      ["arbitrum head", head !== null ? head.toLocaleString("en-US") : "✗ unreadable"],
    ],
  };
}

async function readGatewayNode(): Promise<NodeLiveData> {
  const lag = await fetchLagShared();
  return {
    summary: `ok · ${lag.rows} rows`,
    rows: [
      ["endpoint", CONFIG.pnl.endpoint],
      ["indexed block", lag.indexed.toLocaleString("en-US")],
      ["rows proxied", String(lag.rows)],
    ],
  };
}

async function readSubgraphNode(): Promise<NodeLiveData> {
  const [lag, head] = await Promise.all([fetchLagShared(), getPublicClient().getBlockNumber()]);
  const delta = Number(head) - lag.indexed;
  return {
    summary: `idx ${lag.indexed.toLocaleString("en-US")} · ${delta} behind`,
    rows: [
      ["indexed block", lag.indexed.toLocaleString("en-US")],
      ["arc head", head.toLocaleString("en-US")],
      ["lag", `${delta} block${delta === 1 ? "" : "s"}`],
      ["rows", String(lag.rows)],
    ],
    block: lag.indexed,
  };
}

async function readEscrowNode(): Promise<NodeLiveData> {
  const jobs = await fetchJobsShared();
  let settled = 0;
  let refunded = 0;
  let open = 0;
  for (const job of jobs) {
    if (job.state === "settled") settled += 1;
    else if (job.state === "refunded") refunded += 1;
    else open += 1;
  }
  const totals = scopedTotals(jobs);
  return {
    summary: `S${settled} · R${refunded} · O${open}`,
    rows: [
      ["address", ADDR.escrow],
      ["settled", `${settled} · ${usdc6(totals.revenue)} USDC revenue`],
      ["refunded", `${refunded} · ${usdc6(totals.refunds)} USDC refunds`],
      ["open", String(open)],
    ],
  };
}

async function readHookNode(): Promise<NodeLiveData> {
  const client = getPublicClient();
  const [serves, attester] = await Promise.all([
    client.readContract({ address: ADDR.hook, abi: HOOK_ABI, functionName: "escrow" }),
    client.readContract({ address: ADDR.hook, abi: HOOK_ABI, functionName: "attester" }),
  ]);
  return {
    summary: `attester ${truncateHash(attester)}`,
    rows: [
      ["address", ADDR.hook],
      ["serves escrow", serves],
      ["attester", attester],
    ],
  };
}

const READERS: Record<string, () => Promise<NodeLiveData>> = {
  ens: readEnsNode,
  agent: readAgentNode,
  policy: readPolicyNode,
  mcp: readMcpNode,
  gateway: readGatewayNode,
  subgraph: readSubgraphNode,
  escrow: readEscrowNode,
  hook: readHookNode,
};

function NodeShape({
  node,
  live,
  active,
  onSelect,
}: {
  node: (typeof NODES)[number];
  live: NodeLive;
  active: boolean;
  onSelect: () => void;
}): JSX.Element {
  const chip =
    live.state === "loading"
      ? "…"
      : live.value === null
        ? "offline"
        : live.source === "cache" || live.source === "snapshot"
          ? `${live.value.summary} · ${live.source === "cache" ? "cached" : "snapshot"}`
          : live.value.summary;
  return (
    <g
      className={`map__node ${live.state}${active ? " active" : ""}`}
      transform={`translate(${node.x}, ${node.y})`}
      role="button"
      tabIndex={0}
      aria-label={`${node.title} · ${chip}`}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <title>{live.reason ?? node.title}</title>
      <circle r={30} className="map__node-ring" />
      <text className="map__node-name" y={-44} textAnchor="middle">
        {node.title}
      </text>
      <text className={`map__node-chip ${live.state}`} y={54} textAnchor="middle">
        {chip}
      </text>
    </g>
  );
}

export function SystemMap(): JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // One poll loop per node — the chips and the drawer share the same live value.
  // Reads and poll cadences are staggered (nodeOpts) so the public Arc RPC never
  // sees all 8 nodes burst at once (it rate-limits broad bursts with 429s).
  //
  // Every node keeps its last-good payload in localStorage (`map.<id>`), so a
  // walled gateway degrades to a labeled cached chip instead of a raw upstream
  // error. The Studio-backed nodes (gateway/subgraph/escrow) additionally
  // share STUDIO_GATE: one 429 pauses them all through the cooldown instead of
  // each re-hammering the wall on its own tick.
  const nodeOptsWith = (index: number): Record<string, unknown> => ({
    ...nodeOpts(index),
    cacheKey: `map.${NODES[index].id}`,
    gateKey: index >= 4 && index <= 6 ? STUDIO_GATE : undefined,
  });
  const ensLive = useLiveValue(() => sleep(0).then(() => READERS.ens()), nodeOptsWith(0));
  const agentLive = useLiveValue(() => sleep(700).then(() => READERS.agent()), nodeOptsWith(1));
  const policyLive = useLiveValue(() => sleep(1_400).then(() => READERS.policy()), nodeOptsWith(2));
  const mcpLive = useLiveValue(() => sleep(2_100).then(() => READERS.mcp()), nodeOptsWith(3));
  const gatewayLive = useLiveValue(() => sleep(2_800).then(() => READERS.gateway()), nodeOptsWith(4));
  const subgraphLive = useLiveValue(() => sleep(3_500).then(() => READERS.subgraph()), nodeOptsWith(5));
  const escrowLive = useLiveValue(() => sleep(4_200).then(() => READERS.escrow()), nodeOptsWith(6));
  const hookLive = useLiveValue(() => sleep(4_900).then(() => READERS.hook()), nodeOptsWith(7));
  const lives: Record<string, NodeLive> = {
    ens: ensLive,
    agent: agentLive,
    policy: policyLive,
    mcp: mcpLive,
    gateway: gatewayLive,
    subgraph: subgraphLive,
    escrow: escrowLive,
    hook: hookLive,
  };

  // Edges pulse when the subgraph's indexed head advances past the last poll.
  const lastIndexed = useRef<number | null>(null);
  const [pulse, setPulse] = useState(0);
  useEffect(() => {
    const block = subgraphLive.value?.block;
    if (block !== undefined) {
      if (lastIndexed.current !== null && block !== lastIndexed.current) setPulse((p) => p + 1);
      lastIndexed.current = block;
    }
  }, [subgraphLive.value?.block]);

  const selectedNode = selectedId !== null ? NODES.find((n) => n.id === selectedId) : undefined;
  const selectedLive = selectedId !== null ? lives[selectedId] : undefined;

  return (
    <section className="map" aria-label="live system map">
      <header className="map__head">
        <span className="map__title">system map</span>
        <span className="map__hint">
          click a node for its live detail + console action · edges pulse when the subgraph indexes a new head
        </span>
      </header>
      <svg
        className="map__canvas"
        viewBox="0 0 1000 440"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="live topology of the openbook system"
      >
        <g className="map__edges" key={pulse}>
          {EDGES.map(([fromId, toId]) => {
            const from = edgeTarget(fromId);
            const to = edgeTarget(toId);
            if (!from || !to) return null;
            return (
              <line
                key={`${fromId}-${toId}`}
                className={`map__edge${pulse > 0 ? " map__edge--pulse" : ""}`}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
              />
            );
          })}
        </g>
        {NODES.map((node) => (
          <NodeShape
            key={node.id}
            node={node}
            live={lives[node.id]}
            active={selectedId === node.id}
            onSelect={() => setSelectedId(node.id)}
          />
        ))}
      </svg>
      {selectedNode !== undefined && selectedLive !== undefined && (
        <Drawer node={selectedNode} live={selectedLive} onClose={() => setSelectedId(null)} />
      )}
    </section>
  );
}
