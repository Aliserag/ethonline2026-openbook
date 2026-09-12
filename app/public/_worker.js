// Cloudflare Pages advanced-mode worker. /api/subgraph is a cached proxy to
// the open-book Studio endpoint; everything else is served from the static
// assets. Judges' browsers share one upstream call per query per 20 s instead
// of each hitting Studio, and when Studio answers 429 the last good copy is
// served (labeled STALE) for up to 30 minutes so the page never goes dark.
const UPSTREAM = "https://api.studio.thegraph.com/query/1760032/open-book/v0.0.6";
const FRESH_SECONDS = 20;
const KEEP_SECONDS = 1800;

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders() },
  });
}

function withCacheHeader(response, label) {
  const headers = new Headers(response.headers);
  headers.set("x-openbook-cache", label);
  for (const [k, v] of Object.entries(corsHeaders())) headers.set(k, v);
  return new Response(response.body, { status: response.status, headers });
}

async function proxy(request, ctx) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  const body = await request.text();
  const key = new Request(`https://cache.openbook/subgraph/${await sha256Hex(body)}`, { method: "GET" });
  const cache = caches.default;
  const cached = await cache.match(key);
  if (cached) {
    const storedAt = Number(cached.headers.get("x-openbook-at") ?? 0);
    if (Date.now() - storedAt < FRESH_SECONDS * 1000) return withCacheHeader(cached, "HIT");
  }
  let upstream;
  try {
    upstream = await fetch(UPSTREAM, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  } catch (error) {
    if (cached) return withCacheHeader(cached, "STALE");
    return json({ error: `upstream unreachable: ${String(error)}` }, 502);
  }
  if (!upstream.ok) {
    if (cached) return withCacheHeader(cached, "STALE");
    return withCacheHeader(upstream, "MISS");
  }
  const text = await upstream.text();
  const headers = {
    "content-type": "application/json",
    "x-openbook-cache": "MISS",
    "x-openbook-at": String(Date.now()),
    "cache-control": `public, max-age=${KEEP_SECONDS}`,
    ...corsHeaders(),
  };
  const response = new Response(text, { status: 200, headers });
  ctx.waitUntil(cache.put(key, response.clone()));
  return response;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/subgraph") return proxy(request, ctx);
    return env.ASSETS.fetch(request);
  },
};
