/**
 * LogBlock — the receipt printer's log line: a mono pre block for `text`
 * results, plain or error-styled. Runs of full hex values become copy
 * chips (hash/address copy-on-click).
 */
import type { JSX } from "react";
import { HashChip, splitHex } from "./HashChip";

export function HexText({
  text,
  onCopy,
  onCopyFailed,
}: {
  text: string;
  onCopy?: (hash: string) => void;
  onCopyFailed?: (hash: string) => void;
}): JSX.Element {
  if (onCopy === undefined) return <>{text}</>;
  const parts = splitHex(text);
  if (parts.length === 1 && typeof parts[0] === "string") return <>{text}</>;
  return (
    <>
      {parts.map((part, i) =>
        typeof part === "string" ? (
          <span key={i}>{part}</span>
        ) : (
          <HashChip key={i} hash={part.hash} onCopy={onCopy} onCopyFailed={onCopyFailed} />
        ),
      )}
    </>
  );
}

export function LogBlock({
  text,
  error = false,
  onCopy,
  onCopyFailed,
}: {
  text: string;
  error?: boolean;
  onCopy?: (hash: string) => void;
  onCopyFailed?: (hash: string) => void;
}): JSX.Element {
  return (
    <pre className={error ? "tape__log tape__log--error" : "tape__log"}>
      <HexText text={text} onCopy={onCopy} onCopyFailed={onCopyFailed} />
    </pre>
  );
}
