/**
 * Client for The Graph's official Subgraph MCP (subgraphs.mcp.thegraph.com), used
 * by `discover_datasets`: our tooling layers on The Graph's AI Suite instead of
 * re-implementing catalog search. Auth is the same Studio/Gateway key.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

export const SUBGRAPH_MCP_URL = "https://subgraphs.mcp.thegraph.com/sse";

export interface SubgraphCandidate {
  subgraphId: string;
  name: string;
  ipfsHash: string | null;
}

export type SubgraphSearch = (keyword: string) => Promise<SubgraphCandidate[]>;

/** Parse the text payload of `search_subgraphs_by_keyword` into candidates. */
export function parseSearchResult(raw: unknown): SubgraphCandidate[] {
  const content = (raw as { content?: { type?: string; text?: string }[] })?.content ?? [];
  const text = content.find((c) => c.type === "text")?.text ?? "";
  let parsed: { subgraphs?: unknown[] };
  try {
    parsed = JSON.parse(text) as { subgraphs?: unknown[] };
  } catch {
    return [];
  }
  const out: SubgraphCandidate[] = [];
  for (const s of parsed.subgraphs ?? []) {
    const r = s as { id?: unknown; metadata?: { displayName?: unknown }; currentVersion?: { subgraphDeployment?: { ipfsHash?: unknown } } };
    if (typeof r.id !== "string") continue;
    out.push({
      subgraphId: r.id,
      name: typeof r.metadata?.displayName === "string" ? r.metadata.displayName : r.id,
      ipfsHash: typeof r.currentVersion?.subgraphDeployment?.ipfsHash === "string" ? r.currentVersion.subgraphDeployment.ipfsHash : null,
    });
  }
  return out;
}

/** Live search through the official Subgraph MCP over SSE. */
export function createSubgraphSearch(gatewayKey: string, url: string = SUBGRAPH_MCP_URL): SubgraphSearch {
  return async (keyword) => {
    const headers = { Authorization: `Bearer ${gatewayKey}` };
    const transport = new SSEClientTransport(new URL(url), {
      requestInit: { headers },
      eventSourceInit: {
        fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), ...headers } }),
      } as unknown as EventSourceInit,
    });
    const client = new Client({ name: "sla-subgraph-mcp", version: "0.1.0" });
    await client.connect(transport);
    try {
      const result = await client.callTool({ name: "search_subgraphs_by_keyword", arguments: { keyword } });
      return parseSearchResult(result);
    } finally {
      await client.close();
    }
  };
}
