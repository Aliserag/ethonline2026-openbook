/**
 * OpenBook: one page, five sections. Hero (the latest real refund) → Try it
 * (a live keyless purchase) → The market → The books → How it works. The
 * console dock, replay theater and system map stay as secondary surfaces.
 */
import { useEffect, useState, type JSX } from "react";
import { setEscrowAddress, setUsdcAddress } from "../../agent/escrow";
import { env } from "./env";
import { ADDR } from "./data/addresses";
import { FeedProvider } from "./data/feed";
import { Hero } from "./sections/Hero";
import { TryIt } from "./sections/TryIt";
import { MarketSection } from "./sections/MarketSection";
import { Books } from "./sections/Books";
import { Builders } from "./sections/Builders";
import { Console } from "./console/Console";
import { TheaterRoute } from "./theater/Theater";
import { SystemMap } from "./map/MapCanvas";

// Chain-specific USDC (VITE_USDC_ADDRESS), mainnet override for the escrow module.
if (env.usdcAddress !== undefined && /^0x[0-9a-fA-F]{40}$/.test(env.usdcAddress)) {
  setUsdcAddress(env.usdcAddress as `0x${string}`);
}
// Every write targets the market escrow (the instance that whitelists our SlaHook).
setEscrowAddress(ADDR.escrow);

export default function App(): JSX.Element {
  const [armed, setArmed] = useState<"fresh" | "fail" | null>(null);
  const [mapRoute, setMapRoute] = useState<boolean>(() => window.location.hash === "#map");

  useEffect(() => {
    const onHash = (): void => setMapRoute(window.location.hash === "#map");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const go = (mode: "fresh" | "fail"): void => {
    setArmed(null);
    document.getElementById("try")?.scrollIntoView({ behavior: "smooth", block: "start" });
    window.setTimeout(() => setArmed(mode), 350);
  };
  const openConsole = (): void => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
  };

  return (
    <FeedProvider>
      {mapRoute ? (
        <main className="wrap map-route">
          <p>
            <a href="#">← back to the page</a>
          </p>
          <SystemMap />
        </main>
      ) : (
        <main>
          <Hero onBuy={() => go("fresh")} onFail={() => go("fail")} />
          <TryIt armed={armed} />
          <MarketSection />
          <Books />
          <Builders onConsole={openConsole} />
          <footer className="foot wrap">
            <span className="tiny">OpenBook · built for ETHOnline 2026 · Arc testnet, ENSv2 on Sepolia, The Graph</span>
          </footer>
        </main>
      )}
      <Console />
      <TheaterRoute />
    </FeedProvider>
  );
}
