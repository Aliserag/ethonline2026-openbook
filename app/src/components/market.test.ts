import { describe, expect, it } from "bun:test";
import { parseProviderRows, statsFor, venuePercent, venueTreasuryLabel } from "./Market";

const OPERATOR = "0x64A78b6d5e99274d01D1d0A70B180A73AAEb8d21";

function provider(id: string) {
  return {
    id,
    jobs: 83,
    settled: 1_148_000n,
    refunded: 200_000n,
    delivered: 72,
    avgLagBlocks: 38.02777777777777,
    lastJobAt: 1_789_186_349n,
  };
}

describe("parseProviderRows", () => {
  it("maps the subgraph providers payload to ProviderStats", () => {
    const rows = parseProviderRows({
      providers: [
        {
          id: "0x64A78b6d5e99274d01D1d0A70B180A73AAEb8d21",
          jobs: "83",
          settled: "1148000",
          refunded: "200000",
          delivered: "72",
          avgLagBlocks: "38.02777777777777777777777777777778",
          lastJobAt: "1789186349",
        },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "0x64a78b6d5e99274d01d1d0a70b180a73aaeb8d21", // lowercased
      jobs: 83,
      settled: 1_148_000n,
      refunded: 200_000n,
      delivered: 72,
      lastJobAt: 1_789_186_349n,
    });
    expect(rows[0].avgLagBlocks).toBeCloseTo(1369 / 36, 12);
  });

  it("degrades junk or missing fields instead of throwing", () => {
    const rows = parseProviderRows({
      providers: [{ id: "0x06100f442f0d24197e78b6fbe40cbfa3c24f63a9", jobs: null }],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ settled: 0n, refunded: 0n, delivered: 0, avgLagBlocks: 0, lastJobAt: 0n });
  });

  it("is empty for non-payload shapes", () => {
    expect(parseProviderRows(null)).toEqual([]);
    expect(parseProviderRows({ providers: "nope" })).toEqual([]);
    expect(parseProviderRows({ providers: [{ id: 7 }] })).toEqual([]);
  });
});

describe("statsFor", () => {
  const providers = [provider("0x64a78b6d5e99274d01d1d0a70b180a73aaeb8d21")];

  it("matches the operator address case-insensitively", () => {
    expect(statsFor(OPERATOR, providers)).toEqual(providers[0]);
  });

  it("returns null for an unindexed operator (honest: no stats, never zeros)", () => {
    expect(statsFor("0xe09C8F90931E97d0aEE998885b306DDF08CE08Cc", providers)).toBeNull();
    expect(statsFor(null, providers)).toBeNull();
  });
});

describe("venuePercent", () => {
  it("renders basis points as a percent", () => {
    expect(venuePercent(200)).toBe("2%");
    expect(venuePercent(250)).toBe("2.5%");
    expect(venuePercent(25)).toBe("0.25%");
    expect(venuePercent(0)).toBe("0%");
  });
});

describe("venueTreasuryLabel", () => {
  it("names the PolicyWallet when the live read matches it", () => {
    expect(venueTreasuryLabel("0x4e83eB15EE973A49E40D9A79aB2cA89a4Eb4894E")).toBe("PolicyWallet");
  });

  it("falls back to a truncated address for an unknown treasury", () => {
    const label = venueTreasuryLabel("0xAC548CFEfe70bb3199ee214F39bC9730a8A754De");
    expect(label).toContain("0xAC54");
    expect(label).not.toBe("PolicyWallet");
  });
});
