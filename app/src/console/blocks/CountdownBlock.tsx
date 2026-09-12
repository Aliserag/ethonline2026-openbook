/**
 * CountdownBlock — the DOM progress bar for `sandbox claim`: the claim
 * opens when the escrow deadline passes. The bar ticks against the deadline
 * (min 360s — the contract's ExpiryTooShort floor), so the reference window
 * is 360s and the fill is clamped. Motion: the bar width + the number tick
 * transition at 120ms (value change only); prefers-reduced-motion zeroes it.
 */
import { useEffect, useState, type JSX } from "react";

const WINDOW_SECONDS = 360;

function clock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function CountdownBlock({ until }: { until: number }): JSX.Element {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 250);
    return () => window.clearInterval(timer);
  }, []);

  const remain = Math.max(0, until - now);
  const pct = Math.min(100, (remain / WINDOW_SECONDS) * 100);
  const deadline = new Date(until * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  return (
    <div className="tape__countdown" aria-label={`claim window: ${remain} seconds left`}>
      {remain > 0 ? (
        <>
          <div className="tape__countdown-track">
            <span className="tape__countdown-fill" style={{ width: `${pct}%` }} />
          </div>
          <div className="tape__countdown-nums">
            <span>T-{clock(remain)}</span>
            <span>deadline {deadline}</span>
          </div>
        </>
      ) : (
        <div className="tape__note">claim window closed — rerun sandbox claim to execute the refund</div>
      )}
    </div>
  );
}
