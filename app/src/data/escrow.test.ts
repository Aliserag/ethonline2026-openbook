import { describe, expect, it } from "bun:test";
import { feeSplitFromReceipt } from "./escrow";

const USDC = "0x3600000000000000000000000000000000000000";
const SELLER = "0x64a78b6d5e99274d01d1d0a70b180a73aaeb8d21";
const TREASURY = "0x4e83eb15ee973a49e40d9a79ab2ca89a4eb4894e";
const TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const transfer = (to: string, amt: bigint) => ({
  address: USDC, topics: [TOPIC, `0x${"00".repeat(12)}${"11".repeat(20)}`, `0x${"00".repeat(12)}${to.slice(2)}`],
  data: `0x${amt.toString(16).padStart(64, "0")}`,
});

describe("feeSplitFromReceipt", () => {
  it("splits by the actual transfer logs (0.098 + 0.002)", () => {
    const split = feeSplitFromReceipt({ logs: [transfer(SELLER, 98_000n), transfer(TREASURY, 2_000n)] } as never, 200);
    expect(split).toEqual({ total: 100_000n, seller: 98_000n, treasury: 2_000n, feeBP: 200 });
  });
  it("throws when the logs disagree with the fee rate", () => {
    expect(() => feeSplitFromReceipt({ logs: [transfer(SELLER, 99_000n), transfer(TREASURY, 2_000n)] } as never, 200)).toThrow(/fee split/i);
  });
  it("throws on a receipt with no USDC transfers", () => {
    expect(() => feeSplitFromReceipt({ logs: [] } as never, 200)).toThrow(/fee split/i);
  });
});
