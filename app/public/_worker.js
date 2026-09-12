// Cloudflare Pages advanced-mode worker. /api/subgraph is a 20 s cached proxy
// to the open-book Studio endpoint; everything else is served from the static
// assets. Judges' browsers share one upstream call per query per 20 s instead
// of each hitting Studio and getting HTTP 429.
const UPSTREAM = "https://api.studio.thegraph.com/query/1760032/open-book/version/latest";
const TTL_SECONDS = 20;

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

async function proxy(request, ctx) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  const body = await request.text();
  const key = new Request(`https://cache.openbook/subgraph/${await sha256Hex(body)}`, { method: "GET" });
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) {
    const headers = new Headers(hit.headers);
    headers.set("x-openbook-cache", "HIT");
    return new Response(hit.body, { status: hit.status, headers });
  }
  let upstream;
  try {
    upstream = await fetch(UPSTREAM, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  } catch (error) {
    return json({ error: `upstream unreachable: ${String(error)}` }, 502);
  }
  const text = await upstream.text();
  const headers = {
    "content-type": "application/json",
    "x-openbook-cache": "MISS",
    "cache-control": `public, max-age=${TTL_SECONDS}`,
    ...corsHeaders(),
  };
  const response = new Response(text, { status: upstream.status, headers });
  if (upstream.ok) ctx.waitUntil(cache.put(key, response.clone()));
  return response;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/subgraph") return proxy(request, ctx);
    return env.ASSETS.fetch(request);
  },
};
