/**
 * Cloudflare Pages advanced-mode worker (bundled to app/public/_worker.js by
 * `bun run build:worker`). Routes:
 *   POST /api/subgraph   cached proxy to the open-book Studio endpoint (20 s fresh,
 *                        last good copy served on 429 for up to 30 min)
 *   POST /api/deliver    a dataset query on the Gateway with the server-held key;
 *                        returns the payload, its hash, the indexed block and the
 *                        server's signature over that observation
 *   POST /api/attest     the SlaHook attester (server-held key; onchain checks and
 *                        the deliver signature are required)
 *   POST /api/ask/chat/completions   the console's LLM, key held here
 *   POST /api/sepolia    JSON-RPC proxy to the configured Sepolia RPC (ENS reads)
 * Everything else is served from the static assets. No secret ever reaches the
 * browser: keys are Pages secrets (wrangler pages secret put).
 */
import { LLM_BASE_DEFAULT, LLM_MODEL_DEFAULT, STUDIO_UPSTREAM, ask, attest, deliver, parseAttestRequest, parseDeliverRequest, sepoliaRpc } from "./shared";

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  OPENBOOK_ATTESTER_PK?: string;
  GRAPH_GATEWAY_KEY?: string;
  LLM_API_KEY?: string;
  LLM_BASE_URL?: string;
  LLM_MODEL?: string;
  SEPOLIA_RPC?: string;
}

const FRESH_SECONDS = 20;
const KEEP_SECONDS = 1800;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...CORS } });
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The client always sees a 20 s max-age; the stored copy keeps its own 30 min TTL. */
function clientResponse(response: Response, label: string): Response {
  const headers = new Headers(response.headers);
  headers.set("x-openbook-cache", label);
  headers.set("cache-control", `public, max-age=${FRESH_SECONDS}`);
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
    if (Date.now() - storedAt < FRESH_SECONDS * 1000) return clientResponse(cached, "HIT");
  }
  let upstream: Response;
  try {
    upstream = await fetch(STUDIO_UPSTREAM, { method: "POST", headers: { "content-type": "application/json" }, body });
  } catch (error) {
    if (cached) return clientResponse(cached, "STALE");
    return json({ error: `upstream unreachable: ${String(error)}` }, 502);
  }
  if (!upstream.ok) {
    if (cached) return clientResponse(cached, "STALE");
    return clientResponse(upstream, "MISS");
  }
  const text = await upstream.text();
  const stored = new Response(text, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-openbook-at": String(Date.now()),
      "cache-control": `public, max-age=${KEEP_SECONDS}`,
    },
  });
  ctx.waitUntil(cache.put(key, stored.clone()));
  return clientResponse(stored, "MISS");
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
    try {
      if (url.pathname === "/api/subgraph") return await subgraph(request, ctx);
      if (url.pathname === "/api/deliver") {
        const parsed = parseDeliverRequest(await readJson(request));
        if (typeof parsed === "string") return json({ error: parsed }, 400);
        const out = await deliver(parsed, env.GRAPH_GATEWAY_KEY ?? "", env.OPENBOOK_ATTESTER_PK ?? "");
        return out.ok ? json(out, 200) : json({ error: out.error }, out.status);
      }
      if (url.pathname === "/api/attest") {
        const parsed = parseAttestRequest(await readJson(request));
        if (typeof parsed === "string") return json({ error: parsed }, 400);
        const out = await attest(parsed, env.OPENBOOK_ATTESTER_PK ?? "");
        return out.ok ? json(out, 200) : json({ error: out.error }, out.status);
      }
      if (url.pathname === "/api/sepolia") {
        const out = await sepoliaRpc(await request.text(), env.SEPOLIA_RPC ?? "");
        return new Response(out.text, { status: out.status, headers: { "content-type": "application/json", ...CORS } });
      }
      if (url.pathname === "/api/ask/chat/completions") {
        const out = await ask(await request.text(), {
          key: env.LLM_API_KEY ?? "",
          baseUrl: env.LLM_BASE_URL ?? LLM_BASE_DEFAULT,
          model: env.LLM_MODEL ?? LLM_MODEL_DEFAULT,
        });
        return new Response(out.text, { status: out.status, headers: { "content-type": "application/json", ...CORS } });
      }
    } catch (error) {
      return json({ error: `server error: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}` }, 502);
    }
    return json({ error: "not found" }, 404);
  },
};
