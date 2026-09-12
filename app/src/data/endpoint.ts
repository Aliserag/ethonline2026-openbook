/**
 * Where the app reads the open-book subgraph from. Deployed origins go through
 * the same-origin cached proxy (/api/subgraph, see app/public/_worker.js and
 * app/public/api/subgraph.js) so every judge shares one upstream call per 20 s
 * instead of each browser hitting Studio and getting HTTP 429. Local dev and
 * tests read Studio directly.
 */
import { hostedQuery, type FetchLike, type GatewayMeta } from "../../../mcp/src/gateway";
import { CONFIG } from "../config";

export const STUDIO_ENDPOINT: string = CONFIG.pnl.endpoint.replace("{GRAPH_GATEWAY_KEY}", "");

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function envOverrideDefault(): string | undefined {
  const raw = (import.meta.env?.VITE_SUBGRAPH_ENDPOINT as string | undefined) ?? "";
  return raw.length > 0 ? raw : undefined;
}

function locationDefault(): { hostname: string; origin: string } | undefined {
  return typeof location !== "undefined" ? { hostname: location.hostname, origin: location.origin } : undefined;
}

export function subgraphEndpoint(
  loc: { hostname: string; origin: string } | undefined = locationDefault(),
  envOverride: string | undefined = envOverrideDefault(),
): string {
  if (envOverride) return envOverride;
  if (loc === undefined || LOCAL_HOSTS.has(loc.hostname)) return STUDIO_ENDPOINT;
  return `${loc.origin}/api/subgraph`;
}

let proxyDead = false;

/** Test seam: forget a dead-proxy verdict. */
export function resetProxyState(): void {
  proxyDead = false;
}

/**
 * hostedQuery through the resolved endpoint. A proxy that is missing or broken
 * (404 / 5xx) falls back to Studio for the rest of the session; a 429 is the
 * upstream wall and is surfaced as-is so the callers' backoff applies.
 */
export async function hostedQueryViaProxy(
  query: string,
  fetchImpl?: FetchLike,
): Promise<{ data: unknown; meta: GatewayMeta }> {
  const url = proxyDead ? STUDIO_ENDPOINT : subgraphEndpoint();
  if (url === STUDIO_ENDPOINT) return hostedQuery({ url, query, fetchImpl });
  try {
    return await hostedQuery({ url, query, fetchImpl });
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 404 || (status !== undefined && status >= 500)) {
      proxyDead = true;
      return hostedQuery({ url: STUDIO_ENDPOINT, query, fetchImpl });
    }
    throw error;
  }
}
