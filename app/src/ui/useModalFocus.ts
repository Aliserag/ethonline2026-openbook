/**
 * Focus discipline for the two overlay surfaces (replay theater, command
 * palette): while one is open, everything behind it is `inert` (not tabbable,
 * not clickable), focus moves into the overlay, and on close focus returns to
 * the element that opened it. WCAG 2.4.7 / 2.4.11: a focused control must
 * never sit under a fixed overlay.
 */
import { useEffect } from "react";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useModalFocus(
  active: boolean,
  opts: { inertSelectors: string[]; focus: () => HTMLElement | null; container?: () => HTMLElement | null },
): void {
  useEffect(() => {
    if (!active) return;
    // Tab wraps inside the container so focus never drops onto <body>
    const onKey = (event: KeyboardEvent): void => {
      const root = opts.container?.();
      if (!root || event.key !== "Tab") return;
      const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const current = document.activeElement;
      if (!event.shiftKey && (current === last || !root.contains(current))) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && (current === first || !root.contains(current))) {
        event.preventDefault();
        last.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
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
      document.removeEventListener("keydown", onKey, true);
      window.clearTimeout(timer);
      for (const el of made) el.removeAttribute("inert");
      if (previous && document.contains(previous)) previous.focus();
    };
    // opts is a fresh object each render; only `active` should re-arm the trap
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}
