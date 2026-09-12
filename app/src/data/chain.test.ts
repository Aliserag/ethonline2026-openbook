import { describe, expect, it } from "bun:test";
import { pickSigner } from "./chain";

describe("pickSigner", () => {
  it("prefers the demo key when present", () => {
    expect(pickSigner({ demoKey: "0x" + "11".repeat(32) as `0x${string}`, injected: "0x" + "22".repeat(20) as `0x${string}` })).toBe("demo");
  });
  it("falls back to injected", () => {
    expect(pickSigner({ injected: "0x" + "22".repeat(20) as `0x${string}` })).toBe("injected");
  });
  it("returns none when neither exists", () => {
    expect(pickSigner({})).toBe("none");
  });
});
