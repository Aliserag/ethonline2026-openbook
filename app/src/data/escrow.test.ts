import { describe, expect, it } from "bun:test";
import type { PublicClient } from "viem";
import { feeSplitFromReceipt, readJob } from "./escrow";
import { packSla } from "../../../agent/escrow";

const USDC = "0x3600000000000000000000000000000000000000";
const SELLER = "0x64a78b6d5e99274d01d1d0a70b180a73aaeb8d21";
const TREASURY = "0x4e83eb15ee973a49e40d9a79ab2ca89a4eb4894e";
const THIRD_PARTY = `0x${"33".repeat(20)}`;
const TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const transfer = (to: string, amt: bigint) => ({
  address: USDC, topics: [TOPIC, `0x${"00".repeat(12)}${"11".repeat(20)}`, `0x${"00".repeat(12)}${to.slice(2)}`],
  data: `0x${amt.toString(16).padStart(64, "0")}`,
});

describe("feeSplitFromReceipt", () => {
  it("splits by the actual transfer logs (0.098 + 0.002)", () => {
    const split = feeSplitFromReceipt({ logs: [transfer(SELLER, 98_000n), transfer(TREASURY, 2_000n)] } as never, 200, SELLER as `0x${string}`);
    expect(split).toEqual({ total: 100_000n, seller: 98_000n, treasury: 2_000n, feeBP: 200 });
  });
  it("throws when the logs disagree with the fee rate", () => {
    expect(() => feeSplitFromReceipt({ logs: [transfer(SELLER, 99_000n), transfer(TREASURY, 2_000n)] } as never, 200, SELLER as `0x${string}`)).toThrow(/fee split/i);
  });
  it("throws on a receipt with no USDC transfers", () => {
    expect(() => feeSplitFromReceipt({ logs: [] } as never, 200, SELLER as `0x${string}`)).toThrow(/fee split/i);
  });
  it("throws on a transfer to an unexpected recipient (evaluator cut must never land in seller)", () => {
    expect(() =>
      feeSplitFromReceipt({ logs: [transfer(SELLER, 96_000n), transfer(TREASURY, 2_000n), transfer(THIRD_PARTY, 2_000n)] } as never, 200, SELLER as `0x${string}`),
    ).toThrow(/unexpected transfer recipient/i);
  });
});

describe("readJob", () => {
  // Live probe (viem 2.56.3 + agent/abi/erc8183.json): jobs() decodes as an
  // ARRAY [id, client, provider, evaluator, description, budget, expiredAt,
  // status, hook] — pin that branch so it can never regress unnoticed.
  const arrayClient = {
    readContract: async () => [
      4n,
      "0xAC548CFEfe70bb3199ee214F39bC9730a8A754De", // client (buyer)
      "0x64A78b6d5e99274d01D1d0A70B180A73AAEb8d21", // provider (seller)
      "0x0000000000000000000000000000000000000000", // evaluator
      packSla({ minBlock: 123, schemaHash: `0x${"ab".repeat(32)}`, maxLatencyMs: 2000 }),
      100_000n,
      1_752_000_000n,
      3n, // Completed → settled
      "0x606075F3Cf9b5B66E7e4DD2ea369894374Ff0846",
    ],
  } as unknown as PublicClient;

  it("maps the live array decode with SLA minBlock and settled state", async () => {
    const job = await readJob(arrayClient, 4n);
    expect(job).toEqual({
      jobId: 4n,
      buyer: "0xAC548CFEfe70bb3199ee214F39bC9730a8A754De",
      seller: "0x64A78b6d5e99274d01D1d0A70B180A73AAEb8d21",
      amount: 100_000n,
      minBlock: 123n,
      deadline: 1_752_000_000n,
      blockNumber: 0n,
      timestamp: 0,
      state: "settled",
    });
  });

  it("returns null when the escrow reverts (unknown jobId)", async () => {
    const reverting = { readContract: async () => { throw new Error("revert"); } } as unknown as PublicClient;
    expect(await readJob(reverting, 999n)).toBeNull();
  });
});
