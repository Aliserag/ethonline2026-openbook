import { describe, expect, test } from "bun:test";
import { blocksToDuration, datasetTitle, freshnessPromise, priceLabel, relativeTime, stalenessLabel } from "./plain";

describe("plain copy", () => {
  test("blocks to duration per chain", () => {
    expect(blocksToDuration(50, "arbitrum")).toBe("about 13 seconds");
    expect(blocksToDuration(50, "ethereum")).toBe("about 10 minutes");
    expect(blocksToDuration(600, "ethereum")).toBe("about 2 hours");
    expect(blocksToDuration(1, "arbitrum")).toBe("under a second");
  });
  test("freshness promise", () => {
    expect(freshnessPromise(50, "arbitrum")).toBe("fresh within about 13 seconds (50 Arbitrum blocks)");
    expect(freshnessPromise(50, "ethereum")).toBe("fresh within about 10 minutes (50 Ethereum blocks)");
  });
  test("staleness label", () => {
    expect(stalenessLabel(100, 101, "arbitrum")).toBe("1 block below the freshness floor");
    expect(stalenessLabel(0, 504_000_000, "arbitrum")).toBe("504,000,000 blocks below the freshness floor");
  });
  test("dataset titles", () => {
    expect(datasetTitle("aave-v3-arbitrum-lending")).toBe("Aave V3 lending on Arbitrum");
    expect(datasetTitle("uniswap-v3-arbitrum-dex")).toBe("Uniswap V3 pools on Arbitrum");
    expect(datasetTitle("opensea-nft-trades")).toBe("OpenSea NFT trades");
    expect(datasetTitle("ens-registrations")).toBe("ENS name registrations");
    expect(datasetTitle("overtime-sports-odds")).toBe("Overtime sports odds");
    expect(datasetTitle("something-else")).toBe("something-else");
  });
  test("price label trims", () => {
    expect(priceLabel(150000)).toBe("0.15 USDC");
    expect(priceLabel(100000)).toBe("0.10 USDC");
    expect(priceLabel(3000)).toBe("0.003 USDC");
  });
  test("relative time", () => {
    const now = 1_800_000_000_000;
    expect(relativeTime(1_800_000_000 - 20, now)).toBe("just now");
    expect(relativeTime(1_800_000_000 - 240, now)).toBe("4 min ago");
    expect(relativeTime(1_800_000_000 - 7200, now)).toBe("2 h ago");
    expect(relativeTime(1_800_000_000 - 3 * 86400, now)).toBe("3 d ago");
  });
});
