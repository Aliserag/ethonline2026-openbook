/**
 * The pay-per-call lane: the same delivery as /api/deliver, sold through Circle
 * Gateway Nanopayments (x402). An agent pays the dataset's live ENS price per
 * query, gaslessly, from any Gateway-supported network; the seller is the same
 * Circle wallet the escrow lane pays. No recourse on this lane: that is what the
 * escrow lane is for, and the buyer picks which one it wants.
 *
 *   POST /api/x402/query   body {datasetId, query}; 402 with payment requirements
 *                          until a PAYMENT-SIGNATURE header settles the price
 *   POST /api/x402/status  the lane's terms, no payment
 *
 * Node runtime only (Vercel functions): the Gateway middleware works on plain
 * IncomingMessage / ServerResponse.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createGatewayMiddleware } from "@circle-fin/x402-batching/server";
import { deliver, parseDeliverRequest } from "./shared";
import { resolveSellerTerms } from "./circle";
import openbook from "../../mcp/config/openbook.json";

export const GATEWAY_FACILITATOR_TESTNET = "https://gateway-api-testnet.circle.com";
export const ARC_TESTNET_CAIP2 = "eip155:5042002";

const DATASETS = (openbook as { datasets: { id: string; subgraphId: string; schema: string; chain: string }[] }).datasets;

export interface X402Env {
  sellerAddress: string;
  gatewayKey: string;
  attesterPk: string;
  sepoliaRpc?: string;
}

type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => unknown;
let middlewareCache: { seller: string; gateway: { require: (price: string) => Middleware } } | null = null;

function gatewayFor(sellerAddress: string): { require: (price: string) => Middleware } {
  if (middlewareCache && middlewareCache.seller === sellerAddress) return middlewareCache.gateway;
  const gateway = createGatewayMiddleware({ sellerAddress, facilitatorUrl: GATEWAY_FACILITATOR_TESTNET }) as unknown as { require: (price: string) => Middleware };
  middlewareCache = { seller: sellerAddress, gateway };
  return gateway;
}

/** "$0.10" from a 6-decimal amount, the format the middleware prices in. */
export function priceLabel(amount6dec: number): string {
  return `$${(amount6dec / 1_000_000).toFixed(6).replace(/0+$/, "").replace(/\.$/, ".0")}`;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage & { body?: unknown }): Promise<unknown> {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return null;
    }
  }
  const text = await new Promise<string>((resolve) => {
    let data = "";
    req.on("data", (c: Buffer | string) => (data += c));
    req.on("end", () => resolve(data));
  });
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The lane's terms: every dataset with its live ENS price, so an agent can decide before paying. */
export async function x402Status(env: X402Env): Promise<unknown> {
  const datasets = await Promise.all(
    DATASETS.map(async (d) => {
      try {
        const terms = await resolveSellerTerms(d.id, env.sepoliaRpc);
        return { id: d.id, schema: d.schema, chain: d.chain, price: priceLabel(terms.amount6dec), pricedBy: terms.name, payee: terms.payee };
      } catch (error) {
        return { id: d.id, schema: d.schema, chain: d.chain, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
  return {
    lane: "x402",
    settlement: "Circle Gateway Nanopayments, gasless, no recourse (use the escrow lane for a refundable purchase)",
    facilitator: GATEWAY_FACILITATOR_TESTNET,
    network: ARC_TESTNET_CAIP2,
    seller: env.sellerAddress,
    how: 'POST /api/x402/query {"datasetId","query"}; pay the 402 with `circle services pay <url> -X POST -d <body> --address <agent wallet> --chain ARC-TESTNET`',
    datasets,
  };
}

/** Price the request from ENS, gate it with Gateway Nanopayments, deliver on payment. */
export async function x402Query(req: IncomingMessage & { body?: unknown }, res: ServerResponse, env: X402Env): Promise<void> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(env.sellerAddress)) {
    send(res, 503, { error: "the x402 lane is not configured on this deployment (no seller wallet)" });
    return;
  }
  const body = await readBody(req);
  const r = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const dataset = DATASETS.find((d) => d.id === r.datasetId);
  if (!dataset) {
    send(res, 400, { error: "datasetId is not one of the datasets this deployment sells", datasets: DATASETS.map((d) => d.id) });
    return;
  }
  const parsed = parseDeliverRequest({ subgraphId: dataset.subgraphId, query: r.query });
  if (typeof parsed === "string") {
    send(res, 400, { error: parsed });
    return;
  }
  let terms;
  try {
    terms = await resolveSellerTerms(dataset.id, env.sepoliaRpc);
  } catch (error) {
    send(res, 424, { error: error instanceof Error ? error.message : String(error) });
    return;
  }
  if (terms.payee.toLowerCase() !== env.sellerAddress.toLowerCase()) {
    send(res, 424, { error: `${terms.name} names ${terms.payee} as svc.payee, which this deployment does not sell for` });
    return;
  }
  // the middleware answers 402 (with the price) itself when no valid payment is attached
  const paid = await new Promise<boolean>((resolve) => {
    let called = false;
    const next = () => {
      called = true;
      resolve(true);
    };
    Promise.resolve(gatewayFor(env.sellerAddress).require(priceLabel(terms.amount6dec))(req, res, next)).then(
      () => {
        if (!called) resolve(false);
      },
      (error: unknown) => {
        if (!res.writableEnded) send(res, 424, { error: `payment check failed: ${error instanceof Error ? error.message : String(error)}` });
        resolve(false);
      },
    );
  });
  if (!paid) return;
  const payment = (req as IncomingMessage & { payment?: { payer: string; amount: string; network: string; transaction?: string } }).payment;
  const out = await deliver(parsed, env.gatewayKey, env.attesterPk);
  if (!out.ok) {
    send(res, out.status, { error: out.error, payment });
    return;
  }
  send(res, 200, {
    lane: "x402",
    datasetId: dataset.id,
    pricedBy: terms.name,
    price: priceLabel(terms.amount6dec),
    payment,
    data: out.data,
    payloadHash: out.payloadHash,
    metaBlock: out.metaBlock,
    attester: out.attester,
    proof: out.proof,
  });
}
