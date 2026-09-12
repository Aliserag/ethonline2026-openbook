/**
 * Copy-ack state — pure reducer for the receipt-tape "copied" acknowledgment.
 * The console keeps ONE printed ack at a time (a copy chips the last ack
 * away); the ack is auto-cleared by the caller after ~2s. Kept pure so the
 * transition table is unit-testable without a DOM. The ack is printed from
 * the ACTUAL clipboard result — a failed write prints an honest failure
 * note, never a ✓.
 */
import { truncateHash } from "../../format";

export interface CopyAck {
  /** the entry (receipt) that printed the copied value */
  entryId: number;
  /** the full value copied to the clipboard */
  hash: string;
  /** true when the clipboard write failed — the printed note says so */
  failed?: boolean;
}

export type CopyAckAction =
  | { type: "copied"; entryId: number; hash: string }
  | { type: "failed"; entryId: number; hash: string }
  | { type: "clear" };

export function copyAckReducer(_state: CopyAck | null, action: CopyAckAction): CopyAck | null {
  switch (action.type) {
    case "copied":
      return { entryId: action.entryId, hash: action.hash };
    case "failed":
      return { entryId: action.entryId, hash: action.hash, failed: true };
    case "clear":
      return null;
  }
}

/** The printed ack line — the pure success/failure decision. */
export function copyAckText(ack: CopyAck): string {
  if (ack.failed) {
    return "copy failed: clipboard write rejected — select the hash and copy manually";
  }
  return `✓ copied ${truncateHash(ack.hash, 8, 6)} — printed`;
}
