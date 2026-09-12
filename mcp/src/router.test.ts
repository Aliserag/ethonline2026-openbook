/**
 * Marketplace buyer router (W2) — unit tests for `pickSeller`. Pure function,
 * no seams needed: the acceptance contract is frozen by the brief (spec §3
 * W2) — default `fresh` (tighter maxBlockLag wins, price breaks ties),
 * `cheap` mirrors it, ties stay deterministic.
 */
import { describe, expect, it } from "bun:test";
import { pickSeller, type ProviderStats, type SellerQuote } from "./router";

function offer(overrides: Partial<SellerQuote>): SellerQuote {
  return {
    name: "a.openbook.eth",
    datasetId: "aave-v3-arbitrum-lending",
    priceUsdc: 120000, // 0.12 USDC
    maxBlockLag: 50,
    payee: "0x4e83eB15EE973A49E40D9A79aB2cA89a4Eb4894E",
    stats: null,
    ...overrides,
  };
}

const OTHER_PAYEE = "0xe09C8F90931E97d0aEE998885b306DDF08CE08Cc";

describe("pickSeller", () => {
  it("fresh: tighter maxBlockLag wins", () => {
    const picked = pickSeller(
      [
        offer({ name: "a.openbook.eth", maxBlockLag: 60, priceUsdc: 90000 }),
        offer({ name: "b.openbook.eth", maxBlockLag: 40, priceUsdc: 100000, payee: OTHER_PAYEE }),
      ],
      "fresh",
    );
    expect(picked.name).toBe("b.openbook.eth");
  });

  it("fresh: equal maxBlockLag -> cheaper price breaks the tie", () => {
    const picked = pickSeller(
      [
        offer({ name: "a.openbook.eth", maxBlockLag: 50, priceUsdc: 150000 }),
        offer({ name: "b.openbook.eth", maxBlockLag: 50, priceUsdc: 120000, payee: OTHER_PAYEE }),
      ],
      "fresh",
    );
    expect(picked).toMatchObject({ name: "b.openbook.eth", priceUsdc: 120000, maxBlockLag: 50 });
  });

  it("cheap: lower price wins", () => {
    const picked = pickSeller(
      [
        offer({ name: "a.openbook.eth", priceUsdc: 150000, maxBlockLag: 30 }),
        offer({ name: "b.openbook.eth", priceUsdc: 120000, maxBlockLag: 60, payee: OTHER_PAYEE }),
      ],
      "cheap",
    );
    expect(picked).toMatchObject({ name: "b.openbook.eth", priceUsdc: 120000 });
  });

  it("cheap: equal price -> tighter maxBlockLag breaks the tie", () => {
    const picked = pickSeller(
      [
        offer({ name: "a.openbook.eth", priceUsdc: 120000, maxBlockLag: 60 }),
        offer({ name: "b.openbook.eth", priceUsdc: 120000, maxBlockLag: 30, payee: OTHER_PAYEE }),
      ],
      "cheap",
    );
    expect(picked).toMatchObject({ name: "b.openbook.eth", maxBlockLag: 30 });
  });

  it("defaults to fresh when the strategy is omitted", () => {
    const picked = pickSeller([
      offer({ name: "a.openbook.eth", maxBlockLag: 60, priceUsdc: 90000 }),
      offer({ name: "b.openbook.eth", maxBlockLag: 40, priceUsdc: 100000, payee: OTHER_PAYEE }),
    ]);
    expect(picked.name).toBe("b.openbook.eth");
  });

  it("full tie keeps the earlier offer (deterministic, stable)", () => {
    const quotes = [
      offer({ name: "a.openbook.eth", maxBlockLag: 50, priceUsdc: 120000 }),
      offer({ name: "b.openbook.eth", maxBlockLag: 50, priceUsdc: 120000, payee: OTHER_PAYEE }),
    ];
    expect(pickSeller(quotes, "fresh").name).toBe("a.openbook.eth");
    expect(pickSeller(quotes, "cheap").name).toBe("a.openbook.eth");
  });

  it("throws on an empty offer list — never picks nothing", () => {
    expect(() => pickSeller([], "fresh")).toThrow(/no quotes/);
    expect(() => pickSeller([], "cheap")).toThrow(/no quotes/);
  });

  it("carries the accompanying stats through untouched", () => {
    const stats: ProviderStats = {
      id: "0x64A78b6d5e99274d01D1d0A70B180A73AAEb8d21",
      jobs: 3,
      settled: 2n,
      refunded: 1n,
      delivered: 2,
      avgLagBlocks: 40,
      lastJobAt: 1789000000n,
    };
    const picked = pickSeller(
      [
        offer({ name: "a.openbook.eth", maxBlockLag: 60 }),
        offer({ name: "b.openbook.eth", maxBlockLag: 40, stats, payee: OTHER_PAYEE }),
      ],
      "fresh",
    );
    expect(picked.stats).toBe(stats);
  });
});
