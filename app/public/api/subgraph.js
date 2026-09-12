// Vercel Node function (zero config when `dist` is the deploy root). Same
// contract as app/public/_worker.js: the POST body is forwarded to Studio,
// fresh answers are cached 20 s per warm instance, and when Studio answers
// 429 the last good copy is served (labeled STALE) for up to 30 minutes.
const UPSTREAM = "https://api.studio.thegraph.com/query/1760032/open-book/v0.0.5";
const FRESH_MS = 20_000;
const KEEP_MS = 1_800_000;
const cache = new Map();

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
  });
}

function send(res, status, label, text) {
  res.setHeader("x-openbook-cache", label);
  res.statusCode = status;
  res.end(text);
}

module.exports = async (req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  res.setHeader("content-type", "application/json");
  if (req.method !== "POST") {
    send(res, 405, "MISS", JSON.stringify({ error: "POST only" }));
    return;
  }
  const body =
    typeof req.body === "string" ? req.body : req.body ? JSON.stringify(req.body) : await readBody(req);
  const now = Date.now();
  const hit = cache.get(body);
  if (hit && now - hit.at < FRESH_MS) {
    send(res, 200, "HIT", hit.text);
    return;
  }
  let upstream;
  try {
    upstream = await fetch(UPSTREAM, { method: "POST", headers: { "content-type": "application/json" }, body });
  } catch (error) {
    if (hit && now - hit.at < KEEP_MS) {
      send(res, 200, "STALE", hit.text);
      return;
    }
    send(res, 502, "MISS", JSON.stringify({ error: `upstream unreachable: ${String(error)}` }));
    return;
  }
  const text = await upstream.text();
  if (!upstream.ok) {
    if (hit && now - hit.at < KEEP_MS) {
      send(res, 200, "STALE", hit.text);
      return;
    }
    send(res, upstream.status, "MISS", text);
    return;
  }
  cache.set(body, { at: now, text });
  send(res, 200, "MISS", text);
};
