/**
 * HashChip — copy-on-click for hashes and addresses. Any printed full hex
 * value becomes a chip: click (or Enter/Space) copies the FULL value to the
 * clipboard and reports it through onCopy so the receipt can print the ack.
 * Truncated display copies the full value — the chip never copies a "…".
 */
import type { JSX } from "react";
import { truncateHash } from "../../format";

/**
 * Split a string into plain text parts and full hex tokens. Only COMPLETE
 * clickable values are wrapped: "0x…" with an ellipsis is display-only.
 */
export function splitHex(text: string): (string | { hash: string })[] {
  const parts: (string | { hash: string })[] = [];
  const re = /0x[0-9a-fA-F]{6,}/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push({ hash: match[0] });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/**
 * Copy to the clipboard with a DOM fallback (headless/embedded browsers
 * without async-clipboard permission still copy via execCommand).
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText !== undefined) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the execCommand path
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

export function HashChip({
  hash,
  onCopy,
  onCopyFailed,
}: {
  hash: string;
  onCopy: (hash: string) => void;
  /** fired only when the clipboard write really failed — the ack must never lie */
  onCopyFailed?: (hash: string) => void;
}): JSX.Element {
  const copy = (): void => {
    // await the actual write result before printing the ack: a rejected
    // clipboard must not print "✓ copied".
    void copyText(hash).then((ok) => {
      if (ok) onCopy(hash);
      else onCopyFailed?.(hash);
    });
  };
  return (
    <span
      className="tape__hash"
      role="button"
      tabIndex={0}
      title={`copy ${hash}`}
      aria-label={`copy ${hash} to the clipboard`}
      onClick={copy}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          copy();
        }
      }}
    >
      {truncateHash(hash)}
    </span>
  );
}
