/**
 * Focus discipline for the two overlay surfaces (replay theater, command
 * palette): while one is open, everything behind it is `inert` (not tabbable,
 * not clickable), focus moves into the overlay, and on close focus returns to
 * the element that opened it. WCAG 2.4.7 / 2.4.11: a focused control must
 * never sit under a fixed overlay.
 */
import { useEffect } from "react";

export function useModalFocus(
  active: boolean,
  opts: { inertSelectors: string[]; focus: () => HTMLElement | null },
): void {
  useEffect(() => {
    if (!active) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const made: Element[] = [];
    for (const selector of opts.inertSelectors) {
      for (const el of document.querySelectorAll(selector)) {
        if (!el.hasAttribute("inert")) {
          el.setAttribute("inert", "");
          made.push(el);
        }
      }
    }
    const timer = window.setTimeout(() => opts.focus()?.focus(), 30);
    return () => {
      window.clearTimeout(timer);
      for (const el of made) el.removeAttribute("inert");
      if (previous && document.contains(previous)) previous.focus();
    };
    // opts is a fresh object each render; only `active` should re-arm the trap
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}
