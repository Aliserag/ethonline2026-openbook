/**
 * PolicyWallet reader: live caps/spend view of the policy treasury
 * (contracts/src/PolicyWallet.sol, Arc testnet 0x4e83…), a pure
 * checkWithdrawal mirroring its onchain order of checks (per-tx cap →
 * daily cap → allowlist, with the block-number day-bucket roll), and a
 * keyless simulateOverspend that probes the wallet through the agent key.
 *
 * Deviation note: PolicyWallet.sol does NOT revert on cap violations — it
 * emits PolicyBlocked(PER_TX_CAP/DAILY_CAP/NOT_ALLOWLISTED) and returns, so a
 * simulateContract of an overspend succeeds. simulateOverspend reports
 * reverted:false in that case (the truth of this contract version) and only
 * decodes the PerTxCapExceeded/DailyCapExceeded/NotAllowlisted selectors when
 * a future version (or a non-policy revert) actually reverts.
 */
import {
  keccak256,
  toBytes,
  type Abi,
  type PublicClient,
} from "viem";
import { ADDR } from "./addresses";

/** PolicyWallet.sol DAY_BLOCKS — ~24h at Arc's 4s blocks. */
export const DAY_BLOCKS = 21_600n;

const POLICY_ABI = [
  { name: "usdc", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address", name: "" }] },
  { name: "owner", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address", name: "" }] },
  { name: "agent", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address", name: "" }] },
  { name: "perTxCap", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256", name: "" }] },
  { name: "dailyCap", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256", name: "" }] },
  { name: "spentToday", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256", name: "" }] },
  { name: "lastDayStart", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256", name: "" }] },
  { name: "allowlisted", type: "function", stateMutability: "view", inputs: [{ type: "address", name: "" }], outputs: [{ type: "bool", name: "" }] },
  { name: "requestWithdrawal", type: "function", stateMutability: "nonpayable", inputs: [{ type: "address", name: "to" }, { type: "uint256", name: "amount" }], outputs: [] },
] as const satisfies Abi;

export interface PolicyView {
  usdc: `0x${string}`;
  owner: `0x${string}`;
  agent: `0x${string}`;
  perTxCap: bigint;
  dailyCap: bigint;
  spentToday: bigint;
  lastDayStart: bigint;
}

/** Live PolicyWallet view at ADDR.policy (all read calls in one round). */
export async function readPolicy(publicClient: PublicClient): Promise<PolicyView> {
  const [usdc, owner, agent, perTxCap, dailyCap, spentToday, lastDayStart] = await Promise.all(
    (["usdc", "owner", "agent", "perTxCap", "dailyCap", "spentToday", "lastDayStart"] as const).map((fn) =>
      publicClient.readContract({ address: ADDR.policy, abi: POLICY_ABI, functionName: fn }),
    ),
  );
  return {
    usdc: usdc as `0x${string}`,
    owner: owner as `0x${string}`,
    agent: agent as `0x${string}`,
    perTxCap: perTxCap as bigint,
    dailyCap: dailyCap as bigint,
    spentToday: spentToday as bigint,
    lastDayStart: lastDayStart as bigint,
  };
}

export interface WithdrawalCheck {
  to: `0x${string}`;
  amount: bigint;
  perTxCap: bigint;
  dailyCap: bigint;
  spentToday: bigint;
  allowlisted: boolean;
  /** block-number day bucket (PolicyWallet.sol); omit both to skip the roll */
  lastDayStart?: bigint;
  headBlock?: bigint;
}

/**
 * Pure mirror of PolicyWallet.requestWithdrawal's policy checks, in contract
 * order. The day bucket rolls when headBlock - lastDayStart >= DAY_BLOCKS.
 */
export function checkWithdrawal(input: WithdrawalCheck): { ok: true } | { ok: false; reason: string } {
  if (input.amount <= 0n) return { ok: false, reason: "zero amount" };
  if (input.to === "0x0000000000000000000000000000000000000000") return { ok: false, reason: "to is zero" };
  const lastDayStart = input.lastDayStart ?? 0n;
  const headBlock = input.headBlock ?? 0n;
  const spentToday = headBlock - lastDayStart >= DAY_BLOCKS ? 0n : input.spentToday;
  if (input.amount > input.perTxCap) return { ok: false, reason: "per-tx cap" };
  if (spentToday + input.amount > input.dailyCap) return { ok: false, reason: "daily cap" };
  if (!input.allowlisted) return { ok: false, reason: "allowlist" };
  return { ok: true };
}

/** Revert selectors of the hypothetical cap errors the brief names. */
export const POLICY_REVERT_SELECTORS = {
  perTxCapExceeded: keccak256(toBytes("PerTxCapExceeded()")).slice(0, 10),
  dailyCapExceeded: keccak256(toBytes("DailyCapExceeded()")).slice(0, 10),
  notAllowlisted: keccak256(toBytes("NotAllowlisted()")).slice(0, 10),
} as const;

/**
 * Keyless overspend probe: simulate `requestWithdrawal(to=operator,
 * amount)` as the wallet's own agent(). See the module header for why this
 * contract version reports reverted:false on a cap hit.
 */
export async function simulateOverspend(
  publicClient: PublicClient,
  amount: bigint,
): Promise<{ reverted: boolean; reason: string; data?: `0x${string}` }> {
  const view = await readPolicy(publicClient);
  try {
    await publicClient.simulateContract({
      address: ADDR.policy,
      abi: POLICY_ABI,
      functionName: "requestWithdrawal",
      args: [ADDR.operator, amount],
      account: view.agent,
    });
    return {
      reverted: false,
      reason:
        "no revert: PolicyWallet.sol blocks caps by emitting PolicyBlocked (PER_TX_CAP/DAILY_CAP/NOT_ALLOWLISTED), not by reverting",
    };
  } catch (error) {
    const data = (error as { data?: unknown })?.data;
    const hex = typeof data === "string" && data.startsWith("0x") ? data : undefined;
    const selector = hex?.slice(0, 10).toLowerCase() ?? "";
    if (selector === POLICY_REVERT_SELECTORS.perTxCapExceeded) return { reverted: true, reason: "per-tx cap", data: hex as `0x${string}` };
    if (selector === POLICY_REVERT_SELECTORS.dailyCapExceeded) return { reverted: true, reason: "daily cap", data: hex as `0x${string}` };
    if (selector === POLICY_REVERT_SELECTORS.notAllowlisted) return { reverted: true, reason: "allowlist", data: hex as `0x${string}` };
    const message = error instanceof Error ? error.message : String(error);
    return {
      reverted: true,
      reason: hex ? `revert ${hex.slice(0, 10)}… (${message})` : message,
      ...(hex ? { data: hex as `0x${string}` } : {}),
    };
  }
}
