/**
 * Circle developer-controlled wallets on Arc testnet, driven from the server
 * with plain fetch + WebCrypto (no SDK: this runs inside the Cloudflare worker
 * and the Vercel function alike).
 *
 *   buyer  SCA wallet: createJob · approve · fund     (gas: Circle Gas Station)
 *   seller SCA wallet: setBudget · submit              (gas: Circle Gas Station)
 *
 * The entity secret never leaves the server: every request carries a fresh
 * RSA-OAEP(SHA-256) ciphertext of it under Circle's entity public key, which is
 * what Circle's own SDK does. Wallet ids and addresses are configuration.
 */
import { createPublicClient, http, keccak256, parseAbi, recoverMessageAddress, toBytes, type Hex } from "viem";
import { ARC_RPC, ESCROW, HOOK, USDC, arcTestnet, proofMessage } from "./shared";

export interface CircleEnv {
  apiKey: string;
  entitySecret: string;
  buyerWalletId: string;
  sellerWalletId: string;
  buyerAddress: Hex;
  sellerAddress: Hex;
}

const API = "https://api.circle.com/v1/w3s";
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const JOB_CREATED_TOPIC = keccak256(toBytes("JobCreated(uint256,address,address,address,uint256,address)"));
const STANDING_ALLOWANCE = 50_000_000n;
const ESCROW_ABI = parseAbi([
  "function jobs(uint256 jobId) view returns (uint256 id, address client, address provider, address evaluator, string description, uint256 budget, uint256 expiredAt, uint8 status, address hook)",
]);
const USDC_ABI = parseAbi(["function allowance(address owner, address spender) view returns (uint256)"]);
const HOOK_ABI = parseAbi(["function attester() view returns (address)"]);

/** Read the Circle configuration from an env-like getter; null when the deployment has no Circle wallets. */
export function circleEnvFrom(get: (key: string) => string | undefined): CircleEnv | null {
  const rawKey = get("CIRCLE_API_KEY") ?? "";
  const apiKey = rawKey.includes(":") && rawKey.split(":").length === 3 ? rawKey : rawKey ? `TEST_API_KEY:${rawKey}` : "";
  const env = {
    apiKey,
    entitySecret: get("CIRCLE_ENTITY_SECRET") ?? "",
    buyerWalletId: get("CIRCLE_BUYER_WALLET_ID") ?? "",
    sellerWalletId: get("CIRCLE_SELLER_WALLET_ID") ?? "",
    buyerAddress: (get("CIRCLE_BUYER_WALLET_ADDRESS") ?? "") as Hex,
    sellerAddress: (get("CIRCLE_SELLER_WALLET_ADDRESS") ?? "") as Hex,
  };
  if (!env.apiKey || !/^[0-9a-f]{64}$/i.test(env.entitySecret) || !env.buyerWalletId || !env.sellerWalletId) return null;
  if (!ADDRESS_RE.test(env.buyerAddress) || !ADDRESS_RE.test(env.sellerAddress)) return null;
  return env;
}

// ---- entity secret ciphertext -----------------------------------------------------

let publicKeyCache: { apiKey: string; key: CryptoKey } | null = null;

