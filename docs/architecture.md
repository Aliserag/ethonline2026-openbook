# OpenBook Architecture

```mermaid
flowchart LR
    subgraph ClientSide["Buyer agent / human"]
        BA[Buyer CLI]
        FE[Frontend (Vite + wagmi)]
    end

    subgraph ENSv2["ENSv2 · Sepolia"]
        NAME[openbook.eth]
        RECS["svc.menu · svc.price · svc.sla · svc.payee · svc.operator · svc.pnl<br/>agent-context · agent-endpoint[mcp] · agent-registration"]
        NAME --> RECS
    end

    subgraph Arc["Arc Testnet (5042002)"]
        W[PolicyWallet<br/>perTxCap · dailyCap · allowlist<br/>WithdrawalExecuted / PolicyBlocked]
        J[ERC-8183 AgenticCommerce<br/>createJob → fund → submit → complete/reject → claimRefund]
        ID[ERC-8004 IdentityRegistry<br/>agent identity]
        USDC[(USDC 6-dec ERC-20)]
    end

    subgraph Graph["The Graph"]
        MCP[sla-subgraph-mcp<br/>list_datasets · get_quote · query_dataset · verify_delivery · get_pnl]
        GW[Gateway<br/>pinned Messari subgraphs<br/>_meta freshness gates]
        PNL[openbook-pnl subgraph<br/>(arc-testnet · Studio)]
    end

    BA -->|"resolve records (hard-fail if null)"| NAME
    FE --> NAME
    BA -->|"get_quote (ENS-resolved price+SLA)"| MCP
    MCP -->|"live GraphQL + _meta"| GW
    BA -->|"pay (escrowed SLA)"| J
    MCP -->|"submit payloadHash + metaBlock"| J
    BA -->|"verify_delivery → complete / reject+refund"| J
    J --> USDC
    W --> USDC
    J -->|"events"| PNL
    W -->|"events"| PNL
    MCP -->|"get_pnl"| PNL
    FE --> PNL
    ID -.->|"agent-registration record"| NAME
```

## Trust model (declared, not hidden)

- SLA conditions (freshness block, deliverable hash, deadline) are committed at payment time
  in the ERC-8183 job description; the deliverable hash is committed at `submit`.
- The verdict (`verify_delivery`) is deterministic open code: `metaBlock >= minBlock` and
  `keccak256(payload) == payloadHash`. Anyone can re-run it.
- Timeout defaults to the buyer: `claimRefund()` after `expiredAt`. The seller cannot stall.
- Latency is buyer-attested reputation-layer only; never claimed as onchain-proven.
