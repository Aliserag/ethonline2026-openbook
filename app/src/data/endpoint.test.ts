import { describe, expect, test } from "bun:test";
import { STUDIO_ENDPOINT, subgraphEndpoint } from "./endpoint";

describe("subgraphEndpoint", () => {
  test("env override wins", () => {
    expect(
      subgraphEndpoint({ hostname: "openbook.litai.ca", origin: "https://openbook.litai.ca" }, "https://x/api"),
    ).toBe("https://x/api");
  });
  test("deployed origin uses the same-origin proxy", () => {
    expect(subgraphEndpoint({ hostname: "openbook.litai.ca", origin: "https://openbook.litai.ca" }, undefined)).toBe(
      "https://openbook.litai.ca/api/subgraph",
    );
  });
  test("localhost goes straight to Studio", () => {
    expect(subgraphEndpoint({ hostname: "localhost", origin: "http://localhost:5173" }, undefined)).toBe(STUDIO_ENDPOINT);
    expect(subgraphEndpoint({ hostname: "127.0.0.1", origin: "http://127.0.0.1:4173" }, undefined)).toBe(STUDIO_ENDPOINT);
  });
  test("no location (tests, SSR) goes to Studio", () => {
    expect(subgraphEndpoint(undefined, undefined)).toBe(STUDIO_ENDPOINT);
  });
});
