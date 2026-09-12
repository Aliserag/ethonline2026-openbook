/**
 * Receipt verdict stamps — the pure mapping from a printed command line +
 * its result to the rubber-stamp verdict (spec §5.3c: APPROVED / REFUSED /
 * REFUNDED). Only settle/refund/refusal receipts get a stamp; every other
 * block prints plain (no stamp = no claim).
 *
 * Refusals are detected from the command's own labeled output, never by
 * sniffing an arbitrary "✗": policy try-overspend marks its simulated
 * rejection rows, sandbox stale prints the captured SlaNotMet evidence, and
 * the buy/deliver guards name the refused path in the row text. Settle
 * prints its verdict row (APPROVE, or a stale/invalid verdict that refunds
 * instead).
 */
import type { CommandResult } from "../registry";

export type Verdict = "APPROVED" | "REFUSED" | "REFUNDED";

export function verdictFor(line: string, result: CommandResult | null): Verdict | null {
  if (!result) return null;
  if (result.render === "tx") {
    if (result.data.kind === "settled") return "APPROVED";
    if (result.data.kind === "refunded") return "REFUNDED";
    return null; // stale/open tx cards print un-stamped
  }
  if (result.render !== "kv") return null;
  const rows = result.data.rows;
  const text = `${rows.map(([, value]) => value).join(" ")} ${result.data.note ?? ""}`;
  const refused = text.includes("reverted:") || text.includes("protocol refuses");
  if (line.startsWith("policy try-overspend")) {
    if (refused) return "REFUSED";
    if (rows.some(([key, value]) => key === "pure mirror" && value.startsWith("✗"))) return "REFUSED";
    return null;
  }
  if (line.startsWith("sandbox stale")) {
    if (refused) return "REFUSED";
    return null;
  }
  if (line.startsWith("settle")) {
    const verdictRow = rows.find(([key]) => key === "verdict");
    if (verdictRow !== undefined && verdictRow[1] === "APPROVE") return "APPROVED";
    if (text.includes("refunded instead")) return "REFUNDED";
    return null;
  }
  if (line.startsWith("buy") && text.includes("buy refused")) return "REFUSED";
  if (line.startsWith("deliver") && text.includes("delivery refused")) return "REFUSED";
  return null;
}
