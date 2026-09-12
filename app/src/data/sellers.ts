/** Operator address → ENS seller name, from the live market directory. The
 *  demo wallet plays both sides of a keyless run (single-key operation), so
 *  its jobs are labeled as such rather than shown as a bare address. */
import type { MarketView } from "../components/Market";
import { demoAddress } from "./chain";

export const DEMO_SELLER_LABEL = "our demo wallet (buyer and seller)";

export function sellerNameMap(view: MarketView | null): Record<string, string> {
  const map: Record<string, string> = {};
  const demo = demoAddress();
  if (demo) map[demo.toLowerCase()] = DEMO_SELLER_LABEL;
  // earlier demo wallets (comma-separated in VITE_DEMO_BUYER_ADDRESS) keep the same label
  for (const a of ((import.meta.env?.VITE_DEMO_BUYER_ADDRESS as string | undefined) ?? "").split(",")) {
    if (/^0x[0-9a-fA-F]{40}$/.test(a.trim())) map[a.trim().toLowerCase()] = DEMO_SELLER_LABEL;
  }
  if (view === null) return map;
  for (const s of view.sellers) {
    if (s.operator) map[s.operator.toLowerCase()] = s.name;
    if (s.payee) map[s.payee.toLowerCase()] = s.name;
  }
  return map;
}
