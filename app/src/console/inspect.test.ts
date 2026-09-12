/**
 * ens show — visible-copy contract (adversarial E2E F1).
 *
 * The storefront summary names the testnet the ENSv2 records live on. A
 * typo ("sepiola") shipped in the summary and was visible in every `ens
 * show` receipt (console + tour). The summary is a constant string — this
 * test must fail on the typo and pass once the record reads correctly,
 * regardless of the live ENS probe outcomes.
 */
import { describe, expect, it } from "bun:test";
import { dispatch } from "./registry";
import type { CommandContext } from "./registry";
// Side-effect: registers the inspect commands (same import the Console makes).
import "./commands/inspect";

function ctx(): CommandContext {
  return {
    publicClient: {} as never,
    signer: { kind: "none", address: null },
    config: { name: "openbook", ens: "openbook.eth", datasets: [] } as never,
    navigate: () => undefined,
  };
}

describe("ens show", () => {
  it("summary names the correct testnet: 'sepolia ENSv2', never 'sepiola'", async () => {
    const result = await dispatch("ens show", ctx());
    if (result.render !== "table") {
      throw new Error(`ens show must render a table, got ${result.render}`);
    }
    expect(result.data.summary).toContain("sepolia ENSv2");
    expect(result.data.summary).not.toContain("sepiola");
  });
});
