import type { JSX } from "react";

export function Builders({ onConsole, onBuy }: { onConsole(): void; onBuy(): void }): JSX.Element {
  return (
    <section id="how" className="section wrap" aria-labelledby="how-title">
      <div className="section__head">
        <h2 id="how-title">How it works</h2>
        <p className="lede">
          Three networks, each doing one job. Everything on this page is read live from them.
        </p>
      </div>
      <div className="builders__grid">
        <article className="builder">
          <h3>Arc holds the money</h3>
          <p className="small">
            Payments sit in an escrow with the freshness promise written into the job. A small contract we wrote
            checks the delivered block against that promise before any payout, so stale data cannot be paid. Gas
            is USDC. The venue's 2% goes to a treasury with onchain spending limits. (Escrow: Circle's ERC-8183
            reference; the check: our SlaHook.)
          </p>
        </article>
        <article className="builder">
          <h3>The Graph is the product</h3>
          <p className="small">
            Any of 15,000+ subgraphs becomes a paid, freshness-guaranteed dataset with one config entry. The seller
            runs as an MCP server: agents pick a seller, get a quote, buy, and verify the delivery with six tools. The public books
            are a subgraph too.
          </p>
          <pre className="mono builder__code">bun mcp/src/server.ts --config mcp/config/openbook.json</pre>
        </article>
        <article className="builder">
          <h3>ENS is the storefront</h3>
          <p className="small">
            A seller is a name on ENSv2 with four text records: menu, price, freshness promise, payee. Repricing is
            editing a record. Buyers refuse to pay a name without them.
          </p>
        </article>
      </div>
      <div className="closing">
        <p className="lede">Watch the escrow do it. One click, no wallet.</p>
        <button type="button" className="btn" onClick={onBuy}>
          Buy a query
        </button>
      </div>
      <div className="builders__links">
        <a href="https://github.com/Aliserag/OpenBook" target="_blank" rel="noreferrer">
          Source on GitHub
        </a>
        <a href="https://github.com/Aliserag/OpenBook/blob/main/docs/architecture.md" target="_blank" rel="noreferrer">
          Architecture
        </a>
        <a href="https://github.com/Aliserag/OpenBook/blob/main/mcp/README.md" target="_blank" rel="noreferrer">
          MCP server quickstart
        </a>
        <a href="#map">System map</a>
        <button type="button" className="linkbtn" onClick={onConsole}>
          Open the console (⌘K)
        </button>
      </div>
    </section>
  );
}
