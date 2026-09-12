import { describe, expect, test } from "bun:test";
import { circleEnvFrom, entitySecretCiphertext, parseCircleJobRequest, parseCircleSubmitRequest } from "./circle";

describe("circle env", () => {
  const good: Record<string, string> = {
    CIRCLE_API_KEY: "TEST_API_KEY:aaaa:bbbb",
    CIRCLE_ENTITY_SECRET: "ab".repeat(32),
    CIRCLE_BUYER_WALLET_ID: "w1",
    CIRCLE_SELLER_WALLET_ID: "w2",
    CIRCLE_BUYER_WALLET_ADDRESS: "0x00e8350b21365b1dc73ed60ba19ea8b7fda059dc",
    CIRCLE_SELLER_WALLET_ADDRESS: "0xb63fa642b3bc64d91722f0884d86af5b00e66ca9",
  };
  test("complete config is accepted; a bare id:secret key gets the TEST_API_KEY prefix", () => {
    expect(circleEnvFrom((k) => good[k])?.buyerWalletId).toBe("w1");
    expect(circleEnvFrom((k) => (k === "CIRCLE_API_KEY" ? "aaaa:bbbb" : good[k]))?.apiKey).toBe("TEST_API_KEY:aaaa:bbbb");
  });
  test("any missing piece disables the path", () => {
    for (const k of Object.keys(good)) expect(circleEnvFrom((key) => (key === k ? undefined : good[key]))).toBeNull();
  });
});

describe("request parsing", () => {
  test("job request bounds the amount to 1 USDC and needs a 32-byte schema hash", () => {
    const ok = { datasetId: "aave-v3-arbitrum-lending", minBlock: 1, schemaHash: `0x${"ab".repeat(32)}`, maxLatencyMs: 2000, amount: "150000" };
    expect(parseCircleJobRequest(ok)).toMatchObject({ amount: "150000", datasetId: "aave-v3-arbitrum-lending" });
    expect(parseCircleJobRequest({ ...ok, amount: "5000000" })).toContain("amount");
    expect(parseCircleJobRequest({ ...ok, minBlock: -1 })).toContain("minBlock");
    expect(parseCircleJobRequest({ ...ok, datasetId: "not-sold" })).toContain("datasetId");
  });
  test("submit request needs the attester's 65-byte signature", () => {
    expect(parseCircleSubmitRequest({ jobId: "84", deliverable: `0x${"cd".repeat(32)}`, metaBlock: 5, proof: "deadbeef" })).toContain("proof");
    expect(parseCircleSubmitRequest({ jobId: "84", deliverable: `0x${"cd".repeat(32)}`, metaBlock: 5, proof: `0x${"ef".repeat(65)}` })).toMatchObject({ jobId: "84" });
  });
});

describe("entity secret ciphertext", () => {
  test("is RSA-OAEP(SHA-256) of the raw 32 secret bytes, fresh per call", async () => {
    const pair = await crypto.subtle.generateKey({ name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["encrypt", "decrypt"]);
    const secret = "0123456789abcdef".repeat(4);
    const c1 = await entitySecretCiphertext({ apiKey: "x", entitySecret: secret }, pair.publicKey);
    const c2 = await entitySecretCiphertext({ apiKey: "x", entitySecret: secret }, pair.publicKey);
    expect(c1).not.toBe(c2);
    const dec = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, pair.privateKey, Uint8Array.from(atob(c1), (ch) => ch.charCodeAt(0)));
    expect([...new Uint8Array(dec)].map((b) => b.toString(16).padStart(2, "0")).join("")).toBe(secret);
  });
});
