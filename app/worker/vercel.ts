/**
 * Vercel Node functions (bundled to app/public/api/*.mjs by `bun run build:worker`).
 * One handler serves all three routes; each api/*.mjs re-exports it. Same contract as
 * the Cloudflare worker; the subgraph cache is in memory per warm instance.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { STUDIO_UPSTREAM, attest, gatewayProxy, parseAttestRequest, parseGatewayRequest } from "./shared";

const FRESH_MS = 20_000;
const KEEP_MS = 1_800_000;
const cache = new Map<string, { at: number; text: string }>();

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk: Buffer | string) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
  });
}

function send(res: ServerResponse, status: number, text: string, extra: Record<string, string> = {}): void {
  for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
  res.statusCode = status;
  res.end(text);
}

async function bodyOf(req: IncomingMessage & { body?: unknown }): Promise<string> {
  if (typeof req.body === "string") return req.body;
  if (req.body && typeof req.body === "object") return JSON.stringify(req.body);
  return readBody(req);
}

export async function handler(route: "subgraph" | "query" | "attest", req: IncomingMessage & { body?: unknown }, res: ServerResponse): Promise<void> {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("content-type", "application/json");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "POST") {
    send(res, 405, JSON.stringify({ error: "POST only" }));
    return;
  }
  const body = await bodyOf(req);

  if (route === "subgraph") {
    const now = Date.now();
    const hit = cache.get(body);
    if (hit && now - hit.at < FRESH_MS) {
      send(res, 200, hit.text, { "x-openbook-cache": "HIT" });
      return;
    }
    let upstream: Response;
    try {
      upstream = await fetch(STUDIO_UPSTREAM, { method: "POST", headers: { "content-type": "application/json" }, body });
    } catch (error) {
      if (hit && now - hit.at < KEEP_MS) send(res, 200, hit.text, { "x-openbook-cache": "STALE" });
      else send(res, 502, JSON.stringify({ error: `upstream unreachable: ${String(error)}` }), { "x-openbook-cache": "MISS" });
      return;
    }
    const text = await upstream.text();
    if (!upstream.ok) {
      if (hit && now - hit.at < KEEP_MS) send(res, 200, hit.text, { "x-openbook-cache": "STALE" });
      else send(res, upstream.status, text, { "x-openbook-cache": "MISS" });
      return;
    }
    cache.set(body, { at: now, text });
    send(res, 200, text, { "x-openbook-cache": "MISS" });
    return;
  }

  let parsedBody: unknown = null;
  try {
    parsedBody = JSON.parse(body);
  } catch {
    parsedBody = null;
  }

  if (route === "query") {
    const parsed = parseGatewayRequest(parsedBody);
    if (typeof parsed === "string") {
      send(res, 400, JSON.stringify({ error: parsed }));
      return;
    }
    const out = await gatewayProxy(parsed, process.env.GRAPH_GATEWAY_KEY ?? "");
    send(res, out.status, out.text);
    return;
  }

  const parsed = parseAttestRequest(parsedBody);
  if (typeof parsed === "string") {
    send(res, 400, JSON.stringify({ error: parsed }));
    return;
  }
  try {
    const out = await attest(parsed, process.env.OPENBOOK_ATTESTER_PK ?? "");
    if (out.ok) send(res, 200, JSON.stringify(out));
    else send(res, out.status, JSON.stringify({ error: out.error }));
  } catch (error) {
    send(res, 502, JSON.stringify({ error: `attest failed: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}` }));
  }
}
