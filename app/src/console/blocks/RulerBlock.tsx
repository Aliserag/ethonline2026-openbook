/**
 * RulerBlock — the freshness ruler (delivered vs chain head, SLA window).
 * Reuses the app's global `.ruler` primitives (index.css) inside the tape's
 * paper track; only the wrapper is taped.
 */
import type { JSX } from "react";
import type { RulerData } from "../registry";
import { LogBlock } from "./LogBlock";

export function RulerBlock({ data }: { data: RulerData }): JSX.Element {
  const { delivered, head, floor, label, note } = data;
  if (delivered === undefined || head === undefined) {
    return <LogBlock text={`${label} — incomplete: delivered ${delivered ?? "—"} vs head ${head ?? "—"}`} />;
  }
  const lo = Math.min(delivered, head, floor ?? head);
  const hi = Math.max(delivered, head, floor ?? head);
  const span = Math.max(1, hi - lo);
  const pct = (value: number): number => ((value - lo) / span) * 100;
  return (
    <div className="tape__ruler">
      <div className="tape__ruler-track">
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
      <div className="tape__note">
        {label} · {note ?? ""}
      </div>
    </div>
  );
}
