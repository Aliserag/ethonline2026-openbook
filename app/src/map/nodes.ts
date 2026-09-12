/**
 * Live system map contract (T11): the 8 nodes and edges of the OpenBook system
 * the canvas renders. Node ids are pinned by the test — exactly
 * ens/agent/policy/mcp/gateway/subgraph/escrow/hook. Every node declares ≥1
 * live source (shown as chips via useLiveValue) and, when actable, a
 * `primaryAction.command` that must resolve through the console registry's
 * `find` (the test asserts this) so the Drawer can dispatch it with zero
 * duplicate logic.
 *
 * The `policy → operator` edge is drawn to the AGENT node: the ERC-8004 owner
 * (0x64A78b6d…) IS the PolicyWallet's agent (operator) — `edgeTarget` resolves
 * the alias so the canvas only ever draws to defined node positions.
 */
import type { Live } from "../data/types";

export interface MapNode {
  id: string;
  title: string;
  x: number;
  y: number;
  /** human labels of the live feeds shown as chips on the node */
  sources: string[];
  primaryAction?: { label: string; command: string };
}

/** The live read every node chip (summary) and drawer (rows) consume. */
export interface NodeLiveData {
  /** one-line value for the node chip */
  summary: string;
  /** detailed rows for the node drawer */
  rows: [string, string][];
  /** optional numeric sentinel for edge pulsing (subgraph indexed head) */
  block?: number;
}

export type NodeLive = Live<NodeLiveData> & { refresh(): void };

/** ViewBox coordinates (1000 × 440): five sources up top, three services below. */
export const NODES: MapNode[] = [
  {
    id: "ens",
    title: "ENS storefront",
    x: 90,
    y: 110,
    sources: ["sepolia ENSv2 · svc.price/sla/payee"],
    primaryAction: { label: "show storefront records", command: "ens show" },
  },
  {
    id: "agent",
    title: "agent · ERC-8004",
    x: 280,
    y: 110,
    sources: ["registry identity (tokenId 894065)", "PolicyWallet caps/spend"],
    primaryAction: { label: "system status", command: "status" },
  },
  {
    id: "mcp",
    title: "sla-subgraph-mcp",
    x: 470,
    y: 110,
    sources: ["ENS menu + price", "arbitrum chain head"],
    primaryAction: { label: "list datasets", command: "datasets" },
  },
  {
    id: "gateway",
    title: "graph gateway",
    x: 660,
    y: 110,
    sources: ["studio P&L endpoint"],
    primaryAction: { label: "system status", command: "status" },
  },
  {
    id: "subgraph",
    title: "open-book subgraph",
    x: 850,
    y: 110,
    sources: ["_meta.block vs arc head"],
    primaryAction: { label: "indexing lag", command: "lag" },
  },
  {
    id: "escrow",
    title: "escrow · ERC-8183",
    x: 470,
    y: 330,
    sources: ["scoped jobs by state"],
    primaryAction: { label: "scoped jobs", command: "jobs" },
  },
  {
    id: "hook",
    title: "sla hook",
    x: 660,
    y: 330,
    sources: ["hook escrow/attester (onchain)"],
    primaryAction: { label: "replay the cited refund", command: "replay 185853" },
  },
  {
    id: "policy",
    title: "policy wallet",
    x: 280,
    y: 330,
    sources: ["PolicyWallet caps/spend/allowlist"],
    primaryAction: { label: "show caps & spend", command: "policy show" },
  },
];

/** Directed edges — verbatim from the brief. */
export const EDGES: Array<[string, string]> = [
  ["ens", "agent"],
  ["agent", "mcp"],
  ["mcp", "gateway"],
  ["gateway", "subgraph"],
  ["agent", "escrow"],
  ["escrow", "hook"],
  ["escrow", "policy"],
  ["policy", "operator"],
];

/** Resolve an edge endpoint to a drawn node; "operator" is the agent node's operator. */
export function edgeTarget(id: string): MapNode | undefined {
  if (id === "operator") return NODES.find((n) => n.id === "agent");
  return NODES.find((n) => n.id === id);
}
