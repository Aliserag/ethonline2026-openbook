/**
 * TableBlock — the ledger table body. Rows carrying a numeric `job` cell
 * become clickable replay links (theater); hash cells stay copyable.
 */
import type { JSX } from "react";
import type { TableData } from "../registry";
import { HashChip, splitHex } from "./HashChip";

export function TableBlock({
  data,
  onOpenJob,
  onCopy,
  onCopyFailed,
}: {
  data: TableData;
  /** when set, rows carrying a numeric `job` cell become clickable replay links */
  onOpenJob?: (jobId: string) => void;
  onCopy?: (hash: string) => void;
  onCopyFailed?: (hash: string) => void;
}): JSX.Element {
  return (
    <div className="tape__tablewrap">
      {data.summary !== undefined && <div className="tape__summary">{data.summary}</div>}
      <table className="tape__table">
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
            const cells = data.columns.map((column) => {
              const value = row[column] ?? "";
              if (onCopy === undefined || value.length === 0) return <span key={column}>{value}</span>;
              return (
                <span key={column}>
                  {splitHex(value).map((part, p) =>
                    typeof part === "string" ? (
                      <span key={p}>{part}</span>
                    ) : (
                      <HashChip key={p} hash={part.hash} onCopy={onCopy} onCopyFailed={onCopyFailed} />
                    ),
                  )}
                </span>
              );
            });
            if (!clickable) {
              return (
                <tr key={i}>
                  {cells.map((cell, c) => (
                    <td key={c}>{cell}</td>
                  ))}
                </tr>
              );
            }
            const jobId = jobCell;
            return (
              <tr
                key={i}
                className="tape__row--job"
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
                {cells.map((cell, c) => (
                  <td key={c}>{cell}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
