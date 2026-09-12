import { describe, expect, it } from "bun:test";
import { EDGES, NODES } from "./nodes";
import { find } from "../console/registry";
// Side-effect: registers the inspect commands the primary actions resolve to
// (same import the Console does).
import "../console/commands/inspect";

describe("system map nodes", () => {
  it("covers exactly the 8 node ids", () => {
    expect(NODES.map((n) => n.id).sort()).toEqual(
      ["ens", "agent", "policy", "mcp", "gateway", "subgraph", "escrow", "hook"].sort(),
    );
  });

  it("every node declares at least one live source", () => {
    for (const node of NODES) {
      expect(node.sources.length, `${node.id} must declare ≥1 source`).toBeGreaterThanOrEqual(1);
    }
  });

  it("every node with a primary action resolves its command in the registry", () => {
    for (const node of NODES) {
      if (node.primaryAction === undefined) continue;
      const command = find(node.primaryAction.command);
      expect(command, `${node.id} primary action "${node.primaryAction.command}" must resolve`).toBeDefined();
    }
  });

  it("every node has a position on the canvas", () => {
    for (const node of NODES) {
      expect(Number.isFinite(node.x), `${node.id}.x`).toBe(true);
      expect(Number.isFinite(node.y), `${node.id}.y`).toBe(true);
    }
  });

  it("declares the 8 briefed edges (operator endpoint resolved to the agent node)", () => {
    expect(EDGES).toEqual([
      ["ens", "agent"],
      ["agent", "mcp"],
      ["mcp", "gateway"],
      ["gateway", "subgraph"],
      ["agent", "escrow"],
      ["escrow", "hook"],
      ["escrow", "policy"],
      ["policy", "operator"],
    ]);
    const ids: Record<string, true> = {
      ens: true,
      agent: true,
      policy: true,
      mcp: true,
      gateway: true,
      subgraph: true,
      escrow: true,
      hook: true,
    };
    for (const [from, to] of EDGES) {
      expect(ids[from], `edge from ${from}`).toBe(true);
      expect(to === "operator" || ids[to] === true, `edge to ${to}`).toBe(true);
    }
  });
});
