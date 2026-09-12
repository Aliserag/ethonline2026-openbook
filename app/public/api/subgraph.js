// Vercel Node function (zero config when `dist` is the deploy root). Same
// contract as app/public/_worker.js: the POST body is forwarded to Studio and
// the answer is cached 20 s in memory per warm instance.
const UPSTREAM = "https://api.studio.thegraph.com/query/1760032/open-book/version/latest";
const TTL_MS = 20_000;
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
    res.statusCode = 405;
    res.end(JSON.stringify({ error: "POST only" }));
    return;
  }
  const body =
    typeof req.body === "string" ? req.body : req.body ? JSON.stringify(req.body) : await readBody(req);
  const now = Date.now();
  const hit = cache.get(body);
  if (hit && now - hit.at < TTL_MS) {
    res.setHeader("x-openbook-cache", "HIT");
    res.statusCode = hit.status;
    res.end(hit.text);
    return;
  }
  let upstream;
  try {
    upstream = await fetch(UPSTREAM, { method: "POST", headers: { "content-type": "application/json" }, body });
  } catch (error) {
    res.statusCode = 502;
    res.end(JSON.stringify({ error: `upstream unreachable: ${String(error)}` }));
    return;
  }
  const text = await upstream.text();
  if (upstream.ok) cache.set(body, { at: now, status: upstream.status, text });
  res.setHeader("x-openbook-cache", "MISS");
  res.statusCode = upstream.status;
  res.end(text);
};
