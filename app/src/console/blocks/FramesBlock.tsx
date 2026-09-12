/**
 * FramesBlock — the replay pointer card: where the theater lives and what
 * the <job> frame chain prints (quote → pay → deliver → verdict → money →
 * books).
 */
import type { JSX } from "react";
import type { FramesData } from "../registry";

export function FramesBlock({ data }: { data: FramesData }): JSX.Element {
  return (
    <div className="tape__frames">
      <div className="tape__note">
        replay <code>{data.jobId}</code> · the theater is open at{" "}
        <code>#theater/{data.jobId}</code>: quote → pay → deliver → verdict → money →
        books (←/→ scrub, esc closes).
      </div>
    </div>
  );
}
