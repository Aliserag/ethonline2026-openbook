/**
 * App-side directory reader (W3): thin re-export of the marketplace
 * directory from mcp/src so every surface (CLI, MCP, app) reads the same
 * live-ENS seller list. See ../../../mcp/src/directory.ts for the mechanism.
 */
export {
  listSellers,
  sellersForSchema,
  type MenuEntry,
  type SellerRef,
} from "../../../mcp/src/directory";
