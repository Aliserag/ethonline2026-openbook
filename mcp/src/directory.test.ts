/**
 * ENS directory (W3) — unit tests. Seams injected, no network:
 *  - resolveSellers takes an EnsTextReader stub (acceptance: a parent with
 *    two subnames, one advertising svc.menu and one bare, yields exactly the
 *    equipped one);
 *  - listRegisteredSubnames takes a stubbed PublicClient (registry walk +
 *    LabelRegistered scan + getState freshness filter);
 *  - sellersForSchema narrows by the advertised schema.
 */
import { describe, expect, it } from "bun:test";
import { labelhash, type Address, type PublicClient } from "viem";
import {
  ENSV2_FROM_BLOCK,
  envSepoliaRpc,
  listRegisteredSubnames,
  resolveSellers,
  sellersForSchema,
  type EnumeratedSubname,
  type MenuEntry,
  type SellerRef,
} from "./directory";
import type { EnsTextReader } from "./ens";

// --- fixtures ---------------------------------------------------------------

const ALPHA = "alpha";
const BARE = "bare";
const ALPHA_NAME = `${ALPHA}.openbook.eth`;
const BARE_NAME = `${BARE}.openbook.eth`;

const alphaRecords: Record<string, string> = {
  "svc.menu": `[{"id":"aave-v3-arbitrum-lending","schema":"lending/3.1.0"},{"id":"uniswap-v3-arbitrum-dex","schema":"dex-amm/4.0.1"}]`,
  "svc.price": "0.12 USDC/query",
  "svc.sla": '{"maxBlockLag":40,"maxLatencyMs":2000}',
  "svc.payee": "0x4e83eB15EE973A49E40D9A79aB2cA89a4Eb4894E",
  "svc.operator": "0x64A78b6d5e99274d01D1d0A70B180A73AAEb8d21",
};

/** Records are scoped per name — the bare subname resolves nothing at all. */
const stubEns = (recordsByName: Record<string, Record<string, string>>): EnsTextReader =>
  async (name: string, key: string): Promise<string | null> =>
    recordsByName[name]?.[key] ?? null;

const twoSubnames: EnumeratedSubname[] = [
  { label: ALPHA, owner: "0x4e83eB15EE973A49E40D9A79aB2cA89a4Eb4894E", expiry: 2000000000n },
  { label: BARE, owner: "0x64A78b6d5e99274d01D1d0A70B180A73AAEb8d21", expiry: 2000000000n },
];

/** ENS reader where alpha.openbook.eth is equipped and bare.openbook.eth is bare. */
const alphaReader: EnsTextReader = stubEns({ [ALPHA_NAME]: alphaRecords });

/** A second seller with one overlapping menu schema, for filtering tests. */
function seller(overrides: Partial<SellerRef>): SellerRef {
  return {
    name: ALPHA_NAME,
    menu: [{ id: "aave-v3-arbitrum-lending", schema: "lending/3.1.0" }],
    price: "0.12 USDC/query",
    sla: { maxBlockLag: 40, maxLatencyMs: 2000 },
    payee: "0x4e83eB15EE973A49E40D9A79aB2cA89a4Eb4894E",
    operator: "0x64A78b6d5e99274d01D1d0A70B180A73AAEb8d21",
    ...overrides,
  };
}

// --- acceptance: readEnsText stub, two subnames, only the equipped one -------

