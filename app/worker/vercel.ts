/**
 * Vercel Node functions (bundled to app/public/api/*.mjs by `bun run build:worker`).
 * One handler serves every route; each api/*.mjs re-exports it. Same contract as
 * the Cloudflare worker; the subgraph cache is in memory per warm instance.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { LLM_BASE_DEFAULT, LLM_MODEL_DEFAULT, STUDIO_UPSTREAM, ask, attest, deliver, parseAttestRequest, parseDeliverRequest, sepoliaRpc } from "./shared";

export type Route = "subgraph" | "deliver" | "attest" | "ask" | "sepolia";

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

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function handler(route: Route, req: IncomingMessage & { body?: unknown }, res: ServerResponse): Promise<void> {
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
  try {
    if (route === "subgraph") {
      const now = Date.now();
      const hit = cache.get(body);
      if (hit && now - hit.at < FRESH_MS) {
        send(res, 200, hit.text, { "x-openbook-cache": "HIT", "cache-control": "public, max-age=20" });
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
      send(res, 200, text, { "x-openbook-cache": "MISS", "cache-control": "public, max-age=20" });
      return;
    }
    if (route === "deliver") {
      const parsed = parseDeliverRequest(parseJson(body));
      if (typeof parsed === "string") {
        send(res, 400, JSON.stringify({ error: parsed }));
        return;
      }
      const out = await deliver(parsed, process.env.GRAPH_GATEWAY_KEY ?? "", process.env.OPENBOOK_ATTESTER_PK ?? "");
      if (out.ok) send(res, 200, JSON.stringify(out));
      else send(res, out.status, JSON.stringify({ error: out.error }));
      return;
    }
    if (route === "attest") {
      const parsed = parseAttestRequest(parseJson(body));
      if (typeof parsed === "string") {
        send(res, 400, JSON.stringify({ error: parsed }));
        return;
      }
      const out = await attest(parsed, process.env.OPENBOOK_ATTESTER_PK ?? "");
      if (out.ok) send(res, 200, JSON.stringify(out));
      else send(res, out.status, JSON.stringify({ error: out.error }));
      return;
    }
    if (route === "sepolia") {
      const out = await sepoliaRpc(body, process.env.SEPOLIA_RPC ?? "");
      send(res, out.status, out.text);
      return;
    }
    const out = await ask(body, {
      key: process.env.LLM_API_KEY ?? "",
      baseUrl: process.env.LLM_BASE_URL ?? LLM_BASE_DEFAULT,
      model: process.env.LLM_MODEL ?? LLM_MODEL_DEFAULT,
    });
    send(res, out.status, out.text);
  } catch (error) {
    send(res, 502, JSON.stringify({ error: `server error: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}` }));
  }
}
