import type { IncomingMessage, ServerResponse } from "node:http";
import { x402Query } from "../../x402";
export default (req: IncomingMessage, res: ServerResponse) =>
  x402Query(req, res, {
    sellerAddress: process.env.CIRCLE_SELLER_WALLET_ADDRESS ?? "",
    gatewayKey: process.env.GRAPH_GATEWAY_KEY ?? "",
    attesterPk: process.env.OPENBOOK_ATTESTER_PK ?? "",
    sepoliaRpc: process.env.SEPOLIA_RPC || undefined,
  });