describe("resolveSellers (acceptance: svc.menu gates the list)", () => {
  it("yields exactly the subname advertising svc.menu", async () => {
    const sellers = await resolveSellers("openbook.eth", twoSubnames, alphaReader);
    expect(sellers).toHaveLength(1);
    expect(sellers[0]?.name).toBe(ALPHA_NAME);
  });

  it("parses the equipped seller's records from ENS (never synthesized)", async () => {
    const [seller] = await resolveSellers("openbook.eth", twoSubnames, alphaReader);
    expect(seller?.menu).toEqual([
      { id: "aave-v3-arbitrum-lending", schema: "lending/3.1.0" },
      { id: "uniswap-v3-arbitrum-dex", schema: "dex-amm/4.0.1" },
    ]);
    expect(seller?.price).toBe("0.12 USDC/query");
    expect(seller?.sla).toEqual({ maxBlockLag: 40, maxLatencyMs: 2000 });
    expect(seller?.payee).toBe("0x4e83eB15EE973A49E40D9A79aB2cA89a4Eb4894E");
    expect(seller?.operator).toBe("0x64A78b6d5e99274d01D1d0A70B180A73AAEb8d21");
  });

  it("surfaces missing/invalid records as null instead of guessing", async () => {
    const partial: Record<string, string> = {
      "svc.menu": alphaRecords["svc.menu"] as string, // menu only, everything else unset
      "svc.payee": "not-an-address",
    };
    const [seller] = await resolveSellers("openbook.eth", twoSubnames, stubEns({ [ALPHA_NAME]: partial }));
    expect(seller?.price).toBeNull();
    expect(seller?.sla).toBeNull();
    expect(seller?.payee).toBeNull(); // junk record → null, never a fabricated address
    expect(seller?.operator).toBeNull();
  });

  it("treats an unparseable svc.menu as 'not a seller'", async () => {
    const junk: Record<string, string> = { "svc.menu": "not json" };
    const [seller] = await resolveSellers("openbook.eth", twoSubnames, stubEns({ [ALPHA_NAME]: junk }));
    expect(seller).toBeUndefined();
  });
});

// --- acceptance: sellersForSchema ---------------------------------------------

describe("sellersForSchema", () => {
  const refs: SellerRef[] = [
    seller({ name: "alpha.openbook.eth", menu: [
      { id: "aave-v3-arbitrum-lending", schema: "lending/3.1.0" },
      { id: "uniswap-v3-arbitrum-dex", schema: "dex-amm/4.0.1" },
    ] as MenuEntry[] }),
    seller({ name: "beta.openbook.eth", menu: [
      { id: "overtime-sports-odds", schema: "sports-odds/1.0.0" },
    ] as MenuEntry[] }),
  ];

  it("returns only sellers whose menu advertises the schema", () => {
    const matches = sellersForSchema(refs, "lending/3.1.0");
    expect(matches.map((r) => r.name)).toEqual(["alpha.openbook.eth"]);
  });

  it("returns [] when no seller advertises the schema", () => {
    expect(sellersForSchema(refs, "ens/1.0.0")).toEqual([]);
  });

  it("matches schema exactly (no partial/suffix guessing)", () => {
    expect(sellersForSchema(refs, "lending")).toEqual([]);
    expect(sellersForSchema(refs, "lending/3")).toEqual([]);
  });
});

// --- live seam: registry walk + LabelRegistered scan + getState gate ----------

