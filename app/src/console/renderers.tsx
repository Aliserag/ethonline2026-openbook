/**
 * Console result renderers — the tape's block grammar (spec §5.3c). One
 * component per CommandResult kind (text|kv|table|tx|ruler|frames), all in
 * blocks/*; this module keeps the dispatch surface stable for the external
 * consumers that render results outside the dock (theater, tour, map drawer)
 * and re-exports every block component.
 */
import type { JSX } from "react";
import type { CommandResult } from "./registry";
import { LogBlock } from "./blocks/LogBlock";
import { KvBlock } from "./blocks/KvBlock";
import { TableBlock } from "./blocks/TableBlock";
import { RulerBlock } from "./blocks/RulerBlock";
import { TxBlock } from "./blocks/TxBlock";
import { FramesBlock } from "./blocks/FramesBlock";

export { KvBlock, TableBlock, RulerBlock, TxBlock, FramesBlock };

/** Log block for `text` results (plain, or error-styled from the caller). */
export function TextBlock({
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
  return <LogBlock text={text} error={error} onCopy={onCopy} onCopyFailed={onCopyFailed} />;
}

/** Render any CommandResult through its kind's block. */
export function renderResult(
  result: CommandResult,
  onOpenJob?: (jobId: string) => void,
  onCopy?: (hash: string) => void,
  onCopyFailed?: (hash: string) => void,
): JSX.Element {
  switch (result.render) {
    case "text":
      return <TextBlock text={result.data} onCopy={onCopy} onCopyFailed={onCopyFailed} />;
    case "kv":
      return <KvBlock data={result.data} onCopy={onCopy} onCopyFailed={onCopyFailed} />;
    case "table":
      return <TableBlock data={result.data} onOpenJob={onOpenJob} onCopy={onCopy} onCopyFailed={onCopyFailed} />;
    case "ruler":
      return <RulerBlock data={result.data} />;
    case "tx":
      return <TxBlock data={result.data} onCopy={onCopy} onCopyFailed={onCopyFailed} />;
    case "frames":
      return <FramesBlock data={result.data} />;
  }
}
