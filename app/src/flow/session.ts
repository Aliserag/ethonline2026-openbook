/**
 * Purchases executed in this browser session. The board and the hero show
 * them immediately, marked confirming until the subgraph indexes the job.
 */
import { useSyncExternalStore } from "react";
import type { SessionRun } from "../data/feed";

let runs: SessionRun[] = [];
const listeners = new Set<() => void>();

export function recordRun(run: SessionRun): void {
  runs = [run, ...runs.filter((r) => r.jobId !== run.jobId)];
  for (const l of listeners) l();
}

/** Test seam. */
export function resetRuns(): void {
  runs = [];
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useSessionRuns(): SessionRun[] {
  return useSyncExternalStore(subscribe, () => runs, () => runs);
}
