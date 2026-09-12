/**
 * Replay theater frames (T10) — PURE derivation, no I/O. `buildFrames` renders
 * a job's life as six frames — quote, pay, deliver, verdict, money, books —
 * from an already-verified JobView, the receipt-derived FeeSplit
 * (feeSplitFromReceipt, never config), the live chain heads, and the ENS
 * storefront records.
 *
 * The verdict frame shows the exact gate comparison `metaBlock ≥ minBlock` and
 * derives its label with the SAME deterministic decideDelivery the evaluator
 * used (mcp/src/escrow); the `Verdict` type is data/types' re-export, never a
 * second verdict type.
 *
 * The money frame renders the RECEIPT-derived split (settled jobs) or the
 * full-amount refund row (refunded jobs — no fee row, because a refund moves
 * no USDC to the treasury). All I/O (subgraph events, onchain job read, chain
 * logs, ENS probes) lives in Theater.tsx, which calls buildFrames with the
 * composed inputs.
 */
import { decideDelivery } from "../../../mcp/src/escrow";
import { truncateHash } from "../format";
import type { FeeSplit, JobView, Verdict } from "../data/types";

/** One frame of the replay: a title, kv rows, an optional tx link, an optional note. */
export interface Frame {
  id: string;
  title: string;
  rows: [string, string][];
  tx?: `0x${string}`;
  note?: string;
}

/**
 * USDC raw-units display with up to 6 decimals — the receipt-derived split
 * often carries sub-cent cuts (2000 raw = 0.002 USDC) that usdc6 would round
 * to "0.00". Pure, never an invented figure.
 */
export function usdcDisplay(value: bigint): string {
  const whole = value / 1_000_000n;
  const frac = value % 1_000_000n;
  if (frac === 0n) return `${whole}.00`;
  const fracStr = frac.toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole}.${fracStr}`;
}

/** "2000 (0.002 USDC)" — raw units first so sums are exact, display second. */
function amountRow(label: string, value: bigint): [string, string] {
  return [label, `${value} (${usdcDisplay(value)} USDC)`];
}

function deadlineLabel(deadline: bigint): string {
  if (deadline === 0n) return "·";
  return `${deadline.toString()} (${new Date(Number(deadline) * 1000).toLocaleString()})`;
}

/**
 * The deterministic delivery verdict of a closed job — the evaluator's gate.
 * Null when the delivery never happened (open job) or the deliverable block
 * was never observed.
 */
function deliveryVerdict(job: JobView): Verdict | null {
  if (job.metaBlock === undefined || job.state === "open") return null;
  return decideDelivery({
    metaBlock: job.metaBlock,
    minBlock: Number(job.minBlock),
    payloadHash: job.payloadHash,
  });
}

/**
 * The verdict row's label. State outranks the pure gate for the OUTCOME (a
 * refunded job reads REJECT even when the deliverable cleared the floor —
 * e.g. job 185853, refunded client-side); the gate's REJECT reason wins when
 * the freshness check itself failed.
 */
function verdictLabel(job: JobView, verdict: Verdict | null): string {
  if (job.state === "refunded") {
    const reason =
      verdict?.verdict === "REJECT" ? verdict.reason.toLowerCase() : (job.refundReason ?? "refunded");
    return `REJECT (${reason})`;
  }
  if (job.state === "settled") return verdict ? verdict.verdict : "APPROVE";
  return "· pending settlement";
}

export function buildFrames(
  job: JobView,
  split: FeeSplit | null,
  heads: { arc: bigint; subgraph: bigint },
  ens: { name: string; price: string; maxBlockLag: number },
): Frame[] {
  const moneyRows: [string, string][] =
    split !== null
      ? [
          ["platformFeeBP", `${split.feeBP} BP (contract)`],
          amountRow("treasury (platform cut)", split.treasury),
          amountRow("seller (provider)", split.seller),
          amountRow("total", split.total),
        ]
      : job.state === "refunded"
        ? [
            amountRow("refund to buyer", job.amount),
            ["reason", job.refundReason ?? "·"],
          ]
        : job.state === "settled"
          ? [["state", "settled · split unavailable (see note)"]]
          : [["state", "open · escrow still holds the amount"]];

  const verdict = deliveryVerdict(job);

  return [
    {
      id: "quote",
      title: "quote",
      rows: [
        ["ens name", ens.name],
        ["ens price", ens.price],
        ["sla maxBlockLag", ens.maxBlockLag > 0 ? `${ens.maxBlockLag} blocks` : "· unreadable (svc.sla)"],
        amountRow("amount", job.amount),
        ["minBlock (SLA floor)", job.minBlock.toString()],
      ],
      note: "price and SLA window are the live ENS records of that name (the dataset's subname when its price matches the amount, else the parent)",
    },
    {
      id: "pay",
      title: "pay",
      rows: [
        ["job", job.jobId.toString()],
        ["buyer", truncateHash(job.buyer)],
        ["seller", truncateHash(job.seller)],
        amountRow("amount escrowed", job.amount),
        ["deadline", deadlineLabel(job.deadline)],
      ],
    },
    {
      id: "deliver",
      title: "deliver",
      rows: [
        ["delivered", job.state === "open" ? "· not yet" : "submitted"],
        ["payloadHash", job.payloadHash ? truncateHash(job.payloadHash, 12, 10) : "· no fulfillment indexed"],
        ["metaBlock", job.metaBlock !== undefined ? job.metaBlock.toString() : "·"],
      ],
    },
    {
      id: "verdict",
      title: "verdict",
      rows: [
        ["metaBlock ≥ minBlock", `${job.metaBlock ?? "·"} ≥ ${job.minBlock.toString()}`],
        ["verdict", verdictLabel(job, verdict)],
        ["subgraph indexed", heads.subgraph.toString()],
        ["arc head", heads.arc.toString()],
      ],
      note: "the freshness gate is deterministic: a deliverable clears when its block reaches the SLA floor · the ruler below compares delivered vs floor vs head",
    },
    {
      id: "money",
      title: "money",
      rows: moneyRows,
      note:
        split !== null
          ? "split derived from the settlement receipt's USDC Transfer logs (feeSplitFromReceipt) · never from config"
          : job.state === "refunded"
            ? "RefundIssued returns the full amount to the buyer · no platform fee row (a refund moves no USDC to the treasury)"
            : "no money moves until settlement",
    },
    {
      id: "books",
      title: "books",
      rows: [
        ["jobId", job.jobId.toString()],
        ["state", job.state],
        amountRow("amount", job.amount),
        [
          "books line",
          job.state === "settled"
            ? "revenue (PaymentReleased books the full amount once)"
            : job.state === "refunded"
              ? "refund (RefundIssued books the full amount)"
              : "no line yet · open",
        ],
      ],
    },
  ];
}