function pemToDer(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

async function entityPublicKey(apiKey: string): Promise<CryptoKey> {
  if (publicKeyCache && publicKeyCache.apiKey === apiKey) return publicKeyCache.key;
  const res = await fetch(`${API}/config/entity/publicKey`, { headers: { authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`circle publicKey ${res.status}`);
  const body = (await res.json()) as { data?: { publicKey?: string } };
  if (!body.data?.publicKey) throw new Error("circle publicKey: empty");
  const key = await crypto.subtle.importKey("spki", pemToDer(body.data.publicKey), { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
  publicKeyCache = { apiKey, key };
  return key;
}

/** Fresh ciphertext per request (Circle rejects reuse). Exported for the unit test. */
export async function entitySecretCiphertext(env: Pick<CircleEnv, "apiKey" | "entitySecret">, key?: CryptoKey): Promise<string> {
  const k = key ?? (await entityPublicKey(env.apiKey));
  const secret = new Uint8Array(env.entitySecret.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
  const enc = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, k, secret);
  return btoa(String.fromCharCode(...new Uint8Array(enc)));
}

// ---- contract execution -------------------------------------------------------------

export interface Execution {
  id: string;
  txHash: Hex;
  state: string;
}

const TERMINAL = new Set(["COMPLETE", "FAILED", "DENIED", "CANCELLED"]);

/** Execute one contract call from a Circle wallet and wait for its onchain hash. */
export async function contractExecution(
  env: CircleEnv,
  walletId: string,
  call: { contractAddress: Hex; abiFunctionSignature: string; abiParameters: (string | number)[] },
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<Execution> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(`${API}/developer/transactions/contractExecution`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      idempotencyKey: crypto.randomUUID(),
      walletId,
      contractAddress: call.contractAddress,
      abiFunctionSignature: call.abiFunctionSignature,
      abiParameters: call.abiParameters,
      feeLevel: "MEDIUM",
      entitySecretCiphertext: await entitySecretCiphertext(env),
    }),
  });
  const created = (await res.json()) as { data?: { id?: string; state?: string }; message?: string; code?: number };
  if (!res.ok || !created.data?.id) throw new Error(`circle contractExecution ${res.status}: ${created.message ?? "no id"}`);
  const id = created.data.id;
  const deadline = Date.now() + (opts.timeoutMs ?? 90_000);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const poll = await f(`${API}/transactions/${id}`, { headers: { authorization: `Bearer ${env.apiKey}` } });
    const body = (await poll.json()) as { data?: { transaction?: { state?: string; txHash?: string; errorReason?: string; errorDetails?: string } } };
    const tx = body.data?.transaction;
    if (!tx?.state) continue;
    if (tx.state === "COMPLETE" && tx.txHash) return { id, txHash: tx.txHash as Hex, state: tx.state };
    if (TERMINAL.has(tx.state)) throw new Error(`circle transaction ${tx.state}: ${tx.errorReason ?? ""} ${tx.errorDetails ?? ""}`.trim());
  }
  throw new Error("circle transaction did not complete in time");
}

// ---- the escrow flow -------------------------------------------------------------

export interface CircleJobRequest {
  minBlock: number;
  schemaHash: Hex;
  maxLatencyMs: number;
  /** USDC, 6 decimals */
  amount: string;
  expirySeconds?: number;
}

export function parseCircleJobRequest(raw: unknown): CircleJobRequest | string {
  if (typeof raw !== "object" || raw === null) return "body must be a JSON object";
  const r = raw as Record<string, unknown>;
  if (typeof r.minBlock !== "number" || !Number.isInteger(r.minBlock) || r.minBlock < 0) return "minBlock must be a non-negative integer";
  if (typeof r.schemaHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(r.schemaHash)) return "schemaHash must be a 32-byte hex hash";
  if (typeof r.maxLatencyMs !== "number" || !Number.isInteger(r.maxLatencyMs) || r.maxLatencyMs <= 0) return "maxLatencyMs must be a positive integer";
  if (typeof r.amount !== "string" || !/^\d{1,12}$/.test(r.amount) || BigInt(r.amount) === 0n || BigInt(r.amount) > 1_000_000n) return "amount must be a 6-decimal USDC string up to 1.000000";
  return { minBlock: r.minBlock, schemaHash: r.schemaHash as Hex, maxLatencyMs: r.maxLatencyMs, amount: r.amount, expirySeconds: 3600 };
}

export interface CircleJobResult {
  jobId: string;
  buyer: Hex;
  seller: Hex;
  evaluator: Hex;
  txs: { createJob: Hex; setBudget: Hex; approve?: Hex; fund: Hex };
}

/**
 * The buyer wallet opens and funds a job whose provider is the seller wallet and
 * whose evaluator is the hook's attester; the seller wallet sets the budget.
 * Four sponsored transactions, all from Circle-managed keys.
 */
export async function circleCreateJob(env: CircleEnv, req: CircleJobRequest): Promise<CircleJobResult> {
  const pub = createPublicClient({ chain: arcTestnet, transport: http(ARC_RPC) });
  const evaluator = await pub.readContract({ address: HOOK, abi: HOOK_ABI, functionName: "attester" });
  const block = await pub.getBlock();
  const expiredAt = block.timestamp + BigInt(req.expirySeconds ?? 3600);
  const description = JSON.stringify({ minBlock: req.minBlock, schemaHash: req.schemaHash, maxLatencyMs: req.maxLatencyMs });

  const create = await contractExecution(env, env.buyerWalletId, {
    contractAddress: ESCROW,
    abiFunctionSignature: "createJob(address,address,uint256,string,address)",
    abiParameters: [env.sellerAddress, evaluator, expiredAt.toString(), description, HOOK],
  });
  const receipt = await pub.getTransactionReceipt({ hash: create.txHash });
  const log = receipt.logs.find((l) => l.address.toLowerCase() === ESCROW.toLowerCase() && l.topics[0] === JOB_CREATED_TOPIC);
  if (!log?.topics[1]) throw new Error("createJob succeeded but the JobCreated log is missing");
  const jobId = BigInt(log.topics[1]);

  const setBudget = await contractExecution(env, env.sellerWalletId, {
    contractAddress: ESCROW,
    abiFunctionSignature: "setBudget(uint256,uint256,bytes)",
    abiParameters: [jobId.toString(), req.amount, "0x"],
  });

  let approve: Execution | undefined;
  const allowance = await pub.readContract({ address: USDC, abi: USDC_ABI, functionName: "allowance", args: [env.buyerAddress, ESCROW] });
  if (allowance < BigInt(req.amount)) {
    approve = await contractExecution(env, env.buyerWalletId, {
      contractAddress: USDC,
      abiFunctionSignature: "approve(address,uint256)",
      abiParameters: [ESCROW, STANDING_ALLOWANCE.toString()],
    });
  }
  const fund = await contractExecution(env, env.buyerWalletId, {
    contractAddress: ESCROW,
    abiFunctionSignature: "fund(uint256,bytes)",
    abiParameters: [jobId.toString(), "0x"],
  });
  return {
    jobId: jobId.toString(),
    buyer: env.buyerAddress,
    seller: env.sellerAddress,
    evaluator: evaluator as Hex,
    txs: { createJob: create.txHash, setBudget: setBudget.txHash, ...(approve ? { approve: approve.txHash } : {}), fund: fund.txHash },
  };
}

export interface CircleSubmitRequest {
  jobId: string;
  deliverable: Hex;
  metaBlock: number;
  /** the attester's deliver signature: the seller only submits what the attester observed */
  proof: string;
}

export function parseCircleSubmitRequest(raw: unknown): CircleSubmitRequest | string {
  if (typeof raw !== "object" || raw === null) return "body must be a JSON object";
  const r = raw as Record<string, unknown>;
  if (typeof r.jobId !== "string" || !/^\d{1,12}$/.test(r.jobId)) return "jobId must be a decimal string";
  if (typeof r.deliverable !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(r.deliverable)) return "deliverable must be a 32-byte hex hash";
  if (typeof r.metaBlock !== "number" || !Number.isInteger(r.metaBlock) || r.metaBlock < 0) return "metaBlock must be a non-negative integer";
  if (typeof r.proof !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(r.proof)) return "proof must be the attester's deliver signature";
  return { jobId: r.jobId, deliverable: r.deliverable as Hex, metaBlock: r.metaBlock, proof: r.proof };
}

/** The seller wallet submits the deliverable the attester signed for a job it is the provider of. */
export async function circleSubmit(env: CircleEnv, req: CircleSubmitRequest, attesterPk: string): Promise<{ txHash: Hex; seller: Hex }> {
  const pub = createPublicClient({ chain: arcTestnet, transport: http(ARC_RPC) });
  const attester = await pub.readContract({ address: HOOK, abi: HOOK_ABI, functionName: "attester" });
  let signer: string;
  try {
    signer = await recoverMessageAddress({ message: proofMessage(req.deliverable, req.metaBlock), signature: req.proof as Hex });
  } catch {
    throw new Error("the deliver signature is malformed");
  }
  if (signer.toLowerCase() !== attester.toLowerCase()) throw new Error("the deliverable was not observed by the attester (signature mismatch)");
  void attesterPk;
  const job = await pub.readContract({ address: ESCROW, abi: ESCROW_ABI, functionName: "jobs", args: [BigInt(req.jobId)] });
  const [, , provider, , , , , status] = job;
  if (provider.toLowerCase() !== env.sellerAddress.toLowerCase()) throw new Error(`job ${req.jobId} is not sold by the Circle seller wallet`);
  if (status !== 1) throw new Error(`job ${req.jobId} is not Funded (status ${status})`);
  const submit = await contractExecution(env, env.sellerWalletId, {
    contractAddress: ESCROW,
    abiFunctionSignature: "submit(uint256,bytes32,bytes)",
    abiParameters: [req.jobId, req.deliverable, "0x"],
  });
  return { txHash: submit.txHash, seller: env.sellerAddress };
}

/** USDC (6-dec) balance of an address on Arc, for scripts that must not import viem themselves. */
export async function usdcBalance(address: Hex): Promise<bigint> {
  const pub = createPublicClient({ chain: arcTestnet, transport: http(ARC_RPC) });
  return pub.readContract({ address: USDC, abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [address] });
}

export function circleStatus(env: CircleEnv | null): { enabled: boolean; buyer: Hex | null; seller: Hex | null; gas: string } {
  return env
    ? { enabled: true, buyer: env.buyerAddress, seller: env.sellerAddress, gas: "sponsored by Circle Gas Station (SCA wallets, Arc testnet policy)" }
    : { enabled: false, buyer: null, seller: null, gas: "" };
}
