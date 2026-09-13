import type { IncomingMessage, ServerResponse } from "node:http";
import { x402Status } from "../../x402";
export default async (_req: IncomingMessage, res: ServerResponse) => {
  const body = await x402Status({
    sellerAddress: process.env.CIRCLE_SELLER_WALLET_ADDRESS ?? "",
    gatewayKey: process.env.GRAPH_GATEWAY_KEY ?? "",
    attesterPk: process.env.OPENBOOK_ATTESTER_PK ?? "",
    sepoliaRpc: process.env.SEPOLIA_RPC || undefined,
  });
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.setHeader("access-control-allow-origin", "*");
  res.end(JSON.stringify(body));
};
