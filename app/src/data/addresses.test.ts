import { describe, expect, it } from "bun:test";
import { ADDR, OUR_ADDRESSES } from "./addresses";

describe("ADDR", () => {
  it("binds the OpenBook world addresses", () => {
    expect(ADDR.escrow).toBe("0x967e005154D0F62C33Eac8E2F44b44d4C4C07Dd5");
    expect(ADDR.hook).toBe("0x606075F3Cf9b5B66E7e4DD2ea369894374Ff0846");
    expect(ADDR.policy).toBe("0x4e83eB15EE973A49E40D9A79aB2cA89a4Eb4894E");
    expect(ADDR.usdc).toBe("0x3600000000000000000000000000000000000000");
  });
  it("accepts env overrides without breaking defaults", () => {
    expect(ADDR.operator).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(ADDR.registry).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});

describe("OUR_ADDRESSES", () => {
  it("keeps the README-cited historical CLI buyer in scoped books", () => {
    const lower = OUR_ADDRESSES.map((a) => a.toLowerCase());
    expect(lower).toContain("0xac548cfefe70bb3199ee214f39bc9730a8a754de"); // job 185853's buyer
    expect(lower).toContain(ADDR.operator.toLowerCase()); // every job's seller
  });
});
