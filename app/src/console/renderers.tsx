/**
 * Console result renderers — one component per CommandResult kind, all minimal
 * structure + tokens (the design-system pass T16/T17 styles the tape later).
 * The freshness ruler reuses the app's global `.ruler` primitives (index.css).
 */
import type { JSX } from "react";
import { explorerUrl, truncateHash } from "../format";
import type { FramesData, KvData, RulerData, TableData, TxData, CommandResult } from "./registry";

export function TextBlock({ text }: { text: string }): JSX.Element {
  return <pre className="console__text">{text}</pre>;
}

export function KvBlock({ data }: { data: KvData }): JSX.Element {
  return (
    <div className="console__kv">
      {data.rows.map(([key, value]) => (
        <div className="console__kvrow" key={key}>
          <span className="console__k">{key}</span>
          <span className="console__v">{value}</span>
        </div>
      ))}
      {data.note !== undefined && <div className="console__note">{data.note}</div>}
    </div>
  );
}

export function TableBlock({
  data,
  onOpenJob,
}: {
  data: TableData;
  /** when set, rows carrying a numeric `job` cell become clickable replay links */
  onOpenJob?: (jobId: string) => void;
}): JSX.Element {
  return (
    <div className="console__tablewrap">
      {data.summary !== undefined && <div className="console__summary">{data.summary}</div>}
      <table className="console__table">
        <thead>
          <tr>
            {data.columns.map((column) => (
              <th key={column} scope="col">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row, i) => {
            const openJob = onOpenJob;
            const jobCell = row["job"];
            const clickable = openJob !== undefined && jobCell !== undefined && /^[0-9]+$/.test(jobCell);
            if (!clickable) {
              return (
                <tr key={i}>
                  {data.columns.map((column) => (
                    <td key={column}>{row[column] ?? ""}</td>
                  ))}
                </tr>
              );
            }
            const jobId = jobCell;
            return (
              <tr
                key={i}
                className="console__row--job"
                role="button"
                tabIndex={0}
                title={`replay job ${jobId} in the theater`}
                onClick={() => openJob(jobId)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    openJob(jobId);
                  }
                }}
              >
                {data.columns.map((column) => (
                  <td key={column}>{row[column] ?? ""}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Freshness ruler: delivered (subgraph) vs head (chain), with the SLA window. */
export function RulerBlock({ data }: { data: RulerData }): JSX.Element {
  const { delivered, head, floor, label, note } = data;
  if (delivered === undefined || head === undefined) {
    return <TextBlock text={`${label} — incomplete: delivered ${delivered ?? "—"} vs head ${head ?? "—"}`} />;
  }
  const lo = Math.min(delivered, head, floor ?? head);
  const hi = Math.max(delivered, head, floor ?? head);
  const span = Math.max(1, hi - lo);
  const pct = (value: number): number => ((value - lo) / span) * 100;
  return (
    <div className="console__ruler">
      <div className="console__ruler-track">
        <div className="ruler" role="img" aria-label={label}>
          {floor !== undefined && (
            <span
              className="windowbar"
              style={{ left: `${pct(floor)}%`, width: `${Math.max(0, pct(head) - pct(floor))}%` }}
              title={`SLA accepts delivered >= ${floor}`}
            />
          )}
          {floor !== undefined && (
            <span className="mark minblock" style={{ left: `${pct(floor)}%` }}>
              SLA min {floor}
            </span>
          )}
          <span className={`needle meta${delivered >= (floor ?? 0) ? " fresh" : ""}`} style={{ left: `${pct(delivered)}%` }}>
            <span className="lbl">indexed {delivered}</span>
          </span>
          <span className="needle head" style={{ left: `${pct(head)}%` }}>
            <span className="lbl">head {head}</span>
          </span>
        </div>
      </div>
      <div className="console__note">{label} · {note ?? ""}</div>
    </div>
  );
}

export function TxBlock({ data }: { data: TxData }): JSX.Element {
  const kindClass = data.kind !== undefined ? ` stamp ${data.kind}` : "";
  const stampText = data.kind !== undefined ? data.kind.toUpperCase() : "TX";
  return (
    <div className="console__tx">
      <div className="console__txhead">
        <span className={`stamp${kindClass}`}>{stampText}</span>
        <span className="console__txlink">
          <a href={explorerUrl(data.hash)} target="_blank" rel="noreferrer">
            {truncateHash(data.hash, 10, 8)} ↗
          </a>
        </span>
      </div>
      {data.title !== undefined && <div className="console__tx-title">{data.title}</div>}
      {data.rows !== undefined && <KvBlock data={{ rows: data.rows }} />}
      {data.note !== undefined && <div className="console__note">{data.note}</div>}
    </div>
  );
}

export function FramesBlock({ data }: { data: FramesData }): JSX.Element {
  return (
    <div className="console__frames">
      <div className="console__note">
        replay <code>{data.jobId}</code> · the theater is open at{" "}
        <code>#theater/{data.jobId}</code>: quote → pay → deliver → verdict → money →
        books (←/→ scrub, esc closes).
      </div>
    </div>
  );
}

/** Render any CommandResult through its kind's block. */
export function renderResult(
  result: CommandResult,
  onOpenJob?: (jobId: string) => void,
): JSX.Element {
  switch (result.render) {
    case "text":
      return <TextBlock text={result.data} />;
    case "kv":
      return <KvBlock data={result.data} />;
    case "table":
      return <TableBlock data={result.data} onOpenJob={onOpenJob} />;
    case "ruler":
      return <RulerBlock data={result.data} />;
    case "tx":
      return <TxBlock data={result.data} />;
    case "frames":
      return <FramesBlock data={result.data} />;
  }
}
