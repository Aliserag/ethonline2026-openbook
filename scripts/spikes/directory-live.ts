// Live check (W3 evidence): print the sellers discovered for openbook.eth
// straight from ENSv2 Sepolia — subregistry walk + LabelRegistered scan +
// getState gate + svc.* resolution. Read-only; no keys.
import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";
import { listSellers, listRegisteredSubnames, subregistryFor } from "../../mcp/src/directory";
import { UNIVERSAL_RESOLVER_V2 } from "../../mcp/src/constants";

// Usage: bun directory-live.ts [sepolia-rpc-url]  (omit for viem's default RPC)
const RPC = process.argv[2] ?? undefined;
const PARENT = "openbook.eth";

const client = createPublicClient({ chain: sepolia, transport: http(RPC, { timeout: 20000, retryCount: 3 }) });

const subregistry = await subregistryFor(PARENT, client);
console.log(`subregistry(${PARENT}) = ${subregistry}`);

const subnames = await listRegisteredSubnames(PARENT, { client });
console.log(`registered subnames (${subnames.length}):`, subnames.map((s) => s.label).join(", ") || "(none)");

const sellers = await listSellers(PARENT, { client });
console.log(`\nsellers (svc.menu advertised) (${sellers.length}):`);
if (sellers.length === 0) console.log("  (none yet)");
for (const s of sellers) {
  console.log(`  - ${s.name}`);
  console.log(`      menu: ${JSON.stringify(s.menu)}`);
  console.log(`      price: ${s.price ?? "(null)"}`);
  console.log(`      sla: ${JSON.stringify(s.sla)}`);
  console.log(`      payee: ${s.payee ?? "(null)"}`);
  console.log(`      operator: ${s.operator ?? "(null)"}`);
}

// context: any subname that exists but is not a seller (e.g. dataset price
// overrides publishing records without a menu)
console.log("\ncontext — records on subnames without svc.menu (kept as-is from ENS, for the report):");
const read = async (name: string, key: string) =>
  client.getEnsText({ name, key, universalResolverAddress: UNIVERSAL_RESOLVER_V2 });
for (const sub of subnames) {
  const name = `${sub.label}.${PARENT}`;
  const [menu, price, sla, payee, operator] = await Promise.all([
    read(name, "svc.menu"),
    read(name, "svc.price"),
    read(name, "svc.sla"),
    read(name, "svc.payee"),
    read(name, "svc.operator"),
  ]);
  if (menu !== null) continue; // already a seller above
  if ([price, sla, payee, operator].every((v) => v === null)) continue;
  console.log(`  - ${name} (no svc.menu; records present):`);
  if (price) console.log(`      price: ${price}`);
  if (sla) console.log(`      sla: ${sla}`);
  if (payee) console.log(`      payee: ${payee}`);
  if (operator) console.log(`      operator: ${operator}`);
}
