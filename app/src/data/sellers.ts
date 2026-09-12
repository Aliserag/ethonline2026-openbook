/** Operator address → ENS seller name, from the live market directory. */
import type { MarketView } from "../components/Market";

export function sellerNameMap(view: MarketView | null): Record<string, string> {
  const map: Record<string, string> = {};
  if (view === null) return map;
  for (const s of view.sellers) {
    if (s.operator) map[s.operator.toLowerCase()] = s.name;
    if (s.payee) map[s.payee.toLowerCase()] = s.name;
  }
  return map;
}
