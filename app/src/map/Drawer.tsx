/**
 * Node drawer (T11) — the right-side detail panel for the selected map node.
 * Shows the node's live rows (the same live value the chip polls — shared, so
 * no second poll loop), its sources, read recency, and the primary action
 * wired to the CONSOLE: the button dispatches the node's command through the
 * registry and renders the exact same typed block the console would (reusing
 * renderResult — no duplicate logic). navigate() feeds the theater route.
 */
import { useMemo, useState, type JSX } from "react";
import { CONFIG } from "../config";
import { demoAddress, getPublicClient, pickSigner } from "../data/chain";
import { dispatch, type CommandContext, type CommandResult } from "../console/registry";
import { renderResult } from "../console/renderers";
import type { MapNode, NodeLive } from "./nodes";

export function Drawer({
  node,
  live,
  onClose,
}: {
  node: MapNode;
  live: NodeLive;
  onClose: () => void;
}): JSX.Element {
  const [result, setResult] = useState<CommandResult | null>(null);
  const [running, setRunning] = useState(false);

  const ctx = useMemo<CommandContext>(
    () => ({
      publicClient: getPublicClient(),
      signer: {
        kind: pickSigner({ demoKey: import.meta.env.VITE_DEMO_BUYER_KEY as string | undefined }),
        address: demoAddress(),
      },
      config: CONFIG,
      navigate: (route: string) => {
        window.location.hash = route;
      },
    }),
    [],
  );

  const runAction = async (): Promise<void> => {
    if (!node.primaryAction) return;
    setRunning(true);
    setResult(null);
    try {
      setResult(await dispatch(node.primaryAction.command, ctx));
    } finally {
      setRunning(false);
    }
  };

  const age = live.at > 0 ? Math.max(0, Math.round((Date.now() - live.at) / 1000)) : null;

  return (
    <aside className="map__drawer" role="dialog" aria-label={`${node.title} details`}>
      <header className="map__drawer-head">
        <span className="map__drawer-title">{node.title}</span>
        <span className={`map__drawer-state ${live.state}`}>{live.state}</span>
        <button type="button" className="map__drawer-close" onClick={onClose} aria-label="close drawer">
          ×
        </button>
      </header>

      <div className="map__drawer-sources">
        {node.sources.map((source) => (
          <span className="map__drawer-source" key={source}>
            {source}
          </span>
        ))}
      </div>

      {live.state === "error" && live.value === null && (
        <p className="map__drawer-error" role="alert" title={live.reason}>
          offline · {live.reason}
        </p>
      )}

      {live.value !== null && (
        <div className="map__drawer-rows">
          {live.value.rows.map(([key, value]) => (
            <div className="map__drawer-row" key={key}>
              <span className="map__drawer-k">{key}</span>
              <span className="map__drawer-v">{value}</span>
            </div>
          ))}
        </div>
      )}

      {live.state !== "live" && live.reason !== undefined && live.value !== null && (
        <p className="map__drawer-error" title={live.detail}>
          {live.state === "stale" ? "stale" : "degraded"} · {live.reason}
        </p>
      )}

      <div className="map__drawer-meta">
        <button type="button" className="map__drawer-refresh" onClick={live.refresh}>
          ↺ refresh
        </button>
        {age !== null && <span className="map__drawer-age">records read {age}s ago</span>}
      </div>

      {node.primaryAction !== undefined && (
        <div className="map__drawer-action">
          <button type="button" className="primary" onClick={() => void runAction()} disabled={running}>
            {running ? "running…" : node.primaryAction.label}
          </button>
          <span className="map__drawer-cmd">console: {node.primaryAction.command}</span>
        </div>
      )}

      {result !== null && (
        <div className="console__block console__block--drawer">{renderResult(result)}</div>
      )}
    </aside>
  );
}
