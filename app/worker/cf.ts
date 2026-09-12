/**
 * Cloudflare Pages advanced-mode worker (bundled to app/public/_worker.js by
 * `bun run build:worker`). Routes:
 *   POST /api/subgraph   cached proxy to the open-book Studio endpoint (20 s fresh,
 *                        last good copy served on 429 for up to 30 min)
 *   POST /api/query      The Graph Gateway with the server-held key
 *   POST /api/attest     the SlaHook attester (server-held key, onchain checks)
 * Everything else is served from the static assets.
 */
import { STUDIO_UPSTREAM, attest, gatewayProxy, parseAttestRequest, parseGatewayRequest } from "./shared";

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  OPENBOOK_ATTESTER_PK?: string;
  GRAPH_GATEWAY_KEY?: string;
}

const FRESH_SECONDS = 20;
const KEEP_SECONDS = 1800;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

function json(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS, ...extra },
  });
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function withCacheHeader(response: Response, label: string): Response {
  const headers = new Headers(response.headers);
  headers.set("x-openbook-cache", label);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(response.body, { status: response.status, headers });
}

async function subgraph(request: Request, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
  const body = await request.text();
  const key = new Request(`https://cache.openbook/subgraph/${await sha256Hex(body)}`, { method: "GET" });
  const cache = (caches as unknown as { default: Cache }).default;
  const cached = await cache.match(key);
  if (cached) {
    const storedAt = Number(cached.headers.get("x-openbook-at") ?? 0);
    if (Date.now() - storedAt < FRESH_SECONDS * 1000) return withCacheHeader(cached, "HIT");
  }
  let upstream: Response;
  try {
    upstream = await fetch(STUDIO_UPSTREAM, { method: "POST", headers: { "content-type": "application/json" }, body });
  } catch (error) {
    if (cached) return withCacheHeader(cached, "STALE");
    return json({ error: `upstream unreachable: ${String(error)}` }, 502);
  }
  if (!upstream.ok) {
    if (cached) return withCacheHeader(cached, "STALE");
    return withCacheHeader(upstream, "MISS");
  }
  const text = await upstream.text();
  const response = new Response(text, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-openbook-cache": "MISS",
      "x-openbook-at": String(Date.now()),
      "cache-control": `public, max-age=${KEEP_SECONDS}`,
      ...CORS,
    },
  });
  ctx.waitUntil(cache.put(key, response.clone()));
  return response;
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    if (url.pathname === "/api/subgraph") return subgraph(request, ctx);
    if (url.pathname === "/api/query") {
      const parsed = parseGatewayRequest(await readJson(request));
      if (typeof parsed === "string") return json({ error: parsed }, 400);
      const out = await gatewayProxy(parsed, env.GRAPH_GATEWAY_KEY ?? "");
      return new Response(out.text, { status: out.status, headers: { "content-type": "application/json", ...CORS } });
    }
    if (url.pathname === "/api/attest") {
      const parsed = parseAttestRequest(await readJson(request));
      if (typeof parsed === "string") return json({ error: parsed }, 400);
      try {
        const out = await attest(parsed, env.OPENBOOK_ATTESTER_PK ?? "");
        return out.ok ? json(out, 200) : json({ error: out.error }, out.status);
      } catch (error) {
        return json({ error: `attest failed: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}` }, 502);
      }
    }
    return json({ error: "not found" }, 404);
  },
};