describe("listRegisteredSubnames (stubbed chain)", () => {
  const SUBREGISTRY = "0x8eC443d5e7BCB2E9182c83CE96295dFc35085f29";
  const PARENT = "openbook.eth";
  const now = BigInt(Math.floor(Date.now() / 1000));

  /**
   * Minimal PublicClient stand-in: the registry walk answers getSubregistry,
   * the scan returns one LabelRegistered log per registered label, and
   * getState marks only the given labels REGISTERED (2) and unexpired.
   * Cast through unknown: a shape subset, never an `any`.
   */
  function stubClient(registered: string[], labelsInLogs: string[], rootRegistry: Address) {
    const known = new Set(registered);
    const logged = new Set(labelsInLogs);
    const readContract = async (args: unknown) => {
      const call = args as { functionName: string; address: Address; args: unknown[] };
      if (call.functionName === "getSubregistry") {
        return rootRegistry === call.address ? SUBREGISTRY : "0x0000000000000000000000000000000000000000";
      }
      if (call.functionName === "getState") {
        const anyId = BigInt(String(call.args[0]));
        const canonical = anyId & ~0xffffffffn;
        const label = [...known].find((l) => (BigInt(labelhash(l)) & ~0xffffffffn) === canonical);
        return label === undefined
          ? { status: 0, expiry: 0n, latestOwner: "0x0000000000000000000000000000000000000000", tokenId: anyId, resource: anyId }
          : { status: 2, expiry: now + 3600n, latestOwner: "0x4e83eB15EE973A49E40D9A79aB2cA89a4Eb4894E", tokenId: anyId, resource: anyId };
      }
      throw new Error(`stub readContract: unexpected ${call.functionName}`);
    };
    const api = {
      getBlockNumber: async () => ENSV2_FROM_BLOCK + 10n,
      readContract,
      getLogs: async () =>
        [...logged].map((label) => ({
          address: SUBREGISTRY as Address,
          topics: ["0x0", "0x0", `0x${BigInt(labelhash(label)).toString(16).padStart(64, "0")}`],
          data: "0x",
          logIndex: 0,
          blockNumber: ENSV2_FROM_BLOCK,
          transactionHash: "0x0",
          transactionIndex: 0,
          blockHash: "0x0",
          args: { label, owner: "0x4e83eB15EE973A49E40D9A79aB2cA89a4Eb4894E", tokenId: 0n, labelHash: "0x0", expiry: 0n, sender: "0x0" },
        })),
    };
    return api as unknown as PublicClient; // library boundary: subset shape
  }

  it("walks getSubregistry to the parent's subregistry", async () => {
    const sub = await listRegisteredSubnames(PARENT, {
      client: stubClient(["alpha"], ["alpha"], "0xBDC85dD5b15D7ecb354cd7cb6f2c50b4f2c4F0E2"),
    });
    expect(sub.map((s) => s.label)).toEqual(["alpha"]);
    expect(sub[0]?.owner).toBe("0x4e83eB15EE973A49E40D9A79aB2cA89a4Eb4894E");
  });

  it("drops labels whose getState is not REGISTERED", async () => {
    const sub = await listRegisteredSubnames(PARENT, {
      client: stubClient(["alpha"], ["alpha", "burned"], "0xBDC85dD5b15D7ecb354cd7cb6f2c50b4f2c4F0E2"),
    });
    expect(sub.map((s) => s.label)).toEqual(["alpha"]); // "burned" logged but not REGISTERED
  });
});

// --- process-less environments (Vite browser bundle safety) -------------------

/**
 * The app bundle has no `process` global — a bare `process` identifier throws
 * `ReferenceError` at call time. envSepoliaRpc() must read the env through a
 * `typeof process === "undefined"` guard at BOTH RPC-defaulting sites.
 */
describe("envSepoliaRpc (no process shim in the browser bundle)", () => {
  // globalThis is the well-known kernel; simulating a browser bundle that
  // lacks Node's `process` global requires deleting + restoring it in a test.
  const kernel = globalThis as typeof globalThis & { process?: unknown };

  it("returns undefined when `process` is absent (typeof-guarded, no throw)", () => {
    const saved = kernel.process;
    try {
      delete kernel.process;
      expect(() => envSepoliaRpc()).not.toThrow();
      expect(envSepoliaRpc()).toBeUndefined();
    } finally {
      kernel.process = saved;
    }
  });

  it("returns the SEPOLIA_RPC value when `process.env` carries it", () => {
    const savedVar = process.env.SEPOLIA_RPC;
    try {
      process.env.SEPOLIA_RPC = "https://example.invalid/rpc";
      expect(envSepoliaRpc()).toBe("https://example.invalid/rpc");
    } finally {
      process.env.SEPOLIA_RPC = savedVar;
    }
  });

  it("returns undefined when `process` exists but SEPOLIA_RPC is unset", () => {
    const savedVar = process.env.SEPOLIA_RPC;
    try {
      delete process.env.SEPOLIA_RPC;
      expect(envSepoliaRpc()).toBeUndefined();
    } finally {
      process.env.SEPOLIA_RPC = savedVar;
    }
  });
});

// --- exported type sanity (the frozen SellerRef shape) ------------------------

describe("SellerRef shape", () => {
  it("keeps the frozen six-field contract", () => {
    const ref: SellerRef = seller({});
    const keys = Object.keys(ref).sort();
    expect(keys).toEqual(["menu", "name", "operator", "payee", "price", "sla"]);
  });
});
