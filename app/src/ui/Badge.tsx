import type { JSX, ReactNode } from "react";

export type BadgeKind = "settled" | "refunded" | "open" | "muted";

export function Badge({ kind, children }: { kind: BadgeKind; children: ReactNode }): JSX.Element {
  return <span className={`badge badge--${kind}`}>{children}</span>;
}
