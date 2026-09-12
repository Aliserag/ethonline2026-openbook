/**
 * KvBlock — the key/value body rows (mono, dashed rules). Hash-like values
 * become copy chips; the note prints as the receipt footnote.
 */
import type { JSX } from "react";
import type { KvData } from "../registry";
import { HashChip, splitHex } from "./HashChip";

export function KvBlock({
  data,
  onCopy,
}: {
  data: KvData;
  onCopy?: (hash: string) => void;
}): JSX.Element {
  return (
    <div className="tape__kv">
      {data.rows.map(([key, value]) => (
        <div className="tape__kvrow" key={key}>
          <span className="tape__k">{key}</span>
          <span className="tape__v">
            {onCopy === undefined ? (
              value
            ) : (
              <>
                {splitHex(value).map((part, i) =>
                  typeof part === "string" ? (
                    <span key={i}>{part}</span>
                  ) : (
                    <HashChip key={i} hash={part.hash} onCopy={onCopy} />
                  ),
                )}
              </>
            )}
          </span>
        </div>
      ))}
      {data.note !== undefined && <div className="tape__note">{data.note}</div>}
    </div>
  );
}
