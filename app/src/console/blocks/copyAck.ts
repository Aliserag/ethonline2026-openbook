/**
 * Copy-ack state — pure reducer for the receipt-tape "copied" acknowledgment.
 * The console keeps ONE printed ack at a time (a copy chips the last ack
 * away); the ack is auto-cleared by the caller after ~2s. Kept pure so the
 * transition table is unit-testable without a DOM.
 */
export interface CopyAck {
  /** the entry (receipt) that printed the copied value */
  entryId: number;
  /** the full value copied to the clipboard */
  hash: string;
}

export type CopyAckAction = { type: "copied"; entryId: number; hash: string } | { type: "clear" };

export function copyAckReducer(_state: CopyAck | null, action: CopyAckAction): CopyAck | null {
  switch (action.type) {
    case "copied":
      return { entryId: action.entryId, hash: action.hash };
    case "clear":
      return null;
  }
}
